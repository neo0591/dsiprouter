/* ============================================================================
   UFI SMS Center — application logic（真实 API 版）
   通道 = 已注册 + SIM 就绪的 UFI（后端实时派生）；发送 = 真实 SIP MESSAGE；
   群发/定时由后端线程执行；本文件只负责视图与交互。
   ========================================================================= */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const I = (n, s) => Icon.svg(n, s);
  const num = n => (n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const pad2 = n => String(n).padStart(2, '0');

  /* 列表/正文选区：拖选过程中或已选中文字时，暂停 3s 刷新，避免 DOM 重绘冲掉选区 */
  let _ptrDown = null;
  function hasTextSelection() {
    try {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /^(text|search|tel|url|password|email)$/i.test(ae.type || 'text')))) {
        const a = ae.selectionStart, b = ae.selectionEnd;
        if (a != null && b != null && a !== b) return true;
      }
      const s = window.getSelection && window.getSelection();
      return !!(s && String(s).replace(/\s+/g, '').length);
    } catch (e) { return false; }
  }
  function trackPtrDown(e) {
    if (e.button !== 0) return;
    _ptrDown = { x: e.clientX, y: e.clientY, t: Date.now() };
  }
  function clearPtrDown() { _ptrDown = null; }
  function isSelectingText() {
    if (hasTextSelection()) return true;
    return !!_ptrDown; /* 鼠标尚未松开：可能正在拖选 */
  }
  function bindListCopyHelpers(root) {
    const el = root || document.querySelector('.ufi-sms');
    if (!el || el._copyBound) return;
    el._copyBound = true;
    el.addEventListener('mousedown', trackPtrDown, true);
    document.addEventListener('mouseup', clearPtrDown, true);
    document.addEventListener('pointerup', clearPtrDown, true);
    el.addEventListener('dblclick', e => {
      const cell = e.target.closest('.copyable, .mono, td.mono, .sms-body-cell, .alert-title, .sms-bubble-body');
      if (!cell || cell.closest('button,a,input,select,label,textarea')) return;
      const text = (cell.getAttribute('data-copy') || cell.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text === '—' || text.length < 2) return;
      e.preventDefault();
      const done = () => toast('已复制', text.length > 48 ? text.slice(0, 48) + '…' : text, 'ok', 1600);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {});
      }
    });
  }

  const SMS_TASK_STATE = {
    running:   { label: '发送中',   cls: 'ok' },
    scheduled: { label: '定时待发', cls: 'info' },
    paused:    { label: '已暂停',   cls: 'warn' },
    done:      { label: '已完成',   cls: '' },
    draft:     { label: '草稿',     cls: '' },
    recur_on:  { label: '周期启用', cls: 'purple' },
    recur_off: { label: '周期停用', cls: 'warn' }
  };
  const SMS_WHEN = { now: '立即发送', at: '指定时间', daily: '每日', weekly: '每周' };

  /** 号码池列表：通道聚合 + 已创建但尚无成员的空池 */
  function listPools() {
    const map = {};
    (DB.channelList() || []).forEach(c => {
      const p = c.pool;
      if (!p || p === '—') return;
      if (!map[p]) map[p] = { id: p, all: 0, ok: 0 };
      map[p].all += 1;
      if (c.state === 'ok') map[p].ok += 1;
    });
    (((DB.poolMembers && DB.poolMembers.pools) || [])).forEach(p => {
      if (!p || map[p]) return;
      map[p] = { id: p, all: 0, ok: 0 };
    });
    return Object.keys(map).sort().map(k => map[k]);
  }
  function poolOptionsHtml(selected) {
    const pools = listPools();
    let sel = selected == null ? '' : String(selected);
    if (!sel && pools.length === 1) sel = pools[0].id;
    let html = '<option value="">— 请选择号码池 —</option>';
    if (!pools.length) {
      html += '<option value="" disabled>暂无号码池（可点「新建号码池」创建）</option>';
      return html;
    }
    html += pools.map(p =>
      '<option value="' + esc(p.id) + '"' + (sel === p.id ? ' selected' : '') + '>' +
      esc(p.id) + (p.all ? ('（可用 ' + p.ok + '/' + p.all + ' 路）') : '（空池）') + '</option>').join('');
    return html;
  }
  const SMS_MSG_STATE = {
    delivered: { label: '已送达', cls: 'ok' },
    sending:   { label: '发送中', cls: 'info' },
    failed:    { label: '失败',   cls: 'err' },
    in:        { label: '上行',   cls: 'purple' }
  };
  const SMS_CH_STATE = {
    ok:   { label: '可用',   cls: 'ok' },
    cool: { label: '冷却中', cls: 'warn' },
    off:  { label: '已停用', cls: '' }
  };
  const SMS_KIND = { daily: '每日', weekly: '每周', once: '一次性' };
  const STRATEGY_NAME = { wrr: '加权轮询', rr: '严格轮询', lru: '最长空闲' };

  const APP = {
    view: 'compose',
    timer: null,
    paused: false,
    mode: 'single',
    msgFilter: { dir: '', q: '', country: '' },
    blackFilter: ''
  };

  /* ════════════════════════════════════════════════════════════ helpers */
  function toast(title, msg, kind, ms) {
    kind = kind || 'info';
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const ico = kind === 'ok' ? 'check-circle' : kind === 'err' ? 'x-circle' : kind === 'warn' ? 'alert' : 'info';
    el.innerHTML = '<span class="ti">' + I(ico, 17) + '</span><div class="tb"><b>' + esc(title) + '</b>' +
      (msg ? '<span>' + esc(msg) + '</span>' : '') + '</div>';
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s, transform .25s'; el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 260); }, ms || 3600);
  }
  function fmtAgo(min) {
    if (min == null) return '—';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.floor(min / 60) + ' 小时前';
    return Math.floor(min / 1440) + ' 天前';
  }
  function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  /** 短信时间展示：年月日时分秒（不附时区） */
  function fmtSmsTime(s) {
    let t = String(s || '').trim();
    if (!t) return '—';
    t = t.replace(/\s*(中国\/上海|CST|UTC([+-]\d+)?|GMT([+-]\d+)?|\+08(:?00)?)\s*$/i, '').trim();
    return t || '—';
  }
  function dirCellHtml(dir) {
    const out = dir === 'out';
    /* 小号箭头在上、文字在下 */
    const arrow = out
      ? '<svg class="sms-dir__svg" viewBox="0 0 14 8" width="14" height="8" aria-hidden="true"><path d="M1 4h9M7.5 1.5L11 4 7.5 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg class="sms-dir__svg" viewBox="0 0 14 8" width="14" height="8" aria-hidden="true"><path d="M13 4H4M6.5 1.5L3 4l3.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<span class="sms-dir ' + (out ? 'sms-dir--out' : 'sms-dir--in') + '" title="' + (out ? '下行（平台→终端）' : '上行（终端→平台）') + '">' +
      arrow +
      '<span class="sms-dir__label">' + (out ? '下行' : '上行') + '</span></span>';
  }
  function kpi(lb, vl, df, tone) {
    return '<div class="kpi ' + (tone || '') + '"><div class="lb">' + esc(lb) + '</div><div class="vl">' + vl + '</div><div class="df">' + esc(df) + '</div></div>';
  }
  function segCount(n) { return n <= 0 ? 1 : (n <= 70 ? 1 : Math.ceil(n / 67)); }
  function iconsIn(sel) { $$(sel + ' [data-i]').forEach(el => { el.innerHTML = I(el.dataset.i, 15); }); }
  function errText(ex) { return (ex && ex.message) ? ex.message : String(ex); }
  function readDateRange(fromId, toId) {
    return {
      date_from: (($('#' + fromId) || {}).value || '').trim(),
      date_to: (($('#' + toId) || {}).value || '').trim()
    };
  }
  function clearDateRange(fromId, toId) {
    if ($('#' + fromId)) $('#' + fromId).value = '';
    if ($('#' + toId)) $('#' + toId).value = '';
  }
  function bindDateRange(fromId, toId, applyId, resetId, applyFn) {
    const go = () => {
      const r = readDateRange(fromId, toId);
      if (r.date_from && r.date_to && r.date_from > r.date_to) {
        toast('时间区间无效', '开始日期不能晚于结束日期', 'warn');
        return;
      }
      applyFn(r);
    };
    if ($('#' + applyId)) $('#' + applyId).addEventListener('click', go);
    if ($('#' + resetId)) $('#' + resetId).addEventListener('click', () => {
      clearDateRange(fromId, toId);
      applyFn({ date_from: '', date_to: '' });
    });
    [fromId, toId].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }
  function inDateRange(createdStr, from, to) {
    if (!from && !to) return true;
    const d = String(createdStr || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  /* ── CSV 导入 / 模板 / 变量渲染（群发） ── */
  const PHONE_HDR = /^(phone|num|peer|mobile|号码|手机号|手机|收件人)$/i;
  function csvSplitLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if ((c === ',' || c === '\t' || c === ';') && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(x => String(x || '').trim().replace(/^["']|["']$/g, ''));
  }
  function normalizePhone(v) {
    let s = String(v || '').trim();
    if (!s) return '';
    s = s.replace(/[\s\-().]/g, '');
    if (s.indexOf('00') === 0 && /^00\d+$/.test(s)) s = '+' + s.slice(2);

    // E.164：保留 +digits（含 +86，不剥国家码，跨国短信需要）
    if (s.charAt(0) === '+') {
      const digits = s.slice(1).replace(/\D/g, '');
      if (!digits || digits.length < 2 || digits.length > 15) return '';
      return '+' + digits;
    }

    // 字母数字短码 / 业务号（* #）
    if (/[A-Za-z*#]/.test(s)) {
      return /^[0-9A-Za-z+*#.\-]{2,64}$/.test(s) ? s : '';
    }
    let d = s.replace(/\D/g, '');
    // 无 + 的 86/086 中国国际号 → 升为 +86…（跨国 X-SMS 需要国家码）
    if (d.indexOf('086') === 0 && d.length === 14 && d.charAt(3) === '1') return '+86' + d.slice(3);
    if (d.indexOf('86') === 0 && d.length === 13 && d.charAt(2) === '1') return '+86' + d.slice(2);
    const m = d.match(/^1\d{10}$/);
    if (m) return m[0];
    return (d.length >= 2 && d.length <= 20) ? d : '';
  }
  function cnPhoneVariants(num) {
    const a = normalizePhone(num);
    if (!a) return [];
    const out = [a];
    if (a.charAt(0) === '+' && a.indexOf('+86') === 0 && a.length === 14 && /^1\d{10}$/.test(a.slice(3))) {
      out.push(a.slice(3));
    } else if (/^1\d{10}$/.test(a)) {
      out.push('+86' + a);
    }
    return out;
  }
  function isCnBlack(num) {
    const bs = DB.blackSet();
    return cnPhoneVariants(num).some(n => bs.has(n));
  }
  function renderSmsBody(body, row) {
    return String(body || '').replace(/\{([^{}]+)\}/g, (m, k) => {
      const key = String(k || '').trim();
      if (row && Object.prototype.hasOwnProperty.call(row, key) && key !== 'phone') return String(row[key] == null ? '' : row[key]);
      return m;
    });
  }
  /** Excel 中文版常把 CSV 存成 GBK/GB18030；浏览器默认按 UTF-8 读会乱码导致变量无法替换 */
  function decodeCsvBytes(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
    if (!u8.length) return '';
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF)
      return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
    const dec = (label, fatal) => {
      try { return new TextDecoder(label, { fatal: !!fatal }).decode(u8); }
      catch (e) { return null; }
    };
    const utf8ok = dec('utf-8', true);
    if (utf8ok != null && utf8ok.indexOf('\uFFFD') < 0) return utf8ok;
    const gbk = dec('gb18030', false) || dec('gbk', false);
    if (gbk != null) {
      const loose = dec('utf-8', false) || '';
      if ((loose.match(/\uFFFD/g) || []).length > 0 || utf8ok == null) return gbk;
      return loose;
    }
    return dec('utf-8', false) || '';
  }
  function readCsvFile(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => {
        try { resolve(decodeCsvBytes(rd.result)); }
        catch (e) { reject(e); }
      };
      rd.onerror = () => reject(rd.error || new Error('读文件失败'));
      rd.readAsArrayBuffer(file);
    });
  }
  function parseCampaignCsv(text) {
    // 兼容 CRLF / LF / 旧 Mac 单独 CR
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], cols: [], err: '文件为空', skipped: [] };
    let headers = csvSplitLine(lines[0]).map(h => String(h || '').replace(/^\uFEFF/, '').trim());
    let start = 1;
    // 收件人列优先精确匹配；明确排除「电话号码」等正文变量列
    let phoneIdx = headers.findIndex(h => PHONE_HDR.test(h));
    if (phoneIdx < 0 && normalizePhone(headers[0])) {
      headers = headers.map((_, i) => (i === 0 ? '号码' : ('参数' + i)));
      phoneIdx = 0;
      start = 0;
    }
    if (phoneIdx < 0) phoneIdx = 0;
    const cols = headers.filter((_, i) => i !== phoneIdx && String(headers[i] || '').trim());
    const rows = [], seen = new Set(), skipped = [];
    for (let li = start; li < lines.length; li++) {
      const cells = csvSplitLine(lines[li]);
      if (!cells.length || cells.every(c => !String(c || '').trim())) continue;
      let phone = normalizePhone(cells[phoneIdx]);
      if (!phone) phone = normalizePhone(cells[0]);
      if (!phone) {
        // 整行兜底：防止分隔符异常时漏号
        phone = normalizePhone(cells.join(' '));
      }
      if (!phone) { skipped.push({ phone: '', reason: '无效号码', line: li + 1 }); continue; }
      if (seen.has(phone)) { skipped.push({ phone: phone, reason: '重复', line: li + 1 }); continue; }
      seen.add(phone);
      const row = { phone: phone };
      headers.forEach((h, i) => {
        if (i === phoneIdx) return;
        const key = String(h || '').trim() || ('参数' + i);
        row[key] = cells[i] != null ? String(cells[i]).trim() : '';
      });
      rows.push(row);
    }
    // 若结构化解析偏少：补 E.164 与「非 + 前缀」的大陆 11 位
    const looseExtra = [];
    (String(text).match(/\+[1-9]\d{6,14}/g) || []).forEach(p => {
      const n = normalizePhone(p);
      if (n && !seen.has(n)) { seen.add(n); looseExtra.push(n); rows.push({ phone: n }); }
    });
    const cnRe = /(?:^|[^0-9+])(1\d{10})(?!\d)/g;
    let cm;
    while ((cm = cnRe.exec(String(text))) !== null) {
      const n = normalizePhone(cm[1]);
      if (n && !seen.has(n)) { seen.add(n); looseExtra.push(n); rows.push({ phone: n }); }
    }
    return {
      rows: rows,
      cols: cols,
      skipped: skipped,
      file_phones: looseExtra.length,
      err: rows.length ? '' : '未解析到有效号码（手机号 / 短号 / 短码 / +国际号）'
    };
  }
  function extractBodyVars(body) {
    return [...String(body || '').matchAll(/\{([^{}]+)\}/g)]
      .map(m => String(m[1] || '').trim())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
  }
  function buildCampaignCsvTemplate(varNames) {
    // 严格按短信正文变量生成：无参数 → 仅「号码」列；有参数 → 号码 + 各变量列
    const vars = (varNames || []).map(v => String(v || '').trim()).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    const headers = ['号码'].concat(vars);
    const sampleVal = (h, row) => {
      if (PHONE_HDR.test(h) || h === '号码') return row === 0 ? '13800138000' : '13900139000';
      if (/名|name/i.test(h)) return row === 0 ? '张三' : '李四';
      if (/订单|order/i.test(h)) return row === 0 ? 'A20261001' : 'A20261002';
      if (/电话|手机|mobile|tel/i.test(h)) return row === 0 ? '13900001111' : '13900002222';
      return '示例' + (row + 1);
    };
    const escapeCell = c => {
      const s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.map(escapeCell).join(',')];
    for (let r = 0; r < 2; r++) lines.push(headers.map(h => escapeCell(sampleVal(h, r))).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function tplVarList(t) {
    if (!t) return [];
    const fromMeta = String(t.vars || '').split(',').map(x => x.trim()).filter(Boolean);
    const fromBody = [...String(t.body || '').matchAll(/\{([^{}]+)\}/g)].map(m => m[1].trim());
    return [...new Set(fromMeta.concat(fromBody).filter(Boolean))];
  }
  function matchTplByCols(cols) {
    const colSet = new Set(cols || []);
    let best = null, score = -1;
    (DB.sms.tpl || []).forEach(t => {
      const vars = tplVarList(t);
      if (!vars.length) return;
      const hit = vars.filter(v => colSet.has(v)).length;
      if (hit === vars.length && hit > score) { best = t; score = hit; }
      else if (hit > score && hit > 0 && hit >= Math.ceil(vars.length * 0.6)) { best = t; score = hit; }
    });
    return best;
  }
  function campaignParamTableHtml(rows, limit) {
    const list = rows || [];
    if (!list.length) return '';
    const cols = Object.keys(list[0]).filter(k => k !== 'phone');
    const n = Math.min(limit || 5, list.length);
    let html = '<div class="pv-hd">已解析参数 · 前 ' + n + ' 行</div><div class="pv-list" style="overflow:auto">';
    html += '<table class="pv-table"><thead><tr><th>号码</th>' +
      cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
    for (let i = 0; i < n; i++) {
      const r = list[i];
      html += '<tr><td>' + esc(r.phone) + '</td>' +
        cols.map(c => '<td>' + esc(r[c] == null ? '' : r[c]) + '</td>').join('') + '</tr>';
    }
    return html + '</tbody></table></div>';
  }
  function campaignPreviewHtml(body, rows, limit) {
    const list = rows || [];
    const n = Math.min(limit || 5, list.length);
    if (!list.length) {
      return '<div class="pv-empty">① 左侧先填写短信正文（或选模板）　　② 再下载/导入收件人 CSV　　③ 此处预览替换结果</div>';
    }
    const bodyTrim = String(body || '').trim();
    if (!bodyTrim) {
      return '<div class="pv-empty" style="margin-bottom:8px">CSV 已导入，请在左侧<strong>选择短信模板</strong>或填写正文，即可生成发送预览</div>' +
        campaignParamTableHtml(list, n);
    }
    const keys = new Set(Object.keys(list[0] || {}).filter(k => k !== 'phone'));
    const missing = [...bodyTrim.matchAll(/\{([^{}]+)\}/g)]
      .map(m => m[1].trim()).filter(k => k && !keys.has(k));
    let html = '<div class="pv-hd">发送预览 · 共 <b>' + list.length + '</b> 人，展示前 ' + n + ' 条</div>';
    if (missing.length) {
      html += '<div class="pv-empty" style="margin-bottom:8px;color:var(--st-warn)">CSV 缺少列：' +
        missing.map(k => '{' + esc(k) + '}').join(' ') + '（表头需与正文变量名一致）</div>';
    }
    html += '<div class="pv-list">';
    for (let i = 0; i < n; i++) {
      const r = list[i];
      const rendered = renderSmsBody(bodyTrim, r);
      html += '<div class="pv-item"><div class="pv-phone">' + esc(r.phone) + '</div>' +
        '<div>' + (rendered ? esc(rendered) : '<span style="color:var(--tx-3)">（空内容）</span>') + '</div></div>';
    }
    return html + '</div>';
  }

  /* ════════════════════════════════════════════════════════════ PAGER（客户端分页） */
  const PG = {
    st: {}, registry: {},
    cut(key, arr, defSize) {
      const s = this.st[key] || (this.st[key] = { page: 1, size: defSize || 10 });
      if (!s.size) s.size = defSize || 10;
      const total = arr.length;
      const pages = Math.max(1, Math.ceil(total / s.size));
      if (s.page > pages) s.page = pages;
      if (s.page < 1) s.page = 1;
      return { list: arr.slice((s.page - 1) * s.size, s.page * s.size), total: total, page: s.page, pages: pages, size: s.size };
    },
    foot(key, pg) {
      if (!pg.total) return '';
      this.st[key]._pages = pg.pages;
      const nums = [];
      nums.push(1);
      let lo = Math.max(2, pg.page - 2), hi = Math.min(pg.pages - 1, pg.page + 2);
      if (lo > 2) nums.push('…');
      for (let i = lo; i <= hi; i++) nums.push(i);
      if (hi < pg.pages - 1) nums.push('…');
      if (pg.pages > 1) nums.push(pg.pages);
      const btn = (p, label, cls, dis) =>
        '<button class="pgbtn ' + (cls || '') + '" data-pg="' + key + '|' + p + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
      return '<span class="pg-info">共 ' + num(pg.total) + ' 条 · 第 ' + pg.page + '/' + pg.pages + ' 页</span>' +
        '<select class="pgsel" data-psize="' + key + '">' +
        [10, 15, 30, 50, 100].map(n => '<option value="' + n + '"' + (n === pg.size ? ' selected' : '') + '>' + n + ' 条/页</option>').join('') +
        '</select>' +
        '<span class="pg-btns">' +
        btn(pg.page - 1, '‹', '', pg.page <= 1) +
        nums.map(n => n === '…' ? '<span class="pgbtn gap">…</span>' : btn(n, n, n === pg.page ? 'on' : '', false)).join('') +
        btn(pg.page + 1, '›', '', pg.page >= pg.pages) +
        '</span>';
    },
    /* 服务端分页 foot（records） */
    footSrv(key, rec) {
      if (!rec.total) return '';
      const s = this.st[key] || (this.st[key] = { page: rec.page, size: rec.size || 15 });
      s.page = rec.page; s._pages = rec.pages;
      const btn = (p, label, cls, dis) =>
        '<button class="pgbtn ' + (cls || '') + '" data-pg="' + key + '|' + p + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
      return '<span class="pg-info">共 ' + num(rec.total) + ' 条 · 第 ' + rec.page + '/' + rec.pages + ' 页</span>' +
        '<select class="pgsel" data-psize="' + key + '">' +
        [10, 15, 30, 50, 100].map(n => '<option value="' + n + '"' + (n === (s.size || 15) ? ' selected' : '') + '>' + n + ' 条/页</option>').join('') +
        '</select>' +
        '<span class="pg-btns">' +
        btn(rec.page - 1, '‹', '', rec.page <= 1) + btn(rec.page + 1, '›', '', rec.page >= rec.pages) +
        '</span>';
    },
    bind() {
      document.addEventListener('click', e => {
        const b = e.target.closest('[data-pg]');
        if (!b || b.classList.contains('gap')) return;
        const parts = b.dataset.pg.split('|');
        const key = parts[0], p = +parts[1];
        const s = this.st[key];
        if (!s || !this.registry[key]) return;
        if (p < 1 || p > (s._pages || 1)) return;
        s.page = p;
        this.registry[key]();
      });
      document.addEventListener('change', e => {
        const sel = e.target.closest('[data-psize]');
        if (!sel) return;
        const key = sel.dataset.psize, s = this.st[key];
        if (!s || !this.registry[key]) return;
        s.size = +sel.value || 10; s.page = 1;
        this.registry[key]();
      });
    },
    reg(key, fn) { this.registry[key] = fn; }
  };

  /* ════════════════════════════════════════════════════════════ NAV */
  const VIEW_META = {
    compose:  ['发送短信', '真实 SIP MESSAGE → UFI → 运营商 · 敏感词与黑名单即时校验'],
    records:  ['短信记录', 'MT / MO 全量 · 状态日志 · 失败重发'],
    alerts:   ['告警中心', '运营商欠费 / 余额不足自动识别 · 按手机卡处理'],
    campaign: ['群发短信', '立即 / 定时 / 每日 / 每周 · 匀速出队 · 静默顺延'],
    channels: ['通道与频控', 'UFI 池 = 短信线路通道 · 限速 / 冷却 / 夜间静默'],
    tpl:      ['短信模板', '通知 / 营销 / 验证码 · {变量} 占位'],
    blacklist:['黑名单', '手动 / 退订 / 运营商回执 · 发送与群发自动剔除'],
    words:    ['敏感词', '发送内容即时校验 · 命中拦截'],
    openapi:  ['开放 API', '第三方短信网关 · ts+sign / Bearer · sendSms / 推送']
  };

  const Nav = {
    init() {
      $$('.ufi-tab').forEach(a => a.addEventListener('click', () => this.go(a.dataset.v)));
      $('#btnPause').addEventListener('click', () => this.togglePause());
      $('#modalMask').addEventListener('click', () => Modal.close());
      $('#modalClose').addEventListener('click', () => Modal.close());
      document.addEventListener('keydown', e => { if (e.key === 'Escape') Modal.close(); });
      this.icons();
      PG.bind();
      var start = location.hash.replace('#', '') || 'compose';
      var startEl = document.querySelector('.ufi-tab[data-v="' + start + '"]');
      if (!startEl || startEl.style.display === 'none') {
        var vis = Array.prototype.filter.call(document.querySelectorAll('.ufi-tab'), function (el) {
          return el.style.display !== 'none';
        })[0];
        start = vis ? vis.getAttribute('data-v') : 'compose';
      }
      this.go(start);
    },
    icons() { $$('[data-i]').forEach(el => { el.innerHTML = I(el.dataset.i, 15); }); },
    go(v) {
      if (!VIEW_META[v]) v = 'compose';
      var tab = document.querySelector('.ufi-tab[data-v="' + v + '"]');
      if (tab && tab.style.display === 'none') return;
      APP.view = v;
      $$('.ufi-tab').forEach(a => {
        const on = a.dataset.v === v;
        a.classList.toggle('is-active', on);
        a.classList.toggle('active', on);
      });
      $$('.view').forEach(s => s.classList.toggle('active', s.id === 'v-' + v));
      $('#crumbTitle').textContent = VIEW_META[v][0];
      $('#crumbSub').textContent = VIEW_META[v][1];
      if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
      $('#main').scrollTop = 0;
      Renderer.render(v);
    },
    togglePause() {
      APP.paused = !APP.paused;
      $('#txtPause').textContent = APP.paused ? '继续' : '暂停';
      $('#icoPause').innerHTML = I(APP.paused ? 'play' : 'pause', 14);
      toast(APP.paused ? '已暂停实时刷新' : '已恢复实时刷新', APP.paused ? '数据不再自动更新' : '每 3 秒刷新一次', 'info', 2000);
    }
  };

  /* ════════════════════════════════════════════════════════════ MODAL */
  const Modal = {
    onOk: null,
    open(title, body, foot, wide) {
      $('#modalTitle').textContent = title;
      $('#modalBody').innerHTML = body;
      $('#modalFoot').innerHTML = foot || '';
      const xl = wide === 'xl' || wide === 2;
      $('#modal').classList.toggle('wide', !!wide);
      $('#modal').classList.toggle('task-xl', xl);
      $('#modalMask').classList.add('on');
      $('#modal').classList.add('on');
      $$('#modalFoot [data-mact]').forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.mact === 'close') return this.close();
        if (b.dataset.mact === 'ok') { const ok = this.onOk && await this.onOk(); if (ok !== false) this.close(); }
      }));
    },
    close() {
      $('#modalMask').classList.remove('on');
      $('#modal').classList.remove('on');
      $('#modal').classList.remove('task-xl');
      this.onOk = null;
      if (Records.chatTimer) {
        clearInterval(Records.chatTimer);
        Records.chatTimer = null;
        Records.chatPeer = '';
      }
      if (Records._chatVisHandler) {
        document.removeEventListener('visibilitychange', Records._chatVisHandler);
        Records._chatVisHandler = null;
      }
    },
    isOpen() { return $('#modal').classList.contains('on'); }
  };

  /* ════════════════════════════════════════════════════════════ COMPOSE */
  const Compose = {
    importRows: [],
    init() {
      $$('#composeMode [data-cmode]').forEach(b => b.addEventListener('click', () => {
        APP.mode = b.dataset.cmode;
        $$('#composeMode [data-cmode]').forEach(x => x.classList.toggle('on', x === b));
        if (APP.mode === 'single') this.importRows = [];
        this.renderParams();
        this.renderPeerZone();
        this.check();
      }));
      const body = $('#composeBody');
      body.addEventListener('input', () => this.check());
      $('#composeSigOn').addEventListener('change', () => this.check());
      $('#composeClear').addEventListener('click', () => { body.value = ''; if (APP.mode === 'single') $('#cPeer').value = ''; else $('#cRcpts').value = ''; this.check(); });
      $('#composeSaveTpl').addEventListener('click', () => this.saveTpl());
      $('#composeSend').addEventListener('click', () => this.send());
      $('#composeApplyTpl').addEventListener('click', () => {
        const t = DB.sms.tpl.find(x => x.id === +$('#composeTpl').value);
        if (!t) { toast('未选择模板', '', 'warn', 1800); return; }
        body.value = t.body;
        this.renderVars();
        this.check();
        toast('模板已应用', t.name + '（' + t.type + '）· 变量可点击插入', 'ok');
      });
      $('#composeTpl').addEventListener('change', () => this.renderVars());
      $('#composeGoTpl').addEventListener('click', () => Nav.go('tpl'));
      this.renderAll();
    },
    renderAll() { this.renderTplSel(); this.renderPeerZone(); this.renderParams(); this.renderVars(); this.check(); },
    renderTplSel() {
      $('#composeTpl').innerHTML = '<option value="">— 选择模板 —</option>' +
        DB.sms.tpl.map(t => '<option value="' + t.id + '">' + esc(t.name) + '（' + esc(t.type) + '）</option>').join('');
    },
    renderPeerZone() {
      const z = $('#composePeerZone');
      if (APP.mode === 'single') {
        z.innerHTML = '<label class="mxtag">收件号码</label>' +
          '<input class="inp" id="cPeer" autocomplete="off" placeholder="手机号 / 短号 10086 / 短码" style="width:280px;font-size:14px">';
        $('#cPeer').addEventListener('input', () => this.check());
      } else {
        z.innerHTML = '<label class="mxtag">收件人清单</label>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">' +
          '<button type="button" class="btn sm" id="cTplDl"><span data-i="download"></span>下载导入模板</button>' +
          '<button type="button" class="btn sm" id="cImportBtn"><span data-i="upload"></span>导入 CSV</button>' +
          '<button type="button" class="btn sm" id="cImportClear"' + (this.importRows.length ? '' : ' style="display:none"') + '>清除导入</button>' +
          '<input type="file" id="cImportFile" accept=".txt,.csv,text/plain,text/csv" style="display:none">' +
          '<span style="color:var(--tx-3);font-size:12px">须先写短信内容 → 下载模板（按 {变量} 生成列）→ 导入</span></div>' +
          '<textarea class="inp" id="cRcpts" rows="8" style="width:100%" placeholder="先在上方填写短信内容，再下载 CSV 模板导入&#10;正文无变量时可粘贴纯号码"></textarea>' +
          '<div class="mxtag" id="cRcptsStat" style="margin-top:6px"></div>';
        if (this.importRows.length) {
          $('#cRcpts').value = this.importRows.map(r => r.phone).join('\n');
          $('#cRcpts').readOnly = true;
          $('#cRcpts').style.background = 'var(--bg-2)';
        }
        $('#cRcpts').addEventListener('input', () => {
          if (!this.importRows.length) { this.statRcpts(); this.check(); }
        });
        $('#cTplDl').addEventListener('click', () => {
          const body = (($('#composeBody') || {}).value || '').trim();
          if (!body) {
            toast('请先填写短信内容', '导入模板按正文里的 {变量} 自动生成；无变量则只有号码列', 'warn', 3600);
            try { $('#composeBody').focus(); } catch (e) { /* ignore */ }
            return;
          }
          const vars = extractBodyVars(body);
          downloadText('群发导入模板.csv', buildCampaignCsvTemplate(vars));
          toast('模板已下载', vars.length
            ? ('列：号码、' + vars.join('、') + ' · 填写后导入')
            : '正文无变量，模板仅含「号码」列', 'ok', 3200);
        });
        $('#cImportBtn').addEventListener('click', () => {
          const body = (($('#composeBody') || {}).value || '').trim();
          if (!body) {
            toast('请先填写短信内容', '确定正文与 {变量} 后再导入收件人', 'warn', 3600);
            try { $('#composeBody').focus(); } catch (e) { /* ignore */ }
            return;
          }
          $('#cImportFile').click();
        });
        $('#cImportClear').addEventListener('click', () => {
          this.importRows = [];
          $('#cRcpts').value = '';
          $('#cRcpts').readOnly = false;
          $('#cRcpts').style.background = '';
          $('#cImportClear').style.display = 'none';
          this.statRcpts(); this.check();
          toast('已清除导入', '', 'info', 1800);
        });
        $('#cImportFile').addEventListener('change', async e => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!f) return;
          try {
            if (!DB.blacklist.length) { try { await DB.loadBlack(); } catch (ex) { /* ignore */ } }
            const text = await readCsvFile(f);
            const parsed = parseCampaignCsv(text);
            if (parsed.err) { toast('导入失败', parsed.err, 'err'); return; }
            const black = parsed.rows.filter(r => isCnBlack(r.phone)).map(r => r.phone);
            this.importRows = parsed.rows.filter(r => !isCnBlack(r.phone));
            const box = $('#cRcpts');
            box.value = this.importRows.map(r => r.phone).join('\n');
            box.readOnly = true;
            box.style.background = 'var(--bg-2)';
            $('#cImportClear').style.display = this.importRows.length ? '' : 'none';
            this.statRcpts(); this.check();
            const cols = this.importRows[0] ? Object.keys(this.importRows[0]).filter(k => k !== 'phone') : [];
            toast(
              '文件 ' + (parsed.file_phones || parsed.rows.length) + ' 个 → 导入 ' + this.importRows.length + ' 人',
              (cols.length ? '参数：' + cols.join('、') + ' · ' : '') +
              (black.length ? '黑名单跳过 ' + black.length + '：' + black.join('、') : '预览已更新'),
              black.length ? 'warn' : 'ok', 5200
            );
          } catch (ex) { toast('导入失败', errText(ex), 'err'); }
        });
        iconsIn('#composePeerZone');
      }
      this.statRcpts();
    },
    renderParams() {
      const s = DB.sms.settings;
      const ok = DB.usableChannels();
      const bulk = APP.mode === 'bulk';
      const polOpts = '<option value="0">默认设置（' + esc(STRATEGY_NAME[s.strategy] || s.strategy || 'wrr') + ' · ' + (s.per_hour || 40) + ' 条/时/通道）</option>' +
        (DB.policies || []).map(p => '<option value="' + p.id + '">' + esc(p.name) + ' · ' + esc(STRATEGY_NAME[p.strategy] || p.strategy) + ' · ' + (p.rate || 20) + ' 条/分</option>').join('');
      $('#composeParams').innerHTML =
        '<dl class="spec">' +
        '<dt>发送策略</dt><dd><select class="sel" id="cPolicy" style="width:100%">' + polOpts + '</select></dd>' +
        (bulk
          ? '<dt>发送号码池</dt><dd><select class="sel" id="cPool" style="width:100%">' + poolOptionsHtml('') + '</select></dd>'
          : '<dt>发送通道</dt><dd><select class="sel" id="cChan" style="width:100%">' +
            '<option value="">自动选择（' + esc(STRATEGY_NAME[s.strategy] || s.strategy || 'wrr') + ' · 可用 ' + ok.length + ' 路）</option>' +
            ok.slice(0, 50).map(c => '<option value="' + esc(c.imei) + '">' + esc(c.sim || '—') + ' · ' + esc(c.imei.slice(-6)) + '（时 ' + c.hour + '/' + c.cap + '）</option>').join('') +
            '</select></dd>') +
        (bulk ?
          '<dt>发送速率</dt><dd><input class="inp" type="number" min="1" value="20" id="cRate" style="width:80px"> 条/分</dd>' +
          '<dt>时上限</dt><dd><input class="inp" type="number" min="1" value="' + (s.per_hour || 40) + '" id="cPerHour" style="width:80px"> 条/时/通道</dd>' :
          '<dt>静默窗口</dt><dd>' + (DB.quietNow() ? '<span class="tag warn">夜间静默中</span>' : '<span class="tag ok">放行中</span>') + '</dd>') +
        '<dt>频控</dt><dd>' + (s.per_hour || 40) + ' 条/时/通道 · 间隔 ' + (s.gap_s || 6) + 's</dd>' +
        '</dl>' +
        (bulk ? '<div class="note plain" style="margin-top:10px"><span class="ni">' + I('info', 15) + '</span><div class="nb">群发须指定<b>号码池</b>，后台仅从该池可用通道匀速出队；黑名单自动剔除。</div></div>' : '');
      const polSel = $('#cPolicy');
      if (polSel) polSel.addEventListener('change', () => {
        const p = (DB.policies || []).find(x => x.id === +polSel.value);
        if (p && bulk) {
          if ($('#cRate')) $('#cRate').value = p.rate || 20;
          if ($('#cPerHour')) $('#cPerHour').value = p.per_hour || 40;
        }
      });
    },
    renderVars() {
      const t = DB.sms.tpl.find(x => x.id === +$('#composeTpl').value);
      $('#composeVars').innerHTML = t
        ? '<div class="mxtag" style="margin:10px 0 4px">点击插入变量：</div>' +
          String(t.vars || '').split(',').map(v => v.trim()).filter(Boolean).map(v =>
            '<button class="var-chip" data-var="' + esc(v) + '">{ ' + esc(v) + ' }</button>').join('')
        : '';
      $$('#composeVars [data-var]').forEach(b => b.addEventListener('click', () => {
        const body = $('#composeBody');
        body.value = body.value + '{' + b.dataset.var + '}';
        this.check();
      }));
    },
    statRcpts() {
      const el = $('#cRcptsStat');
      if (!el) return;
      const st = this.parseRcpts();
      el.innerHTML = st.raw ? ('共 ' + st.raw + ' 个 · 有效 <b>' + st.valid + '</b> · 去重 ' + st.dup + ' · 黑名单剔除 <b>' + st.black + '</b>') : '';
    },
    parseRcpts() {
      if (APP.mode === 'bulk' && this.importRows.length) {
        let black = 0;
        const clean = this.importRows.filter(r => {
          if (isCnBlack(r.phone)) { black++; return false; }
          return true;
        });
        return { raw: this.importRows.length, valid: clean.length, dup: 0, black: black, nums: clean.map(r => r.phone), rows: clean };
      }
      const raw = APP.mode === 'bulk' ? (($('#cRcpts') || {}).value || '') : (($('#cPeer') || {}).value || '');
      let list;
      if (APP.mode === 'single') {
        const one = normalizePhone(raw);
        list = one ? [one] : [];
      } else {
        /* 按行/分隔符规范化，保留 +E.164；禁止从 +1… 中抠 11 位大陆号 */
        list = raw.split(/[\s,;|/\n\r]+/).map(normalizePhone).filter(Boolean);
        if (!list.length) {
          const intl = raw.match(/\+[1-9]\d{6,14}/g) || [];
          list = intl.map(normalizePhone).filter(Boolean);
        }
      }
      const set = new Set();
      let dup = 0, black = 0;
      const clean = list.filter(p => {
        if (set.has(p)) { dup++; return false; }
        set.add(p);
        if (isCnBlack(p)) { black++; return false; }
        return true;
      });
      return { raw: list.length, valid: clean.length, dup: dup, black: black, nums: clean, rows: clean.map(p => ({ phone: p })) };
    },
    check() {
      const body = $('#composeBody').value;
      const sigOn = $('#composeSigOn').checked;
      const sig = DB.sms.settings.sig || '';
      const full = (sigOn && body && body.indexOf('【') !== 0 ? sig : '') + body;
      const n = full.length;
      $('#composeCount').textContent = n + ' 字 · ' + segCount(n) + ' 条' + (n > 500 ? '（超长）' : '');
      const sigLbl = $('#sigText');
      if (sigLbl) sigLbl.textContent = sig || '【未设置签名】';
      const hits = DB.checkWords(full);
      let html = '';
      if (hits.length) {
        html += '<div class="note err" style="margin-top:12px"><span class="ni">' + I('x-circle', 15) + '</span><div class="nb"><b>命中敏感词 ' + hits.length + ' 个：</b>' +
          hits.map(w => '<span class="tag err">' + esc(w) + '</span>').join(' ') + ' —— 发送将被拦截，请修改内容或到「敏感词」调整词库。</div></div>';
      }
      const st = this.parseRcpts();
      if (st.black > 0) {
        html += '<div class="note warn" style="margin-top:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>黑名单号码 ' + st.black + ' 个</b>已自动剔除（群发）/ 拒绝发送（单发）。</div></div>';
      }
      if (DB.quietNow()) {
        const mkt = _isMarketing(full);
        if (mkt) html += '<div class="note warn" style="margin-top:12px"><span class="ni">' + I('clock', 15) + '</span><div class="nb"><b>夜间静默中</b>（' + (DB.sms.settings.quiet_from || '') + ' → 次日 ' + (DB.sms.settings.quiet_to || '') + '）：营销类单发将被拒绝，请改用群发（自动顺延至静默结束）。</div></div>';
      }
      const pv = $('#composePreview');
      if (pv) {
        if (APP.mode === 'bulk' && st.rows && st.rows.length) {
          const sample = st.rows[0];
          const rendered = renderSmsBody(full, sample);
          pv.innerHTML = '<div class="note info" style="margin-top:12px"><span class="ni">' + I('eye', 15) + '</span><div class="nb"><b>发送预览（群发 ' + st.valid + ' 人，已按导入参数替换）</b>' +
            '<div style="margin-top:6px;padding:10px 12px;background:var(--bg-2);border-radius:8px;font-size:14px;line-height:1.6">' +
            '<div style="color:var(--tx-3);font-size:11px;margin-bottom:4px">' + esc(sample.phone) + (st.valid > 1 ? ' · 另有 ' + (st.valid - 1) + ' 人' : '') + '</div>' +
            (rendered ? esc(rendered) : '<span style="color:var(--tx-3)">（空）</span>') + '</div>' +
            (st.valid > 1 ? '<div style="margin-top:8px">' + campaignPreviewHtml(full, st.rows, 4) + '</div>' : '') +
            '</div></div>';
        } else {
          const demo = full.replace(/\{[^}]*\}/g, m => '<b style="color:var(--ac)">' + esc(m) + '</b>');
          pv.innerHTML = full ? '<div class="note info" style="margin-top:12px"><span class="ni">' + I('eye', 15) + '</span><div class="nb"><b>发送预览' +
            (APP.mode === 'bulk' ? '（导入 CSV 后将按行替换变量）' : '') + '</b>' +
            '<div style="margin-top:6px;padding:10px 12px;background:var(--bg-2);border-radius:8px;font-size:14px;line-height:1.6">' + (demo || '<span style="color:var(--tx-3)">（空）</span>') + '</div></div></div>' : '';
        }
        iconsIn('#composePreview');
      }
      $('#composeChecks').innerHTML = html;
      iconsIn('#composeChecks');
      $('#composeSendTxt').textContent = APP.mode === 'single' ? '立即发送' : '创建群发任务';
    },
    saveTpl() {
      const body = $('#composeBody').value.trim();
      if (!body) { toast('内容为空', '先编辑内容再存为模板', 'warn'); return; }
      Modal.open('存为模板',
        '<label class="mxtag">模板名称</label><input class="inp" id="tpName" style="width:100%" placeholder="如：发货通知-华南仓">' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">类型</label><select class="sel" id="tpType" style="width:100%"><option>通知</option><option>营销</option><option>验证码</option></select></div>' +
        '<div><label class="mxtag">变量（逗号分隔）</label><input class="inp" id="tpVars" style="width:100%" placeholder="订单号, 运单号"></div></div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存模板</button>');
      Modal.onOk = async () => {
        const name = ($('#tpName').value || '').trim();
        if (!name) { toast('缺少模板名', '', 'err'); return false; }
        try {
          await DB.tplAdd({ name: name, type: $('#tpType').value, vars: ($('#tpVars').value || '').trim(), body: body });
          this.renderTplSel();
          const last = DB.sms.tpl.find(x => x.name === name);
          if (last) $('#composeTpl').value = last.id;
          this.renderVars();
          toast('模板已保存', name, 'ok');
        } catch (ex) { toast('保存失败', errText(ex), 'err'); return false; }
      };
    },
    async send() {
      const bodyRaw = $('#composeBody').value.trim();
      const policyId = +(($('#cPolicy') || {}).value || 0);
      const sigOn = $('#composeSigOn').checked;
      const sig = DB.sms.settings.sig || '';
      const body = (sigOn && bodyRaw && bodyRaw.indexOf('【') !== 0 ? sig : '') + bodyRaw;
      if (!bodyRaw) { toast('内容为空', '请填写短信内容', 'err'); return; }
      const hits = DB.checkWords(body);
      if (hits.length) { toast('命中敏感词', '「' + hits.join('、') + '」，发送已拦截', 'err'); return; }
      const chan = $('#cChan') ? $('#cChan').value : '';
      if (APP.mode === 'single') {
        const peer = normalizePhone($('#cPeer').value || '');
        if (!peer) { toast('号码无效', '支持手机号、短号（如 10086）或字母数字短码', 'err'); return; }
        if (isCnBlack(peer)) { toast('黑名单号码', peer + ' 拒绝发送（可在黑名单模块移除）', 'err'); return; }
        const btn = $('#composeSend');
        btn.disabled = true;
        try {
          const msg = await DB.send(peer, body, chan || null, policyId);
          if (!msg || msg.state === 'failed') {
            toast('发送失败', (msg && msg.err) || '无可用短信通道', 'err', 4200);
          } else {
            toast('通道已确认', peer + ' · 通道 ' + (msg.sim || '—') + ' · MESSAGE 200 OK', 'ok', 4200);
          }
        } catch (ex) { toast('发送失败', errText(ex), 'err'); }
        btn.disabled = false;
        this.check();
      } else {
        const st = this.parseRcpts();
        if (!st.valid) { toast('收件人为空', '支持手机号、短号或导入 CSV', 'err'); return; }
        const tpl = DB.sms.tpl.find(x => x.id === +$('#composeTpl').value);
        const poolId = (($('#cPool') || {}).value || '').trim();
        if (!poolId) { toast('请选择号码池', '群发必须指定发送号码池', 'err'); return; }
        try {
          const t = await DB.addTask({
            name: ((tpl && tpl.name) || '自定义内容') + ' · ' + (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日批次',
            tpl_id: (tpl && tpl.id) || '',
            body: body, rcpts: st.rows,
            rate: Math.max(1, +($('#cRate') || {}).value || 20),
            per_hour: Math.max(1, +($('#cPerHour') || {}).value || 40),
            policy_id: policyId,
            pool_id: poolId,
            when: 'now'
          });
          toast('群发任务已创建', '#' + (t && t.id) + ' · 池 ' + poolId + ' · ' + (t && t.total) + ' 个收件人', 'ok', 4200);
          this.importRows = [];
          Nav.go('campaign');
        } catch (ex) { toast('创建失败', errText(ex), 'err'); }
      }
    }
  };
  function _isMarketing(body) { return (body || '').indexOf('退订') >= 0 || /大促|优惠|领券|满减|秒杀|折扣/.test(body || ''); }

  /* ════════════════════════════════════════════════════════════ RECORDS（服务端分页） */
  const Records = {
    chatPeer: '',
    chatImei: '',
    chatTimer: null,
    init() {
      const cSel = $('#msgCountry');
      if (cSel && window.UfiGeo && UfiGeo.FILTER_OPTIONS) {
        cSel.innerHTML = '<option value="">全部国家</option>' +
          UfiGeo.FILTER_OPTIONS.map(o => '<option value="' + o[0] + '">' + o[1] + ' (' + o[0] + ')</option>').join('');
        cSel.addEventListener('change', e => {
          APP.msgFilter.country = e.target.value;
          DB.recordsQ.country = e.target.value;
          DB.recordsQ.page = 1;
          this.table();
        });
      }
      $('#msgDir').addEventListener('change', e => { APP.msgFilter.dir = e.target.value; DB.recordsQ.dir = e.target.value; DB.recordsQ.page = 1; this.table(); });
      let qt = null;
      $('#msgQ').addEventListener('input', e => {
        APP.msgFilter.q = e.target.value;
        clearTimeout(qt);
        qt = setTimeout(() => { DB.recordsQ.q = APP.msgFilter.q; DB.recordsQ.page = 1; this.table(); }, 350);
      });
      let tt = null;
      const taskInp = $('#msgTask');
      if (taskInp) taskInp.addEventListener('input', e => {
        clearTimeout(tt);
        const v = e.target.value;
        tt = setTimeout(() => { DB.recordsQ.task = v; DB.recordsQ.page = 1; this.table(); }, 350);
      });
      bindDateRange('msgFrom', 'msgTo', 'msgDateApply', 'msgDateReset', r => {
        DB.recordsQ.date_from = r.date_from;
        DB.recordsQ.date_to = r.date_to;
        DB.recordsQ.page = 1;
        this.table();
      });
      const msgReset = $('#msgDateReset');
      if (msgReset) {
        msgReset.addEventListener('click', () => {
          if (cSel) cSel.value = '';
          APP.msgFilter.country = '';
          DB.recordsQ.country = '';
          APP.msgFilter.dir = '';
          DB.recordsQ.dir = '';
          if ($('#msgDir')) $('#msgDir').value = '';
          if ($('#msgQ')) $('#msgQ').value = '';
          APP.msgFilter.q = '';
          DB.recordsQ.q = '';
          if ($('#msgTask')) $('#msgTask').value = '';
          DB.recordsQ.task = '';
        }, true);
      }
      $('#msgBody').addEventListener('click', async e => {
        const b = e.target.closest('[data-msact]');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        const id = +b.dataset.mid;
        // 按钮自带 peer/imei，避免 3s 刷新替换 list 后找不到记录导致静默失败
        const fromBtn = {
          id: id,
          peer: b.dataset.peer || '',
          imei: b.dataset.imei || '',
          body: b.dataset.body || '',
          sim: b.dataset.sim || '',
          dir: b.dataset.dir || '',
          state: b.dataset.state || '',
          err: b.dataset.err || '',
          created: b.dataset.created || ''
        };
        const m = (DB.records.list || []).find(x => +x.id === id) || fromBtn;
        const row = Object.assign({}, m, {
          peer: m.peer || fromBtn.peer,
          imei: m.imei || fromBtn.imei,
          body: m.body || fromBtn.body
        });
        if (b.dataset.msact === 'view') this.showMsg(row);
        else if (b.dataset.msact === 'chat') this.openChat(row);
        else if (b.dataset.msact === 'resend') {
          if (!row.peer) { toast('无法重发', '缺少对端号码', 'err'); return; }
          b.disabled = true;
          try {
            const n = await DB.send(row.peer, row.body, row.imei && DB.channelList().some(c => c.imei === row.imei) ? row.imei : null);
            toast(n && n.state !== 'failed' ? '已重新发送' : '重发失败', (n && n.err) || (row.peer + ' · 已出队'), n && n.state !== 'failed' ? 'ok' : 'err');
            await this.table();
          } catch (ex) { toast('重发失败', errText(ex), 'err'); }
          b.disabled = false;
        }
      });
    },
    async table() {
      let rec;
      try { rec = await DB.loadRecords(); } catch (ex) { toast('记录加载失败', errText(ex), 'err'); return; }
      // 对话弹窗打开时不要重绘表格，避免打断点击/销毁按钮
      if (Modal.isOpen() && this.chatPeer) {
        $('#msgCount').textContent = rec.total + ' 条';
        return;
      }
      $('#msgCount').textContent = rec.total + ' 条';
      $('#msgBody').innerHTML = rec.list.length ? rec.list.map(m => {
        const st = SMS_MSG_STATE[m.state] || { label: m.state, cls: '' };
        const ops = [['chat', '对话', 'primary'], ['view', '状态日志', '']];
        if (m.dir === 'out' && m.state === 'failed') ops.push(['resend', '重发', '']);
        const dataAttrs = ' data-mid="' + m.id + '"' +
          ' data-peer="' + esc(m.peer || '') + '"' +
          ' data-imei="' + esc(m.imei || '') + '"' +
          ' data-body="' + esc(m.body || '') + '"' +
          ' data-sim="' + esc(m.sim || '') + '"' +
          ' data-dir="' + esc(m.dir || '') + '"' +
          ' data-state="' + esc(m.state || '') + '"' +
          ' data-err="' + esc(m.err || '') + '"' +
          ' data-created="' + esc(m.created || '') + '"';
        const peerCc = (window.UfiGeo && UfiGeo.peerChip(m)) || '';
        const simCc = (window.UfiGeo && UfiGeo.simChip(m)) || '';
        return '<tr><td class="mono">' + esc(fmtSmsTime(m.created)) + '</td>' +
          '<td>' + (m.task_name ? '<b>' + esc(m.task_name) + '</b><div class="mxtag">#' + (m.task_id || '') + '</div>' : '<span class="mxtag">—</span>') + '</td>' +
          '<td class="sms-num-cell">' +
            '<span class="sms-num-row"><span class="mono">' + esc(m.sim || '—') + '</span>' + (simCc || '') + '</span>' +
            '<div class="mxtag">' + esc(m.imei || '') + '</div></td>' +
          '<td>' + dirCellHtml(m.dir) + '</td>' +
          '<td class="sms-num-cell sms-num-cell--peer">' +
            '<span class="sms-num-row"><span class="mono">' + esc(m.peer) + '</span>' + peerCc + '</span></td>' +
          '<td class="sms-body-cell copyable" data-copy="' + esc(m.body) + '" title="' + esc(m.body) + '（双击复制）">' + esc(m.body) + '</td>' +
          '<td class="sms-state-cell"><span class="tag ' + st.cls + '">' + st.label + '</span>' + (m.err ? '<div class="mxtag" style="color:var(--st-err)">' + esc(m.err) + '</div>' : '') + '</td>' +
          '<td class="col-act"><div class="rowbtns rowbtns--center">' + ops.map(o =>
            '<button class="btn xs ' + o[2] + '" data-msact="' + o[0] + '"' + dataAttrs + '>' + o[1] + '</button>').join('') + '</div></td></tr>';
      }).join('') : '<tr><td colspan="8"><div class="empty">' + I('inbox', 34) + '无匹配记录</div></td></tr>';
      $('#pgRecords').innerHTML = PG.footSrv('records', rec);
    },
    showMsg(m) {
      // Preview only — wire domain is EXTERNAL_IP (device AOR), not the GUI hostname.
      const domain = (window.UFI_SIP_DOMAIN || window.EXTERNAL_IP_ADDR || location.hostname || '').replace(/^https?:\/\//, '');
      // Reconstruct preview from DB fields (not wire capture).
      // Out: R-URI=IMEI, X-SMS=peer; In: From=IMEI, R-URI=IMEI, X-SMS=peer.
      const peer = m.peer || '—';
      const imei = m.imei || '—';
      const raw = [
        (m.dir === 'out' ? 'MESSAGE sip:' + imei : 'MESSAGE sip:' + imei) + '@' + domain + ' SIP/2.0',
        'Via: SIP/2.0/UDP …',
        'From: <sip:' + (m.dir === 'out' ? (m.sim || 'sms') : imei) + '@' + domain + '>',
        'To: <sip:' + imei + '@' + domain + '>',
        'X-SMS: ' + peer + '   ← 对端号码（固件 sms-gw / MO 收信）',
        'X-VOLTE: ' + peer + '   ← 兼容头（通话方言；短信以 X-SMS 为准）',
        'Content-Type: text/plain',
        '',
        (m.body && m.body !== 'BIN:') ? m.body : '(无正文：历史 BIN: 占位或非 text/plain)'
      ].join('\n');
      Modal.open('状态日志 · #' + m.id,
        '<div class="step-log" style="max-height:340px"><span class="cmd">' + esc(raw) + '</span></div>' +
        '<dl class="spec" style="margin-top:12px"><dt>通道</dt><dd>' + esc(m.sim || '—') + '（' + esc(m.imei || '—') + '）</dd>' +
        '<dt>时间</dt><dd>' + esc(fmtSmsTime(m.created)) + '</dd>' +
        '<dt>状态</dt><dd>' + (SMS_MSG_STATE[m.state] || { label: m.state }).label + (m.err ? ' · ' + esc(m.err) : '') + '</dd></dl>',
        '<button class="btn" data-mact="close">关闭</button>', true);
    },
    bubbleHtml(list) {
      if (!list.length) {
        return '<div class="sms-chat-empty">' + I('message', 36) + '<div>暂无与该号码的往来短信</div></div>';
      }
      return list.map((m, i) => {
        const mine = m.dir === 'out';
        const prev = i > 0 ? list[i - 1] : null;
        const sameSide = prev && prev.dir === m.dir;
        const st = SMS_MSG_STATE[m.state] || { label: m.state, cls: '' };
        const body = (m.body && m.body !== 'BIN:') ? m.body : '（无正文）';
        /* 左侧对方=对端号码；右侧我方通道=SIM 号码 */
        const num = mine ? (m.sim || m.imei || '—') : (m.peer || '—');
        const ccChip = mine
          ? ((window.UfiGeo && UfiGeo.simChip(m)) || '')
          : ((window.UfiGeo && UfiGeo.peerChip(m)) || '');
        const foot = fmtSmsTime(m.created) +
          (mine ? (' · ' + (st.label || '')) : '') +
          (m.err ? ' · ' + m.err : '');
        return '<div class="sms-bubble ' + (mine ? 'out' : 'in') + (sameSide ? ' sms-bubble--gap2' : '') + '">' +
          '<div class="sms-bubble-num">' + esc(num) + (ccChip ? ' ' + ccChip : '') + '</div>' +
          '<div class="sms-bubble-body">' + esc(body) + '</div>' +
          '<div class="sms-bubble-meta">' + esc(foot) + '</div></div>';
      }).join('');
    },
    async openChat(seed) {
      const raw = String((seed && seed.peer != null) ? seed.peer : (seed || '')).trim();
      // 规范化失败时仍用原始 peer（库内存的短号/短码），避免对话打不开
      const peer = normalizePhone(raw) || raw;
      if (!peer || peer.length < 2) {
        toast('号码无效', '该记录缺少对端号码，无法打开对话', 'err');
        return;
      }
      this.chatPeer = peer;
      this.chatImei = (seed && seed.imei && DB.channelList().some(c => c.imei === seed.imei)) ? seed.imei : '';
      if (this.chatTimer) { clearInterval(this.chatTimer); this.chatTimer = null; }
      if (this._chatVisHandler) {
        document.removeEventListener('visibilitychange', this._chatVisHandler);
        this._chatVisHandler = null;
      }
      try {
        Modal.open('短信对话 · ' + peer,
          '<div class="sms-chat">' +
            '<div class="sms-chat-hd">' +
              '<div><b>客户</b> <span class="mono">' + esc(peer) + '</span></div>' +
              '<div class="sms-chat-live">' +
                '<span class="live-dot" title="自动刷新中"></span>' +
                '<span class="mxtag" id="chatMeta">加载中…</span>' +
              '</div>' +
            '</div>' +
            '<div class="sms-chat-log-wrap">' +
              '<div class="sms-chat-log" id="chatLog"><div class="sms-chat-empty">加载会话…</div></div>' +
              '<button type="button" class="sms-chat-jump" id="chatJumpNew" hidden>有新短信 · 回到底部</button>' +
            '</div>' +
            '<div class="sms-chat-compose">' +
              '<textarea class="inp" id="chatBody" rows="2" placeholder="输入短信内容，回车发送（Shift+回车换行）"></textarea>' +
              '<button type="button" class="btn primary" id="chatSend"><span data-i="send"></span>发送</button>' +
            '</div>' +
          '</div>',
          '<button class="btn" data-mact="close">关闭</button>', 'xl');
        iconsIn('#modalBody');

        let lastSig = '';
        let loading = false;
        let pendingNew = 0;

        const threadSig = (list) => (list || []).map(m =>
          [m.id, m.dir, m.state, m.err || '', (m.body || '').length].join(':')
        ).join('|');

        const setMeta = (th, extra) => {
          const meta = $('#chatMeta');
          if (!meta) return;
          const list = (th && th.list) || [];
          const last = list[list.length - 1];
          const parts = [
            (th && th.total != null ? th.total : list.length) + ' 条往来',
            '自动刷新'
          ];
          if (last && last.sim) parts.push('通道 ' + last.sim);
          if (isCnBlack(peer)) parts.push('黑名单');
          if (extra) parts.push(extra);
          meta.textContent = parts.join(' · ');
        };

        const showJump = (n) => {
          const btn = $('#chatJumpNew');
          if (!btn) return;
          if (n > 0) {
            btn.hidden = false;
            btn.textContent = n > 1 ? ('有 ' + n + ' 条新短信 · 回到底部') : '有新短信 · 回到底部';
          } else {
            btn.hidden = true;
          }
        };

        const load = async (silent) => {
          if (!Modal.isOpen() || this.chatPeer !== peer) return;
          if (document.hidden) return;
          if (loading) return;
          loading = true;
          try {
            const th = await DB.loadThread(peer);
            if (!Modal.isOpen() || this.chatPeer !== peer) return;
            const log = $('#chatLog');
            if (!log) return;
            const list = th.list || [];
            const sig = threadSig(list);
            const changed = sig !== lastSig;
            const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
            if (!silent || changed) {
              const prevCount = lastSig ? lastSig.split('|').filter(Boolean).length : 0;
              const grew = list.length > prevCount;
              log.innerHTML = this.bubbleHtml(list);
              if (!silent || atBottom) {
                log.scrollTop = log.scrollHeight;
                pendingNew = 0;
                showJump(0);
              } else if (grew && silent) {
                pendingNew += (list.length - prevCount);
                showJump(pendingNew);
              }
              lastSig = sig;
            }
            setMeta(th, silent && changed ? '已更新' : '');
            const lastOut = [...list].reverse().find(x => x.dir === 'out' && x.imei);
            if (lastOut && DB.channelList().some(c => c.imei === lastOut.imei)) this.chatImei = lastOut.imei;
          } catch (ex) {
            if (!silent) toast('会话加载失败', errText(ex), 'err');
            const meta = $('#chatMeta');
            if (meta && silent) meta.textContent = (meta.textContent || '').replace(/ · 已更新$/, '') + ' · 刷新失败';
          } finally {
            loading = false;
          }
        };

        await load(false);

        const sendNow = async () => {
          const body = (($('#chatBody') || {}).value || '').trim();
          if (!body) { toast('内容为空', '请输入短信', 'warn'); return; }
          if (isCnBlack(peer)) { toast('黑名单号码', peer + ' 拒绝发送', 'err'); return; }
          const hits = DB.checkWords(body);
          if (hits.length) { toast('命中敏感词', '「' + hits.join('、') + '」', 'err'); return; }
          const btn = $('#chatSend');
          if (btn) btn.disabled = true;
          try {
            const msg = await DB.send(peer, body, this.chatImei || null);
            if (!msg || msg.state === 'failed') {
              toast('发送失败', (msg && msg.err) || '无可用通道', 'err');
            } else {
              toast('已发送', peer + ' · ' + (msg.sim || '—'), 'ok', 2800);
              if ($('#chatBody')) $('#chatBody').value = '';
            }
            await load(false);
          } catch (ex) { toast('发送失败', errText(ex), 'err'); }
          if (btn) btn.disabled = false;
        };

        const sendBtn = $('#chatSend');
        const bodyEl = $('#chatBody');
        const jumpBtn = $('#chatJumpNew');
        const logEl = $('#chatLog');
        if (sendBtn) sendBtn.addEventListener('click', sendNow);
        if (bodyEl) bodyEl.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); }
        });
        if (jumpBtn) jumpBtn.addEventListener('click', () => {
          const log = $('#chatLog');
          if (log) log.scrollTop = log.scrollHeight;
          pendingNew = 0;
          showJump(0);
        });
        if (logEl) logEl.addEventListener('scroll', () => {
          if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80) {
            pendingNew = 0;
            showJump(0);
          }
        });

        const tick = () => { load(true); };
        this.chatTimer = setInterval(tick, 2000);
        this._chatVisHandler = () => {
          if (!document.hidden && Modal.isOpen() && this.chatPeer === peer) load(true);
        };
        document.addEventListener('visibilitychange', this._chatVisHandler);

        const stop = () => {
          if (this.chatTimer) { clearInterval(this.chatTimer); this.chatTimer = null; }
          if (this._chatVisHandler) {
            document.removeEventListener('visibilitychange', this._chatVisHandler);
            this._chatVisHandler = null;
          }
          this.chatPeer = '';
        };
        $$('#modalFoot [data-mact="close"], #modalClose').forEach(b => {
          b.addEventListener('click', stop, { once: true });
        });
        const mask = $('#modalMask');
        if (mask) mask.addEventListener('click', stop, { once: true });
      } catch (ex) {
        this.chatPeer = '';
        toast('打开对话失败', errText(ex), 'err');
      }
    }
  };

  /* ════════════════════════════════════════════════════════════ CAMPAIGN */
  const Campaign = {
    kindFilter: '',
    init() {
      $('#taskBody').addEventListener('click', async e => {
        const b = e.target.closest('[data-tact]');
        if (!b) return;
        b.disabled = true;
        try {
          await this.act(b.dataset.tact, +b.dataset.tid, b.dataset.rtype || 'batch');
        } catch (ex) { toast('操作失败', errText(ex), 'err'); }
        b.disabled = false;
      });
      if ($('#taskKindFilter')) {
        $('#taskKindFilter').addEventListener('change', e => {
          this.kindFilter = e.target.value || '';
          PG.st.campaign = PG.st.campaign || { page: 1, size: 10 };
          PG.st.campaign.page = 1;
          this.render();
        });
      }
      bindDateRange('taskFrom', 'taskTo', 'taskDateApply', 'taskDateReset', async r => {
        DB.tasksQ.date_from = r.date_from;
        DB.tasksQ.date_to = r.date_to;
        try { await DB.loadTasks(); await this.render(); }
        catch (ex) { toast('查询失败', errText(ex), 'err'); }
      });
    },
    async render() {
      const h = DB.health();
      const all = DB.sms.tasks || [];
      const recurN = all.filter(t => t.row_type === 'recur' && t.state === 'recur_on').length;
      $('#kpiCampaign').innerHTML = [
        ['进行中', h.running || 0, '队列积压 ' + num(h.queued || 0) + ' 条', h.running ? 'purple' : ''],
        ['定时待发', h.scheduled || 0, '指定时间 / 静默顺延', 'info'],
        ['周期计划', recurN || h.schedOn || 0, '每日 / 每周启用中', ''],
        ['今日发送', num(h.sentToday || 0), '全部通道合计', 'ok']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');

      const filtered = all.filter(t => {
        if (!this.kindFilter) return true;
        if (this.kindFilter === 'recur') return t.row_type === 'recur';
        return t.row_type !== 'recur';
      });
      const pg = PG.cut('campaign', filtered, 10);
      if ($('#taskCount')) {
        const dr = DB.tasksQ || {};
        $('#taskCount').textContent = filtered.length + ' 条' +
          ((dr.date_from || dr.date_to || this.kindFilter) ? '（已筛选）' : '');
      }
      $('#taskBody').innerHTML = pg.list.length ? pg.list.map(t => {
        const isRecur = t.row_type === 'recur';
        const pct = !isRecur && t.total ? Math.round((t.sent || 0) / t.total * 100) : 0;
        const st = SMS_TASK_STATE[t.state] || { label: t.state, cls: '' };
        const ops = [];
        if (isRecur) {
          ops.push([t.state === 'recur_on' ? 'pause' : 'start', t.state === 'recur_on' ? '停用' : '启用', t.state === 'recur_on' ? '' : 'primary']);
        } else {
          if (t.state === 'running') ops.push(['pause', '暂停', '']);
          if (t.state === 'paused' || t.state === 'scheduled') ops.push(['start', '开始发送', 'primary']);
        }
        ops.push(['detail', '详情', '']);
        ops.push(['del', '删除', '']);
        const kindTag = isRecur
          ? '<span class="tag purple">' + esc(SMS_KIND[t.kind] || t.kind || '周期') + '</span><div class="mxtag mono">' + esc(t.run || '') + '</div>'
          : (t.state === 'scheduled'
            ? '<span class="tag info">定时一次</span><div class="mxtag mono">' + esc(t.start_at || '') + '</div>'
            : '<span class="tag">批次</span>');
        const prog = isRecur
          ? '<span class="mxtag">' + esc(t.note || t.last || '未执行') + '</span>'
          : '<div class="prog"><i style="width:' + pct + '%"></i></div><span class="mxtag">' + num(t.sent || 0) + '/' + num(t.total || 0) + ' · 失败 ' + (t.fail || 0) + '</span>';
        return '<tr><td><b>' + esc(t.name) + '</b><div class="mxtag">#' + t.id + ' · ' + esc(fmtAgo(t.created ? Math.max(0, (Date.now() - new Date(t.created.replace(' ', 'T'))) / 60000) : null)) + '</div></td>' +
          '<td>' + kindTag + '</td>' +
          '<td><span class="tag mono">' + esc(t.pool_id || '—') + '</span></td>' +
          '<td>' + esc((DB.sms.tpl.find(x => String(x.id) === String(t.tpl_id)) || { name: t.tpl_id ? '已删模板' : '自定义' }).name) + '</td>' +
          '<td class="num">' + (t.total ? num(t.total) : '—') + '</td>' +
          '<td class="num">' + (t.rate || 20) + ' 条/分<br><span style="color:var(--tx-3)">' + (t.per_hour || 40) + ' 条/时/通道</span></td>' +
          '<td>' + prog + '</td>' +
          '<td><span class="tag ' + st.cls + '">' + st.label + '</span></td>' +
          '<td class="col-act"><div class="rowbtns">' + ops.map(o =>
            '<button class="btn xs ' + o[2] + '" data-tact="' + o[0] + '" data-tid="' + t.id + '" data-rtype="' + (isRecur ? 'recur' : 'batch') + '">' + o[1] + '</button>').join('') + '</div></td></tr>';
      }).join('') : '<tr><td colspan="9"><div class="empty">' + I('send', 34) + '暂无群发任务 · 点右上角新建（须选号码池）</div></td></tr>';
      $('#pgCampaign').innerHTML = PG.foot('campaign', pg);
      $('#cntCampaign').textContent = all.length;
    },
    async showDetail(id, rowType) {
      let pack;
      try { pack = await DB.taskItems(id, rowType === 'recur' ? 'recur' : 'batch'); }
      catch (ex) { toast('加载详情失败', errText(ex), 'err'); return; }
      const task = pack.task || {};
      const items = pack.items || [];
      const stLabel = (s) => (SMS_MSG_STATE[s] || { label: s || '—', cls: '' });
      const rows = items.length ? items.map(m => {
        const st = stLabel(m.state);
        return '<tr><td class="mono">' + esc(m.created || '') + '</td>' +
          '<td class="mono">' + esc(m.peer || '') + '</td>' +
          '<td class="mono">' + esc(m.sim || '—') + '</td>' +
          (rowType === 'recur' ? '<td>' + esc(m.task_name || '') + '</td>' : '') +
          '<td><span class="tag ' + st.cls + '">' + st.label + '</span>' +
          (m.err ? '<div class="mxtag" style="color:var(--st-err)">' + esc(m.err) + '</div>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="5">还没有出队记录</td></tr>';
      const pending = (task.pending || []);
      const pendHtml = pending.length
        ? '<div class="note plain" style="margin-top:10px"><div class="nb">未发送 ' + pending.length + ' 个：' + esc(pending.slice(0, 30).join('、')) + (pending.length > 30 ? '…' : '') + '</div></div>'
        : '';
      const batches = (task.batches || []);
      const batchHtml = batches.length
        ? '<div class="mxtag" style="margin-bottom:8px">已生成 ' + batches.length + ' 个批次：' +
          batches.map(b => '#' + b.id + ' ' + esc(b.name) + ' ' + (b.sent || 0) + '/' + (b.total || 0)).join(' · ') + '</div>'
        : (rowType === 'recur' ? '<div class="mxtag">尚未生成执行批次</div>' : '');
      Modal.open('执行详情 · ' + (task.name || ('#' + id)),
        '<div style="margin-bottom:8px">状态 ' + esc((SMS_TASK_STATE[task.state] || {}).label || task.state || '') +
          (task.total != null ? ' · 已发 ' + (task.sent || 0) + '/' + task.total + ' · 失败 ' + (task.fail || 0) : '') + '</div>' +
        batchHtml +
        '<div class="tablewrap" style="max-height:360px"><table class="grid"><thead><tr><th>时间</th><th>收件人</th><th>通道</th>' +
          (rowType === 'recur' ? '<th>批次</th>' : '') + '<th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + pendHtml,
        '<button class="btn" data-modal-cancel>关闭</button>');
    },
    async act(a, id, rowType) {
      if (a === 'detail') {
        await this.showDetail(id, rowType);
        return;
      }
      if (rowType === 'recur') {
        if (a === 'start' || a === 'pause') {
          await DB.schedAct(id, 'toggle');
          toast(a === 'start' ? '周期计划已启用' : '周期计划已停用', '#' + id, a === 'start' ? 'ok' : 'warn');
        } else if (a === 'del') {
          await DB.schedAct(id, 'del');
          toast('周期计划已删除', '#' + id, 'info', 2000);
        }
      } else if (a === 'start') {
        await DB.taskAct(id, 'start');
        toast('任务开始发送', '后台线程按速率匀速出队', 'ok');
      } else if (a === 'pause') {
        await DB.taskAct(id, 'pause');
        toast('任务已暂停', '队列保留，可随时恢复', 'warn');
      } else if (a === 'del') {
        await DB.taskAct(id, 'del');
        toast('任务已删除', '#' + id, 'info', 2000);
      }
      await DB.loadTasks();
      await this.render();
    },
    async taskNew() {
      if (!DB.sms.tpl.length) {
        try { await DB.loadTpl(); } catch (e) { /* ignore */ }
      }
      const tpl = DB.sms.tpl;
      let importRows = [];
      const refreshPreview = () => {
        const el = $('#tPreview');
        if (!el) return;
        el.innerHTML = campaignPreviewHtml(($('#tBody') || {}).value || '', importRows, 5);
      };
      const currentVars = () => extractBodyVars((($('#tBody') || {}).value || ''));
      const bodyReady = () => !!((($('#tBody') || {}).value || '').trim());
      const renderVarChips = () => {
        const box = $('#tVarChips');
        if (!box) return;
        const vars = currentVars();
        const fromCsv = importRows[0] ? Object.keys(importRows[0]).filter(k => k !== 'phone') : [];
        const all = [...new Set(vars.concat(fromCsv))];
        box.innerHTML = all.length
          ? all.map(v => '<button type="button" class="var-chip" data-var="' + esc(v) + '">{' + esc(v) + '}</button>').join('')
          : '<span class="mxtag" style="margin:0">在正文中写 {' + '变量名}，导入模板会自动带上该列</span>';
        $$('#tVarChips [data-var]').forEach(b => b.addEventListener('click', () => {
          const ta = $('#tBody');
          ta.value = (ta.value || '') + '{' + b.dataset.var + '}';
          syncImportGate();
          refreshPreview();
        }));
      };
      const applyTpl = (t, silent) => {
        if (!t) return;
        $('#tTpl').value = String(t.id);
        $('#tBody').value = t.body || '';
        syncImportGate();
        if (!silent) toast('已应用模板', t.name, 'ok', 2200);
      };
      let importMeta = { black: [], dup: [], bad: [], file_n: 0 };
      const syncRcptsBox = () => {
        const box = $('#tRcpts');
        if (!box) return;
        if (importRows.length) {
          box.value = importRows.map(r => r.phone).join('\n');
          box.readOnly = true;
          box.style.background = 'var(--bg-2)';
        } else {
          box.readOnly = !bodyReady();
          box.style.background = bodyReady() ? '' : 'var(--bg-2)';
        }
        const st = $('#tRcptsStat');
        if (st) {
          const vars = currentVars();
          const cols = importRows.length ? Object.keys(importRows[0]).filter(k => k !== 'phone') : [];
          let html;
          if (importRows.length) {
            html = '已导入 <b>' + importRows.length + '</b> 人' +
              (cols.length ? ' · 参数列：' + cols.map(esc).join('、') : '（仅号码）');
          } else if (!bodyReady()) {
            html = '请先在左侧填写短信正文，再下载/导入收件人 CSV';
          } else if (vars.length) {
            html = '正文含变量 <b>' + vars.map(esc).join('、') + '</b> · 请下载 CSV 填写后导入';
          } else {
            html = '正文无变量 · 可下载仅含「号码」的 CSV，或直接粘贴号码';
          }
          if (importMeta.black.length) {
            html += '<br><span style="color:var(--st-err)">黑名单已跳过 <b>' + importMeta.black.length + '</b> 个：' +
              importMeta.black.map(esc).join('、') + '（可到「黑名单」移除后再导入）</span>';
          }
          if (importMeta.dup.length) {
            html += '<br><span style="color:var(--st-warn)">重复跳过 ' + importMeta.dup.length + ' 个</span>';
          }
          st.innerHTML = html;
        }
        renderVarChips();
        refreshPreview();
      };
      const syncImportGate = () => {
        const ready = bodyReady();
        const vars = currentVars();
        const dl = $('#tTplDl');
        const btn = $('#tImportBtn');
        if (dl) {
          dl.disabled = !ready;
          dl.title = ready
            ? (vars.length ? '按正文变量生成：号码、' + vars.join('、') : '正文无变量，模板仅含号码列')
            : '请先填写短信内容';
        }
        if (btn) {
          btn.disabled = !ready;
          btn.title = ready ? '导入按正文生成的 CSV' : '请先填写短信内容';
        }
        const box = $('#tRcpts');
        if (box && !importRows.length) {
          box.readOnly = !ready;
          box.style.background = ready ? '' : 'var(--bg-2)';
          box.placeholder = ready
            ? (vars.length
              ? '正文含 {' + vars.join('}、{') + '}，请下载 CSV 填写参数后导入'
              : '每行一个号码，或逗号 / 空格分隔；也可下载仅含「号码」的 CSV 导入')
            : '请先在左侧填写短信正文，再下载/导入收件人';
        }
        syncRcptsBox();
      };
      Modal.open('新建群发任务',
        '<div class="task-form">' +
          '<div class="task-col">' +
            '<section class="task-sec">' +
              '<h4 class="task-sec-title">任务设置</h4>' +
              '<div class="task-fields">' +
                '<div class="grid2">' +
                  '<div><label class="mxtag">任务名称</label><input class="inp" id="tName" style="width:100%" placeholder="如：双旦大促 · 第一批"></div>' +
                  '<div><label class="mxtag">速率（条/分）</label><input class="inp" type="number" min="1" value="20" id="tRate" style="width:100%"></div>' +
                '</div>' +
                '<div class="grid2">' +
                  '<div><label class="mxtag">发送号码池 <span style="color:var(--st-err)">*</span></label>' +
                    '<select class="sel" id="tPool" style="width:100%">' + poolOptionsHtml('') + '</select></div>' +
                  '<div><label class="mxtag">发送策略</label><select class="sel" id="tPolicy" style="width:100%">' +
                    '<option value="0">默认设置</option>' +
                    (DB.policies || []).map(p => '<option value="' + p.id + '">' + esc(p.name) + '（' + (p.rate || 20) + ' 条/分）</option>').join('') +
                  '</select></div>' +
                '</div>' +
                '<div class="grid2">' +
                  '<div><label class="mxtag">发送时机</label><select class="sel" id="tWhen" style="width:100%">' +
                    '<option value="now">立即发送</option>' +
                    '<option value="at">指定时间（一次）</option>' +
                    '<option value="daily">每日</option>' +
                    '<option value="weekly">每周</option>' +
                  '</select></div>' +
                  '<div id="tWhenExtra">' +
                    '<label class="mxtag" id="tWhenLbl">—</label>' +
                    '<input class="inp" id="tWhenVal" style="width:100%" placeholder="">' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</section>' +
            '<section class="task-sec grow">' +
              '<h4 class="task-sec-title">短信内容</h4>' +
              '<div><label class="mxtag">短信模板</label>' +
                '<select class="sel" id="tTpl" style="width:100%"><option value="">自定义内容</option>' +
                tpl.map(t => '<option value="' + t.id + '">' + esc(t.name) + '（' + esc(t.type) + '）</option>').join('') +
                '</select></div>' +
              '<div><label class="mxtag">正文（支持 {变量}）</label>' +
                '<textarea class="inp task-body" id="tBody" rows="5" placeholder="先填写正文，再导入收件人。有变量示例：您的订单{订单号}已发货"></textarea>' +
                '<div class="task-varchips" id="tVarChips"></div></div>' +
            '</section>' +
          '</div>' +
          '<div class="task-col">' +
            '<section class="task-sec grow">' +
              '<div class="task-sec-hd">' +
                '<h4 class="task-sec-title">收件人</h4>' +
                '<div class="task-sec-acts">' +
                  '<button type="button" class="btn sm" id="tTplDl" disabled title="请先填写短信内容"><span data-i="download"></span>下载 CSV</button>' +
                  '<button type="button" class="btn sm primary" id="tImportBtn" disabled title="请先填写短信内容"><span data-i="upload"></span>导入 CSV</button>' +
                  '<button type="button" class="btn sm" id="tImportClear" style="display:none">清除</button>' +
                  '<input type="file" id="tImportFile" accept=".csv,.txt,text/csv,text/plain" style="display:none">' +
                '</div>' +
              '</div>' +
              '<textarea class="inp task-rcpts" id="tRcpts" rows="6" readonly placeholder="请先在左侧填写短信正文，再下载/导入收件人"></textarea>' +
              '<div class="task-stat" id="tRcptsStat">请先在左侧填写短信正文，再下载/导入收件人 CSV</div>' +
              '<div class="task-preview" id="tPreview"></div>' +
            '</section>' +
          '</div>' +
        '</div>',
        '<span class="task-hint">黑名单 / 敏感词服务端复核 · 立即 / 定时一次 · 每日 / 每周周期 · 静默期营销自动顺延</span>' +
        '<span class="sp"></span>' +
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">创建任务</button>',
        'xl');
      iconsIn('#modalBody');
      const syncWhenUI = () => {
        const w = ($('#tWhen') || {}).value || 'now';
        const box = $('#tWhenExtra');
        const lbl = $('#tWhenLbl');
        const inp = $('#tWhenVal');
        if (!box || !lbl || !inp) return;
        if (w === 'now') {
          box.style.display = 'none';
          inp.value = '';
          return;
        }
        box.style.display = '';
        if (w === 'at') {
          lbl.textContent = '执行时间';
          inp.type = 'datetime-local';
          inp.placeholder = '';
          if (!inp.value || inp.type !== 'datetime-local') {
            const d = new Date(Date.now() + 3600000);
            d.setMinutes(0, 0, 0);
            const pad = n => String(n).padStart(2, '0');
            inp.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
              'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
          }
        } else if (w === 'daily') {
          lbl.textContent = '每日时刻（HH:MM）';
          inp.type = 'text';
          inp.placeholder = '09:00';
          if (!/^\d{1,2}:\d{2}$/.test(inp.value || '')) inp.value = '09:00';
        } else {
          lbl.textContent = '每周（如 周一 09:00）';
          inp.type = 'text';
          inp.placeholder = '周一 09:00';
          if (!/^周/.test(inp.value || '')) inp.value = '周一 09:00';
        }
      };
      syncWhenUI();
      $('#tWhen').addEventListener('change', syncWhenUI);
      syncImportGate();
      // 仅有一个短信模板时默认选中，便于带出正文后再导入
      if (tpl.length === 1) applyTpl(tpl[0], true);
      $('#tTpl').addEventListener('change', e => {
        const t = DB.sms.tpl.find(x => String(x.id) === String(e.target.value));
        if (t) applyTpl(t, true);
        else { syncImportGate(); }
      });
      $('#tBody').addEventListener('input', () => { syncImportGate(); });
      $('#tTplDl').addEventListener('click', () => {
        if (!bodyReady()) {
          toast('请先填写短信内容', '导入模板按正文里的 {变量} 自动生成；无变量则只有号码列', 'warn', 3600);
          try { $('#tBody').focus(); } catch (e) { /* ignore */ }
          return;
        }
        const vars = currentVars();
        downloadText('群发导入模板.csv', buildCampaignCsvTemplate(vars));
        toast('CSV 已下载', vars.length
          ? ('列：号码、' + vars.join('、') + ' · 填写后导入')
          : '正文无变量，模板仅含「号码」列', 'ok', 3200);
      });
      $('#tImportBtn').addEventListener('click', () => {
        if (!bodyReady()) {
          toast('请先填写短信内容', '确定正文与 {变量} 后再导入收件人', 'warn', 3600);
          try { $('#tBody').focus(); } catch (e) { /* ignore */ }
          return;
        }
        $('#tImportFile').click();
      });
      $('#tImportClear').addEventListener('click', () => {
        importRows = [];
        importMeta = { black: [], dup: [], bad: [], file_n: 0 };
        $('#tImportClear').style.display = 'none';
        syncImportGate();
        toast('已清除导入', '可重新粘贴号码或导入文件', 'info', 2000);
      });
      $('#tImportFile').addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        if (!bodyReady()) {
          toast('请先填写短信内容', '导入模板列由正文 {变量} 决定', 'warn', 3600);
          return;
        }
        try {
          if (!DB.blacklist.length) { try { await DB.loadBlack(); } catch (ex) { /* ignore */ } }
          const text = await readCsvFile(f);
          const parsed = parseCampaignCsv(text);
          if (parsed.err) { toast('导入失败', parsed.err, 'err'); return; }
          const needVars = currentVars();
          const missing = needVars.filter(v => !(parsed.cols || []).includes(v));
          if (missing.length) {
            toast('CSV 缺少参数列', '正文需要：' + missing.join('、') + ' · 请重新下载模板填写', 'err', 5200);
            return;
          }
          const black = [], kept = [];
          parsed.rows.forEach(r => {
            if (isCnBlack(r.phone)) black.push(r.phone);
            else kept.push(r);
          });
          importMeta = {
            black: black,
            dup: (parsed.skipped || []).filter(s => s.reason === '重复').map(s => s.phone),
            bad: (parsed.skipped || []).filter(s => s.reason === '无效号码'),
            file_n: parsed.file_phones || parsed.rows.length
          };
          importRows = kept;
          $('#tImportClear').style.display = importRows.length ? '' : 'none';
          syncImportGate();
          if (!importRows.length && black.length) {
            toast('全部命中黑名单', black.join('、') + ' — 请到「黑名单」移除后再导入', 'err', 5600);
            return;
          }
          toast(
            '文件 ' + importMeta.file_n + ' 个号码 → 导入 ' + importRows.length + ' 人',
            (needVars.length ? '参数：' + needVars.join('、') + ' · ' : '仅号码 · ') +
            (black.length ? '黑名单跳过 ' + black.length + '：' + black.join('、') + ' · ' : '') +
            '预览已更新',
            black.length ? 'warn' : 'ok', 5600
          );
        } catch (ex) { toast('导入失败', errText(ex), 'err'); }
      });
      Modal.onOk = async () => {
        const name = ($('#tName').value || '').trim();
        const body = ($('#tBody').value || '').trim();
        const hits = DB.checkWords(body);
        if (hits.length) { toast('命中敏感词', '「' + hits.join('、') + '」，请修改内容', 'err'); return false; }
        if (!name) { toast('缺少任务名', '', 'err'); return false; }
        if (!body) { toast('缺少短信内容', '请先填写正文，再导入收件人', 'err'); return false; }
        const poolId = (($('#tPool') || {}).value || '').trim();
        if (!poolId) { toast('请选择号码池', '群发必须指定发送号码池', 'err'); return false; }
        const needVars = extractBodyVars(body);
        let rcpts = importRows.slice();
        if (!rcpts.length) {
          if (needVars.length) {
            toast('请导入带参数的 CSV', '正文含 {' + needVars.join('}、{') + '}，请下载模板填写后导入', 'err', 4200);
            return false;
          }
          const rawRcpt = ($('#tRcpts').value || '');
          const nums = [...new Set(rawRcpt.split(/[\s,;|/\n\r]+/).map(normalizePhone).filter(Boolean))];
          rcpts = nums.filter(p => !isCnBlack(p)).map(p => ({ phone: p }));
        }
        if (!rcpts.length) { toast('收件人为空', '请粘贴号码或导入 CSV', 'err'); return false; }
        if (needVars.length) {
          const missRow = rcpts.find(r => needVars.some(v => !(r[v] || '').toString().trim()));
          if (missRow) {
            toast('收件人缺少参数', '号码 ' + missRow.phone + ' 缺少：' +
              needVars.filter(v => !(missRow[v] || '').toString().trim()).join('、'), 'err', 4200);
            return false;
          }
        }
        const when = ($('#tWhen') || {}).value || 'now';
        const whenVal = (($('#tWhenVal') || {}).value || '').trim();
        if (when === 'at' && !whenVal) { toast('请选择执行时间', '', 'err'); return false; }
        if (when === 'daily' && !/^\d{1,2}:\d{2}$/.test(whenVal)) {
          toast('每日时间格式错误', '应为 HH:MM，如 09:00', 'err'); return false;
        }
        if (when === 'weekly' && !/^周[一二三四五六日天]\s*\d{1,2}:\d{2}$/.test(whenVal)) {
          toast('每周时间格式错误', '应为 周一 09:00', 'err'); return false;
        }
        try {
          const payload = {
            name: name, tpl_id: $('#tTpl').value || '', body: body,
            rcpts: rcpts, rate: Math.max(1, +$('#tRate').value || 20),
            per_hour: DB.sms.settings.per_hour || 40,
            policy_id: +(($('#tPolicy') || {}).value || 0),
            pool_id: poolId,
            when: when
          };
          if (when === 'at') payload.start_at = whenVal.replace('T', ' ').slice(0, 16);
          if (when === 'daily' || when === 'weekly') payload.run = whenVal;
          const t = await DB.addTask(payload);
          const kind = SMS_WHEN[when] || when;
          toast(
            when === 'daily' || when === 'weekly' ? '周期计划已创建' : '任务已创建',
            '#' + (t && t.id) + ' · 池 ' + poolId + ' · ' + kind + ' · ' + (t && t.total) + ' 个收件人',
            'ok'
          );
          await this.render();
        } catch (ex) { toast('创建失败', errText(ex), 'err'); return false; }
      };
    }
  };

  /* ════════════════════════════════════════════════════════════ CHANNELS */
  const Channels = {
    poolSel: new Set(),
    poolQ: '',
    init() {
      $('#chPane').addEventListener('click', e => {
        const gClose = e.target.closest('[data-chguide-close]');
        if (gClose) {
          try { localStorage.setItem('ufi_sms_ch_guide', 'off'); } catch (_) {}
          const g = $('#chGuide');
          if (g) g.remove();
          return;
        }
        const jump = e.target.closest('[data-chjump]');
        if (jump) {
          const t = document.querySelector(jump.dataset.chjump);
          if (t) {
            if (t.tagName === 'DETAILS') t.open = true;
            t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }
        const join = e.target.closest('[data-pooljoin]');
        if (join) this.joinPool(join.dataset.pooljoin, join.dataset.sim, join.dataset.pool);
        if (e.target.id === 'btnPoolJoin') this.joinPool('', '', 'sim-pool');
        if (e.target.id === 'btnPoolBatch') this.batchSetPool();
        if (e.target.id === 'btnPoolNew') this.poolNew();
        if (e.target.id === 'poolMemQApply') {
          this.poolQ = (($('#poolMemQ') && $('#poolMemQ').value) || '').trim();
          PG.st.poolmem = PG.st.poolmem || { page: 1, size: 15 };
          PG.st.poolmem.page = 1;
          this.renderPoolMembers();
        }
        if (e.target.id === 'poolMemQReset') {
          this.poolQ = '';
          if ($('#poolMemQ')) $('#poolMemQ').value = '';
          PG.st.poolmem = PG.st.poolmem || { page: 1, size: 15 };
          PG.st.poolmem.page = 1;
          this.renderPoolMembers();
        }
      });
      $('#chPane').addEventListener('keydown', e => {
        if (e.target && e.target.id === 'poolMemQ' && e.key === 'Enter') {
          e.preventDefault();
          this.poolQ = (e.target.value || '').trim();
          PG.st.poolmem = PG.st.poolmem || { page: 1, size: 15 };
          PG.st.poolmem.page = 1;
          this.renderPoolMembers();
        }
      });
      $('#chPane').addEventListener('change', async e => {
        if (e.target && e.target.id === 'poolMemAll') {
          const on = !!e.target.checked;
          $$('#poolMemBody [data-poolchk]').forEach(cb => {
            cb.checked = on;
            const id = cb.dataset.poolchk;
            if (on) this.poolSel.add(id); else this.poolSel.delete(id);
          });
          this._syncPoolSelUi();
          return;
        }
        const chk = e.target.closest('[data-poolchk]');
        if (chk) {
          const id = chk.dataset.poolchk;
          if (chk.checked) this.poolSel.add(id); else this.poolSel.delete(id);
          this._syncPoolSelUi();
          return;
        }
        const sw = e.target.closest('[data-chsw]');
        if (sw) {
          sw.disabled = true;
          try { await DB.channelToggle(sw.dataset.chsw); this.renderTable(); }
          catch (ex) { toast('操作失败', errText(ex), 'err'); }
          sw.disabled = false;
          return;
        }
        const p = e.target.closest('[data-sparam]');
        if (p) {
          p.disabled = true;
          const k = p.dataset.sparam;
          const v = p.type === 'number' ? Math.max(1, +p.value || 1) : p.value;
          try {
            await DB.saveSettings({ [k]: v });
            toast('参数已更新', k + ' = ' + v + '（服务端即时生效）', 'ok', 2200);
          } catch (ex) { toast('更新失败', errText(ex), 'err'); }
          p.disabled = false;
        }
      });
      $('#chPane').addEventListener('click', async e => {
        const save = e.target.closest('[data-csave]');
        if (save) {
          const cid = save.dataset.csave;
          const mo = (($('#mo-' + cid) || {}).value || '').trim();
          const report = (($('#rp-' + cid) || {}).value || '').trim();
          const name = (($('#cn-' + cid) || {}).value || '').trim();
          const secret_key = (($('#sk-' + cid) || {}).value || '').trim();
          const sms_key = (($('#mk-' + cid) || {}).value || '').trim();
          save.disabled = true;
          try {
            await DB.saveCarrier(cid, {
              mo_url: mo, report_url: report, name: name,
              secret_key: secret_key, sms_key: sms_key, enabled: 1
            });
            toast('推送地址已保存', (name || ('运营商 #' + cid)), 'ok', 2200);
            this.render();
          } catch (ex) { toast('保存失败', errText(ex), 'err'); }
          save.disabled = false;
          return;
        }
        const pb = e.target.closest('[data-polact]');
        if (pb) {
          const pid = +pb.dataset.polid || 0;
          if (pb.dataset.polact === 'new') { this.form(null); return; }
          if (pb.dataset.polact === 'edit') { this.form(DB.policies.find(x => x.id === pid)); return; }
          if (pb.dataset.polact === 'del') {
            const p = DB.policies.find(x => x.id === pid);
            if (!confirm('删除策略「' + ((p && p.name) || pid) + '」？引用它的任务将回退默认设置。')) return;
            pb.disabled = true;
            try { await DB.policyDel(pid); toast('策略已删除', (p && p.name) || '#' + pid, 'info', 2000); this.render(); }
            catch (ex) { toast('删除失败', errText(ex), 'err'); }
            pb.disabled = false;
            return;
          }
        }
        const el = e.target.closest('[data-sstrat]');
        if (!el) return;
        if ((DB.sms.settings.strategy || 'wrr') === el.dataset.sstrat) return;
        try {
          await DB.saveSettings({ strategy: el.dataset.sstrat });
          toast('策略已切换', '短信通道选路：' + (STRATEGY_NAME[el.dataset.sstrat] || el.dataset.sstrat), 'ok', 2200);
          this.render();
        } catch (ex) { toast('切换失败', errText(ex), 'err'); }
      });
    },
    render() {
      const h = DB.health();
      const s = DB.sms.settings;
      $('#kpiChannels').innerHTML = [
        ['可用通道', (h.chOk || 0) + '/' + (h.chAll || 0), (h.chCool || 0) + ' 冷却 · ' + (h.chOff || 0) + ' 停用', h.chOk ? 'ok' : 'err'],
        ['今日发送', num(h.sentToday || 0), '全部通道合计', 'ok'],
        ['今日上行', num(h.recvToday || 0), 'UFI MO 回传', 'info'],
        ['失败率', (h.failRate || 0) + '%', '今日发送记录口径', (h.failRate || 0) > 8 ? 'err' : 'warn'],
        ['进行中群发', h.running || 0, '队列积压 ' + num(h.queued || 0) + ' 条', h.running ? 'purple' : ''],
        ['周期计划', h.schedOn || 0, '每日 / 每周启用中', '']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');

      const strat = [
        { id: 'wrr', name: '加权轮询', desc: '时计数少的通道优先，各线路负载均衡', on: (s.strategy || 'wrr') === 'wrr' },
        { id: 'rr',  name: '严格轮询', desc: '累计计数少的通道优先，各通道磨损最均匀', on: s.strategy === 'rr' },
        { id: 'lru', name: '最长空闲', desc: '最久未发的通道先发，兼顾负载与老化', on: s.strategy === 'lru' }
      ];
      const pols = DB.policies || [];
      const polRows = pols.length ? pols.map(p =>
        '<tr><td><b>' + esc(p.name) + '</b></td>' +
        '<td>' + esc(STRATEGY_NAME[p.strategy] || p.strategy || 'wrr') + '</td>' +
        '<td class="num">' + (p.rate || 20) + ' 条/分</td>' +
        '<td class="num">' + (p.per_hour || 40) + ' / ' + (p.per_day || 400) + '</td>' +
        '<td class="num">' + (p.gap_s || 0) + ' 秒</td>' +
        '<td>' + (p.quiet_enabled ? esc(p.quiet_from) + ' → ' + esc(p.quiet_to) : '<span class="tag">不启用</span>') + '</td>' +
        '<td class="col-act"><div class="rowbtns"><button class="btn xs" data-polact="edit" data-polid="' + p.id + '">编辑</button>' +
        '<button class="btn xs" data-polact="del" data-polid="' + p.id + '">删除</button></div></td></tr>').join('')
        : '<tr><td colspan="7" style="text-align:center;color:var(--tx-3);padding:18px">暂无策略。可在发送 / 群发时选择不同策略；未选则按下方默认设置执行。</td></tr>';

      /* ---- 快速上手引导条（可关闭，localStorage 记忆） ---- */
      let guideClosed = false;
      try { guideClosed = localStorage.getItem('ufi_sms_ch_guide') === 'off'; } catch (_) {}
      const guide = guideClosed ? '' :
        '<div class="chx-guide" id="chGuide">' +
          '<div class="chx-guide-hd"><b>第一次用？按这三步就能发短信</b>' +
            '<button class="btn xs" type="button" data-chguide-close>知道了，不再显示</button></div>' +
          '<div class="chx-steps">' +
            '<button type="button" class="chx-step" data-chjump="#ch-pool"><span class="n">1</span><span class="t"><b>选好发信设备</b><small>把 SIM 设备加入号码池，只有入池且在线的设备才会用来发</small></span></button>' +
            '<button type="button" class="chx-step" data-chjump="#ch-list"><span class="n">2</span><span class="t"><b>确认通道可用</b><small>查看每张卡的信号 / 限速余量 / 状态，异常卡可停用</small></span></button>' +
            '<button type="button" class="chx-step" data-chjump="#ch-strategy"><span class="n">3</span><span class="t"><b>按需调发送节奏</b><small>限速、时段上限、夜间静默，默认值已可用，一般不用改</small></span></button>' +
          '</div>' +
          '<div class="chx-diag" id="chGuideDiag"></div>' +
        '</div>';

      $('#chPane').innerHTML = guide +
        /* ── 1. 可用通道（客户最常看） ── */
        '<div class="panel" id="ch-list"><div class="panel-head"><h3><span data-i="antenna"></span>可用通道（按运营商分组 · ' + num((DB.ov.channels || []).length) + ' 路）</h3>' +
          '<span class="hint">一张 SIM 卡 = 一条通道；绿色=可发，灰=未启用，黄=冷却中</span></div>' +
          '<div class="panel-body" id="chBody" style="padding:14px 16px"></div></div>' +
        /* ── 2. 号码池成员 ── */
        '<div class="panel" id="ch-pool"><div class="panel-head"><h3><span data-i="pool"></span>发信设备（号码池）</h3>' +
          '<span class="hint">勾选后「批量设置号码池」；群发只从池内在线设备里选卡发送</span></div>' +
          '<div class="toolbar" style="flex-wrap:wrap;gap:8px">' +
            '<div class="searchbox grow"><span data-i="search"></span>' +
              '<input class="inp" id="poolMemQ" autocomplete="off" placeholder="IMEI / SN / SIM / 池名，回车过滤" value="' + esc(this.poolQ || '') + '">' +
            '</div>' +
            '<button class="btn sm" type="button" id="poolMemQApply">查询</button>' +
            '<button class="btn sm" type="button" id="poolMemQReset">重置</button>' +
            '<button class="btn sm primary" type="button" id="btnPoolBatch" disabled>批量设置号码池</button>' +
            '<button class="btn sm" type="button" id="btnPoolNew">＋ 新建号码池</button>' +
            '<button class="btn sm primary" type="button" id="btnPoolJoin">加入号码池</button>' +
            '<span class="tb-count" id="poolMemSelCount"></span>' +
          '</div>' +
          '<div class="panel-body flush"><div class="tablewrap"><table class="grid"><thead><tr>' +
          '<th class="col-check"><input type="checkbox" id="poolMemAll" title="本页全选"></th>' +
          '<th>IMEI</th><th>SN</th><th>SIM</th><th>号码池</th><th>VoIP</th><th class="col-act">操作</th>' +
          '</tr></thead><tbody id="poolMemBody"><tr><td colspan="7">加载中…</td></tr></tbody></table></div>' +
          '<div class="pager-bar" id="pgPoolMem"></div></div></div>' +
        /* ── 3. 发送节奏（进阶 · 默认折叠） ── */
        '<details class="chx-fold" id="ch-strategy"><summary><span data-i="sliders"></span><b>发送节奏与限速（进阶）</b>' +
          '<span class="hint">当前策略：' + esc(STRATEGY_NAME[s.strategy || 'wrr'] || '加权轮询') + ' · 单通道 ' + (s.per_hour || 40) + ' 条/时 · ' + (s.per_day || 400) + ' 条/日' + (DB.quietNow() ? ' · ⚠️ 夜间静默中' : '') + '</span></summary>' +
          '<div class="chx-fold-bd">' +
          '<p class="chx-plain">不配置也能正常发短信（走下方默认值）。需要<strong>多任务不同节奏</strong>时才建策略，发送 / 群发时选一下即可。</p>' +
          '<div class="panel"><div class="panel-head"><h3><span data-i="layers"></span>发送策略（多套 · 发送时选择）</h3>' +
            '<button class="btn sm primary" data-polact="new">＋ 新增策略</button></div>' +
            '<div class="panel-body flush"><div class="tablewrap"><table class="grid"><thead><tr>' +
            '<th>策略名</th><th>通道选路</th><th>速率</th><th>时 / 日上限</th><th>同通道间隔</th><th>夜间静默</th><th>操作</th>' +
            '</tr></thead><tbody>' + polRows + '</tbody></table></div></div></div>' +
          '<div class="grid2">' +
          '<div class="panel"><div class="panel-head"><h3><span data-i="sliders"></span>默认设置与频控</h3>' +
            '<span class="hint">发送时未选策略则按此执行（改后即时生效）</span></div><div class="panel-body">' +
            '<div class="strat-grid">' + strat.map(x =>
              '<div class="strat' + (x.on ? ' on' : '') + '" data-sstrat="' + x.id + '"><b>' + x.name + '</b>' +
              '<span>' + x.desc + '</span>' + (x.on ? '<span class="tag ok">当前</span>' : '') + '</div>').join('') + '</div>' +
            '<dl class="spec" style="margin-top:14px">' +
              '<dt>单通道时上限</dt><dd><input class="inp" type="number" min="1" style="width:90px" value="' + (s.per_hour || 40) + '" data-sparam="per_hour"> 条/时</dd>' +
              '<dt>单通道日上限</dt><dd><input class="inp" type="number" min="1" style="width:90px" value="' + (s.per_day || 400) + '" data-sparam="per_day"> 条/日</dd>' +
              '<dt>同通道最小间隔</dt><dd><input class="inp" type="number" min="1" style="width:90px" value="' + (s.gap_s || 6) + '" data-sparam="gap_s"> 秒</dd>' +
              '<dt>夜间静默</dt><dd>' + (s.quiet_from || '23:00') + ' → 次日 ' + (s.quiet_to || '08:00') +
                (DB.quietNow() ? ' <span class="tag warn">静默中</span>' : ' <span class="tag ok">放行中</span>') + '</dd>' +
              '<dt>短信签名（前缀）</dt><dd><input class="inp" style="width:170px" value="' + esc(s.sig || '') + '" data-sparam="sig" placeholder="【公司名】"> <span style="color:var(--tx-3);font-size:12px">开启签名时自动拼在正文前</span></dd>' +
            '</dl>' +
          '</div></div>' +
          '</div></div></details>' +
        /* ── 4. 技术说明（了解即可 · 默认折叠） ── */
        '<details class="chx-fold" id="ch-tech"><summary><span data-i="info"></span><b>通道是怎么工作的（技术说明）</b>' +
          '<span class="hint">短信能力与通话同门槛 · 含合规提醒</span></summary>' +
          '<div class="chx-fold-bd"><div class="grid2">' +
          '<div class="panel"><div class="panel-head"><h3><span data-i="antenna"></span>通道口径</h3><span class="hint">给技术同学看的</span></div><div class="panel-body">' +
            '<dl class="spec">' +
              '<dt>通道来源</dt><dd>UFI 台账：已注册 + SIM 就绪（后端实时派生）</dd>' +
              '<dt>发送方言</dt><dd>MESSAGE · R-URI=IMEI · X-SMS=收件号码（X-VOLTE=身份）</dd>' +
              '<dt>上行回传</dt><dd>UFI → MESSAGE → Kamailio 落库（SMS_RELAY）</dd>' +
              '<dt>通道确认</dt><dd>UFI 回 200 OK = 已接收；超时 / 4xx 记失败</dd>' +
              '<dt>运营商风险</dt><dd>高频单卡群发会被拦截 / 空放，务必限速</dd>' +
            '</dl>' +
          '</div></div>' +
          '<div class="panel"><div class="panel-head"><h3><span data-i="alert"></span>合规提醒</h3></div><div class="panel-body">' +
            '<div class="note warn"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>营销短信必须</b>：① 内容含签名（如【坤势通信】）② 含退订方式（如"回T退订"）③ 夜间静默期（23:00–08:00）营销类拒绝单发、群发自动顺延。高频单卡群发会被运营商拦截，请勿关闭限速。</div></div>' +
          '</div></div>' +
          '</div></div></details>';
      this.loadPoolMembers();
      this.renderTable();
      this.updateGuideDiag();
      iconsIn('#chPane');
    },
    /* 引导条自检：号码池数据为异步加载，加载完成后回填诊断 */
    updateGuideDiag() {
      const el = $('#chGuideDiag');
      if (!el) return;
      const h = DB.health();
      const poolN = ((DB.poolMembers && DB.poolMembers.devices) || [])
        .filter(d => d.in_pool && d.voip === '1').length;
      const ok = (h.chOk || 0) > 0 && poolN > 0;
      el.className = 'chx-diag ' + (ok ? 'ok' : 'warn');
      el.innerHTML = ok
        ? '当前就绪：<b>' + h.chOk + '</b> 路可用通道 · 号码池内 <b>' + poolN + '</b> 台设备 · ' + (DB.quietNow() ? '⚠️ 夜间静默中（营销类暂缓）' : '正常放行中')
        : '待处理：' + (!(h.chOk || 0) ? '<b>暂无可用通道</b>（检查设备注册与 SIM）· ' : '') +
          (!poolN ? '<b>号码池为空</b>（先完成第 1 步）' : '');
    },
    _syncPoolSelUi() {
      const n = this.poolSel.size;
      const btn = $('#btnPoolBatch');
      if (btn) btn.disabled = n < 1;
      const tip = $('#poolMemSelCount');
      if (tip) tip.textContent = n ? ('已选 ' + n + ' 台') : '';
      const all = $('#poolMemAll');
      if (all) {
        const boxes = $$('#poolMemBody [data-poolchk]');
        const checked = boxes.filter(b => b.checked).length;
        all.checked = boxes.length > 0 && checked === boxes.length;
        all.indeterminate = checked > 0 && checked < boxes.length;
      }
    },
    _filteredPoolDevs() {
      const pack = DB.poolMembers || { devices: [] };
      let list = pack.devices || [];
      const q = (this.poolQ || '').toLowerCase();
      if (q) {
        list = list.filter(d => {
          const hay = [d.imei, d.sn, d.sim, d.pool_id, d.pool, d.in_pool ? '' : '未入池']
            .map(x => String(x || '').toLowerCase()).join(' ');
          return hay.indexOf(q) >= 0;
        });
      }
      return list;
    },
    async loadPoolMembers() {
      const tb = $('#poolMemBody');
      if (!tb) return;
      try {
        await DB.loadPoolMembers();
        this.renderPoolMembers();
      } catch (ex) {
        tb.innerHTML = '<tr><td colspan="7">' + esc(errText(ex)) + '</td></tr>';
        if ($('#pgPoolMem')) $('#pgPoolMem').innerHTML = '';
      }
    },
    renderPoolMembers() {
      const tb = $('#poolMemBody');
      if (!tb) return;
      const all = this._filteredPoolDevs();
      if (!all.length) {
        tb.innerHTML = '<tr><td colspan="7">' + (this.poolQ ? '无匹配设备' : '台账暂无设备') + '</td></tr>';
        if ($('#pgPoolMem')) $('#pgPoolMem').innerHTML = '';
        const allCb = $('#poolMemAll');
        if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
        this._syncPoolSelUi();
        return;
      }
      const pg = PG.cut('poolmem', all, 15);
      tb.innerHTML = pg.list.map(d => {
        const on = this.poolSel.has(d.imei);
        return '<tr><td class="col-check"><input type="checkbox" data-poolchk="' + esc(d.imei) + '"' + (on ? ' checked' : '') + '></td>' +
          '<td class="mono">' + esc(d.imei) + '</td><td class="mono">' + esc(d.sn || '—') + '</td>' +
          '<td class="mono">' + esc(d.sim || '—') + '</td>' +
          '<td><span class="tag mono">' + esc(d.in_pool ? (d.pool_id || d.pool) : '未入池') + '</span></td>' +
          '<td>' + (d.voip === '1' ? '<span class="tag ok">已注册</span>' : '<span class="tag">未注册</span>') + '</td>' +
          '<td class="col-act"><button class="btn xs" type="button" data-pooljoin="' + esc(d.imei) + '" data-sim="' + esc(d.sim || '') + '" data-pool="' + esc(d.pool_id && d.pool_id !== '—' ? d.pool_id : 'sim-pool') + '">设置号码池</button></td></tr>';
      }).join('');
      if ($('#pgPoolMem')) $('#pgPoolMem').innerHTML = PG.foot('poolmem', pg);
      this._syncPoolSelUi();
      this.updateGuideDiag();
    },
    _poolSelectHtml(pool) {
      const pools = ((DB.poolMembers && DB.poolMembers.pools) || []);
      const fromCh = listPools().map(p => p.id);
      return ['sim-pool', 'P1'].concat(pools).concat(fromCh)
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .map(p => '<option value="' + esc(p) + '"' + (p === (pool || 'sim-pool') ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
    },
    poolNew() {
      const labels = {
        round_robin: '严格轮询',
        failover: '主备故障转移',
        least_load: '负载均衡'
      };
      const stratOpts = Object.keys(labels).map(k =>
        '<option value="' + k + '">' + labels[k] + '</option>'
      ).join('');
      Modal.open('新建号码池',
        '<div class="grid2" style="gap:12px">' +
        '<div><label class="mxtag">池 ID <span style="color:var(--st-err)">*</span></label>' +
          '<input class="inp mono" id="inpNewPool" style="width:100%" placeholder="如 P2 / market / night" maxlength="16"></div>' +
        '<div><label class="mxtag">选路策略</label>' +
          '<select class="sel" id="inpNewStrat" style="width:100%">' + stratOpts + '</select></div></div>' +
        '<div style="margin-top:12px"><label class="mxtag">外呼触发号（池 DID，可选，逗号分隔）</label>' +
          '<input class="inp" id="inpNewPoolDid" style="width:100%" placeholder="如 18960700521"></div>' +
        '<div class="note plain" style="margin-top:10px"><span class="ni">' + I('info', 15) + '</span>' +
          '<div class="nb">创建后可在下方把设备划入该池；短信群发选择此池时只从池内在线设备发送。</div></div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">创建</button>');
      Modal.onOk = async () => {
        const poolId = (($('#inpNewPool') || {}).value || '').trim();
        const strategy = (($('#inpNewStrat') || {}).value || 'round_robin').trim();
        const dids = (($('#inpNewPoolDid') || {}).value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        if (!/^[A-Za-z0-9_-]{1,16}$/.test(poolId)) {
          toast('池 ID 无效', '1–16 位字母/数字/下划线/横线', 'err');
          return false;
        }
        try {
          await DB.createPool(poolId, strategy, dids);
          toast('号码池已创建', poolId + ' · ' + (labels[strategy] || strategy), 'ok');
          this.render();
          return true;
        } catch (ex) {
          toast('创建失败', errText(ex), 'err');
          return false;
        }
      };
    },
    joinPool(imei, sim, pool) {
      const opts = this._poolSelectHtml(pool);
      Modal.open('加入号码池',
        '<label>IMEI<input class="inp mono" id="pjImei" value="' + esc(imei || '') + '"></label>' +
        '<label>SIM<input class="inp mono" id="pjSim" value="' + esc(sim || '') + '" placeholder="可空，默认用台账号码"></label>' +
        '<label>号码池<select class="sel" id="pjPool" style="width:100%">' + opts + '</select>' +
          '<input class="inp mono" id="pjPoolNew" placeholder="或新建池 ID，如 sim-pool" style="margin-top:6px"></label>' +
        '<label class="chk"><input type="checkbox" id="pjIn" checked> 入池（短信选路可用）</label>',
        '<button class="btn" data-modal-cancel>取消</button><button class="btn primary" id="pjOk">保存</button>');
      const ok = $('#pjOk');
      if (!ok) return;
      ok.addEventListener('click', async () => {
        const id = ($('#pjImei').value || '').trim();
        const pid = ($('#pjPoolNew').value || '').trim() || $('#pjPool').value;
        const simVal = ($('#pjSim').value || '').trim();
        ok.disabled = true;
        try {
          await DB.setPoolMembers([id], pid, $('#pjIn').checked, simVal);
          Modal.close();
          toast('已写入号码池', id + ' → ' + pid, 'ok');
          this.poolSel.delete(id);
          this.render();
        } catch (ex) { toast('保存失败', errText(ex), 'err'); }
        finally { ok.disabled = false; }
      });
    },
    batchSetPool() {
      const imeis = Array.from(this.poolSel);
      if (!imeis.length) { toast('未选择设备', '请先勾选要设置的设备', 'err'); return; }
      if (imeis.length > 200) { toast('超出上限', '单次最多批量 200 台', 'err'); return; }
      const opts = this._poolSelectHtml('sim-pool');
      const preview = imeis.slice(0, 8).map(i => '<code class="mono">' + esc(i) + '</code>').join('、') +
        (imeis.length > 8 ? ' …' : '');
      Modal.open('批量设置号码池 · ' + imeis.length + ' 台',
        '<p style="margin:0 0 10px;color:var(--tx-2);font-size:var(--fs-sm)">将把已选设备写入同一号码池：' + preview + '</p>' +
        '<label>号码池<select class="sel" id="pjPool" style="width:100%">' + opts + '</select>' +
          '<input class="inp mono" id="pjPoolNew" placeholder="或新建池 ID，如 sim-pool" style="margin-top:6px"></label>' +
        '<label class="chk"><input type="checkbox" id="pjIn" checked> 入池（短信选路可用）</label>',
        '<button class="btn" data-modal-cancel>取消</button><button class="btn primary" id="pjOk">批量保存</button>');
      const ok = $('#pjOk');
      if (!ok) return;
      ok.addEventListener('click', async () => {
        const pid = ($('#pjPoolNew').value || '').trim() || $('#pjPool').value;
        ok.disabled = true;
        try {
          const r = await DB.setPoolMembers(imeis, pid, $('#pjIn').checked);
          const pack = (r && r.data && r.data[0]) || {};
          Modal.close();
          toast('批量已更新', (pack.count || imeis.length) + ' 台 → ' + pid, 'ok');
          this.poolSel.clear();
          this.render();
        } catch (ex) { toast('批量失败', errText(ex), 'err'); }
        finally { ok.disabled = false; }
      });
    },
    renderTable() {
      const body = $('#chBody');
      if (!body) return;
      const chs = DB.channelList() || [];
      const carriers = DB.carriers || [];
      const byC = {};
      chs.forEach(c => {
        const k = c.carrier || '';
        if (!byC[k]) byC[k] = [];
        byC[k].push(c);
      });
      const order = carriers.length
        ? carriers.map(x => x.carrier)
        : Object.keys(byC).sort();
      // 未在 carriers 列表中的通道组也展示
      Object.keys(byC).forEach(k => { if (order.indexOf(k) < 0) order.push(k); });

      if (!order.length && !chs.length) {
        body.innerHTML = '<div class="empty">' + I('antenna', 34) + '暂无短信通道</div>';
        $('#cntChannels').textContent = 0;
        return;
      }

      const tip = (t) => '<span class="hint-q" title="' + esc(t) + '">?</span>';
      body.innerHTML = order.map(cid => {
        const meta = carriers.find(x => String(x.carrier) === String(cid)) || {};
        const list = byC[cid] || [];
        const title = meta.name || (list[0] && list[0].carrier_name) || (cid ? ('运营商 #' + cid) : '未绑定运营商');
        const okN = list.filter(c => c.state === 'ok').length;
        const rows = list.length ? list.map(c =>
          '<tr><td class="mono"><b>' + esc(c.sim || '—') + '</b></td><td class="mono">' + esc(c.imei) + '</td>' +
          '<td><span class="tag mono">' + esc(c.pool || '—') + '</span></td>' +
          '<td>' + '▮'.repeat(c.signal || 0) + '▯'.repeat(4 - (c.signal || 0)) + '</td>' +
          '<td class="num">' + num(c.sent || 0) + '</td>' +
          '<td class="num">' + (c.hour || 0) + ' / ' + (c.cap || 40) + '</td>' +
          '<td><span class="tag ' + (SMS_CH_STATE[c.state] || { cls: '' }).cls + '">' + (SMS_CH_STATE[c.state] || { label: c.state }).label + '</span></td>' +
          '<td><label class="sw"><input type="checkbox" ' + (c.enabled ? 'checked' : '') + ' data-chsw="' + esc(c.imei) + '"><i></i></label></td></tr>'
        ).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--tx-3);padding:14px">该运营商暂无在线通道</td></tr>';

        const canCfg = !!cid;
        return '<div class="carrier-block">' +
          '<div class="carrier-hd">' +
            '<div><b>' + esc(title) + '</b> ' +
              (cid ? '<span class="tag mono">#' + esc(cid) + '</span> ' : '') +
              '<span class="tag">' + okN + '/' + list.length + ' 可用</span></div>' +
            (canCfg ? '<button class="btn sm primary" data-csave="' + esc(cid) + '">保存推送配置</button>' : '') +
          '</div>' +
          (canCfg
            ? '<div class="carrier-hooks">' +
                '<label>客户短信推送地址 ' + tip('上行短信（MO）收到后 HTTP POST；smsBody 为 XOR+Base64 密文，附带 ts/sign') +
                  '<input class="inp" id="mo-' + esc(cid) + '" value="' + esc(meta.mo_url || '') + '" placeholder="http://客户IP:端口/mo"></label>' +
                '<label>短信状态推送地址 ' + tip('下行发送结果（成功/失败）HTTP POST；附带 ts/sign 与加密 smsBody') +
                  '<input class="inp" id="rp-' + esc(cid) + '" value="' + esc(meta.report_url || '') + '" placeholder="http://客户IP:端口/report"></label>' +
                '<label>签名密钥 secret_key ' + tip('推送 sign 计算用；留空则用开放 API 默认密钥') +
                  '<input class="inp mono" id="sk-' + esc(cid) + '" value="' + esc(meta.secret_key || '') + '" placeholder="可选，覆盖默认 secret_key"></label>' +
                '<label>短信密钥 sms_key ' + tip('smsBody XOR 加解密密钥；留空则用开放 API 默认值') +
                  '<input class="inp mono" id="mk-' + esc(cid) + '" value="' + esc(meta.sms_key || '') + '" placeholder="可选，覆盖默认 sms_key"></label>' +
                '<input type="hidden" id="cn-' + esc(cid) + '" value="' + esc(title) + '">' +
              '</div>'
            : '<div class="note warn" style="margin:8px 0 12px"><div class="nb">请先在通信管理为设备绑定运营商（carrier），再配置推送地址。</div></div>') +
          '<div class="tablewrap"><table class="grid"><thead><tr>' +
          '<th>SIM（短信出口号码）</th><th>IMEI</th><th>池</th><th>信号</th><th class="num">累计发送</th><th class="num">时计数 / 上限</th><th>状态</th><th>启用</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</div>';
      }).join('');
      $('#cntChannels').textContent = DB.health().chOk || 0;
    },
    form(p) {
      const isNew = !p;
      p = p || { name: '', strategy: 'wrr', rate: 20, per_hour: 40, per_day: 400,
                 gap_s: 6, burst_gap_s: 90, quiet_enabled: 1, quiet_from: '23:00', quiet_to: '08:00' };
      Modal.open(isNew ? '新增发送策略' : '编辑发送策略 · ' + p.name,
        '<div class="grid2" style="gap:12px">' +
        '<div><label class="mxtag">策略名称 *</label><input class="inp" id="pName" style="width:100%" value="' + esc(p.name) + '" placeholder="如：营销高频"></div>' +
        '<div><label class="mxtag">通道选路</label><select class="sel" id="pStrategy" style="width:100%">' +
        ['wrr', 'rr', 'lru'].map(k => '<option value="' + k + '"' + ((p.strategy || 'wrr') === k ? ' selected' : '') + '>' + esc(STRATEGY_NAME[k] || k) + '</option>').join('') +
        '</select></div></div>' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">速率（条/分）</label><input class="inp" type="number" min="1" id="pRate" value="' + (p.rate || 20) + '" style="width:100%"></div>' +
        '<div><label class="mxtag">同通道最小间隔（秒）</label><input class="inp" type="number" min="0" id="pGap" value="' + (p.gap_s || 0) + '" style="width:100%"></div></div>' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">单通道时上限</label><input class="inp" type="number" min="1" id="pPerHour" value="' + (p.per_hour || 40) + '" style="width:100%"></div>' +
        '<div><label class="mxtag">单通道日上限</label><input class="inp" type="number" min="1" id="pPerDay" value="' + (p.per_day || 400) + '" style="width:100%"></div></div>' +
        '<div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="sw"><input type="checkbox" id="pQuiet" ' + (p.quiet_enabled ? 'checked' : '') + '><i></i></label><span>夜间静默（营销类顺延）</span>' +
        '<input class="inp" type="time" id="pQFrom" value="' + esc(p.quiet_from || '23:00') + '" style="width:110px"><span>→</span><input class="inp" type="time" id="pQTo" value="' + esc(p.quiet_to || '08:00') + '" style="width:110px"></div>' +
        '<div class="note plain" style="margin-top:12px"><span class="ni">' + I('info', 15) + '</span><div class="nb">发送页 / 群发表单选择策略后按该策略选路与频控；进行中的任务按创建时绑定的策略执行；删除策略后相关任务回退默认设置。</div></div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存策略</button>', true);
      Modal.onOk = async () => {
        const name = ($('#pName').value || '').trim();
        if (!name) { toast('缺少策略名', '', 'err'); return false; }
        try {
          await DB.savePolicy({
            id: p.id || 0, name: name, strategy: $('#pStrategy').value,
            rate: Math.max(1, +$('#pRate').value || 20),
            per_hour: Math.max(1, +$('#pPerHour').value || 40),
            per_day: Math.max(1, +$('#pPerDay').value || 400),
            gap_s: Math.max(0, +$('#pGap').value || 0),
            burst_gap_s: p.burst_gap_s || 90,
            quiet_enabled: $('#pQuiet').checked ? 1 : 0,
            quiet_from: $('#pQFrom').value || '23:00',
            quiet_to: $('#pQTo').value || '08:00'
          });
          toast('策略已保存', name, 'ok');
          this.render();
        } catch (ex) { toast('保存失败', errText(ex), 'err'); return false; }
      };
    }
  };

  /* ════════════════════════════════════════════════════════════ TPL */
  const Tpl = {
    init() {
      $('#tplBody').addEventListener('click', e => {
        const b = e.target.closest('[data-tpact]');
        if (!b) return;
        const t = DB.sms.tpl.find(x => x.id === +b.dataset.tpid);
        if (!t) return;
        if (b.dataset.tpact === 'edit') this.edit(t);
        else if (b.dataset.tpact === 'del') {
          const used = DB.tplUsage(t.id);
          if (used > 0) { toast('模板使用中', '被 ' + used + ' 个群发任务引用，先处理任务再删除', 'warn'); return; }
          this.del(t);
        }
      });
      bindDateRange('tplFrom', 'tplTo', 'tplDateApply', 'tplDateReset', r => {
        DB.tplQ.date_from = r.date_from;
        DB.tplQ.date_to = r.date_to;
        PG.st.tpl = PG.st.tpl || { page: 1, size: 10 };
        PG.st.tpl.page = 1;
        this.render();
      });
    },
    async del(t) {
      try { await DB.tplDel(t.id); Compose.renderTplSel(); toast('模板已删除', t.name, 'info', 2000); await this.render(); }
      catch (ex) { toast('删除失败', errText(ex), 'err'); }
    },
    async render() {
      const dr = DB.tplQ || {};
      const filtered = DB.sms.tpl.filter(t => inDateRange(t.created, dr.date_from, dr.date_to));
      const pg = PG.cut('tpl', filtered, 10);
      if ($('#tplCount')) {
        $('#tplCount').textContent = filtered.length + ' 条' +
          ((dr.date_from || dr.date_to) ? ' / 共 ' + DB.sms.tpl.length + '（已按时间筛选）' : '');
      }
      $('#tplBody').innerHTML = pg.list.length ? pg.list.map(t =>
        '<tr><td><b>' + esc(t.name) + '</b><div class="mxtag">#' + t.id + (t.created ? ' · ' + esc(t.created) : '') + '</div></td>' +
        '<td><span class="tag ' + (t.type === '营销' ? 'warn' : t.type === '验证码' ? 'info' : '') + '">' + esc(t.type) + '</span></td>' +
        '<td>' + esc(t.vars || '—') + '</td>' +
        '<td class="sms-body-cell copyable" style="max-width:420px" data-copy="' + esc(t.body) + '" title="' + esc(t.body) + '（双击复制）">' + esc(t.body) + '</td>' +
        '<td>' + (DB.tplUsage(t.id) ? '<span class="tag purple">' + DB.tplUsage(t.id) + ' 个任务</span>' : '<span class="tag">未引用</span>') + '</td>' +
        '<td class="col-act"><div class="rowbtns">' +
        '<button class="btn xs" data-tpact="edit" data-tpid="' + t.id + '">编辑</button>' +
        '<button class="btn xs" data-tpact="del" data-tpid="' + t.id + '">删除</button>' +
        '</div></td></tr>').join('')
        : '<tr><td colspan="6"><div class="empty">' + I('file', 34) + '暂无模板</div></td></tr>';
      $('#pgTpl').innerHTML = PG.foot('tpl', pg);
      $('#cntTpl').textContent = DB.sms.tpl.length;
    },
    edit(t) {
      const isNew = !t;
      t = t || { name: '', type: '通知', vars: '', body: '' };
      Modal.open((isNew ? '新建模板' : '编辑模板 · ' + t.name),
        '<label class="mxtag">模板名称</label><input class="inp" id="tpName" style="width:100%" value="' + esc(t.name) + '">' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">类型</label><select class="sel" id="tpType" style="width:100%">' +
        ['通知', '营销', '验证码'].map(x => '<option' + (t.type === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
        '<div><label class="mxtag">变量（逗号分隔）</label><input class="inp" id="tpVars" style="width:100%" value="' + esc(t.vars) + '" placeholder="订单号, 运单号"></div></div>' +
        '<label class="mxtag" style="display:block;margin-top:12px">内容（支持 {变量} 占位）</label>' +
        '<textarea class="inp" id="tpBody" rows="6" style="width:100%">' + esc(t.body) + '</textarea>' +
        '<div class="note plain" style="margin-top:10px"><span class="ni">' + I('shield', 15) + '</span><div class="nb">保存时自动做敏感词校验；营销类模板建议自带签名与退订方式。</div></div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存</button>');
      Modal.onOk = async () => {
        const name = ($('#tpName').value || '').trim();
        const body = ($('#tpBody').value || '').trim();
        if (!name || !body) { toast('信息不完整', '名称与内容必填', 'err'); return false; }
        const hits = DB.checkWords(body);
        if (hits.length) { toast('命中敏感词', '「' + hits.join('、') + '」，请修改内容', 'err'); return false; }
        const data = { name: name, type: $('#tpType').value, vars: ($('#tpVars').value || '').trim(), body: body };
        try {
          if (isNew) await DB.tplAdd(data);
          else await DB.tplUpdate(t.id, data);
          Compose.renderTplSel();
          toast('模板已保存', name, 'ok');
          await this.render();
        } catch (ex) { toast('保存失败', errText(ex), 'err'); return false; }
      };
    }
  };

  /* ════════════════════════════════════════════════════════════ BLACKLIST */
  const Blacklist = {
    init() {
      $('#blackAdd').addEventListener('click', () => this.add());
      $('#blackInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.add(); });
      $('#blackFilter').addEventListener('change', e => { APP.blackFilter = e.target.value; this.table(); });
      bindDateRange('blackFrom', 'blackTo', 'blackDateApply', 'blackDateReset', r => {
        DB.blackQ.date_from = r.date_from;
        DB.blackQ.date_to = r.date_to;
        PG.st.black = PG.st.black || { page: 1, size: 12 };
        PG.st.black.page = 1;
        this.table();
      });
      $('#blackBody').addEventListener('click', async e => {
        const b = e.target.closest('[data-blact]');
        if (!b || b.dataset.blact !== 'del') return;
        b.disabled = true;
        try { await DB.blackDel(b.dataset.blnum); toast('已移出黑名单', b.dataset.blnum, 'info', 2000); await this.render(); }
        catch (ex) { toast('操作失败', errText(ex), 'err'); }
        b.disabled = false;
      });
    },
    async add() {
      const raw = $('#blackInput').value || '';
      const nums = (raw.match(/1\d{10}/g) || []);
      if (!nums.length) { toast('没有有效号码', '每行一个 11 位手机号', 'warn'); return; }
      try {
        const r = await DB.blackAdd(nums, $('#blackSrc').value);
        $('#blackInput').value = '';
        toast('黑名单已更新', '新增 ' + r.added + ' 个' + (r.dup ? ' · 重复跳过 ' + r.dup + ' 个' : ''), 'ok');
        await this.render();
      } catch (ex) { toast('操作失败', errText(ex), 'err'); }
    },
    async render() {
      const all = DB.blacklist;
      $('#kpiBlack').innerHTML = [
        ['名单总量', num(all.length), '发送与群发自动剔除', 'err'],
        ['手动加入', num(all.filter(b => b.src === '手动').length), '运维添加', ''],
        ['回复退订', num(all.filter(b => b.src === '退订').length), '用户回 TD 自动加入', 'purple'],
        ['运营商回执', num(all.filter(b => b.src === '运营商').length), '空号 / 投诉自动加入', 'warn']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');
      this.table();
      $('#cntBlack').textContent = all.length;
    },
    table() {
      const dr = DB.blackQ || {};
      const list = DB.blacklist.filter(b =>
        (!APP.blackFilter || b.src === APP.blackFilter) &&
        inDateRange(b.created, dr.date_from, dr.date_to));
      const pg = PG.cut('black', list, 12);
      if ($('#blackListCount')) {
        $('#blackListCount').textContent = list.length + ' 条' +
          ((dr.date_from || dr.date_to || APP.blackFilter) ? '（已筛选）' : '');
      }
      $('#blackBody').innerHTML = pg.list.length ? pg.list.map(b =>
        '<tr><td class="mono"><b>' + esc(b.num) + '</b></td>' +
        '<td><span class="tag ' + (b.src === '运营商' ? 'warn' : b.src === '退订' ? 'purple' : '') + '">' + esc(b.src) + '</span></td>' +
        '<td class="mono">' + esc(b.created || '') + '</td>' +
        '<td class="col-act"><div class="rowbtns"><button class="btn xs" data-blact="del" data-blnum="' + esc(b.num) + '">移出</button></div></td></tr>').join('')
        : '<tr><td colspan="4"><div class="empty">' + I('shield', 34) + '名单为空</div></td></tr>';
      $('#pgBlack').innerHTML = PG.foot('black', pg);
    },
    async clearManual() {
      const n = DB.blacklist.filter(b => b.src === '手动').length;
      if (!n) { toast('手动来源为空', '', 'info', 1800); return; }
      try { await DB.blackClear('手动'); toast('已清空手动来源', n + ' 个号码移出黑名单（退订 / 运营商来源保留）', 'warn'); await this.render(); }
      catch (ex) { toast('操作失败', errText(ex), 'err'); }
    }
  };

  /* ════════════════════════════════════════════════════════════ WORDS */
  const Words = {
    init() {
      $('#wordAdd').addEventListener('click', () => this.add());
      $('#wordInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.add(); });
      $('#wordTest').addEventListener('input', () => this.test());
      $('#wordChips').addEventListener('click', async e => {
        const b = e.target.closest('.wx');
        if (!b) return;
        try { await DB.wordDel(b.dataset.word); toast('敏感词已删除', b.dataset.word, 'info', 1800); await this.render(); }
        catch (ex) { toast('操作失败', errText(ex), 'err'); }
      });
    },
    async add() {
      const raw = $('#wordInput').value || '';
      const list = raw.split(/[,，\s]+/).filter(Boolean);
      if (!list.length) { toast('请输入敏感词', '', 'warn', 1800); return; }
      try {
        const n = await DB.wordAdd(list);
        $('#wordInput').value = '';
        toast(n ? '敏感词已添加' : '未新增', n ? '新增 ' + n + ' 个（重复自动跳过）' : '全部与现有词库重复', n ? 'ok' : 'info');
        await this.render();
      } catch (ex) { toast('操作失败', errText(ex), 'err'); }
    },
    async render() {
      const ws = DB.words;
      $('#kpiWords').innerHTML = [
        ['词库总量', num(ws.length), '发送与模板保存即时校验', 'err'],
        ['校验范围', '发送 + 模板 + 群发', '服务端同样复核', 'info']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');
      const pg = PG.cut('words', ws, 40);
      $('#wordChips').innerHTML = pg.list.map(w =>
        '<span class="word-chip">' + esc(w) + '<button class="wx" data-word="' + esc(w) + '" title="删除">×</button></span>').join('');
      $('#pgWords').innerHTML = PG.foot('words', pg);
      $('#cntWords').textContent = ws.length;
      this.test();
    },
    test() {
      const body = $('#wordTest').value || '';
      const out = $('#wordTestOut');
      if (!body.trim()) { out.innerHTML = '<span class="mxtag">输入内容后即时检测</span>'; return; }
      const hits = DB.checkWords(body);
      out.innerHTML = hits.length
        ? '<div class="note err" style="margin:0"><span class="ni">' + I('x-circle', 15) + '</span><div class="nb"><b>命中 ' + hits.length + ' 个：</b>' +
          hits.map(w => '<span class="tag err">' + esc(w) + '</span>').join(' ') + '</div></div>'
        : '<div class="note ok" style="margin:0"><span class="ni">' + I('check-circle', 15) + '</span><div class="nb">未命中任何敏感词，可发送。</div></div>';
      iconsIn('#wordTestOut');
    }
  };

  /* ════════════════════════════════════════════════════════════ OPEN API */
  const API_LOG_NAME = {
    sendSms: 'sendSms 发送',
    send: 'send 兼容发送',
    batch: 'batch 批量',
    push_mo: '推送 MO',
    push_report: '推送状态'
  };
  const OpenApi = {
    init() {
      ['#btnKeyNew', '#btnKeyNew2'].forEach(sel => {
        const btn = $(sel);
        if (btn) btn.addEventListener('click', () => this.create());
      });
      const btnWlAdd = $('#btnWlAdd');
      if (btnWlAdd) btnWlAdd.addEventListener('click', () => this.addWl());
      const btnWlSave = $('#btnWlSaveCfg');
      if (btnWlSave) btnWlSave.addEventListener('click', async () => {
        btnWlSave.disabled = true;
        try {
          await DB.saveWhitelistCfg({
            sms_enabled: ($('#wlSmsEn') && $('#wlSmsEn').checked) ? 1 : 0,
            carrier_enabled: ($('#wlCarrierEn') && $('#wlCarrierEn').checked) ? 1 : 0
          });
          toast('白名单开关已保存', '', 'ok', 1800);
          this.renderWl();
        } catch (ex) { toast('保存失败', errText(ex), 'err'); }
        finally { btnWlSave.disabled = false; }
      });
      const wlBody = $('#wlBody');
      if (wlBody) wlBody.addEventListener('click', async e => {
        const b = e.target.closest('[data-wlact]');
        if (!b) return;
        const id = +b.dataset.wid;
        const act = b.dataset.wlact;
        b.disabled = true;
        try {
          if (act === 'del') {
            if (!confirm('删除此白名单条目？')) { b.disabled = false; return; }
            await DB.whitelistAct(id, { action: 'del' });
            toast('已删除', '', 'info', 1500);
          } else if (act === 'toggle') {
            await DB.whitelistAct(id, { action: 'toggle' });
            toast('状态已更新', '', 'ok', 1500);
          }
          this.renderWl();
        } catch (ex) { toast('操作失败', errText(ex), 'err'); }
        finally { b.disabled = false; }
      });
      const body = $('#keyBody');
      if (body) body.addEventListener('click', async e => {
        const b = e.target.closest('[data-kact]');
        if (!b) return;
        const id = +b.dataset.kid;
        const act = b.dataset.kact;
        b.disabled = true;
        try {
          if (act === 'edit') {
            const row = (DB.apikeys || []).find(x => +x.id === id);
            b.disabled = false;
            this.edit(row);
            return;
          }
          if (act === 'toggle') {
            await DB.apiKeyAct(id, { action: 'toggle' });
            toast('状态已更新', '', 'ok', 1500);
          } else if (act === 'del') {
            const row = (DB.apikeys || []).find(x => +x.id === id);
            const tip = row && row.api_key
              ? ('删除「' + (row.name || row.api_key) + '」？第三方将立即无法调用。')
              : '删除此 API Key？第三方将立即无法调用。';
            if (!confirm(tip)) { b.disabled = false; return; }
            await DB.apiKeyAct(id, { action: 'del' });
            toast('已删除', row && row.name ? row.name : '', 'info', 1800);
          } else if (act === 'copy') {
            const t = b.dataset.kmask || '';
            try { await navigator.clipboard.writeText(t); toast('已复制掩码', t, 'ok', 1500); }
            catch (ex) { toast('复制失败', errText(ex), 'err'); }
          }
          await DB.loadApiKeys();
          this.render();
        } catch (ex) { toast('操作失败', errText(ex), 'err'); }
        b.disabled = false;
      });
      const apply = () => {
        DB.apiLogsQ.dir = ($('#apiLogDir') && $('#apiLogDir').value) || '';
        DB.apiLogsQ.carrier = ($('#apiLogCarrier') && $('#apiLogCarrier').value) || '';
        DB.apiLogsQ.caller = (($('#apiLogCaller') && $('#apiLogCaller').value) || '').trim();
        DB.apiLogsQ.callee = (($('#apiLogCallee') && $('#apiLogCallee').value) || '').trim();
        DB.apiLogsQ.date_from = ($('#apiLogFrom') && $('#apiLogFrom').value) || '';
        DB.apiLogsQ.date_to = ($('#apiLogTo') && $('#apiLogTo').value) || '';
        DB.apiLogsQ.page = 1;
        this.renderLogs();
      };
      if ($('#apiLogApply')) $('#apiLogApply').addEventListener('click', apply);
      if ($('#btnApiLogRefresh')) $('#btnApiLogRefresh').addEventListener('click', () => this.renderLogs());
      if ($('#apiLogReset')) $('#apiLogReset').addEventListener('click', () => {
        ['apiLogDir', 'apiLogCarrier', 'apiLogCaller', 'apiLogCallee', 'apiLogFrom', 'apiLogTo'].forEach(id => {
          const el = $('#' + id); if (el) el.value = '';
        });
        DB.apiLogsQ = { dir: '', caller: '', callee: '', carrier: '', date_from: '', date_to: '', page: 1, size: DB.apiLogsQ.size || 15 };
        this.renderLogs();
      });
      ['apiLogCaller', 'apiLogCallee'].forEach(id => {
        const el = $('#' + id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
      });
      const logBody = $('#apiLogBody');
      if (logBody) logBody.addEventListener('click', e => {
        const b = e.target.closest('[data-logact="view"]');
        if (!b) return;
        const row = (DB.apiLogs.list || []).find(x => +x.id === +b.dataset.logid);
        if (row) this.showLog(row);
      });
    },
    fillCarrierSel() {
      const sel = $('#apiLogCarrier');
      if (!sel) return;
      const cur = sel.value || DB.apiLogsQ.carrier || '';
      const list = (DB.apiLogs && DB.apiLogs.carriers && DB.apiLogs.carriers.length)
        ? DB.apiLogs.carriers
        : (DB.carriers || []).map(c => ({ carrier: c.carrier, name: c.name }));
      sel.innerHTML = '<option value="">全部运营商组</option>' +
        list.map(c => '<option value="' + esc(c.carrier) + '"' +
          (String(cur) === String(c.carrier) ? ' selected' : '') + '>' +
          esc((c.name || ('运营商 #' + c.carrier)) + ' · ' + c.carrier) + '</option>').join('');
    },
    showLog(row) {
      if (!row) return;
      Modal.open('API 日志 #' + row.id,
        '<div class="kv" style="display:grid;grid-template-columns:100px 1fr;gap:6px 12px;font-size:13px">' +
        '<b>时间</b><span>' + esc(row.created || '') + '</span>' +
        '<b>方向</b><span>' + (row.direction === 'out' ? '平台 → 客户（推送）' : '客户 → 平台（调用）') + '</span>' +
        '<b>接口</b><span>' + esc(API_LOG_NAME[row.api_name] || row.api_name || '') + '</span>' +
        '<b>路径</b><span style="word-break:break-all">' + esc(row.path || '') + '</span>' +
        '<b>主叫</b><span>' + esc(row.caller_number || '—') + '</span>' +
        '<b>被叫</b><span>' + esc(row.callee_number || '—') + '</span>' +
        '<b>运营商</b><span>' + esc((row.carrier_name || '') + (row.carrier ? ' (' + row.carrier + ')' : '') || '—') + '</span>' +
        '<b>结果</b><span>HTTP ' + esc(row.http_status) + ' · code ' + esc(row.result_code) + ' · ' + esc(row.result_msg || '') + '</span>' +
        '<b>耗时</b><span>' + esc(row.duration_ms) + ' ms</span>' +
        '<b>requestId</b><span>' + esc(row.request_id || '—') + '</span>' +
        '<b>msgId</b><span>' + esc(row.msg_id || '—') + '</span>' +
        '<b>API Key</b><span>' + esc(row.key_name || (row.key_id ? ('#' + row.key_id) : '—')) + '</span>' +
        '<b>来源 IP</b><span>' + esc(row.remote || '—') + '</span>' +
        '</div>' +
        '<div class="mxtag" style="margin-top:12px">短信内容</div>' +
        '<pre class="codeblock" style="max-height:160px;overflow:auto;white-space:pre-wrap">' + esc(row.sms_body || '—') + '</pre>' +
        '<div class="mxtag">请求摘要</div><pre class="codeblock" style="max-height:160px;overflow:auto">' + esc(row.req_summary || '—') + '</pre>' +
        '<div class="mxtag">响应摘要</div><pre class="codeblock" style="max-height:160px;overflow:auto">' + esc(row.resp_summary || '—') + '</pre>',
        '<button class="btn" data-mact="close">关闭</button>');
    },
    clipBody(s, n) {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      if (!t) return '—';
      const lim = n || 36;
      return t.length > lim ? (t.slice(0, lim) + '…') : t;
    },
    async renderLogs() {
      const tb = $('#apiLogBody');
      if (!tb) return;
      const st = PG.st.apilogs || (PG.st.apilogs = { page: DB.apiLogsQ.page || 1, size: DB.apiLogsQ.size || 15 });
      DB.apiLogsQ.page = st.page || 1;
      DB.apiLogsQ.size = st.size || 15;
      let rec;
      try { rec = await DB.loadApiLogs(); }
      catch (ex) { toast('日志加载失败', errText(ex), 'err'); return; }
      this.fillCarrierSel();
      if ($('#apiLogCount')) $('#apiLogCount').textContent = (rec.total || 0) + ' 条';
      if (!rec.list || !rec.list.length) {
        tb.innerHTML = '<tr><td colspan="10"><div class="empty">' + I('inbox', 34) + '暂无 API 日志 · 发送或推送后将显示在此</div></td></tr>';
        if ($('#pgApiLogs')) $('#pgApiLogs').innerHTML = '';
        return;
      }
      tb.innerHTML = rec.list.map(r => {
        const ok = +r.result_code === 200 || (+r.http_status >= 200 && +r.http_status < 300 && +r.result_code === 200);
        const dir = r.direction === 'out'
          ? '<span class="tag warn">→ 推送</span>'
          : '<span class="tag info">← 调用</span>';
        const api = esc(API_LOG_NAME[r.api_name] || r.api_name || '—');
        const car = r.carrier_name || r.carrier || '—';
        const bodyFull = String(r.sms_body || '').trim();
        const bodyShow = this.clipBody(bodyFull, 36);
        const stTag = ok
          ? '<span class="tag ok">' + esc(r.result_msg || '成功') + '</span>'
          : '<span class="tag err">' + esc(r.result_msg || ('HTTP ' + r.http_status)) + '</span>';
        return '<tr>' +
          '<td>' + esc(r.created || '') + '</td>' +
          '<td>' + dir + '</td>' +
          '<td><b>' + api + '</b><div class="mxtag">' + esc(r.http_status) + ' · ' + esc(r.duration_ms) + 'ms</div></td>' +
          '<td>' + esc(r.caller_number || '—') + '</td>' +
          '<td>' + esc(r.callee_number || '—') + '</td>' +
          '<td class="sms-body-cell" style="max-width:220px" title="' + esc(bodyFull || '') + '">' + esc(bodyShow) + '</td>' +
          '<td title="' + esc(r.carrier || '') + '">' + esc(car) + '</td>' +
          '<td>' + stTag + '</td>' +
          '<td>' + esc(r.duration_ms) + ' ms</td>' +
          '<td class="col-act"><button class="btn sm" data-logact="view" data-logid="' + r.id + '">详情</button></td>' +
          '</tr>';
      }).join('');
      if ($('#pgApiLogs')) $('#pgApiLogs').innerHTML = PG.footSrv('apilogs', rec);
    },
    pools() {
      const set = new Set();
      (DB.ov.channels || []).forEach(c => { if (c.pool && c.pool !== '—') set.add(c.pool); });
      return Array.from(set).sort();
    },
    async create() {
      const pools = this.pools();
      const opts = ['<option value="">不绑定（可用请求参数指定 pool_id）</option>']
        .concat(pools.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>')).join('');
      Modal.onOk = async () => {
        const name = ($('#kName') && $('#kName').value || '').trim();
        const pool_id = ($('#kPool') && $('#kPool').value) || '';
        const note = ($('#kNote') && $('#kNote').value || '').trim();
        const api_key = ($('#kApi') && $('#kApi').value || '').trim();
        const secret_key = ($('#kSecret') && $('#kSecret').value || '').trim();
        const sms_key = ($('#kSms') && $('#kSms').value || '').trim();
        if (!name) { toast('请填写应用名称', '', 'err'); return false; }
        try {
          const payload = { name: name, pool_id: pool_id, note: note };
          if (api_key) payload.api_key = api_key;
          if (secret_key) payload.secret_key = secret_key;
          if (sms_key) payload.sms_key = sms_key;
          const row = await DB.createApiKey(payload);
          await DB.loadApiKeys();
          this.render();
          if (!row || !row.api_key) {
            toast('已创建', '请在列表中查看新密钥', 'ok', 2200);
            return true;
          }
          setTimeout(() => {
            Modal.open('API Key 已创建',
              '<div class="note warn" style="margin-bottom:12px"><b>请妥善保存密钥</b>，关闭后列表仅显示掩码。</div>' +
              '<div style="font-size:12px;color:#888;margin-bottom:6px">应用：' + esc(row.name || '') +
              (row.pool_id ? ' · 池 ' + esc(row.pool_id) : '') + '</div>' +
              '<div class="mxtag">api_key</div><pre class="codeblock" style="user-select:all;word-break:break-all">' + esc(row.api_key) + '</pre>' +
              '<div class="mxtag">secret_key</div><pre class="codeblock" style="user-select:all;word-break:break-all">' + esc(row.secret_key || '') + '</pre>' +
              '<div class="mxtag">sms_key</div><pre class="codeblock" style="user-select:all;word-break:break-all">' + esc(row.sms_key || '') + '</pre>',
              '<button class="btn" data-mact="close">关闭</button>' +
              '<button class="btn primary" id="btnCopyKey">复制 api_key</button>');
            const cbtn = $('#btnCopyKey');
            if (cbtn) cbtn.addEventListener('click', async () => {
              try { await navigator.clipboard.writeText(row.api_key); toast('已复制', '', 'ok', 1500); }
              catch (ex) { toast('复制失败', errText(ex), 'err'); }
            });
          }, 40);
          return true;
        } catch (ex) { toast('创建失败', errText(ex), 'err'); return false; }
      };
      Modal.open('新建 API Key',
        '<div class="oa-form">' +
        '<label>应用名称<input class="inp" id="kName" placeholder="如：订单系统 / CRM"></label>' +
        '<label>绑定号码池<select class="sel" id="kPool">' + opts + '</select></label>' +
        '<label>api_key（可选，留空自动生成）<input class="inp mono" id="kApi" placeholder="对接文档提供的 api_key"></label>' +
        '<label>secret_key（签名密钥）<input class="inp mono" id="kSecret" placeholder="默认与 api_key 相同"></label>' +
        '<label>sms_key（短信加解密）<input class="inp mono" id="kSms" placeholder="默认文档密钥"></label>' +
        '<label>备注<input class="inp" id="kNote" placeholder="可选"></label>' +
        '</div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">创建</button>');
    },
    async edit(k) {
      if (!k) return;
      const pools = this.pools();
      const opts = ['<option value="">不绑定</option>']
        .concat(pools.map(p => '<option value="' + esc(p) + '"' + (k.pool_id === p ? ' selected' : '') + '>' + esc(p) + '</option>')).join('');
      Modal.onOk = async () => {
        try {
          await DB.apiKeyAct(k.id, {
            name: ($('#kName').value || '').trim() || k.name,
            pool_id: ($('#kPool').value || ''),
            note: ($('#kNote').value || '').trim(),
            secret_key: ($('#kSecret').value || '').trim(),
            sms_key: ($('#kSms').value || '').trim(),
            enabled: +k.enabled,
          });
          toast('已更新', '', 'ok', 1500);
          await DB.loadApiKeys();
          this.render();
          return true;
        } catch (ex) { toast('保存失败', errText(ex), 'err'); return false; }
      };
      Modal.open('编辑 · ' + (k.name || ''),
        '<div class="oa-form">' +
        '<label>应用名称<input class="inp" id="kName" value="' + esc(k.name || '') + '"></label>' +
        '<label>绑定号码池<select class="sel" id="kPool">' + opts + '</select></label>' +
        '<label>api_key（只读）<input class="inp mono" value="' + esc(k.api_key || '') + '" readonly></label>' +
        '<label>secret_key<input class="inp mono" id="kSecret" value="' + esc(k.secret_key || '') + '"></label>' +
        '<label>sms_key<input class="inp mono" id="kSms" value="' + esc(k.sms_key || '') + '"></label>' +
        '<label>备注<input class="inp" id="kNote" value="' + esc(k.note || '') + '"></label>' +
        '</div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存</button>');
    },
    render() {
      const base = location.origin;
      const ep = $('#openapiEndpoints');
      if (ep) {
        ep.textContent =
          '协议        UTF-8 JSON · POST · ts(毫秒) + SHA256(sign)\n' +
          '文档发送    POST ' + base + '/ufi-app/api/ufi/sendSms\n' +
          '            兼容 POST ' + base + '/api/v1/sms/sendSms\n' +
          '鉴权        业务参数按 key ASCII 升序拼接 + &secret_key=SK → SHA-256\n' +
          '            ts 须在服务器时间 ±5 分钟内\n' +
          '兼容 Bearer Authorization: Bearer <API_KEY>  （/api/v1/sms/send 等）\n\n' +
          'POST   /ufi-app/api/ufi/sendSms   文档发送（requestId/ts/sign/caller/callee/text）\n' +
          'POST   /api/v1/sms/send           兼容单发（Bearer 或 ts+sign）\n' +
          'POST   /api/v1/sms/batch          批量（异步任务）\n' +
          'GET    /api/v1/sms/message/{id}   按消息 ID 查询\n' +
          'GET    /api/v1/sms/health         通道健康检查\n' +
          '推送       运营商 mo_url / report_url（smsBody XOR+Base64，附 sign）';
      }
      const curl = $('#openapiCurl');
      if (curl) {
        curl.textContent =
          '# 文档协议 sendSms（需自行计算 sign）\n' +
          'curl -X POST "' + base + '/ufi-app/api/ufi/sendSms" \\\n' +
          '  -H "Content-Type: application/json; charset=utf-8" \\\n' +
          '  -d \'{"requestId":"uuid","ts":1733827361936,"sign":"<sha256>","callerNumber":"13625000004","calleeNumber":"15159900003","text":"测试短信"}\'\n\n' +
          '# 兼容 Bearer 单发\n' +
          'curl -X POST "' + base + '/api/v1/sms/send" \\\n' +
          '  -H "Authorization: Bearer <API_KEY>" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          '  -d \'{"to":"13800138000","content":"您的验证码是 123456","ext_id":"order-1001"}\'';
      }
      const kpi = $('#kpiOpenapi');
      if (kpi) {
        const keys = DB.apikeys || [];
        const on = keys.filter(k => +k.enabled === 1).length;
        const wl = DB.whitelist || {};
        const wlN = (wl.items || []).filter(x => +x.enabled === 1).length;
        kpi.innerHTML =
          '<div class="kpi"><b>' + keys.length + '</b><span>API Key</span></div>' +
          '<div class="kpi"><b>' + on + '</b><span>已启用</span></div>' +
          '<div class="kpi"><b>' + wlN + '</b><span>白名单 IP</span></div>' +
          '<div class="kpi"><b>' + ((DB.ov.health || {}).chOk || 0) + '</b><span>可用通道</span></div>';
      }
      this.renderWl();
      const tb = $('#keyBody');
      if (!tb) return;
      const keys = DB.apikeys || [];
      if (!keys.length) {
        tb.innerHTML = '<tr><td colspan="8"><div class="empty">' + I('key', 34) + '暂无 API Key · 点右上角新建</div></td></tr>';
        return;
      }
      tb.innerHTML = keys.map(k =>
        '<tr>' +
        '<td><b>' + esc(k.name) + '</b>' + (k.note ? '<div style="font-size:11px;color:#888">' + esc(k.note) + '</div>' : '') + '</td>' +
        '<td><code title="' + esc(k.api_key || '') + '">' + esc(k.api_key_masked || '') + '</code></td>' +
        '<td><code style="font-size:11px">' + esc((k.secret_key || '').slice(0, 8) + (k.secret_key && k.secret_key.length > 8 ? '…' : '')) + '</code></td>' +
        '<td>' + (k.pool_id ? esc(k.pool_id) : '—') + '</td>' +
        '<td>' + (+k.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>') + '</td>' +
        '<td>' + esc(k.last_used || '—') + '</td>' +
        '<td>' + esc(k.created || '') + '</td>' +
        '<td class="col-act">' +
          '<button class="btn sm" data-kact="edit" data-kid="' + k.id + '">编辑</button> ' +
          '<button class="btn sm" data-kact="toggle" data-kid="' + k.id + '">' + (+k.enabled ? '停用' : '启用') + '</button> ' +
          '<button class="btn sm" data-kact="del" data-kid="' + k.id + '">删除</button>' +
        '</td></tr>'
      ).join('');
      const cnt = $('#cntKeys');
      if (cnt) cnt.textContent = keys.length;
      this.renderLogs();
    },
    scopeLabel(s) {
      if (s === 'sms') return '<span class="tag info">短信 API</span>';
      if (s === 'carrier') return '<span class="tag warn">通话运营商</span>';
      return '<span class="tag ok">全部</span>';
    },
    renderWl() {
      const wl = DB.whitelist || {};
      const cfg = wl.cfg || {};
      const smsEn = $('#wlSmsEn');
      const carEn = $('#wlCarrierEn');
      if (smsEn) smsEn.checked = !!+cfg.sms_enabled;
      if (carEn) carEn.checked = !!+cfg.carrier_enabled;
      const tip = $('#wlHint');
      if (tip) {
        tip.innerHTML = '<div class="nb"><b>规则：</b>关闭开关时不拦截。开启后仅名单内 IP 可调用对应接口；' +
          '「通话运营商」会同步写入 Kamailio <code>address</code> 表，并校验「运营商组」里新增/修改的网关 IP。' +
          '当前访问 IP：<code>' + esc(wl.client_ip || '—') + '</code></div>';
      }
      const cip = $('#wlClientIp');
      if (cip) cip.textContent = wl.client_ip ? ('当前 IP ' + wl.client_ip) : '';
      const tb = $('#wlBody');
      if (!tb) return;
      const items = wl.items || [];
      if (!items.length) {
        tb.innerHTML = '<tr><td colspan="6"><div class="empty">' + I('shield', 34) +
          '暂无白名单 · 开启前请先添加对接方 IP/CIDR</div></td></tr>';
        return;
      }
      tb.innerHTML = items.map(r =>
        '<tr>' +
        '<td><code>' + esc(r.cidr) + '</code></td>' +
        '<td>' + this.scopeLabel(r.scope) + '</td>' +
        '<td>' + esc(r.note || '—') + '</td>' +
        '<td>' + (+r.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag">停用</span>') + '</td>' +
        '<td>' + esc(r.created || '') + '</td>' +
        '<td class="col-act">' +
          '<button class="btn sm" data-wlact="toggle" data-wid="' + r.id + '">' + (+r.enabled ? '停用' : '启用') + '</button> ' +
          '<button class="btn sm" data-wlact="del" data-wid="' + r.id + '">删除</button>' +
        '</td></tr>'
      ).join('');
    },
    addWl() {
      Modal.open('添加接入白名单',
        '<label>IP 或 CIDR<input class="inp mono" id="wlCidr" placeholder="例如 203.0.113.10 或 203.0.113.0/24"></label>' +
        '<label>适用范围<select class="sel" id="wlScope" style="width:100%">' +
          '<option value="all">全部（短信 API + 通话运营商）</option>' +
          '<option value="sms">仅短信 API</option>' +
          '<option value="carrier">仅通话运营商组</option>' +
        '</select></label>' +
        '<label>备注<input class="inp" id="wlNote" placeholder="对接方名称 / 用途"></label>',
        '<button class="btn" data-modal-cancel>取消</button>' +
        '<button class="btn primary" id="btnWlConfirm">添加</button>');
      const save = $('#btnWlConfirm');
      if (save) save.addEventListener('click', async () => {
        const cidr = ($('#wlCidr') && $('#wlCidr').value || '').trim();
        if (!cidr) { toast('请填写 IP/CIDR', '', 'warn', 1800); return; }
        save.disabled = true;
        try {
          await DB.addWhitelist({
            cidr: cidr,
            scope: ($('#wlScope') && $('#wlScope').value) || 'all',
            note: ($('#wlNote') && $('#wlNote').value) || ''
          });
          Modal.close();
          toast('已添加', cidr, 'ok', 1800);
          this.renderWl();
        } catch (ex) { toast('添加失败', errText(ex), 'err'); }
        finally { save.disabled = false; }
      });
    }
  };

  /* ════════════════════════════════════════════════════════════ ALERTS */
  const Alerts = {
    page: 1,
    TEST_SAMPLES: [
      { name: '移动 · 星级客户余额预警 8.60 元（预期 P2）', sender: '10086',
        text: '尊敬的客户，至10月21日20时，您的账户余额为8.60元。您是3星级客户，在48小时内可享受透支额度为30.00元。欠费停机将影响您的通信畅通，建议您及时预存话费。话费查询请拨1008611。中国移动。' },
      { name: '移动 · 全球通透支 -31.79 元（预期 P0）', sender: '10086',
        text: '【话费提醒】尊敬的全球通客户，您好！截止20日20时36分您的账户余额-31.79元，本月可透支额度50.00元。' },
      { name: '移动 · 充值到账、欠费金额 0.00 元（预期：恢复）', sender: '10086',
        text: '【充值到账提醒】尊敬的客户您好，20日15时28分您的号码成功缴费100.00元，您的可用余额为116.67元，待返还余额为0.00元，欠费金额为0.00元。' },
      { name: '联通 · 流量用尽提醒（预期：忽略）', sender: '10010',
        text: '【中国联通】流量用尽提醒：截至07月30日16时18分，您当月套餐内的国内通用流量已用4.000GB，剩余0.0MB；当前套餐套外流量资费为1元/GB日租宝（当日有效，自动叠加）。' },
      { name: '电信 · 余额 6.43 元预警（预期 P2）', sender: '10001',
        text: '尊敬的客户，截至07月17日09时，您的话费余额为6.43元，欠费停机将影响您的使用和星级，请及时交费。' },
      { name: '广电 · 套外语音费用 5.1 元（预期 P3）', sender: '10099',
        text: '截止25年12月25日9点36分，您的套餐外语音话费已达5.1元，套外语音资费0.15元/分钟，请合理使用，详询10099。中国广电' },
      { name: '移动 · 超套餐提醒 147.66 元（预期 P3）', sender: '10086',
        text: '【超套餐提醒】截至07月20日20时35分，您本月移动数据流量已使用27.26GB，超出套餐流量已达到511.95MB，套餐外流量总费用147.66元。' },
      { name: '移动 · 本账期出账提醒（预期：默认忽略）', sender: '10086',
        text: '尊敬的客户，截至2022年3月18日0时23分18秒，您本账期已产生总费用40028元。' },
      { name: '联通 · 信用度透支提醒（预期 P1）', sender: '10010',
        text: '联通客户经理友情提醒：您的话费余额已低于0元，已经消费您的信用度，请您在方便时及时缴费。' },
      { name: '非白名单端口 · 疑似钓鱼（预期：疑似）', sender: '1065712345678',
        text: '【移动通信】尊敬的客户，您的号码已欠费35.00元即将停机，请立即登录 http://cz-pay.example 充值，逾期将影响使用。' }
    ],
    async reload() {
      await Promise.all([DB.loadAlertStats(), DB.loadAlertSims(), DB.loadAlerts()]);
    },
    init() {
      const seg = $('#alertStatusSeg');
      if (seg) seg.addEventListener('click', e => {
        const b = e.target.closest('[data-ast]'); if (!b) return;
        $$('#alertStatusSeg button').forEach(x => x.classList.toggle('on', x === b));
        DB.alertsQ.status = b.dataset.ast || 'all';
        DB.alertsQ.page = 1;
        this.reload().then(() => this.render());
      });
      const apply = () => {
        DB.alertsQ.type = ($('#alertType') && $('#alertType').value) || '';
        DB.alertsQ.sim = ($('#alertSim') && $('#alertSim').value) || '';
        DB.alertsQ.q = ($('#alertKw') && $('#alertKw').value) || '';
        DB.alertsQ.page = 1;
        this.reload().then(() => this.render());
      };
      const btn = $('#alertApply'); if (btn) btn.addEventListener('click', apply);
      const kw = $('#alertKw'); if (kw) kw.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
      const scan = $('#alertScan');
      if (scan) scan.addEventListener('click', async () => {
        scan.disabled = true;
        try {
          const r = await DB.scanAlerts();
          const n = (r.data && r.data[0] && r.data[0].created) || 0;
          toast('扫描完成', '新建 ' + n + ' 条告警', 'ok');
          $('#alertLastScan').textContent = '最近扫描：' + new Date().toLocaleTimeString();
          await this.reload(); this.render();
        } catch (ex) { toast('扫描失败', errText(ex), 'err'); }
        finally { scan.disabled = false; }
      });
      const all = $('#alertDoneAll');
      if (all) all.addEventListener('click', async () => {
        if (!confirm('确认将全部未处理告警标为已处理？')) return;
        try {
          const r = await DB.alertDoneAll();
          toast('已处理', '更新 ' + (((r.data || [])[0] || {}).updated || 0) + ' 条', 'ok');
          await this.reload(); this.render();
        } catch (ex) { toast('操作失败', errText(ex), 'err'); }
      });
      const mail = $('#alertMailCfg');
      if (mail) mail.addEventListener('click', () => this.openMailCfg());
      const bench = $('#alertTestBench');
      if (bench) bench.addEventListener('click', () => this.openTestBench());
      document.body.addEventListener('click', e => {
        const d1 = e.target.closest('[data-alert-done]');
        if (d1) {
          const id = +d1.getAttribute('data-alert-done');
          DB.alertDone(id).then(() => { toast('已处理', '#' + id, 'ok'); return this.reload(); }).then(() => this.render())
            .catch(ex => toast('失败', errText(ex), 'err'));
        }
        const d2 = e.target.closest('[data-sim-done]');
        if (d2) {
          const sim = d2.getAttribute('data-sim') || '';
          const imei = d2.getAttribute('data-imei') || '';
          DB.alertSimDone(sim, imei).then(r => {
            toast('已处理该卡', '更新 ' + (((r.data || [])[0] || {}).updated || 0) + ' 条', 'ok');
            return this.reload();
          }).then(() => this.render()).catch(ex => toast('失败', errText(ex), 'err'));
        }
      });
    },
    levelMeta(a) {
      const lv = String((a && (a.level || '')) || '');
      const type = String((a && (a.alert_type || a.label)) || '');
      if (lv === 'P0' || type === '欠费停机') return { code: 'P0', cls: 'danger', card: 'unread', label: 'P0 欠费停机' };
      if (lv === 'P1' || type === '欠费预警') return { code: 'P1', cls: 'orange', card: 'warning', label: 'P1 欠费预警' };
      if (lv === 'P3' || type === '超套费用') return { code: 'P3', cls: 'purple', card: 'p3', label: 'P3 超套费用' };
      if (lv === 'SUSPECT' || type === '疑似告警') return { code: '疑似', cls: 'gray', card: 'suspect', label: '疑似告警' };
      if (lv === 'RECOVERED' || type === '充值恢复') return { code: '恢复', cls: 'green', card: 'done', label: '充值恢复' };
      if (lv === 'IGNORED' || type === '无需处理') return { code: '忽略', cls: 'gray', card: 'suspect', label: '无需处理' };
      return { code: 'P2', cls: 'warn', card: 'warning', label: type ? ('P2 ' + type) : 'P2 余额不足' };
    },
    hl(s) {
      return esc(s || '').replace(/(欠费停机|已欠费|欠费|停机|余额不足|账户余额|即将停机|暂停服务|停止服务|限制主叫|套餐外|超套餐|[0-9]+\.?[0-9]*\s*元)/g, '<span class="hl">$1</span>');
    },
    fmtSim(v) {
      let d = String(v || '').replace(/\D/g, '');
      if (d.indexOf('86') === 0 && d.length === 13 && d.charAt(2) === '1') d = d.slice(2);
      return d || String(v || '');
    },
    render() {
      this.renderKpi();
      this.renderSims();
      this.renderList();
      this.fillSimFilter();
      Renderer.counts();
    },
    renderKpi() {
      const s = DB.alertStats || {};
      const box = $('#kpiAlerts'); if (!box) return;
      box.innerHTML =
        '<div class="kpi err"><div class="k">P0 欠费停机卡</div><div class="v">' + (s.dangerSims || 0) + '<small> 张</small></div></div>' +
        '<div class="kpi warn"><div class="k">P1–P3 预警卡</div><div class="v">' + (s.warnSims || 0) + '<small> 张</small></div></div>' +
        '<div class="kpi info"><div class="k">今日告警邮件</div><div class="v">' + (s.mailedToday || 0) + '<small> 封</small></div></div>' +
        '<div class="kpi ok"><div class="k">已处理告警</div><div class="v">' + (s.done || 0) + '<small> 条</small></div></div>';
      const tn = $('#todoN'); if (tn) tn.textContent = s.todo || 0;
      const ac = $('#abnCount'); if (ac) ac.textContent = ((s.dangerSims || 0) + (s.warnSims || 0)) + ' 张';
    },
    renderSims() {
      const rows = DB.alertSims || [];
      const tb = $('#abnBody'); const empty = $('#abnEmpty');
      if (!tb) return;
      if (!rows.length) {
        tb.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
      }
      if (empty) empty.style.display = 'none';
      tb.innerHTML = rows.map(r => {
        const meta = this.levelMeta(r);
        const body = String(r.body || '').slice(0, 48);
        return '<tr>' +
          '<td class="mono">' + esc(this.fmtSim(r.sim || r.sim_key) || '—') + '</td>' +
          '<td class="mono">' + esc(r.imei || '—') + '</td>' +
          '<td>' + esc(r.carrier || '—') + '</td>' +
          '<td><span class="tag ' + meta.cls + '">' + esc(meta.label || r.status_label || '') + '</span></td>' +
          '<td>' + esc(r.amount || '—') + '</td>' +
          '<td title="' + esc(r.body || '') + '">' + esc(body) + (body.length >= 48 ? '…' : '') + '</td>' +
          '<td>' + (r.todo_n || 0) + '</td>' +
          '<td class="col-act"><button class="btn sm primary" type="button" data-sim-done="1" data-sim="' +
            esc(this.fmtSim(r.sim || r.sim_key) || '') + '" data-imei="' + esc(r.imei || '') + '">处理</button></td></tr>';
      }).join('');
    },
    fillSimFilter() {
      const sel = $('#alertSim'); if (!sel) return;
      const cur = sel.value;
      const sims = {};
      (DB.alertSims || []).forEach(r => { const k = this.fmtSim(r.sim || r.sim_key); if (k) sims[k] = 1; });
      (DB.alerts.items || []).forEach(a => { const k = this.fmtSim(a.sim); if (k) sims[k] = 1; });
      sel.innerHTML = '<option value="">全部手机号</option>' +
        Object.keys(sims).map(s => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
      if (cur) sel.value = cur;
    },
    renderList() {
      const box = $('#alertList'); if (!box) return;
      const items = (DB.alerts && DB.alerts.items) || [];
      const total = (DB.alerts && DB.alerts.total) || 0;
      const cnt = $('#alertCount'); if (cnt) cnt.textContent = '共 ' + total + ' 条';
      if (!items.length) {
        box.innerHTML = '<div class="empty" style="padding:36px;text-align:center;color:#94a3b8">该筛选条件下暂无异常短信</div>';
      } else {
        box.innerHTML = items.map(a => {
          const meta = this.levelMeta(a);
          const cls = a.status === 'done' ? 'done' : meta.card;
          const conf = a.confidence ? ('<span class="alert-conf">置信 ' + esc(String(a.confidence)) + '%</span>') : '';
          return '<div class="alert-card ' + cls + '">' +
            '<div class="alert-top">' +
            '<span class="tag ' + meta.cls + '">' + esc(meta.label) + '</span>' + conf +
            '<span class="alert-title">' + esc(this.fmtSim(a.sim) || a.imei || '') +
            (a.carrier ? ' · ' + esc(a.carrier) : '') + '</span>' +
            '<span class="alert-time">' + esc(a.created || '') + '</span>' +
            '<div class="alert-actions">' +
            (a.status === 'todo'
              ? '<button class="btn sm primary" type="button" data-alert-done="' + a.id + '">标为已处理</button>'
              : '<span class="tag green">已处理</span>') +
            '</div></div>' +
            '<div class="alert-sms">' + this.hl(a.body) + '</div>' +
            '<div class="alert-meta">' +
            '<span>发送方 <b>' + esc(a.peer || '—') + '</b></span>' +
            '<span>金额 <b>' + esc(a.amount || '—') + '</b></span>' +
            '<span>规则 <b>' + esc(a.rule_hit || '—') + '</b></span>' +
            '<span>邮件 <b>' + esc(a.mail_status || '未发') + '</b></span>' +
            (a.status === 'done' ? '<span>处理人 <b>' + esc(a.done_by || '') + ' ' + esc(a.done_at || '') + '</b></span>' : '') +
            '</div></div>';
        }).join('');
      }
      const size = DB.alertsQ.size || 10;
      const pages = Math.max(1, Math.ceil(total / size));
      const page = DB.alertsQ.page || 1;
      const bar = $('#pgAlerts');
      if (bar) bar.innerHTML = PG.footSrv('alerts', { total: total, page: page, pages: pages, size: size });
    },
    async openMailCfg() {
      let cfg = {};
      try { cfg = await DB.loadAlertCfg(); } catch (e) { cfg = {}; }
      Modal.open('告警规则与通知设置',
        '<label class="mxtag">收件邮箱（逗号分隔）</label>' +
        '<input class="inp" id="acEmails" style="width:100%" value="' + esc(cfg.emails || '') + '">' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">移动阈值（元）</label><input class="inp" id="acThrCmcc" style="width:100%" value="' + esc(String(cfg.thr_cmcc != null ? cfg.thr_cmcc : 10)) + '"></div>' +
        '<div><label class="mxtag">电信阈值（元）</label><input class="inp" id="acThrCt" style="width:100%" value="' + esc(String(cfg.thr_ct != null ? cfg.thr_ct : 20)) + '"></div>' +
        '<div><label class="mxtag">联通阈值（元）</label><input class="inp" id="acThrCu" style="width:100%" value="' + esc(String(cfg.thr_cu != null ? cfg.thr_cu : 10)) + '"></div>' +
        '<div><label class="mxtag">广电阈值（元）</label><input class="inp" id="acThrCb" style="width:100%" value="' + esc(String(cfg.thr_cb != null ? cfg.thr_cb : 20)) + '"></div>' +
        '</div>' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">超套费用阈值（元）</label><input class="inp" id="acOverageTh" style="width:100%" value="' + esc(String(cfg.overage_threshold != null ? cfg.overage_threshold : 50)) + '"></div>' +
        '<div><label class="mxtag">非白名单端口</label><select class="sel" id="acPortPol" style="width:100%">' +
          '<option value="suspect"' + ((cfg.unknown_port_policy || 'suspect') === 'suspect' ? ' selected' : '') + '>降级为疑似</option>' +
          '<option value="ignore"' + (cfg.unknown_port_policy === 'ignore' ? ' selected' : '') + '>直接忽略</option>' +
        '</select></div></div>' +
        '<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">' +
        '<label><input type="checkbox" id="acSus"' + (cfg.enable_suspend !== 0 ? ' checked' : '') + '> P0 欠费停机告警</label>' +
        '<label><input type="checkbox" id="acLow"' + (cfg.enable_low !== 0 ? ' checked' : '') + '> P1/P2 预警告警</label>' +
        '<label><input type="checkbox" id="acOverage"' + (cfg.enable_overage !== 0 ? ' checked' : '') + '> P3 超套费用告警</label>' +
        '<label><input type="checkbox" id="acBilling"' + (cfg.billing_alert ? ' checked' : '') + '> 出账提醒按告警处理</label>' +
        '<label><input type="checkbox" id="acDed"' + (cfg.dedupe !== 0 ? ' checked' : '') + '> 24 小时同卡同类型去重</label></div>' +
        '<p class="hint" style="margin-top:10px">端口白名单：移动 10086/1008611、联通 10010、电信 10000/10001/11888、广电 10099。命中 P0–P3 后按系统 SMTP 发信。</p>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存</button>'
      );
      Modal.onOk = async () => {
        try {
          await DB.saveAlertCfg({
            emails: ($('#acEmails') && $('#acEmails').value) || '',
            thr_cmcc: ($('#acThrCmcc') && $('#acThrCmcc').value) || 10,
            thr_ct: ($('#acThrCt') && $('#acThrCt').value) || 20,
            thr_cu: ($('#acThrCu') && $('#acThrCu').value) || 10,
            thr_cb: ($('#acThrCb') && $('#acThrCb').value) || 20,
            overage_threshold: ($('#acOverageTh') && $('#acOverageTh').value) || 50,
            unknown_port_policy: ($('#acPortPol') && $('#acPortPol').value) || 'suspect',
            enable_suspend: ($('#acSus') && $('#acSus').checked) ? 1 : 0,
            enable_low: ($('#acLow') && $('#acLow').checked) ? 1 : 0,
            enable_overage: ($('#acOverage') && $('#acOverage').checked) ? 1 : 0,
            billing_alert: ($('#acBilling') && $('#acBilling').checked) ? 1 : 0,
            dedupe: ($('#acDed') && $('#acDed').checked) ? 1 : 0
          });
          toast('已保存', '告警规则设置', 'ok');
        } catch (ex) { toast('保存失败', errText(ex), 'err'); return false; }
      };
    },
    openTestBench() {
      const samples = this.TEST_SAMPLES;
      Modal.open('规则测试台',
        '<label class="mxtag">内置样本</label>' +
        '<select class="sel" id="tbSample" style="width:100%"><option value="">— 选择样本一键填入 —</option>' +
        samples.map((s, i) => '<option value="' + i + '">' + esc(s.name) + '</option>').join('') +
        '</select>' +
        '<div class="grid2" style="gap:12px;margin-top:12px">' +
        '<div><label class="mxtag">发送端口</label><input class="inp" id="tbPeer" style="width:100%" placeholder="如 10086" value="10086"></div>' +
        '<div style="display:flex;align-items:flex-end"><button type="button" class="btn primary" id="tbRun" style="width:100%">分级判定</button></div></div>' +
        '<label class="mxtag" style="margin-top:12px;display:block">短信原文</label>' +
        '<textarea class="inp" id="tbBody" rows="6" style="width:100%" placeholder="粘贴运营商短信原文…"></textarea>' +
        '<div class="tb-result" id="tbResult">选择样本或粘贴原文后点「分级判定」</div>',
        '<button class="btn" data-mact="close">关闭</button>',
        'lg'
      );
      const fill = () => {
        const i = +(($('#tbSample') && $('#tbSample').value) || -1);
        if (i < 0 || !samples[i]) return;
        $('#tbBody').value = samples[i].text;
        $('#tbPeer').value = samples[i].sender;
      };
      const run = async () => {
        const body = (($('#tbBody') && $('#tbBody').value) || '').trim();
        const peer = (($('#tbPeer') && $('#tbPeer').value) || '').trim();
        if (!body) { toast('请填写短信原文', '', 'warn'); return; }
        try {
          const r = await DB.classifyAlert(body, peer);
          const hit = (r.data && r.data[0]) || r[0] || {};
          const meta = this.levelMeta({ level: hit.level, alert_type: hit.label });
          const amts = (hit.amounts || []).map(a => a.name + ' ' + a.value + ' 元').join('；') || '—';
          const hits = (hit.hits || []).join('；') || '—';
          const notes = (hit.notes || []).join('；') || '—';
          $('#tbResult').innerHTML =
            '<span class="tag ' + meta.cls + ' lv">' + esc(meta.label) + '</span>' +
            '<span>置信度 <b>' + esc(String(hit.confidence || 0)) + '%</b></span> · ' +
            '<span>运营商 <b>' + esc(hit.carrier || '—') + '</b></span> · ' +
            '<span>白名单 <b>' + (hit.whitelisted ? '是' : '否') + '</b></span>' +
            '<div style="margin-top:8px">金额：' + esc(amts) + '</div>' +
            '<div>命中：' + esc(hits) + '</div>' +
            '<div>备注：' + esc(notes) + '</div>';
        } catch (ex) { toast('判定失败', errText(ex), 'err'); }
      };
      if ($('#tbSample')) $('#tbSample').addEventListener('change', fill);
      if ($('#tbRun')) $('#tbRun').addEventListener('click', run);
    }
  };

  /* ════════════════════════════════════════════════════════════ RENDERER */
  const Renderer = {
    render(v) {
      if (v === 'compose') { if (DB.loaded) { Compose.renderTplSel(); Compose.renderVars(); Compose.statRcpts(); Compose.check(); Compose.renderParams(); } }
      else if (v === 'records') Records.table();
      else if (v === 'alerts') Alerts.render();
      else if (v === 'campaign') Campaign.render();
      else if (v === 'channels') Channels.render();
      else if (v === 'tpl') Tpl.render();
      else if (v === 'blacklist') Blacklist.render();
      else if (v === 'words') Words.render();
      else if (v === 'openapi') OpenApi.render();
      this.counts();
      this.pills();
    },
    counts() {
      const c = DB.ov.counts || {};
      $('#cntRecords').textContent = c.records || 0;
      $('#cntCampaign').textContent = (DB.sms.tasks && DB.sms.tasks.length) || c.tasks || 0;
      $('#cntChannels').textContent = (DB.ov.health || {}).chOk || 0;
      $('#cntTpl').textContent = c.tpl || 0;
      $('#cntBlack').textContent = c.black || 0;
      $('#cntWords').textContent = c.words || 0;
      const ca = $('#cntAlerts');
      if (ca) ca.textContent = (DB.alertStats && DB.alertStats.todo) || 0;
      const ck = $('#cntKeys');
      if (ck) ck.textContent = (DB.apikeys && DB.apikeys.length) || 0;
    },
    pills() {
      const h = DB.ov.health || {};
      $('#pillChN').textContent = (h.chOk || 0) + '/' + (h.chAll || 0);
      $('#pillKsrN').textContent = '在线';
    }
  };

  /* ════════════════════════════════════════════════════════════ 数据加载与轮询 */
  async function loadViewData(v) {
    try {
      if (v === 'campaign') await DB.loadTasks();
      else if (v === 'tpl') await DB.loadTpl();
      else if (v === 'blacklist') await DB.loadBlack();
      else if (v === 'words') await DB.loadWords();
      else if (v === 'records') await DB.loadRecords();
      else if (v === 'alerts') await Alerts.reload();
      else if (v === 'openapi') {
        await DB.loadApiKeys();
        try { await DB.loadWhitelist(); } catch (e2) { /* 白名单失败不阻断 */ }
        try { await DB.loadApiLogs(); } catch (e2) { /* 日志失败不阻断 Key */ }
      }
    } catch (ex) { toast('数据加载失败', errText(ex), 'err'); }
  }

  async function boot() {
    /* 初始数据 */
    try {
      await Promise.all([DB.refresh(), DB.loadTpl(), DB.loadBlack(), DB.loadWords(), DB.loadTasks()]);
    } catch (ex) {
      toast('初始化失败', errText(ex), 'err', 6000);
    }
    Nav.init();
    bindActions();
    Compose.init();
    Records.init();
    Campaign.init();
    Channels.init();
    Tpl.init();
    Blacklist.init();
    Words.init();
    OpenApi.init();
    Alerts.init();
    try { await DB.loadAlertStats(); Renderer.counts(); } catch (e) { /* 告警统计失败不阻断 */ }
    PG.reg('campaign', () => Campaign.render());
    PG.reg('alerts', () => {
      DB.alertsQ.page = PG.st.alerts ? PG.st.alerts.page : 1;
      DB.alertsQ.size = PG.st.alerts ? PG.st.alerts.size : 10;
      DB.loadAlerts().then(() => Alerts.renderList());
    });
    PG.reg('channels', () => Channels.renderTable());
    PG.reg('poolmem', () => Channels.renderPoolMembers());
    PG.reg('tpl', () => Tpl.render());
    PG.reg('black', () => Blacklist.table());
    PG.reg('words', () => Words.render());
    PG.reg('records', () => { DB.recordsQ.page = PG.st.records ? PG.st.records.page : 1; DB.recordsQ.size = PG.st.records ? PG.st.records.size : 15; Records.table(); });
    PG.reg('apilogs', () => {
      DB.apiLogsQ.page = PG.st.apilogs ? PG.st.apilogs.page : 1;
      DB.apiLogsQ.size = PG.st.apilogs ? PG.st.apilogs.size : 15;
      OpenApi.renderLogs();
    });
    Renderer.render(APP.view);

    setInterval(() => { $('#clock').textContent = fmtTime(new Date()); }, 1000);
    bindListCopyHelpers();
    APP.timer = setInterval(async () => {
      if (APP.paused || document.hidden) return;
      if (isSelectingText() || hasTextSelection()) return; /* 拖选 / 已选中时暂缓刷新 */
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      try { await DB.refresh(); } catch (ex) { return; }
      if (isSelectingText() || hasTextSelection()) return;
      if (APP.view === 'compose' || APP.view === 'channels') {
        Renderer.pills();
        Renderer.counts();
        if (APP.view === 'channels' && !typing && !Modal.isOpen()) Channels.renderTable();
        return;
      }
      if (!typing && !Modal.isOpen()) {
        if (APP.view !== 'records' && APP.view !== 'openapi') { await loadViewData(APP.view); }
        else if (APP.view === 'openapi') {
          try { await DB.loadApiKeys(); } catch (e) {}
        }
        Renderer.render(APP.view);
      }
    }, 3000);
  }

  /* ════════════════════════════════════════════════════════════ 动作总线 */
  function bindActions() {
    const A = {
      'go-compose': () => Nav.go('compose'),
      'task-new': () => Campaign.taskNew(),
      'tpl-new': () => Tpl.edit(null),
      'go-cc': () => { location.href = '/ufi-callcenter'; },
      'black-clear-used': () => Blacklist.clearManual(),
      'refresh': async () => {
        try { await Promise.all([DB.refresh(), loadViewData(APP.view)]); toast('已刷新', '', 'ok', 1500); Renderer.render(APP.view); }
        catch (ex) { toast('刷新失败', errText(ex), 'err'); }
      },
      'word-add-show': () => { Nav.go('words'); setTimeout(() => $('#wordInput').focus(), 60); }
    };
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      e.preventDefault();
      const a = A[t.dataset.act];
      if (a) a();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
