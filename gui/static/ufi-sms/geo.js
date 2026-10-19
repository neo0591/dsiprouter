/* UFI SMS geo: E.164 dial → country, MCC → country (mirror of ufi_geo.py) */
(function (global) {
  'use strict';

  const DIAL = [
    ['886', 'TW', '中国台湾'], ['852', 'HK', '中国香港'], ['853', 'MO', '中国澳门'],
    ['971', 'AE', '阿联酋'], ['966', 'SA', '沙特'], ['972', 'IL', '以色列'],
    ['234', 'NG', '尼日利亚'], ['254', 'KE', '肯尼亚'],
    ['65', 'SG', '新加坡'], ['60', 'MY', '马来西亚'], ['66', 'TH', '泰国'],
    ['62', 'ID', '印度尼西亚'], ['63', 'PH', '菲律宾'], ['84', 'VN', '越南'],
    ['91', 'IN', '印度'], ['81', 'JP', '日本'], ['82', 'KR', '韩国'],
    ['61', 'AU', '澳大利亚'], ['64', 'NZ', '新西兰'], ['44', 'GB', '英国'],
    ['49', 'DE', '德国'], ['33', 'FR', '法国'], ['39', 'IT', '意大利'],
    ['34', 'ES', '西班牙'], ['31', 'NL', '荷兰'], ['32', 'BE', '比利时'],
    ['41', 'CH', '瑞士'], ['46', 'SE', '瑞典'], ['47', 'NO', '挪威'],
    ['45', 'DK', '丹麦'], ['48', 'PL', '波兰'], ['90', 'TR', '土耳其'],
    ['55', 'BR', '巴西'], ['52', 'MX', '墨西哥'], ['54', 'AR', '阿根廷'],
    ['27', 'ZA', '南非'], ['86', 'CN', '中国'], ['7', 'RU', '俄罗斯'],
    ['1', 'US', '美国']
  ].sort((a, b) => b[0].length - a[0].length);

  const MCC = {
    '202': ['GR', '希腊'], '204': ['NL', '荷兰'], '206': ['BE', '比利时'],
    '208': ['FR', '法国'], '214': ['ES', '西班牙'], '222': ['IT', '意大利'],
    '226': ['RO', '罗马尼亚'], '228': ['CH', '瑞士'], '232': ['AT', '奥地利'],
    '234': ['GB', '英国'], '235': ['GB', '英国'], '238': ['DK', '丹麦'],
    '240': ['SE', '瑞典'], '242': ['NO', '挪威'], '244': ['FI', '芬兰'],
    '250': ['RU', '俄罗斯'], '260': ['PL', '波兰'], '262': ['DE', '德国'],
    '268': ['PT', '葡萄牙'], '272': ['IE', '爱尔兰'], '286': ['TR', '土耳其'],
    '302': ['CA', '加拿大'],
    '310': ['US', '美国'], '311': ['US', '美国'], '312': ['US', '美国'],
    '313': ['US', '美国'], '314': ['US', '美国'], '315': ['US', '美国'], '316': ['US', '美国'],
    '334': ['MX', '墨西哥'], '404': ['IN', '印度'], '405': ['IN', '印度'],
    '440': ['JP', '日本'], '441': ['JP', '日本'], '450': ['KR', '韩国'],
    '452': ['VN', '越南'], '454': ['HK', '中国香港'], '455': ['MO', '中国澳门'],
    '460': ['CN', '中国'], '461': ['CN', '中国'], '466': ['TW', '中国台湾'],
    '502': ['MY', '马来西亚'], '505': ['AU', '澳大利亚'], '510': ['ID', '印度尼西亚'],
    '515': ['PH', '菲律宾'], '520': ['TH', '泰国'], '525': ['SG', '新加坡'],
    '530': ['NZ', '新西兰'], '621': ['NG', '尼日利亚'], '639': ['KE', '肯尼亚'],
    '655': ['ZA', '南非'], '724': ['BR', '巴西']
  };

  const FILTER_OPTIONS = [
    ['CN', '中国'], ['US', '美国'], ['HK', '中国香港'], ['TW', '中国台湾'],
    ['MO', '中国澳门'], ['SG', '新加坡'], ['MY', '马来西亚'], ['JP', '日本'],
    ['KR', '韩国'], ['GB', '英国'], ['AU', '澳大利亚'], ['DE', '德国'],
    ['FR', '法国'], ['IN', '印度'], ['TH', '泰国'], ['PH', '菲律宾'],
    ['ID', '印度尼西亚'], ['VN', '越南']
  ];

  function empty(name) { return { cc: '', name: name || '—' }; }
  function hit(cc, name) { return { cc: cc, name: name }; }

  function matchDial(digits) {
    for (let i = 0; i < DIAL.length; i++) {
      if (digits.indexOf(DIAL[i][0]) === 0) return hit(DIAL[i][1], DIAL[i][2]);
    }
    return null;
  }

  function dialToCountry(phone) {
    let s = String(phone == null ? '' : phone).trim();
    if (!s) return empty();

    if (/[A-Za-z*#]/.test(s) && !(s.charAt(0) === '+' && /^\+[0-9\s]+$/.test(s))) {
      const raw = s.replace(/\s+/g, '');
      if (/^[0-9A-Za-z*#.\-]{2,8}$/.test(raw) || /[A-Za-z*#]/.test(raw)) return empty('短码');
      return empty();
    }

    s = s.replace(/[\s\-().]/g, '');
    if (s.indexOf('00') === 0) s = '+' + s.slice(2);

    if (s.charAt(0) === '+') {
      const digits = s.slice(1).replace(/\D/g, '');
      if (!digits) return empty();
      if (digits.indexOf('86') === 0 && digits.length >= 13 && digits.charAt(2) === '1') {
        return hit('CN', '中国');
      }
      return matchDial(digits) || empty();
    }

    const digits = s.replace(/\D/g, '');
    if (!digits) return empty();
    if (/^1\d{10}$/.test(digits)) return hit('CN', '中国');
    if (digits.indexOf('86') === 0 && digits.length === 13 && digits.slice(2).charAt(0) === '1') {
      return hit('CN', '中国');
    }
    if (digits.length >= 2 && digits.length <= 6) return empty('短码');
    return matchDial(digits) || empty();
  }

  function mccToCountry(mccMnc) {
    const s = String(mccMnc == null ? '' : mccMnc).replace(/\D/g, '');
    if (s.length < 3) return empty();
    const row = MCC[s.slice(0, 3)];
    return row ? hit(row[0], row[1]) : empty();
  }

  /** Compact chip HTML: "美国" or "短码" */
  function chipHtml(cc, name, kind) {
    const n = String(name || '—');
    if (!n || n === '—') return '';
    const cls = 'sms-cc sms-cc--' + (kind || 'peer') + (cc ? ' sms-cc--' + String(cc).toLowerCase() : '');
    const tip = cc ? (cc + ' · ' + n) : n;
    return '<span class="' + cls + '" title="' + tip.replace(/"/g, '&quot;') + '">' +
      (cc ? '<b>' + cc + '</b> ' : '') + n + '</span>';
  }

  function peerChip(m) {
    if (m && (m.peer_country || m.peer_cc)) {
      return chipHtml(m.peer_cc || '', m.peer_country || '—', 'peer');
    }
    const g = dialToCountry(m && m.peer);
    return chipHtml(g.cc, g.name, 'peer');
  }

  function simChip(m) {
    if (m && (m.sim_country || m.sim_cc)) {
      return chipHtml(m.sim_cc || '', m.sim_country || '—', 'sim');
    }
    return '';
  }

  global.UfiGeo = {
    dialToCountry: dialToCountry,
    mccToCountry: mccToCountry,
    chipHtml: chipHtml,
    peerChip: peerChip,
    simChip: simChip,
    FILTER_OPTIONS: FILTER_OPTIONS
  };
})(window);
