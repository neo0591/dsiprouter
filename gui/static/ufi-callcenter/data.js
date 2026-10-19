/* ============================================================================
   UFI Call Center Console — live data layer
   ----------------------------------------------------------------------------
   设备台账（只读）：GET /api/v1/ufi/comm → dsip_ufi_device（设备管理模块所有）
   通信属性（可写）：dsip_ufi_pool（本模块维护，按 IMEI 关联台账）
   呼入映射（只读）：kamailio.dbaliases（alias_username → username）
   实时通话流：     GET /api/v1/ufi/records → dsip_ufi_call

   静态知识库保留自原型：POOLS / STRATEGIES / FALLBACKS / PATCHES / TROUBLE /
   snapshot / sop / guideTpl（池元数据、排障库、客户指引单模板，无后端依赖）。
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- API */
  function apiBase() {
    return (typeof API_BASE_URL === 'string' ? API_BASE_URL : '/api/v1/').replace(/\/?$/, '/');
  }
  async function apiGet(path) {
    const url = apiBase() + path.replace(/^\//, '') + (path.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      /* 会话失效（如 GUI 重启后）：跳登录页，避免页面静默退化为"台账未联动" */
      location.href = '/';
      throw new Error('登录已过期，正在跳转登录页…');
    }
    if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
    return json.data || [];
  }
  async function apiSend(path, method, body) {
    const res = await fetch(apiBase() + path.replace(/^\//, ''), {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = '/';
      throw new Error('登录已过期，正在跳转登录页…');
    }
    return { ok: res.ok, status: res.status, json: json, data: (json.data && json.data[0]) || json.data || json };
  }

  const OPERATORS = [
    { code: '46000', name: '中国移动' }, { code: '46002', name: '中国移动' },
    { code: '46004', name: '中国移动' }, { code: '46007', name: '中国移动' },
    { code: '46008', name: '中国移动' }, { code: '46020', name: '中国移动' },
    { code: '46001', name: '中国联通' }, { code: '46006', name: '中国联通' },
    { code: '46009', name: '中国联通' },
    { code: '46003', name: '中国电信' }, { code: '46005', name: '中国电信' },
    { code: '46011', name: '中国电信' }, { code: '46015', name: '中国广电' },
    { code: '45412', name: 'CMLink' },
    { code: '310260', name: 'T-Mobile US' }, { code: '310240', name: 'T-Mobile US' },
    { code: '310410', name: 'AT&T' }, { code: '310150', name: 'AT&T' },
    { code: '311480', name: 'Verizon' },
    { code: '302720', name: 'Rogers' }, { code: '302610', name: 'Bell' }, { code: '302220', name: 'TELUS' },
    { code: '52501', name: 'Singtel' }, { code: '52503', name: 'M1' },
    { code: '52505', name: 'StarHub' }, { code: '52510', name: 'SIMBA Telecom' },
    { code: '23430', name: 'EE' }, { code: '23410', name: 'O2' },
    { code: '23415', name: 'Vodafone' }, { code: '23420', name: 'Three' },
    { code: '20801', name: 'Orange' }, { code: '20810', name: 'SFR' },
    { code: '20820', name: 'Bouygues Telecom' }, { code: '20815', name: 'Free Mobile' },
    { code: '26201', name: 'Telekom Deutschland' }, { code: '26202', name: 'Vodafone Germany' },
    { code: '26207', name: 'O2 Germany' },
    { code: '22201', name: 'TIM' }, { code: '22210', name: 'Vodafone Italy' },
    { code: '21401', name: 'Vodafone Spain' }, { code: '21403', name: 'Orange Spain' },
    { code: '20404', name: 'Vodafone Netherlands' }, { code: '20408', name: 'KPN' },
    { code: '44010', name: 'NTT DOCOMO' }, { code: '44050', name: 'KDDI' },
    { code: '44020', name: 'SoftBank' }, { code: '44011', name: 'Rakuten Mobile' },
    { code: '45005', name: 'SK Telecom' }, { code: '45008', name: 'KT' }, { code: '45006', name: 'LG U+' },
    { code: '40445', name: 'Airtel' }, { code: '40410', name: 'Airtel' }, { code: '405840', name: 'Jio' },
    { code: '51010', name: 'Telkomsel' }, { code: '51001', name: 'Indosat' }, { code: '51011', name: 'XL Axiata' },
    { code: '50212', name: 'Maxis' }, { code: '50213', name: 'CelcomDigi' },
    { code: '52001', name: 'AIS' }, { code: '52005', name: 'dtac' }, { code: '52099', name: 'TrueMove H' },
    { code: '50501', name: 'Telstra' }, { code: '50502', name: 'Optus' }, { code: '50503', name: 'Vodafone Australia' },
    { code: '53001', name: 'Spark New Zealand' }, { code: '53005', name: 'One NZ' }
  ];
  function resolveOperator(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    const digits = s.replace(/\D/g, '');
    if (/^\d{5,6}/.test(digits)) {
      let hit = null;
      OPERATORS.forEach(o => {
        if (digits.indexOf(o.code) === 0 && (!hit || o.code.length > hit.code.length)) hit = o;
      });
      if (hit) return hit.name;
      return s;
    }
    return s;
  }
  /* 网络类型归一化到池筛选使用的标签集合 */
  const NET_LABELS = {
    'nr': '5G SA', 'nr-nsa': '5G NSA', '5g': '5G SA', '5g sa': '5G SA', '5g nsa': '5G NSA',
    'lte': 'LTE', 'lte-a': 'LTE', 'hspa': 'HSPA+', 'hspa+': 'HSPA+', 'wifi': 'WIFI', 'none': '—'
  };
  function netLabel(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'none') return '—';
    return NET_LABELS[s] || String(v || '—').toUpperCase();
  }

  function pick(row) {
    for (let i = 1; i < arguments.length; i++) {
      const k = arguments[i];
      if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return '';
  }

  /* 健康分派生（与设备监控模块口径一致：SIP/SIM 异常为 err，其余越线为 warn） */
  function scoreDevice(d) {
    const issues = [];
    /* 入参兼容：adapt 后的展示对象（sipReg/volte 布尔、simStateRaw）或原始台账行 */
    const sipReg = d.sipReg != null ? !!d.sipReg : String(d.voipRegisterStatus) === '1';
    const volte = typeof d.volte === 'boolean' ? d.volte : String(d.volteRegisterStatus) === '1';
    const simState = String(d.simStateRaw || d.simState || 'READY').toUpperCase();
    if (!sipReg) issues.push('SIP 未注册');
    if (!volte) issues.push('VoLTE 未注册');
    if (simState !== 'READY') issues.push('SIM ' + (simState === 'ABSENT' ? '无卡' : simState));
    if (d.band === '—' || !d.band) issues.push('无频段上报');
    const cpu = +(d.cpu != null ? d.cpu : d.cpuUseRate) || 0,
          sto = +(d.storage != null ? d.storage : d.storageUseRate) || 0,
          mem = +(d.mem != null ? d.mem : d.memoryUseRate) || 0;
    if (cpu >= 85) issues.push('CPU ' + cpu + '%');
    if (sto >= 88) issues.push('存储 ' + sto + '%');
    if (mem >= 88) issues.push('内存 ' + mem + '%');
    if (d.rsrp != null && d.rsrp < -110) issues.push('RSRP ' + d.rsrp);
    let health = 100;
    if (!sipReg) health -= 35;
    if (!volte) health -= 12;
    if (simState !== 'READY') health -= 20;
    if (cpu >= 85) health -= 10;
    if (sto >= 88) health -= 10;
    if (d.rsrp != null && d.rsrp < -110) health -= 8;
    health = Math.max(5, health);
    const severity = (!sipReg || simState === 'ABSENT') ? 'err' : issues.length ? 'warn' : 'ok';
    d.health = health;
    d.severity = severity;
    d.issues = issues;
    return d;
  }

  /* ------------------------------------------------ 设备台账 → 通信模块对象
     设备属性只读；通信属性（pool_id/enabled/in_pool/weight/max_concurrent…）
     由 /ufi/comm 的 comm 字段平铺，写操作走 PUT /ufi/comm/<imei>。 */
  function adapt(row, i, comm) {
    const sig = +row.cellularSignalLevel || 0;
    const registered = String(row.voipRegisterStatus) === '1';
    const simStateRaw = String(row.simState || 'READY').toUpperCase();
    const sim = String(row.simNumber || '').replace(/^\+?86/, '').replace(/[^\d]/g, '');
    const d = {
      idx: i,
      /* ── 设备台账（只读） ── */
      imei: String(pick(row, 'imei')),
      sn: String(pick(row, 'sn') || '—'),
      sim: sim || '—',
      simRaw: row.simNumber || null,
      imsi: String(pick(row, 'imsi') || '—'),
      model: (row.agentType || 'Linkcircle-UFI-C') + (row.apkVersion ? ' / ' + row.apkVersion : ''),
      vendor: resolveOperator(row.operatorCode) || row.operatorShort || row.cellularNetwork || '—',
      fw: row.buildNumber || '—',
      net: netLabel(row.networkType),
      networkPath: 'mobile',
      band: String(row.band || '—'),
      earfcn: String(row.serviceCellEARFCN || '0'),
      signal: Math.max(0, Math.min(3, sig)),
      rsrp: row.rsrp == null ? '—' : Number(row.rsrp),
      rsrq: row.rsrq == null ? '—' : Number(row.rsrq),
      volte: String(row.volteRegisterStatus) === '1',
      /* 在线 = 后端 location 注册条目有效（online）或 WS 心跳在线（wsOnline） */
      online: !!(row.online || row.wsOnline || String(row.ws_online) === '1'),
      registered: registered,
      sipReg: registered,
      sipStatus: registered ? '已注册' : '未注册',
      simState: simStateRaw === 'READY' ? '就绪' : (simStateRaw === 'ABSENT' ? '无卡' : '待解锁'),
      simStateRaw: simStateRaw,
      cpu: +row.cpuUseRate || 0,
      mem: +row.memoryUseRate || 0,
      storage: +row.storageUseRate || 0,
      lastSeen: row.lastSeen || null,
      voipRegisterStatus: String(row.voipRegisterStatus || '0'),
      /* ── 通信属性（本模块维护） ── */
      pool_id: comm.pool_id || '—',
      carrier: comm.carrier || '100',
      enabled: comm.enabled !== false,
      in_pool: !!comm.in_pool,
      weight: comm.weight || 1,
      max_concurrent: comm.max_concurrent != null ? comm.max_concurrent : 2,
      active_calls: comm.active_calls || 0,
      last_used_min: null,
      calls_today: Number(row.callsToday || 0),
      asr_today: null,
      note: comm.note || ''
    };
    return scoreDevice(d);
  }

  /* start_ts 存设备上报的毫秒 epoch 字符串；兼容秒/ISO 串（与设备监控 parseTs 同口径） */
  function parseTs(value) {
    if (value == null || value === '') return Date.now();
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const n = Number(value);
    if (!Number.isNaN(n) && String(value).length >= 10 && /^\d+$/.test(String(value))) {
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(String(value).replace(' ', 'T'));
    return Number.isNaN(t) ? Date.now() : t;
  }

  /* ------------------------------------------------ 实时通话 → 原型 call 结构 */
  function adaptCall(row, i, ufiByImei) {
    const u = ufiByImei ? ufiByImei(String(row.imei || '')) : null;
    const answered = !!row.answered;
    const rejected = !!row.rejected;
    const dirRaw = String(row.direction || row.dir || 'incoming').toLowerCase();
    const dir = (dirRaw === 'out' || dirRaw === 'outgoing' || dirRaw === 'mo') ? 'out' : 'in';
    const outcome = String(row.outcome || (
      answered ? 'answered' : rejected ? 'rejected'
        : /fail|error|timeout|busy|cancel/i.test(String(row.result || '') + ' ' + String(row.failReason || row.fail_reason || ''))
          ? 'failed' : 'unanswered'
    ));
    const carrier = String(row.carrier || (u && u.carrier) || '100');
    const pool = String(row.poolId || row.pool_id || (u && u.pool_id) || '—');
    return {
      id: String(row.traceId || row.trace_id || row.id || ('C' + (100000 + i))),
      dir: dir,
      peer: String(row.peer || '—'),
      imei: String(row.imei || '—'),
      sim: u ? u.sim : '—',
      pool: pool,
      carrier: carrier,
      outcome: outcome,
      state: answered ? 'talk' : ((rejected || outcome === 'failed') ? 'fail' : 'done'),
      dur: Number(row.durationSec || row.duration_sec || 0),
      at: new Date(parseTs(row.startTs || row.start_ts || row.created_at)),
      ua: u ? u.net : '—',
      result: String(row.result || ''),
      failReason: String(row.failReason || row.fail_reason || ''),
      traceId: String(row.traceId || row.trace_id || ''),
      routeCallId: String(row.routeCallId || row.route_call_id || ''),
      vlog: String(row.volteLog || row.volte_log || ''),
      slog: String(row.sipLog || row.sip_log || ''),
      routeLog: String(row.routeLog || row.route_log || ''),
      answered: answered,
      rejected: rejected,
      createdAt: String(row.created_at || '')
    };
  }

  /* ================================================================ 池元数据（静态） */
  const POOLS = [
    { id: 'P1', name: '主用池（电商客服）', strat: 'failover', max_try: 2, retry_gap_s: 8,  member_q: 'Q1', enabled: true, fallback: 'reject' },
    { id: 'P2', name: '夜间池',           strat: 'online',   max_try: 1, retry_gap_s: 0,  member_q: 'Q3', enabled: true, fallback: 'Q4' },
    { id: 'P3', name: '外呼营销池',        strat: 'wrr',      max_try: 3, retry_gap_s: 15, member_q: 'Q5', enabled: true, fallback: 'P1' },
    { id: 'P4', name: '维护暂存池',       strat: 'rr',       max_try: 1, retry_gap_s: 0,  member_q: '',   enabled: false, fallback: 'reject' }
  ];
  const STRATEGIES = [
    { id: 'rr',      name: '严格轮询', en: 'Round-Robin',  icon: 'repeat',   tag: '当前线上', tagKind: 'ok',
      desc: 'htable 计数器逐台交替，已双 UFI 验证。扩容需注意计数器语义。' },
    { id: 'rand',    name: '随机',     en: 'Random',       icon: 'shuffle',  tagKind: '',
      desc: '等概率取一台，实现最简。cfg {s.select} + 随机数或 ORDER BY RAND()。' },
    { id: 'wrr',     name: '加权轮询', en: 'Weighted RR',  icon: 'weight',   tagKind: '',
      desc: '按 ufi_pool.weight 映射区间，权重大的被选概率高。适合新旧线路质量差异。' },
    { id: 'lru',     name: '最长空闲', en: 'LRU',          icon: 'clock',    tagKind: '',
      desc: '按 last_used_at 升序取，呼叫结束后回写。天然均衡负载与电池老化。' },
    { id: 'online',  name: '在线优先', en: 'Online-first', icon: 'antenna',  tagKind: '',
      desc: '仅 location 有注册（未过期）的入池，选路前 ul.lookup 校验。' },
    { id: 'failover',name: '故障转移', en: 'Failover',     icon: 'alert-tri', tagKind: 'warn',
      desc: '失败响应（408/486/503/超时）自动重选下一台，可配最大重试次数。' },
    { id: 'concl',   name: '并发上限', en: 'Concurrency',  icon: 'layers',   tagKind: '',
      desc: '单 UFI 满负荷自动跳下一台。依赖 active_calls，htable 增减。' },
    { id: 'time',    name: '时段路由', en: 'Time-based',   icon: 'calendar', tagKind: '',
      desc: '工作时段池 A、夜间池 B。cfg $time 条件或由 GUI 生成路由规则。' }
  ];
  const FALLBACKS = [
    { id: 'reject', name: '拒绝（回 404 / 忙音）', desc: '池空且无兜底时直接拒呼，最安全但影响接通率。' },
    { id: 'queue',  name: '回落 VOS 落地',       desc: '改走 VOS 现有中继落地，保持通话可接但号码线路不匹配。' },
    { id: 'fixed',  name: '指定单台兜底',       desc: '固定一台应急线路，需要额外维护，容易成单点。' },
    { id: 'Q4',     name: '转指定队列（VOS 侧）', desc: '转到 VOS 现有队列排队等待，柔性降级，需客户侧配合配置，推荐。' }
  ];
  const PATCHES = [
    { id: 'A', name: '补丁 A — 来显还原（X-VOLTE → From）', target: '/etc/kamailio/kamailio.cfg',
      desc: 'MO 方向从 X-VOLTE 取真实主叫写 From。缺失会导致 1002 来显=IMEI。',
      snippet: 'if(hmf_contains("$hdr(X-VOLTE)")) { $var(from)=$(rb{sip.msg}); setFromHeader(); }',
      enabled: true, critical: true },
    { id: 'B', name: '补丁 B — 轮询池选路（已改 sqlops）', target: '/etc/kamailio/kamailio.cfg',
      desc: '原 IMEI 硬编码列表，GUI 化后改为 sqlops 动态查 ufi_pool 表，加设备零重启。',
      snippet: 'modparam("sqlops","sqlcon","ka=>mysql://.../kamailio")\nsql_query("ka","select imei from dsip_ufi_pool where enabled=1 and in_pool=1 order by last_used_at limit 1")',
      enabled: true, critical: true },
    { id: 'C', name: '补丁 C — 对称桥接（R-URI=IMEI + X-VOLTE）', target: '/etc/kamailio/kamailio.cfg',
      desc: 'UFI 方言核心。R-URI 放真实被叫 UFI 不认领，必须 R-URI=IMEI、X-VOLTE=真实号码。',
      snippet: '$rU = $rU; $hdr(X-VOLTE) = $rU; uac_replace_from(); route(NATMANAGE);',
      enabled: true, critical: true },
    { id: 'D', name: '补丁 D — 关闭 rtpengine', target: '/etc/kamailio/kamailio.cfg',
      desc: 'WITH_RTPENGINE 必须注释，否则 200 OK 不回传，对端持续振铃。',
      snippet: '# WITH_RTPENGINE=yes   # 必须注释：No RTP proxy, media handled by UFI directly',
      enabled: true, critical: true }
  ];
  const EFFECT = {
    live:    { label: '即时生效', desc: '写入即生效，无需 reload/重启。典型：subscriber、dbaliases、htable。' },
    reload:  { label: '需 reload', desc: '需执行 kamcmd permissions.addressReload（或 wsg 权限重载）。' },
    restart: { label: '需重启',   desc: '需重启服务进程：mbx3000d 或 kamailio restart。批量修改可合并为一次重启。' }
  };
  const OWNER = {
    ours:   { id: 'ours',   label: '我方',   sys: 'dSIPRouter', canExec: true,
              note: '自建服务器，我方有 SSH 与数据库权限，可直接执行并回显结果' },
    client: { id: 'client', label: '客户',   sys: 'VOS3000', canExec: false,
              note: '客户资产，我方不碰。生成配置指引单 → 客户在 VOS 管理界面完成 → 我方验收' }
  };
  const NODES = {
    ufi:      { id: 'ufi',      name: 'UFI 设备',  host: '分散在客户现场',     proto: 'SIP over UDP' },
    ksrlocal: { id: 'ksrlocal', name: 'dSIPRouter', host: '106.75.29.22:5060', proto: 'Kamailio 5.x' },
    vos:      { id: 'vos',      name: 'VOS3000',   host: '8.136.109.38:5060', proto: 'SIP + MySQL' },
    agent1002:{ id: 'agent1002',name: '坐席话机',  host: '1002 / 1004 …',     proto: 'SIP UA' }
  };
  const OUT_RULES = [
    { id: 'OR1', name: '国内座机/手机 0-9', prefix: '1', pool: 'P1', auth: 'prefix', max_try: 2, retry_gap_s: 8,  record: true, enabled: true },
    { id: 'OR2', name: '400/800 服务号', prefix: '400,800', pool: 'P1', auth: 'prefix', max_try: 1, retry_gap_s: 0, record: true, enabled: true },
    { id: 'OR3', name: '仅营销池（时段）', prefix: '外呼白名单', pool: 'P3', auth: 'whitelist', max_try: 3, retry_gap_s: 15, record: true, enabled: true },
    { id: 'OR4', name: '国际长途（禁用）', prefix: '00', pool: '—', auth: 'deny', max_try: 0, retry_gap_s: 0, record: false, enabled: false }
  ];
  const TROUBLE = [
    { q: 'VOS CDR 显示"服务器挂断 / Temporarily Unavailable"',
      cause: 'dSIPRouter 对 VOS 回 407 Unauthorized', scope: 'ours', crit: true,
      check: "select port from address where ip_addr='8.136.109.38'",
      fix: '我方执行：把 address.port 改为 0（任意源端口），再执行 kamcmd permissions.addressReload' },
    { q: '坐席 1002 来显显示成 IMEI（861717067605136）',
      cause: 'X-VOLTE 头缺失或补丁 A 未生效', scope: 'ours', crit: true,
      check: "grep X-VOLTE /var/log/kamailio/kamailio.log | tail -40",
      fix: '我方执行：确认补丁 A 已启用且打在 /etc/kamailio/kamailio.cfg，reload kamailio' },
    { q: '接起后对端仍持续振铃',
      cause: 'rtpengine 缺失，200 OK 未回传', scope: 'ours',
      check: "grep -n WITH_RTPENGINE /etc/kamailio/kamailio.cfg",
      fix: '我方执行：将 WITH_RTPENGINE 注释掉（媒体由 UFI 侧直通），重启 kamailio' },
    { q: 'UFI 设备全部不注册',
      cause: 'subscriber 未开户 / 密码不符 md5(IMEI)[:16] / kamailio 未运行', scope: 'ours', crit: true,
      check: "kamcmd ul dump; select username,domain from subscriber where username='<IMEI>';",
      fix: '我方执行：重跑 dsip_add_ufi.py <IMEI> <SIM>（幂等），并检查 kamailio 服务状态' },
    { q: '轮询策略改了不生效',
      cause: '补丁打到了 /etc/dsiprouter/…，服务实际读 /etc/kamailio/…', scope: 'ours',
      check: "md5sum /etc/kamailio/kamailio.cfg /etc/dsiprouter/kamailio/kamailio.cfg",
      fix: '我方执行：补丁一律打到服务文件；建议迁到 sqlops 动态查表，彻底摆脱 cfg 硬编码' },
    { q: '新增线路后 UFI 注册不上',
      cause: 'subscriber 密码未按 md5(IMEI)[:16] 生成，或 dbaliases 未插入', scope: 'ours',
      check: "select * from dbaliases where alias_username='<SIM>';",
      fix: '我方执行：重跑 dsip_add_ufi.py <IMEI> <SIM>（幂等），再单独 INSERT dbaliases' },
    { q: 'CDR 报"无可用路由" / 404',
      cause: 'VOS 落地/对接网关「网关前缀」仍是逐号白名单，新被叫未命中', scope: 'client', crit: true,
      check: 'VOS → 网关管理 → dsip接入 → 网关前缀/呼出号段：若是一串完整 11 位号，即为错误的逐号模式',
      fix: '客户一次性改为前缀通配（推荐 1,0,400,800），保存并重载。之后任意国内被叫无需再改 VOS' },
    { q: '改了号段但外呼仍被拒',
      cause: '客户侧 conf 与 DB 不一致，或话务配置未重载', scope: 'client',
      check: '请客户确认保存后是否按其运维规范重载了话务配置',
      fix: '客户处理：重载或重启话务服务后复测。我方无客户设备操作权限' },
    { q: '坐席分机不注册 / 呼入不响铃',
      cause: '客户侧话机未注册，或坐席处于示忙 / 离线', scope: 'client',
      check: '请客户在 VOS 界面确认话机注册状态与坐席状态',
      fix: '客户处理：坐席置为示闲并确认话机在线，我方再做拨测验收' },
    { q: '录音缺失 / 找不到录音文件',
      cause: '客户侧录音未开启，或无调阅权限', scope: 'client',
      check: '请客户确认 VOS 录音开关与文件存放路径权限',
      fix: '客户处理：开启录音并提供调阅方式。我方不持有客户录音资产' },
    { q: '客户看不到我方要求的配置菜单',
      cause: 'VOS 版本差异，或当前账号无管理员权限', scope: 'client',
      check: '确认客户使用的 VOS 版本与账号权限级别',
      fix: '客户处理：需客户提供管理员权限，或由其系统管理员代为配置' },
    { q: '客户报启动异常 / Node conflict',
      cause: '实体 id 与客户其他表撞车（客户 VOS 全局命名空间）', scope: 'client',
      check: '请客户管理员在 VOS 侧核对相关记录 id 是否重复',
      fix: '客户处理：我方无法访问客户数据库，请客户管理员在 VOS 界面核对调整' }
  ];
  const SOP = [
    { n: 1, owner: 'ours', sys: 'dSIPRouter', act: '开户 subscriber', cmd: 'python3 /root/dsip_add_ufi.py <IMEI> <SIM>',
      ef: 'live', note: 'pw = md5(IMEI)[:16]，幂等可重跑', how: '我方自动执行，客户无需参与' },
    { n: 2, owner: 'ours', sys: 'dSIPRouter', act: '呼入被叫映射 dbaliases',
      cmd: "INSERT dbaliases ('<SIM>','106.75.29.22','<IMEI>','106.75.29.22')", ef: 'live',
      note: '与步骤 1 合并为一次调用', how: '我方自动执行' },
    { n: 3, owner: 'client', sys: 'VOS3000', act: '话机 1002 追加 DIDs',
      cmd: '客户 GUI：话机管理 → 1002 → DIDs 追加 <SIM>,<IMEI>（保留原有号码）', ef: 'client',
      note: '我方出指引单，客户手工操作', how: '客户在 VOS 管理界面完成' },
    { n: 4, owner: 'client', sys: 'VOS3000', act: 'dsip接入 外呼前缀（一次性）',
      cmd: '客户 GUI：网关 → dsip接入 → 网关前缀设为 1,0,400,800（勿逐号追加）', ef: 'client',
      note: '仅首次开通或改策略时配置一次；新增被叫/新增 UFI 均不必再改号段', how: '客户在 VOS 管理界面完成' },
    { n: 5, owner: 'ours', sys: 'dSIPRouter', act: '轮询池加成员',
      cmd: "通信管理模块：新增通信配置向导（写 dsip_ufi_pool）", ef: 'live',
      note: 'GUI 直接落库，sqlops 动态查表后加设备零重启', how: '本模块自动执行' },
    { n: 6, owner: 'ours', sys: 'dSIPRouter', act: '联调验收（双向通话）',
      cmd: 'kamcmd ul dump 确认注册 → 双方各拨一通确认', ef: 'live',
      note: '我方拨出 + 请客户侧确认振铃录音', how: '我方发起，客户配合确认' }
  ];
  const GUIDE_TPL = {
    vos_dids: {
      title: '话机 DIDs 追加',
      where: 'VOS3000 管理界面（8.136.109.38）→ 话机管理 → 话机 1002 → DIDs',
      steps: [
        '登录客户 VOS3000 管理界面',
        '进入「话机管理 / 分机管理」，定位话机编号 1002',
        '在 DIDs 字段末尾追加号码，用英文逗号分隔（不要覆盖原有值）',
        '保存后按客户运维规范重载话务配置'
      ],
      caution: '原有号码必须保留，否则现有呼入全部中断。',
      verify: '从外线拨打新号码，坐席 1002 应正常振铃并显示真实来显。'
    },
    vos_prefix: {
      title: '外呼前缀通配（生产一次性）',
      where: 'VOS3000 管理界面 → 网关管理 → 对接/落地网关 → dsip接入（ID 1001）',
      steps: [
        '打开「路由网关」里的 dsip接入（不是对接网关同名项；坐席外呼经此到 dSIPRouter / UFI）',
        '确认「网关组」已勾选/填写（如 luodi）。若网关组为空，点应用会 NPE 卡在「应用中」（错误 7008108）',
        '将「网关前缀」改为通配：0,1,400,800,9（或 1,0,400,800）',
        '含义：1=国内手机、0=区号座机、400/800=服务号、9=出局字冠；勿再填完整 11 位被叫',
        '保存并应用；若仍卡住，关闭客户端重开后重试。应用成功后 mbx 的 gatewayrouting.conf 中 Prefix 应同步为通配'
      ],
      caution: '逐号白名单只适合联调。改成前缀后任意被叫不必再改 VOS。路由网关「网关组」不能为空，否则应用必失败。',
      verify: '坐席 1002 拨未单独配置过的手机号，CDR 被叫经由=dsip接入，且无「无可用路由」。'
    }
  };
  /* Fallback only used before first /ufi/comm/topo succeeds */
  const SNAPSHOT_FALLBACK = {
    phone: { ext: '—', phone_id: null, dids: '', owner: 'client' },
    dsiprouter: {
      host: '—', cfg: '/etc/kamailio/kamailio.cfg', owner: 'ours',
      carrier: '—', auth: 'IP Auth', gwlist: '', address: ''
    },
    vos: {
      host: '—', gw_id: null, gw_name: 'dsip接入', gw_ip: '—', owner: 'client',
      gw_auth: 'IP 认证', routing_id: null,
      prefix: '0,1,400,800,9',
      prefix_recommended: '0,1,400,800,9',
      prefix_mode: 'prefix'
    },
    legacy: ''
  };

  function buildSnapshotFromTopo(topo) {
    const base = JSON.parse(JSON.stringify(SNAPSHOT_FALLBACK));
    if (!topo) return base;
    const ds = topo.dsip || {};
    const pv = topo.primary_vos || {};
    const carriers = topo.carriers || [];
    const authOk = carriers.filter(c => c.auth && c.auth.ok).length;
    base.dsiprouter = {
      host: ds.host || '—', cfg: ds.cfg || '/etc/kamailio/kamailio.cfg', owner: 'ours',
      domain: ds.domain || '', endpoint: ds.endpoint || ((ds.host || '—') + ':5060'),
      carrier: (pv.name || 'VOS') + ' #' + (pv.gwid || ''),
      auth: 'IP Auth',
      gwlist: carriers.map(c => '#' + c.gwid).join(',') || '',
      address: carriers.map(c => {
        const a = c.auth || {};
        return (c.ip || c.address || '') + (a.present ? (' port=' + a.port) : ' (未放行)');
      }).join('; '),
      auth_ok: authOk, auth_total: carriers.length
    };
    base.vos = {
      host: (pv.address || pv.ip || '—').split(':')[0],
      gw_id: pv.gwid, gw_name: pv.name || 'VOS', gw_ip: ds.host || '—', owner: 'client',
      gw_auth: (pv.auth && pv.auth.detail) || 'IP 认证',
      carriers: carriers,
      prefix: base.vos.prefix,
      prefix_recommended: '0,1,400,800,9',
      prefix_mode: 'prefix'
    };
    /* Aggregate SIM/IMEI triggers from pool DIDs + dbaliases for guidance templates */
    const triggers = [];
    (topo.pools || []).forEach(p => (p.dids || []).forEach(d => triggers.push(d)));
    base.phone = {
      ext: '—', phone_id: null, owner: 'client',
      dids: triggers.join(',') || ''
    };
    return base;
  }

  /* ================================================================ Store */
  const Store = {
    NODES, POOLS, STRATEGIES, FALLBACKS, PATCHES, EFFECT, OWNER,
    OUT_RULES, TROUBLE, SOP,
    get snapshot() { return Store._snapshotLive || SNAPSHOT_FALLBACK; },
    get guideTpl() { return GUIDE_TPL; },
    DID_ROUTES: [],
    routes: null,
    poolStrat: null,
    topo: null,
    _snapshotLive: null,
    carriers: [],
    DEVICE_LINKED: false,
    LOAD_ERROR: '',
    LAST_SYNC: null,

    ufis: [],
    calls: [],
    callPage: { total: 0, page: 1, pageSize: 25, pages: 1, calls: [] },
    pending: [],

    imeiIndex: new Map(),

    reindex() {
      Store.imeiIndex = new Map();
      Store.ufis.forEach(u => Store.imeiIndex.set(u.imei, u));
      return Store;
    },

    /* ---------- 拉取真实数据（设备台账 + 通信属性 + dbaliases + 通话） ---------- */
    async reload() {
      const payload = await apiGet('ufi/comm');
      const body = (payload && payload[0]) || { devices: [], dids: [] };
      const seen = new Set();
      const ufis = [];
      (body.devices || []).forEach((row, i) => {
        const imei = String(row.imei || '');
        if (!imei || seen.has(imei)) return;
        seen.add(imei);
        ufis.push(adapt(row, i, row.comm || {}));
      });
      Store.ufis = ufis;
      Store.carriers = body.carriers || [{ gwid: '100', name: 'VOS3000', address: '8.136.109.38' }];
      Store.DID_ROUTES = (body.dids || []).map(d => {
        const u = ufis.find(x => x.imei === d.imei);
        return {
          did: String(d.did || ''),
          kind: d.kind || (d.did === d.imei ? 'imei' : 'sim'),
          imei: String(d.imei || ''),
          target: d.target || '话机 1002',
          pool: u ? u.pool_id : '—'
        };
      });
      Store.reindex();
      Store.DEVICE_LINKED = ufis.length > 0;
      Store.LAST_SYNC = new Date();
      Store.LOAD_ERROR = '';
      try {
        const rec = await apiGet('ufi/records');
        const rows = (rec && rec[0] && rec[0].calls) || [];
        Store.calls = rows.map((r, i) => adaptCall(r, i, imei => Store.ufis.find(x => x.imei === imei))).slice(0, 120);
      } catch (e) {
        Store.calls = Store.calls || [];
      }
      /* Parallel: topo / pool strategy / route consistency — feed #topo & snapshot */
      await Promise.all([
        Store.loadTopo().catch(() => null),
        Store.loadPoolStrat().catch(() => null),
        Store.loadRoutes().catch(() => null)
      ]);
      return Store;
    },

    async loadTopo() {
      try {
        const d = await apiGet('ufi/comm/topo');
        Store.topo = (Array.isArray(d) && d[0]) || null;
        if (Store.topo) {
          Store._snapshotLive = buildSnapshotFromTopo(Store.topo);
          if (Store.topo.carriers && Store.topo.carriers.length) {
            Store.carriers = Store.topo.carriers;
          }
          /* Keep poolStrat.carriers in sync for pool DID editor */
          if (Store.poolStrat) Store.poolStrat.carriers = Store.topo.carriers;
        }
      } catch (e) {
        Store.topo = Store.topo || null;
      }
      return Store.topo;
    },

    /* ---------- 路由自动同步（pool ↔ dr_rules ↔ subscriber） ---------- */
    async loadRoutes() {
      try {
        const payload = await apiGet('ufi/comm/routes');
        Store.routes = (payload && payload[0]) || null;
      } catch (e) {
        Store.routes = Store.routes || null;
      }
      return Store.routes;
    },
    async syncRoutes() {
      const res = await apiSend('ufi/comm/sync-routes', 'POST', {});
      if (!res.ok) throw new Error((res.json && res.json.msg) || ('HTTP ' + res.status));
      const d = res.data || {};
      if (d.snapshot) Store.routes = d.snapshot;
      return d;
    },

    /* ---------- 通话记录（聚合 + 过滤 + 分页） ---------- */
    async loadCalls(q) {
      q = q || {};
      const params = [];
      if (q.imei) params.push('imei=' + encodeURIComponent(q.imei));
      if (q.carrier) params.push('carrier=' + encodeURIComponent(q.carrier));
      if (q.from) params.push('from=' + encodeURIComponent(q.from));
      if (q.to) params.push('to=' + encodeURIComponent(q.to));
      if (q.result) params.push('result=' + encodeURIComponent(q.result));
      if (q.dir) params.push('dir=' + encodeURIComponent(q.dir));
      params.push('page=' + encodeURIComponent(q.page || 1));
      params.push('page_size=' + encodeURIComponent(q.pageSize || 25));
      const payload = await apiGet('ufi/calls?' + params.join('&'));
      const body = (payload && payload[0]) || {};
      const rows = body.calls || [];
      const adapted = rows.map((r, i) => adaptCall(r, i, imei => Store.ufis.find(x => x.imei === imei)));
      Store.callPage = {
        total: Number(body.total || 0),
        page: Number(body.page || 1),
        pageSize: Number(body.pageSize || q.pageSize || 25),
        pages: Number(body.pages || 1),
        calls: adapted
      };
      return Store.callPage;
    },

    /* ---------- 通信属性写操作（真实落库 dsip_ufi_pool） ---------- */
    carrierLabel(gwid) {
      const c = (Store.carriers || []).find(x => x.gwid === String(gwid || '100'));
      return c ? c.name : String(gwid || '100');
    },
    carrierName(gwid) {
      const c = (Store.carriers || []).find(x => x.gwid === String(gwid || '100'));
      return c ? (c.name + ' · ' + c.gwid + ' · ' + c.address) : '';
    },
    async saveDeviceSim(imei, sim) {
    const r = await apiSend('/api/v1/ufi/devices/' + imei + '/sim-number', 'PUT', { sim_number: sim });
    if (r && r.ok) {
      const u = (Store.ufis || []).find(x => x.imei === imei);
      if (u) { u.sim = sim.replace(/^\+86/, ''); u.simRaw = sim; }
    }
    return r;
  },
  async loadPoolStrat() {
      /* apiGet 返回的已是 json.data（数组），本身没有 .ok 字段，不能按 apiSend 的形状判断 */
      try {
        const d = await apiGet('ufi/comm/pool-strategy');
        Store.poolStrat = (Array.isArray(d) && d[0]) || null;
      } catch (e) {
        Store.poolStrat = null;
      }
      return Store.poolStrat;
    },
    async savePoolStrat(poolId, strategy) {
      const r = await apiSend('ufi/comm/pool-strategy', 'PUT', { pool_id: poolId, strategy });
      if (r && r.ok && Store.poolStrat) {
        const p = (Store.poolStrat.pools || []).find(x => x.pool_id === poolId);
        if (p) { p.strategy = strategy; p.strategy_label = (Store.poolStrat.labels || {})[strategy] || strategy; }
      }
      return r;
    },
    async createPool(poolId, strategy, dids) {
      const r = await apiSend('ufi/comm/pools', 'POST', { pool_id: poolId, strategy, dids: dids || [] });
      if (r && r.ok) await DB.loadPoolStrat();
      return r;
    },
    async deletePool(poolId) {
      const r = await apiSend('ufi/comm/pools/' + encodeURIComponent(poolId), 'DELETE');
      if (r && r.ok) await DB.loadPoolStrat();
      return r;
    },
    async poolMembers(poolId, imeis, action) {
      const r = await apiSend('ufi/comm/pools/' + encodeURIComponent(poolId) + '/members', 'POST', { imeis, action });
      if (r && r.ok) await DB.loadPoolStrat();
      return r;
    },
    async savePoolDids(poolId, dids, opts) {
      const body = { dids: dids || [] };
      if (opts && typeof opts === 'object') {
        if (typeof opts.isDefault === 'boolean') body.is_default = opts.isDefault;
        if (Array.isArray(opts.defaultVos)) body.default_vos = opts.defaultVos;
      } else if (typeof opts === 'boolean') {
        body.is_default = opts; /* legacy */
      }
      const r = await apiSend('ufi/comm/pools/' + encodeURIComponent(poolId) + '/dids', 'PUT', body);
      if (r && r.ok) await DB.loadPoolStrat();
      return r;
    },
    async saveComm(imei, patch) {
      const res = await apiSend('ufi/comm/' + encodeURIComponent(imei), 'PUT', patch || {});
      if (!res.ok) throw new Error((res.json && res.json.msg) || ('HTTP ' + res.status));
      /* 本地同步（避免整表重拉闪烁） */
      const u = Store.ufiByImei(imei);
      if (u && res.data) {
        const d = res.data;
        if (d.pool_id !== undefined) u.pool_id = d.pool_id;
        if (d.carrier !== undefined) u.carrier = d.carrier;
        if (d.enabled !== undefined) u.enabled = !!d.enabled;
        if (d.in_pool !== undefined) u.in_pool = !!d.in_pool;
        if (d.weight !== undefined) u.weight = d.weight;
        if (d.max_concurrent !== undefined) u.max_concurrent = d.max_concurrent;
        if (d.note !== undefined) u.note = d.note;
        if (d.sim) u.sim = d.sim;
        Store.reindex();
      }
      Store.loadRoutes();
      return res.data;
    },
    async bulkComm(action, imeis) {
      const res = await apiSend('ufi/comm/bulk', 'POST', { action: action, imeis: imeis });
      if (!res.ok) throw new Error((res.json && res.json.msg) || ('HTTP ' + res.status));
      const map = { enable: [1, 1], disable: [0, 0], maintain: [null, 0] };
      if (action === 'reset-conc') {
        imeis.forEach(i => { const u = Store.ufiByImei(i); if (u) u.active_calls = 0; });
      } else {
        imeis.forEach(i => {
          const u = Store.ufiByImei(i);
          if (!u) return;
          if (action === 'enable') {
            if (u.pool_id === '—') u.pool_id = 'P1';   /* 与后端 bulk enable 兜底一致 */
          } else if (map[action][0] !== null) {
            u.enabled = !!map[action][0];
          }
          u.in_pool = !!map[action][1];
        });
        Store.reindex();
      }
      Store.loadRoutes();
      return res.data;
    },

    /* ---------- 呼入映射写操作（真实落库 kamailio.dbaliases） ---------- */
    async delDid(did) {
      const res = await apiSend('ufi/comm/dids/' + encodeURIComponent(did), 'DELETE');
      if (!res.ok) throw new Error((res.json && res.json.msg) || ('HTTP ' + res.status));
      /* 本地同步：从映射列表移除（可能与预览状态重复，幂等） */
      const i = Store.DID_ROUTES.findIndex(d => d.did === did);
      if (i >= 0) Store.DID_ROUTES.splice(i, 1);
      return res.data;
    },
    async addDid(did, imei) {
      const res = await apiSend('ufi/comm/dids', 'POST', { did: did, imei: imei });
      if (!res.ok) throw new Error((res.json && res.json.msg) || ('HTTP ' + res.status));
      /* 本地同步：避免整表重拉闪烁 */
      if (!Store.DID_ROUTES.some(d => d.did === did)) {
        Store.DID_ROUTES.push({ did: did, kind: did === imei ? 'imei' : 'sim', imei: imei, target: '话机 1002', pool: (Store.ufiByImei(imei) || {}).pool_id || '—' });
      }
      return res.data;
    },

    /* ---------- 变更任务真实执行（带 act 的任务落库，其余仅留痕） ---------- */
    async execPending(act) {
      if (!act || !act.type) throw new Error('task has no executable action');
      if (act.type === 'did_del') return Store.delDid(act.did);
      if (act.type === 'did_add') return Store.addDid(act.did, act.imei);
      throw new Error('unknown action: ' + act.type);
    },

    /* ---------- 检索 ---------- */
    poolById: id => Store.POOLS.find(p => p.id === id),
    ufiByImei: imei => Store.ufis.find(u => u.imei === imei),
    exists(imei) { return Store.imeiIndex.has(String(imei || '').trim()); },
    search(kw, limit) {
      const q = String(kw || '').trim().toLowerCase();
      limit = limit || 20;
      if (!q) return Store.ufis.slice(0, limit);
      const out = [];
      const isNum = /^\d{4,}$/.test(q);
      for (const u of Store.ufis) {
        let hit = 0;
        if (isNum) {
          const p = u.imei.indexOf(q);
          hit = p === 0 ? 4 : (p > 0 || (u.sim && u.sim.indexOf(q) >= 0)) ? 2 : 0;
        } else {
          hit = (u.imei.toLowerCase().indexOf(q) >= 0) ? 4
              : (u.sim && u.sim.indexOf(q) >= 0) ? 4
              : (u.model && u.model.toLowerCase().indexOf(q) >= 0) ? 3
              : (u.sn && u.sn.toLowerCase().indexOf(q) >= 0) ? 3
              : (u.band && u.band.toLowerCase().indexOf(q) >= 0) ? 1
              : 0;
        }
        if (hit) out.push({ u: u, hit: hit });
        if (out.length >= 600) break;
      }
      out.sort((a, b) => (b.hit - a.hit) || (a.u.imei < b.u.imei ? -1 : 1));
      return out.slice(0, limit).map(x => x.u);
    },

    /* ---------- 池工具 ---------- */
    ufisOfPool(pid) { return Store.ufis.filter(u => u.pool_id === pid); },
    usableOfPool(pid) { return Store.ufisOfPool(pid).filter(u => u.in_pool && u.enabled && u.registered); },

    health() {
      const ufis = Store.ufis, calls = Store.calls;
      const topoC = (Store.topo && Store.topo.counts) || {};
      const on = ufis.filter(u => u.online).length;
      const reg = ufis.filter(u => u.registered).length;
      const inPool = ufis.filter(u => u.in_pool && u.enabled).length;
      const usable = ufis.filter(u => u.in_pool && u.enabled && u.registered && u.online).length;
      const busy = ufis.reduce((s, u) => s + (u.active_calls || 0), 0);
      const talking = (calls || []).filter(c => c.state === 'talk').length;
      const ringing = (calls || []).filter(c => c.state === 'ring').length;
      const failed = (calls || []).filter(c => c.state === 'fail').length;
      const volte = ufis.filter(u => u.volte).length;
      return {
        online: on || topoC.ws_online || 0,
        registered: reg || topoC.location_regs || 0,
        inPool: inPool || topoC.in_pool || 0,
        usable, busy: busy || topoC.active_calls || 0,
        talking, ringing, failed, volte,
        offline: Math.max(0, ufis.length - on),
        totalUfi: ufis.length || topoC.devices || 0,
        capacity: topoC.capacity || ufis.reduce((s, u) => s + (u.max_concurrent || 0), 0),
        didAliases: topoC.did_aliases != null ? topoC.did_aliases : (Store.DID_ROUTES || []).length,
        locRegs: topoC.location_regs != null ? topoC.location_regs : reg,
        routesOk: !!(Store.topo && Store.topo.routes && Store.topo.routes.consistent)
      };
    },

    referrers(imei) {
      const out = [];
      const u = Store.ufiByImei(imei);
      if (!u) return out;
      if (u.pool_id && u.pool_id !== '—') {
        const pl = Store.POOLS.find(p => p.id === u.pool_id);
        if (pl) out.push({ kind: 'pool', id: pl.id, name: pl.name, group: '线路池' });
      }
      Store.DID_ROUTES.forEach(d => {
        if (d.imei === imei) out.push({ kind: 'did', id: d.did, name: d.did, group: '呼入映射' });
      });
      Store.OUT_RULES.forEach(r => {
        if (r.pool === u.pool_id) out.push({ kind: 'rule', id: r.id, name: r.name, group: '呼出规则' });
      });
      return out;
    },

    /* ---------- 变更队列（开户/补丁等人工执行项 + 客户指引单） ----------
       pending 持久化到 localStorage：页面刷新后任务仍在，可继续执行 */
    PEND_KEY: 'uficc.pending.v1',
    loadPending() {
      try {
        const raw = localStorage.getItem(Store.PEND_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr)) Store.pending = arr.map(p => Object.assign(p, { at: new Date(p.at || Date.now()) }));
      } catch (e) { /* 坏数据忽略 */ }
    },
    savePending() {
      try { localStorage.setItem(Store.PEND_KEY, JSON.stringify(Store.pending)); } catch (e) { /* 隐私模式等 */ }
    },
    addPending(p) {
      const owner = p.owner || (p.sys === 'dSIPRouter' ? 'ours' : 'client');
      const item = Object.assign({
        id: (owner === 'ours' ? 'P' : 'C') + Date.now().toString(36) + Math.floor(Math.random() * 99),
        at: new Date(), state: owner === 'ours' ? 'pending' : 'waiting', by: owner === 'ours' ? '我方' : '待客户执行'
      }, p, { owner: owner });
      Store.pending.unshift(item);
      Store.savePending();
      return item;
    },
    dropPending(id) { const i = Store.pending.findIndex(p => p.id === id); if (i >= 0) Store.pending.splice(i, 1); Store.savePending(); },
    pendOf(owner, state) {
      return Store.pending.filter(p => (owner ? p.owner === owner : true) && (state ? p.state === state : true));
    },

    get sop() { return SOP; }
  };

  global.DB = Store;
})(window);
