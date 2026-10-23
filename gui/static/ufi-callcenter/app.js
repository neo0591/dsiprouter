/* ============================================================================
   UFI Call Center Console — application logic
   ========================================================================= */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const I = (n, s) => Icon.svg(n, s);
  const num = n => (n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const pad2 = n => String(n).padStart(2, '0');

  let _ptrDown = null;
  function hasTextSelection() {
    try {
      const s = window.getSelection && window.getSelection();
      return !!(s && String(s).replace(/\s+/g, '').length);
    } catch (e) { return false; }
  }
  function trackPtrDown(e) {
    if (e.button !== 0) return;
    _ptrDown = { x: e.clientX, y: e.clientY };
  }
  function shouldSkipRowNav(e) {
    if (hasTextSelection()) return true;
    if (!_ptrDown) return false;
    return Math.abs((e.clientX || 0) - _ptrDown.x) > 4 || Math.abs((e.clientY || 0) - _ptrDown.y) > 4;
  }
  function bindListCopyHelpers(sel) {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el || el._copyBound) return;
    el._copyBound = true;
    el.addEventListener('mousedown', trackPtrDown, true);
    el.addEventListener('dblclick', e => {
      const cell = e.target.closest('.copyable, .mono, .io-imei, td.mono');
      if (!cell || cell.closest('button,a,input,select,label')) return;
      const text = (cell.getAttribute('data-copy') || cell.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text === '—' || text.length < 2) return;
      e.preventDefault();
      const done = () => toast('已复制', text.length > 48 ? text.slice(0, 48) + '…' : text, 'ok', 1600);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {});
      }
    });
  }

  const AG_STATE = {
    idle:    { label: '示闲', color: 'var(--ag-idle)', cls: 'ok' },
    busy:    { label: '通话中', color: 'var(--ag-busy)', cls: 'err' },
    wrap:    { label: '小休', color: 'var(--ag-wrap)', cls: 'warn' },
    na:      { label: '示忙', color: 'var(--st-idle)', cls: '' },
    offline: { label: '离线', color: 'var(--st-idle)', cls: '' }
  };

  const CALL_STATE = {
    talk:  { label: '通话中', cls: 'ok' },
    ring:  { label: '振铃',   cls: 'info' },
    queue: { label: '排队',   cls: 'purple' },
    done:  { label: '已完成', cls: '' },
    fail:  { label: '失败',   cls: 'err' }
  };

  /* ═══ 通话过程链路弹窗（实时通话流点击进入） ═══ */
  function openCallChain(c) {
    const st = CALL_STATE[c.state] || CALL_STATE.done;
    /* 阶段链：route 侧 INVITE + VoLTE 状态机时间线 */
    const steps = [];
    const rinv = (c.routeLog || '').match(/([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+) \| INVITE (\d+)/);
    if (rinv) steps.push({ t: 'INVITE ' + rinv[2], ts: rinv[1], cls: Number(rinv[2]) < 300 ? 'ok' : 'err', src: 'route 侧' });
    const vre = /([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+) \| VoLTE state=(DIALING|ALERTING|ACTIVE|END)[^,]*, callid=[^,]*, dir=(MO|MT)/g;
    const vlbl = { DIALING: '外呼中', ALERTING: '振铃', ACTIVE: '已接通', END: '释放' };
    const seen = {};
    let m;
    while ((m = vre.exec(c.vlog || ''))) {
      const s = m[2];
      if (seen[s]) continue;
      seen[s] = 1;
      const cm = /code=(-?\d+)/.exec(m[0]);
      steps.push({
        t: vlbl[s] + (s === 'END' && cm && cm[1] !== '-1' ? ' (code ' + cm[1] + ')' : ''),
        ts: m[1],
        cls: s === 'END' ? (c.state === 'fail' ? 'err' : 'ok') : (s === 'ACTIVE' ? 'ok' : 'info'),
        src: 'volte 侧'
      });
    }
    if (!steps.length && c.routeLog) steps.push({ t: '已落地 dSIPRouter', ts: c.createdAt || '', cls: 'info', src: 'route 侧' });

    const chain = steps.length
      ? '<div class="chain">' + steps.map(s =>
          '<span class="cs ' + s.cls + '"><b>' + esc(s.t) + '</b><i>' + esc(s.ts ? s.ts.slice(5) : '') + '</i><u>' + esc(s.src) + '</u></span>'
        ).join('<span class="ar">→</span>') + '</div>'
      : '<div class="chain empty">暂无链路数据（该通话缺少状态上报）</div>';

    const meta =
      '<div class="ccmeta">' +
      '<div><span>对端号码</span><b class="mono">' + esc(c.peer) + '</b></div>' +
      '<div><span>方向</span><b>' + (c.dir === 'out' ? '呼出 (MO)' : '呼入 (MT)') + '</b></div>' +
      '<div><span>状态</span><b class="tag ' + st.cls + '">' + st.label + '</b></div>' +
      '<div><span>时长</span><b class="mono">' + fmtDur(c.dur) + '</b></div>' +
      '<div><span>开始</span><b class="mono">' + esc(fmtTs(c.at)) + '</b></div>' +
      '<div><span>UFI / 池</span><b class="mono">' + esc(c.imei) + ' / ' + esc(c.pool) + '</b></div>' +
      (c.routeCallId ? '<div><span>话单 Call-ID</span><b class="mono sm">' + esc(c.routeCallId) + '</b></div>' : '') +
      (c.traceId ? '<div><span>traceId</span><b class="mono sm">' + esc(c.traceId) + '</b></div>' : '') +
      (c.failReason ? '<div><span>失败原因</span><b class="mono">' + esc(c.failReason) + '</b></div>' : '') +
      '</div>';

    const logs =
      (c.routeLog ? '<div class="lb-h">route 侧 · dSIPRouter / Kamailio（按时间窗关联）</div><pre class="step-log">' + esc(c.routeLog) + '</pre>' : '') +
      (c.slog ? '<div class="lb-h">sip 侧 · UFI SIP 协议栈</div><pre class="step-log">' + esc(c.slog) + '</pre>' : '') +
      (c.vlog ? '<div class="lb-h">volte 侧 · UFI VoLTE 状态机</div><pre class="step-log">' + esc(c.vlog) + '</pre>' : '') ||
      '<div class="chain empty">该通话暂无上报日志</div>';

    Modal.open('通话过程链路 · ' + (c.peer || c.imei), meta + '<div class="lb-h">阶段链</div>' + chain + '<div class="lb-h">过程日志（三侧）</div>' + logs, '', true);
  }

  function fmtTs(d) {
    if (!(d instanceof Date) || isNaN(d)) return '—';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }


  const EF = {
    live:    { label: '即时',   cls: 'ok',   color: 'var(--ef-live)' },
    reload:  { label: 'reload', cls: 'warn', color: 'var(--ef-reload)' },
    restart: { label: '重启',   cls: 'err',  color: 'var(--ef-restart)' },
    client:  { label: '客户配置', cls: 'warn', color: 'var(--st-warn)' }
  };

  /* 客户任务状态：waiting 待客户配置 → done 客户已完成（待我方验收）→ verified 我方已验收 */
  const CSTATE = {
    waiting: { label: '待客户配置', cls: 'warn' },
    done:    { label: '待我方验收', cls: 'info' },
    verified:{ label: '已验收',     cls: 'ok' }
  };

  const APP = {
    view: 'topo',
    timer: null,
    paused: false,
    bindDirty: false,
    bindDraft: {},          /* agentId -> [imei] 本地未保存改动 */
    selPool: new Set(),
    poolPage: 1, poolSize: 25,
    poolSort: { k: 'active_calls', dir: 'desc' },
    poolFilter: { q: '', pool: '', state: '', net: '' },
    callsPage: 1, callsSize: 25,
    callsFilter: { imei: '', carrier: '', from: '', to: '', result: '', dir: '' },
    callsLoading: false,
    callsTimer: null,
    grpFilter: 'ALL',
    selAgent: null,
    wizard: null,
    probeTimer: null,
    inviteIdx: 0,
    stratPoolId: '',
    stratLoading: false
  };

  const CALL_OUTCOME = {
    answered:   { label: '接通',   cls: 'ok' },
    rejected:   { label: '拒接',   cls: 'warn' },
    failed:     { label: '失败',   cls: 'err' },
    unanswered: { label: '未接通', cls: '' }
  };

  /* ════════════════════════════════════════════════════════════ helpers */
  function toast(title, msg, kind, ms) {
    kind = kind || 'info';
    const box = $('#toasts');
    if (!box) { console.log('[toast]', kind, title, msg || ''); return; }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const ico = kind === 'ok' ? 'check-circle' : kind === 'err' ? 'x-circle' : kind === 'warn' ? 'alert' : 'info';
    el.innerHTML = '<span class="ti">' + I(ico, 17) + '</span><div class="tb"><b>' + esc(title) + '</b>' +
      (msg ? '<span>' + esc(msg) + '</span>' : '') + '</div>';
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s, transform .25s'; el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 260); }, ms || 3600);
  }
  /* 兼容旧代码 Toast.ok / Toast.err */
  const Toast = {
    ok: (t, m) => toast(t || '成功', m || '', 'ok'),
    err: (t, m) => toast(typeof t === 'string' && !m ? '操作失败' : (t || '失败'), m || t || '', 'err'),
    warn: (t, m) => toast(t || '注意', m || '', 'warn'),
    info: (t, m) => toast(t || '提示', m || '', 'info')
  };

  function fmtDur(s) {
    if (s == null) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(x);
  }
  function fmtAgo(min) {
    if (min == null) return '—';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.floor(min / 60) + ' 小时前';
    return Math.floor(min / 1440) + ' 天前';
  }
  function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function effBadge(ef) {
    const e = EF[ef];
    return '<span class="tag ' + e.cls + '">' + e.label + '</span>';
  }

  /* ════════════════════════════════════════════════════════════ NAV */
  const VIEW_META = {
    topo:  ['线路总览', '手机 → UFI → dSIPRouter → VOS3000 → 坐席'],
    pool:  ['UFI 通信配置', '池归属 · 选路策略 · 并发上限'],
    calls: ['通话记录', 'IMEI · 运营商组 · 时间 · 结果 · 类型'],
    route: ['号码与路由', '呼入路由自动同步 · 无需手工配置'],
    diag:  ['链路诊断', '分段探针 · INVITE 三值 · 排障速查'],
    pend:  ['变更任务', '我方待办 · 客户指引单'],
    sys:   ['对接参数', 'dSIPRouter / VOS3000 对接快照']
  };

  const Nav = {
    init() {
      $$('#shell .navitem[data-v]').forEach(a => a.addEventListener('click', () => this.go(a.dataset.v)));
      const btnPend = $('#btnPending');
      if (btnPend) btnPend.addEventListener('click', () => this.go('pend'));
      const btnOur = $('#btnOurWork');
      if (btnOur) btnOur.addEventListener('click', () => this.go('pend'));
      /* 嵌入主框架后侧栏外链可能不存在，加空值防护 */
      const navV2 = $('#navToV2');
      if (navV2) navV2.addEventListener('click', () => {
        toast('呼叫中心（二期）未上线', 'IVR / ACD 队列 / 坐席状态由客户 VOS3000 承载，属二期范围', 'info', 4200);
      });
      const navDev = $('#navToDev');
      if (navDev) navDev.addEventListener('click', () => { location.href = '/ufi'; });
      const btnPause = $('#btnPause');
      if (btnPause) btnPause.addEventListener('click', () => this.togglePause());
      const brand = $('#shell .brand');
      if (brand) brand.addEventListener('click', () => { const sh = $('#shell'); if (sh) sh.classList.toggle('collapsed'); });
      const dc = $('#drawerClose'), dm = $('#drawerMask'), mm = $('#modalMask'), mc = $('#modalClose');
      if (dc) dc.addEventListener('click', () => Drawer.close());
      if (dm) dm.addEventListener('click', () => Drawer.close());
      if (mm) mm.addEventListener('click', () => Modal.close());
      if (mc) mc.addEventListener('click', () => Modal.close());
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (Modal.isOpen()) Modal.close(); else Drawer.close(); }
      });
      window.addEventListener('popstate', () => { if (Drawer.isOpen()) Drawer.close(true); });
      this.icons();
      this.go(location.hash.replace('#', '') || 'topo');
    },
    icons() { $$('#shell [data-i], .drawer [data-i], .modal [data-i], .ufi-view-tabs [data-i]').forEach(el => {
      el.innerHTML = I(el.dataset.i, el.closest('.nav-btn,.pill,.btn') ? 14 : 15);
    }); },
    go(v) {
      if (!VIEW_META[v]) v = 'topo';
      APP.view = v;
      $$('#shell .navitem[data-v]').forEach(a => {
        a.classList.toggle('active', a.dataset.v === v);
        a.classList.toggle('is-active', a.dataset.v === v);
      });
      $$('#shell .view').forEach(s => s.classList.toggle('active', s.id === 'v-' + v));
      const ct = $('#crumbTitle'), cs = $('#crumbSub');
      if (ct) ct.textContent = VIEW_META[v][0];
      if (cs) cs.textContent = VIEW_META[v][1];
      if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
      const main = $('#main');
      if (main) main.scrollTop = 0;
      Renderer.render(v);
    },
    togglePause() {
      APP.paused = !APP.paused;
      const txt = $('#txtPause'), ico = $('#icoPause'), btn = $('#btnPause');
      if (txt) txt.textContent = APP.paused ? '继续' : '暂停';
      if (ico) ico.innerHTML = I(APP.paused ? 'play' : 'pause', 14);
      if (btn) btn.classList.toggle('primary', APP.paused);
      toast(APP.paused ? '已暂停实时刷新' : '已恢复实时刷新', APP.paused ? '数据不再自动更新' : '每 3 秒刷新一次', 'info', 2000);
    }
  };

  /* ════════════════════════════════════════════════════════════ MODAL */
  const Modal = {
    onClose: null,
    onOk: null,
    _busy: false,
    open(title, body, foot, wide) {
      this.onOk = null;
      this.onClose = null;
      this._busy = false;
      $('#modalTitle').textContent = title;
      $('#modalBody').innerHTML = body;
      $('#modalFoot').innerHTML = foot || '';
      $('#modal').classList.toggle('wide', !!wide);
      $('#modalMask').classList.add('on');
      $('#modal').classList.add('on');
      this.bind();
    },
    bind() {
      /* 每次 open 重绑：先克隆脚注按钮去掉旧监听，避免重复触发 */
      const foot = $('#modalFoot');
      if (foot) {
        $$('#modalFoot [data-mact]').forEach(b => {
          const nb = b.cloneNode(true);
          b.parentNode.replaceChild(nb, b);
        });
      }
      $$('#modalFoot [data-mact]').forEach(b => b.addEventListener('click', e => {
        e.preventDefault();
        const a = b.dataset.mact;
        if (a === 'close') return this.close();
        if (a === 'ok') return this._runOk(b);
      }));
      $$('#modalBody [data-mact]').forEach(b => b.addEventListener('click', e => {
        e.preventDefault();
        if (b.dataset.mact === 'close') this.close();
        else if (b.dataset.mact === 'ok') this._runOk(b);
      }));
    },
    async _runOk(btn) {
      if (this._busy) return;
      if (!this.onOk) { this.close(); return; }
      this._busy = true;
      if (btn) { btn.disabled = true; btn.dataset._old = btn.textContent; btn.textContent = '处理中…'; }
      try {
        const ok = await this.onOk();
        if (ok !== false) this.close();
      } catch (ex) {
        toast('操作失败', String(ex.message || ex), 'err');
      }
      this._busy = false;
      if (btn && document.body.contains(btn)) {
        btn.disabled = false;
        if (btn.dataset._old) btn.textContent = btn.dataset._old;
      }
    },
    close() {
      $('#modalMask').classList.remove('on');
      $('#modal').classList.remove('on');
      this.onOk = null;
      this._busy = false;
      if (this.onClose) { const f = this.onClose; this.onClose = null; f(); }
    },
    isOpen() { const m = $('#modal'); return !!(m && m.classList.contains('on')); }
  };

  /* ════════════════════════════════════════════════════════════ DRAWER */
  const Drawer = {
    cur: null, tab: null, key: null,
    open(imei) {
      this.cur = imei;
      const u = DB.ufiByImei(imei);
      if (!u) return;
      $('#drawerTitle').innerHTML = I('sim', 17) + ' UFI ' + esc(imei);
      $('#drawerSub').textContent = (u.model + ' · SIM ' + u.sim + ' · ' + (u.vendor || '') + ' · 池 ' + u.pool_id);
      this.key = 'ufi:' + imei;
      this.setTab('spec');
      $('#drawerMask').classList.add('on');
      $('#drawer').classList.add('on');
      $('#drawer').setAttribute('aria-hidden', 'false');
      history.pushState({ drawer: this.key }, '');
    },
    setTab(t) {
      this.tab = t;
      const u = DB.ufiByImei(this.cur);
      const tabs = [['spec', '规格', 'info'], ['bind', '引用', 'link'], ['route', '路由', 'route'], ['log', '日志', 'terminal'], ['cmd', '指令', 'bolt']];
      let html = '<div class="tabs">' + tabs.map(x =>
        '<button data-tab="' + x[0] + '" class="' + (t === x[0] ? 'on' : '') + '">' + I(x[2], 14) + x[1] +
        (x[0] === 'bind' ? '<span class="cnt">' + DB.referrers(u.imei).length + '</span>' : '') + '</button>').join('') + '</div>';
      html += '<div style="padding:16px">' + this.body(u, t) + '</div>';
      $('#drawerBody').innerHTML = html;
      $$('#drawerBody [data-tab]').forEach(b => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
      $$('#drawerBody [data-rowact]').forEach(b => b.addEventListener('click', () => this.rowAct(b.dataset.rowact, u)));

      const btns = [['复制 IMEI', 'copy'], ['停用入池', 'disable'], ['加入待生效', 'pend']];
      $('#drawerFoot').innerHTML =
        btns.map(x => '<button class="btn' + (x[1] === 'pend' ? ' primary' : '') + '" data-foot="' + x[1] + '">' + esc(x[0]) + '</button>').join('') +
        '<span class="sp"></span><button class="btn ghost" data-foot="close">关闭</button>';
      $$('#drawerFoot [data-foot]').forEach(b => b.addEventListener('click', () => this.footAct(b.dataset.foot, u)));
    },
    body(u, t) {
      const refs = DB.referrers(u.imei);
      if (t === 'spec') {
        /* 设备属性：只读，全部来自 UFI 管理模块台账 */
        const devRows = [
          ['IMEI（注册名）', u.imei],
          ['SN', u.sn],
          ['SIM 号码', u.sim + (u.simRaw && u.simRaw !== '+86' + u.sim ? '（台账 ' + u.simRaw + '）' : '')],
          ['IMSI', u.imsi],
          ['SIM 状态', u.simState],
          ['型号 / 版本', u.model],
          ['固件', u.fw],
          ['网络类型', u.net + '（' + u.networkPath + '）'],
          ['频段 / EARFCN', u.band + ' / ' + u.earfcn],
          ['RSRP / RSRQ', u.rsrp + ' dBm / ' + u.rsrq + ' dB'],
          ['信号格', '▮'.repeat(u.signal) + '▯'.repeat(4 - u.signal)],
          ['VoLTE 注册', u.volte ? '已注册' : '未注册'],
          ['SIP 注册', u.registered ? '已注册（' + u.sipStatus + '）' : '未注册（' + u.sipStatus + '）'],
          ['健康分', u.health + '　' + (u.issues || []).join('、')],
          ['CPU / 内存 / 存储', u.cpu + '% / ' + u.mem + '% / ' + u.storage + '%'],
          ['最近上报', u.lastSeen || '—']
        ];
        /* 通信属性：本模块维护 */
        const commRows = [
          ['所属池', u.pool_id],
          ['运营商组（落地 VOS）', (DB.carrierLabel && DB.carrierLabel(u.carrier)) || u.carrier || '100'],
          ['启用 / 在池', (u.enabled ? '启用' : '停用') + ' / ' + (u.in_pool ? '在池' : '不在池')],
          ['选路权重', u.weight],
          ['并发上限', u.max_concurrent || '不限'],
          ['当前并发', u.active_calls],
          ['最近使用', fmtAgo(u.last_used_min)],
          ['今日呼叫 / 接通率', u.calls_today + ' / ' + (u.asr_today == null ? '—' : u.asr_today + '%')],
          ['被引用', DB.referrers(u.imei).length + ' 处（坐席 / 班组）']
        ];
        return '<div class="note plain" style="margin-bottom:12px"><span class="ni">' + I('key', 15) + '</span><div class="nb"><b>UFI SIP 方言</b>注册名 = IMEI；密码 = md5(IMEI)[:16] 不展示；桥接 INVITE 的 R-URI = IMEI，X-VOLTE = 真实号码。改号码或注册参数请到 UFI 管理模块。</div></div>' +
          (u.unmanaged ? '<div class="note warn" style="margin-bottom:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>该设备尚未纳管</b>它来自存量快照（文档 §5.3），设备属性无法自动同步。请先在 UFI 管理模块中纳管，此后信号、频段、注册状态与健康分将自动接入，本模块只需维护通信属性。</div></div>' : '') +
          '<h4 class="dev-sec"><span class="tag ok">设备</span>属性 · 只读，来源 UFI 管理模块</h4>' +
          (u.unmanaged
            ? '<div class="empty" style="padding:18px;font-size:12px">' + I('sim', 26) +
              '该设备未纳管，暂无设备属性。纳管后此处自动显示信号、频段、注册状态与健康分。</div>'
            : '<dl class="spec">' + devRows.map(r => '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>') +
          (!u.unmanaged && !u.sim ? '<div style="margin:-2px 0 10px;color:var(--tx-3);font-size:12px">设备未上报号码时，可在「UFI 设备 → 设备设置」中手动填写 SIM 号码。</div>' : '') +
          '<h4 class="dev-sec"><span class="tag warn">通信</span>属性 · 本模块可配置</h4>' +
          '<dl class="spec">' + commRows.map(r => '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>';
      }
      if (t === 'bind') {
        if (!refs.length) return '<div class="empty">' + I('link', 34) + '该线路未被任何坐席或班组引用</div>';
        return '<table class="grid"><thead><tr><th>类型</th><th>名称</th><th>所属班组</th></tr></thead><tbody>' +
          refs.map(r => '<tr><td><span class="tag ' + (r.kind === 'agent' ? 'info' : 'purple') + '">' + (r.kind === 'agent' ? '坐席' : '班组') + '</span></td><td>' + esc(r.name) + '</td><td>' + esc(r.group) + '</td></tr>').join('') +
          '</tbody></table>' +
          '<div class="note warn" style="margin-top:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>共享提醒</b>被多个坐席引用时，实际并发受 <code>max_concurrent=' + (u.max_concurrent || '不限') + '</code> 限制，满载时选路会自动跳下一台。</div></div>';
      }
      if (t === 'route') {
        const dids = DB.DID_ROUTES.filter(d => d.imei === u.imei);
        const rule = DB.OUT_RULES.filter(r => r.pool === u.pool_id);
        return '<h4 style="font-size:12px;color:var(--tx-3);margin-bottom:6px">呼入映射（dbaliases + Dids）</h4>' +
          (dids.length ? '<table class="grid"><thead><tr><th>被叫号码</th><th>类型</th><th>落地</th></tr></thead><tbody>' +
            dids.map(d => '<tr><td class="mono">' + esc(d.did) + '</td><td><span class="tag">' + d.kind + '</span></td><td>' + esc(d.target) + '</td></tr>').join('') + '</tbody></table>'
            : '<div class="empty" style="padding:20px">无呼入映射</div>') +
          '<h4 style="font-size:12px;color:var(--tx-3);margin:16px 0 6px">呼出规则（使用 ' + u.pool_id + '）</h4>' +
          (rule.length ? '<table class="grid"><thead><tr><th>规则</th><th>号段</th><th>重试</th></tr></thead><tbody>' +
            rule.map(r => '<tr><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.prefix) + '</td><td class="mono">' + r.max_try + ' 次 / ' + r.retry_gap_s + 's</td></tr>').join('') + '</tbody></table>'
            : '<div class="empty" style="padding:20px">无呼出规则</div>');
      }
      if (t === 'log') {
        const lines = this.fakeLog(u);
        return '<div class="note plain" style="margin-bottom:10px"><span class="ni">' + I('info', 15) + '</span><div class="nb"><b>选路示意</b>以下为该线路在链路中的信令位置示意；真实呼叫明细见设备管理模块「通话与短信」（含 volte / sip / route 三侧日志）。</div></div>' +
          '<div class="step-log">' + lines.map(l => '<span class="' + l[1] + '">' + esc(l[0]) + '</span>').join('') + '</div>';
      }
      /* cmd */
      const cmds = [
        ['reboot', '重启设备', '无参数'], ['restart_linphone', '重启 LinPhone 软电话', '无参数'],
        ['wifi_on', '开启 Wi-Fi', 'ssid / passwd'], ['wifi_off', '关闭 Wi-Fi', '无参数'],
        ['wificall', '发起 Wi-Fi 语音', 'number'],
        ['sim_verify_pin', '校验 SIM PIN', 'pin'], ['sim_set_pin', '设置 SIM PIN', 'pin,new_pin'],
        ['sim_verify_puk', '校验 SIM PUK', 'puk,new_pin']
      ];
      return '<div class="note plain" style="margin-bottom:12px"><span class="ni">' + I('terminal', 15) + '</span><div class="nb"><b>下发路径</b>GUI 调 <code>Ufi-Get-Cmd-Request</code>，设备 WebSocket 回执。参数按文档 §7 表格逐项填写。</div></div>' +
        '<div class="grid2">' + cmds.map(c =>
          '<button class="btn" data-rowact="cmd" data-cmd="' + c[0] + '" style="height:auto;padding:10px 12px;justify-content:flex-start;text-align:left">' +
          '<span style="flex:1"><b style="display:block;font-size:12px">' + esc(c[1]) + '</b><span class="mono" style="color:var(--tx-3);font-size:11px">' + c[0] + ' · ' + c[2] + '</span></span>' + I('send', 14) + '</button>').join('') + '</div>';
    },
    fakeLog(u) {
      const L = [];
      L.push(['# kamcmd ul dump | grep ' + u.imei, 'cmd']);
      L.push(['<sip:' + u.imei + '@106.75.29.22>; expires=' + (u.registered ? 2400 - Math.floor(Math.random() * 600) : 0), u.registered ? 'ok' : 'er']);
      if (u.registered) {
        L.push(['  Contact: <sip:' + u.imei + '@10.x.x.x:5060;transport=udp>', 'dim']);
        L.push(['  call-id: ' + Math.random().toString(16).slice(2, 10), 'dim']);
      }
      L.push(['[xvolte] INVITE ruri=' + u.imei + ' X-VOLTE=' + u.sim + ' from=0' + u.sim, u.volte ? 'ok' : 'wr']);
      L.push(['[pool] selected=' + u.imei + ' pool=' + (u.pool_id || '—') + ' active=' + u.active_calls + '/' + (u.max_concurrent || '∞'), 'dim']);
      L.push(['[cdr] 8.136.109.38 <- 106.75.29.22  200 OK  dur=' + (20 + Math.floor(Math.random() * 300)) + 's', 'ok']);
      L.push(['[acc] src_user=<NULL>  ← 已知待修：需先补齐 acc 表 src_user 列', 'wr']);
      return L;
    },
    rowAct(a, u) {
      if (a === 'cmd') {
        /* 一期不做指令通道重复建设：设备管理模块已有完整指令下发（WebSocket 回执） */
        toast('请到设备管理模块下发', '通信管理模块暂不重复建设指令通道：/ufi → 指令与日志', 'warn', 4200);
      }
    },
    footAct(a, u) {
      if (a === 'close') return this.close();
      if (a === 'copy') { navigator.clipboard && navigator.clipboard.writeText(u.imei); toast('已复制 IMEI', u.imei, 'ok', 1800); return; }
      if (a === 'disable') {
        /* 通信属性真实落库（dsip_ufi_pool）：停用并退出轮询池，呼入不受影响 */
        DB.bulkComm('disable', [u.imei]).then(() => {
          toast('已停用并退出轮询池', u.imei + '（已写入 dsip_ufi_pool，呼入不受影响）', 'ok');
          Drawer.setTab(Drawer.tab); Pool.render();
        }).catch(e => toast('停用失败', String(e.message || e), 'err'));
        return;
      }
      if (a === 'pend') {
        DB.addPending({ ef: 'restart', sys: 'dSIPRouter', title: '线路配置复核：' + u.imei, target: 'ufi_pool', detail: 'weight=' + u.weight + ' max_concurrent=' + u.max_concurrent });
        toast('已加入待生效变更', '通信属性已在 GUI 落库；选路策略类变更需 cfg 配合（sqlops 迁移后零重启）', 'info');
        Nav.go('pend');
      }
    },
    close(fromPop) {
      if (!$('#drawer').classList.contains('on')) return;
      $('#drawerMask').classList.remove('on');
      $('#drawer').classList.remove('on');
      $('#drawer').setAttribute('aria-hidden', 'true');
      this.cur = null;
      const si = $('#poolSearch');
      if (si) { si.value = ''; APP.poolFilter.q = ''; APP.poolPage = 1; }
      ImeiPick.close();
      if (!fromPop && history.state && history.state.drawer) history.back();
    },
    isOpen() { const d = $('#drawer'); return !!(d && d.classList.contains('on')); }
  };

  /* ── 抽屉里假造注册剩余时间 ── */
  function ri_hold() { return (1200 + Math.floor(Math.random() * 1200)) + ' s'; }

  /* ════════════════════════════════════════════════════════════ POOL VIEW */
  /* 列定义：src=dev 的列来自 UFI 管理模块（只读）；src=comm 的列由通信模块维护 */
  const POOL_COLS = [
    { k: 'imei', t: 'IMEI（注册名）', w: '150px', src: 'dev' },
    { k: 'sim', t: 'SIM', w: '112px', src: 'dev' },
    { k: 'model', t: '型号', w: '118px', src: 'dev' },
    { k: 'net', t: '网络', w: '76px', src: 'dev' },
    { k: 'band', t: '频段', w: '88px', src: 'dev' },
    { k: 'signal', t: '信号', w: '78px', src: 'dev' },
    { k: 'state', t: '在线/注册', w: '124px', src: 'dev' },
    { k: 'health', t: '健康', w: '76px', src: 'dev' },
    { k: 'pool_id', t: '池', w: '56px', src: 'comm' },
    { k: 'carrier', t: 'VOS', w: '64px', src: 'comm' },
    { k: 'weight', t: '权重', w: '56px', num: true, src: 'comm' },
    { k: 'max_concurrent', t: '并发上限', w: '84px', num: true, src: 'comm' },
    { k: 'active_calls', t: '当前并发', w: '94px', num: true, src: 'comm' },
    { k: 'last_used_min', t: '最近使用', w: '96px', src: 'comm' },
    { k: 'enabled', t: '启用', w: '60px', src: 'comm' },
    { k: 'in_pool', t: '在池', w: '60px', src: 'comm' }
  ];

  /* ════════════════════════════════════════════════════════════ IMEI 检索选择器
     通信模块与设备台账的唯一入口：模糊过滤 IMEI / SIM / 型号 / SN / 频段，
     选中即定位到该设备的通信配置。设备属性只读，通信属性可写。
  ════════════════════════════════════════════════════════════ */
  const ImeiPick = {
    hl: 0, opts: [],
    init() {
      const inp = $('#poolSearch'), wrap = $('#imeiPick'), drop = $('#imeiDrop');
      if (!inp) return;
      inp.addEventListener('focus', () => { this.open(inp.value); });
      inp.addEventListener('input', () => { APP.poolPage = 1; this.open(inp.value); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          /* 回车 = 把当前输入作为模糊过滤条件应用到表格；
             打开该设备详情请用 ↓ 选中候选项后点击，或直接点表格行 */
          this.commitFilter(inp.value);
        } else if (e.key === 'Escape') { this.close(); }
      });
      drop.addEventListener('click', e => {
        const o = e.target.closest('[data-imei]');
        if (o) this.choose(o.dataset.imei);
      });
      document.addEventListener('click', e => {
        if (!e.target.closest('#imeiPick')) this.close();
      });
    },
    open(kw) {
      const wrap = $('#imeiPick'), drop = $('#imeiDrop');
      if (!wrap) return;
      this.opts = DB.search(kw, 24);
      this.hl = 0;
      if (!this.opts.length) {
        drop.innerHTML = '<div class="idp-hint">未匹配到设备。设备台账来自 UFI 管理模块，确认设备已纳管后再配置通信。</div>';
      } else {
        drop.innerHTML = this.opts.map((u, i) => {
          const sev = u.severity === 'ok' ? 'ok' : u.severity === 'warn' ? 'warn' : 'err';
          const reg = u.registered ? '<span class="tag ok">已注册</span>' : '<span class="tag err">未注册</span>';
          return '<div class="imei-opt' + (i === 0 ? ' hl' : '') + '" data-imei="' + u.imei + '">' +
            '<span class="io-imei">' + hl(u.imei, kw) + '</span>' +
            '<span class="io-meta">' + hl(u.sim || '—', kw) + ' · ' + esc(u.net) + ' · ' + esc(u.band) + '</span>' +
            '<span class="io-right"><span class="sdot ' + sev + '"></span>' + reg +
            '<span class="tag mono">' + u.pool_id + '</span></span></div>';
        }).join('') +
        '<div class="idp-hint" style="border-top:1px solid var(--line)">点击某行 = 打开该设备的通信配置详情　·　回车 = 把当前输入作为过滤条件</div>';
      }
      wrap.classList.add('on');
    },
    move(d) {
      if (!this.opts.length) return;
      this.hl = Math.max(0, Math.min(this.opts.length - 1, this.hl + d));
      $$('#imeiDrop .imei-opt').forEach((el, i) => el.classList.toggle('hl', i === this.hl));
    },
    close() { const w = $('#imeiPick'); if (w) w.classList.remove('on'); },
    /* 选中某设备：直接打开其通信配置抽屉 */
    choose(imei) {
      this.close();
      $('#poolSearch').value = imei;
      Drawer.open(imei);
    },
    /* 回车且无候选项：作为模糊过滤条件应用到表格 */
    commitFilter(kw) {
      this.close();
      APP.poolFilter.q = String(kw || '').trim();
      APP.poolPage = 1;
      Pool.render();
      if (!APP.poolFilter.q) return;
      const n = Pool.rows().length;
      toast(n ? '按「' + APP.poolFilter.q + '」匹配到 ' + n + ' 台' : '未匹配到设备',
        n ? '模糊匹配 IMEI / SIM / 型号 / SN' : '试试更短的片段，或确认设备已纳管', n ? 'ok' : 'warn', 2800);
    }
  };
  /* 关键词高亮（纯 IMEI/SIM 数字串场景，做轻量标记） */
  function hl(text, kw) {
    const t = esc(text == null ? '' : text);
    const q = String(kw || '').trim();
    if (!q || q.length < 2) return t;
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return t;
    return t.slice(0, i) + '<mark>' + t.slice(i, i + q.length) + '</mark>' + t.slice(i + q.length);
  }

  const Pool = {
    cur: 'P1',
    init() {
      ImeiPick.init();
      ['#poolFilterPool', '#poolFilterState', '#poolFilterNet'].forEach(s =>
        $(s).addEventListener('change', e => { APP.poolFilter[s.replace('#poolFilter', '').toLowerCase()] = e.target.value; APP.poolPage = 1; this.render(); }));
      $('#poolSub').addEventListener('click', e => {
        const th = e.target.closest('th');
        if (!th || !th.dataset.k) return;
        const k = th.dataset.k;
        APP.poolSort = APP.poolSort.k === k ? { k, dir: APP.poolSort.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: 'asc' };
        this.render();
      });
      bindListCopyHelpers('#poolBody');
      $('#poolBody').addEventListener('click', e => {
        const cb = e.target.closest('input[type=checkbox]');
        if (cb) {
          const imei = cb.dataset.imei;
          if (cb.checked) APP.selPool.add(imei); else APP.selPool.delete(imei);
          this.bulk();
          return;
        }
        if (e.target.closest('button,a,label')) return;
        if (shouldSkipRowNav(e)) return;
        const tr = e.target.closest('tr[data-imei]');
        if (tr) Drawer.open(tr.dataset.imei);
      });
      $$('[data-bulk]').forEach(b => b.addEventListener('click', () => this.bulkAct(b.dataset.bulk)));
      this.renderReal();
    },
    renderReal() {
      const ufis = DB.ufis;
      const tag = $('#routeRealTag');
      const rt = DB.routes;
      if (tag) {
        tag.textContent = rt ? (rt.consistent ? '路由同步一致' : '路由有差异 → 去「号码与路由」同步') : '同步状态未加载';
        tag.className = 'tag ' + (rt ? (rt.consistent ? 'ok' : 'warn') : '');
      }
      const byCarrier = {};
      ufis.forEach(u => { const c = String(u.carrier || '100'); byCarrier[c] = (byCarrier[c] || 0) + 1; });
      const cname = gwid => { const c = (DB.carriers || []).find(x => String(x.gwid) === String(gwid)); return c ? (c.name || c.address) : 'gwid ' + gwid; };
      const card = (k) =>
        '<div class="panel" style="margin:0"><div class="panel-head"><h3><span data-i="pool"></span>' + esc(cname(k)) + '</h3></div>' +
        '<div class="panel-body"><div style="font-size:22px;font-weight:700">' + byCarrier[k] + '</div><span style="color:var(--tx-3)">台设备 · gwlist=' + k + '</span></div></div>';
      const carrierHtml = Object.keys(byCarrier).map(card).join('') || '<span style="color:var(--tx-3)">暂无设备</span>';
      const inPool = ufis.filter(u => u.in_pool && u.enabled);
      const conc = ufis.reduce((a, u) => a + u.active_calls, 0);
      const cap = ufis.reduce((a, u) => a + (u.max_concurrent || 0), 0);
      const weights = inPool.map(u => u.weight || 1);
      const stratHtmlReady = !!DB.poolStrat;
      $('#routeReal').innerHTML =
        '<div class="grid3">' + carrierHtml + '</div>' +
        '<div class="grid2" style="margin-top:14px">' +
        '<dl class="spec">' +
        '<dt>在池设备</dt><dd>' + inPool.length + ' / ' + ufis.length + '</dd>' +
        '<dt>当前并发 / 容量上限</dt><dd>' + conc + ' / ' + (cap || '—') + '</dd>' +
        '<dt>权重分布</dt><dd>' + (weights.length ? esc(weights.join(' / ')) : '—') + '</dd>' +
        '</dl>' +
        '<dl class="spec">' +
        '<dt>呼入路由</dt><dd class="plain">dr_rules 8000：prefix=IMEI → gwlist=运营商组</dd>' +
        '<dt>DID 映射</dt><dd class="plain">dr_rules 9000：prefix=SIM → 同上（' + DB.DID_ROUTES.length + ' 条）</dd>' +
        '<dt>SIP 账号</dt><dd class="plain">subscriber：用户名=IMEI，密码=md5(IMEI)[:16]（' + ufis.length + ' 户）</dd>' +
        '</dl>' +
        '</div>' +
        (stratHtmlReady ? this.stratHtml() : '');
      if (stratHtmlReady) this.bindStrat();
      else if (!APP.stratLoading) {
        /* 防重入：用模块级 APP 标记（this 在多种调用链下不可靠），避免策略接口并发风暴 */
        APP.stratLoading = true;
        DB.loadPoolStrat()
          .catch(() => {})
          .then(() => { APP.stratLoading = false; if (APP.view === 'pool') this.renderReal(); });
      }
    },
    stratHtml() {
      const ps = DB.poolStrat;
      const pools = (ps && ps.pools) || [];
      const labels = (ps && ps.labels) || { round_robin: '严格轮询', failover: '主备故障转移', least_load: '负载均衡' };
      const desc = { round_robin: '按成员顺序轮转分配（严格轮询）', failover: '固定权重顺序，第一台可用优先，故障才切换（主备）', least_load: '优先分配当前并发最低的在线台（负载均衡）' };
      if (!pools.length) {
        return '<div class="panel" style="margin-top:14px"><div class="panel-head"><h3>号码池列表</h3>' +
          '<button class="btn sm primary" id="btnPoolNew" style="margin-left:auto">＋ 新建号码池</button></div>' +
          '<div class="panel-body"><span style="color:var(--tx-3)">暂无号码池，请先新建</span></div></div>';
      }
      const curId = APP.stratPoolId && pools.some(p => p.pool_id === APP.stratPoolId) ? APP.stratPoolId : pools[0].pool_id;
      APP.stratPoolId = curId;
      const p0 = pools.find(p => p.pool_id === curId) || pools[0];
      const opts = Object.keys(labels).map(k =>
        '<option value="' + k + '"' + (p0.strategy === k ? ' selected' : '') + '>' + labels[k] + '</option>').join('');
      const rows = pools.map(p => {
        const online = (p.members || []).filter(m => m.online && m.in_pool && m.enabled).length;
        const dids = (p.dids || []).length ? p.dids.join(', ') : '—';
        const on = p.pool_id === curId ? ' sel' : '';
        const primary = p.pool_id === 'P1' ? ' <span class="tag accent">主池</span>' : '';
        const vosTag = (p.default_vos && p.default_vos.length)
          ? ' <span class="tag ok">VOS ' + esc(p.default_vos.join('/')) + ' 任意</span>' : '';
        const defTag = p.is_default ? ' <span class="tag accent">全局兜底</span>' : '';
        return '<tr class="pool-row' + on + '" data-pool="' + esc(p.pool_id) + '" tabindex="0">' +
          '<td><b class="mono">' + esc(p.pool_id) + '</b>' + primary + vosTag + defTag + '</td>' +
          '<td><span class="tag info">' + esc(p.strategy_label || labels[p.strategy] || p.strategy) + '</span></td>' +
          '<td class="mono">' + (p.active || 0) + ' / ' + (p.total || 0) + '</td>' +
          '<td class="mono">' + online + '</td>' +
          '<td class="mono">' + (p.conc || 0) + ' / ' + (p.cap || 0) + '</td>' +
          '<td class="mono pool-dids" title="' + esc(dids) + '">' + esc(dids) + '</td>' +
          '</tr>';
      }).join('');
      const dids0 = (p0.dids || []).join(', ') || '—';
      return '<div class="panel" style="margin-top:14px" id="poolListPanel">' +
        '<div class="panel-head"><h3>号码池列表</h3>' +
        '<span class="hint">共 ' + pools.length + ' 个池 · 点击一行选中，下方可改策略 / 触发号</span>' +
        '<span class="tag ok" id="poolStratTag">' + esc(p0.strategy_label || labels[p0.strategy] || p0.strategy) + '</span>' +
        '<button class="btn sm primary" id="btnPoolNew" style="margin-left:auto">＋ 新建号码池</button></div>' +
        '<div class="panel-body">' +
        '<div class="tblwrap pool-list-wrap"><table class="grid pool-list" id="poolListTable">' +
        '<thead><tr><th>池 ID</th><th>选路策略</th><th>在池 / 成员</th><th>在线</th><th>并发 / 容量</th><th>外呼触发号（池 DID）</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<div class="pool-strat-edit" id="poolStratEdit">' +
        '<div class="pse-title">编辑选中池 · <b class="mono" id="selStratPoolLabel">' + esc(p0.pool_id) + '</b>' +
        '<input type="hidden" id="selStratPool" value="' + esc(p0.pool_id) + '"></div>' +
        '<div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<label>策略 <select id="selStrat" style="width:auto">' + opts + '</select></label>' +
        '<button class="btn primary" id="btnStratSave" style="flex:0 0 auto;width:auto">保存策略</button>' +
        '<button class="btn" id="btnPoolDids" style="flex:0 0 auto;width:auto">编辑触发号 / 任意被叫</button>' +
        '<button class="btn" id="btnPoolDel" style="flex:0 0 auto;width:auto' + (p0.pool_id === 'P1' ? ';display:none' : '') + '">删除此池</button>' +
        '<button class="btn ghost" id="btnPoolFilterDev" style="flex:0 0 auto;width:auto">查看该池设备</button>' +
        '</div>' +
        '<p id="stratDesc" style="color:var(--tx-3);margin:8px 0 0">' + esc(desc[p0.strategy] || '') +
        '；外呼触发号：' + esc(dids0) +
        ((p0.default_vos && p0.default_vos.length) ? '；任意被叫←VOS ' + esc(p0.default_vos.join(', ')) : '') +
        (p0.is_default ? '；全局兜底' : '') + '</p>' +
        '<p style="color:var(--tx-3);margin:4px 0 0">多 VOS：每个对接网关（gwid）可绑定一个「任意被叫」池；来自该 VOS 的长号外呼进对应池。触发号仍是精确 R-URI 匹配。</p>' +
        '</div></div></div>';
    },

    isEditingStrat() {
      const ae = document.activeElement;
      if (!ae || !ae.closest) return false;
      return !!(ae.closest('#poolListPanel') || ae.closest('#selStrat') || ae.closest('#btnStratSave') ||
        ae.closest('#btnPoolNew') || ae.closest('#btnPoolDel') || ae.closest('#btnPoolDids') ||
        ae.id === 'inpNewPool' || ae.id === 'inpNewPoolDid' || ae.id === 'inpEditPoolDid');
    },
    selectPool(poolId, opts) {
      opts = opts || {};
      const ps = DB.poolStrat;
      const pools = (ps && ps.pools) || [];
      const p = pools.find(x => x.pool_id === poolId);
      if (!p) return;
      APP.stratPoolId = poolId;
      const hid = $('#selStratPool');
      const lab = $('#selStratPoolLabel');
      const selStrat = $('#selStrat');
      const labels = (ps && ps.labels) || {};
      const desc = { round_robin: '按成员顺序轮转分配（严格轮询）', failover: '固定权重顺序，第一台可用优先，故障才切换（主备）', least_load: '优先分配当前并发最低的在线台（负载均衡）' };
      if (hid) hid.value = poolId;
      if (lab) lab.textContent = poolId;
      if (selStrat) selStrat.value = p.strategy;
      $$('#poolListTable tr.pool-row').forEach(tr => tr.classList.toggle('sel', tr.dataset.pool === poolId));
      const el = $('#stratDesc');
      const tag = $('#poolStratTag');
      if (el) el.textContent = (desc[p.strategy] || '') + '；外呼触发号：' + ((p.dids && p.dids.length) ? p.dids.join(', ') : '—') +
        ((p.default_vos && p.default_vos.length) ? '；任意被叫←VOS ' + p.default_vos.join(', ') : '') +
        (p.is_default ? '；全局兜底' : '');
      if (tag) tag.textContent = p.strategy_label || labels[p.strategy] || p.strategy;
      const btnDel = $('#btnPoolDel');
      if (btnDel) btnDel.style.display = poolId === 'P1' ? 'none' : '';
      if (opts.filterDev) {
        APP.poolFilter.pool = poolId;
        this.syncPoolFilterOptions();
        const sel = $('#poolFilterPool');
        if (sel) sel.value = poolId;
        APP.poolPage = 1;
        this.render();
      }
    },
    poolEditDids() {
      const poolId = (($('#selStratPool') || {}).value || APP.stratPoolId || 'P1');
      const ps = DB.poolStrat || {};
      const p = ((ps.pools) || []).find(x => x.pool_id === poolId) || { dids: [], is_default: false, default_vos: [] };
      const carriers = (ps.carriers && ps.carriers.length) ? ps.carriers
        : (DB.carriers || [{ gwid: '100', name: 'VOS3000', address: '' }]);
      const owned = new Set((p.default_vos || []).map(String));
      const vosChecks = carriers.map(c => {
        const id = 'chkVos' + c.gwid;
        return '<label style="display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer">' +
          '<input type="checkbox" class="chkVosDefault" id="' + id + '" data-gwid="' + esc(c.gwid) + '"' +
          (owned.has(String(c.gwid)) ? ' checked' : '') + '>' +
          '<span><b>' + esc(c.name || ('VOS#' + c.gwid)) + '</b> <span class="mono" style="color:var(--tx-3)">gwid=' +
          esc(c.gwid) + (c.address ? ' · ' + esc(c.address) : '') + '</span></span></label>';
      }).join('') || '<span style="color:var(--tx-3)">暂无 type=8 运营商网关（请先在运营商组添加 VOS）</span>';
      const self = this;
      Modal.open('编辑触发号 / 任意被叫 · ' + poolId,
        '<div class="field"><label>外呼触发号（池 DID，逗号分隔）</label>' +
          '<input class="inp" id="inpEditPoolDid" style="width:100%" value="' + esc((p.dids || []).join(', ')) + '" placeholder="如 18960700521；清空则删除全部触发号">' +
          '<p style="color:var(--tx-3);font-size:12px;margin:4px 0 0">保存时按输入框内容整表覆盖（可增可删；留空=清空本池触发号）。</p></div>' +
        '<div style="margin-top:14px"><b>任意被叫 ← 对接 VOS</b>' +
          '<p style="color:var(--tx-3);font-size:12px;margin:4px 0 8px">勾选后，该 VOS 通配打来的任意长号进本池。每个 VOS 只能绑一个池；多 VOS 可分别绑不同池。</p>' +
          vosChecks + '</div>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;cursor:pointer">' +
          '<input type="checkbox" id="chkPoolDefault"' + (p.is_default ? ' checked' : '') + ' style="margin-top:3px">' +
          '<span><b>全局兜底</b>（源 IP 未识别到 VOS 时）<br><span style="color:var(--tx-3);font-size:12px">' +
          '一般不必勾；优先用上方按 VOS 绑定。</span></span></label>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">保存</button>');
      Modal.onOk = async () => {
        const raw = (($('#inpEditPoolDid') || {}).value || '').trim();
        const dids = raw ? raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean) : [];
        const def = !!(($('#chkPoolDefault') || {}).checked);
        const defaultVos = $$('.chkVosDefault').filter(el => el.checked).map(el => el.dataset.gwid);
        const r = await DB.savePoolDids(poolId, dids, { isDefault: def, defaultVos });
        if (!(r && r.ok)) {
          toast('保存失败', (r && r.json && r.json.msg) || (r && r.msg) || '请重试', 'err');
          return false;
        }
        toast('已覆盖保存', '触发号 ' + (dids.length ? dids.join(', ') : '（已清空）') +
          (defaultVos.length ? ' · VOS ' + defaultVos.join('/') + ' 任意' : ''), 'ok');
        try { await DB.loadPoolStrat(); } catch (e) { /* ignore */ }
        self.renderReal();
        return true;
      };
    },
    syncPoolFilterOptions() {
      const sel = $('#poolFilterPool');
      if (!sel) return;
      const cur = sel.value;
      const pools = ((DB.poolStrat && DB.poolStrat.pools) || []).map(p => p.pool_id);
      const fromDev = [...new Set(DB.ufis.map(u => u.pool_id).filter(Boolean))];
      const ids = [...new Set(['P1'].concat(pools, fromDev))].filter(id => id && id !== '—');
      sel.innerHTML = '<option value="">全部池</option>' +
        ids.map(id => '<option value="' + esc(id) + '">' + esc(id) + (id === 'P1' ? ' 主用池' : '') + '</option>').join('') +
        '<option value="—">未入池</option>';
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    },
    bindStrat() {
      const selStrat = $('#selStrat');
      const ps = DB.poolStrat;
      const labels = (ps && ps.labels) || {};
      const desc = { round_robin: '按成员顺序轮转分配（严格轮询）', failover: '固定权重顺序，第一台可用优先，故障才切换（主备）', least_load: '优先分配当前并发最低的在线台（负载均衡）' };
      const getPoolId = () => (($('#selStratPool') || {}).value || APP.stratPoolId || 'P1');
      this.syncPoolFilterOptions();
      const refreshDesc = () => {
        if (!selStrat) return;
        const poolId = getPoolId();
        const p = ((ps && ps.pools) || []).find(x => x.pool_id === poolId);
        const el = $('#stratDesc');
        const tag = $('#poolStratTag');
        const strat = selStrat.value;
        if (el) el.textContent = (desc[strat] || '') + '；外呼触发号：' + ((p && p.dids && p.dids.length) ? p.dids.join(', ') : '—') +
          ((p && p.default_vos && p.default_vos.length) ? '；任意被叫←VOS ' + p.default_vos.join(', ') : '') +
          (p && p.is_default ? '；全局兜底' : '');
        if (tag) tag.textContent = labels[strat] || strat;
      };
      $$('#poolListTable tr.pool-row').forEach(tr => {
        tr.addEventListener('click', () => this.selectPool(tr.dataset.pool));
        tr.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectPool(tr.dataset.pool); }
        });
      });
      const btnDids = $('#btnPoolDids');
      if (btnDids) btnDids.addEventListener('click', () => this.poolEditDids());
      if (selStrat && ps) {
        selStrat.addEventListener('change', refreshDesc);
        const btnSave = $('#btnStratSave');
        if (btnSave) btnSave.addEventListener('click', async () => {
          const poolId = getPoolId(), strat = selStrat.value;
          btnSave.disabled = true;
          try {
            const r = await DB.savePoolStrat(poolId, strat);
            if (r && r.ok) {
              APP.stratPoolId = poolId;
              toast('策略已保存', '池 ' + poolId + ' → ' + (labels[strat] || strat) + '（已即时生效）', 'ok');
              await DB.loadPoolStrat();
              this.renderReal();
            } else {
              toast('保存失败', (r && r.json && r.json.msg) || (r && r.msg) || '请重试', 'err');
            }
          } catch (ex) {
            toast('保存失败', String(ex.message || ex), 'err');
          }
          btnSave.disabled = false;
        });
        const btnDel = $('#btnPoolDel');
        if (btnDel) btnDel.addEventListener('click', async () => {
          const poolId = getPoolId();
          if (poolId === 'P1') { toast('不能删除', 'P1 为主用池', 'warn'); return; }
          if (!confirm('删除号码池 ' + poolId + '？成员将回退到 P1。')) return;
          btnDel.disabled = true;
          try {
            const r = await DB.deletePool(poolId);
            if (r && r.ok) {
              APP.stratPoolId = 'P1';
              toast('已删除号码池', poolId, 'ok');
              this.renderReal();
            } else toast('删除失败', (r && r.json && r.json.msg) || '请重试', 'err');
          } catch (ex) { toast('删除失败', String(ex.message || ex), 'err'); }
          btnDel.disabled = false;
        });
      }
      const btnFilter = $('#btnPoolFilterDev');
      if (btnFilter) btnFilter.addEventListener('click', () => this.selectPool(getPoolId(), { filterDev: true }));
      const btnNew = $('#btnPoolNew');
      if (btnNew) btnNew.addEventListener('click', () => this.poolNew());
    },
    poolNew() {
      const ps = DB.poolStrat || {};
      const labels = ps.labels || { round_robin: '严格轮询', failover: '主备故障转移', least_load: '负载均衡' };
      const stratOpts = Object.keys(labels).map(k => '<option value="' + k + '">' + labels[k] + '</option>').join('');
      const self = this;
      Modal.open('新建号码池',
        '<div class="grid2" style="gap:12px">' +
        '<div class="field"><label>池 ID <span class="req">*</span></label>' +
          '<input class="inp" id="inpNewPool" style="width:100%" placeholder="如 P2 / market / night" maxlength="16"></div>' +
        '<div class="field"><label>选路策略</label><select class="sel" id="inpNewStrat" style="width:100%">' + stratOpts + '</select></div></div>' +
        '<div class="field" style="margin-top:12px"><label>外呼触发号（池 DID，可选，逗号分隔）</label>' +
          '<input class="inp" id="inpNewPoolDid" style="width:100%" placeholder="如 18960700521"></div>' +
        '<div class="note plain" style="margin-top:10px"><span class="ni">' + I('info', 15) + '</span><div class="nb">创建后可在设备台账把 UFI 划入该池；策略即时写入 Kamailio，无需重启。</div></div>',
        '<button class="btn" data-mact="close">取消</button><button class="btn primary" data-mact="ok">创建</button>');
      /* open() 会清空 onOk，必须在 open 之后再挂回调；_runOk 会 await 完成后再关窗 */
      Modal.onOk = async () => {
        const poolId = (($('#inpNewPool') || {}).value || '').trim();
        const strategy = (($('#inpNewStrat') || {}).value || 'round_robin').trim();
        const dids = (($('#inpNewPoolDid') || {}).value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        if (!/^[A-Za-z0-9_-]{1,16}$/.test(poolId)) {
          toast('池 ID 无效', '1–16 位字母/数字/下划线/横线', 'err');
          return false;
        }
        const r = await DB.createPool(poolId, strategy, dids);
        if (!(r && r.ok)) {
          const msg = (r && r.json && r.json.msg) || (r && r.msg) || ('HTTP ' + ((r && r.status) || '?'));
          toast('创建失败', msg, 'err');
          return false;
        }
        APP.stratPoolId = poolId;
        toast('号码池已创建', poolId + ' · ' + (labels[strategy] || strategy), 'ok');
        try { await DB.loadPoolStrat(); } catch (e) { /* ignore */ }
        self.renderReal();
        return true;
      };
    },
    rows() {
      const f = APP.poolFilter;
      let list = DB.ufis.filter(u => {
        if (f.pool && u.pool_id !== f.pool) return false;
        if (f.net && u.net !== f.net) return false;
        if (f.state === 'online' && !u.online) return false;
        if (f.state === 'registered' && !u.registered) return false;
        if (f.state === 'offline' && u.online) return false;
        if (f.state === 'busy' && u.active_calls < 1) return false;
        if (f.state === 'idle' && u.active_calls > 0) return false;
        if (f.q) {
          /* 模糊匹配：IMEI / SIM / 型号 / SN / 频段（不区分大小写） */
          const q = f.q.toLowerCase();
          const hit =
            u.imei.toLowerCase().indexOf(q) >= 0 ||
            (u.sim && u.sim.indexOf(f.q) >= 0) ||
            (u.sn && u.sn.toLowerCase().indexOf(q) >= 0) ||
            (u.model && u.model.toLowerCase().indexOf(q) >= 0) ||
            (u.band && u.band.toLowerCase().indexOf(q) >= 0);
          if (!hit) return false;
        }
        return true;
      });
      const s = APP.poolSort;
      list.sort((a, b) => {
        let x = a[s.k], y = b[s.k];
        if (s.k === 'state') { x = (a.online ? 1 : 0) + (a.registered ? 1 : 0); y = (b.online ? 1 : 0) + (b.registered ? 1 : 0); }
        if (typeof x === 'string') return s.dir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
        return s.dir === 'asc' ? x - y : y - x;
      });
      return list;
    },
    render() {
      const list = this.rows();
      const total = list.length;
      const pages = Math.max(1, Math.ceil(total / APP.poolSize));
      if (APP.poolPage > pages) APP.poolPage = pages;
      const start = (APP.poolPage - 1) * APP.poolSize;
      const slice = list.slice(start, start + APP.poolSize);
      const s = APP.poolSort;

      $('#poolHead').innerHTML = '<th class="col-check"></th>' +
        '<th class="col-src" colspan="' + POOL_COLS.filter(c => c.src === 'dev').length + '">设备属性 · 来自 UFI 管理模块（只读）</th>' +
        '<th class="col-src comm" colspan="' + POOL_COLS.filter(c => c.src === 'comm').length + '">通信属性 · 本模块维护</th>' +
        '<th class="col-act"></th>';
      $('#poolSub').innerHTML = '<th class="col-check"><input type="checkbox" id="pAll"></th>' +
        POOL_COLS.map(c => {
          const cl = s.k === c.k ? (s.dir === 'asc' ? 'asc' : 'desc') : '';
          return '<th class="sortable ' + cl + (c.num ? ' num' : '') + '" data-k="' + c.k + '">' + c.t +
            '<span class="sarrow">' + (cl === 'asc' ? '▲' : cl === 'desc' ? '▼' : '⇅') + '</span></th>';
        }).join('') + '<th class="col-act">操作</th>';

      $('#poolBody').innerHTML = slice.length ? slice.map(u => {
        const sigCls = u.signal >= 3 ? '' : u.signal === 2 ? 'warn' : 'err';
        const concPct = u.max_concurrent ? Math.min(100, u.active_calls / u.max_concurrent * 100) : 0;
        const concCls = !u.max_concurrent ? '' : u.active_calls >= u.max_concurrent ? 'err' : u.active_calls > 0 ? 'warn' : '';
        return '<tr data-imei="' + u.imei + '" class="clickable-row ' + (APP.selPool.has(u.imei) ? 'sel' : '') + '">' +
          '<td class="col-check"><input type="checkbox" data-imei="' + u.imei + '" ' + (APP.selPool.has(u.imei) ? 'checked' : '') + '></td>' +
          '<td class="cell-ident">' + esc(u.imei) + (u.unmanaged ? ' <span class="tag warn" title="存量设备，尚未纳管到 UFI 管理模块">未纳管</span>' : '') + '</td>' +
          '<td class="mono">' + esc(u.sim) + '</td>' +
          '<td title="' + esc(u.model) + '">' + esc((u.model || '—').split(' / ')[0]) + '</td>' +
          '<td>' + (u.net === '—' ? '<span class="tag">—</span>' : '<span class="tag ' + (/5G/.test(u.net) ? 'purple' : 'info') + '">' + u.net + '</span>') + '</td>' +
          '<td class="mono">' + u.band + '</td>' +
          '<td><span class="meter ' + sigCls + '"><i style="width:' + (u.signal * 25) + '%"></i></span> <span class="mono" style="font-size:11px;color:var(--tx-3)">' + u.rsrp + '</span></td>' +
          '<td><span class="sdot ' + (u.online ? 'ok pulse' : 'idle') + '"></span> ' + (u.online ? '在线' : '离线') +
              ' <span class="tag ' + (u.registered ? 'ok' : 'err') + '" style="margin-left:3px">' + (u.registered ? '已注册' : '未注册') + '</span></td>' +
          '<td><span class="tag ' + (u.severity === 'ok' ? 'ok' : u.severity === 'warn' ? 'warn' : 'err') + '" title="' +
              esc((u.issues || []).join('、') || '无异常') + '">' + u.health + '</span></td>' +
          '<td><span class="tag mono">' + u.pool_id + '</span></td>' +
          '<td><span class="tag mono" title="' + esc(DB.carrierName(u.carrier)) + '">' + esc(DB.carrierLabel(u.carrier)) + '</span></td>' +
          '<td class="num">' + u.weight + '</td>' +
          '<td class="num">' + (u.max_concurrent || '∞') + '</td>' +
          '<td class="num"><span class="meter ' + concCls + '" style="width:44px"><i style="width:' + concPct + '%"></i></span> ' + u.active_calls + '</td>' +
          '<td>' + fmtAgo(u.last_used_min) + '</td>' +
          '<td><span class="sdot ' + (u.enabled ? 'ok' : 'idle') + '"></span></td>' +
          '<td><span class="sdot ' + (u.in_pool ? 'ok' : 'idle') + '"></span></td>' +
          '<td class="col-act"><div class="rowbtns">' +
            '<button class="btn xs" data-row="detail">详情</button>' +
          '</div></td>' +
          '</tr>';
      }).join('') : (function () {
        const q = APP.poolFilter.q;
        const tip = q ? '没有匹配 “' + esc(q) + '” 的线路' : '当前筛选条件下没有线路';
        return '<tr><td colspan="' + (POOL_COLS.length + 2) + '"><div class="empty">' + I('search', 34) + tip + '</div></td></tr>';
      })();

      /* 表头全选（事件委托绑定一次） */
      const all = $('#pAll');
      if (all) all.addEventListener('change', () => {
        slice.forEach(u => all.checked ? APP.selPool.add(u.imei) : APP.selPool.delete(u.imei));
        this.render(); this.bulk();
      });
      $$('#poolBody [data-row]').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        const imei = b.closest('tr').dataset.imei;
        if (b.dataset.row === 'detail') Drawer.open(imei);
      }));

      $('#poolCount').textContent = '共 ' + num(total) + ' 台' + (slice.length ? '　显示 ' + (start + 1) + '–' + (start + slice.length) : '');
      this.pager(total, pages);
      this.bulk();
      this.renderReal();
    },
    pager(total, pages) {
      const p = APP.poolPage;
      let h = '<span class="info">' + num(total) + ' 条</span>' +
        '<select class="sel sm" id="pSize" style="margin-left:10px">' +
        [25, 50, 100, 200].map(n => '<option ' + (APP.poolSize === n ? 'selected' : '') + '>' + n + '</option>').join('') + '</select>' +
        '<div class="pages">' +
        '<button class="pg" data-pg="' + (p - 1) + '" ' + (p <= 1 ? 'disabled' : '') + '>‹</button>';
      const set = new Set([1, pages, p, p - 1, p + 1, p - 2, p + 2]);
      const arr = Array.from(set).filter(x => x >= 1 && x <= pages).sort((a, b) => a - b);
      let last = 0;
      arr.forEach(x => {
        if (x - last > 1) h += '<span style="color:var(--tx-3);padding:0 2px">…</span>';
        h += '<button class="pg ' + (x === p ? 'on' : '') + '" data-pg="' + x + '">' + x + '</button>';
        last = x;
      });
      h += '<button class="pg" data-pg="' + (p + 1) + '" ' + (p >= pages ? 'disabled' : '') + '>›</button></div>';
      $('#poolPager').innerHTML = h;
      $$('#poolPager [data-pg]').forEach(b => b.addEventListener('click', () => { APP.poolPage = +b.dataset.pg; this.render(); }));
      $('#pSize').addEventListener('change', e => { APP.poolSize = +e.target.value; APP.poolPage = 1; this.render(); });
    },
    bulk() {
      $('#poolBulk').classList.toggle('on', APP.selPool.size > 0);
      $('#poolSelN').textContent = APP.selPool.size;
    },
    bulkAct(a) {
      const n = APP.selPool.size;
      if (!n) return;
      const imeis = Array.from(APP.selPool);
      const label = { enable: '批量启用入池', disable: '批量停用', maintain: '批量转维护', 'reset-conc': '清零并发计数' }[a] || a;
      DB.bulkComm(a, imeis).then(() => {
        APP.selPool.clear();
        this.render();
        toast('已执行：' + label + ' ' + n + ' 台', '通信属性已写入 dsip_ufi_pool 并生效', 'ok', 4200);
      }).catch(e => {
        this.render();
        toast('批量操作失败', String(e.message || e), 'err', 5000);
      });
    }
  };

  function fld(label, val, help) {
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<input class="inp mono" value="' + esc(val) + '"><span class="help">' + esc(help) + '</span></div>';
  }

  /* ════════════════════════════════════════════════════════════ ROUTE VIEW（路由自动同步）
     呼入：拨 UFI SIM 号经 VoLTE 直达（REQINIT 信任 + dr_rules 8000 prefix=IMEI→VOS）
     同步：pool(enabled&in_pool) ↔ dr_rules(8000/9000) ↔ subscriber，幂等校准 + 自动 reload
  ════════════════════════════════════════════════════════════ */
  const Route = {
    init() {
      const btn = $('#btnSyncRoutes');
      if (btn) btn.addEventListener('click', () => this.runSync());
    },
    async runSync() {
      const btn = $('#btnSyncRoutes');
      if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
      try {
        const r = await DB.syncRoutes();
        const c = r || {};
        const parts = [];
        if ((c.rules_added || []).length) parts.push('新增呼入规则: ' + c.rules_added.join(', '));
        if ((c.rules_removed || []).length) parts.push('移除呼入规则: ' + c.rules_removed.join(', '));
        if ((c.imaps_added || []).length) parts.push('新增 DID 映射: ' + c.imaps_added.join(', '));
        if ((c.imaps_removed || []).length) parts.push('移除 DID 映射: ' + c.imaps_removed.join(', '));
        if ((c.pools_pruned || []).length) parts.push('清理已删设备: ' + c.pools_pruned.join(', '));
        if (c.subscribers_ensured) parts.push('SIP 账号校准 ' + c.subscribers_ensured + ' 个');
        const changed = parts.length > 0;
        parts.push(c.reloaded ? '已执行 drouting reload' : '无路由变更，未 reload');
        this.render();
        toast(changed ? '同步完成' : '配置已一致，无需变更', parts.join(' ｜ '), changed ? 'ok' : 'info', 6500);
      } catch (e) {
        toast('同步失败', String(e.message || e), 'err', 5200);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '立即同步'; }
      }
    },
    render() {
      const h = DB.health();
      const rs = DB.routes || {};
      if (!DB.routes && !this._loading) {
        this._loading = true;
        DB.loadRoutes().then(() => { this._loading = false; this.render(); });
      }
      const usable = DB.ufis.filter(u => u.in_pool && u.enabled && u.registered).length;
      const kpiEl = $('#kpiRoute');
      if (kpiEl) kpiEl.innerHTML = [
        ['可用线路', num(usable), '在池且已注册', usable ? 'ok' : 'err'],
        ['呼入规则', (rs.rules_out || []).length, 'dr_rules 8000 · IMEI→VOS', 'info'],
        ['DID 映射', (rs.rules_in || []).length, 'dr_rules 9000 · SIM', 'info'],
        ['配置一致性', rs.consistent === undefined ? '—' : (rs.consistent ? '一致' : '有差异'), rs.consistent ? '自动同步生效' : '点「立即同步」', rs.consistent ? 'ok' : 'warn'],
        ['当前并发', h.busy, '线路承载中', 'purple']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');

      /* 路由同步状态表（若页面有该区块） */
      const tag = $('#syncTag');
      if (tag) {
        tag.textContent = rs.consistent === undefined ? '未加载' : (rs.consistent ? '一致' : '有差异');
        tag.className = 'tag ' + (rs.consistent === undefined ? '' : (rs.consistent ? 'ok' : 'warn'));
      }
      const syncBody = $('#syncBody');
      if (syncBody) {
        syncBody.innerHTML = (rs.pool || []).map(p => {
          const act = p.enabled && p.in_pool;
          const hasRule = (rs.rules_out || []).some(x => x.prefix === p.imei);
          const hasSub = !(rs.missing_subs || []).includes(p.imei);
          const hasMap = !p.sim || !(rs.missing_imaps || []).includes(p.sim);
          const cell = v => !act ? '<span class="tag">不适用</span>' : (v ? '<span class="tag ok">✓</span>' : '<span class="tag err">缺</span>');
          return '<tr><td class="mono"><b>' + esc(p.imei) + '</b></td>' +
            '<td class="mono">' + (p.sim ? esc(p.sim) : '—') + '</td>' +
            '<td><span class="tag mono">' + esc(p.pool_id || '—') + '</span></td>' +
            '<td><span class="tag mono">' + esc(p.carrier || '100') + '</span></td>' +
            '<td><span class="tag ' + (act ? 'ok' : 'warn') + '">' + (act ? '在池·启用' : (p.enabled ? '不在池' : '停用')) + '</span></td>' +
            '<td>' + cell(hasRule) + '</td>' +
            '<td>' + (!p.sim ? '<span class="tag">无 SIM</span>' : cell(hasMap)) + '</td>' +
            '<td>' + cell(hasSub) + '</td></tr>';
        }).join('') || '<tr><td colspan="8" style="color:var(--tx-3)">暂无 pool 成员</td></tr>';
      }

      /* 号码与路由页：dbaliases / 呼出规则 / VOS 号段快照 */
      const didBody = $('#didBody');
      if (didBody) {
        const rows = DB.DID_ROUTES || [];
        didBody.innerHTML = rows.length ? rows.map(d =>
          '<tr><td class="mono">' + esc(d.did) + '</td><td>' + esc(d.kind || '绑定') + '</td>' +
          '<td class="mono">' + esc(d.imei) + '</td><td>' + esc(d.land || 'UFI') + '</td>' +
          '<td><span class="tag mono">' + esc(d.pool || '—') + '</span></td>' +
          '<td class="col-act">—</td></tr>'
        ).join('') : '<tr><td colspan="6" style="color:var(--tx-3)">暂无 dbaliases 绑定</td></tr>';
      }
      const ruleBody = $('#ruleBody');
      if (ruleBody) {
        ruleBody.innerHTML = (DB.OUT_RULES || []).map(r =>
          '<tr><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.prefix) + '</td>' +
          '<td class="mono">' + esc(r.pool) + '</td><td>' + esc(r.auth) + '</td>' +
          '<td class="num">' + r.max_try + '</td><td class="num">' + r.retry_gap_s + '</td>' +
          '<td><span class="tag ' + (r.enabled ? 'ok' : '') + '">' + (r.enabled ? '启用' : '停用') + '</span></td>' +
          '<td class="col-act">—</td></tr>'
        ).join('');
      }
      const snap = DB.snapshot || {};
      const sd = $('#snapDids');
      if (sd) sd.textContent = (snap.phone && snap.phone.dids) || '—';
      const sp = $('#snapPrefix');
      if (sp) {
        const cur = (snap.vos && snap.vos.prefix) || '—';
        const exact = /(^|,)\d{11}(,|$)/.test(String(cur));
        sp.innerHTML = '<span class="mono">' + esc(cur) + '</span> ' +
          (exact
            ? '<span class="tag err">逐号联调 · 请改为 1,0,400,800</span>'
            : '<span class="tag ok">前缀通配</span>');
      }
    }
  };


  function triCell(k, v, n, good) {
    return '<div class="tri-cell ' + (good ? 'good' : 'bad') + '"><div class="tk">' + esc(k) + '</div><div class="tv">' + esc(v) + '</div><div class="tn">' + esc(n) + '</div></div>';
  }

  /* ════════════════════════════════════════════════════════════ 变更任务（双责任域）
     我方（dSIPRouter）→ 可直接执行，逐条回显
     客户（VOS3000）→ 只生成指引单，客户在其管理界面操作后回填，我方验收
  ════════════════════════════════════════════════════════════ */
  const Pend = {
    init() {
      document.addEventListener('click', e => {
        const b = e.target.closest('[data-pact]');
        if (!b) return;
        const id = b.dataset.pid;
        const p = DB.pending.find(x => x.id === id);
        if (!p) return;
        switch (b.dataset.pact) {
          case 'drop':   DB.dropPending(id); this.render(); toast('已移除任务', '', 'info', 1800); break;
          case 'apply':  this.apply([p]); break;
          /* 客户侧状态流转：待配置 → 客户已完成 → 我方已验收 */
          case 'confirm': p.state = 'done'; this.render(); toast('已记录客户完成', '现在可进行我方验收', 'ok'); break;
          case 'verify':  p.state = 'verified'; this.render(); toast('验收通过', p.title, 'ok'); break;
          case 'reopen':  p.state = 'waiting'; this.render(); break;
          case 'copy':    this.copyOne(p); break;
        }
      });
    },
    render() {
      /* ── 我方三项（只含 owner=ours） ── */
      const g = { live: [], reload: [], restart: [] };
      DB.pending.filter(p => p.owner === 'ours').forEach(p => (g[p.ef] || g.live).push(p));
      const box = { live: '#pendLive', reload: '#pendReload', restart: '#pendRestart' };
      Object.keys(box).forEach(k => {
        const arr = g[k];
        $(box[k]).innerHTML = arr.length ? arr.map(p => this.item(p)).join('')
          : '<div class="empty" style="padding:24px;font-size:12px">无我方待办</div>';
      });

      /* ── 客户指引单 ── */
      const cs = DB.pending.filter(p => p.owner === 'client');
      $('#clientTasks').innerHTML = cs.length ? cs.map(p => this.guide(p)).join('')
        : '<div class="empty" style="padding:32px">' + I('check-circle', 32) + '当前没有待客户配置的任务</div>';

      /* ── 计数 ── */
      const ours = DB.pending.filter(p => p.owner === 'ours' && p.state === 'pending').length;
      const cli = cs.filter(p => p.state === 'waiting').length;
      $('#ourCnt').textContent = ours;
      $('#btnOurWork').classList.toggle('badge-host', ours > 0);
      $('#pendCnt').textContent = cli;
      $('#btnPending').classList.toggle('idle', cli === 0);
      $('#cntPend').textContent = DB.pending.filter(p => p.state === 'pending' || p.state === 'waiting').length;
      $('#cntPend').classList.toggle('hot', cli + ours > 0);
      DB.savePending();
    },

    /* 我方执行项 */
    item(p) {
      return '<div class="pend-item ' + (p.state === 'done' ? 'done' : p.state === 'failed' ? 'failed' : '') + '" data-ef="' + p.ef + '">' +
        '<span class="pi-ico">' + I(p.state === 'done' ? 'check' : p.state === 'failed' ? 'x' : 'bolt', 14) + '</span>' +
        '<div class="pi-main"><div class="pi-t">' + esc(p.title) + effBadge(p.ef) +
        '<span class="tag mono">' + esc(p.sys) + '</span></div>' +
        '<div class="pi-d">' + esc(p.detail) + '</div>' +
        '<div class="pi-d" style="color:var(--tx-3)">' + esc(p.target) + ' · ' + fmtTime(p.at) + '</div></div>' +
        '<div class="pi-act">' +
        '<button class="btn xs primary" data-pact="apply" data-pid="' + p.id + '" ' + (p.state === 'done' ? 'disabled' : '') + '>执行</button>' +
        '<button class="btn xs" data-pact="drop" data-pid="' + p.id + '">移除</button>' +
        '</div></div>';
    },

    /* 客户配置指引单 */
    guide(p) {
      const st = CSTATE[p.state] || CSTATE.waiting;
      return '<div class="guide ' + (p.state === 'verified' ? 'done' : '') + '" data-cid="' + p.id + '">' +
        '<div class="guide-hd">' +
        '<span class="tag ' + st.cls + '">' + st.label + '</span>' +
        '<b>' + esc(p.title) + '</b>' +
        '<span class="tag mono">' + esc(p.sys) + '</span>' +
        '<span class="sp"></span>' +
        '<button class="btn xs" data-pact="copy" data-pid="' + p.id + '">' + I('copy', 12) + '复制</button>' +
        (p.state === 'waiting'
          ? '<button class="btn xs primary" data-pact="confirm" data-pid="' + p.id + '">客户已完成</button>'
          : p.state === 'done'
            ? '<button class="btn xs primary" data-pact="verify" data-pid="' + p.id + '">验收通过</button>'
            : '<button class="btn xs" data-pact="reopen" data-pid="' + p.id + '">重新打开</button>') +
        '</div>' +
        '<div class="guide-bd">' +
        '<div class="guide-where"><span class="gi">' + I('target', 15) + '</span><div><b>操作位置</b>' + esc(p.target) + '</div></div>' +
        '<ol class="guide-steps">' + (p.guide || []).map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
        (p.caution ? '<div class="guide-caution"><span class="gi">' + I('alert', 15) + '</span><div><b>注意事项</b>' + esc(p.caution) + '</div></div>' : '') +
        (p.verify ? '<div class="guide-verify"><span class="gi">' + I('check-circle', 15) + '</span><div><b>验收方法</b>' + esc(p.verify) + '</div></div>' : '') +
        '</div>' +
        (p.state !== 'verified' ? this.fillForm(p) : '') +
        '<div class="guide-ft"><span>创建于 ' + fmtTime(p.at) + '</span><span>·</span><span>责任方：客户</span>' +
        '<span class="sp"></span><button class="btn xs" data-pact="drop" data-pid="' + p.id + '">关闭任务</button></div>' +
        '</div>';
    },

    /* 客户回填区：客户做完把实际值填回来，我方可据此验收 */
    fillForm(p) {
      return '<div class="guide-fill">' +
        '<div class="gf-row"><label>客户回填</label>' +
        '<input class="inp mono" placeholder="' + esc((p.verify || '').slice(0, 30)) + '…实际配置结果 / 完成时间" data-fill="' + p.id + '">' +
        '<button class="btn sm" data-pact="confirm" data-pid="' + p.id + '">客户已完成</button></div>' +
        '<div class="gf-row"><label>我方验收</label>' +
        '<input class="inp" placeholder="验收结论：拨测结果、异常现象" data-verify="' + p.id + '">' +
        '<button class="btn sm" data-pact="verify" data-pid="' + p.id + '" ' + (p.state === 'waiting' ? 'disabled' : '') + '>标记已验收</button></div>' +
        '</div>';
    },

    /* 指引单文本：可直接粘给客户 */
    guideText(p) {
      const L = [];
      L.push('【配置指引单】' + p.title);
      L.push('系统：' + p.sys + '（' + (DB.OWNER.client.sys) + '）');
      L.push('责任方：客户侧（我方无执行权限，请贵方管理员操作）');
      L.push('');
      L.push('操作位置：' + p.target);
      L.push('');
      L.push('操作步骤：');
      (p.guide || []).forEach((s, i) => L.push('  ' + (i + 1) + '. ' + s));
      if (p.caution) { L.push(''); L.push('注意事项：' + p.caution); }
      if (p.verify)  { L.push(''); L.push('验收方法：' + p.verify); }
      L.push('');
      L.push('完成后请回复本单，我方将进行拨测验收。');
      return L.join('\n');
    },
    copyOne(p) {
      const t = this.guideText(p);
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      toast('指引单已复制', '可直接粘贴发送给客户管理员', 'ok');
    },
    copyAll() {
      const cs = DB.pending.filter(p => p.owner === 'client' && p.state !== 'verified');
      if (!cs.length) { toast('无待客户配置任务', '', 'warn'); return; }
      const t = cs.map(p => this.guideText(p)).join('\n\n' + '─'.repeat(40) + '\n\n');
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      toast('已复制 ' + cs.length + ' 份指引单', '合并为一个文本块，可直接发客户', 'ok', 4000);
    },

    log(txt, cls) {
      const box = $('#applyLog');
      if (box.querySelector('.dim')) box.innerHTML = '';
      const s = document.createElement('span');
      s.className = 'l ' + (cls || 'dim');
      s.textContent = txt;
      box.appendChild(s);
      box.scrollTop = box.scrollHeight;
    },
    gap() { const s = document.createElement('span'); s.className = 'sp'; $('#applyLog').appendChild(s); },

    /* 执行我方待办：仅限 owner=ours，绝不触碰客户侧。
       带 act 的任务真实调用后端 API 落库；无 act 的仅标记留痕（需人工/脚本执行）。 */
    apply(list) {
      const items = (list || DB.pending.filter(p => p.owner === 'ours')).filter(Boolean);
      if (!items.length) { toast('无我方待办', '客户侧任务不由此处执行', 'warn'); return; }
      const groups = { live: [], reload: [], restart: [] };
      items.forEach(p => { if (p.owner === 'ours') groups[p.ef].push(p); });
      const order = ['live', 'reload', 'restart'];
      this.log('$ backup 20261007-1006  kamailio.cfg + mysqldump kamailio  （我方资产，不含客户 VOS/FS）', 'wr');
      this.gap();
      let i = 0, real = 0, failed = 0;
      const runGroup = gi => {
        if (gi >= order.length) {
          const failMsg = failed ? ('，' + failed + ' 项失败（见日志）') : '';
          this.log('$ done  — 我方变更执行完成' + (real ? '（' + real + ' 项已落库' + failMsg + '）' : ''), failed ? 'wr' : 'ok');
          const cli = DB.pending.filter(p => p.owner === 'client' && p.state === 'waiting').length;
          toast(failed ? '部分任务执行失败' : '我方待办已完成',
            (failed ? failed + ' 项失败，详情见执行日志；' : '') + (cli ? '另有 ' + cli + ' 项等客户在其界面配置' : '无待客户配置项'),
            failed ? 'warn' : 'ok', 4200);
          if (real > 0) {
            /* 真实落库后重拉真实数据（dbaliases 等），避免定时同步覆盖预览状态 */
            DB.reload().then(() => { Renderer.render(APP.view); this.render(); Nav.go('pend'); })
              .catch(() => { Nav.go('pend'); });
          } else Nav.go('pend');
          return;
        }
        const ef = order[gi];
        const arr = groups[ef];
        if (!arr.length) return runGroup(gi + 1);
        this.log('$ [我方 · ' + EF[ef].label + '] 共 ' + arr.length + ' 项', 'dim');
        const step = () => {
          if (i >= arr.length) {
            if (ef === 'live') this.log(real ? '  ✓ dbaliases / 通信属性写入完成，无需 reload' : '  → 本组无自动执行动作，均为留痕任务', real ? 'ok' : 'wr');
            if (ef === 'reload') { this.log('$ kamcmd permissions.addressReload', 'cmd'); this.log('  ✓ address 表已重载', 'ok'); }
            if (ef === 'restart') { this.log('$ kamailio restart', 'cmd'); this.log('  ✓ kamailio 5.9.1 已加载 /etc/kamailio/kamailio.cfg', 'ok'); }
            this.gap();
            arr.forEach(p => { if (p.state !== 'failed') p.state = 'done'; });
            DB.savePending();
            return runGroup(gi + 1);
          }
          const p = arr[i];
          this.log('  [' + (i + 1) + '/' + arr.length + '] ' + p.sys + ' · ' + p.title, 'dim');
          const next = () => { i++; this.render(); step(); };
          if (p.act && p.act.type) {
            /* 真实执行：调后端 API 落库（dbaliases 增删等） */
            DB.execPending(p.act).then(() => {
              real++;
              this.log('    $ ' + p.detail, 'cmd');
              this.log('    ✓ 已写入数据库并生效（' + EF[p.ef].label + '）', 'ok');
              p.state = 'done';
              next();
            }).catch(err => {
              failed++;
              this.log('    $ ' + p.detail, 'cmd');
              this.log('    ✗ 执行失败：' + (err.message || err), 'wr');
              p.state = 'failed';
              next();
            });
          } else {
            /* 留痕型任务：无自动执行动作，如实标注，不伪装"已生效" */
            setTimeout(() => {
              this.log('    $ ' + p.detail, 'cmd');
              this.log('    → 已标记完成（本任务需按命令人工/脚本执行，未自动落库）', 'wr');
              p.state = 'done';
              next();
            }, 420 + Math.random() * 340);
          }
        };
        step();
      };
      runGroup(0);
    }
  };

  /* ════════════════════════════════════════════════════════════ TOPO VIEW */
  const Topo = {
    render() {
      const h = DB.health();
      const topo = DB.topo || {};
      const ds = topo.dsip || {};
      const carriers = topo.carriers || DB.carriers || [];
      const pools = (topo.pools && topo.pools.length) ? topo.pools
        : ((DB.poolStrat && DB.poolStrat.pools) || []);
      const routes = topo.routes || {};
      const dsipEp = ds.endpoint || ((ds.host || '—') + ':5060');
      const authOk = carriers.filter(c => c.auth && c.auth.ok).length;
      const authWarn = carriers.length && authOk < carriers.length;
      const vosTitle = carriers.length > 1
        ? ('VOS ×' + carriers.length)
        : ((carriers[0] && (carriers[0].name || 'VOS3000')) || 'VOS3000');
      const vosHosts = carriers.map(c => (c.address || c.ip || '').split(':')[0]).filter(Boolean).join(' / ') || '—';
      const poolLine = pools.length
        ? pools.map(p => {
            const n = (p.active != null ? p.active : ((p.members || []).filter(m => m.in_pool).length)) || 0;
            const vos = (p.default_vos && p.default_vos.length) ? ('←VOS' + p.default_vos.join('/')) : '';
            return p.pool_id + '·' + n + '台' + (vos ? ' ' + vos : '') +
              (p.strategy_label ? '（' + p.strategy_label + '）' : '');
          }).join(' / ')
        : '暂无号码池';
      const stratHint = pools.filter(p => p.active || p.total).map(p =>
        p.pool_id + ':' + (p.strategy_label || p.strategy || '—') +
        ' 并发 ' + (p.conc || 0) + '/' + (p.cap || '—')).join(' · ') || '按池策略分配并发';
      const routeCls = routes.consistent === false ? 'warn' : 'ok';
      const routeSub = routes.consistent === false
        ? ('路由不一致：缺 subscriber ' + (routes.missing_subs || 0) +
           ' / 缺规则 ' + (routes.missing_rules || 0) +
           ' / 陈旧 ' + (routes.stale_rules || 0))
        : 'dr_rules / subscriber 与号码池一致；sqlops 动态选池，加设备零重启';

      $('#kpiTopo').innerHTML = [
        ['纳管设备', num(h.totalUfi), h.online + ' 在线 / WS', 'info'],
        ['已注册', num(h.locRegs || h.registered), 'location 有效', (h.registered / Math.max(1, h.totalUfi) > .9 ? 'ok' : 'warn')],
        ['池内可用', num(h.usable), '在线+注册+在池', 'ok'],
        ['VoLTE 注册', num(h.volte), '支持桥接通话', 'purple'],
        ['当前并发', h.busy, '容量 ' + (h.capacity || '—'), 'info'],
        ['DID 映射', num(h.didAliases), routes.consistent === false ? '路由待校准' : 'dbaliases', routes.consistent === false ? 'warn' : 'ok']
      ].map(k => kpi(k[0], k[1], k[2], k[3])).join('');

      const pillKsr = $('#pillKsr'), pillVos = $('#pillVos');
      if ($('#pillKsrN')) $('#pillKsrN').textContent = h.locRegs || h.registered;
      if ($('#pillVosN')) $('#pillVosN').textContent = h.busy;
      if (pillKsr) {
        pillKsr.className = 'pill clickable ' + (h.registered ? 'ok' : 'err');
        pillKsr.title = 'dSIPRouter ' + dsipEp + ' · 我方自建 · 注册 ' + (h.locRegs || h.registered);
      }
      if (pillVos) {
        pillVos.className = 'pill clickable ' + (authWarn ? 'warn' : (carriers.length ? 'ok' : ''));
        pillVos.title = vosTitle + ' ' + vosHosts + ' · 客户资产 · IP 认证 ' + authOk + '/' + carriers.length;
      }

      const nodes = [
        { c: 'c-phone', n: '<div class="link-node ' + (h.busy ? 'ok' : 'warn') + '"><div class="ln-hd"><span class="sdot ' + (h.busy ? 'ok pulse' : 'warn') + '"></span><b>用户手机</b></div><div class="ln-sub">蜂窝 VoLTE · 外呼经 VOS 进 dSIP</div><div class="ln-metrics"><div><span class="n">' + h.busy + '</span><span class="c">通话中</span></div><div><span class="n">' + h.ringing + '</span><span class="c">振铃</span></div></div></div>' },
        { c: 'c-ufi', n: '<div class="link-node ' + (h.registered ? 'ok' : 'err') + '"><div class="ln-hd"><span class="sdot ' + (h.registered ? 'ok pulse' : 'err') + '"></span><b>UFI 设备池</b><span class="own-tag">我方</span></div><div class="ln-sub">' + num(h.totalUfi) + ' 台 · ' + esc((topo.dialect && topo.dialect.register) || '注册名=IMEI，密码=md5(IMEI)[:16]') + '</div><div class="ln-metrics"><div><span class="n">' + num(h.online) + '</span><span class="c">在线</span></div><div><span class="n">' + num(h.registered) + '</span><span class="c">已注册</span></div><div><span class="n">' + num(h.inPool) + '</span><span class="c">池内</span></div></div></div>' +
          '<div class="link-node mini ' + (h.inPool ? 'ok' : '') + '"><div class="ln-hd"><b>号码池选路</b></div><div class="ln-sub">' + esc(poolLine) + '</div></div>' },
        { c: 'c-ksr', n: '<div class="link-node ' + routeCls + '"><div class="ln-hd"><span class="sdot ' + routeCls + '"></span><b>dSIPRouter</b><span class="own-tag">我方</span></div><div class="ln-sub">' + esc(dsipEp) + ' · 域 ' + esc(ds.domain || '—') + '<br>鉴权 / 池 DID·_DEFAULT_&lt;gwid&gt; / X-VOLTE</div><div class="ln-metrics"><div><span class="n">' + num(h.locRegs || h.registered) + '</span><span class="c">location</span></div><div><span class="n">' + num(h.didAliases) + '</span><span class="c">DID 映射</span></div><div><span class="n">' + num((topo.counts && topo.counts.phone_triggers) || 0) + '</span><span class="c">触发号</span></div></div></div>' +
          '<div class="link-node mini ' + routeCls + '"><div class="ln-hd"><b>路由一致性</b></div><div class="ln-sub">' + esc(routeSub) + '</div></div>' },
        { c: 'c-vos', n: '<div class="link-node client ' + (authWarn ? 'warn' : 'ok') + '"><div class="ln-hd"><span class="sdot ' + (authWarn ? 'warn' : 'ok') + '"></span><b>' + esc(vosTitle) + '</b><span class="own-tag client">客户</span></div><div class="ln-sub">' + esc(vosHosts) + ' · IP 认证 ' + authOk + '/' + carriers.length + '<br><span style="color:var(--tx-3)">客户资产 · 前缀通配 / 计费由客户维护</span></div></div>' +
          carriers.map(c => {
            const a = c.auth || {};
            const cls = a.ok ? 'ok' : 'warn';
            const vosPools = pools.filter(p => (p.default_vos || []).map(String).indexOf(String(c.gwid)) >= 0).map(p => p.pool_id);
            return '<div class="link-node mini client ' + cls + '"><div class="ln-hd"><b>gwid ' + esc(c.gwid) + ' · ' + esc(c.name || '') + '</b></div><div class="ln-sub">' +
              esc(c.address || c.ip || '—') + ' · ' + esc(a.detail || '—') +
              (vosPools.length ? '<br>任意被叫 → 池 ' + esc(vosPools.join(',')) : '<br>未绑任意被叫池') +
              '</div></div>';
          }).join('') },
        { c: 'c-agent', n: '<div class="link-node ok"><div class="ln-hd"><span class="sdot ' + (h.busy ? 'ok pulse' : 'idle') + '"></span><b>线路承载</b><span class="own-tag">我方</span></div><div class="ln-sub">选路候选 ' + h.usable + ' 台 · ' + esc(stratHint) + '</div><div class="ln-metrics"><div><span class="n">' + h.busy + '</span><span class="c">并发</span></div><div><span class="n">' + h.talking + '</span><span class="c">通话记录·中</span></div><div><span class="n">' + h.failed + '</span><span class="c">失败</span></div></div></div>' +
          '<div class="link-node mini ok"><div class="ln-hd"><b>并发上限</b></div><div class="ln-sub">池内容量 ' + (h.capacity || 0) + ' · 满载跳下一台（failover/轮询）</div></div>' }
      ];
      const arrows = [
        { c: 'narrow', l: '蜂窝', cls: 'hot' },
        { c: '', l: 'R-URI=IMEI', cls: 'bidir' },
        { c: 'narrow', l: 'IP Auth', cls: authWarn ? 'hot' : 'bidir' },
        { c: '', l: 'X-VOLTE', cls: 'bidir' }
      ];
      let html = '';
      nodes.forEach((nd, i) => {
        html += '<div class="topo-col ' + nd.c + '">' + nd.n + '</div>';
        if (i < nodes.length - 1) {
          const a = arrows[i];
          html += '<div class="topo-arrow ' + a.cls + '"><span class="wire"></span><span class="cap">' + I('chevron', 18) + '</span><span class="lbl">' + a.l + '</span></div>';
        }
      });
      $('#topoFlow').innerHTML = html;

      const syncAt = topo.updated_at || (DB.LAST_SYNC ? fmtTime(DB.LAST_SYNC) : '—');
      $('#topoLegend').innerHTML =
        '<span class="li"><span class="sw" style="background:var(--ly-mobile)"></span>用户手机</span>' +
        '<span class="li"><span class="sw" style="background:var(--ly-ufi)"></span>UFI 线路</span>' +
        '<span class="li"><span class="sw" style="background:var(--ly-ksr)"></span>dSIPRouter（我方）</span>' +
        '<span class="li"><span class="sw" style="background:var(--ly-vos)"></span>VOS（客户）</span>' +
        '<span class="li"><span class="sw" style="background:var(--ly-agent)"></span>线路承载（我方）</span>' +
        '<span class="li" style="margin-left:auto;color:var(--tx-3)">数据源：/ufi/comm/topo · 同步 ' + esc(syncAt) + '</span>';

      const live = DB.calls.slice(0, 22);
      $('#callflowLive').innerHTML = live.length ? live.map((c, ci) => {
        const st = CALL_STATE[c.state] || CALL_STATE.done;
        return '<div class="cfl clk ' + (c.state === 'talk' ? 'live' : c.state === 'ring' ? 'ring' : '') + '" data-ci="' + ci + '" title="点击查看通话过程链路">' +
          '<span class="dir ' + c.dir + '">' + I(c.dir === 'in' ? 'phone-in' : 'phone-out', 11) + '</span>' +
          '<span class="num">' + esc(c.peer) + '</span>' +
          '<span class="path">UFI ' + esc(c.imei) + ' · 池 ' + esc(c.pool) + ' · ' + esc(c.ua) + '</span>' +
          '<span class="tag ' + st.cls + '">' + st.label + '</span>' +
          '<span class="du">' + (c.state === 'talk' ? fmtDur(c.dur) : fmtTime(c.at)) + '</span></div>';
      }).join('') : '<span style="color:var(--tx-3)">暂无通话记录（设备上报 /ufi/records）</span>';
      $$('#callflowLive .cfl[data-ci]').forEach(el => el.addEventListener('click', () => {
        const c = DB.calls[Number(el.dataset.ci)];
        if (c) openCallChain(c);
      }));

      $('#poolLoad').innerHTML = (function () {
        if (pools.length) {
          return pools.map(p => {
            const conc = p.conc || 0, cap = p.cap || 0;
            const pct = cap ? Math.min(100, conc / cap * 100) : 0;
            const vos = (p.default_vos && p.default_vos.length) ? ('VOS ' + p.default_vos.join('/') + ' 任意') : '';
            const dids = (p.dids && p.dids.length) ? p.dids.join(', ') : '—';
            return '<div style="margin-bottom:12px"><div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px">' +
              '<span class="tag mono">' + esc(p.pool_id) + '</span><b>' + (p.active || 0) + '/' + (p.total || 0) + ' 台</b>' +
              (vos ? '<span class="tag ok">' + esc(vos) + '</span>' : '') +
              '<span style="margin-left:auto;font-family:var(--ff-num);color:var(--tx-3)">' + conc + ' / ' + (cap || '—') + '</span></div>' +
              '<div class="meter ' + (pct > 80 ? 'err' : pct > 50 ? 'warn' : '') + '" style="width:100%;height:7px"><i style="width:' + pct + '%"></i></div>' +
              '<div style="font-size:11px;color:var(--tx-3);margin-top:3px">' + esc(p.strategy_label || p.strategy || '') +
              ' · 触发号 ' + esc(dids) + '</div></div>';
          }).join('');
        }
        const g = {};
        DB.ufis.forEach(u => { const k = u.pool_id || '—'; (g[k] = g[k] || []).push(u); });
        const keys = Object.keys(g).filter(k => g[k].length);
        if (!keys.length) return '<span style="color:var(--tx-3)">暂无设备</span>';
        return keys.map(k => {
          const mem = g[k];
          const conc = mem.reduce((a, u) => a + u.active_calls, 0);
          const cap = mem.reduce((a, u) => a + (u.max_concurrent || 0), 0);
          const pct = cap ? Math.min(100, conc / cap * 100) : 0;
          const usable = mem.filter(u => u.in_pool && u.enabled && u.registered && u.online).length;
          return '<div style="margin-bottom:12px"><div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px">' +
            '<span class="tag mono">' + esc(k) + '</span><b>' + mem.length + ' 台</b>' +
            '<span style="margin-left:auto;font-family:var(--ff-num);color:var(--tx-3)">' + conc + ' / ' + (cap || '—') + '</span></div>' +
            '<div class="meter ' + (pct > 80 ? 'err' : pct > 50 ? 'warn' : '') + '" style="width:100%;height:7px"><i style="width:' + pct + '%"></i></div>' +
            '<div style="display:flex;gap:10px;font-size:11px;color:var(--tx-3);margin-top:3px"><span>在池可用 ' + usable + '/' + mem.length + '</span>' +
            '<span style="margin-left:auto">并发/上限</span></div></div>';
        }).join('');
      })();
    },

    diagInvite() {
      const u = DB.ufis.find(x => x.registered && x.in_pool) || DB.ufis.find(x => x.registered) || DB.ufis[0];
      const live = (DB.calls || []).find(c => c.state === 'talk' || c.state === 'ring');
      const topo = DB.topo || {};
      const ds = topo.dsip || {};
      const imei = (live && live.imei) || (u && u.imei) || '<IMEI>';
      const peer = (live && live.peer) || (u && u.sim && u.sim !== '—' ? u.sim : '<被叫号码>');
      const host = ds.host || (DB.snapshot.dsiprouter && DB.snapshot.dsiprouter.host) || '—';
      Modal.open('桥接 INVITE 三值（真实方言）',
        '<div class="note plain" style="margin-bottom:12px"><span class="ni">' + I('info', 15) + '</span><div class="nb">' +
        '数据来自当前台账' + (live ? ' + 进行中通话' : '') + '。Kamailio 外呼桥接必须满足下列三值，否则 UFI 不认领或来显错误。</div></div>' +
        '<dl class="spec">' +
        '<dt>R-URI user</dt><dd class="mono">' + esc(imei) + ' <span style="color:var(--tx-3)">（UFI 注册名 / IMEI）</span></dd>' +
        '<dt>X-VOLTE</dt><dd class="mono">' + esc(peer) + ' <span style="color:var(--tx-3)">（真实被叫，写在自定义头）</span></dd>' +
        '<dt>Request 域</dt><dd class="mono">' + esc(host) + ' / ' + esc(ds.domain || '—') + '</dd>' +
        '<dt>From（来显）</dt><dd class="mono">由补丁 A 按 X-VOLTE / 主叫还原</dd>' +
        '</dl>' +
        '<pre style="margin-top:12px;font-size:12px;background:var(--bg-2);padding:10px;border-radius:8px;overflow:auto">INVITE sip:' + esc(imei) + '@' + esc(host) + ' SIP/2.0\n' +
        'To: &lt;sip:' + esc(imei) + '@' + esc(host) + '&gt;\n' +
        'X-VOLTE: ' + esc(peer) + '\n' +
        '# 选池：精确触发号 → _DEFAULT_&lt;VOS_gwid&gt; → 全局 _DEFAULT_</pre>',
        '<button class="btn primary" data-mact="ok">知道了</button>');
    }
  };

  function kpi(lb, vl, df, tone) {
    return '<div class="kpi ' + (tone || '') + '"><div class="lb">' + esc(lb) + '</div><div class="vl">' + vl + '</div><div class="df">' + esc(df) + '</div></div>';
  }

  /* ════════════════════════════════════════════════════════════ WIZARD */
  const Wizard = {
    open() {
      APP.wizard = { step: 1, imei: '', sim: '', pool: 'P1', carrier: '100', group: 'G1', plan: [] };
      /* 先挂载弹窗骨架，再渲染内容——否则 #wizBody 尚不存在 */
      Modal.open('新增 UFI 接入向导', '<div id="wizBody"></div>',
        '<button class="btn ghost" data-mact="close">取消</button>' +
        '<span class="sp"></span><button class="btn" id="wizPrev">上一步</button><button class="btn primary" id="wizNext">下一步</button>', true);
      Modal.onClose = () => { APP.wizard = null; };
      $('#wizPrev').addEventListener('click', () => this.go(-1));
      $('#wizNext').addEventListener('click', () => this.go(1));
      this.render();
    },
    render() {
      const w = APP.wizard;
      const steps = ['输入', '路由', 'SOP', '确认'];
      let body = '<div class="wiz-steps">' + steps.map((s, i) =>
        '<div class="wiz-step ' + (i + 1 === w.step ? 'on' : i + 1 < w.step ? 'ok' : '') + '"><span class="wn">' + (i + 1 < w.step ? '✓' : i + 1) + '</span><span class="wl">' + s + '</span></div>').join('') + '</div>';

      if (w.step === 1) {
        const dev = w.imei ? DB.ufiByImei(w.imei) : null;
        const cands = DB.search('', 8);
        body += '<div class="grid2">' +
          /* 左：从设备台账选 */
          '<div class="imei-pick" id="wizPick" style="min-width:0">' +
            '<div class="field"><label>选择设备（来自 UFI 管理模块台账）<span class="req">*</span></label>' +
            '<div class="searchbox"><span>' + I('search', 14) + '</span>' +
            '<input class="inp" id="wzImei" autocomplete="off" placeholder="IMEI 片段 / SIM / 型号，回车选中" value="' + esc(w.imei) + '"></div>' +
            '<div class="imei-drop" id="wizDrop"></div>' +
            '<span class="help">只能选择已纳管的设备。设备属性（IMEI / SIM / 信号）由 UFI 管理模块维护，此处只读。</span></div>' +
          '</div>' +
          /* 右：通信参数 */
          '<div class="field"><label>呼入被叫号码（DID）<span class="req">*</span></label>' +
          '<input class="inp mono" id="wzSim" placeholder="11 位" value="' + esc(w.sim) + '">' +
          '<span class="help">默认取设备 SIM 号，可改。我方写入 dbaliases；话机 DIDs 需客户在 VOS 界面追加。</span></div>' +
          '</div>' +
          (dev
            ? '<div class="dev-brief" style="margin-top:12px"><span class="db-imei">' + esc(dev.imei) + '</span>' +
              '<span><span class="db-k">SIM</span> <span class="db-v">' + esc(dev.sim) + '</span></span>' +
              '<span class="db-sep">|</span><span><span class="db-k">网络</span> <span class="db-v">' + esc(dev.net) + '</span></span>' +
              '<span class="db-sep">|</span><span><span class="db-k">频段</span> <span class="db-v">' + esc(dev.band) + '</span></span>' +
              '<span class="db-sep">|</span><span><span class="db-k">信号</span> <span class="db-v">' + dev.signal + ' 格</span></span>' +
              '<span class="db-sep">|</span><span><span class="db-k">SIP</span> <span class="db-v">' + (dev.registered ? '已注册' : '未注册') + '</span></span>' +
              '<span class="db-sep">|</span><span><span class="db-k">健康</span> <span class="db-v">' + dev.health + '</span></span>' +
              '</div>' +
              (dev.registered ? '<div class="note" style="margin-top:12px"><span class="ni">' + I('check-circle', 15) + '</span><div class="nb"><b>该设备已注册到 dSIPRouter</b>若只需调整通信归属（池 / 权重 / 并发 / 坐席绑定），在「线路池」与「坐席与班组」直接配置即可，无需重新开户。</div></div>'
                              : '<div class="note warn" style="margin-top:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>该设备尚未注册</b>继续则为我方新增开户任务（subscriber + dbaliases）。注册密码 = md5(IMEI)[:16]，自动生成。</div></div>')
            : '<div class="note plain" style="margin-top:12px"><span class="ni">' + I('info', 15) + '</span><div class="nb"><b>从台账中选择设备</b>共 ' + num(DB.ufis.length) + ' 台已纳管设备。输入任意片段即可模糊匹配，例如 ' +
              esc(cands.slice(0, 3).map(c => c.imei.slice(0, 7)).join(' / ')) + ' …</div></div>');
      }
      if (w.step === 2) {
        body += '<div class="grid2">' +
          '<div class="field"><label>加入线路池</label><select class="sel" id="wzPool">' +
          DB.POOLS.filter(p => p.enabled).map(p => '<option ' + (p.id === w.pool ? 'selected' : '') + ' value="' + p.id + '">' + p.id + ' · ' + esc(p.name) + '</option>').join('') + '</select>' +
          '<span class="help">池归属用于台账分组与筛选；选路实际按运营商组 gwlist 落地</span></div>' +
          '<div class="field"><label>运营商组（落地 VOS）</label><select class="sel" id="wzCarrier">' +
          (DB.carriers || [{ gwid: '100', name: 'VOS3000', address: '8.136.109.38' }]).map(c =>
            '<option ' + (c.gwid === (w.carrier || '100') ? 'selected' : '') + ' value="' + esc(c.gwid) + '">' + esc(c.name) + '（' + esc(c.address) + '）</option>').join('') + '</select>' +
          '<span class="help">该 UFI 的呼入落地到所选 VOS；新 VOS 在 dSIPRouter Carrier 页添加网关后自动出现在此列表</span></div>' +
        '</div>' +
          '<h4 style="font-size:12px;color:var(--tx-3);margin:16px 0 8px">执行计划（按责任方拆分）</h4>' +
          DB.sop.map(s => '<div class="sop-row" data-owner="' + s.owner + '">' +
            '<span class="sn">' + s.n + '</span>' +
            '<span class="tag ' + (s.owner === 'ours' ? 'ok' : 'warn') + '" style="width:52px;justify-content:center">' + (s.owner === 'ours' ? '我方' : '客户') + '</span>' +
            '<span class="ssys">' + esc(s.sys) + '</span>' +
            '<span class="scmd">' + esc(s.cmd.replace(/<IMEI>/g, w.imei || '‹IMEI›').replace(/<SIM>/g, w.sim || '‹SIM›')) + '</span>' +
            effBadge(s.ef) + '</div>').join('') +
          '<div class="note warn" style="margin-top:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>顺序提示</b>我方步骤（1/2/5）应先就绪，客户才能在 VOS 侧配置并拨测成功。若客户先配而我方未开户，UFI 不会注册。</div></div>';
      }
      if (w.step === 3) {
        const im = w.imei || '‹IMEI›', sm = w.sim || '‹SIM›';
        body += '<div class="note warn"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>责任划分</b>我方步骤（1/2/5）在自建 dSIPRouter 上执行，提交后由「执行我方待办」统一下发；VOS 步骤（3/4）属客户资产，<b>只生成指引单</b>，客户管理员在其界面手工配置。</div></div>' +
          '<h4 style="font-size:12px;color:var(--tx-3);margin:16px 0 8px">联调顺序（重要）</h4>' +
          '<div class="flow">' +
          '<div class="flow-node"><div class="fn-hd"><span class="n">1</span><b>我方先行就绪</b><span class="tag ok">我方</span></div>' +
          '<div class="fn-body" style="grid-template-columns:1fr"><div><div class="v" style="font-family:var(--ff-ui)">' +
          '在 dSIPRouter 上完成开户（' + esc(im) + '）、dbaliases 映射（' + esc(sm) + ' → ' + esc(im) + '）与 ufi_pool 入池。完成后 UFI 才能注册上线。</div></div></div></div>' +
          '<div class="flow-branch">' +
          '<div class="flow-node"><div class="fn-hd"><span class="n">2</span><b>客户在 VOS 侧配置</b><span class="tag warn">客户</span></div>' +
          '<div class="fn-body" style="grid-template-columns:1fr"><div><div class="v" style="font-family:var(--ff-ui)">' +
          '客户管理员收到指引单后，在其 VOS 界面追加 DIDs（' + esc(sm) + '、' + esc(im) + '）与号段授权（' + esc(sm) + '）。</div></div></div></div>' +
          '<div class="flow-node"><div class="fn-hd"><span class="n">3</span><b>我方拨测验收</b><span class="tag ok">我方 + 客户配合</span></div>' +
          '<div class="fn-body" style="grid-template-columns:1fr"><div><div class="v" style="font-family:var(--ff-ui)">' +
          '客户回填完成状态后，我方发起双向拨测：呼入验证来显与录音，呼出验证号段授权与线路承载。</div></div></div></div>' +
          '</div></div>' +
          '<div class="note danger" style="margin-top:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>顺序不能颠倒</b>若客户先配而我方尚未开户，UFI 不会注册到 dSIPRouter，客户配完也拨不通。反之我方先开户但客户未配，则能注册但呼入无振铃。</div></div>';
      }
      if (w.step === 4) {
        const im = w.imei || '‹IMEI›', sm = w.sim || '‹SIM›';
        const addDids = sm + ',' + im;
        body += '<div class="owner-split" style="margin-bottom:14px">' +
          /* 左：我方自动执行 */
          '<div class="os-card ours"><div class="os-hd"><span class="os-ico">' + I('server', 16) + '</span>' +
          '<div><b>我方自动执行</b><span class="os-sub">dSIPRouter · 提交即真实执行</span></div>' +
          '<span class="tag ok">' + I('check', 11) + '</span></div>' +
          '<div class="os-body"><p>以下操作在我方自建 dSIPRouter 上完成，无需客户参与。</p>' +
          '<div class="diff">' + diffLines([
            ['ctx', '# 提交后由自动同步引擎真实执行'],
            ['plus', "dsip_ufi_pool: imei='" + im + "'  sim='" + sm + "'  enabled=1  in_pool=1"],
            ['plus', "subscriber: username='" + im + "'  password=md5(IMEI)[:16]（幂等开户）"],
            ['plus', "dr_rules 8000: prefix='" + im + "' → gwlist=100（呼入→VOS）"],
            ['plus', "dr_rules 9000: prefix='" + sm + "' → gwlist=100（DID 映射）"],
            ['plus', 'kamcmd drouting.reload（有变更时自动执行）']
          ]) + '</div></div></div>' +
          /* 右：客户配置指引 */
          '<div class="os-card client"><div class="os-hd"><span class="os-ico">' + I('building', 16) + '</span>' +
          '<div><b>客户配置指引单</b><span class="os-sub">VOS3000 · 客户自行操作</span></div>' +
          '<span class="tag warn">2 份</span></div>' +
          '<div class="os-body"><p>我方<b>不执行</b>，以下为交付客户的操作说明。</p>' +
          '<div class="guide-where" style="margin-bottom:10px"><span class="gi">' + I('target', 14) + '</span><div><b>指引单一 · 话机 DIDs</b>VOS → 话机管理 → 话机 1002 → DIDs</div></div>' +
          '<div class="guide-steps" style="margin-bottom:12px">' +
          '<li>定位话机编号 1002</li><li>DIDs 字段末尾追加，用英文逗号分隔</li><li>保存后重载话务配置</li></div>' +
          '<div class="guide-caution"><span class="gi">' + I('alert', 14) + '</span><div><b>末尾追加以下值</b><span class="mono" style="word-break:break-all">' + esc(addDids) + '</span>（保留 VOS 上现有 DIDs 原值，以话机管理页实际列表为准）</div></div>' +
          '<div class="guide-where" style="margin:12px 0 10px"><span class="gi">' + I('target', 14) + '</span><div><b>指引单二 · 外呼前缀（一次性，非逐号）</b>VOS → 网关 → dsip接入</div></div>' +
          '<div class="guide-steps"><li>确认「网关前缀 / 呼出号段」为生产通配 <span class="mono">1,0,400,800</span></li>' +
          '<li>若仍是完整 11 位号码列表，请整表改为上述前缀（不要再追加 ' + esc(sm) + '）</li>' +
          '<li>保存后重载话务配置；此后任意被叫无需再改 VOS 号段</li></div>' +
          '</div></div></div>' +
          '<div class="note plain"><span class="ni">' + I('info', 15) + '</span><div class="nb"><b>提交后发生什么</b>我方 2 项进入「变更任务 · 我方待办」；客户侧仅需「话机 DIDs」+（若尚未通配）「外呼前缀一次性」指引。新增被叫号码不必再出 VOS 号段任务。</div></div>';
      }
      $('#wizBody').innerHTML = body;

      if (w.step === 1) {
        const ie = $('#wzImei'), se = $('#wzSim');
        const wrap = $('#wizPick'), drop = $('#wizDrop');
        if (ie) {
          /* 从设备台账模糊检索：只能选已纳管设备 */
          const show = kw => {
            const list = DB.search(kw, 20);
            this._wizOpts = list;
            drop.innerHTML = list.length ? list.map((u, i) =>
              '<div class="imei-opt' + (i === 0 ? ' hl' : '') + '" data-imei="' + u.imei + '">' +
              '<span class="io-imei">' + hl(u.imei, kw) + '</span>' +
              '<span class="io-meta">' + hl(u.sim || '—', kw) + ' · ' + esc(u.net) + ' · ' + esc(u.band) +
              (u.registered ? ' · <em>已注册</em>' : ' · 未注册') + '</span>' +
              '<span class="io-right"><span class="tag mono">' + u.pool_id + '</span></span></div>').join('')
              : '<div class="idp-hint">未匹配到设备，请确认该设备已在 UFI 管理模块纳管</div>';
            wrap.classList.add('on');
          };
          ie.addEventListener('focus', () => show(ie.value));
          ie.addEventListener('input', () => show(ie.value));
          ie.addEventListener('keydown', e => {
            if (e.key === 'Escape') { wrap.classList.remove('on'); return; }
            if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
            e.preventDefault();
            const list = this._wizOpts || [];
            if (e.key === 'ArrowDown') {
              this._wizHl = Math.min(list.length - 1, (this._wizHl || 0) + 1);
              $$('#wizDrop .imei-opt').forEach((el, i) => el.classList.toggle('hl', i === this._wizHl));
              return;
            }
            const pick = list[this._wizHl || 0];
            if (!pick) { toast('请从台账中选择设备', '通信配置只能关联已纳管设备', 'warn'); return; }
            w.imei = pick.imei;
            w.sim = w.sim || pick.sim;
            wrap.classList.remove('on');
            this.render();
          });
          drop.addEventListener('click', ev => {
            const o = ev.target.closest('[data-imei]');
            if (!o) return;
            const pick = DB.ufiByImei(o.dataset.imei);
            w.imei = pick.imei;
            w.sim = w.sim || pick.sim;
            wrap.classList.remove('on');
            this.render();
          });
          document.addEventListener('click', ev => {
            if (!ev.target.closest('#wizPick')) wrap.classList.remove('on');
          });
        }
        if (se) se.addEventListener('input', e => { w.sim = e.target.value.replace(/\D/g, ''); });
      }
      if (w.step === 2) {
        $('#wzPool') && $('#wzPool').addEventListener('change', e => { w.pool = e.target.value; this.render(); });
        $('#wzCarrier') && $('#wzCarrier').addEventListener('change', e => { w.carrier = e.target.value; this.render(); });
      }
      $('#wizPrev').disabled = w.step === 1;
      $('#wizNext').textContent = w.step === 4 ? '确认加入待生效' : '下一步';
      $('#wizPrev').style.display = w.step === 1 ? 'none' : '';
    },
    go(d) {
      const w = APP.wizard;
      /* 已在第 4 步再点「下一步」＝确认提交 */
      if (d > 0 && w.step === 4) { this.commit(); return; }
      const nw = w.step + d;
      if (nw < 1 || nw > 4) return;
      if (nw > 1 && !w.imei) { toast('请先从台账中选择设备', '通信配置只能关联已纳管设备', 'err'); return; }
      if (nw > 1 && !DB.exists(w.imei)) { toast('该 IMEI 不在设备台账中', '请确认设备已在 UFI 管理模块纳管', 'err'); return; }
      if (nw > 1 && !/^1\d{10}$/.test(w.sim)) { toast('DID 需 11 位且以 1 开头', '', 'err'); return; }
      w.step = nw;
      this.render();
    },
    commit() {
      const w = APP.wizard;
      const snap = DB.snapshot;
      const newDids = snap.phone.dids + ',' + w.sim + ',' + w.imei;
      const recPrefix = (snap.vos && snap.vos.prefix_recommended) || '1,0,400,800';
      const curPrefix = String((snap.vos && snap.vos.prefix) || '');
      /* 已是短前缀通配（无 11 位完整号）则不再生成号段任务 */
      const prefixOk = !/(^|,)\d{11}(,|$)/.test(curPrefix) && /(?:^|,)(1|0|400|800)(?:,|$)/.test(curPrefix);
      /* 我方可执行：开户 / dbaliases 为人工/脚本操作 → 待办留痕；入池由 GUI 真实落库 */
      const ours = [
        { owner: 'ours', ef: 'live', sys: 'dSIPRouter', title: '开户 + dbaliases：' + w.imei,
          target: 'subscriber / dbaliases', detail: "dsip_add_ufi.py " + w.imei + ' ' + w.sim },
        { owner: 'ours', ef: 'live', sys: 'dSIPRouter', title: '池 ' + w.pool + ' 入池：' + w.imei,
          target: 'dsip_ufi_pool（GUI 落库）', detail: "sim=" + w.sim + " enabled=1 in_pool=1 weight=1 max_concurrent=2" }
      ];
      /* 客户侧：呼入 DIDs 每次追加；外呼前缀仅在仍是逐号模式时出一次性指引 */
      const client = [
        { owner: 'client', ef: 'client', sys: 'VOS3000', title: '话机 1002 追加 DIDs（2 个号码）',
          target: 'VOS 管理界面 → 话机管理 → 话机 1002 → DIDs',
          guide: ['登录客户 VOS3000 管理界面', '进入「话机管理 / 分机管理」，定位话机编号 1002',
            '在 DIDs 字段末尾追加，用英文逗号分隔', '保存后按客户规范重载话务配置'],
          caution: '追加后的完整值：' + newDids + '。原有号码必须保留，覆盖会导致现有呼入中断。',
          verify: '从外线拨打 ' + w.sim + ' 与 ' + w.imei + '，坐席 1002 应正常振铃。' }
      ];
      if (!prefixOk && !DB.pending.some(p => p.title && p.title.indexOf('外呼前缀通配') >= 0)) {
        client.push({
          owner: 'client', ef: 'client', sys: 'VOS3000', title: '外呼前缀通配（生产一次性，勿逐号）',
          target: 'VOS 管理界面 → 网关管理 → dsip接入（ID 1001）→ 网关前缀/呼出号段',
          guide: ['打开 dsip接入 网关', '确认 IP 认证，对端 106.75.29.22',
            '将网关前缀/呼出号段改为 ' + recPrefix + '（替换现有完整号码列表，不要再追加单个 11 位号）',
            '保存后重载话务配置'],
          caution: '当前联调值「' + curPrefix + '」是逐号白名单，每加一个被叫都会无可用路由。改为前缀后任意国内被叫无需再改 VOS。',
          verify: '坐席拨一个未单独配置过的手机号，CDR 被叫经由=dsip接入，且无「无可用路由」。'
        });
      }
      /* 入池：真实写入 dsip_ufi_pool（通信属性），失败则中止提交 */
      const dev = DB.ufiByImei(w.imei);
      DB.saveComm(w.imei, {
        sim: w.sim, pool_id: w.pool, carrier: w.carrier || '100', enabled: 1, in_pool: 1,
        weight: 1, max_concurrent: 2, note: '向导入池 ' + new Date().toISOString().slice(0, 10)
      }).then((r) => {
        if (dev) { dev.pool_id = w.pool; dev.in_pool = true; dev.enabled = true; dev.sim = w.sim; DB.reindex(); }
        ours.concat(client).forEach(a => DB.addPending(a));
        Modal.close();
        Pool.render();
        const sy = (r && r.route_sync) || {};
        toast('已入池，路由已自动同步', w.imei + ' → 池 ' + w.pool + ' · VOS#' + (w.carrier || '100') +
          ' · 呼入规则 +' + ((sy.rules_added || []).length) + '/-' + ((sy.rules_removed || []).length) +
          ' · DID 映射 +' + ((sy.imaps_added || []).length) + '/-' + ((sy.imaps_removed || []).length) +
          ' · SIP 账号校准 ' + (sy.subscribers_ensured || 0) +
          (sy.reloaded ? ' · 已 reload' : ' · 路由无变更'), 'ok', 6500);
        Nav.go('pend');
      }).catch(e => {
        toast('入池失败', String(e.message || e), 'err', 5200);
      });
    }
  };

  function diffLines(rows) {
    return rows.map((r, i) => '<div class="dl ' + r[0] + '"><span class="gn">' + (i + 1) + '</span><span class="tx">' +
      (r[0] === 'plus' ? '+ ' : r[0] === 'minus' ? '- ' : '  ') + esc(r[1]) + '</span></div>').join('');
  }
  /* ════════════════════════════════════════════════════════════ 通用弹窗 */
  const Dialog = {
    /* 生成客户配置指引单：预览 → 确认入库 → 可复制发给客户 */
    guide(key) {
      const t = DB.guideTpl[key];
      if (!t) { toast('未找到指引模板', key, 'err'); return; }
      const item = DB.addPending({
        owner: 'client', ef: 'client', sys: 'VOS3000',
        title: t.title, target: t.where,
        guide: t.steps, caution: t.caution, verify: t.verify
      });
      Modal.open('客户配置指引单 · ' + t.title,
        '<div class="note warn" style="margin-bottom:14px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>我方无执行权限</b>VOS3000 是客户资产。此单为<b>操作说明</b>而非命令，请交付客户管理员在其管理界面执行，完成后回填并由我方拨测验收。</div></div>' +
        '<div class="guide-where"><span class="gi">' + I('target', 15) + '</span><div><b>操作位置</b>' + esc(t.where) + '</div></div>' +
        '<ol class="guide-steps">' + t.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
        (t.caution ? '<div class="guide-caution"><span class="gi">' + I('alert', 15) + '</span><div><b>注意事项</b>' + esc(t.caution) + '</div></div>' : '') +
        (t.verify ? '<div class="guide-verify"><span class="gi">' + I('check-circle', 15) + '</span><div><b>验收方法</b>' + esc(t.verify) + '</div></div>' : '') +
        '<div class="note plain" style="margin-top:12px"><span class="ni">' + I('info', 15) + '</span><div class="nb"><b>菜单名称提示</b>客户 VOS 版本不同，菜单路径可能略有差异。若客户找不到对应菜单，请其系统管理员按功能名称定位，或向我方反馈以便调整指引。</div></div>',
        '<button class="btn primary" data-mact="ok">存入待客户配置</button><button class="btn ghost" data-mact="close">取消</button>', true);
      Modal.onOk = () => {
        toast('指引单已生成', t.title + ' — 可在「变更任务 · 待客户配置」中复制发送', 'ok', 4000);
        Pend.render();
        Nav.go('pend');
      };
      void item;
    },
    /* 一次性生成呼入侧全部指引单（IVR + 队列 + 时段） */
    /* 一期：一次生成呼入/呼出两条基础指引单 */
    guideAll() {
      const keys = ['vos_dids', 'vos_prefix'];
      let n = 0;
      keys.forEach(k => {
        const t = DB.guideTpl[k];
        if (!t || DB.pending.some(p => p.title === t.title)) return;
        DB.addPending({
          owner: 'client', ef: 'client', sys: 'VOS3000',
          title: t.title, target: t.where, guide: t.steps, caution: t.caution, verify: t.verify
        });
        n++;
      });
      if (!n) { toast('指引单已齐全', '话机 DIDs 与外呼前缀通配两项均已生成过', 'warn'); return; }
      toast('已生成 ' + n + ' 份指引单', '话机 DIDs / 外呼前缀通配（一次性），可批量复制发客户', 'ok', 4200);
      Nav.go('pend');
    },
    backup() {
      toast('我方配置已备份', 'kamailio.cfg + subscriber/dbaliases/ufi_pool dump → backup-20261007-1006（不含客户设备）', 'ok', 4200);
      Pend.log('$ backup-20261007-1006  我方资产：kamailio.cfg + kamailio DB dump（不涉及客户 VOS）', 'ok');
    },
    rollback() {
      const ours = DB.pending.filter(p => p.owner === 'ours' && p.state === 'pending').length;
      Modal.open('回滚我方 dSIPRouter 配置',
        '<div class="note warn" style="margin-bottom:12px"><span class="ni">' + I('alert', 15) + '</span><div class="nb"><b>回滚会丢失</b>上次备份之后的所有我方改动。当前有 <b>' + ours + '</b> 项我方待办未执行，回滚后需重新配置。</div></div>' +
        '<div class="note plain"><span class="ni">' + I('info', 15) + '</span><div class="nb"><b>回滚范围</b>仅限我方资产：kamailio.cfg 与 kamailio 数据库（subscriber / dbaliases / ufi_pool）。<b>客户 VOS 不在我方回滚范围内</b>，需客户自行回退。</div></div>' +
        '<dl class="spec" style="margin-top:14px"><dt>备份名</dt><dd>backup-20261007-1006</dd><dt>内容</dt><dd>kamailio.cfg, kamailio DB dump</dd><dt>范围</dt><dd>我方 dSIPRouter（106.75.29.22）</dd></dl>',
        '<button class="btn" data-mact="close">取消</button><button class="btn danger" id="rbGo">确认回滚我方配置</button>');
      $('#rbGo').addEventListener('click', () => {
        Modal.close();
        Pend.log('$ rollback backup-20261007-1006  （我方 dSIPRouter，不含客户 VOS）', 'wr');
        Pend.log('  ✓ kamailio.cfg 与 kamailio DB 已恢复；kamailio 已重启', 'ok');
        Pend.log('  ! 客户 VOS 侧如有变更，需客户自行回退', 'wr');
        toast('我方配置已回滚', '客户 VOS 侧如有变更需客户自行回退', 'warn', 4600);
      });
    }
  };

  /* ════════════════════════════════════════════════════════════ CALLS (通话记录) */
  const Calls = {
    init() {
      const bind = (sel, key, ev) => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener(ev || 'change', () => {
          APP.callsFilter[key] = (el.value || '').trim();
          APP.callsPage = 1;
          this.reload();
        });
      };
      const imei = $('#callsImei');
      if (imei) {
        let t = null;
        imei.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => {
            APP.callsFilter.imei = imei.value.trim();
            APP.callsPage = 1;
            this.reload();
          }, 320);
        });
        imei.addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          clearTimeout(t);
          APP.callsFilter.imei = imei.value.trim();
          APP.callsPage = 1;
          this.reload();
        });
      }
      bind('#callsCarrier', 'carrier');
      bind('#callsFrom', 'from');
      bind('#callsTo', 'to');
      bind('#callsResult', 'result');
      bind('#callsDir', 'dir');
      const clr = $('#callsClear');
      if (clr) clr.addEventListener('click', () => {
        APP.callsFilter = { imei: '', carrier: '', from: '', to: '', result: '', dir: '' };
        APP.callsPage = 1;
        ['#callsImei', '#callsCarrier', '#callsFrom', '#callsTo', '#callsResult', '#callsDir'].forEach(s => {
          const el = $(s); if (el) el.value = '';
        });
        this.reload();
      });
      const body = $('#callsBody');
      if (body) {
        bindListCopyHelpers(body);
        body.addEventListener('click', e => {
          if (e.target.closest('button,a,input,label')) return;
          if (shouldSkipRowNav(e)) return;
          const tr = e.target.closest('tr[data-ci]');
          if (!tr) return;
          const c = (DB.callPage.calls || [])[Number(tr.dataset.ci)];
          if (c) openCallChain(c);
        });
      }
    },

    fillCarriers() {
      const sel = $('#callsCarrier');
      if (!sel) return;
      const cur = APP.callsFilter.carrier || sel.value || '';
      const opts = ['<option value="">全部运营商组</option>'].concat(
        (DB.carriers || []).map(c =>
          '<option value="' + esc(c.gwid) + '"' + (String(c.gwid) === String(cur) ? ' selected' : '') + '>' +
          esc(c.name || ('VOS#' + c.gwid)) + '（' + esc(c.gwid) + '）</option>')
      );
      sel.innerHTML = opts.join('');
      if (cur) sel.value = cur;
    },

    async reload() {
      if (APP.callsLoading) return;
      APP.callsLoading = true;
      const cnt = $('#callsCount');
      if (cnt) cnt.textContent = '加载中…';
      try {
        await DB.loadCalls({
          imei: APP.callsFilter.imei,
          carrier: APP.callsFilter.carrier,
          from: APP.callsFilter.from,
          to: APP.callsFilter.to,
          result: APP.callsFilter.result,
          dir: APP.callsFilter.dir,
          page: APP.callsPage,
          pageSize: APP.callsSize
        });
        this.render();
      } catch (e) {
        if (cnt) cnt.textContent = '加载失败';
        const body = $('#callsBody');
        if (body) body.innerHTML = '<tr><td colspan="9"><div class="note warn" style="margin:12px"><span class="ni">' +
          I('alert', 15) + '</span><div class="nb"><b>加载失败</b>' + esc(String(e.message || e)) + '</div></div></td></tr>';
        toast('通话记录加载失败', String(e.message || e), 'err');
      } finally {
        APP.callsLoading = false;
      }
    },

    render() {
      this.fillCarriers();
      const page = DB.callPage || { total: 0, page: 1, pages: 1, calls: [] };
      APP.callsPage = page.page || 1;
      APP.callsSize = page.pageSize || APP.callsSize;
      const list = page.calls || [];
      const body = $('#callsBody');
      const cnt = $('#callsCount');
      const hint = $('#callsHint');
      const tabCnt = $('#cntCalls');
      if (tabCnt) tabCnt.textContent = num(page.total || 0);
      if (cnt) {
        const f = APP.callsFilter;
        const filtered = !!(f.imei || f.carrier || f.from || f.to || f.result || f.dir);
        cnt.textContent = '共 ' + num(page.total || 0) + ' 条' + (filtered ? ' · 已筛选' : '');
      }
      if (hint) hint.textContent = '按开始时间倒序 · 第 ' + (page.page || 1) + '/' + (page.pages || 1) + ' 页';
      if (!body) return;
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="9"><div style="padding:28px;text-align:center;color:var(--tx-3)">暂无匹配的通话记录</div></td></tr>';
        this.pager(page);
        return;
      }
      body.innerHTML = list.map((c, i) => {
        const oc = CALL_OUTCOME[c.outcome] || CALL_OUTCOME.unanswered;
        const detail = c.failReason || c.result || c.routeCallId || c.traceId || '—';
        return '<tr class="clickable-row" data-ci="' + i + '" title="点击查看通话过程链路">' +
          '<td class="mono">' + esc(fmtTs(c.at)) + '</td>' +
          '<td><span class="tag ' + (c.dir === 'out' ? 'info' : '') + '">' + (c.dir === 'out' ? '呼出' : '呼入') + '</span></td>' +
          '<td class="mono">' + esc(c.peer) + '</td>' +
          '<td class="mono">' + esc(c.imei) + '</td>' +
          '<td><span class="tag mono" title="' + esc(DB.carrierName(c.carrier)) + '">' +
            esc(DB.carrierLabel(c.carrier)) + '</span></td>' +
          '<td class="mono">' + esc(c.pool) + '</td>' +
          '<td><span class="tag ' + oc.cls + '">' + oc.label + '</span></td>' +
          '<td class="num mono">' + (c.answered ? fmtDur(c.dur) : '—') + '</td>' +
          '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx-3)">' +
            esc(detail) + '</td></tr>';
      }).join('');
      this.pager(page);
      Nav.icons();
    },

    pager(page) {
      const el = $('#callsPager');
      if (!el) return;
      const total = page.total || 0;
      const pages = Math.max(1, page.pages || 1);
      const p = page.page || 1;
      let h = '<span class="info">' + num(total) + ' 条</span>' +
        '<select class="sel sm" id="callsSize" style="margin-left:10px">' +
        [25, 50, 100, 200].map(n =>
          '<option ' + (APP.callsSize === n ? 'selected' : '') + '>' + n + '</option>').join('') +
        '</select>' +
        '<div class="pages">' +
        '<button class="pg" data-cpg="' + (p - 1) + '" ' + (p <= 1 ? 'disabled' : '') + '>‹</button>';
      const set = new Set([1, pages, p, p - 1, p + 1, p - 2, p + 2]);
      const arr = Array.from(set).filter(x => x >= 1 && x <= pages).sort((a, b) => a - b);
      let last = 0;
      arr.forEach(x => {
        if (x - last > 1) h += '<span style="color:var(--tx-3);padding:0 2px">…</span>';
        h += '<button class="pg ' + (x === p ? 'on' : '') + '" data-cpg="' + x + '">' + x + '</button>';
        last = x;
      });
      h += '<button class="pg" data-cpg="' + (p + 1) + '" ' + (p >= pages ? 'disabled' : '') + '>›</button></div>';
      el.innerHTML = h;
      $$('#callsPager [data-cpg]').forEach(b => b.addEventListener('click', () => {
        if (b.disabled) return;
        APP.callsPage = +b.dataset.cpg;
        this.reload();
      }));
      const sz = $('#callsSize');
      if (sz) sz.addEventListener('change', e => {
        APP.callsSize = +e.target.value;
        APP.callsPage = 1;
        this.reload();
      });
    }
  };

  /* ════════════════════════════════════════════════════════════ RENDERER */
  const Renderer = {
    render(v) {
      if (v === 'topo') Topo.render();
      else if (v === 'pool') Pool.render();
      else if (v === 'calls') Calls.reload();
      else if (v === 'route') Route.render();
      else if (v === 'pend') Pend.render();
      /* 侧栏计数 */
      $('#cntPool').textContent = DB.ufis.filter(u => u.in_pool).length;
      $('#cntDid').textContent = DB.DID_ROUTES.length;
      const cc = $('#cntCalls');
      if (cc && DB.callPage) cc.textContent = num(DB.callPage.total || 0);
      /* 设备台账联动状态 */
      const dl = $('#cntDevLink');
      if (dl) {
        dl.textContent = num(DB.ufis.length);
        dl.classList.toggle('hot', false);
      }
      const ntl = $('#navToDev');
      if (ntl) ntl.style.opacity = DB.DEVICE_LINKED ? '' : '.55';
      const lt = $('#linkTag');
      if (lt) {
        const errMsg = String(DB.LOAD_ERROR || '');
        lt.textContent = DB.DEVICE_LINKED
          ? '台账已联动 · ' + num(DB.ufis.length) + ' 台'
          : (errMsg ? '数据加载失败 · ' + (errMsg.length > 42 ? errMsg.slice(0, 42) + '…' : errMsg) : '台账未联动');
        lt.title = DB.DEVICE_LINKED ? '' : (errMsg || '未检测到设备台账，请确认 UFI 管理模块已有设备');
        lt.className = 'tag ' + (DB.DEVICE_LINKED ? 'ok' : 'err');
      }
    }
  };

  /* ════════════════════════════════════════════════════════════ 动作总线 */
  function bindActions() {
    const A = {
      refresh: async () => {
        try {
          await DB.reload();
          Renderer.render(APP.view);
          toast('已刷新', '台账 / 拓扑 / 路由已同步', 'ok', 1800);
        } catch (e) {
          toast('刷新失败', String(e.message || e), 'err');
        }
      },
      'calls-refresh': () => Calls.reload(),
      'diag-invite': () => Topo.diagInvite(),
      'apply-all': () => Pend.apply(),
      'go-pending': () => Nav.go('pend'),
      wizard: () => Wizard.open(),
      'in-time': () => { Nav.go('inbound'); toast('时段规则在页面下方', '', 'info', 2200); },
      'in-ivr': () => { Nav.go('inbound'); },
      'in-ivr-edit': () => Dialog.ivrEdit(),
      'guide-all': () => Dialog.guideAll(),
      'copy-all-guide': () => Pend.copyAll(),
      'open-guide': k => Dialog.guide(k),
      'clear-log': () => { $('#applyLog').innerHTML = '<span class="dim"># 尚无执行记录。点「执行我方待办」开始。</span>'; },
      backup: () => Dialog.backup(),
      rollback: () => Dialog.rollback(),
      'sys-save': () => {
        DB.addPending({ owner: 'ours', ef: 'reload', sys: 'dSIPRouter', title: '我方对接参数保存',
          target: 'dSIPRouter address / cfg', detail: 'IP 认证 port=0；kamcmd permissions.addressReload' });
        toast('已入我方待办', 'reload 即可生效，不涉及客户设备', 'info');
        Nav.go('pend');
      }
    };
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      e.preventDefault();
      const a = A[t.dataset.act];
      if (a) { a(); return; }
      if (t.dataset.ivr !== undefined) Dialog.ivrEdit();
    });
    /* 生成指引单：需带 data-guide 键 */
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-act="gen-guide"]');
      if (!t || !t.dataset.guide) return;
      e.preventDefault();
      Dialog.guide(t.dataset.guide);
    });
  }

  /* ════════════════════════════════════════════════════════════ BOOT */
  async function boot() {
    Nav.init();
    bindActions();
    Pool.init();
    Calls.init();
    Route.init();
    DB.loadPending();
    Pend.init();
    Renderer.render(APP.view);

    /* 时钟 */
    setInterval(() => { $('#clock').textContent = fmtTime(new Date()); }, 1000);

    /* 初始拉取真实数据（设备台账 + 通信属性 + dbaliases + 呼叫记录） */
    try {
      await DB.reload();
    } catch (e) {
      DB.LOAD_ERROR = String(e.message || e);
      DB.BOOT_FAILED = true;
      toast('数据加载失败', DB.LOAD_ERROR + ' — 请确认已登录且 /api/v1/ufi/comm 可达', 'err', 6500);
    }
    Renderer.render(APP.view);

    /* 定时同步真实数据（10s）；paused 时不刷新 */
    APP.timer = setInterval(async () => {
      if (APP.paused || document.hidden) return;
      if (hasTextSelection()) return;
      try { await DB.reload(); } catch (e) { return; }
      if (DB.BOOT_FAILED) {
        DB.BOOT_FAILED = false;
        DB.LOAD_ERROR = '';
        Renderer.render(APP.view);
        if (APP.view === 'pool') Pool.render();
        else if (APP.view === 'topo') Topo.render();
        else if (APP.view === 'route') Route.render();
        toast('数据连接已恢复', '台账与线路状态已重新加载', 'ok', 2600);
      }
      if (APP.view === 'topo') Topo.render();
      else if (APP.view === 'pool') {
        /* 正在编辑策略表单时不重绘，避免冲掉下拉选择 / 保存操作 */
        if (!Pool.isEditingStrat() && !Modal.isOpen()) Pool.renderReal();
      }
      const cp = $('#cntPool');
      if (cp) cp.textContent = DB.ufis.filter(u => u.in_pool).length;
      const cd = $('#cntDid');
      if (cd) cd.textContent = DB.DID_ROUTES.length;
    }, 10000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();