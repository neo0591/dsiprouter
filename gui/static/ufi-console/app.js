/* ============================================================================
   UFI Management Console — Application
   Views: 总览 / 设备监控 / 指令下发 / 日志与记录
   ========================================================================= */

(function () {
  'use strict';

  let S = UFI.Store;
  const M = UFI.META;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, size, cls) => window.Icon.svg(n, size, cls);

  /* ---------------- Formatters ---------------- */
  const fmtInt = n => Number(n).toLocaleString('en-US');
  const fmtPct = n => n.toFixed(1) + '%';

  function fmtAgo(ms) {
    const d = Math.max(0, Date.now() - ms);
    const s = Math.floor(d / 1000);
    if (s < 10) return '刚刚';
    if (s < 60) return s + ' 秒前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  function fmtDur(sec) {
    if (!sec) return '—';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? m + '分' + String(s).padStart(2, '0') + '秒' : s + '秒';
  }

  function fmtTime(ms) {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDateTime(ms) {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtBytes(mb) {
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return mb + ' MB';
  }

  /** Open cloud reverse-proxy to device local admin (never uses device private IP). */
  function openAdminProxy(imei) {
    const d = S.device(imei);
    if (!d) return;
    const path = d.adminProxyUrl || d.adminProxyPath ||
      ('/api/v1/ufi/devices/' + encodeURIComponent(imei) + '/admin-proxy/');
    if (!d.tunnelReady || !d.wsOnline) {
      Toast.show(
        'warn',
        '反向管理隧道未就绪',
        '设备需有外网并完成 Tunnel-Register。现场无外网时可连 SoftAP 打开 ' + (d.softApUrl || 'http://192.168.43.1:8080')
      );
      return;
    }
    window.open(path, '_blank', 'noopener');
    Toast.show('ok', '已打开云端反向管理', '经 WebSocket 代理访问设备本地管理台，不暴露设备私网 IP');
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* ---------------- Toast ---------------- */
  const Toast = {
    host: null,
    init() { this.host = $('#toasts'); },
    show(kind, title, msg) {
      const map = { ok: 'check-circle', err: 'x-circle', warn: 'alert', info: 'info' };
      const el = document.createElement('div');
      el.className = 'toast toast--' + (kind === 'info' ? 'info' : kind);
      el.innerHTML =
        '<span class="toast__icon">' + icon(map[kind] || 'info') + '</span>' +
        '<div class="toast__body"><div class="toast__title">' + esc(title) + '</div>' +
        (msg ? '<div class="toast__msg">' + esc(msg) + '</div>' : '') + '</div>';
      this.host.appendChild(el);
      setTimeout(() => {
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 220);
      }, 3600);
    }
  };

  /* ==========================================================================
     VIEW 1 — OVERVIEW
     ========================================================================== */

  const Overview = {
    render() {
      const st = S.stats();
      this.renderKpi(st);
      this.renderHealth(st);
      this.renderSignal();
      this.renderOperator();
      this.renderBand();
      this.renderNetType();
      this.renderEvents();
    },

    renderKpi(st) {
      const cards = [
        {
          key: 'all', label: '设备总数', value: fmtInt(st.total), unit: '台',
          foot: '<span class="kpi__delta kpi__delta--up">' + icon('trend-up') + ' 较昨日 +3.2%</span>',
          accent: 'var(--dsip-blue)'
        },
        {
          key: 'online', label: '在线设备', value: fmtInt(st.online), unit: '台',
          foot: '<span>' + fmtPct(st.onlineRate) + ' 在线率</span>',
          accent: 'var(--st-ok)',
          bar: [[st.online, 'var(--st-ok)'], [st.offline, 'var(--st-err)']]
        },
        {
          key: 'volte', label: 'VoLTE 已注册', value: fmtPct(st.volteRate),
          foot: '<span class="muted">' + fmtInt(st.volte) + ' 台 / 未注册 ' + fmtInt(st.total - st.volte) + '</span>',
          accent: 'var(--net-4g)',
          bar: [[st.volte, 'var(--net-4g)'], [st.total - st.volte, '#dfe4e9']]
        },
        {
          key: 'sip', label: 'SIP 已注册', value: fmtPct(st.sipRate),
          foot: '<span class="muted">掉注册 <b style="color:var(--st-err)">' + fmtInt(st.sipDown) + '</b> 台</span>',
          accent: 'var(--net-5g)',
          bar: [[st.sip, 'var(--net-5g)'], [st.sipDown, 'var(--st-err)']]
        },
        {
          key: 'warn', label: '预警设备', value: fmtInt(st.warn + st.crit), unit: '台',
          foot: '<span class="muted">健康 ' + fmtInt(st.ok) + ' · 严重 ' + fmtInt(st.crit) + '</span>',
          accent: 'var(--st-warn)',
          bar: [[st.ok, 'var(--st-ok)'], [st.warn, 'var(--st-warn)'], [st.crit, 'var(--st-err)']]
        },
        {
          key: 'signal', label: '弱信号 / 无服务', value: fmtInt(st.weak), unit: '台',
          foot: '<span class="muted">无服务 ' + fmtInt(st.none) + ' · 强信号 ' + fmtInt(st.strong) + '</span>',
          accent: 'var(--st-err)',
          bar: [[st.strong, 'var(--st-ok)'], [st.weak, 'var(--st-warn)'], [st.none, '#dfe4e9']]
        }
      ];

      $('#kpiStrip').innerHTML = cards.map(c => {
        const bar = c.bar ? '<div class="kpi__bar">' + c.bar.map(([v, col]) => {
          const tot = c.bar.reduce((a, x) => a + x[0], 0) || 1;
          return '<i style="width:' + (v / tot * 100).toFixed(2) + '%;background:' + col + '"></i>';
        }).join('') + '</div>' : '';
        return '<button class="kpi" data-kpi="' + c.key + '" style="--kpi-accent:' + c.accent + '">' +
          '<div class="kpi__head">' + esc(c.label) + '</div>' +
          '<div class="kpi__value">' + esc(c.value) + (c.unit ? '<span class="kpi__unit">' + c.unit + '</span>' : '') + '</div>' +
          '<div class="kpi__foot">' + c.foot + '</div>' + bar + '</button>';
      }).join('');

      $$('#kpiStrip .kpi').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.kpi;
        Nav.go('devices');
        if (k === 'online') Devices.applyPreset('online');
        else if (k === 'volte') Devices.applyPreset('volte-down');
        else if (k === 'sip') Devices.applyPreset('sip-down');
        else if (k === 'warn') Devices.applyPreset('alert');
        else if (k === 'signal') Devices.applyPreset('weak');
        else Devices.applyPreset('all');
      }));
    },

    renderHealth(st) {
      const rows = [
        { label: '健康', n: st.ok, color: 'var(--st-ok)' },
        { label: '预警', n: st.warn, color: 'var(--st-warn)' },
        { label: '严重', n: st.crit, color: 'var(--st-err)' },
        { label: '离线', n: st.offline, color: 'var(--st-idle)' }
      ];
      const tot = st.total || 1;
      $('#healthDist').innerHTML = rows.map(r =>
        '<div class="dist__row">' +
        '<span class="dist__label">' + r.label + '</span>' +
        '<span class="dist__track"><i class="dist__fill" style="width:' + (r.n / tot * 100).toFixed(1) + '%;background:' + r.color + '"></i></span>' +
        '<span class="dist__val">' + fmtInt(r.n) + '<small>' + (r.n / tot * 100).toFixed(1) + '%</small></span>' +
        '</div>'
      ).join('');

      $('#healthIssues').innerHTML = [
        ['VoLTE 未注册', st.volteDown, 'var(--st-err)'],
        ['SIP 掉注册', st.sipDown, 'var(--st-warn)'],
        ['SIM 待解锁', st.simLocked, 'var(--st-warn)'],
        ['CPU 高负载', st.cpuHigh, 'var(--st-warn)'],
        ['存储紧张', st.storageHigh, 'var(--st-warn)'],
        ['飞行模式', st.flight, 'var(--st-idle)']
      ].map(([name, n, col]) =>
        '<div class="minilist__row">' +
        '<span class="minilist__name"><span class="dot" style="background:' + col + ';display:inline-block;margin-right:6px"></span>' + name + '</span>' +
        '<span class="minilist__bar"><i style="width:' + (n / tot * 100 * 4).toFixed(1) + '%;background:' + col + '"></i></span>' +
        '<span class="minilist__num">' + fmtInt(n) + '</span>' +
        '</div>'
      ).join('');
    },

    renderSignal() {
      const b = S.bySignal();
      const labels = ['无信号', '差', '中', '好', '优'];
      const colors = ['var(--sig-0)', 'var(--sig-1)', 'var(--sig-2)', 'var(--sig-3)', 'var(--sig-4)'];
      const max = Math.max.apply(null, b) || 1;
      $('#sigChart').innerHTML = b.map((n, i) =>
        '<div class="sigchart__col">' +
        '<div class="sigchart__bar" style="height:' + Math.max(3, n / max * 78) + '%;background:' + colors[i] + '"><span>' + fmtInt(n) + '</span></div>' +
        '<div class="sigchart__label">' + labels[i] + '</div>' +
        '</div>'
      ).join('');
    },

    renderOperator() {
      const list = S.byOperator().slice(0, 6);
      const max = list[0] ? list[0].n : 1;
      $('#operatorList').innerHTML = list.map(o =>
        '<div class="minilist__row">' +
        '<span class="minilist__name" title="' + esc(o.name) + '">' + esc(o.name) + '</span>' +
        '<span class="minilist__bar"><i style="width:' + (o.n / max * 100).toFixed(1) + '%"></i></span>' +
        '<span class="minilist__num">' + fmtInt(o.n) + '</span>' +
        '</div>'
      ).join('');
    },

    renderBand() {
      const list = S.byBand();
      const max = list[0] ? list[0].n : 1;
      $('#bandList').innerHTML = list.map(o =>
        '<div class="minilist__row">' +
        '<span class="minilist__name"><span class="netchip netchip--4g" style="margin-right:6px">' + esc(o.name) + '</span></span>' +
        '<span class="minilist__bar"><i style="width:' + (o.n / max * 100).toFixed(1) + '%;background:var(--net-4g)"></i></span>' +
        '<span class="minilist__num">' + fmtInt(o.n) + '</span>' +
        '</div>'
      ).join('');
    },

    renderNetType() {
      const m = S.byNetType();
      const tot = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      const order = [['5G', 'netchip--5g'], ['4G', 'netchip--4g'], ['3G', 'netchip--3g'], ['WLAN', 'netchip--wifi'], ['NONE', 'netchip--none'], ['Flight mode', 'netchip--flight']];
      $('#netTypeList').innerHTML = order.map(([k, cls]) =>
        '<div class="minilist__row">' +
        '<span class="minilist__name"><span class="netchip ' + cls + '" style="margin-right:6px">' + esc(M.NET_LABEL[k] || k) + '</span></span>' +
        '<span class="minilist__bar"><i style="width:' + ((m[k] || 0) / tot * 100).toFixed(1) + '%"></i></span>' +
        '<span class="minilist__num">' + fmtInt(m[k] || 0) + '</span>' +
        '</div>'
      ).join('');
    },

    renderEvents() {
      const kindMap = { ok: 'ok', warn: 'warn', err: 'err' };
      const iconFor = (e) => {
        const t = (e.tag || e.title || '') + ' ' + (e.source || '');
        if (/短信/.test(t)) return 'message';
        if (/拒接|通话|呼/.test(t)) return 'phone';
        if (/掉线|心跳|离线|恢复/.test(t)) return 'wifi-off';
        if (/注册|SIP|VoLTE/.test(t)) return 'antenna';
        if (/SIM/.test(t)) return 'sim-lock';
        if (/CPU|存储|资源/.test(t)) return 'cpu';
        if (/日志/.test(t)) return 'file';
        return e.kind === 'ok' ? 'check-circle' : 'alert';
      };
      const list = (S.events || []).slice(0, 12);
      const el = $('#eventFeed');
      if (!el) return;
      if (!list.length) {
        el.innerHTML = '<div class="empty" style="padding:24px">' + icon('bell') +
          '<h4 class="empty__title">暂无事件</h4>' +
          '<p class="empty__desc">设备通话 / 短信过程、心跳掉线、SIP 掉注册等会显示在这里。</p></div>';
        return;
      }
      el.innerHTML = list.map(e => {
        const badge = e.tag || e.sn || '';
        const lv = kindMap[e.kind] || (e.kind === 'err' ? 'err' : e.kind === 'warn' ? 'warn' : 'ok');
        return '<div class="feed__item">' +
          '<div class="feed__mark feed__mark--' + lv + '">' + icon(iconFor(e)) + '</div>' +
          '<div class="feed__card">' +
          '<div class="feed__top">' +
          '<span class="feed__title">' + esc(e.title) + '</span>' +
          (badge ? '<span class="badge badge--' + lv + '">' + esc(badge) + '</span>' : '') +
          '<span class="feed__time">' + fmtAgo(e.ts) + '</span>' +
          '</div>' +
          '<div class="feed__body">' + esc(e.desc || '—') + '</div>' +
          '<div class="feed__kv"><div><dt>IMEI</dt><dd class="mono-sm">' + esc(e.imei) + '</dd></div></div>' +
          '</div></div>';
      }).join('');
    }
  };

  /* ==========================================================================
     VIEW 2 — DEVICE MONITOR (the core surface, thousands of rows)
     ========================================================================== */

  const Devices = {
    filtered: [],
    selected: new Set(),
    page: 1,
    pageSize: 50,
    sortKey: 'health',
    sortDir: 1, // 1 asc, -1 desc
    filters: {
      q: '', severity: new Set(), volte: null, sip: null, net: new Set(),
      sig: null, op: '', band: ''
    },
    live: true,

    COLUMNS: [
      { key: 'imei', label: 'IMEI / SN', ident: true, sortable: true },
      { key: 'lteStatus', label: '核心网', sortable: true },
      { key: 'cellularStatus', label: '网络 / Band', sortable: true },
      { key: 'cellularSignalLevel', label: '信号', sortable: true },
      { key: 'volteRegisterStatus', label: 'VoLTE', sortable: true },
      { key: 'voipRegisterStatus', label: 'SIP', sortable: true },
      { key: 'wfcStatus', label: 'WFC / 加密', sortable: true },
      { key: 'operatorName', label: '运营商 / IMSI', sortable: true },
      { key: 'simState', label: 'SIM', sortable: true },
      { key: 'res', label: '资源', sortable: true },
      { key: 'health', label: '健康度', sortable: true }
    ],

    init() {
      this.applyFilters();
      this.bindToolbar();
      /* 表头用事件委托绑定一次即可，#checkAll 由 renderHead() 动态生成 */
      $('#gridHead').addEventListener('click', e => {
        const th = e.target.closest('th[data-sort]'); if (!th) return;
        const k = th.dataset.sort;
        if (this.sortKey === k) this.sortDir *= -1;
        else { this.sortKey = k; this.sortDir = k === 'health' ? -1 : 1; }
        this.applyFilters(); this.render();
      });
      $('#gridHead').addEventListener('change', e => {
        if (!e.target.matches('#checkAll')) return;
        const rows = this.pageRows();
        if (e.target.checked) rows.forEach(d => this.selected.add(d.imei));
        else rows.forEach(d => this.selected.delete(d.imei));
        this.render();
      });
      this.bindBody();
    },

    bindBody() {
      $('#gridBody').addEventListener('click', e => {
        /* row action buttons */
        const btn = e.target.closest('button[data-act]');
        if (btn) {
          const imei = btn.closest('tr').dataset.imei;
          const act = btn.dataset.act;
          e.stopPropagation();
          if (act === 'detail') Drawer.open(imei);
          else if (act === 'admin') openAdminProxy(imei);
          else if (act === 'cmd') Commands.open([imei]);
          else if (act === 'esim') Commands.openEsim([imei]);
          else if (act === 'logs') Commands.openLog([imei]);
          else if (act === 'settings') Settings.open([imei]);
          else if (act === 'del') Commands.removeDevice(imei);
          return;
        }
        /* row click → detail (unless a control was hit) */
        if (e.target.closest('input,select,label')) return;
        const tr = e.target.closest('tr[data-imei]');
        if (tr) Drawer.open(tr.dataset.imei);
      });

      $('#gridBody').addEventListener('change', e => {
        const cb = e.target.closest('input[type="checkbox"][data-row]');
        if (!cb) return;
        const imei = cb.dataset.row;
        cb.checked ? this.selected.add(imei) : this.selected.delete(imei);
        this.syncSelectionUI();
      });
    },

    bindToolbar() {
      const q = $('#devSearch');
      q.addEventListener('input', () => {
        this.filters.q = q.value.trim().toLowerCase();
        this.page = 1;
        this.applyFilters();
        this.render();
      });
      $('#devSearchClear').addEventListener('click', () => {
        q.value = ''; this.filters.q = ''; this.page = 1; this.applyFilters(); this.render();
      });

      $('#sevChips').addEventListener('click', e => {
        const c = e.target.closest('.chip'); if (!c) return;
        const v = c.dataset.sev;
        this.filters.severity.has(v) ? this.filters.severity.delete(v) : this.filters.severity.add(v);
        this.page = 1; this.applyFilters(); this.render();
      });
      $('#netChips').addEventListener('click', e => {
        const c = e.target.closest('.chip'); if (!c) return;
        const v = c.dataset.net;
        this.filters.net.has(v) ? this.filters.net.delete(v) : this.filters.net.add(v);
        this.page = 1; this.applyFilters(); this.render();
      });
      $('#sigChips').addEventListener('click', e => {
        const c = e.target.closest('.chip'); if (!c) return;
        const v = Number(c.dataset.sig);
        this.filters.sig = this.filters.sig === v ? null : v;
        this.page = 1; this.applyFilters(); this.render();
      });

      $('#fRegVolte').addEventListener('change', e => {
        this.filters.volte = e.target.checked ? '1' : null; this.page = 1; this.applyFilters(); this.render();
      });
      $('#fRegSip').addEventListener('change', e => {
        this.filters.sip = e.target.checked ? '1' : null; this.page = 1; this.applyFilters(); this.render();
      });
      $('#fOp').addEventListener('change', e => { this.filters.op = e.target.value; this.page = 1; this.applyFilters(); this.render(); });
      $('#fBand').addEventListener('change', e => { this.filters.band = e.target.value; this.page = 1; this.applyFilters(); this.render(); });

      $('#btnResetFilters').addEventListener('click', () => this.resetFilters());
      $('#btnExportCsv').addEventListener('click', () => this.exportCsv());

      /* batch */
      $('#batchbar').addEventListener('click', e => {
        const b = e.target.closest('button[data-batch]'); if (!b) return;
        const act = b.dataset.batch;
        const list = [...this.selected];
        if (act === 'clear') { this.selected.clear(); this.render(); return; }
        if (act === 'cmd') { Commands.open(list); return; }
        if (act === 'esim') { Commands.openEsim(list); return; }
        if (act === 'logs') { Commands.openLog(list); return; }
        if (act === 'export') {
          Toast.show('ok', '已生成导出任务', list.length + ' 台设备的快照正在打包（CSV）');
          return;
        }
        if (act === 'reboot') {
          Confirm.ask({
            title: '批量重启 ' + list.length + ' 台设备',
            body: '将通过 WebSocket 下发 <code>cmd=reboot</code>（Ufi-Get-Cmd-Request）。设备先回 ACK，约 1.5 秒后执行 PowerManager.reboot，期间通话会中断。',
            danger: true,
            confirmText: '确认重启',
            onOk: () => Toast.show('ok', '指令已入队', fmtInt(list.length) + ' 台设备等待 ACK 应答')
          });
        }
      });

      /* pagination */
      $('#pageList').addEventListener('click', e => {
        const b = e.target.closest('.page-btn'); if (!b || b.disabled) return;
        const p = b.dataset.page;
        if (p === 'prev') this.page = Math.max(1, this.page - 1);
        else if (p === 'next') this.page = Math.min(this.totalPages(), this.page + 1);
        else this.page = Number(p);
        this.render();
        $('#tableScroll').scrollTop = 0;
      });
      $('#pageSize').addEventListener('change', e => {
        this.pageSize = Number(e.target.value); this.page = 1; this.render();
      });
    },

    bindHead() {
      /* 已由 init() 内的事件委托取代，保留空方法以兼容旧调用 */
    },

    totalPages() { return Math.max(1, Math.ceil(this.filtered.length / this.pageSize)); },
    pageRows() {
      const start = (this.page - 1) * this.pageSize;
      return this.filtered.slice(start, start + this.pageSize);
    },

    key(d) {
      switch (this.sortKey) {
        case 'res': return Number(d.cpuUseRate) + Number(d.memoryUseRate);
        case 'cellularSignalLevel': return Number(d.cellularSignalLevel);
        case 'health': return d.health;
        default: return d[this.sortKey];
      }
    },

    applyFilters() {
      const f = this.filters;
      let list = S.devices;

      if (f.q) {
        const q = f.q;
        list = list.filter(d =>
          d.imei.indexOf(q) >= 0 || d.sn.toLowerCase().indexOf(q) >= 0 ||
          d.imsi.indexOf(q) >= 0 || d.cellularNetwork.toLowerCase().indexOf(q) >= 0 ||
          d.simNumber.indexOf(q) >= 0 || d.cellularStatus.toLowerCase().indexOf(q) >= 0 ||
          (d.operatorName || '').toLowerCase().indexOf(q) >= 0
        );
      }
      if (f.severity.size) list = list.filter(d => f.severity.has(d.severity));
      if (f.volte) list = list.filter(d => d.volteRegisterStatus === f.volte);
      if (f.sip) list = list.filter(d => d.voipRegisterStatus === f.sip);
      if (f.net.size) list = list.filter(d => f.net.has(d.cellularStatus));
      if (f.sig !== null) list = list.filter(d => Number(d.cellularSignalLevel) === f.sig);
      if (f.op) list = list.filter(d => (d.operatorName || d.cellularNetwork) === f.op);
      if (f.band) list = list.filter(d => d.band === f.band);

      list = list.slice().sort((a, b) => {
        const va = this.key(a), vb = this.key(b);
        if (va === vb) return 0;
        return (va > vb ? 1 : -1) * this.sortDir;
      });

      this.filtered = list;
      if (this.page > this.totalPages()) this.page = this.totalPages();
    },

    resetFilters() {
      this.filters = { q: '', severity: new Set(), volte: null, sip: null, net: new Set(), sig: null, op: '', band: '' };
      $('#devSearch').value = '';
      $('#fRegVolte').checked = false;
      $('#fRegSip').checked = false;
      $('#fOp').value = '';
      $('#fBand').value = '';
      this.page = 1;
      this.applyFilters();
      this.render();
    },

    applyPreset(name) {
      this.resetFilters();
      const f = this.filters;
      if (name === 'alert') f.severity = new Set(['warn', 'err']);
      else if (name === 'weak') { f.sig = 1; }
      else if (name === 'volte-down') f.volte = '0';
      else if (name === 'sip-down') f.sip = '0';
      else if (name === 'offline') f.severity = new Set(['err']);
      this.page = 1;
      this.applyFilters();
      this.render();
      Devices.syncChipRow();
    },

    /* reflect state back into chip UI */
    syncChipRow() {
      const f = this.filters;
      $$('#sevChips .chip').forEach(c => {
        const on = f.severity.has(c.dataset.sev);
        c.classList.toggle('is-on', on);
        c.classList.toggle('is-on--ok', on && c.dataset.sev === 'ok');
        c.classList.toggle('is-on--warn', on && c.dataset.sev === 'warn');
        c.classList.toggle('is-on--err', on && c.dataset.sev === 'err');
      });
      $$('#netChips .chip').forEach(c => c.classList.toggle('is-on', f.net.has(c.dataset.net)));
      $$('#sigChips .chip').forEach(c => c.classList.toggle('is-on', f.sig === Number(c.dataset.sig)));
      $('#fRegVolte').checked = f.volte === '1';
      $('#fRegSip').checked = f.sip === '1';
      $('#fOp').value = f.op || '';
      $('#fBand').value = f.band || '';
    },

    render() {
      this.renderChips();
      this.renderFilterBar();
      this.renderHead();
      this.renderBody();
      this.renderPager();
      this.syncSelectionUI();
    },

    renderChips() {
      /* recompute chip counters against the FULL fleet (not filtered) */
      const st = S.stats();
      const sev = { ok: st.ok, warn: st.warn, err: st.crit };
      $$('#sevChips .chip').forEach(c => { $('.chip__n', c).textContent = fmtInt(sev[c.dataset.sev] || 0); });
      const nt = S.byNetType();
      $$('#netChips .chip').forEach(c => { $('.chip__n', c).textContent = fmtInt(nt[c.dataset.net] || 0); });
      const sb = S.bySignal();
      $$('#sigChips .chip').forEach(c => { $('.chip__n', c).textContent = fmtInt(sb[Number(c.dataset.sig)] || 0); });

      const ops = ['<option value="">全部运营商</option>'].concat(
        S.byOperator().map(o => '<option value="' + esc(o.name) + '">' + esc(o.name) + '（' + o.n + '）</option>')
      ).join('');
      const curOp = $('#fOp').value;
      $('#fOp').innerHTML = ops;
      $('#fOp').value = curOp;

      const bands = ['<option value="">全部 Band</option>'].concat(
        S.byBand().map(b => '<option value="' + esc(b.name) + '">' + esc(b.name) + '（' + b.n + '）</option>')
      ).join('');
      const curBand = $('#fBand').value;
      $('#fBand').innerHTML = bands;
      $('#fBand').value = curBand;
    },

    renderFilterBar() {
      const f = this.filters;
      const tags = [];
      if (f.severity.size) tags.push('健康度：' + [...f.severity].map(s => ({ ok: '健康', warn: '预警', err: '严重' }[s])).join(' / '));
      if (f.net.size) tags.push('网络类型：' + [...f.net].map(n => M.NET_LABEL[n] || n).join(' / '));
      if (f.sig !== null) tags.push('信号级别 = ' + ['无信号', '差', '中', '好', '优'][f.sig]);
      if (f.volte) tags.push('VoLTE 已注册');
      if (f.sip) tags.push('SIP 已注册');
      if (f.op) tags.push('运营商：' + f.op);
      if (f.band) tags.push('Band：' + f.band);
      if (f.q) tags.push('关键词：' + f.q);

      const bar = $('#filterbar');
      if (!tags.length) { bar.classList.add('u-hidden'); return; }
      bar.classList.remove('u-hidden');
      $('#filterTags').innerHTML = tags.map(t => '<span class="chip">' + esc(t) + '</span>').join('');
      $('#filterCount').textContent = fmtInt(this.filtered.length);
    },

    renderHead() {
      const ths = this.COLUMNS.map(c => {
        const sorted = this.sortKey === c.key;
        return '<th class="' + (c.ident ? 'col-ident ' : '') + (c.sortable ? 'sortable ' : '') + (sorted ? 'is-sorted' : '') +
          '" ' + (c.sortable ? 'data-sort="' + c.key + '"' : '') + ' scope="col">' +
          '<span class="th-inner">' + esc(c.label) +
          (c.sortable ? '<span class="sort-ind">' + (sorted ? (this.sortDir === 1 ? '▲' : '▼') : '⇅') + '</span>' : '') +
          '</span></th>';
      }).join('');
      $('#gridHead').innerHTML =
        '<tr><th class="col-check"><input type="checkbox" id="checkAll" aria-label="全选本页"></th>' + ths +
        '<th class="col-actions u-text-r" scope="col">操作</th></tr>';
      $('#checkAll').addEventListener('change', e => {
        const rows = this.pageRows();
        if (e.target.checked) rows.forEach(d => this.selected.add(d.imei));
        else rows.forEach(d => this.selected.delete(d.imei));
        this.render();
      });
    },

    renderBody() {
      const rows = this.pageRows();
      if (!rows.length) {
        $('#gridBody').innerHTML = '<tr><td colspan="' + (this.COLUMNS.length + 2) + '">' +
          '<div class="empty">' + icon('search') +
          '<h4 class="empty__title">没有匹配的设备</h4>' +
          '<p class="empty__desc">请调整筛选条件或清空搜索关键词。</p>' +
          '<button class="btn" id="emptyReset">清空全部筛选</button>' +
          '</div></td></tr>';
        $('#emptyReset').addEventListener('click', () => this.resetFilters());
        return;
      }

      $('#gridBody').innerHTML = rows.map(d => {
        const sel = this.selected.has(d.imei);
        const rowCls = ['is-selected', d.severity === 'err' ? 'is-alert' : d.severity === 'warn' ? 'is-alert-warn' : ''].filter(Boolean).join(' ');
        const netCls = { '5G': 'netchip--5g', '4G': 'netchip--4g', '3G': 'netchip--3g', 'WLAN': 'netchip--wifi', 'NONE': 'netchip--none', 'Flight mode': 'netchip--flight' }[d.cellularStatus] || 'netchip--none';

        /* core network */
        const lteOk = d.lteStatus === 'LTE-Connect';
        const lteHb = d.lteStatus === 'LTE-HeartBeat';
        const lteTip = lteOk ? '设备与核心网数据链路正常'
          : lteHb ? '设备在线，LTE 数据链路空闲，仅靠周期心跳维持在线；有通话或流量时自动恢复连接'
          : '设备与核心网失去连接';
        const lteHtml =
          '<span class="u-row u-gap-2">' +
          '<span class="dot ' + (lteOk || lteHb ? 'dot--ok dot--live' : 'dot--err') + '"></span>' +
          '<span class="badge badge--' + (lteOk || lteHb ? 'ok' : 'err') + '" title="' + lteTip + '">' +
          (lteOk ? '已连接' : lteHb ? '心跳保活' : '已断开') + '</span></span>';

        /* signal bars */
        const sig = Math.min(Number(d.cellularSignalLevel), 4);
        const sigTxt = ['无信号', '差', '中', '好', '优'][sig] || '—';
        const sigHtml = sig === 0
          ? '<span class="u-row u-gap-2"><span class="sigbars" data-lvl="0"><i></i><i></i><i></i><i></i></span><span class="sigbars__txt">' + sigTxt + '</span></span>'
          : '<span class="u-row u-gap-2"><span class="sigbars" data-lvl="' + sig + '"><i></i><i></i><i></i><i></i></span>' +
          '<span class="cell-stack"><span class="mono-sm">' + (d.rsrp == null ? '—' : d.rsrp + ' dBm') + '</span>' +
          '<span class="cell-sub">RSRQ ' + (d.rsrq == null ? '—' : d.rsrq + 'dB') + '</span></span></span>';

        /* registration pills */
        const pill = (v, onLabel, offLabel) => v === '1'
          ? '<span class="badge badge--ok badge--dot">' + onLabel + '</span>'
          : '<span class="badge badge--err badge--dot">' + offLabel + '</span>';

        /* resources */
        const cpu = Number(d.cpuUseRate), mem = Number(d.memoryUseRate), sto = Number(d.storageUseRate);
        const tube = (label, v) => {
          const cls = v >= 88 ? 'is-err' : v >= 70 ? 'is-warn' : '';
          return '<span class="resbar"><span class="resbar__tube ' + cls + '"><i style="height:' + Math.max(3, v) + '%"></i></span>' +
            '<span class="resbar__cap">' + label + '</span></span>';
        };
        const resHtml = '<span class="resbars" title="CPU ' + cpu + '% / 内存 ' + mem + '% / 存储 ' + sto + '%">' +
          tube('C', cpu) + tube('M', mem) + tube('S', sto) + '</span>';

        /* health */
        const hCol = d.health >= 85 ? 'var(--st-ok)' : d.health >= 60 ? 'var(--st-warn)' : 'var(--st-err)';
        const healthHtml = '<span class="score"><span class="score__bar"><i style="width:' + d.health + '%;background:' + hCol + '"></i></span>' +
          '<span class="score__num" style="color:' + hCol + '">' + d.health + '</span></span>';

        return '<tr data-imei="' + d.imei + '" class="' + rowCls + '">' +
          '<td class="col-check"><input type="checkbox" data-row="' + d.imei + '"' + (sel ? ' checked' : '') + ' aria-label="选择 ' + d.imei + '"></td>' +
          '<td class="cell-ident"><div class="cell-stack">' +
          '<span class="cell-imei">' + esc(d.imei) + (d.severity === 'err' && d.issues.length ? '<span class="dot dot--err" title="' + esc(d.issues.join('、')) + '"></span>' : '') + '</span>' +
          '<span class="cell-sub">' + esc(d.sn) + ' · ' + esc(d.apkVersion) + '</span>' +
          '<span class="cell-sub" title="buildNumber">' + esc(d.buildNumber || '—') + '</span>' +
          '</div></td>' +
          '<td>' + lteHtml + '</td>' +
          '<td><div class="cell-stack"><span class="u-row u-gap-2">' +
          '<span class="netchip ' + netCls + '">' + esc(M.NET_LABEL[d.cellularStatus] || d.cellularStatus) + '</span>' +
          (d.networkType === 'wifi' ? '<span class="mono-sm" title="' + esc(d.wlanName) + '">' + icon('wifi', 13) + '</span>' : '') +
          '</span><span class="cell-sub">Band ' + esc(d.band) + ' · EARFCN ' + esc(d.serviceCellEARFCN) + '</span></div></td>' +
          '<td>' + sigHtml + '</td>' +
          '<td>' + pill(d.volteRegisterStatus, '已注册', '未注册') + '</td>' +
          '<td>' + pill(d.voipRegisterStatus, '已注册', d.sipregeststatus === 'none' ? '不适用' : '未注册') + '</td>' +
          '<td><div class="cell-stack"><span class="mono-sm">WFC ' + (d.wfcStatus === '1' ? 'ON' : 'OFF') + '</span>' +
          '<span class="cell-sub">' + esc(d.encryptionType.toUpperCase()) + ' / ' + esc(d.transportProtocol) + '</span></div></td>' +
          '<td><div class="cell-stack"><span class="mono-sm">' + esc(d.operatorName || d.cellularNetwork) + '</span>' +
          '<span class="cell-sub">' + esc(d.cellularNetwork) + ' · ' + esc(d.imsi) + '</span></div></td>' +
          '<td><div class="cell-stack"><span class="badge badge--' + (d.simState === 'READY' ? 'ok' : d.simState === 'PIN_REQUIRED' ? 'warn' : 'idle') + '">' + esc(d.simState === 'READY' ? '正常' : d.simState === 'PIN_REQUIRED' ? '待解锁' : '无卡') + '</span>' +
          '<span class="cell-sub">' + esc(d.simType.toUpperCase()) + ' · ' + (d.simNumber ? esc(d.simNumber) : '—') + '</span></div></td>' +
          '<td>' + resHtml + '</td>' +
          '<td>' + healthHtml + '</td>' +
          '<td class="col-actions u-text-r"><span class="rowacts">' +
          '<button type="button" class="btn btn--icon btn--sm" data-act="detail" title="查看详情">' + icon('eye') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm' + (d.tunnelReady ? '' : ' is-muted') + '" data-act="admin" title="' +
            (d.tunnelReady ? '云端反向打开设备管理台' : '隧道未就绪（无外网时用 SoftAP ' + esc(d.softApUrl) + '）') + '">' + icon('globe') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm" data-act="cmd" title="下发指令">' + icon('terminal') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm" data-act="esim" title="下发 eSIM Profile">' + icon('sim') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm" data-act="logs" title="获取日志">' + icon('file') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm" data-act="settings" title="设备设置">' + icon('sliders') + '</button>' +
          '<button type="button" class="btn btn--icon btn--sm btn--danger" data-act="del" title="删除设备（含全部记录与日志文件）">' + icon('trash') + '</button>' +
          '</span></td></tr>';
      }).join('');
    },

    renderPager() {
      const total = this.filtered.length;
      const tp = this.totalPages();
      const start = total ? (this.page - 1) * this.pageSize + 1 : 0;
      const end = Math.min(this.page * this.pageSize, total);

      $('#pagerInfo').innerHTML = '显示 <b>' + fmtInt(start) + '–' + fmtInt(end) + '</b> / 共 <b>' + fmtInt(total) +
        '</b> 台 · 全量 <b>' + fmtInt(S.devices.length) + '</b> 台';

      /* windowed page numbers */
      const nums = [];
      const push = n => nums.push(n);
      if (tp <= 7) { for (let i = 1; i <= tp; i++) push(i); }
      else {
        push(1);
        if (this.page > 3) nums.push('…');
        for (let i = Math.max(2, this.page - 1); i <= Math.min(tp - 1, this.page + 1); i++) push(i);
        if (this.page < tp - 2) nums.push('…');
        push(tp);
      }
      $('#pageList').innerHTML =
        '<button class="page-btn" data-page="prev"' + (this.page === 1 ? ' disabled' : '') + ' aria-label="上一页">' + icon('chevron-left') + '</button>' +
        nums.map(n => n === '…'
          ? '<span class="page-ellipsis">…</span>'
          : '<button class="page-btn' + (n === this.page ? ' is-active' : '') + '" data-page="' + n + '">' + n + '</button>').join('') +
        '<button class="page-btn" data-page="next"' + (this.page === tp ? ' disabled' : '') + ' aria-label="下一页">' + icon('chevron') + '</button>';
    },

    syncSelectionUI() {
      const n = this.selected.size;
      const bar = $('#batchbar');
      bar.classList.toggle('is-on', n > 0);
      $('#batchCount').textContent = fmtInt(n);
      const rows = this.pageRows();
      const allSel = rows.length > 0 && rows.every(d => this.selected.has(d.imei));
      const ca = $('#checkAll');
      if (ca) { ca.checked = allSel; ca.indeterminate = !allSel && rows.some(d => this.selected.has(d.imei)); }
    },

    exportCsv() {
      const cols = ['imei', 'sn', 'lteStatus', 'cellularStatus', 'operatorName', 'cellularNetwork', 'cellularSignalLevel', 'band', 'serviceCellEARFCN',
        'volteRegisterStatus', 'voipRegisterStatus', 'wfcStatus', 'websocketStatus', 'networkType', 'wlanName',
        'imsi', 'simType', 'simState', 'cpuUseRate', 'memoryUseRate', 'storageUseRate',
        'linphoneProcessStatus', 'apkVersion', 'sipServerAddress', 'transportProtocol', 'encryptionType', 'health'];
      const rows = this.selected.size
        ? S.devices.filter(d => this.selected.has(d.imei))
        : this.filtered;
      const csv = [cols.join(',')].concat(
        rows.map(d => cols.map(c => '"' + String(d[c] == null ? '' : d[c]).replace(/"/g, '""') + '"').join(','))
      ).join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ufi-fleet-' + (this.selected.size ? 'selected' : 'filtered') + '-' + rows.length + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      Toast.show('ok', '导出完成', fmtInt(rows.length) + ' 条设备记录已下载为 CSV');
    }
  };

  /* ==========================================================================
     DRAWER — device detail
     ========================================================================== */

  const Drawer = {
    imei: null,
    tab: 'spec',
    historyPushed: false,
    onPop: null,

    init() {
      $('#drawerScrim').addEventListener('click', () => this.close());
      $('#drawerClose').addEventListener('click', () => this.close());
      document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if ($('#drawer').classList.contains('is-open')) this.close();
        else if ($$('.modal-scrim.is-open').length) Modal.closeAll();
      });
      $('#drawerTabs').addEventListener('click', e => {
        const t = e.target.closest('.tab'); if (!t) return;
        this.setTab(t.dataset.tab);
      });
      $('#drawerHeadActions').addEventListener('click', e => {
        const b = e.target.closest('button[data-dact]'); if (!b) return;
        const act = b.dataset.dact;
        if (act === 'admin') openAdminProxy(this.imei);
        else if (act === 'esim') Commands.openEsim([this.imei]);
        else if (act === 'cmd') Commands.open([this.imei]);
        else if (act === 'settings') Settings.open([this.imei]);
        else if (act === 'log') Commands.openLog([this.imei]);
      });

      /* 关闭按钮/遮罩/ESC 均走此通道，popstate 时静默收起抽屉 */
      this.onPop = () => { if ($('#drawer').classList.contains('is-open')) this.close(true); };
      window.addEventListener('popstate', this.onPop);
    },

    setTab(tab) {
      this.tab = tab;
      $$('#drawerTabs .tab').forEach(x => x.classList.toggle('is-active', x.dataset.tab === tab));
      $$('#drawerBody .tabpane').forEach(p => p.classList.toggle('is-active', p.dataset.pane === tab));
      /* 展开抽屉内所有日志块时不强制滚动，保持阅读位置 */
    },

    open(imei) {
      const wasOpen = $('#drawer').classList.contains('is-open');
      this.imei = imei;
      const d = S.device(imei);
      if (!d) return;
      const r = S.recordsFor(imei);

      $('#drawerId').textContent = d.imei;
      $('#drawerMeta').innerHTML = esc(d.sn) + ' · ' + esc(d.operatorName || d.cellularNetwork) + ' · ' + esc(d.cellularStatus) + ' · APK ' + esc(d.apkVersion);

      /* KPI mini strip */
      const st = Number(d.cellularSignalLevel);
      $('#drawerStrip').innerHTML = [
        ['核心网', d.lteStatus === 'LTE-Connect' ? '已连接' : d.lteStatus === 'LTE-HeartBeat' ? '心跳保活' : '已断开', d.lteStatus === 'LTE-Connect' || d.lteStatus === 'LTE-HeartBeat' ? 'ok' : 'err', d.lteStatus === 'LTE-HeartBeat' ? '设备在线，LTE 数据链路空闲，仅周期心跳维持在线；有业务时自动恢复' : ''],
        ['VoLTE', d.volteRegisterStatus === '1' ? '已注册' : '未注册', d.volteRegisterStatus === '1' ? 'ok' : 'err'],
        ['SIP', d.voipRegisterStatus === '1' ? '已注册' : '未注册', d.voipRegisterStatus === '1' ? 'ok' : 'err'],
        ['信号', st === 0 ? '无信号' : ['', '差', '中', '好', '优'][st], st === 0 ? 'err' : st === 1 ? 'warn' : 'ok'],
        ['Band', d.band, 'info'],
        ['健康度', String(d.health), d.severity]
      ].map(([k, v, s]) =>
        '<div class="spec"><div class="spec__k">' + esc(k) + '</div>' +
        '<div class="spec__v"><span class="badge badge--' + s + '">' + esc(v) + '</span></div></div>'
      ).join('');

      /* Spec panes */
      $('#paneSpec').innerHTML = this.specHtml(d);
      $('#paneReg').innerHTML = this.regHtml(d);
      $('#paneCalls').innerHTML = this.recordsHtml(r.calls, 'call');
      $('#paneSms').innerHTML = this.recordsHtml(r.sms, 'sms');
      $('#paneLogs').innerHTML = this.logsHtml(r.logs, d) + this.filesHtml(S.files.filter(f => f.imei === imei), d);

      /* tab counters */
      $('#tabCallsN').textContent = r.calls.length;
      $('#tabSmsN').textContent = r.sms.length;
      $('#tabLogsN').textContent = r.logs.length;

      this.setTab(this.tab);

      $('#drawerScrim').classList.add('is-open');
      $('#drawer').classList.add('is-open');
      $('#drawer').setAttribute('aria-hidden', 'false');
      $('#drawerBody').scrollTop = 0;

      /* 支持浏览器返回键 / 鼠标侧键收起抽屉（真实界面常见诉求） */
      if (!wasOpen) {
        try { history.pushState({ ufiDrawer: imei }, ''); this.historyPushed = true; } catch (_) { this.historyPushed = false; }
      }
    },

    close(fromPop) {
      if (!this.historyPushed || fromPop) this.historyPushed = false;
      else this.historyPushed = false;
      $('#drawerScrim').classList.remove('is-open');
      $('#drawer').classList.remove('is-open');
      $('#drawer').setAttribute('aria-hidden', 'true');
      if (!fromPop && history.state && history.state.ufiDrawer) {
        try { history.back(); } catch (_) { }
      }
    },

    specHtml(d) {
      const rows = [
        ['设备 SN', d.sn], ['厂商设备类型', d.agentType], ['Android 构建号', d.buildNumber],
        ['IMSI', d.imsi], ['SIM 卡类型', d.simType.toUpperCase()], ['SIM 状态', d.simState],
        ['SIM 号码', d.simNumber], ['国家码', d.areaNumber],
        ['驻网状态', d.cellularStatus], ['驻网归属', (d.operatorName || d.cellularNetwork) + (d.cellularNetwork && d.operatorName !== d.cellularNetwork ? '（' + d.cellularNetwork + '）' : '')],
        ['默认网络类型', d.networkType], ['已连接 WLAN', d.wlanName || '—'],
        ['注册小区 EARFCN', d.serviceCellEARFCN], ['Band', d.band],
        ['RSRP', d.rsrp == null ? '—' : d.rsrp + ' dBm'], ['RSRQ', d.rsrq == null ? '—' : d.rsrq + ' dB'],
        ['SIP Server', d.sipServerAddress], ['SIP 端口', d.sipServerPort],
        ['传输协议', d.transportProtocol], ['加密方式', d.encryptionType],
        ['热点状态', d.ufiHotpotstaus === 'ON' ? '开启（' + d.hotspotName + '）' : '关闭'],
        ['短信加密', d.smsCryptionStatus === 'ON' ? '已开启' : '关闭'],
        ['日志上报', d.logStatus === 'ON' ? '自动上报开启' : '已关闭'],
        ['云端反向管理', d.tunnelReady ? ('已就绪 · 代理端口 ' + d.tunnelAdminPort) : '未就绪（无外网请用 SoftAP）'],
        ['SoftAP 现场入口', d.softApUrl || 'http://192.168.43.1:8080'],
        ['Linphone 进程', d.linphoneProcessStatus],
        ['CPU 使用率', d.cpuUseRate + '%'], ['内存使用率', d.memoryUseRate + '%'], ['存储使用率', d.storageUseRate + '%'],
        ['会话通话数', fmtInt(d.callsTotal) + ' 次'], ['会话短信数', fmtInt(d.smsTotal) + ' 条'],
        ['上行流量', fmtBytes(d.trafficTxMB)], ['下行流量', fmtBytes(d.trafficRxMB)],
        ['最近心跳', fmtAgo(d.lastSeen)], ['在线时长', fmtDur(Math.round((Date.now() - d.onlineSince) / 1000))]
      ];
      return '<div class="panel u-mb-4"><div class="panel__head"><h4 class="panel__title">' + icon('sim') + 'SIM 号码</h4></div>' +
        '<div class="panel__body"><div class="u-row u-gap-2" style="align-items:center;flex-wrap:wrap">' +
        '<input class="input input--num" id="manualSim" value="' + esc(d.simNumber || '') + '" placeholder="设备读不到卡号时手工填写" style="max-width:240px">' +
        '<button type="button" class="btn btn--primary btn--sm" data-sim-save="' + esc(d.imei) + '">保存号码</button>' +
        '</div><p class="cell-sub" style="margin-top:8px">保存后写入台账。设备之后若上报空号码，不会覆盖手工填写的值。</p></div></div>' +
        '<div class="specgrid">' + rows.map(([k, v]) =>
        '<div class="spec"><div class="spec__k">' + esc(k) + '</div><div class="spec__v num">' + esc(v) + '</div></div>'
      ).join('') + '</div>' +
        (d.issues.length ? '<div class="panel u-mt-4"><div class="panel__head"><h4 class="panel__title">' + icon('alert') + '待处理问题</h4></div>' +
          '<div class="panel__body"><div class="u-row u-wrap u-gap-2">' +
          d.issues.map(i => '<span class="badge badge--err">' + esc(i) + '</span>').join('') +
          '</div></div></div>' : '');
    },

    regHtml(d) {
      const items = [
        ['volteRegisterStatus', 'VoLTE 注册状态', d.volteRegisterStatus, '0 未注册 / 1 已注册'],
        ['voipRegisterStatus', 'SIP（VoIP）注册状态', d.voipRegisterStatus, '0 未注册 / 1 已注册'],
        ['websocketStatus', 'WebSocket 连接状态', d.websocketStatus, '0 未连接 / 1 已连接'],
        ['wfcStatus', 'WiFi Calling 状态', d.wfcStatus, '0 关闭 / 1 开启'],
        ['airplaneMode', '飞行模式', d.airplaneMode, '0 正常 / 1 飞行模式'],
        ['lteStatus', '核心网连接状态', d.lteStatus, 'LTE-Connect / HeartBeat / Disconnect'],
        ['sipregeststatus', 'SIP 注册结果', d.sipregeststatus, 'success / faild / none'],
        ['logStatus', '日志上报状态', d.logStatus, 'ON / OFF']
      ];
      return '<div class="specgrid">' + items.map(([k, label, v, hint]) =>
        '<div class="spec"><div class="spec__k">' + esc(label) + '<span class="muted" style="text-transform:none;letter-spacing:0">' + esc(k) + '</span></div>' +
        '<div class="spec__v"><span class="badge badge--' + ((v === '1' || v === 'ON' || v === 'success' || v === 'LTE-Connect' || v === 'LTE-HeartBeat') ? 'ok' : (v === '0' || v === 'OFF' ? 'err' : 'idle')) + '">' + esc(v) + '</span></div>' +
        '<div class="cell-sub">' + esc(hint) + '</div></div>'
      ).join('') + '</div>';
    },

    recordsHtml(list, type) {
      if (!list.length) {
        return '<div class="empty">' + icon(type === 'call' ? 'phone' : 'message') +
          '<h4 class="empty__title">暂无' + (type === 'call' ? '通话' : '短信') + '记录</h4>' +
          '<p class="empty__desc">该设备在当前时间窗内没有产生' + (type === 'call' ? '通话' : '短信转发') + '记录。</p></div>';
      }
      if (type === 'call') {
        return '<div class="feed">' + list.slice(0, 40).map(c => {
          const ok = c.answered;
          const kind = c.rejected ? 'warn' : ok ? 'call' : 'err';
          return '<div class="feed__item">' +
            '<div class="feed__mark feed__mark--' + kind + '">' + icon(c.dir === 'incoming' ? 'arrow-down' : 'arrow-up') + '</div>' +
            '<div class="feed__card">' +
            '<div class="feed__top">' +
            '<span class="feed__title">' + (c.dir === 'incoming' ? '呼入' : '呼出') + ' · ' + esc(c.peer) + '</span>' +
            '<span class="badge badge--' + (c.rejected ? 'warn' : ok ? 'ok' : 'err') + '">' +
            (c.rejected ? '拒接（' + esc(M.REJECT_CODES[c.rejectCode] || c.rejectCode) + '）' : ok ? '已接通 ' + fmtDur(c.durationSec) : '未接通') + '</span>' +
            '<span class="feed__time">' + fmtDateTime(c.startTs) + '</span>' +
            '</div>' +
            '<div class="feed__kv">' +
            '<div><dt>traceId</dt><dd>' + esc(c.traceId) + '</dd></div>' +
            '<div><dt>编解码</dt><dd>' + esc(c.codec) + '</dd></div>' +
            '<div><dt>结果</dt><dd>' + esc(c.result) + (c.failReason ? ' / ' + esc(c.failReason) : '') + '</dd></div>' +
            '<div><dt>通话时长</dt><dd>' + fmtDur(c.durationSec) + '</dd></div>' +
            '</div>' +
            '<button class="log-toggle" data-log="' + esc(c.traceId) + '">' + icon('chevron-down', 12) + '日志</button>' +
            '<div class="logblock u-hidden" data-logbody="' + esc(c.traceId) + '">' +
            '<span class="lg-t"># volte 侧（UFI, side=volte）</span>\n' + (esc(c.volteLog) || '（无）') +
            '\n\n<span class="lg-t"># sip 侧（UFI, side=sip）</span>\n' + (esc(c.sipLog) || '（无）') +
            '\n\n<span class="lg-t"># route 侧（dSIPRouter / Kamailio acc）</span>\n' + (esc(c.routeLog) || '（时间窗内无匹配呼叫记录）') +
            '</div>' +
            '</div></div>';
        }).join('') + '</div>';
      }
      return '<div class="feed">' + list.slice(0, 40).map(s =>
        '<div class="feed__item">' +
        '<div class="feed__mark feed__mark--' + (s.kind === 'ok' ? 'sms' : s.kind === 'warn' ? 'warn' : 'err') + '">' + icon(s.mms ? 'image' : 'message') + '</div>' +
        '<div class="feed__card">' +
        '<div class="feed__top">' +
        '<span class="feed__title">' + (s.smsType === 'inbox' ? '收信 → SIP 转发' : 'SIP 下发 → 发送') + ' · ' + esc(s.smsmTel) + '</span>' +
        '<span class="badge badge--' + (s.kind === 'ok' ? 'ok' : s.kind === 'warn' ? 'warn' : 'err') + '">' +
        esc(s.resultCode) + ' ' + esc(s.resultCn) + '</span>' +
        (s.encrypted ? '<span class="badge badge--info">E2E</span>' : '') +
        '<span class="feed__time">' + fmtDateTime(s.smsTimestamp) + '</span>' +
        '</div>' +
        '<div class="feed__body">' + esc(s.smsBody) + '</div>' +
        '<div class="feed__kv">' +
        '<div><dt>smsId</dt><dd>' + esc(s.smsId) + '</dd></div>' +
        '<div><dt>枚举</dt><dd>' + esc(s.resultName) + '</dd></div>' +
        '<div><dt>smsType</dt><dd>' + esc(s.smsType) + '</dd></div>' +
        '</div></div></div>'
      ).join('') + '</div>';
    },

    logsHtml(logs, d) {
      if (!logs.length) {
        return '<div class="panel"><div class="panel__head"><h4 class="panel__title">' + icon('file') + '关键状态日志</h4>' +
          '<div class="panel__actions"><button class="btn btn--primary btn--sm" data-logs="pull">' + icon('download') + '拉取最近 1 天日志</button></div></div>' +
          '<div class="panel__body"><div class="empty">' + icon('terminal') +
          '<h4 class="empty__title">尚无关键状态日志推送</h4>' +
          '<p class="empty__desc">UFI 会在通话/短信/彩信流程结束时推送 Ufi-Status-Log-Indication。<br>可先下发 <code>cmd=start</code> 开启采集，再 <code>cmd=pull</code> 拉取归档。</p>' +
          '<div class="u-row u-gap-2" style="justify-content:center">' +
          '<button class="btn" data-logs="start">' + icon('play') + '开启日志采集</button>' +
          '<button class="btn" data-logs="pull">' + icon('download') + '拉取归档日志</button>' +
          '</div></div></div></div>';
      }
      return '<div class="panel"><div class="panel__head"><h4 class="panel__title">' + icon('file') + '关键状态日志（Ufi-Status-Log-Indication）</h4>' +
        '<div class="panel__actions">' +
        '<button class="btn btn--sm" data-logs="start">' + icon('play') + 'start</button>' +
        '<button class="btn btn--sm" data-logs="stop">' + icon('pause') + 'stop</button>' +
        '<button class="btn btn--primary btn--sm" data-logs="pull">' + icon('download') + 'pull</button>' +
        '</div></div>' +
        '<div class="panel__body panel__body--flush"><div class="feed" style="padding:16px">' +
        logs.slice(0, 30).map(l => {
          const cat = String(l.category || (l.smsBody || l.smsmTel ? 'sms' : 'call'));
          const side = l.side || l.dir || l.smsType || '';
          const isCall = cat === 'call';
          return '<div class="feed__item">' +
            '<div class="feed__mark feed__mark--' + (l.result === 'FAIL' ? 'err' : isCall ? 'call' : 'sms') + '">' + icon(isCall ? 'phone' : 'message') + '</div>' +
            '<div class="feed__card">' +
            '<div class="feed__top">' +
            '<span class="feed__title">' + esc(cat.toUpperCase()) + (side ? ' · ' + esc(side) + ' 侧' : '') + '</span>' +
            '<span class="badge badge--' + (l.result === 'FAIL' ? 'err' : 'ok') + '">' + esc(l.result) + '</span>' +
            '<span class="feed__time">' + fmtDateTime(l.startTs) + '</span>' +
            '</div>' +
            '<div class="feed__kv"><div><dt>sessionId</dt><dd>' + esc(l.traceId) + '</dd></div>' +
            '<div><dt>side</dt><dd>' + esc(l.side) + '</dd></div>' +
            '<div><dt>时长</dt><dd>' + fmtDur(Math.round((l.endTs - l.startTs) / 1000)) + '</dd></div></div>' +
            '<div class="logblock">' + esc((l.volteLog || '') + '\n' + (l.sipLog || '')).replace(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})/gm, '<span class="lg-t">$1</span>') + '</div>' +
            '</div></div>';
        }).join('') + '</div></div></div>';
    },

    filesHtml(files, d) {
      const rows = files.slice(0, 30).map(f =>
        '<div class="feed__item">' +
        '<div class="feed__mark feed__mark--sms">' + icon('file') + '</div>' +
        '<div class="feed__card">' +
        '<div class="feed__top">' +
        '<span class="feed__title">' + esc(f.fileName || ('file-' + f.id)) + '</span>' +
        '<span class="badge badge--info">' + fmtSize(f.fileSize) + '</span>' +
        '<span class="feed__time">' + fmtDateTime(f.uploadTs) + '</span>' +
        '</div>' +
        '<div class="u-row u-gap-2 u-mt-2">' +
        '<button class="btn btn--sm btn--primary" data-filedl="' + esc(f.id) + '" data-fname="' + esc(f.fileName) + '">' + icon('download', 14) + '下载</button>' +
        '</div>' +
        '</div></div>'
      ).join('');
      return '<div class="panel u-mt-4"><div class="panel__head"><h4 class="panel__title">' + icon('download') +
        '上传的日志文件（' + fmtInt(files.length) + '）</h4>' +
        '<div class="panel__actions"><button class="btn btn--primary btn--sm" data-logs="pull">' + icon('download') + '拉取归档日志</button></div></div>' +
        '<div class="panel__body panel__body--flush">' +
        (rows
          ? '<div class="feed" style="padding:16px">' + rows + '</div>'
          : '<div class="panel__body u-fs-sm muted">设备执行 <code>cmd=pull</code> 后经 upload-file 上传的归档日志会列出，可逐个下载。</div>') +
        '</div></div>';
    }
  };

  /* ==========================================================================
     VIEW 3 — COMMAND DISPATCH
     ========================================================================== */

  const Commands = {
    targets: [],
    chosen: null,
    open(targets) {
      this.targets = targets.slice();
      this.chosen = null;
      $('#cmdTargetCount').textContent = fmtInt(targets.length);
      $('#cmdTargetList').innerHTML = targets.slice(0, 6).map(t => {
        const d = S.device(t);
        return '<span class="chip"><span class="mono-sm">' + esc(t) + '</span><span class="muted">' + esc(d ? d.sn : '') + '</span></span>';
      }).join('') + (targets.length > 6 ? '<span class="chip">…其余 ' + (targets.length - 6) + ' 台</span>' : '');

      this.renderList();
      $('#cmdFields').innerHTML = '';
      $('#cmdConsole').innerHTML = '<span class="console__line--dim">// 选择一条命令后，这里会显示将要发送的 WebSocket 报文</span>';
      Modal.open('modalCmd');
    },

    renderList() {
      $('#cmdList').innerHTML = M.CMD_LIST.map(c =>
        '<button class="cmdopt' + (c.danger ? ' is-danger' : '') + (this.chosen === c.cmd ? ' is-on' : '') + '" data-cmd="' + c.cmd + '">' +
        '<span class="cmdopt__icon">' + this.cmdIcon(c) + '</span>' +
        '<span class="cmdopt__text"><span class="cmdopt__name">' + esc(c.name) + '</span>' +
        '<span class="cmdopt__code">cmd=' + esc(c.code) + '</span></span></button>'
      ).join('');

      $$('#cmdList .cmdopt').forEach(b => b.addEventListener('click', () => {
        this.chosen = b.dataset.cmd;
        this.renderList();
        this.renderFields();
      }));
    },

    cmdIcon(c) {
      const map = {
        reboot: 'power', restart_linphone: 'refresh', wifi_scan: 'wifi-search', wifi_connect: 'wifi',
        wifi_on: 'wifi-on', wifi_off: 'wifi-off', wificall: 'phone-wifi', hotspot_on: 'hotspot',
        hotspot_off: 'hotspot-off', sim_verify_pin: 'sim', sim_set_pin: 'sim-key', sim_verify_puk: 'sim-lock'
      };
      return icon(map[c.cmd] || 'terminal');
    },

    renderFields() {
      const c = M.CMD_LIST.find(x => x.cmd === this.chosen);
      if (!c) return;
      let html = '<div class="form-section"><div class="form-section__title">' + icon('terminal') + '命令参数 · ' + esc(c.name) + '</div>' +
        '<p class="u-fs-xs muted u-mb-3" style="margin-top:-6px">' + esc(c.desc) + '</p>';

      const f = c.fields || [];
      if (!f.length) {
        html += '<p class="u-fs-sm muted">该命令无需额外参数，直接下发即可。</p>';
      } else {
        html += '<div class="form-grid">';
        if (f.indexOf('ssid') >= 0) html += '<div class="field"><label class="field__label">WiFi 名称 <span class="field__req">*</span></label>' +
          '<input class="input" id="pSsid" placeholder="SSID，字段 wlanName / ssid"></div>';
        if (f.indexOf('pwd') >= 0) html += '<div class="field"><label class="field__label">密码</label>' +
          '<input class="input" id="pPwd" placeholder="字段 wlanPassword / password"></div>';
        if (f.indexOf('status') >= 0) html += '<div class="field"><label class="field__label">开关状态 <span class="field__req">*</span></label>' +
          '<select class="select" id="pStatus"><option value="ON">ON 开启</option><option value="OFF">OFF 关闭</option></select></div>';
        if (f.indexOf('oldpin') >= 0) html += '<div class="field"><label class="field__label">原 PIN（oldPin）</label>' +
          '<input class="input input--num" id="pOldPin" maxlength="8" placeholder="留空 = 启用 PIN 锁"></div>';
        if (f.indexOf('pin') >= 0) html += '<div class="field"><label class="field__label">SIM PIN <span class="field__req">*</span></label>' +
          '<input class="input input--num" id="pPin" maxlength="8" placeholder="4–8 位数字"></div>';
        if (f.indexOf('puk') >= 0) html += '<div class="field"><label class="field__label">SIM PUK <span class="field__req">*</span></label>' +
          '<input class="input input--num" id="pPuk" maxlength="8" placeholder="8 位 PUK"></div>';
        html += '</div>';
      }
      html += '</div>';

      /* sign / auth preview */
      html += '<div class="form-section"><div class="form-section__title">' + icon('shield') + '鉴权与签名</div>' +
        '<div class="specgrid">' +
        '<div class="spec"><div class="spec__k">msgType</div><div class="spec__v num">Ufi-Get-Cmd-Request</div></div>' +
        '<div class="spec"><div class="spec__k">ts</div><div class="spec__v num" id="cmdTs"></div></div>' +
        '<div class="spec"><div class="spec__k">sign</div><div class="spec__v num">sha256(key 升序拼接 & secret_key)</div></div>' +
        '<div class="spec"><div class="spec__k">通道</div><div class="spec__v num">WebSocket（wss://…/ufi/websocket）</div></div>' +
        '</div></div>';

      $('#cmdFields').innerHTML = html;
      $('#cmdTs').textContent = String(Date.now());
      this.preview();

      $$('#cmdFields input, #cmdFields select').forEach(el => el.addEventListener('input', () => this.preview()));
    },

    buildPayload() {
      const c = M.CMD_LIST.find(x => x.cmd === this.chosen);
      if (!c) return null;
      const p = {
        msgType: 'Ufi-Get-Cmd-Request',
        requestId: cryptoRandom(),
        ts: String(Date.now()),
        sign: '<sha256>',
        imei: this.targets.length === 1 ? this.targets[0] : '<imei#1> … 共 ' + this.targets.length + ' 台',
        cmd: c.code
      };
      const v = id => { const el = $(id); return el ? el.value.trim() : ''; };
      if (c.fields && c.fields.indexOf('ssid') >= 0 && v('#pSsid')) p[c.cmd.indexOf('hotspot') === 0 ? 'hotspotName' : 'wlanName'] = v('#pSsid');
      if (c.fields && c.fields.indexOf('pwd') >= 0 && v('#pPwd')) p[c.cmd.indexOf('hotspot') === 0 ? 'hotspotPassword' : 'wlanPassword'] = v('#pPwd');
      if (c.fields && c.fields.indexOf('status') >= 0) p.status = v('#pStatus') || 'ON';
      if (c.fields && c.fields.indexOf('oldpin') >= 0 && v('#pOldPin')) p.oldPin = v('#pOldPin');
      if (c.fields && c.fields.indexOf('pin') >= 0 && v('#pPin')) p.simPin = v('#pPin');
      if (c.fields && c.fields.indexOf('puk') >= 0 && v('#pPuk')) p.simPuk = v('#pPuk');
      return p;
    },

    preview() {
      const p = this.buildPayload();
      if (!p) return;
      const json = JSON.stringify(p, null, 2);
      $('#cmdConsole').innerHTML =
        '<span class="console__line--dim">// 服务端 → UFI (WebSocket)</span>\n' +
        '<span class="console__line--req">' + esc(json) + '</span>\n\n' +
        '<span class="console__line--dim">// 预期应答 (Ufi-Get-Cmd-Request)</span>\n' +
        '<span class="console__line--res">' + esc(JSON.stringify({
          msgType: 'Ufi-Get-Cmd-Request',
          requestId: p.requestId,
          imei: p.imei,
          code: '200',
          cmd: p.cmd,
          ...(p.cmd === 'wifi_scan' ? { connectedSsid: 'Office-WiFi', wifiList: [{ ssid: 'Office-WiFi', level: -55, frequency: 2412, capabilities: '[WPA2-PSK-CCMP]', connected: true }] } : {}),
          ...(p.cmd === 'wifi_on' ? { wlanStatus: 'ON' } : {}),
          ...(p.cmd === 'wificall' ? { wlanCallingStatus: p.status, wfcStatus: p.status } : {}),
          ...(p.cmd.indexOf('sim_') === 0 ? { pinResult: 'success', resultCode: 0 } : {})
        }, null, 2)) + '</span>';
    },

    send() {
      const p = this.buildPayload();
      if (!p) { Toast.show('warn', '请先选择命令', '从上方列表选择一条远程控制命令。'); return; }
      const c = M.CMD_LIST.find(x => x.cmd === this.chosen);
      if (c.fields && c.fields.indexOf('ssid') >= 0 && !p.wlanName && !p.hotspotName) {
        Toast.show('warn', '缺少必填参数', 'cmd=wifi_connect / hotspot_on 需要提供 SSID。');
        return;
      }
      const run = async () => {
        /* keep the modal open — the preview console becomes a live result view */
        Modal.open('modalCmd');
        const con = $('#cmdConsole');
        const lines = [];
        const paint = () => { con.innerHTML = lines.join('\n'); con.scrollTop = con.scrollHeight; };
        paint();
        let ok = 0, fail = 0, timeouts = 0;
        for (const t of this.targets) {
          const body = Object.assign({}, p, { imei: t, msgType: 'Ufi-Get-Cmd-Request', cmd: p.cmd });
          delete body.sign;
          lines.push('<span class="console__line--dim">// → ' + esc(t) + ' 下发中，等待设备 reply…</span>');
          paint();
          const r = await UFI.api.post('ufi/devices/' + encodeURIComponent(t) + '/command', body);
          const res = await awaitCommandReply(t, r, CMD_REPLY_BUDGET_MS, ms => {
            lines[lines.length - 1] = '<span class="console__line--dim">// → ' + esc(t) + ' 已下发，等待设备 reply… ' + Math.round(ms / 1000) + 's</span>';
            paint();
          });
          if (res.ok) {
            ok++;
            lines.push('<span class="console__line--dim">// ← ' + esc(t) + ' reply（' + Math.round(res.elapsed / 1000) + 's）</span>');
            lines.push('<span class="console__line--res">' + esc(JSON.stringify(res.reply, null, 2)) + '</span>');
          } else {
            fail++;
            if (res.timeout) timeouts++;
            lines.push('<span class="console__line--err">// ✗ ' + esc(t) + ' ' + esc(res.error || 'failed') + '</span>');
          }
          paint();
        }
        const summary = ok + ' 成功 / ' + fail + ' 失败' + (timeouts ? '（含 ' + timeouts + ' 台 120s 超时）' : '') + ' · cmd=' + p.cmd;
        lines.push('<span class="console__line--dim">// 完成：' + esc(summary) + '</span>');
        paint();
        Toast.show(fail ? 'warn' : 'ok', fail ? '指令执行有失败' : '指令执行成功', summary);
        try { await S.reload(); } catch (e) {}
        Devices.applyFilters(); Devices.render();
        Overview.render();
        paintSidebarCounters();
      };
      if (c.danger) {
        Confirm.ask({
          title: '确认下发「' + c.name + '」',
          body: '目标 <b>' + fmtInt(this.targets.length) + '</b> 台设备。命令 <code>cmd=' + p.cmd + '</code> 将立即执行' +
            (p.cmd === 'reboot' ? '，设备重启期间所有通话会中断。' : '。'),
          danger: true, confirmText: '确认下发', onOk: run
        });
      } else run();
    },

    /* ---- Device deletion (removes device + all related records & files) ---- */
    removeDevice(imei) {
      const d = S.device(imei);
      Confirm.ask({
        title: '确认删除设备',
        body: 'IMEI <b>' + esc(imei) + '</b>' + (d && d.sn ? '（SN ' + esc(d.sn) + '）' : '') +
          ' 将被永久删除，包括其通话/短信/事件记录与已上传的日志文件（含服务器磁盘文件）。<br>该操作<b>不可恢复</b>。',
        danger: true,
        confirmText: '确认删除',
        onOk: async () => {
          try {
            await UFI.api.del('ufi/devices/' + encodeURIComponent(imei));
            Toast.show('ok', '设备已删除', imei + ' 及其全部记录');
            try { await S.reload(); } catch (e) {}
            Devices.applyFilters(); Devices.render();
            Overview.render();
            paintSidebarCounters();
          } catch (e) {
            Toast.show('err', '删除失败', String((e && e.message) || e));
          }
        }
      });
    },

    /* ---- eSIM profile (Ufi-Get-ESIM-Request) ---- */
    openEsim(targets) {
      this.targets = targets.slice();
      $('#esimTargetCount').textContent = fmtInt(targets.length);
      $('#esimTargetList').innerHTML = targets.slice(0, 6).map(t => {
        const d = S.device(t);
        return '<span class="chip"><span class="mono-sm">' + esc(t) + '</span><span class="muted">' + esc(d ? d.sn : '') + '</span></span>';
      }).join('') + (targets.length > 6 ? '<span class="chip">…其余 ' + (targets.length - 6) + ' 台</span>' : '');
      const input = $('#esimMessage');
      if (input && !input.value) input.value = '';
      this.previewEsim();
      if (input) {
        input.oninput = () => this.previewEsim();
        setTimeout(() => input.focus(), 50);
      }
      Modal.open('modalEsim');
    },

    previewEsim() {
      const raw = (($('#esimMessage') && $('#esimMessage').value) || '').replace(/\s+/g, '');
      const body = {
        msgType: 'Ufi-Get-ESIM-Request',
        requestId: cryptoRandom(),
        ts: String(Date.now()),
        sign: '<sha256>',
        imei: this.targets.length === 1 ? this.targets[0] : '<imei#1> … 共 ' + this.targets.length + ' 台',
        esimMessage: raw || 'LPA:1$SMDP.EXAMPLE$MATCHING-ID'
      };
      $('#esimConsole').innerHTML =
        '<span class="console__line--dim">// 服务端 → UFI (WebSocket)</span>\n' +
        '<span class="console__line--req">' + esc(JSON.stringify(body, null, 2)) + '</span>\n\n' +
        '<span class="console__line--dim">// 预期应答 (Ufi-Get-ESIM-Request)</span>\n' +
        '<span class="console__line--res">' + esc(JSON.stringify({
          msgType: 'Ufi-Get-ESIM-Request',
          requestId: body.requestId,
          imei: body.imei,
          code: 200,
          ok: 1,
          comment: 'esim profile accepted'
        }, null, 2)) + '</span>';
    },

    sendEsim() {
      const esimMessage = (($('#esimMessage') && $('#esimMessage').value) || '').replace(/\s+/g, '');
      if (!esimMessage) {
        Toast.show('warn', '缺少激活码', '请填写 esimMessage（如 LPA:1$…$…）');
        return;
      }
      if (esimMessage.length > 512) {
        Toast.show('warn', '激活码过长', 'esimMessage 最长 512 字符');
        return;
      }
      Confirm.ask({
        title: '确认下发 eSIM Profile',
        body: '目标 <b>' + fmtInt(this.targets.length) + '</b> 台设备。<br>激活码 <code style="word-break:break-all">' + esc(esimMessage) + '</code><br>将通过 WebSocket 发送 <code>Ufi-Get-ESIM-Request</code>。',
        confirmText: '确认下发',
        onOk: async () => {
          Modal.open('modalEsim');
          const con = $('#esimConsole');
          const lines = [];
          const paint = () => { con.innerHTML = lines.join('\n'); con.scrollTop = con.scrollHeight; };
          let ok = 0, fail = 0, timeouts = 0;
          for (const t of this.targets) {
            const body = { msgType: 'Ufi-Get-ESIM-Request', imei: t, esimMessage: esimMessage };
            lines.push('<span class="console__line--dim">// → ' + esc(t) + ' 下发中，等待设备 reply…</span>');
            paint();
            const r = await UFI.api.post('ufi/devices/' + encodeURIComponent(t) + '/command', body);
            const res = await awaitCommandReply(t, r, CMD_REPLY_BUDGET_MS, ms => {
              lines[lines.length - 1] = '<span class="console__line--dim">// → ' + esc(t) + ' 已下发，等待设备 reply… ' + Math.round(ms / 1000) + 's</span>';
              paint();
            });
            if (res.ok) {
              ok++;
              lines.push('<span class="console__line--dim">// ← ' + esc(t) + ' reply（' + Math.round(res.elapsed / 1000) + 's）</span>');
              lines.push('<span class="console__line--res">' + esc(JSON.stringify(res.reply, null, 2)) + '</span>');
            } else {
              fail++;
              if (res.timeout) timeouts++;
              lines.push('<span class="console__line--err">// ✗ ' + esc(t) + ' ' + esc(res.error || 'failed') + '</span>');
            }
            paint();
          }
          const summary = ok + ' 成功 / ' + fail + ' 失败' + (timeouts ? '（含 ' + timeouts + ' 台超时）' : '');
          lines.push('<span class="console__line--dim">// 完成：' + esc(summary) + '</span>');
          paint();
          Toast.show(fail ? 'warn' : 'ok', fail ? 'eSIM 下发有失败' : 'eSIM 已下发', summary);
        }
      });
    },

    /* ---- Log operations (6.7 Ufi-Get-Log-Request) ---- */
    openLog(targets) {
      this.targets = targets.slice();
      $('#logTargetCount').textContent = fmtInt(targets.length);
      $('#logConsole').innerHTML = '<span class="console__line--dim">// 选择日志操作后显示报文</span>';
      $('#logDaysWrap').classList.add('u-hidden');
      $('#logCmdFields').innerHTML = M.LOG_CMDS.map(l =>
        '<button class="cmdopt' + (l.cmd === 'pull' ? '' : '') + '" data-logcmd="' + l.cmd + '">' +
        '<span class="cmdopt__icon">' + icon(l.cmd === 'start' ? 'play' : l.cmd === 'stop' ? 'pause' : 'download') + '</span>' +
        '<span class="cmdopt__text"><span class="cmdopt__name">' + esc(l.name) + '</span>' +
        '<span class="cmdopt__code">cmd=' + esc(l.cmd) + '</span></span></button>'
      ).join('');
      $$('#logCmdFields .cmdopt').forEach(b => b.addEventListener('click', () => {
        $$('#logCmdFields .cmdopt').forEach(x => x.classList.toggle('is-on', x === b));
        const cmd = b.dataset.logcmd;
        $('#logDaysWrap').classList.toggle('u-hidden', cmd !== 'pull');
        const body = { msgType: 'Ufi-Get-Log-Request', requestId: cryptoRandom(), ts: String(Date.now()), sign: '<sha256>', imei: targets[0] || '<imei>', cmd };
        if (cmd === 'pull') body.days = $('#logDays') ? $('#logDays').value : '1';
        $('#logConsole').innerHTML =
          '<span class="console__line--dim">// 服务端 → UFI (WebSocket)</span>\n<span class="console__line--req">' + esc(JSON.stringify(body, null, 2)) + '</span>\n\n' +
          '<span class="console__line--dim">// 说明</span>\n' +
          (cmd === 'pull'
            ? '<span class="console__line--res">日志达到阈值后设备侧压缩并本地归档（保留最近 4 天），\n按 days 拉取后经 /ufi-app/api/ufi/upload-file 上传。</span>'
            : '<span class="console__line--res">应答：{ msgType, requestId, imei, code: 200 }</span>');
      }));
      Modal.open('modalLog');
    },

    async sendLog() {
      const on = $('#logCmdFields .cmdopt.is-on');
      if (!on) { Toast.show('warn', '请选择日志操作', 'start / stop / pull 三选一。'); return; }
      const cmd = on.dataset.logcmd;
      const days = $('#logDays') ? $('#logDays').value : '1';
      Modal.open('modalLog');
      const con = $('#logConsole');
      const lines = [];
      const paint = () => { con.innerHTML = lines.join('\n'); con.scrollTop = con.scrollHeight; };
      paint();
      let ok = 0, fail = 0, timeouts = 0;
      for (const t of this.targets) {
        const body = { msgType: 'Ufi-Get-Log-Request', cmd: cmd, imei: t };
        if (cmd === 'pull') body.days = days;
        lines.push('<span class="console__line--dim">// → ' + esc(t) + ' 下发中，等待设备 reply…</span>');
        paint();
        const r = await UFI.api.post('ufi/devices/' + encodeURIComponent(t) + '/command', body);
        const res = await awaitCommandReply(t, r, CMD_REPLY_BUDGET_MS, ms => {
          lines[lines.length - 1] = '<span class="console__line--dim">// → ' + esc(t) + ' 已下发，等待设备 reply… ' + Math.round(ms / 1000) + 's</span>';
          paint();
        });
        if (res.ok) {
          ok++;
          lines.push('<span class="console__line--dim">// ← ' + esc(t) + ' reply（' + Math.round(res.elapsed / 1000) + 's）</span>');
          lines.push('<span class="console__line--res">' + esc(JSON.stringify(res.reply, null, 2)) + '</span>');
          if (cmd === 'pull') {
            lines.push('<span class="console__line--dim">// 设备将按 days 拉取归档并经 upload-file 上传，文件见「采集日志」页。</span>');
            lines.push('<span class="console__line--dim">// → <a href="#" class="console__link" data-goto-files data-imei="' + esc(t) + '">查看 ' + esc(t) + ' 的采集日志 →</a></span>');
          }
        } else {
          fail++;
          if (res.timeout) timeouts++;
          lines.push('<span class="console__line--err">// ✗ ' + esc(t) + ' ' + esc(res.error || 'failed') + '</span>');
        }
        paint();
      }
      const summary = ok + ' 成功 / ' + fail + ' 失败' + (timeouts ? '（含 ' + timeouts + ' 台 120s 超时）' : '') + ' · cmd=' + cmd + (cmd === 'pull' ? ' · days=' + days : '');
      lines.push('<span class="console__line--dim">// 完成：' + esc(summary) + '</span>');
      paint();
      Toast.show(fail ? 'warn' : 'ok',
        cmd === 'pull' ? '日志拉取已触发' : ('日志采集已' + (cmd === 'start' ? '开启' : '停止')),
        summary);
      try { await S.reload(); } catch (e) {}
      Records.render();
      paintSidebarCounters();
    }
  };

  function cryptoRandom() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
  }

  const CMD_REPLY_BUDGET_MS = 120000;

  /* Same-origin authenticated download of a stored UFI log file (server streams the file). */
  function fileDownloadUrl(fileId) {
    const base = (typeof API_BASE_URL === 'string' ? API_BASE_URL : '/api/v1/').replace(/\/?$/, '/');
    return base + 'ufi/files/' + encodeURIComponent(fileId) + '/download';
  }

  /* Dispatch already done; wait for the device reply via the long-poll result endpoint.
     The reply budget (default 120s) counts from dispatch time; onTick(elapsedMs) updates progress. */
  async function awaitCommandReply(imei, postRes, budgetMs, onTick) {
    budgetMs = budgetMs || CMD_REPLY_BUDGET_MS;
    const data = (postRes && postRes.data) || {};
    if (!postRes || !postRes.ok) {
      return { ok: false, error: (postRes && postRes.json && postRes.json.msg) || '下发失败' };
    }
    const reply0 = data.reply || null;
    const requestId = String(data.requestId || '');
    if (reply0 || !requestId || !data.pending) {
      return { ok: true, reply: reply0, elapsed: 0 };
    }
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      const remainMs = budgetMs - (Date.now() - started);
      const waitSec = Math.min(25, Math.max(1, Math.round(remainMs / 1000)));
      let rows = null;
      try {
        rows = await UFI.api.get('ufi/devices/' + encodeURIComponent(imei) +
          '/command/' + encodeURIComponent(requestId) + '/result?wait=' + waitSec);
      } catch (e) {
        return { ok: false, error: '结果查询失败：' + String(e.message || e) };
      }
      const pd = rows && rows[0];
      if (pd && pd.reply) return { ok: true, reply: pd.reply, elapsed: Date.now() - started };
      if (pd && pd.ok === false) return { ok: false, error: pd.error || '请求已过期，请重新下发' };
      if (onTick) onTick(Date.now() - started);
    }
    return { ok: false, timeout: true, elapsed: Date.now() - started, error: '超过 120 秒未收到设备 reply，已超时' };
  }

  /* ==========================================================================
     SETTINGS MODAL — device configuration (6.3 sip-setting)
     ========================================================================== */

  const Settings = {
    targets: [],
    open(targets) {
      this.targets = targets.slice();
      const d = targets.length === 1 ? S.device(targets[0]) : null;
      $('#setTargetCount').textContent = fmtInt(targets.length);
      $('#setTargetHint').textContent = d ? d.imei + ' · ' + d.sn : '批量设置将套用相同参数';
      const g = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
      const ck = (id, v) => { const el = $(id); if (el) el.checked = !!v; };

      g('#sSipAddr', d ? d.sipServerAddress : '101.132.78.224');
      g('#sSipPort', d ? d.sipServerPort : 5060);
      g('#sSipPwd', d ? (d.sippassWord || '') : '');
      this.setPwdVisible(false);
      g('#sSsid', d ? d.wlanName : '');
      g('#sSsidPwd', d ? '••••••••' : '');
      g('#sHotspotName', d ? d.hotspotName : '');
      g('#sHotspotPwd', d ? '••••••••' : '');
      g('#sWfc', d ? (d.wfcStatus === '1' ? 'ON' : 'OFF') : 'OFF');
      g('#sSmsCryption', d ? d.smsCryptionStatus : 'ON');
      g('#sLogStatus', d ? d.logStatus : 'OFF');
      g('#sTransport', d ? d.transportProtocol : 'UDP');
      g('#sEncryption', d ? d.encryptionType : 'dtls');
      ck('#sWlan', d ? d.networkType === 'wifi' : false);
      ck('#sOtg', d ? d.networkType === 'ethernet' : false);
      ck('#sEcm', false);
      ck('#sAirplane', d ? d.airplaneMode === '1' : false);
      Modal.open('modalSet');
    },

    setPwdVisible(show) {
      const input = $('#sSipPwd');
      const btn = $('#sSipPwdToggle');
      if (!input || !btn) return;
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.title = show ? '隐藏密码' : '显示密码';
      btn.innerHTML = icon(show ? 'eye-off' : 'eye', 16);
    },

    payload() {
      const v = id => { const el = $(id); return el ? el.value.trim() : ''; };
      const ck = id => { const el = $(id); return el ? el.checked : false; };
      const payload = {
        msgType: 'Ufi-Set-Request',
        sipServerAddress: v('#sSipAddr'),
        sipServerPort: Number(v('#sSipPort')) || 5060,
        transportProtocol: v('#sTransport'),
        encryptionType: v('#sEncryption'),
        wlanCallingStatus: v('#sWfc'),
        wlanStatus: ck('#sWlan') ? 'ON' : 'OFF',
        wlanName: v('#sSsid'),
        otgStatus: ck('#sOtg') ? 'ON' : 'OFF',
        ecmStatus: ck('#sEcm') ? 'ON' : 'OFF',
        ufiHotpotstaus: v('#sHotspotName') ? 'ON' : 'OFF',
        hotspotName: v('#sHotspotName'),
        smsCryptionStatus: v('#sSmsCryption'),
        logStatus: v('#sLogStatus'),
        isSet: 'Set'
      };
      payload.wlanPassword = v('#sSsidPwd');
      payload.hotspotPassword = v('#sHotspotPwd');
      payload.airplaneMode = ck('#sAirplane') ? '1' : '0';
      if (v('#sSipPwd') && v('#sSipPwd') !== '••••••••') payload.sippassWord = v('#sSipPwd');
      return payload;
    },

    save(dispatch) {
      const payload = this.payload();
      payload.dispatch = dispatch ? 1 : 0;
      (async () => {
        Modal.closeAll();
        let ok = 0, fail = 0, restarted = 0;
        for (const t of this.targets) {
          const r = await UFI.api.post('ufi/devices/' + encodeURIComponent(t) + '/settings', Object.assign({ imei: t }, payload));
          if (r.ok) ok++; else fail++;
          if (dispatch && r.ok) {
            const c = await UFI.api.post('ufi/devices/' + encodeURIComponent(t) + '/command', {
              imei: t, msgType: 'Ufi-Get-Cmd-Request', cmd: 'restart_linphone'
            });
            if (c.ok) restarted++;
          }
        }
        if (dispatch) {
          Toast.show(fail ? 'warn' : 'ok', '设置已下发',
            ok + ' 台保存成功 / ' + fail + ' 失败，已重启 Linphone ' + restarted + ' 台');
        } else {
          Toast.show(fail ? 'warn' : 'ok', '设置已保存',
            ok + ' 成功 / ' + fail + ' 失败，下次 sip-setting 或在线推送后生效');
        }
        try { await S.reload(); } catch (e) {}
        Devices.applyFilters(); Devices.render(); Overview.render();
      })();
    }
  };

  /* ==========================================================================
     VIEW 4 — LOGS & RECORDS
     ========================================================================== */

  const Records = {
    tab: 'calls',
    filter: 'all',
    dayFrom: '',
    dayTo: '',
    init() {
      $('#recTabs').addEventListener('click', e => {
        const t = e.target.closest('.tab'); if (!t) return;
        this.tab = t.dataset.rtab;
        $$('#recTabs .tab').forEach(x => x.classList.toggle('is-active', x === t));
        this.render();
      });
      $('#recBody').addEventListener('click', e => {
        const lt = e.target.closest('.log-toggle');
        if (lt) {
          const body = $('[data-logbody="' + lt.dataset.log + '"]');
          const hidden = body.classList.toggle('u-hidden');
          lt.innerHTML = icon('chevron-down', 12) + (hidden ? '日志' : '收起');
        }
        const dl = e.target.closest('button[data-filedl]');
        if (dl) {
          const url = fileDownloadUrl(dl.dataset.filedl);
          const a = document.createElement('a');
          a.href = url;
          a.download = dl.dataset.fname || '';
          document.body.appendChild(a);
          a.click();
          a.remove();
          Toast.show('info', '开始下载', dl.dataset.fname || ('file #' + dl.dataset.filedl));
        }
      });
      $('#recFilterTabs').addEventListener('click', e => {
        const c = e.target.closest('.chip'); if (!c) return;
        $$('#recFilterTabs .chip').forEach(x => x.classList.toggle('is-on', x === c));
        this.filter = c.dataset.rf;
        this.render();
      });
      const rf = $('#recFrom'), rt = $('#recTo');
      [rf, rt].forEach(inp => { if (inp) inp.addEventListener('change', () => {
        this.dayFrom = rf ? (rf.value || '') : '';
        this.dayTo = rt ? (rt.value || '') : '';
        this.render();
      }); });
      const rc = $('#recSearchClear');
      if (rc) rc.addEventListener('click', () => {
        this.dayFrom = '';
        this.dayTo = '';
        if (rf) rf.value = '';
        if (rt) rt.value = '';
        this.render();
      });
    },

    dayOf(ms) {
      const d = new Date(ms);
      if (!ms || isNaN(d.getTime())) return '';
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },

    inDateRange(ms) {
      if (!this.dayFrom && !this.dayTo) return true;
      const day = this.dayOf(ms);
      if (!day) return false;
      return (!this.dayFrom || day >= this.dayFrom) && (!this.dayTo || day <= this.dayTo);
    },

    setCount(matched, shown) {
      const note = $('#recCount');
      if (!note) return;
      const ranged = !!(this.dayFrom || this.dayTo);
      let t = '共 ' + fmtInt(matched) + ' 条';
      if (shown < matched) t += ' · 展示最近 ' + fmtInt(shown) + ' 条';
      if (ranged) t += ' · 已按时间筛选';
      note.textContent = t;
    },

    render() {
      const chips = $('#recFilterTabs');
      if (chips) chips.classList.toggle('u-hidden', false);
      if (this.tab === 'calls') this.renderCalls();
      else this.renderSms();
    },

    renderCalls() {
      let list = S.calls;
      if (this.filter === 'fail') list = list.filter(c => !c.answered && !c.rejected);
      if (this.filter === 'reject') list = list.filter(c => c.rejected);
      if (this.filter === 'ok') list = list.filter(c => c.answered);
      list = list.filter(c => this.inDateRange(c.startTs));

      if (!list.length) {
        this.setCount(0, 0);
        $('#recBody').innerHTML = this.emptyHtml(
          (this.dayFrom || this.dayTo) ? '无匹配的通话记录' : '暂无通话记录');
        return;
      }
      const shown = list.slice(0, 60);
      this.setCount(list.length, shown.length);
      $('#recBody').innerHTML = shown.map(c =>
        '<div class="feed__item">' +
        '<div class="feed__mark feed__mark--' + (c.rejected ? 'warn' : c.answered ? 'call' : 'err') + '">' + icon(c.dir === 'incoming' ? 'arrow-down' : 'arrow-up') + '</div>' +
        '<div class="feed__card">' +
        '<div class="feed__top">' +
        '<span class="feed__title">' + (c.dir === 'incoming' ? '呼入' : '呼出') + ' · ' + esc(c.peer) + '</span>' +
        '<span class="badge badge--' + (c.rejected ? 'warn' : c.answered ? 'ok' : 'err') + '">' +
        (c.rejected ? '拒接 · ' + esc(M.REJECT_CODES[c.rejectCode]) : c.answered ? '已接通 ' + fmtDur(c.durationSec) : '未接通 · ' + esc(c.failReason)) + '</span>' +
        '<span class="mono-sm muted">' + esc(c.imei) + '</span>' +
        '<span class="feed__time">' + fmtDateTime(c.startTs) + '</span>' +
        '</div>' +
        '<div class="feed__kv">' +
        '<div><dt>traceId</dt><dd>' + esc(c.traceId) + '</dd></div>' +
        '<div><dt>编解码</dt><dd>' + esc(c.codec) + '</dd></div>' +
        '<div><dt>结果</dt><dd>' + esc(c.result) + '</dd></div>' +
        '</div>' +
        '<button class="log-toggle" data-log="' + esc(c.traceId) + '">' + icon('chevron-down', 12) + '日志</button>' +
        '<div class="logblock u-hidden" data-logbody="' + esc(c.traceId) + '">' +
        '<span class="lg-t"># volte 侧</span>\n' + esc(c.volteLog) + '\n\n<span class="lg-t"># sip 侧</span>\n' + esc(c.sipLog) + '</div>' +
        '</div></div>'
      ).join('');
    },

    renderSms() {
      let list = S.sms;
      if (this.filter === 'fail') list = list.filter(s => s.kind !== 'ok');
      if (this.filter === 'ok') list = list.filter(s => s.kind === 'ok');
      if (this.filter === 'mms') list = list.filter(s => s.mms);
      list = list.filter(s => this.inDateRange(s.smsTimestamp));

      if (!list.length) {
        this.setCount(0, 0);
        $('#recBody').innerHTML = this.emptyHtml(
          (this.dayFrom || this.dayTo) ? '无匹配的短信记录' : '暂无短信记录');
        return;
      }
      const shown = list.slice(0, 60);
      this.setCount(list.length, shown.length);
      $('#recBody').innerHTML = shown.map(s =>
        '<div class="feed__item">' +
        '<div class="feed__mark feed__mark--' + (s.kind === 'ok' ? 'sms' : s.kind === 'warn' ? 'warn' : 'err') + '">' + icon(s.mms ? 'image' : 'message') + '</div>' +
        '<div class="feed__card">' +
        '<div class="feed__top">' +
        '<span class="feed__title">' + (s.smsType === 'inbox' ? '收信 → SIP 转发' : 'SIP 下发 → 发送') + ' · ' + esc(s.smsmTel) + '</span>' +
        '<span class="badge badge--' + (s.kind === 'ok' ? 'ok' : s.kind === 'warn' ? 'warn' : 'err') + '">' + esc(s.resultCode) + ' · ' + esc(s.resultCn) + '</span>' +
        (s.encrypted ? '<span class="badge badge--info">E2E</span>' : '') +
        (s.mms ? '<span class="badge badge--info">彩信</span>' : '') +
        '<span class="mono-sm muted">' + esc(s.imei) + '</span>' +
        '<span class="feed__time">' + fmtDateTime(s.smsTimestamp) + '</span>' +
        '</div>' +
        '<div class="feed__body">' + esc(s.smsBody) + '</div>' +
        '<div class="feed__kv">' +
        '<div><dt>smsId</dt><dd>' + esc(s.smsId) + '</dd></div>' +
        '<div><dt>枚举</dt><dd>' + esc(s.resultName) + '</dd></div>' +
        '<div><dt>failResult</dt><dd>' + esc(s.failResult || '—') + '</dd></div>' +
        '</div></div></div>'
      ).join('');
    },

    emptyHtml(t) {
      return '<div class="empty">' + icon('file') + '<h4 class="empty__title">' + t + '</h4>' +
        '<p class="empty__desc">当前筛选条件下没有记录。</p></div>';
    }
  };

  /* ==========================================================================
     VIEW — DEVICE COLLECTED LOGS (独立采集日志页，支持 IMEI 搜索)
     ========================================================================== */

  const DevLogs = {
    q: '',
    dayFrom: '',
    dayTo: '',
    page: 1,
    PER_PAGE: 20,
    init() {
      const inp = $('#devlogSearch');
      if (inp) inp.addEventListener('input', () => {
        this.q = inp.value.trim().toLowerCase();
        this.page = 1;
        this.render();
      });
      const df = $('#devlogFrom'), dt = $('#devlogTo');
      [df, dt].forEach(x => { if (x) x.addEventListener('change', () => {
        this.dayFrom = df ? (df.value || '') : '';
        this.dayTo = dt ? (dt.value || '') : '';
        this.page = 1;
        this.render();
      }); });
      const clr = $('#devlogSearchClear');
      if (clr) clr.addEventListener('click', () => {
        this.q = '';
        this.dayFrom = '';
        this.dayTo = '';
        if (inp) inp.value = '';
        if (df) df.value = '';
        if (dt) dt.value = '';
        this.page = 1;
        this.render();
      });
      /* download buttons + pagination (event delegation) */
      const body = $('#devlogBody');
      if (body) body.addEventListener('click', e => {
        const pg = e.target.closest('button[data-filepg]');
        if (pg && !pg.disabled) {
          const all = this.filtered().length, tp = Math.max(1, Math.ceil(all / this.PER_PAGE));
          this.page = pg.dataset.filepg === 'prev' ? Math.max(1, this.page - 1) : Math.min(tp, this.page + 1);
          this.render();
          return;
        }
        const dl = e.target.closest('button[data-filedl]');
        if (!dl) return;
        const a = document.createElement('a');
        a.href = fileDownloadUrl(dl.dataset.filedl);
        a.download = dl.dataset.fname || '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        Toast.show('info', '开始下载', dl.dataset.fname || ('file #' + dl.dataset.filedl));
      });
    },

    /* local-date string (YYYY-MM-DD) from an epoch-ms timestamp */
    dayOf(ms) {
      const d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },

    filtered() {
      let list = S.files.slice();
      list.sort((a, b) => b.uploadTs - a.uploadTs);
      if (this.q) list = list.filter(f =>
        String(f.imei || '').toLowerCase().indexOf(this.q) >= 0 ||
        String(f.fileName || '').toLowerCase().indexOf(this.q) >= 0);
      if (this.dayFrom || this.dayTo) list = list.filter(f => {
        const day = this.dayOf(f.uploadTs);
        return (!this.dayFrom || day >= this.dayFrom) && (!this.dayTo || day <= this.dayTo);
      });
      return list;
    },

    render() {
      const el = $('#devlogBody');
      if (!el) return;
      const all = this.filtered();
      const tp = Math.max(1, Math.ceil(all.length / this.PER_PAGE));
      if (this.page > tp) this.page = tp;
      if (this.page < 1) this.page = 1;
      const list = all.slice((this.page - 1) * this.PER_PAGE, this.page * this.PER_PAGE);
      const cnt = $('#devlogCount');
      if (cnt) cnt.textContent = '共 ' + fmtInt(all.length) + ' 个文件' +
        (this.q ? ' · 已过滤' : '') + (tp > 1 ? ' · 第 ' + this.page + '/' + tp + ' 页' : '');
      if (!all.length) { el.innerHTML = Records.emptyHtml(this.q ? '无匹配的日志文件' : '暂无采集日志'); return; }
      const pager = tp > 1
        ? '<div class="filepager">' +
          '<span class="filepager__info">第 ' + this.page + ' / ' + tp + ' 页 · 共 ' + fmtInt(all.length) + ' 个</span>' +
          '<span class="filepager__btns">' +
          '<button class="btn btn--sm btn--ghost" data-filepg="prev"' + (this.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<button class="btn btn--sm btn--ghost" data-filepg="next"' + (this.page >= tp ? ' disabled' : '') + '>下一页</button>' +
          '</span></div>'
        : '';
      el.innerHTML = pager + list.map(f =>
        '<div class="fileline">' +
        '<span class="fileline__name" title="' + esc(f.fileName || '') + '">' + esc(f.fileName || ('file-' + f.id)) + '</span>' +
        '<span class="fileline__meta">' + fmtSize(f.fileSize) + '</span>' +
        '<span class="fileline__meta" title="设备 IMEI">' + esc(f.imei) + '</span>' +
        '<span class="fileline__meta">' + fmtDateTime(f.uploadTs) + '</span>' +
        '<button class="btn btn--sm btn--primary" data-filedl="' + esc(f.id) + '" data-fname="' + esc(f.fileName) + '" title="下载">' + icon('download', 12) + '</button>' +
        '</div>'
      ).join('') + pager;
    }
  };

  /* ==========================================================================
     CONFIRM dialog
     ========================================================================== */

  const Confirm = {
    ask(o) {
      $('#confirmTitle').textContent = o.title;
      $('#confirmBody').innerHTML = o.body;
      const ok = $('#confirmOk');
      ok.className = 'btn ' + (o.danger ? 'btn--danger' : 'btn--primary');
      ok.textContent = o.confirmText || '确认';
      this.onOk = o.onOk;
      Modal.open('modalConfirm');
    },
    onOk: null
  };

  /* ==========================================================================
     MODAL controller + Nav
     ========================================================================== */

  const Modal = {
    init() {
      $$('.modal-scrim').forEach(s => {
        s.addEventListener('mousedown', e => { if (e.target === s) this.close(s); });
      });
      $$('[data-close]').forEach(b => b.addEventListener('click', () => this.closeAll()));
      $('#confirmOk').addEventListener('click', () => {
        const fn = Confirm.onOk;
        this.closeAll();
        if (fn) fn();
      });
    },
    open(id) { $('#' + id).classList.add('is-open'); },
    close(scrim) { scrim.classList.remove('is-open'); },
    closeAll() { $$('.modal-scrim.is-open').forEach(s => s.classList.remove('is-open')); }
  };

  const Nav = {
    go(view) {
      $$('.ufi-console .view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + view));
      $$('.ufi-tab[data-view], .side-link[data-view]').forEach(l => {
        l.classList.toggle('is-active', l.dataset.view === view);
        l.classList.toggle('is-on', l.dataset.view === view);
      });
      const main = $('.ufi-console .main') || $('.main');
      if (main) main.scrollTop = 0;
      if (view === 'overview') Overview.render();
      if (view === 'commands') Targets.render();
      if (view === 'records') Records.render();
      if (view === 'devlogs') DevLogs.render();
    },
    init() {
      $$('.ufi-tab[data-view], .side-link[data-view]').forEach(l => l.addEventListener('click', () => this.go(l.dataset.view)));
      // "查看日志文件" links inside command consoles / toasts → collected-logs view (pre-filtered by imei)
      document.addEventListener('click', e => {
        const gf = e.target.closest('[data-goto-files]');
        if (!gf) return;
        e.preventDefault();
        const imei = (gf.dataset.imei || '').trim();
        const inp = $('#devlogSearch');
        if (imei && inp) {
          inp.value = imei;
          DevLogs.q = imei.toLowerCase();
        }
        DevLogs.page = 1;
        this.go('devlogs');
      });
      const toggle = $('#sideToggle');
      if (toggle) toggle.addEventListener('click', () => {
        const wrap = $('.wrap');
        if (wrap) wrap.classList.toggle('is-collapsed');
      });
    }
  };

  /* ==========================================================================
     BOOTSTRAP
     ========================================================================== */

  function paintSidebarCounters() {
    const st = S.stats();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#navDeviceCount', fmtInt(st.total));
    set('#navAlertCount', fmtInt(st.warn + st.crit));
    const alert = $('#navAlertCount');
    if (alert) alert.classList.add('is-alert');
    set('#navCallCount', fmtInt(S.calls.length));
    set('#navSmsCount', fmtInt(S.sms.length));
    set('#navLogCount', fmtInt(S.files.length));
  }

  async function boot() {
    try { S = await UFI.Store.init(); } catch (e) { console.error(e); Toast.init(); Toast.show('warn', '设备列表加载失败', String(e.message || e)); }
    Toast.init();
    Nav.init();
    Modal.init();
    Devices.init();
    Drawer.init();
    Records.init();
    DevLogs.init();

    /* command/log modal wiring */
    $('#cmdSend').addEventListener('click', () => Commands.send());
    const esimSend = $('#esimSend');
    if (esimSend) esimSend.addEventListener('click', () => Commands.sendEsim());
    $('#logSend').addEventListener('click', () => Commands.sendLog());
    $('#setSave').addEventListener('click', () => Settings.save(false));
    const setDispatch = $('#setSaveDispatch');
    if (setDispatch) setDispatch.addEventListener('click', () => Settings.save(true));
    const pwdToggle = $('#sSipPwdToggle');
    if (pwdToggle) {
      Settings.setPwdVisible(false);
      pwdToggle.addEventListener('click', () => {
        const input = $('#sSipPwd');
        Settings.setPwdVisible(input && input.type === 'password');
      });
    }
    $('#logDays').addEventListener('change', () => {
      const on = $('#logCmdFields .cmdopt.is-on');
      if (on && on.dataset.logcmd === 'pull') on.click();
    });

    /* drawer log-op shortcuts */
    $('#drawerBody').addEventListener('click', e => {
      const dl = e.target.closest('button[data-filedl]');
      if (dl) {
        const a = document.createElement('a');
        a.href = fileDownloadUrl(dl.dataset.filedl);
        a.download = dl.dataset.fname || '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        Toast.show('info', '开始下载', dl.dataset.fname || ('file #' + dl.dataset.filedl));
        return;
      }
      const simBtn = e.target.closest('button[data-sim-save]');
      if (simBtn) {
        const imei = simBtn.dataset.simSave;
        const inp = $('#manualSim');
        const sim = String((inp && inp.value) || '').replace(/\D/g, '');
        if (sim && !/^\d{5,20}$/.test(sim)) {
          Toast.show('err', '号码格式不对', '请填写 5–20 位数字');
          return;
        }
        simBtn.disabled = true;
        UFI.api.post('ufi/devices/' + encodeURIComponent(imei) + '/sim', { simNumber: sim }).then(r => {
          if (!r.ok) throw new Error((r.json && r.json.msg) || '保存失败');
          const dev = S.device(imei);
          if (dev) dev.simNumber = sim;
          if (typeof Devices.render === 'function') Devices.render();
          Toast.show('ok', sim ? 'SIM 号码已保存' : '已清空 SIM 号码', imei + (sim ? ' · ' + sim : ''));
        }).catch(ex => Toast.show('err', '保存失败', ex.message || String(ex)))
          .finally(() => { simBtn.disabled = false; });
        return;
      }
      const b = e.target.closest('button[data-logs]'); if (!b) return;
      const cmd = b.dataset.logs;
      const d = S.device(Drawer.imei);
      if (!d) return;
      const body = { msgType: 'Ufi-Get-Log-Request', cmd: cmd, imei: d.imei };
      if (cmd === 'pull') body.days = '1';
      b.disabled = true;
      UFI.api.post('ufi/devices/' + encodeURIComponent(d.imei) + '/command', body).then(r => {
        /* wait up to 120s for the device ack, then note pull files land in the collected-logs view */
        return awaitCommandReply(d.imei, r, CMD_REPLY_BUDGET_MS).then(res => {
          if (cmd === 'pull' && res.ok) {
            Toast.show('ok', '日志拉取已触发', d.imei + ' · 设备已确认，文件稍后上传，在「采集日志」页查看下载');
          } else if (res.timeout) {
            Toast.show('warn', '设备 120s 内未回复', d.imei + ' · cmd=' + cmd + '，可稍后在「采集日志」页确认');
          } else {
            Toast.show(res.ok ? 'ok' : 'warn', cmd === 'pull' ? '日志拉取已触发' : ('日志采集已' + (cmd === 'start' ? '开启' : '停止')),
              d.imei + ' · cmd=' + cmd + (res.ok ? '' : ' · ' + (res.error || '失败')));
          }
        });
      }).catch(() => Toast.show('warn', '下发失败', d.imei + ' · cmd=' + cmd)).finally(() => { b.disabled = false; });
    });

    /* header actions */
    const pause = $('#btnPause');
    if (pause) pause.addEventListener('click', e => {
      Devices.live = !Devices.live;
      e.currentTarget.setAttribute('aria-pressed', String(!Devices.live));
      const lab = e.currentTarget.querySelector('span');
      if (lab) lab.textContent = Devices.live ? '实时' : '已暂停';
      Toast.show('info', Devices.live ? '实时刷新已恢复' : '实时刷新已暂停', '10 秒周期拉取 register-status-push');
    });
    const refresh = $('#btnRefresh');
    if (refresh) refresh.addEventListener('click', async () => {
      await S.tick(); Overview.render(); Devices.applyFilters(); Devices.render(); paintSidebarCounters();
      Toast.show('ok', '已同步最新状态', '拉取 register-status-push 增量并重算健康度');
    });
    const platBtn = $('#btnPlatform');
    if (platBtn) platBtn.addEventListener('click', () => {
      const box = $('#ufiPlatform');
      if (box) box.classList.toggle('is-open');
    });
    if ($('#ufi-config-form')) {
      UFI.api.get('ufi/config').then(rows => {
        const c = rows[0] || {};
        const g = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
        g('#cfg_secret', c.secret_key);
        g('#cfg_sip_host', c.sip_host);
        g('#cfg_sip_port', c.sip_port);
        g('#cfg_transport', c.transport);
        g('#cfg_auto', c.auto_provision ? '1' : '0');
      }).catch(() => {});
      $('#ufi-config-form').addEventListener('submit', async e => {
        e.preventDefault();
        const r = await UFI.api.put('ufi/config', {
          secret_key: $('#cfg_secret').value,
          sip_host: $('#cfg_sip_host').value,
          sip_port: $('#cfg_sip_port').value,
          transport: $('#cfg_transport').value,
          auto_provision: $('#cfg_auto').value
        });
        Toast.show(r.ok ? 'ok' : 'warn', r.ok ? '平台配置已保存' : '保存失败', r.ok ? '自动开户 / SIP 登记参数已更新' : ((r.json && r.json.msg) || ''));
      });
    }

    /* init defaults */
    Devices.applyFilters();
    Overview.render();
    Devices.render();
    Records.render();
    paintSidebarCounters();

    /* clock */
    const tickClock = () => {
      const clock = $('#navClock');
      if (!clock) return;
      const d = new Date(), p = n => String(n).padStart(2, '0');
      clock.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };
    tickClock();
    setInterval(tickClock, 1000);

    setInterval(async () => {
      if (!Devices.live) return;
      await S.tick();
      paintSidebarCounters();
      const ov = $('#view-overview'), dv = $('#view-devices'), rec = $('#view-records'), cmd = $('#view-commands'), dl = $('#view-devlogs');
      if (ov && ov.classList.contains('is-active')) Overview.render();
      else if (dv && dv.classList.contains('is-active')) { Devices.applyFilters(); Devices.render(); }
      else if (rec && rec.classList.contains('is-active')) Records.render();
      else if (dl && dl.classList.contains('is-active')) DevLogs.render();
      else if (cmd && cmd.classList.contains('is-active')) Targets.render();
    }, 10000);

    /* command centre — target picker */
    Targets.init();
  }

  /* ==========================================================================
     VIEW — COMMAND CENTRE (target selection)
     ========================================================================== */

  const Targets = {
    alertQ: '',
    alertFrom: '',
    alertTo: '',
    init() {
      $('#tcRefresh').addEventListener('click', () => this.render());
      $('#tcList').addEventListener('click', e => {
        const b = e.target.closest('button[data-tact]'); if (!b) return;
        const tr = b.closest('tr[data-imei]');
        const imei = tr.dataset.imei;
        if (b.dataset.tact === 'cmd') Commands.open([imei]);
        else if (b.dataset.tact === 'log') Commands.openLog([imei]);
        else if (b.dataset.tact === 'set') Settings.open([imei]);
        else if (b.dataset.tact === 'detail') Drawer.open(imei);
      });
      /* alert filters: imei substring + date range */
      const aq = $('#alertSearch'), af = $('#alertFrom'), at = $('#alertTo');
      if (aq) aq.addEventListener('input', () => {
        this.alertQ = aq.value.trim().toLowerCase();
        this.renderAlerts();
      });
      [af, at].forEach(inp => { if (inp) inp.addEventListener('change', () => {
        this.alertFrom = af ? (af.value || '') : '';
        this.alertTo = at ? (at.value || '') : '';
        this.renderAlerts();
      }); });
      const ac = $('#alertSearchClear');
      if (ac) ac.addEventListener('click', () => {
        this.alertQ = '';
        this.alertFrom = '';
        this.alertTo = '';
        if (aq) aq.value = '';
        if (af) af.value = '';
        if (at) at.value = '';
        this.renderAlerts();
      });
      this.render();
    },

    render() {
      /* Prioritise devices that actually need intervention: error → warn → worst health */
      const list = S.devices
        .filter(d => d.severity !== 'ok' || Number(d.cpuUseRate) > 80)
        .sort((a, b) => a.health - b.health)
        .slice(0, 12);

      const st = S.stats();
      $('#tcStats').innerHTML = [
        ['待处理设备', fmtInt(st.warn + st.crit), 'var(--st-warn)', 'alert'],
        ['SIP 掉注册', fmtInt(st.sipDown), 'var(--net-5g)', 'phone'],
        ['VoLTE 未注册', fmtInt(st.volteDown), 'var(--net-4g)', 'antenna'],
        ['SIM 待解锁', fmtInt(st.simLocked), 'var(--st-warn)', 'sim-lock'],
        ['CPU 高负载', fmtInt(st.cpuHigh), 'var(--st-warn)', 'cpu'],
        ['存储紧张', fmtInt(st.storageHigh), 'var(--st-warn)', 'storage']
      ].map(([k, v, col, ic]) =>
        '<div class="kpi" style="--kpi-accent:' + col + '">' +
        '<div class="kpi__head">' + icon(ic) + esc(k) + '</div>' +
        '<div class="kpi__value">' + esc(v) + '<span class="kpi__unit">台</span></div></div>'
      ).join('');

      $('#tcList').innerHTML = list.map(d =>
        '<tr data-imei="' + d.imei + '">' +
        '<td class="cell-ident"><div class="cell-stack"><span class="cell-imei">' + esc(d.imei) + '</span>' +
        '<span class="cell-sub">' + esc(d.sn) + '</span></div></td>' +
        '<td><div class="u-row u-wrap u-gap-1">' +
        d.issues.map(i => '<span class="badge badge--' + (d.severity === 'err' ? 'err' : 'warn') + '">' + esc(i) + '</span>').join('') +
        '</div></td>' +
        '<td><span class="mono-sm">' + esc(d.cellularStatus) + ' · ' + esc(d.operatorName || d.cellularNetwork) + '</span></td>' +
        '<td><span class="sigbars" data-lvl="' + Math.min(Number(d.cellularSignalLevel), 4) + '"><i></i><i></i><i></i><i></i></span></td>' +
        '<td><span class="badge badge--' + (d.voipRegisterStatus === '1' ? 'ok' : 'err') + '">SIP ' + (d.voipRegisterStatus === '1' ? '已注册' : '未注册') + '</span></td>' +
        '<td><span class="score"><span class="score__bar"><i style="width:' + d.health + '%;background:' + (d.health >= 85 ? 'var(--st-ok)' : d.health >= 60 ? 'var(--st-warn)' : 'var(--st-err)') + '"></i></span>' +
        '<span class="score__num">' + d.health + '</span></span></td>' +
        '<td class="col-actions u-text-r"><span class="rowacts">' +
        '<button class="btn btn--icon btn--sm" data-tact="detail" title="详情">' + icon('eye') + '</button>' +
        '<button class="btn btn--icon btn--sm" data-tact="cmd" title="下发指令">' + icon('terminal') + '</button>' +
        '<button class="btn btn--icon btn--sm" data-tact="log" title="获取日志">' + icon('file') + '</button>' +
        '<button class="btn btn--icon btn--sm" data-tact="set" title="设备设置">' + icon('sliders') + '</button>' +
        '</span></td></tr>'
      ).join('');
      this.renderAlerts();
    },

    renderAlerts() {
      const el = $('#alertList');
      if (!el) return;
      const KIND_NAMES = {
        offline: '离线 / 恢复在线', ws_down: '心跳保活失败', ws_up: '心跳恢复',
        sip_down: 'SIP 掉线', sip_up: 'SIP 重新注册',
        volte_down: 'VoLTE 掉线', volte_up: 'VoLTE 恢复',
        cpu_high: 'CPU 高负荷', cpu_ok: 'CPU 恢复正常',
        storage_high: '存储紧张', sim_bad: 'SIM 卡异常'
      };
      const list = (S.alerts || []).slice();
      let hits = list;
      if (this.alertQ) hits = hits.filter(a => String(a.imei || '').toLowerCase().indexOf(this.alertQ) >= 0);
      if (this.alertFrom || this.alertTo) hits = hits.filter(a => {
        const day = String(a.createdAt || '').slice(0, 10);
        return (!this.alertFrom || day >= this.alertFrom) && (!this.alertTo || day <= this.alertTo);
      });
      const cnt = $('#alertCount');
      if (cnt) cnt.textContent = '共 ' + fmtInt(list.length) + ' 条' +
        (hits.length !== list.length ? ' · 筛选出 ' + fmtInt(hits.length) + ' 条' : '');
      if (!hits.length) {
        el.innerHTML = '<tr><td colspan="4"><div class="empty">' + icon('file') +
          '<h4 class="empty__title">' + (list.length ? '无匹配的异常事件' : '暂无异常事件') + '</h4>' +
          '<p class="empty__desc">' + (list.length ? '当前 IMEI / 日期筛选条件下没有记录，试试清空筛选。' : '设备状态推送出现异常变更（掉线 / 高负荷等）时自动记录在此。') + '</p></div></td></tr>';
        return;
      }
      el.innerHTML = hits.slice(0, 100).map(a => {
        const lv = a.level === 'err' ? 'err' : a.level === 'ok' ? 'ok' : 'warn';
        return '<tr>' +
          '<td><span class="mono-sm">' + esc((a.createdAt || '').replace('T', ' ').slice(0, 19)) + '</span></td>' +
          '<td><span class="mono-sm">' + esc(a.imei) + '</span></td>' +
          '<td><span class="badge badge--' + lv + '">' + esc(KIND_NAMES[a.kind] || a.kind) + '</span></td>' +
          '<td><span class="cell-sub" style="white-space:normal">' + esc(a.detail || '—') + '</span></td>' +
          '</tr>';
      }).join('');
    }
  };

  document.addEventListener('DOMContentLoaded', () => { boot().catch(err => console.error(err)); });
})();
