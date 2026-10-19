# UFI geo helpers: E.164 dial → country, MCC → country (no libphonenumber)

from __future__ import annotations

import re

# Longest-prefix dial codes (common markets). Order by length desc when matching.
_DIAL_ROWS = (
    ('886', 'TW', '中国台湾'),
    ('852', 'HK', '中国香港'),
    ('853', 'MO', '中国澳门'),
    ('65', 'SG', '新加坡'),
    ('60', 'MY', '马来西亚'),
    ('66', 'TH', '泰国'),
    ('62', 'ID', '印度尼西亚'),
    ('63', 'PH', '菲律宾'),
    ('84', 'VN', '越南'),
    ('91', 'IN', '印度'),
    ('81', 'JP', '日本'),
    ('82', 'KR', '韩国'),
    ('61', 'AU', '澳大利亚'),
    ('64', 'NZ', '新西兰'),
    ('44', 'GB', '英国'),
    ('49', 'DE', '德国'),
    ('33', 'FR', '法国'),
    ('39', 'IT', '意大利'),
    ('34', 'ES', '西班牙'),
    ('31', 'NL', '荷兰'),
    ('32', 'BE', '比利时'),
    ('41', 'CH', '瑞士'),
    ('46', 'SE', '瑞典'),
    ('47', 'NO', '挪威'),
    ('45', 'DK', '丹麦'),
    ('48', 'PL', '波兰'),
    ('7', 'RU', '俄罗斯'),
    ('90', 'TR', '土耳其'),
    ('971', 'AE', '阿联酋'),
    ('966', 'SA', '沙特'),
    ('972', 'IL', '以色列'),
    ('55', 'BR', '巴西'),
    ('52', 'MX', '墨西哥'),
    ('54', 'AR', '阿根廷'),
    ('27', 'ZA', '南非'),
    ('234', 'NG', '尼日利亚'),
    ('254', 'KE', '肯尼亚'),
    ('86', 'CN', '中国'),
    ('1', 'US', '美国'),  # NANP; CA shares +1 — display as US/北美
)

_DIAL_SORTED = sorted(_DIAL_ROWS, key=lambda r: len(r[0]), reverse=True)

# MCC (first 3 digits of cellular_network) → country
_MCC_MAP = {
    '202': ('GR', '希腊'),
    '204': ('NL', '荷兰'),
    '206': ('BE', '比利时'),
    '208': ('FR', '法国'),
    '214': ('ES', '西班牙'),
    '222': ('IT', '意大利'),
    '226': ('RO', '罗马尼亚'),
    '228': ('CH', '瑞士'),
    '231': ('SK', '斯洛伐克'),
    '232': ('AT', '奥地利'),
    '234': ('GB', '英国'),
    '235': ('GB', '英国'),
    '238': ('DK', '丹麦'),
    '240': ('SE', '瑞典'),
    '242': ('NO', '挪威'),
    '244': ('FI', '芬兰'),
    '250': ('RU', '俄罗斯'),
    '255': ('UA', '乌克兰'),
    '260': ('PL', '波兰'),
    '262': ('DE', '德国'),
    '268': ('PT', '葡萄牙'),
    '272': ('IE', '爱尔兰'),
    '286': ('TR', '土耳其'),
    '302': ('CA', '加拿大'),
    '310': ('US', '美国'),
    '311': ('US', '美国'),
    '312': ('US', '美国'),
    '313': ('US', '美国'),
    '314': ('US', '美国'),
    '315': ('US', '美国'),
    '316': ('US', '美国'),
    '334': ('MX', '墨西哥'),
    '404': ('IN', '印度'),
    '405': ('IN', '印度'),
    '410': ('PK', '巴基斯坦'),
    '413': ('LK', '斯里兰卡'),
    '414': ('MM', '缅甸'),
    '415': ('LB', '黎巴嫩'),
    '416': ('JO', '约旦'),
    '418': ('IQ', '伊拉克'),
    '419': ('KW', '科威特'),
    '420': ('SA', '沙特'),
    '421': ('YE', '也门'),
    '422': ('OM', '阿曼'),
    '424': ('AE', '阿联酋'),
    '425': ('IL', '以色列'),
    '426': ('BH', '巴林'),
    '427': ('QA', '卡塔尔'),
    '429': ('NP', '尼泊尔'),
    '432': ('IR', '伊朗'),
    '440': ('JP', '日本'),
    '441': ('JP', '日本'),
    '450': ('KR', '韩国'),
    '452': ('VN', '越南'),
    '454': ('HK', '中国香港'),
    '455': ('MO', '中国澳门'),
    '456': ('KH', '柬埔寨'),
    '457': ('LA', '老挝'),
    '460': ('CN', '中国'),
    '461': ('CN', '中国'),
    '466': ('TW', '中国台湾'),
    '470': ('BD', '孟加拉'),
    '502': ('MY', '马来西亚'),
    '505': ('AU', '澳大利亚'),
    '510': ('ID', '印度尼西亚'),
    '515': ('PH', '菲律宾'),
    '520': ('TH', '泰国'),
    '525': ('SG', '新加坡'),
    '530': ('NZ', '新西兰'),
    '602': ('EG', '埃及'),
    '620': ('GH', '加纳'),
    '621': ('NG', '尼日利亚'),
    '639': ('KE', '肯尼亚'),
    '640': ('TZ', '坦桑尼亚'),
    '655': ('ZA', '南非'),
    '724': ('BR', '巴西'),
    '730': ('CL', '智利'),
    '732': ('CO', '哥伦比亚'),
    '734': ('VE', '委内瑞拉'),
    '736': ('BO', '玻利维亚'),
    '740': ('EC', '厄瓜多尔'),
    '744': ('PY', '巴拉圭'),
    '748': ('UY', '乌拉圭'),
}

_CN_MOBILE_RE = re.compile(r'^1\d{10}$')
_SHORTCODE_RE = re.compile(r'^[0-9A-Za-z*#.\-]{2,8}$')
_HAS_ALPHA = re.compile(r'[A-Za-z*#]')


def _empty(name='—'):
    return {'cc': '', 'name': name}


def _hit(cc, name):
    return {'cc': cc, 'name': name}


def _match_dial(digits):
    if not digits:
        return None
    for code, cc, name in _DIAL_SORTED:
        if digits.startswith(code):
            return _hit(cc, name)
    return None


def dial_to_country(phone):
    """Infer country from peer SMS address. Returns {cc, name}."""
    s = str(phone or '').strip()
    if not s:
        return _empty()

    # Alphanumeric / service shortcodes (keep + only if pure E.164 later)
    if _HAS_ALPHA.search(s) and not (s.startswith('+') and s[1:].replace(' ', '').isdigit()):
        raw = re.sub(r'\s+', '', s)
        if _SHORTCODE_RE.match(raw) or re.search(r'[A-Za-z*#]', raw):
            return _empty('短码')
        return _empty()

    s = re.sub(r'[\s\-().]', '', s)
    if s.startswith('00'):
        s = '+' + s[2:]

    if s.startswith('+'):
        digits = re.sub(r'\D', '', s[1:])
        if not digits:
            return _empty()
        # +86 + 11-digit mobile
        if digits.startswith('86') and len(digits) >= 13 and digits[2:3] == '1':
            return _hit('CN', '中国')
        hit = _match_dial(digits)
        return hit or _empty()

    digits = re.sub(r'\D', '', s)
    if not digits:
        return _empty()

    # Mainland mobile without +
    if _CN_MOBILE_RE.match(digits):
        return _hit('CN', '中国')
    if digits.startswith('86') and len(digits) == 13 and digits[2:].startswith('1'):
        return _hit('CN', '中国')

    # Short numeric service codes (10086, 95588, …)
    if 2 <= len(digits) <= 6:
        return _empty('短码')

    hit = _match_dial(digits)
    return hit or _empty()


def mcc_to_country(mcc_mnc):
    """Infer country from cellular_network / MCC(+MNC) string."""
    s = re.sub(r'\D', '', str(mcc_mnc or ''))
    if len(s) < 3:
        return _empty()
    hit = _MCC_MAP.get(s[:3])
    if hit:
        return _hit(hit[0], hit[1])
    return _empty()


def enrich_peer(phone):
    g = dial_to_country(phone)
    return {'peer_cc': g['cc'], 'peer_country': g['name']}


def enrich_sim(cellular_network):
    g = mcc_to_country(cellular_network)
    return {'sim_cc': g['cc'], 'sim_country': g['name']}


# Country options for filter UI (peer_cc)
COUNTRY_FILTER_OPTIONS = (
    ('CN', '中国'),
    ('US', '美国'),
    ('HK', '中国香港'),
    ('TW', '中国台湾'),
    ('MO', '中国澳门'),
    ('SG', '新加坡'),
    ('MY', '马来西亚'),
    ('JP', '日本'),
    ('KR', '韩国'),
    ('GB', '英国'),
    ('AU', '澳大利亚'),
    ('DE', '德国'),
    ('FR', '法国'),
    ('IN', '印度'),
    ('TH', '泰国'),
    ('PH', '菲律宾'),
    ('ID', '印度尼西亚'),
    ('VN', '越南'),
)
