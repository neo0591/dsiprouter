# ----------------------------------------------------------------------------
# UFI SMS Alert Center — 运营商短信分级规则引擎（对齐 design/sms-alert-center.html）
# classify_sms 纯函数可独立单测；落库侧映射 P0–P3 / 疑似 / 恢复
# ----------------------------------------------------------------------------
from __future__ import annotations

import re
from datetime import datetime, timedelta

from flask import request, session
from sqlalchemy.sql import text

from database import DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api
from shared import debugEndpoint, getRequestData
import settings

ALERT_BASE = '/api/v1/ufi/sms/alerts'

# ---- 端口白名单 / 级别元数据 ----
PORT_WHITELIST = {
    '10086': '中国移动', '1008611': '中国移动',
    '10010': '中国联通',
    '10001': '中国电信', '10000': '中国电信', '11888': '中国电信',
    '10099': '中国广电',
}
LEVELS = {
    'P0': {'code': 'P0', 'label': '欠费停机', 'severity': 'danger'},
    'P1': {'code': 'P1', 'label': '欠费预警', 'severity': 'warn'},
    'P2': {'code': 'P2', 'label': '余额不足', 'severity': 'warn'},
    'P3': {'code': 'P3', 'label': '超套费用', 'severity': 'info'},
    'RECOVERED': {'code': '恢复', 'label': '充值恢复', 'severity': 'ok'},
    'SUSPECT': {'code': '疑似', 'label': '疑似告警', 'severity': 'info'},
    'IGNORED': {'code': '忽略', 'label': '无需处理', 'severity': 'gray'},
}
ALERT_LEVELS = ('P0', 'P1', 'P2', 'P3')

RE_OWED = re.compile(r'欠费(?:金额)?(?:为|是)?\s*(-?\d+(?:\.\d+)?)\s*元')
RE_BAL = re.compile(r'余额(?:为|是|仅剩|只剩|只有|已低于)?\s*(-?\d+(?:\.\d+)?)\s*元')
RE_OVERAGE = re.compile(
    r'(?:套餐外|套外)[\s\S]{0,12}?(?:总费用|费用|话费)(?:已达|达到|为|是)?\s*(\d+(?:\.\d+)?)\s*元'
)

P0_RULES = [
    (re.compile(r'已停机'), '停机状态词「已停机」'),
    (re.compile(r'(?<!将)(?<!进行)欠费停机(?!将影响|风险)'), '停机状态词「欠费停机」'),
    (re.compile(r'并停机|已被停机'), '停机状态词「停机」'),
    (re.compile(r'限制主叫'), '停机状态词「限制主叫」'),
    (re.compile(r'单向停机|单通'), '停机状态词「单向停机 / 单通」'),
    (re.compile(r'(?<!将)(?<!后)暂停服务'), '停机状态词「暂停服务」'),
    (re.compile(r'(?<!将)(?<!后)停止服务'), '停机状态词「停止服务」'),
]
P1_RULES = [
    (re.compile(r'已欠费'), '欠费词「已欠费」（未停机）'),
    (re.compile(r'尚有未付款|未缴费用|应缴费用'), '欠费词「未缴 / 应缴费用」'),
    (re.compile(r'已透支|余额已低于0元|账户余额为负'), '透支词「已透支 / 余额低于 0 元」'),
    (re.compile(r'消费信用度|已使用信用度'), '透支词「信用度已消耗」'),
    (re.compile(
        r'将执行主叫停机|将被停机|将进行欠费停机|即将停机|可能停机|'
        r'小时后将(进行|被)?(欠费)?停机|(?<!公司)[将后][^。]{0,6}(?:停止|暂停)服务'
    ), '停机预告词「将停机 / 将停止服务」'),
]
P2_WORDS = [
    '余额不足', '余额较低', '余额偏低', '余额告急', '余额仅剩', '可用余额不足',
    '及时预存', '预存话费', '及时交费', '及时缴费', '请及时充值', '请尽快缴费', '尽快交纳',
    '合理规划预存', '为免停机', '以免停机', '为避免停机', '以免影响通信',
]
P2_RULES = [(re.compile(re.escape(w)), '预警词「{}」'.format(w)) for w in P2_WORDS] + [
    (re.compile(r'低于\s*\d+(?:\.\d+)?\s*元'), '低额提示「低于 X 元」'),
    (re.compile(r'余额为0时'), '预警表述「余额为 0 时将停止服务」'),
]
P3_WORDS = ['套餐外费用', '套餐外流量总费用', '套餐外语音', '套外语音', '超套餐提醒', '超出套餐', '超套费用']
P3_RULES = [(re.compile(re.escape(w)), '超套费用词「{}」'.format(w)) for w in P3_WORDS]
RECOVER_RULES = [
    (re.compile(r'充值到账'), '恢复词「充值到账」'),
    (re.compile(r'缴费成功|成功缴费|已缴费成功|充值成功'), '恢复词「缴费成功」'),
    (re.compile(r'话费已到账'), '恢复词「话费已到账」'),
]
FLOW_RULES = [
    (re.compile(r'流量'), '余量提醒词「流量」'),
    (re.compile(r'余量'), '余量提醒词「余量」'),
    (re.compile(r'语音剩余|通话时长|分钟数'), '余量提醒词「语音 / 分钟数」'),
    (re.compile(r'短信条数'), '余量提醒词「短信条数」'),
    (re.compile(r'\d+(?:\.\d+)?\s*(GB|MB|KB)', re.I), '余量提醒词「GB / MB」'),
]
BILLING_RULES = [
    (re.compile(r'本账期已产生|本月账单|应缴账单|出账应缴|本月话费已达'),
     '出账提醒词「本账期已产生总费用」'),
]
# 名词解释 / 业务查询类（含「账户余额」「预存」字样但无告警语义）
GLOSSARY_RULES = [
    (re.compile(r'【业务查询】|业务查询'), '名词解释「业务查询」'),
    (re.compile(r'通用余额是指|专款可用余额是指|未返还金额是指'), '名词解释「余额定义」'),
    (re.compile(r'是指您本月可抵扣|是指您办理了|是指尚未生效'), '名词解释「是指…」'),
]

DEFAULT_RULE_CFG = {
    'thresholds': {'中国移动': 10.0, '中国电信': 20.0, '中国联通': 10.0, '中国广电': 20.0},
    'p0Enabled': True,
    'p12Enabled': True,
    'overageEnabled': True,
    'overageThreshold': 50.0,
    'billingAlert': False,
    'unknownPortPolicy': 'suspect',
}

ALERT_DDL = (
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_alert (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        customer_id INT UNSIGNED NULL,
        imei VARCHAR(32) NOT NULL DEFAULT '',
        sim VARCHAR(32) NOT NULL DEFAULT '',
        peer VARCHAR(64) NOT NULL DEFAULT '',
        carrier VARCHAR(16) NOT NULL DEFAULT '',
        alert_type VARCHAR(16) NOT NULL DEFAULT '',
        severity VARCHAR(8) NOT NULL DEFAULT 'warn',
        level VARCHAR(16) NOT NULL DEFAULT '',
        confidence TINYINT UNSIGNED NOT NULL DEFAULT 0,
        amount VARCHAR(64) NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        rule_hit VARCHAR(255) NOT NULL DEFAULT '',
        src VARCHAR(16) NOT NULL DEFAULT 'device',
        src_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        status VARCHAR(8) NOT NULL DEFAULT 'todo',
        mail_status VARCHAR(32) NOT NULL DEFAULT '',
        done_by VARCHAR(64) NOT NULL DEFAULT '',
        done_at DATETIME NULL,
        remark VARCHAR(255) NOT NULL DEFAULT '',
        created DATETIME NOT NULL,
        KEY idx_alert_src (src, src_id),
        KEY idx_alert_status (status, created),
        KEY idx_alert_sim (sim, status),
        KEY idx_alert_customer (customer_id, status),
        KEY idx_alert_level (level, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_alert_cfg (
        id INT UNSIGNED PRIMARY KEY,
        emails VARCHAR(512) NOT NULL DEFAULT '',
        balance_threshold DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        enable_suspend TINYINT NOT NULL DEFAULT 1,
        enable_low TINYINT NOT NULL DEFAULT 1,
        dedupe TINYINT NOT NULL DEFAULT 1,
        thr_cmcc DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        thr_ct DECIMAL(10,2) NOT NULL DEFAULT 20.00,
        thr_cu DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        thr_cb DECIMAL(10,2) NOT NULL DEFAULT 20.00,
        enable_overage TINYINT NOT NULL DEFAULT 1,
        overage_threshold DECIMAL(10,2) NOT NULL DEFAULT 50.00,
        billing_alert TINYINT NOT NULL DEFAULT 0,
        unknown_port_policy VARCHAR(16) NOT NULL DEFAULT 'suspect',
        updated DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
)

_CFG_EXTRA_COLS = (
    ('thr_cmcc', "DECIMAL(10,2) NOT NULL DEFAULT 10.00"),
    ('thr_ct', "DECIMAL(10,2) NOT NULL DEFAULT 20.00"),
    ('thr_cu', "DECIMAL(10,2) NOT NULL DEFAULT 10.00"),
    ('thr_cb', "DECIMAL(10,2) NOT NULL DEFAULT 20.00"),
    ('enable_overage', "TINYINT NOT NULL DEFAULT 1"),
    ('overage_threshold', "DECIMAL(10,2) NOT NULL DEFAULT 50.00"),
    ('billing_alert', "TINYINT NOT NULL DEFAULT 0"),
    ('unknown_port_policy', "VARCHAR(16) NOT NULL DEFAULT 'suspect'"),
)
_ALERT_EXTRA_COLS = (
    ('level', "VARCHAR(16) NOT NULL DEFAULT ''"),
    ('confidence', "TINYINT UNSIGNED NOT NULL DEFAULT 0"),
)


def _ensure_alert_tables(db):
    for ddl in ALERT_DDL:
        db.execute(text(ddl))
    db.execute(text("INSERT IGNORE INTO dsip_ufi_sms_alert_cfg (id) VALUES (1)"))
    try:
        from modules.api.acl import ensure_acl_tables
        ensure_acl_tables(db)
    except Exception:
        pass
    try:
        cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_alert")).all()]
        if 'customer_id' not in cols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_alert ADD COLUMN customer_id INT UNSIGNED NULL"))
        for name, ddl in _ALERT_EXTRA_COLS:
            if name not in cols:
                db.execute(text("ALTER TABLE dsip_ufi_sms_alert ADD COLUMN {} {}".format(name, ddl)))
        try:
            db.execute(text("ALTER TABLE dsip_ufi_sms_alert MODIFY COLUMN amount VARCHAR(64) NOT NULL DEFAULT ''"))
            db.execute(text("ALTER TABLE dsip_ufi_sms_alert MODIFY COLUMN rule_hit VARCHAR(255) NOT NULL DEFAULT ''"))
        except Exception:
            pass
    except Exception:
        pass
    try:
        cfg_cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_alert_cfg")).all()]
        for name, ddl in _CFG_EXTRA_COLS:
            if name not in cfg_cols:
                db.execute(text("ALTER TABLE dsip_ufi_sms_alert_cfg ADD COLUMN {} {}".format(name, ddl)))
    except Exception:
        pass


def _norm_peer(peer):
    digits = re.sub(r'\D', '', str(peer or ''))
    if digits.startswith('86') and len(digits) > 11:
        digits = digits[2:]
    return digits


def _norm_sim(raw):
    """与短信通道页一致：大陆号去掉 86 前缀，显示为 11 位手机号。"""
    try:
        from modules.api.ufi_sms import _sim_norm
        return _sim_norm(raw)
    except Exception:
        digits = re.sub(r'\D', '', str(raw or ''))
        if digits.startswith('86') and len(digits) > 11:
            digits = digits[2:]
        return digits


def _parse_amount(text, rx):
    m = rx.search(text or '')
    if not m:
        return None
    try:
        return float(m.group(1))
    except (TypeError, ValueError):
        return None


def _match_rules(text, rules):
    return [hit for rx, hit in rules if rx.search(text or '')]


def _detect_carrier_by_prefix(text):
    m = re.search(r'【\s*(中国移动|中国联通|中国电信|中国广电|移动|联通|电信|广电)\s*】', text or '')
    if not m:
        return ''
    short = {'移动': '中国移动', '联通': '中国联通', '电信': '中国电信', '广电': '中国广电'}
    return short.get(m.group(1), m.group(1))


def _merge_rule_cfg(cfg=None):
    """把库配置 / API 入参合并为 classify_sms 使用的 RULE_CONFIG。"""
    out = {
        'thresholds': dict(DEFAULT_RULE_CFG['thresholds']),
        'p0Enabled': True,
        'p12Enabled': True,
        'overageEnabled': True,
        'overageThreshold': 50.0,
        'billingAlert': False,
        'unknownPortPolicy': 'suspect',
    }
    if not cfg:
        return out
    thr = cfg.get('thresholds') if isinstance(cfg.get('thresholds'), dict) else None
    if thr:
        for k, v in thr.items():
            try:
                out['thresholds'][k] = float(v)
            except (TypeError, ValueError):
                pass
    else:
        mapping = (
            ('thr_cmcc', '中国移动'), ('thr_ct', '中国电信'),
            ('thr_cu', '中国联通'), ('thr_cb', '中国广电'),
        )
        for key, name in mapping:
            if cfg.get(key) is not None:
                try:
                    out['thresholds'][name] = float(cfg[key])
                except (TypeError, ValueError):
                    pass
        # 兼容旧单阈值字段：若仅改了 balance_threshold，同步到移动/联通
        if cfg.get('balance_threshold') is not None and cfg.get('thr_cmcc') is None:
            try:
                bt = float(cfg['balance_threshold'])
                out['thresholds']['中国移动'] = bt
                out['thresholds']['中国联通'] = bt
            except (TypeError, ValueError):
                pass
    if 'p0Enabled' in cfg or 'enable_suspend' in cfg:
        v = cfg.get('p0Enabled', cfg.get('enable_suspend', 1))
        out['p0Enabled'] = str(v) not in ('0', 'false', 'False', 'off')
    if 'p12Enabled' in cfg or 'enable_low' in cfg:
        v = cfg.get('p12Enabled', cfg.get('enable_low', 1))
        out['p12Enabled'] = str(v) not in ('0', 'false', 'False', 'off')
    if 'overageEnabled' in cfg or 'enable_overage' in cfg:
        v = cfg.get('overageEnabled', cfg.get('enable_overage', 1))
        out['overageEnabled'] = str(v) not in ('0', 'false', 'False', 'off')
    try:
        out['overageThreshold'] = float(
            cfg.get('overageThreshold', cfg.get('overage_threshold', 50)) or 50
        )
    except (TypeError, ValueError):
        out['overageThreshold'] = 50.0
    if 'billingAlert' in cfg or 'billing_alert' in cfg:
        v = cfg.get('billingAlert', cfg.get('billing_alert', 0))
        out['billingAlert'] = str(v) in ('1', 'true', 'True', 'on')
    pol = str(cfg.get('unknownPortPolicy') or cfg.get('unknown_port_policy') or 'suspect').strip()
    out['unknownPortPolicy'] = pol if pol in ('suspect', 'ignore') else 'suspect'
    return out


def classify_sms(content, sender='', rule_cfg=None):
    """
    短信分级规则引擎（与 design/sms-alert-center.html classifySms 对齐）。
    返回 dict：level / label / carrier / whitelisted / hits / amounts / confidence / notes
    level: P0 | P1 | P2 | P3 | RECOVERED | SUSPECT | IGNORED
    """
    try:
        text = re.sub(r'\s+', ' ', str(content or '')).strip()
        port = str(sender or '').strip()
        cfg = _merge_rule_cfg(rule_cfg)
        notes = []

        prefix_carrier = _detect_carrier_by_prefix(text)
        port_carrier = PORT_WHITELIST.get(port, '')
        carrier = prefix_carrier or port_carrier or '未知运营商'
        whitelisted = bool(port_carrier)

        owed_amt = _parse_amount(text, RE_OWED)
        bal_amt = _parse_amount(text, RE_BAL)
        overage_amt = _parse_amount(text, RE_OVERAGE)
        amounts = []
        if owed_amt is not None:
            amounts.append({'name': '欠费金额', 'value': owed_amt})
        if bal_amt is not None:
            amounts.append({'name': '账户余额', 'value': bal_amt})
        if overage_amt is not None:
            amounts.append({'name': '套外费用', 'value': overage_amt})

        result = {
            'level': 'IGNORED', 'label': LEVELS['IGNORED']['label'],
            'carrier': carrier, 'whitelisted': whitelisted, 'port': port,
            'hits': [], 'amounts': amounts, 'confidence': 0, 'notes': notes,
        }

        recover_hits = _match_rules(text, RECOVER_RULES)
        is_recover = bool(recover_hits) or (owed_amt == 0 and '欠费' in text)
        glossary_hits = _match_rules(text, GLOSSARY_RULES)
        if is_recover:
            result['level'] = 'RECOVERED'
            result['hits'] = list(recover_hits)
            if not recover_hits:
                result['hits'].append('恢复表述「欠费金额为 0.00 元」')
            if owed_amt == 0 and '欠费' in text:
                result['hits'].append('欠费金额解析为 0.00 元（已结清）')
            notes.append('充值 / 缴费到账：该 SIM 卡自动恢复正常状态')
        elif glossary_hits:
            # 业务查询 / 余额名词解释：优先忽略，防「账户余额」「预存」字样误报 P2
            result['level'] = 'IGNORED'
            result['hits'] = glossary_hits
            notes.append('业务查询 / 名词解释短信，无需处理')
        else:
            p0_hits = _match_rules(text, P0_RULES)
            if bal_amt is not None and bal_amt < 0:
                p0_hits.insert(0, '余额解析为负数（{} 元）'.format(bal_amt))
            p1_hits = _match_rules(text, P1_RULES)
            if owed_amt is not None and owed_amt > 0:
                p1_hits.insert(0, '欠费金额解析为 {} 元（未停机）'.format(owed_amt))
            p3_hits = _match_rules(text, P3_RULES)
            flow_hits = _match_rules(text, FLOW_RULES)
            billing_hits = _match_rules(text, BILLING_RULES)
            p2_hits = _match_rules(text, P2_RULES)

            level, hits = 'IGNORED', []
            if p0_hits:
                if cfg['p0Enabled']:
                    level, hits = 'P0', p0_hits
                elif p1_hits:
                    level, hits = 'P1', p1_hits
                    notes.append('P0 欠费停机告警开关已关闭，降级为欠费预警')
                else:
                    level, hits = 'IGNORED', p0_hits
                    notes.append('P0 欠费停机告警开关已关闭')
            elif p1_hits:
                level, hits = 'P1', p1_hits
            elif p3_hits:
                if cfg['overageEnabled']:
                    level, hits = 'P3', p3_hits
                    if overage_amt is not None and overage_amt < cfg['overageThreshold']:
                        notes.append(
                            '套外费用 {} 元低于告警阈值 {} 元，仅提示关注'.format(
                                overage_amt, cfg['overageThreshold']
                            )
                        )
                else:
                    level, hits = 'IGNORED', p3_hits
                    notes.append('P3 超套费用告警开关已关闭')
            elif flow_hits:
                level, hits = 'IGNORED', flow_hits
                notes.append('流量 / 语音余量提醒，无需处理')
            elif billing_hits:
                hits = billing_hits
                if cfg['billingAlert']:
                    level = 'P3'
                    notes.append('出账提醒按告警处理（设置中已开启）')
                else:
                    level = 'IGNORED'
                    notes.append('出账提醒默认忽略，可在设置中开启告警')
            elif p2_hits and cfg['p12Enabled']:
                level = 'P2'
                hits = list(p2_hits)
                th = cfg['thresholds'].get(carrier, 10)
                if bal_amt is not None and bal_amt >= 0 and bal_amt < th:
                    hits.insert(0, '余额 {} 元 低于 {} 告警阈值 {} 元'.format(bal_amt, carrier, th))
                elif bal_amt is not None and bal_amt >= th:
                    notes.append('余额 {} 元 不低于阈值 {} 元，仅命中预警词（低置信）'.format(bal_amt, th))
                else:
                    notes.append('未能解析出具体余额金额（低置信）')
            elif p2_hits:
                level, hits = 'IGNORED', p2_hits
                notes.append('P1/P2 余额预警告警开关已关闭')
            else:
                notes.append('未命中任何告警规则')

            if (not whitelisted) and level in ALERT_LEVELS:
                if cfg['unknownPortPolicy'] == 'suspect':
                    notes.insert(0, '发送端口「{}」不在白名单内，按策略降级为「疑似」'.format(port or '未知'))
                    level = 'SUSPECT'
                else:
                    notes.insert(0, '发送端口「{}」不在白名单内，按策略直接忽略'.format(port or '未知'))
                    level = 'IGNORED'

            result['level'] = level
            result['hits'] = hits

        result['label'] = LEVELS.get(result['level'], LEVELS['IGNORED'])['label']
        conf = 45
        if whitelisted:
            conf += 25
        if prefix_carrier:
            conf += 8
        if prefix_carrier and port_carrier and prefix_carrier == port_carrier:
            conf += 7
        if amounts:
            conf += 10
        if result['level'] == 'SUSPECT':
            conf = min(conf, 45)
        result['confidence'] = max(5, min(99, conf))
        return result
    except Exception:
        return {
            'level': 'IGNORED', 'label': LEVELS['IGNORED']['label'],
            'carrier': '未知运营商', 'whitelisted': False, 'port': str(sender or ''),
            'hits': [], 'amounts': [], 'confidence': 5, 'notes': ['分类异常，已安全降级'],
        }


def _format_amount(amounts):
    if not amounts:
        return ''
    parts = []
    for a in amounts:
        try:
            v = a.get('value')
            parts.append('{} {} 元'.format(a.get('name') or '', v))
        except Exception:
            pass
    return '；'.join(parts)[:64]


def classify_carrier_sms(peer, body, balance_threshold=10.0, rule_cfg=None):
    """兼容旧入口：返回可落库字段，忽略类返回 None。"""
    cfg = dict(rule_cfg or {})
    if balance_threshold is not None and 'thresholds' not in cfg and 'thr_cmcc' not in cfg:
        cfg['balance_threshold'] = balance_threshold
    hit = classify_sms(body, peer, cfg)
    level = hit.get('level') or 'IGNORED'
    if level == 'IGNORED':
        return None
    meta = LEVELS.get(level, LEVELS['IGNORED'])
    return {
        'level': level,
        'alert_type': meta['label'],
        'severity': meta['severity'],
        'amount': _format_amount(hit.get('amounts') or []),
        'carrier': hit.get('carrier') or '',
        'rule_hit': '；'.join((hit.get('hits') or [])[:4])[:255],
        'confidence': int(hit.get('confidence') or 0),
        'notes': hit.get('notes') or [],
        'whitelisted': bool(hit.get('whitelisted')),
        'raw': hit,
    }


def _load_cfg(db):
    _ensure_alert_tables(db)
    row = db.execute(text(
        "SELECT * FROM dsip_ufi_sms_alert_cfg WHERE id=1"
    )).mappings().first()
    cfg = dict(row) if row else {}

    def _f(key, default):
        try:
            return float(cfg[key]) if cfg.get(key) is not None else float(default)
        except (TypeError, ValueError):
            return float(default)

    def _i(key, default=1):
        v = cfg.get(key)
        if v is None:
            return int(default)
        return 1 if str(v) not in ('0', 'false', 'False') else 0

    thr_cmcc = _f('thr_cmcc', cfg.get('balance_threshold') or 10)
    thr_ct = _f('thr_ct', 20)
    thr_cu = _f('thr_cu', cfg.get('balance_threshold') or 10)
    thr_cb = _f('thr_cb', 20)
    return {
        'emails': str(cfg.get('emails') or ''),
        'balance_threshold': thr_cmcc,
        'enable_suspend': _i('enable_suspend', 1),
        'enable_low': _i('enable_low', 1),
        'dedupe': _i('dedupe', 1),
        'thr_cmcc': thr_cmcc,
        'thr_ct': thr_ct,
        'thr_cu': thr_cu,
        'thr_cb': thr_cb,
        'enable_overage': _i('enable_overage', 1),
        'overage_threshold': _f('overage_threshold', 50),
        'billing_alert': _i('billing_alert', 0),
        'unknown_port_policy': str(cfg.get('unknown_port_policy') or 'suspect'),
        'thresholds': {
            '中国移动': thr_cmcc, '中国电信': thr_ct,
            '中国联通': thr_cu, '中国广电': thr_cb,
        },
    }


def _device_customer_id(db, imei):
    if not imei:
        return None
    try:
        return db.execute(text(
            "SELECT customer_id FROM dsip_ufi_device WHERE imei=:i LIMIT 1"
        ), {'i': imei}).scalar()
    except Exception:
        return None


def _dedupe_hit(db, sim, alert_type, hours=24):
    if not sim:
        return False
    since = datetime.now() - timedelta(hours=hours)
    n = db.execute(text(
        "SELECT COUNT(*) FROM dsip_ufi_sms_alert "
        "WHERE sim=:s AND alert_type=:t AND created>=:c AND status='todo'"
    ), {'s': sim, 't': alert_type, 'c': since}).scalar()
    return int(n or 0) > 0


def _maybe_mail(db, cfg, alert_row):
    emails = [e.strip() for e in str(cfg.get('emails') or '').split(',') if e.strip()]
    if not emails:
        return ''
    try:
        from util.notifications import sendEmail
        title = '[短信告警] {} {} {}'.format(
            alert_row.get('sim') or alert_row.get('imei') or '',
            alert_row.get('alert_type') or '',
            alert_row.get('amount') or '',
        )
        body = (
            '告警类型: {alert_type}\n严重级别: {severity}\nSIM: {sim}\nIMEI: {imei}\n'
            '运营商: {carrier}\n金额: {amount}\n发送方: {peer}\n时间: {created}\n\n原文:\n{body}\n'
        ).format(**alert_row)
        sendEmail(emails, body, subject=title)
        return '已发送'
    except Exception:
        return '发送失败'


def _auto_recover_sim(db, sim, imei, remark='充值恢复自动关闭'):
    """恢复类短信：将该卡未处理告警全部标为已处理。"""
    where = ["status='todo'"]
    params = {'r': str(remark)[:255], 'u': 'system-recover'}
    if sim:
        where.append("(sim=:sim OR sim=:sim86 OR REPLACE(sim,'+','')=:sim OR REPLACE(sim,'+','')=:sim86)")
        params['sim'] = sim
        params['sim86'] = ('86' + sim) if not str(sim).startswith('86') else sim
    elif imei:
        where.append('imei=:imei')
        params['imei'] = imei
    else:
        return 0
    r = db.execute(text(
        "UPDATE dsip_ufi_sms_alert SET status='done', done_by=:u, done_at=NOW(), remark=:r "
        "WHERE " + ' AND '.join(where)
    ), params)
    return int(r.rowcount or 0)


def record_sms_alert(db, *, imei='', sim='', peer='', body='', src='device', src_id=0,
                     customer_id=None, created=None):
    """对单条上行短信做识别并落库。返回新建告警 id 或 None。"""
    _ensure_alert_tables(db)
    cfg = _load_cfg(db)
    hit = classify_carrier_sms(peer, body, cfg['balance_threshold'], cfg)
    if not hit:
        return None

    if customer_id is None:
        customer_id = _device_customer_id(db, imei)
    sim = _norm_sim(sim)
    if not sim and imei:
        try:
            sim = _norm_sim(db.execute(text(
                "SELECT sim_number FROM dsip_ufi_device WHERE imei=:i"
            ), {'i': imei}).scalar() or '')
        except Exception:
            sim = ''

    # 恢复类：自动关闭该卡未处理告警，不新建
    if hit.get('level') == 'RECOVERED':
        _auto_recover_sim(db, sim, imei)
        return None

    # 开关：P0 / P1-P2（P3 / 疑似不受 enable_low 限制）
    level = hit.get('level') or ''
    if level == 'P0' and not cfg['enable_suspend']:
        return None
    if level in ('P1', 'P2') and not cfg['enable_low']:
        return None

    if int(src_id or 0):
        existed = db.execute(text(
            "SELECT id FROM dsip_ufi_sms_alert WHERE src=:s AND src_id=:i LIMIT 1"
        ), {'s': src, 'i': int(src_id)}).scalar()
        if existed:
            return int(existed)

    if cfg['dedupe'] and _dedupe_hit(db, sim or imei, hit['alert_type']):
        return None

    now = created or datetime.now()
    if hasattr(now, 'strftime'):
        now_s = now
    else:
        now_s = datetime.now()
    db.execute(text(
        "INSERT INTO dsip_ufi_sms_alert "
        "(customer_id,imei,sim,peer,carrier,alert_type,severity,level,confidence,amount,body,rule_hit,"
        "src,src_id,status,mail_status,created) "
        "VALUES (:cid,:imei,:sim,:peer,:car,:tp,:sev,:lv,:cf,:amt,:body,:rule,"
        ":src,:sid,'todo','',:now)"
    ), {
        'cid': customer_id, 'imei': str(imei or ''), 'sim': sim,
        'peer': str(peer or ''), 'car': hit['carrier'], 'tp': hit['alert_type'],
        'sev': hit['severity'], 'lv': level, 'cf': int(hit.get('confidence') or 0),
        'amt': hit['amount'], 'body': body[:4000],
        'rule': hit['rule_hit'], 'src': src, 'sid': int(src_id or 0), 'now': now_s,
    })
    aid = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    # 仅 P0–P3 发邮件；疑似不打扰
    mail_st = ''
    if level in ALERT_LEVELS:
        alert_row = {
            'sim': sim, 'imei': imei, 'alert_type': hit['alert_type'],
            'severity': hit['severity'], 'amount': hit['amount'],
            'carrier': hit['carrier'], 'peer': peer, 'body': body[:500],
            'created': str(now_s),
        }
        mail_st = _maybe_mail(db, cfg, alert_row)
    if mail_st:
        db.execute(text(
            "UPDATE dsip_ufi_sms_alert SET mail_status=:m WHERE id=:i"
        ), {'m': mail_st, 'i': aid})
    return int(aid) if aid else None


def scan_inbox_for_alerts(db, hours=72):
    """回扫设备上行 + 平台 MO 短信，补建告警。返回新建条数。"""
    _ensure_alert_tables(db)
    since = datetime.now() - timedelta(hours=hours)
    created = 0
    # 设备上行 dsip_ufi_sms
    try:
        rows = db.execute(text(
            "SELECT s.id, s.imei, s.smsm_tel, s.sms_body, s.sms_type, s.created_at, d.sim_number, d.customer_id "
            "FROM dsip_ufi_sms s LEFT JOIN dsip_ufi_device d ON d.imei=s.imei "
            "WHERE s.created_at>=:s ORDER BY s.id DESC LIMIT 2000"
        ), {'s': since}).mappings().all()
        for r in rows:
            st = str(r.get('sms_type') or '').lower()
            if st and st not in ('inbox', 'in', 'mo', '接收', 'recv', ''):
                # 明确是发出的跳过
                if st in ('out', 'sent', 'mt', '发送'):
                    continue
            aid = record_sms_alert(
                db, imei=r.get('imei') or '', sim=r.get('sim_number') or '',
                peer=r.get('smsm_tel') or '', body=r.get('sms_body') or '',
                src='device', src_id=int(r.get('id') or 0),
                customer_id=r.get('customer_id'), created=r.get('created_at'),
            )
            if aid:
                created += 1
    except Exception:
        pass
    # 平台 MO
    try:
        rows = db.execute(text(
            "SELECT id, imei, sim, peer, body, customer_id, created FROM dsip_ufi_sms_msg "
            "WHERE dir='in' AND created>=:s ORDER BY id DESC LIMIT 2000"
        ), {'s': since}).mappings().all()
        for r in rows:
            aid = record_sms_alert(
                db, imei=r.get('imei') or '', sim=r.get('sim') or '',
                peer=r.get('peer') or '', body=r.get('body') or '',
                src='platform', src_id=int(r.get('id') or 0),
                customer_id=r.get('customer_id'), created=r.get('created'),
            )
            if aid:
                created += 1
    except Exception:
        pass
    return created


def _scope_sql():
    from modules.api.acl import is_platform_admin, current_customer_id
    if is_platform_admin():
        return '', {}
    cid = current_customer_id()
    if cid is None:
        return ' AND a.customer_id=-1', {}
    return ' AND a.customer_id=:__cid', {'__cid': cid}


def _row_out(r):
    d = dict(r)
    for k in ('created', 'done_at'):
        if d.get(k) is not None:
            d[k] = str(d[k])
    if d.get('sim'):
        d['sim'] = _norm_sim(d.get('sim'))
    if d.get('sim_key'):
        d['sim_key'] = _norm_sim(d.get('sim_key')) or d.get('sim_key')
    return d


@api.route(ALERT_BASE, methods=['GET'])
@api_security
def listSmsAlerts():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_alert_tables(db)
        status = str(request.args.get('status') or '').strip()
        alert_type = str(request.args.get('type') or '').strip()
        sim = re.sub(r'\D', '', str(request.args.get('sim') or ''))
        kw = str(request.args.get('q') or '').strip()
        page = max(1, int(request.args.get('page') or 1))
        size = min(100, max(5, int(request.args.get('size') or 10)))
        frag, params = _scope_sql()
        where = 'WHERE 1=1' + frag
        if status in ('todo', 'done'):
            where += ' AND a.status=:st'
            params['st'] = status
        if alert_type:
            where += ' AND a.alert_type=:tp'
            params['tp'] = alert_type
        if sim:
            sim_n = _norm_sim(sim)
            where += " AND (a.sim LIKE :sim OR a.sim LIKE :sim86 OR REPLACE(a.sim,'+','') LIKE :sim)"
            params['sim'] = '%' + sim_n + '%'
            params['sim86'] = '%86' + sim_n + '%'
        if kw:
            where += ' AND (a.body LIKE :kw OR a.imei LIKE :kw OR a.peer LIKE :kw OR a.sim LIKE :kw)'
            params['kw'] = '%' + kw + '%'
        total = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_alert a " + where
        ), params).scalar()
        params['lim'] = size
        params['off'] = (page - 1) * size
        rows = db.execute(text(
            "SELECT a.* FROM dsip_ufi_sms_alert a " + where +
            " ORDER BY a.status='todo' DESC, a.created DESC LIMIT :lim OFFSET :off"
        ), params).mappings().all()
        return createApiResponse(msg='alerts', data=[{
            'items': [_row_out(r) for r in rows],
            'total': int(total or 0),
            'page': page,
            'size': size,
        }])
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/stats', methods=['GET'])
@api_security
def smsAlertStats():
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        frag, params = _scope_sql()
        # 角标 / KPI 仅计 P0–P3（排除疑似）；兼容旧数据 level 为空时按 severity
        p_frag = (
            " AND (a.level IN ('P0','P1','P2','P3') OR "
            "(a.level='' AND a.severity IN ('danger','warn','info') AND a.alert_type<>'疑似告警'))"
        )
        danger = db.execute(text(
            "SELECT COUNT(DISTINCT IF(sim='', imei, sim)) FROM dsip_ufi_sms_alert a "
            "WHERE a.status='todo' AND (a.level='P0' OR (a.level='' AND a.severity='danger'))" + frag
        ), params).scalar()
        warn = db.execute(text(
            "SELECT COUNT(DISTINCT IF(sim='', imei, sim)) FROM dsip_ufi_sms_alert a "
            "WHERE a.status='todo' AND ("
            "a.level IN ('P1','P2','P3') OR "
            "(a.level='' AND a.severity IN ('warn','info') AND a.alert_type<>'疑似告警'))" + frag
        ), params).scalar()
        done = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_alert a WHERE a.status='done'" + frag
        ), params).scalar()
        todo = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_alert a WHERE a.status='todo'" + p_frag + frag
        ), params).scalar()
        day0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        params2 = dict(params)
        params2['d0'] = day0
        mailed = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_alert a "
            "WHERE a.mail_status LIKE '已发送%' AND a.created>=:d0" + frag
        ), params2).scalar()
        return createApiResponse(msg='stats', data=[{
            'dangerSims': int(danger or 0),
            'warnSims': int(warn or 0),
            'todo': int(todo or 0),
            'done': int(done or 0),
            'mailedToday': int(mailed or 0),
        }])
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/sims', methods=['GET'])
@api_security
def smsAlertSims():
    """未处理告警按手机卡聚合。"""
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        frag, params = _scope_sql()
        rows = db.execute(text(
            "SELECT IF(a.sim='', a.imei, a.sim) AS sim_key, "
            "MAX(a.sim) AS sim, MAX(a.imei) AS imei, MAX(a.carrier) AS carrier, "
            "MAX(CASE "
            "  WHEN a.level='P0' OR (a.level='' AND a.severity='danger') THEN 4 "
            "  WHEN a.level='P1' THEN 3 "
            "  WHEN a.level='P2' OR (a.level='' AND a.severity='warn') THEN 2 "
            "  WHEN a.level='P3' THEN 1 ELSE 0 END) AS sev_rank, "
            "SUBSTRING_INDEX(GROUP_CONCAT("
            "  CASE WHEN a.level IN ('P0','P1','P2','P3') OR "
            "  (a.level='' AND a.alert_type<>'疑似告警' AND a.severity IN ('danger','warn','info')) "
            "  THEN IF(a.level='', a.alert_type, a.level) ELSE NULL END "
            "  ORDER BY CASE a.level WHEN 'P0' THEN 4 WHEN 'P1' THEN 3 WHEN 'P2' THEN 2 "
            "  WHEN 'P3' THEN 1 ELSE 0 END DESC SEPARATOR ','), ',', 1) AS top_level, "
            "MAX(a.amount) AS amount, MAX(a.body) AS body, MAX(a.created) AS last_at, "
            "SUM(a.status='todo' AND (a.level IN ('P0','P1','P2','P3') OR "
            "  (a.level='' AND a.alert_type<>'疑似告警'))) AS todo_n "
            "FROM dsip_ufi_sms_alert a WHERE a.status='todo' AND ("
            "a.level IN ('P0','P1','P2','P3') OR "
            "(a.level='' AND a.alert_type<>'疑似告警' AND a.severity IN ('danger','warn','info')))" + frag +
            " GROUP BY sim_key HAVING todo_n>0 ORDER BY sev_rank DESC, last_at DESC LIMIT 200"
        ), params).mappings().all()
        label_map = {
            'P0': '欠费停机', 'P1': '欠费预警', 'P2': '余额不足', 'P3': '超套费用',
            '欠费停机': '欠费停机', '欠费预警': '欠费预警', '余额不足': '余额不足', '超套费用': '超套费用',
        }
        out = []
        for r in rows:
            d = _row_out(r)
            rank = int(d.get('sev_rank') or 0)
            top = str(d.get('top_level') or '')
            d['level'] = top if top in ('P0', 'P1', 'P2', 'P3') else (
                'P0' if rank >= 4 else ('P1' if rank == 3 else ('P3' if rank == 1 else 'P2'))
            )
            d['severity'] = 'danger' if d['level'] == 'P0' else ('info' if d['level'] == 'P3' else 'warn')
            d['status_label'] = label_map.get(top) or label_map.get(d['level']) or '余额不足'
            out.append(d)
        return createApiResponse(msg='sims', data=out)
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/<int:aid>/done', methods=['POST'])
@api_security
def markSmsAlertDone(aid):
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        body = request.get_json(silent=True) or {}
        remark = str(body.get('remark') or '').strip()[:255]
        frag, params = _scope_sql()
        params['i'] = aid
        row = db.execute(text(
            "SELECT id FROM dsip_ufi_sms_alert a WHERE a.id=:i" + frag
        ), params).first()
        if not row:
            return createApiResponse(error='http', msg='告警不存在', status_code=404)
        who = session.get('username') or session.get('user') or 'admin'
        db.execute(text(
            "UPDATE dsip_ufi_sms_alert SET status='done', done_by=:u, done_at=NOW(), remark=:r "
            "WHERE id=:i"
        ), {'u': str(who)[:64], 'r': remark, 'i': aid})
        db.commit()
        return createApiResponse(msg='已处理')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/sims/done', methods=['POST'])
@api_security
def markSmsAlertSimDone():
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        body = request.get_json(silent=True) or {}
        sim = _norm_sim(body.get('sim') or '')
        imei = str(body.get('imei') or '').strip()
        if not sim and not imei:
            return createApiResponse(error='http', msg='sim 或 imei 必填', status_code=400)
        remark = str(body.get('remark') or '').strip()[:255]
        frag, params = _scope_sql()
        where = "a.status='todo'" + frag
        if sim:
            # 兼容历史 86 前缀与本地 11 位
            where += " AND (a.sim=:sim OR a.sim=:sim86 OR REPLACE(a.sim,'+','')=:sim OR REPLACE(a.sim,'+','')=:sim86)"
            params['sim'] = sim
            params['sim86'] = ('86' + sim) if not sim.startswith('86') else sim
        if imei:
            where += ' AND a.imei=:imei'
            params['imei'] = imei
        who = session.get('username') or session.get('user') or 'admin'
        params.update({'u': str(who)[:64], 'r': remark})
        r = db.execute(text(
            "UPDATE dsip_ufi_sms_alert a SET status='done', done_by=:u, done_at=NOW(), remark=:r "
            "WHERE " + where
        ), params)
        db.commit()
        return createApiResponse(msg='已处理', data=[{'updated': int(r.rowcount or 0)}])
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/done-all', methods=['POST'])
@api_security
def markAllSmsAlertsDone():
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        frag, params = _scope_sql()
        who = session.get('username') or session.get('user') or 'admin'
        params['u'] = str(who)[:64]
        r = db.execute(text(
            "UPDATE dsip_ufi_sms_alert a SET status='done', done_by=:u, done_at=NOW() "
            "WHERE a.status='todo'" + frag
        ), params)
        db.commit()
        return createApiResponse(msg='已全部处理', data=[{'updated': int(r.rowcount or 0)}])
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/scan', methods=['POST'])
@api_security
def scanSmsAlerts():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        n = scan_inbox_for_alerts(db)
        db.commit()
        return createApiResponse(msg='扫描完成', data=[{'created': n}])
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/config', methods=['GET', 'POST'])
@api_security
def smsAlertConfig():
    from modules.api.acl import is_platform_admin
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        if request.method == 'GET':
            return createApiResponse(msg='config', data=[_load_cfg(db)])
        if not is_platform_admin():
            return createApiResponse(error='http', msg='仅平台管理员可修改告警通知设置', status_code=403)
        body = request.get_json(silent=True) or getRequestData() or {}
        emails = str(body.get('emails') or '').strip()[:512]

        def _num(key, default):
            try:
                return float(body[key]) if body.get(key) is not None else float(default)
            except (TypeError, ValueError):
                return float(default)

        def _flag(key, default=1):
            if key not in body:
                return int(default)
            return 1 if str(body.get(key)) in ('1', 'true', 'True', 'on') else 0

        thr_cmcc = _num('thr_cmcc', body.get('balance_threshold') or 10)
        thr_ct = _num('thr_ct', 20)
        thr_cu = _num('thr_cu', body.get('balance_threshold') or 10)
        thr_cb = _num('thr_cb', 20)
        overage_th = _num('overage_threshold', 50)
        pol = str(body.get('unknown_port_policy') or 'suspect').strip()
        if pol not in ('suspect', 'ignore'):
            pol = 'suspect'
        db.execute(text(
            "UPDATE dsip_ufi_sms_alert_cfg SET emails=:e, balance_threshold=:t, "
            "enable_suspend=:s, enable_low=:l, dedupe=:d, "
            "thr_cmcc=:cmcc, thr_ct=:ct, thr_cu=:cu, thr_cb=:cb, "
            "enable_overage=:eo, overage_threshold=:ot, billing_alert=:ba, "
            "unknown_port_policy=:pol, updated=NOW() WHERE id=1"
        ), {
            'e': emails, 't': thr_cmcc,
            's': _flag('enable_suspend', 1),
            'l': _flag('enable_low', 1),
            'd': _flag('dedupe', 1),
            'cmcc': thr_cmcc, 'ct': thr_ct, 'cu': thr_cu, 'cb': thr_cb,
            'eo': _flag('enable_overage', 1), 'ot': overage_th,
            'ba': _flag('billing_alert', 0), 'pol': pol,
        })
        db.commit()
        return createApiResponse(msg='已保存', data=[_load_cfg(db)])
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route(ALERT_BASE + '/classify', methods=['POST'])
@api_security
def classifySmsAlert():
    """规则测试台：对原文做分级，不落库。"""
    db = DummySession()
    try:
        db = startSession()
        _ensure_alert_tables(db)
        body = request.get_json(silent=True) or getRequestData() or {}
        cfg = _load_cfg(db)
        # 允许临时覆盖阈值做试算
        override = body.get('cfg') if isinstance(body.get('cfg'), dict) else {}
        merged = dict(cfg)
        merged.update(override or {})
        hit = classify_sms(body.get('body') or body.get('content') or '',
                           body.get('peer') or body.get('sender') or '',
                           merged)
        return createApiResponse(msg='classify', data=[hit])
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()
