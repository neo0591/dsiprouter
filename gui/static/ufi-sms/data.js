/* ============================================================================
   UFI SMS Center — data layer（真实 API 客户端 + 缓存）
   后端：/api/v1/ufi/sms/*（ufi_sms.py）；设备台账由后端按 IMEI 关联
   保持与原型一致的 DB 访问面（DB.sms.settings / channelList / checkWords ...），
   差异：全部为 API 数据，records 服务端分页。
   ========================================================================= */
(function () {
  'use strict';

  const BASE = '/api/v1/ufi/sms/';

  async function apiGet(path) {
    const url = BASE + path.replace(/^\//, '') + (path.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/'; throw new Error('登录已过期，正在跳转登录页…'); }
    if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
    return json.data || [];
  }
  async function apiSend(path, method, body) {
    const res = await fetch(BASE + path.replace(/^\//, ''), {
      method: method || 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/'; throw new Error('登录已过期，正在跳转登录页…'); }
    if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
    return json;
  }

  const DB = {
    /* overview 缓存（settings/health/channels/counts/quiet） */
    ov: { settings: {}, quiet_now: false, health: {}, channels: [], counts: {} },
    /* 与原型同名访问面 */
    sms: { settings: {}, tpl: [], tasks: [] },
    blacklist: [],
    words: [],

    /* 收发记录：服务端分页状态 */
    recordsQ: { dir: '', q: '', task: '', country: '', page: 1, size: 15, date_from: '', date_to: '' },
    tasksQ: { date_from: '', date_to: '' },
    tplQ: { date_from: '', date_to: '' },
    blackQ: { date_from: '', date_to: '' },
    records: { list: [], total: 0, page: 1, pages: 1 },

    loaded: false,
    policies: [],

    _withDates(path, q) {
      const parts = [];
      if (q && q.date_from) parts.push('date_from=' + encodeURIComponent(q.date_from));
      if (q && q.date_to) parts.push('date_to=' + encodeURIComponent(q.date_to));
      if (!parts.length) return path;
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
    },

    async refresh() {
      const d = await apiGet('overview');
      const o = d[0] || {};
      DB.ov = o;
      DB.sms.settings = o.settings || {};
      DB.policies = o.policies || [];
      DB.carriers = o.carriers || [];
      DB.loaded = true;
      return o;
    },
    /* 模板 / 黑名单始终拉全量（发送页与校验依赖）；列表页在前端按时间筛 */
    async loadTpl() { DB.sms.tpl = await apiGet('tpl'); },
    async loadTasks() { DB.sms.tasks = await apiGet(DB._withDates('tasks', DB.tasksQ)); },
    async loadBlack() { DB.blacklist = await apiGet('black'); },
    async loadWords() { DB.words = await apiGet('words'); },
    async loadRecords() {
      const q = DB.recordsQ;
      const qs = DB._withDates(
        'records?dir=' + encodeURIComponent(q.dir || '') + '&q=' + encodeURIComponent(q.q || '') +
        '&task=' + encodeURIComponent(q.task || '') +
        '&country=' + encodeURIComponent(q.country || '') +
        '&page=' + q.page + '&size=' + q.size, q);
      const d = await apiGet(qs);
      DB.records = d[0] || { list: [], total: 0, page: 1, pages: 1 };
      return DB.records;
    },
    async loadThread(peer) {
      const d = await apiGet('records/thread?peer=' + encodeURIComponent(peer || ''));
      return d[0] || { peer: peer, list: [], total: 0 };
    },

    /* ---------- 派生（读缓存，即时） ---------- */
    channelList() { return DB.ov.channels || []; },
    usableChannels() { return (DB.ov.channels || []).filter(c => c.state === 'ok'); },
    quietNow() { return !!DB.ov.quiet_now; },
    health() {
      const h = DB.ov.health || {};
      const t = DB.sms.tasks || [];
      return Object.assign({
        running: t.filter(x => x.state === 'running').length,
        scheduled: t.filter(x => x.state === 'scheduled').length,
        queued: t.filter(x => x.state === 'running' || x.state === 'scheduled')
          .reduce((a, x) => a + Math.max(0, (x.total || 0) - (x.sent || 0)), 0)
      }, h);
    },
    checkWords(body) { return (DB.words || []).filter(w => w && body.indexOf(w) >= 0); },
    blackSet() { return new Set(DB.blacklist.map(b => b.num)); },
    isBlack(num) { return DB.blackSet().has(num); },
    tplUsage(id) { return DB.sms.tasks.filter(t => t.tpl_id === id).length; },

    /* ---------- 突变（API + 刷新） ---------- */
    async send(peer, body, imei, policyId) {
      const r = await apiSend('send', 'POST', { peer: peer, body: body, imei: imei || '', policy_id: policyId || 0 });
      await DB.refresh();
      return (r.data && r.data[0]) || null;
    },
    async addTask(t) {
      const r = await apiSend('tasks', 'POST', t);
      await Promise.all([DB.loadTasks(), DB.refresh()]);
      return (r.data && r.data[0]) || null;
    },
    async taskItems(id, kind) {
      const d = await apiGet('tasks/' + id + '/items?kind=' + encodeURIComponent(kind || 'batch'));
      return d[0] || { task: {}, items: [] };
    },
    async taskAct(id, act) { await apiSend('tasks/' + id, 'POST', { action: act }); await Promise.all([DB.loadTasks(), DB.refresh()]); },
    async schedAct(id, act) { await apiSend('scheds/' + id, 'POST', { action: act }); await Promise.all([DB.loadTasks(), DB.refresh()]); },
    async tplAdd(t) { await apiSend('tpl', 'POST', t); await DB.loadTpl(); },
    async tplUpdate(id, t) { await apiSend('tpl/' + id, 'POST', Object.assign({ action: 'update' }, t)); await DB.loadTpl(); },
    async tplDel(id) { await apiSend('tpl/' + id, 'POST', { action: 'del' }); await Promise.all([DB.loadTpl(), DB.refresh()]); },
    async blackAdd(nums, src) {
      const r = await apiSend('black', 'POST', { nums: nums.join(','), src: src });
      await Promise.all([DB.loadBlack(), DB.refresh()]);
      return (r.data && r.data[0]) || { added: 0, dup: 0 };
    },
    async blackDel(num) { await apiSend('black/' + num, 'POST', { action: 'del' }); await Promise.all([DB.loadBlack(), DB.refresh()]); },
    async blackClear(src) { await apiSend('black/__clear__', 'POST', { action: 'clear', src: src }); await Promise.all([DB.loadBlack(), DB.refresh()]); },
    async wordAdd(list) {
      const r = await apiSend('words', 'POST', { words: list.join(',') });
      await Promise.all([DB.loadWords(), DB.refresh()]);
      return (r.data && r.data[0] || {}).added || 0;
    },
    async wordDel(w) { await apiSend('words/' + encodeURIComponent(w), 'POST', { action: 'del' }); await Promise.all([DB.loadWords(), DB.refresh()]); },
    async saveSettings(patch) { await apiSend('settings', 'PUT', patch); await DB.refresh(); },
    async savePolicy(p) {
      if (p.id) await apiSend('policies/' + p.id, 'PUT', p);
      else await apiSend('policies', 'POST', p);
      await DB.refresh();
    },
    async policyDel(id) { await apiSend('policies/' + id, 'DELETE'); await DB.refresh(); },
    async channelToggle(imei) { await apiSend('channel/' + imei, 'POST', {}); await DB.refresh(); },
    async loadPoolMembers() {
      const rows = await apiGet('pool-members');
      DB.poolMembers = (rows && rows[0]) || { devices: [], pools: [], total: 0 };
      return DB.poolMembers;
    },
    async setPoolMember(imei, poolId, inPool) {
      return DB.setPoolMembers([imei], poolId, inPool);
    },
    async setPoolMembers(imeis, poolId, inPool, sim) {
      const list = (imeis || []).map(x => String(x || '').trim()).filter(Boolean);
      const body = { imeis: list, pool_id: poolId, in_pool: inPool ? 1 : 0 };
      if (sim != null && list.length === 1) body.sim = sim;
      const r = await apiSend('pool-members', 'POST', body);
      await DB.loadPoolMembers();
      await DB.refresh();
      return r;
    },
    carriers: [],
    async saveCarrier(carrier, payload) {
      await apiSend('carriers/' + encodeURIComponent(carrier), 'PUT', payload || {});
      await DB.refresh();
    },

    /* ---------- 开放 API Keys ---------- */
    apikeys: [],
    async loadApiKeys() { DB.apikeys = await apiGet('apikeys'); return DB.apikeys; },
    async createApiKey(payload) {
      const r = await apiSend('apikeys', 'POST', payload || {});
      await DB.loadApiKeys();
      return (r.data && r.data[0]) || null;
    },
    async apiKeyAct(id, body) {
      await apiSend('apikeys/' + id, 'POST', body || {});
      await DB.loadApiKeys();
    },

    /* ---------- 接入 IP 白名单（短信 API + 通话运营商组） ---------- */
    whitelist: { cfg: { sms_enabled: 0, carrier_enabled: 0 }, items: [], client_ip: '' },
    async _wlFetch(path, method, body) {
      const isGet = !method || method === 'GET';
      let url = '/api/v1/ufi/access/whitelist' + (path || '');
      if (isGet) url += (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      const opt = { credentials: 'same-origin', cache: 'no-store', method: method || 'GET' };
      if (body) {
        opt.headers = { 'Content-Type': 'application/json' };
        opt.body = JSON.stringify(body);
      }
      const res = await fetch(url, opt);
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) { location.href = '/'; throw new Error('登录已过期'); }
      if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
      return json;
    },
    async loadWhitelist() {
      const r = await DB._wlFetch('', 'GET');
      DB.whitelist = (r.data && r.data[0]) || { cfg: {}, items: [], client_ip: '' };
      return DB.whitelist;
    },
    async saveWhitelistCfg(cfg) {
      await DB._wlFetch('/cfg', 'POST', cfg || {});
      await DB.loadWhitelist();
    },
    async addWhitelist(payload) {
      await DB._wlFetch('', 'POST', payload || {});
      await DB.loadWhitelist();
    },
    async whitelistAct(id, body) {
      await DB._wlFetch('/' + id, 'POST', body || {});
      await DB.loadWhitelist();
    },

    /* ---------- 开放 API 调用日志 ---------- */
    apiLogsQ: {
      dir: '', caller: '', callee: '', carrier: '',
      date_from: '', date_to: '', page: 1, size: 15
    },
    apiLogs: { list: [], total: 0, page: 1, pages: 1, size: 15, carriers: [] },
    async loadApiLogs() {
      const q = DB.apiLogsQ;
      const parts = [
        'page=' + (q.page || 1),
        'size=' + (q.size || 15)
      ];
      if (q.dir) parts.push('dir=' + encodeURIComponent(q.dir));
      if (q.caller) parts.push('caller=' + encodeURIComponent(q.caller));
      if (q.callee) parts.push('callee=' + encodeURIComponent(q.callee));
      if (q.carrier) parts.push('carrier=' + encodeURIComponent(q.carrier));
      if (q.date_from) parts.push('date_from=' + encodeURIComponent(q.date_from));
      if (q.date_to) parts.push('date_to=' + encodeURIComponent(q.date_to));
      const d = await apiGet('apilogs?' + parts.join('&'));
      DB.apiLogs = d[0] || { list: [], total: 0, page: 1, pages: 1, size: 15, carriers: [] };
      return DB.apiLogs;
    }
  };

  window.DB = DB;
})();
