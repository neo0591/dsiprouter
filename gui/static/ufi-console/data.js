/* Live adapter: field names 1:1 with UFI API v2.9. Replaces mock Store.init(). */
(function (global) {
  'use strict';

  const OPERATORS = [
    { code: '46000', name: '中国移动', short: 'CMCC' },
    { code: '46002', name: '中国移动', short: 'CMCC' },
    { code: '46004', name: '中国移动', short: 'CMCC' },
    { code: '46007', name: '中国移动', short: 'CMCC' },
    { code: '46008', name: '中国移动', short: 'CMCC' },
    { code: '46020', name: '中国移动', short: 'CMCC' },
    { code: '46001', name: '中国联通', short: 'CUCC' },
    { code: '46006', name: '中国联通', short: 'CUCC' },
    { code: '46009', name: '中国联通', short: 'CUCC' },
    { code: '46003', name: '中国电信', short: 'CTCC' },
    { code: '46005', name: '中国电信', short: 'CTCC' },
    { code: '46011', name: '中国电信', short: 'CTCC' },
    { code: '46015', name: '中国广电', short: 'CBN' },
    { code: '45412', name: 'CMLink', short: 'CML' },
    { code: '310260', name: 'T-Mobile US', short: 'TMO' },
    { code: '310240', name: 'T-Mobile US', short: 'TMO' },
    { code: '310410', name: 'AT&T', short: 'ATT' },
    { code: '310150', name: 'AT&T', short: 'ATT' },
    { code: '311480', name: 'Verizon', short: 'VZW' },
    { code: '302720', name: 'Rogers', short: 'Rogers' },
    { code: '302610', name: 'Bell', short: 'Bell' },
    { code: '302220', name: 'TELUS', short: 'TELUS' },
    { code: '52501', name: 'Singtel', short: 'Singtel' },
    { code: '52503', name: 'M1', short: 'M1' },
    { code: '52505', name: 'StarHub', short: 'StarHub' },
    { code: '52510', name: 'SIMBA Telecom', short: 'SIMBA' },
    { code: '23430', name: 'EE', short: 'EE' },
    { code: '23410', name: 'O2', short: 'O2' },
    { code: '23415', name: 'Vodafone', short: 'VF' },
    { code: '23420', name: 'Three', short: 'Three' },
    { code: '20801', name: 'Orange', short: 'Orange' },
    { code: '20810', name: 'SFR', short: 'SFR' },
    { code: '20820', name: 'Bouygues Telecom', short: 'Bouygues' },
    { code: '20815', name: 'Free Mobile', short: 'Free' },
    { code: '26201', name: 'Telekom Deutschland', short: 'TD' },
    { code: '26202', name: 'Vodafone Germany', short: 'VF' },
    { code: '26207', name: 'O2 Germany', short: 'O2' },
    { code: '22201', name: 'TIM', short: 'TIM' },
    { code: '22210', name: 'Vodafone Italy', short: 'VF' },
    { code: '21401', name: 'Vodafone Spain', short: 'VF' },
    { code: '21403', name: 'Orange Spain', short: 'Orange' },
    { code: '20404', name: 'Vodafone Netherlands', short: 'VF' },
    { code: '20408', name: 'KPN', short: 'KPN' },
    { code: '44010', name: 'NTT DOCOMO', short: 'DOCOMO' },
    { code: '44050', name: 'KDDI', short: 'KDDI' },
    { code: '44020', name: 'SoftBank', short: 'SoftBank' },
    { code: '44011', name: 'Rakuten Mobile', short: 'Rakuten' },
    { code: '45005', name: 'SK Telecom', short: 'SKT' },
    { code: '45008', name: 'KT', short: 'KT' },
    { code: '45006', name: 'LG U+', short: 'LGU' },
    { code: '40445', name: 'Airtel', short: 'Airtel' },
    { code: '40410', name: 'Airtel', short: 'Airtel' },
    { code: '405840', name: 'Jio', short: 'Jio' },
    { code: '51010', name: 'Telkomsel', short: 'Telkomsel' },
    { code: '51001', name: 'Indosat', short: 'Indosat' },
    { code: '51011', name: 'XL Axiata', short: 'XL' },
    { code: '50212', name: 'Maxis', short: 'Maxis' },
    { code: '50213', name: 'CelcomDigi', short: 'CelcomDigi' },
    { code: '52001', name: 'AIS', short: 'AIS' },
    { code: '52005', name: 'dtac', short: 'dtac' },
    { code: '52099', name: 'TrueMove H', short: 'True' },
    { code: '50501', name: 'Telstra', short: 'Telstra' },
    { code: '50502', name: 'Optus', short: 'Optus' },
    { code: '50503', name: 'Vodafone Australia', short: 'VF' },
    { code: '53001', name: 'Spark New Zealand', short: 'Spark' },
    { code: '53005', name: 'One NZ', short: 'OneNZ' }
  ];
  const BANDS = {
    '4G': ['B1', 'B3', 'B5', 'B8', 'B34', 'B38', 'B39', 'B40', 'B41'],
    '5G': ['n1', 'n28', 'n41', 'n77', 'n78', 'n79'],
    '3G': ['U900', 'U2100']
  };
  const SMS_CODES = {
    1000: { name: 'SUCCESS', cn: '转发成功', kind: 'ok' },
    1001: { name: 'FAILED_UNKNOWN', cn: '未细分失败', kind: 'err' },
    1102: { name: 'MODEM_RADIO_OFF', cn: '射频关闭', kind: 'err' },
    1104: { name: 'MODEM_NO_SERVICE', cn: '无服务', kind: 'err' },
    1108: { name: 'MODEM_SEND_EXCEPTION', cn: 'Modem 发送调用异常', kind: 'err' },
    1201: { name: 'BRIDGE_SIP_USER_EMPTY', cn: 'SIP 用户名为空，无法建会话', kind: 'warn' },
    1202: { name: 'BRIDGE_SIP_PROXY_EMPTY', cn: 'SIP Proxy 地址为空', kind: 'warn' },
    1203: { name: 'BRIDGE_CORE_UNAVAILABLE', cn: 'Linphone Core 不可用', kind: 'err' },
    1205: { name: 'BRIDGE_SIP_SEND_EXCEPTION', cn: 'SIP 消息发送异常', kind: 'err' },
    1306: { name: 'E2E_ENCRYPT_FAILED', cn: '端到端加密失败', kind: 'err' },
    1401: { name: 'SIP_NOT_DELIVERED', cn: 'SIP 消息未投递到 FS', kind: 'err' },
    1501: { name: 'MMS_DOWNLOAD_FAIL', cn: '彩信分片下载失败', kind: 'err' }
  };
  const REJECT_CODES = {
    1: '用户忙', 2: '无人接听', 3: '拒接', 4: '空号', 5: '关机', 6: '停机'
  };
  const ENCRYPTION_TYPES = ['dtls', 'sdes', 'none'];

  function apiBase() {
    return (typeof API_BASE_URL === 'string' ? API_BASE_URL : '/api/v1/').replace(/\/?$/, '/');
  }

  /* Resolve MCC+MNC carrier codes (e.g. "46001") to operator display names */
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
    }
    return s;
  }

  async function apiGet(path) {
    /* cache:'no-store' + cache-buster：杜绝浏览器/代理对 GET 列表请求的任何缓存 */
    const url = apiBase() + path.replace(/^\//, '') + (path.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      /* 会话失效（如 GUI 重启后）：跳登录页，避免页面静默退化为空列表 */
      location.href = '/';
      throw new Error('登录已过期，正在跳转登录页…');
    }
    if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
    return json.data || [];
  }

  async function apiPost(path, body) {
    const res = await fetch(apiBase() + path.replace(/^\//, ''), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json: json, data: (json.data && json.data[0]) || json.data || json };
  }

  async function apiPut(path, body) {
    const res = await fetch(apiBase() + path.replace(/^\//, ''), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json: json, data: (json.data && json.data[0]) || json.data || json };
  }

  async function apiDel(path) {
    const res = await fetch(apiBase() + path.replace(/^\//, ''), {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.msg || ('HTTP ' + res.status));
    return { ok: res.ok, json: json, data: (json.data && json.data[0]) || json.data || json };
  }

  function scoreDevice(d) {
    const issues = [];
    let score = 100;
    const isOffline = d.lteStatus === 'LTE-Disconnect' || (!d.wsOnline && !d.online);
    const isFlight = d.airplaneMode === '1';
    if (isOffline) { score -= 55; issues.push('设备离线'); }
    if (isFlight) { score -= 30; issues.push('飞行模式'); }
    if (d.volteRegisterStatus === '0' && !isOffline && !isFlight) { score -= 22; issues.push('VoLTE 未注册'); }
    if (d.voipRegisterStatus === '0' && !isOffline && !isFlight) { score -= 20; issues.push('SIP 未注册'); }
    if (Number(d.cellularSignalLevel) <= 1 && !isOffline && !isFlight) { score -= 14; issues.push('信号弱'); }
    if (Number(d.cpuUseRate) >= 85) { score -= 8; issues.push('CPU 高负载'); }
    if (Number(d.storageUseRate) >= 88) { score -= 6; issues.push('存储紧张'); }
    if (d.simState === 'PIN_REQUIRED') { score -= 18; issues.push('SIM 待解锁'); }
    if (d.linphoneProcessStatus && d.linphoneProcessStatus !== 'running' && !isOffline) {
      score -= 12; issues.push('Linphone 异常');
    }
    d.issues = issues;
    d.health = Math.max(2, score);
    d.severity = d.health >= 85 ? 'ok' : d.health >= 60 ? 'warn' : 'err';
    if (isOffline || (d.volteRegisterStatus === '0' && d.voipRegisterStatus === '0' && !isFlight)) d.severity = 'err';
    if (d.severity === 'ok' && issues.length) d.severity = 'warn';
    return d;
  }

  function pick(obj, ...keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return '';
  }

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

  function normalizeDevice(row, idx) {
    const d = {
      idx: idx,
      imei: String(pick(row, 'imei')),
      sn: String(pick(row, 'sn') || ''),
      agentType: String(pick(row, 'agentType', 'agent_type') || 'Linkcircle-UFI-C'),
      lteStatus: String(pick(row, 'lteStatus', 'lte_status') || (row.ws_online || row.online ? 'LTE-Connect' : 'LTE-Disconnect')),
      simNumber: String(pick(row, 'simNumber', 'sim_number') || ''),
      imsi: String(pick(row, 'imsi') || ''),
      simType: String(pick(row, 'simType', 'sim_type') || 'SIM'),
      simState: String(pick(row, 'simState', 'sim_state') || 'READY'),
      areaNumber: String(pick(row, 'areaNumber') || ''),
      cellularStatus: String(pick(row, 'cellularStatus', 'cellular_status') || 'NONE'),
      cellularNetwork: String(pick(row, 'cellularNetwork', 'cellular_network') || ''),
      operatorCode: String(pick(row, 'operatorCode') || ''),
      operatorShort: String(pick(row, 'operatorShort') || ''),
      networkType: String(pick(row, 'networkType', 'network_type') || 'none'),
      wlanName: String(pick(row, 'wlanName') || ''),
      wlanPassword: String(pick(row, 'wlanPassword') || ''),
      volteRegisterStatus: String(pick(row, 'volteRegisterStatus', 'volte_status') || '0'),
      voipRegisterStatus: String(pick(row, 'voipRegisterStatus', 'voip_status') || (row.online ? '1' : '0')),
      websocketStatus: String(pick(row, 'websocketStatus', 'ws_status') || (row.ws_online ? '1' : '0')),
      wfcStatus: String(pick(row, 'wfcStatus', 'wfc_status') || '0'),
      airplaneMode: String(pick(row, 'airplaneMode', 'airplane_mode') || '0'),
      cellularSignalLevel: String(pick(row, 'cellularSignalLevel', 'signal_level') || '0'),
      signalRaw: Number(pick(row, 'cellularSignalLevel', 'signal_level') || 0),
      rsrp: row.rsrp == null ? null : Number(row.rsrp),
      rsrq: row.rsrq == null ? null : Number(row.rsrq),
      band: String(pick(row, 'band') || '—'),
      serviceCellEARFCN: String(pick(row, 'serviceCellEARFCN', 'earfcn') || '0'),
      cpuUseRate: String(pick(row, 'cpuUseRate', 'cpu_use') || '0').replace('%', ''),
      memoryUseRate: String(pick(row, 'memoryUseRate', 'mem_use') || '0').replace('%', ''),
      storageUseRate: String(pick(row, 'storageUseRate', 'storage_use') || '0').replace('%', ''),
      linphoneProcessStatus: String(pick(row, 'linphoneProcessStatus', 'linphone_status') || ''),
      buildNumber: String(pick(row, 'buildNumber', 'build_number') || ''),
      apkVersion: String(pick(row, 'apkVersion') || ''),
      sipServerAddress: String(pick(row, 'sipServerAddress', 'sip_domain') || ''),
      sipServerPort: Number(pick(row, 'sipServerPort') || 5060),
      sippassWord: String(pick(row, 'sippassWord') || ''),
      transportProtocol: String(pick(row, 'transportProtocol') || 'UDP'),
      encryptionType: String(pick(row, 'encryptionType') || 'dtls'),
      sipregeststatus: String(pick(row, 'sipregeststatus', 'sip_reg_status') || ''),
      smsCryptionStatus: String(pick(row, 'smsCryptionStatus') || 'ON'),
      ufiHotpotstaus: String(pick(row, 'ufiHotpotstaus') || 'OFF'),
      hotspotName: String(pick(row, 'hotspotName') || ''),
      logStatus: String(pick(row, 'logStatus') || 'OFF'),
      logCmdState: 'idle',
      lastSeen: parseTs(pick(row, 'lastSeen', 'last_seen')),
      onlineSince: parseTs(pick(row, 'last_seen')),
      online: !!row.online,
      wsOnline: !!(row.wsOnline || row.ws_online),
      lastIp: String(pick(row, 'last_ip') || ''),
      tunnelReady: !!(row.tunnelReady || row.tunnel_ready),
      adminProxyUrl: String(pick(row, 'adminProxyUrl', 'admin_proxy_url') || ''),
      adminProxyPath: String(pick(row, 'adminProxyPath', 'admin_proxy_path') || ''),
      softApUrl: String(pick(row, 'softApUrl', 'soft_ap_url') || 'http://192.168.43.1:8080'),
      softApHint: String(pick(row, 'softApHint') || ''),
      tunnelAdminPort: Number(pick(row, 'tunnelAdminPort', 'tunnel_admin_port') || 8080),
      callsTotal: Number(row.callsTotal || 0),
      callsToday: Number(row.callsToday || 0),
      smsTotal: Number(row.smsTotal || 0),
      smsToday: Number(row.smsToday || 0),
      smsFailToday: Number(row.smsFailToday || 0),
      trafficTxMB: Number(row.trafficTxMB || 0),
      trafficRxMB: Number(row.trafficRxMB || 0)
    };
    if (!d.lteStatus) d.lteStatus = d.wsOnline || d.online ? 'LTE-Connect' : 'LTE-Disconnect';
    /* 运营商名称：本地 MCC/MNC 中文映射优先；无映射时用设备自报名称（非数字）；最后回退网络码 */
    const opName = resolveOperator(d.operatorCode || d.cellularNetwork);
    const devName = d.operatorShort && !/^\d/.test(d.operatorShort) ? d.operatorShort : '';
    d.operatorName = opName || devName || d.cellularNetwork;
    return scoreDevice(d);
  }

  function decorateSms(row) {
    const code = Number(row.resultCode || row.result_code || 1000);
    const meta = SMS_CODES[code] || SMS_CODES[1001];
    return {
      smsId: String(pick(row, 'smsId', 'sms_id', 'id')),
      imei: String(pick(row, 'imei')),
      smsType: String(pick(row, 'smsType', 'sms_type') || 'inbox'),
      smsBody: String(pick(row, 'smsBody', 'sms_body') || ''),
      smsmTel: String(pick(row, 'smsmTel', 'smsm_tel') || ''),
      smsTimestamp: parseTs(pick(row, 'smsTimestamp', 'sms_timestamp', 'created_at')),
      resultCode: String(code),
      resultName: meta.name,
      resultCn: meta.cn,
      kind: meta.kind,
      failResult: String(pick(row, 'failResult', 'fail_result') || ''),
      mms: !!row.mms,
      encrypted: row.encrypted !== false
    };
  }

  function decorateCall(row) {
    return {
      traceId: String(pick(row, 'traceId', 'trace_id', 'id')),
      imei: String(pick(row, 'imei')),
      dir: String(pick(row, 'dir') || 'incoming'),
      peer: String(pick(row, 'peer') || ''),
      peerLocal: String(pick(row, 'peerLocal', 'peer_local') || ''),
      answered: !!row.answered,
      rejected: !!row.rejected,
      rejectCode: Number(row.rejectCode || row.reject_code || 0),
      durationSec: Number(row.durationSec || row.duration_sec || 0),
      startTs: parseTs(pick(row, 'startTs', 'start_ts', 'created_at')),
      endTs: parseTs(pick(row, 'endTs', 'end_ts', 'created_at')),
      result: String(pick(row, 'result') || 'END'),
      failReason: String(pick(row, 'failReason', 'fail_reason') || ''),
      codec: String(pick(row, 'codec') || ''),
      volteLog: String(pick(row, 'volteLog', 'volte_log') || ''),
      sipLog: String(pick(row, 'sipLog', 'sip_log') || ''),
      routeLog: String(pick(row, 'routeLog', 'route_log') || '')
    };
  }

  function decorateEvent(row) {
    const kind = String(pick(row, 'kind') || (String(row.msg_type || '').indexOf('FAIL') >= 0 ? 'err' : 'ok'));
    const tag = String(pick(row, 'tag', 'sn') || '');
    let title = String(pick(row, 'title') || '');
    let desc = String(pick(row, 'desc') || '');
    /* 兼容旧接口：若仍是裸 msgType，前端再兜底翻译一次 */
    const rawType = String(pick(row, 'msg_type', 'msgType') || '');
    if (!title || title === rawType || /^Ufi-|^Ai-/.test(title)) {
      if (/Reject/i.test(title || rawType)) title = '通话未接通';
      else if (/Sms|sms/i.test(title || rawType)) title = '短信事件';
      else if (/Status-Log/i.test(title || rawType)) title = '通话/短信过程';
      else if (!title) title = '设备事件';
    }
    if (!desc || desc === title || desc === rawType) {
      desc = desc && desc !== rawType ? desc : '点击设备监控查看更多状态';
    }
    return {
      kind: kind === 'err' || kind === 'warn' || kind === 'ok' ? kind : 'ok',
      title: title,
      desc: desc,
      imei: String(pick(row, 'imei')),
      sn: tag || String(pick(row, 'sn') || ''),
      tag: tag || String(pick(row, 'sn') || ''),
      source: String(pick(row, 'source') || ''),
      ts: parseTs(pick(row, 'ts', 'created_at'))
    };
  }

  function decorateFile(row) {
    return {
      id: String(pick(row, 'id') || ''),
      imei: String(pick(row, 'imei') || ''),
      fileName: String(pick(row, 'file_name', 'fileName') || ''),
      fileSize: Number(row.file_size != null ? row.file_size : (row.fileSize || 0)),
      uploadTs: parseTs(pick(row, 'created_at', 'createdAt', 'upload_time'))
    };
  }

  const Store = {
    devices: [],
    calls: [],
    sms: [],
    keyLogs: [],
    events: [],
    files: [],
    filesError: null,
    alerts: [],

    async init() {
      await this.reload();
      return this;
    },

    async reload() {
      const [devices, records, files, alerts] = await Promise.all([
        apiGet('ufi/devices'),
        apiGet('ufi/records').catch(() => []),
        apiGet('ufi/files').catch(() => null), /* null = fetch failed, keep previous snapshot */
        apiGet('ufi/alerts').catch(() => [])
      ]);
      const bundle = Array.isArray(records) ? (records[0] || {}) : (records || {});
      this.devices = (devices || []).map((row, i) => normalizeDevice(row, i));
      this.calls = (bundle.calls || []).map(decorateCall);
      this.sms = (bundle.sms || []).map(decorateSms);
      this.keyLogs = (bundle.keyLogs || bundle.logs || []).map(function (row) {
        if (row.smsBody || row.smsmTel || row.sms_body) {
          const s = decorateSms(row);
          s.category = 'sms';
          s.side = s.smsType || '';
          s.result = s.kind === 'err' ? 'FAIL' : 'OK';
          s.startTs = s.smsTimestamp;
          s.endTs = s.smsTimestamp;
          s.traceId = s.smsId;
          s.volteLog = s.smsBody;
          s.sipLog = '';
          return s;
        }
        const c = decorateCall(row);
        c.category = 'call';
        c.side = c.dir || '';
        return c;
      });
      this.events = (bundle.events || []).map(decorateEvent);
      this.alerts = (alerts || []).map(a => ({
        imei: String(a.imei || ''),
        kind: String(a.kind || ''),
        level: String(a.level || 'warn'),
        detail: String(a.detail || ''),
        offlineFrom: String(a.offlineFrom || ''),
        offlineTo: String(a.offlineTo || ''),
        createdAt: String(a.createdAt || '')
      }));
      if (files) {
        this.files = files.map(decorateFile);
        this.files.sort((a, b) => b.uploadTs - a.uploadTs);
      }
      this.calls.sort((a, b) => b.startTs - a.startTs);
      this.sms.sort((a, b) => b.smsTimestamp - a.smsTimestamp);
      this.events.sort((a, b) => b.ts - a.ts);
    },

    async reloadFiles() {
      /* 失败时上抛：调用方负责把错误显示出来，不再静默保留旧快照导致"刷新无效"假象 */
      const files = await apiGet('ufi/files');
      this.files = (files || []).map(decorateFile);
      this.files.sort((a, b) => b.uploadTs - a.uploadTs);
      this.filesError = null;
      this.lastFilesSync = Date.now();
    },

    async tick() {
      try { await this.reload(); } catch (e) { /* keep last snapshot */ }
    },

    stats() {
      const n = this.devices.length;
      let online = 0, offline = 0, volte = 0, sip = 0, wifiNet = 0, mobile = 0,
        strong = 0, weak = 0, none = 0, flight = 0, crit = 0, warn = 0, ok = 0,
        sipDown = 0, volteDown = 0, simLocked = 0, cpuHigh = 0, storageHigh = 0;
      for (const d of this.devices) {
        const isOff = d.lteStatus === 'LTE-Disconnect';
        isOff ? offline++ : online++;
        if (d.volteRegisterStatus === '1') volte++;
        if (d.voipRegisterStatus === '1') sip++;
        if (d.networkType === 'wifi') wifiNet++;
        if (d.networkType === 'mobile') mobile++;
        if (d.airplaneMode === '1') flight++;
        const s = Number(d.cellularSignalLevel);
        if (isOff || d.airplaneMode === '1') none++;
        else if (s >= 3) strong++;
        else if (s >= 1) weak++;
        else none++;
        if (d.severity === 'err') crit++; else if (d.severity === 'warn') warn++; else ok++;
        if (!isOff && d.voipRegisterStatus === '0') sipDown++;
        if (!isOff && d.volteRegisterStatus === '0') volteDown++;
        if (d.simState === 'PIN_REQUIRED') simLocked++;
        if (Number(d.cpuUseRate) >= 85) cpuHigh++;
        if (Number(d.storageUseRate) >= 88) storageHigh++;
      }
      return {
        total: n, online, offline, volte, sip, wifiNet, mobile, strong, weak, none,
        flight, crit, warn, ok, sipDown, volteDown, simLocked, cpuHigh, storageHigh,
        volteRate: (volte / Math.max(n, 1) * 100),
        sipRate: (sip / Math.max(n, 1) * 100),
        onlineRate: (online / Math.max(n, 1) * 100)
      };
    },

    byOperator() {
      const m = new Map();
      for (const d of this.devices) {
        const k = d.operatorName || d.cellularNetwork || '未知';
        const entry = m.get(k) || { name: k, code: d.cellularNetwork || '', n: 0 };
        entry.n++;
        if (!entry.code && d.cellularNetwork) entry.code = d.cellularNetwork;
        m.set(k, entry);
      }
      return [...m.values()].sort((a, b) => b.n - a.n);
    },

    byBand() {
      const m = new Map();
      for (const d of this.devices) {
        if (!d.band || d.band === '—') continue;
        m.set(d.band, (m.get(d.band) || 0) + 1);
      }
      return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 7);
    },

    bySignal() {
      const buckets = [0, 0, 0, 0, 0];
      for (const d of this.devices) {
        if (d.lteStatus === 'LTE-Disconnect' || d.airplaneMode === '1') { buckets[0]++; continue; }
        const s = Number(d.cellularSignalLevel);
        buckets[Math.min(s, 4)]++;
      }
      return buckets;
    },

    byNetType() {
      const m = { '5G': 0, '4G': 0, '3G': 0, 'WLAN': 0, 'NONE': 0, 'Flight mode': 0 };
      for (const d of this.devices) m[d.cellularStatus] = (m[d.cellularStatus] || 0) + 1;
      return m;
    },

    device(imei) { return this.devices.find(d => d.imei === imei); },
    recordsFor(imei) {
      return {
        calls: this.calls.filter(c => c.imei === imei),
        sms: this.sms.filter(s => s.imei === imei),
        logs: this.keyLogs.filter(l => l.imei === imei)
      };
    }
  };

  function ts(ms) {
    const d = new Date(ms);
    const p = (n, l) => String(n).padStart(l || 2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3) + ' | ';
  }

  global.UFI = {
    Store,
    api: { get: apiGet, post: apiPost, put: apiPut, del: apiDel },
    META: {
      OPERATORS, BANDS, SMS_CODES, REJECT_CODES, ENCRYPTION_TYPES,
      FLEET_SIZE: 0,
      ts,
      resolveOperator,
      NET_LABEL: {
        '5G': '5G', '4G': 'LTE', '3G': '3G', 'WLAN': 'WLAN',
        'NONE': '无服务', 'Flight mode': '飞行'
      },
      CMD_LIST: [
        { cmd: 'reboot', name: '设备重启', code: 'reboot', danger: true, icon: 'power', desc: 'PowerManager.reboot，约 1.5 秒后执行' },
        { cmd: 'restart_linphone', name: '重启 Linphone', code: 'restart_linphone', icon: 'refresh', desc: '先拉起 CoreService 再结束当前进程' },
        { cmd: 'wifi_scan', name: '扫描 WiFi', code: 'wifi_scan', icon: 'wifi-search', desc: '返回 wifiList / connectedSsid' },
        { cmd: 'wifi_connect', name: '连接 WiFi', code: 'wifi_connect', icon: 'wifi', desc: '需 wlanName + wlanPassword', fields: ['ssid', 'pwd'] },
        { cmd: 'wifi_on', name: '开启 WiFi', code: 'wifi_on', icon: 'wifi-on', desc: '等待 ENABLED 最长 10 秒' },
        { cmd: 'wifi_off', name: '关闭 WiFi', code: 'wifi_off', icon: 'wifi-off', desc: '关闭 STA WiFi' },
        { cmd: 'wificall', name: 'WiFi Calling', code: 'wificall', icon: 'phone-wifi', desc: '需 status=ON/OFF', fields: ['status'] },
        { cmd: 'hotspot_on', name: '开启热点', code: 'hotspot_on', icon: 'hotspot', desc: 'SoftAP，可改名称密码', fields: ['ssid', 'pwd'] },
        { cmd: 'hotspot_off', name: '关闭热点', code: 'hotspot_off', icon: 'hotspot-off', desc: '关闭 SoftAP' },
        { cmd: 'sim_verify_pin', name: '校验 SIM PIN', code: 'sim_verify_pin', icon: 'sim', desc: '失败返回 remainingAttempts', fields: ['pin'] },
        { cmd: 'sim_set_pin', name: '设置 SIM PIN', code: 'sim_set_pin', icon: 'sim-key', desc: '带 oldPin 为修改，否则启用 PIN 锁', fields: ['oldpin', 'pin'] },
        { cmd: 'sim_verify_puk', name: 'PUK 解锁', code: 'sim_verify_puk', icon: 'sim-lock', desc: '解除 PIN 锁定并设新 PIN', fields: ['puk', 'pin'] }
      ],
      LOG_CMDS: [
        { cmd: 'start', name: '开启日志采集', desc: '服务端下发 start，设备开始采集关键日志' },
        { cmd: 'stop', name: '停止日志采集', desc: '服务端下发 stop，设备停止采集' },
        { cmd: 'pull', name: '拉取并上传日志', desc: '按 days 拉取归档日志并经 upload-file 上传', fields: ['days'] }
      ]
    }
  };
})(window);
