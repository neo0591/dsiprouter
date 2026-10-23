# ----------------------------------------------------------------------------
# UFI SMS Center — UFI 池作为平台短信线路通道
#   MT: GUI -> 本模块 raw SIP MESSAGE -> 127.0.0.1:5060 (Kamailio route[SMS_RELAY])
#       -> lookup(location) -> UFI (R-URI=IMEI, X-SMS=对端号码; X-VOLTE 保留兼容。固件 sms-gw 模块读 X-SMS，缺失则 FAIL missing X-SMS tel)
#   MO: UFI -> MESSAGE -> Kamailio SMS_RELAY sqlops 落库 -> 本模块 records
#   后台线程: 群发任务匀速出队 + 定时任务到点执行（单进程 GUI，线程安全）
# ----------------------------------------------------------------------------
import json
import random
import re
import socket
import threading
import time
from datetime import datetime, timedelta

from flask import request
from sqlalchemy.sql import text

from database import DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api, _ufi_auth_domain
from modules.api.ufi_device import _ensure_ufi_tables
from modules.api.ufi_geo import enrich_peer, enrich_sim
from shared import debugEndpoint, getRequestData
import settings

# peer_cc → SQL fragment for list filter (approx; display uses dial_to_country)
_PEER_CC_SQL = {
    'CN': ("(m.peer REGEXP '^1[0-9]{10}$' OR m.peer LIKE '+86%' "
           "OR (m.peer LIKE '86%' AND CHAR_LENGTH(m.peer)=13))"),
    'US': "(m.peer LIKE '+1%' OR m.peer LIKE '001%')",
    'HK': "(m.peer LIKE '+852%' OR m.peer LIKE '00852%')",
    'TW': "(m.peer LIKE '+886%' OR m.peer LIKE '00886%')",
    'MO': "(m.peer LIKE '+853%' OR m.peer LIKE '00853%')",
    'SG': "(m.peer LIKE '+65%' OR m.peer LIKE '0065%')",
    'MY': "(m.peer LIKE '+60%' OR m.peer LIKE '0060%')",
    'JP': "(m.peer LIKE '+81%' OR m.peer LIKE '0081%')",
    'KR': "(m.peer LIKE '+82%' OR m.peer LIKE '0082%')",
    'GB': "(m.peer LIKE '+44%' OR m.peer LIKE '0044%')",
    'AU': "(m.peer LIKE '+61%' OR m.peer LIKE '0061%')",
    'DE': "(m.peer LIKE '+49%' OR m.peer LIKE '0049%')",
    'FR': "(m.peer LIKE '+33%' OR m.peer LIKE '0033%')",
    'IN': "(m.peer LIKE '+91%' OR m.peer LIKE '0091%')",
    'TH': "(m.peer LIKE '+66%' OR m.peer LIKE '0066%')",
    'PH': "(m.peer LIKE '+63%' OR m.peer LIKE '0063%')",
    'ID': "(m.peer LIKE '+62%' OR m.peer LIKE '0062%')",
    'VN': "(m.peer LIKE '+84%' OR m.peer LIKE '0084%')",
}

SMS_BASE = '/api/v1/ufi/sms'

# ---------------------------------------------------------------- tables
SMS_DDL = [
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_settings (
        id INT UNSIGNED PRIMARY KEY,
        strategy VARCHAR(8) NOT NULL DEFAULT 'wrr',
        per_hour INT NOT NULL DEFAULT 40,
        per_day INT NOT NULL DEFAULT 400,
        gap_s INT NOT NULL DEFAULT 6,
        burst_gap_s INT NOT NULL DEFAULT 90,
        quiet_enabled TINYINT NOT NULL DEFAULT 1,
        quiet_from VARCHAR(8) NOT NULL DEFAULT '23:00',
        quiet_to VARCHAR(8) NOT NULL DEFAULT '08:00',
        sig VARCHAR(32) NOT NULL DEFAULT '',
        updated_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_tpl (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        type VARCHAR(8) NOT NULL DEFAULT '通知',
        vars VARCHAR(255) NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        created DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_black (
        num VARCHAR(16) PRIMARY KEY,
        src VARCHAR(8) NOT NULL DEFAULT '手动',
        created DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_word (
        word VARCHAR(64) PRIMARY KEY
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_msg (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        dir VARCHAR(4) NOT NULL DEFAULT 'out',
        imei VARCHAR(32) NOT NULL DEFAULT '',
        sim VARCHAR(32) NOT NULL DEFAULT '',
        peer VARCHAR(64) NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        state VARCHAR(12) NOT NULL DEFAULT 'sending',
        err VARCHAR(128) NOT NULL DEFAULT '',
        task_id INT NOT NULL DEFAULT 0,
        created DATETIME NOT NULL,
        INDEX idx_msg_created (created),
        INDEX idx_msg_imei_time (imei, created)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_task (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        tpl_id VARCHAR(32) NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        rcpts TEXT NOT NULL,
        rate INT NOT NULL DEFAULT 20,
        per_hour INT NOT NULL DEFAULT 40,
        total INT NOT NULL DEFAULT 0,
        sent INT NOT NULL DEFAULT 0,
        fail INT NOT NULL DEFAULT 0,
        state VARCHAR(12) NOT NULL DEFAULT 'draft',
        note VARCHAR(255) NOT NULL DEFAULT '',
        start_at DATETIME NULL,
        created DATETIME NOT NULL,
        INDEX idx_task_state (state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_sched (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        kind VARCHAR(8) NOT NULL DEFAULT 'daily',
        run VARCHAR(32) NOT NULL,
        targets VARCHAR(255) NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        enabled TINYINT NOT NULL DEFAULT 1,
        last VARCHAR(64) NOT NULL DEFAULT '未执行',
        note VARCHAR(255) NOT NULL DEFAULT '',
        last_run DATETIME NULL,
        created DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_ch (
        imei VARCHAR(32) PRIMARY KEY,
        enabled TINYINT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
    """CREATE TABLE IF NOT EXISTS dsip_ufi_sms_policy (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        strategy VARCHAR(8) NOT NULL DEFAULT 'wrr',
        rate INT NOT NULL DEFAULT 20,
        per_hour INT NOT NULL DEFAULT 40,
        per_day INT NOT NULL DEFAULT 400,
        gap_s INT NOT NULL DEFAULT 6,
        burst_gap_s INT NOT NULL DEFAULT 90,
        quiet_enabled TINYINT NOT NULL DEFAULT 1,
        quiet_from VARCHAR(8) NOT NULL DEFAULT '23:00',
        quiet_to VARCHAR(8) NOT NULL DEFAULT '08:00',
        created DATETIME NULL,
        updated DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
]


def _ensure_sms_tables(db):
    for ddl in SMS_DDL:
        db.execute(text(ddl))
    db.execute(text("INSERT IGNORE INTO dsip_ufi_sms_settings (id) VALUES (1)"))
    try:
        cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_task")).all()]
        if 'policy_id' not in cols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_task ADD COLUMN policy_id INT NOT NULL DEFAULT 0"))
        if 'pool_id' not in cols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_task ADD COLUMN pool_id VARCHAR(16) NOT NULL DEFAULT ''"))
    except Exception:
        pass
    try:
        idx = [r[2] for r in db.execute(text("SHOW INDEX FROM dsip_ufi_sms_msg")).all()]
        if 'idx_msg_peer' not in idx:
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD INDEX idx_msg_peer (peer)"))
    except Exception:
        pass
    try:
        mcols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_msg")).all()]
        if 'push_mo' not in mcols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD COLUMN push_mo TINYINT NOT NULL DEFAULT 0"))
        if 'push_report' not in mcols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD COLUMN push_report TINYINT NOT NULL DEFAULT 0"))
        peer_col = next((r for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_msg")).all()
                         if r[0] == 'peer'), None)
        if peer_col and 'varchar(64)' not in str(peer_col[1] or '').lower():
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg MODIFY COLUMN peer VARCHAR(64) NOT NULL DEFAULT ''"))
    except Exception:
        pass
    # 定时能力并入群发：扩展 sched 表以承载完整收件人 JSON 与速率
    try:
        scols = {r[0]: r for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_sched")).all()}
        if scols.get('targets') and 'text' not in str(scols['targets'][1] or '').lower() \
                and 'blob' not in str(scols['targets'][1] or '').lower():
            db.execute(text("ALTER TABLE dsip_ufi_sms_sched MODIFY COLUMN targets TEXT NOT NULL"))
        for col, ddl in (
            ('tpl_id', "ALTER TABLE dsip_ufi_sms_sched ADD COLUMN tpl_id VARCHAR(32) NOT NULL DEFAULT ''"),
            ('rate', "ALTER TABLE dsip_ufi_sms_sched ADD COLUMN rate INT NOT NULL DEFAULT 20"),
            ('per_hour', "ALTER TABLE dsip_ufi_sms_sched ADD COLUMN per_hour INT NOT NULL DEFAULT 40"),
            ('policy_id', "ALTER TABLE dsip_ufi_sms_sched ADD COLUMN policy_id INT NOT NULL DEFAULT 0"),
            ('pool_id', "ALTER TABLE dsip_ufi_sms_sched ADD COLUMN pool_id VARCHAR(16) NOT NULL DEFAULT ''"),
        ):
            if col not in scols:
                db.execute(text(ddl))
    except Exception:
        pass
    from modules.api.acl import ensure_acl_tables
    ensure_acl_tables(db)
    _relax_natural_pk(db, 'dsip_ufi_sms_black', 'num')
    _relax_natural_pk(db, 'dsip_ufi_sms_word', 'word')
    try:
        db.execute(text(
            "UPDATE dsip_ufi_sms_msg m JOIN dsip_ufi_device d ON d.imei=m.imei "
            "SET m.customer_id=d.customer_id "
            "WHERE m.customer_id IS NULL AND d.customer_id IS NOT NULL"))
    except Exception:
        pass
    db.commit()


_CID_UNSET = object()


def _relax_natural_pk(db, table, col):
    """黑名单/敏感词原主键是号码或词本身，改成自增 id，便于不同客户各存一份。"""
    try:
        idx = db.execute(text("SHOW INDEX FROM " + table + " WHERE Key_name='PRIMARY'")).all()
    except Exception:
        return
    cols = [r[4] for r in idx]
    if cols == [col]:
        db.execute(text("ALTER TABLE %s DROP PRIMARY KEY" % table))
        db.execute(text(
            "ALTER TABLE %s ADD COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST" % table))
    names = []
    try:
        names = [r[2] for r in db.execute(text("SHOW INDEX FROM " + table)).all()]
    except Exception:
        return
    uk = 'uk_cust_' + col
    if uk not in names:
        try:
            db.execute(text(
                "ALTER TABLE %s ADD UNIQUE KEY %s (customer_id, %s)" % (table, uk, col)))
        except Exception:
            pass


def _scope_bind(where, params, col='customer_id'):
    from modules.api.acl import apply_customer_filter
    apply_customer_filter(where, params, col)


def _scope_and(alias=''):
    from modules.api.acl import customer_sql
    return customer_sql(alias)


def _stamp_cid():
    from modules.api.acl import stamp_customer
    return stamp_customer()


def _cid_match_sql(col, cid):
    """精确匹配写入者：平台为 NULL，客户为自身 id。"""
    if cid in (None, '', 0, '0'):
        return col + ' IS NULL', {}
    return col + '=:__ocid', {'__ocid': int(cid)}


def _row_owned(row):
    from modules.api.acl import is_platform_admin, current_customer_id
    if is_platform_admin():
        return True
    cid = current_customer_id()
    got = (row or {}).get('customer_id')
    try:
        got = int(got) if got not in (None, '', 0, '0') else None
    except (TypeError, ValueError):
        got = None
    return cid is not None and got == cid


def _words_of(db, customer_id=_CID_UNSET):
    sql = "SELECT word FROM dsip_ufi_sms_word WHERE 1=1"
    if customer_id is _CID_UNSET:
        frag, params = _scope_and()
    else:
        frag, params = _cid_match_sql('customer_id', customer_id)
        frag = ' AND ' + frag
    return [w[0] for w in db.execute(text(sql + frag), params).all() if w[0]]


def _black_hit(db, num, customer_id=_CID_UNSET):
    variants = _cn_addr_variants(num) or {norm_sms_addr(num) or num}
    if customer_id is _CID_UNSET:
        frag, extra = _scope_and()
    else:
        frag, extra = _cid_match_sql('customer_id', customer_id)
        frag = ' AND ' + frag
    for n in variants:
        if not n:
            continue
        params = dict(extra, n=n)
        if db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_black WHERE num=:n" + frag
        ), params).scalar():
            return True
    return False


def _black_nums(db, customer_id=_CID_UNSET):
    sql = "SELECT num FROM dsip_ufi_sms_black WHERE 1=1"
    if customer_id is _CID_UNSET:
        frag, params = _scope_and()
    else:
        frag, params = _cid_match_sql('customer_id', customer_id)
        frag = ' AND ' + frag
    return {r[0] for r in db.execute(text(sql + frag), params).all()}


def _parse_date_range():
    """解析 date_from / date_to（YYYY-MM-DD）。返回 (start, end_exclusive) 或 (None, None)。"""
    fr = (request.args.get('date_from') or request.args.get('from') or '').strip()[:10]
    to = (request.args.get('date_to') or request.args.get('to') or '').strip()[:10]
    start = end = None
    if fr:
        try:
            start = datetime.strptime(fr, '%Y-%m-%d')
        except ValueError:
            start = None
    if to:
        try:
            end = datetime.strptime(to, '%Y-%m-%d') + timedelta(days=1)
        except ValueError:
            end = None
    return start, end


def _apply_date_range(where, params, col='created'):
    start, end = _parse_date_range()
    if start is not None:
        where.append('%s>=:date_from' % col)
        params['date_from'] = start
    if end is not None:
        where.append('%s<:date_to' % col)
        params['date_to'] = end
    return start, end


# ---------------------------------------------------------------- settings / helpers
def _settings(db):
    s = db.execute(text("SELECT * FROM dsip_ufi_sms_settings WHERE id=1")).mappings().first()
    return dict(s) if s else {}


def _policy(db, pid):
    """按 id 取发送策略；无效返回 None（回退全局默认设置）。"""
    try:
        pid = int(pid or 0)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    r = db.execute(text("SELECT * FROM dsip_ufi_sms_policy WHERE id=:i"), {'i': pid}).mappings().first()
    if not r:
        return None
    try:
        from flask import has_request_context
        if has_request_context() and not _row_owned(r):
            return None
    except Exception:
        pass
    return dict(r)


def _policies(db):
    where, params = [], {}
    _scope_bind(where, params, 'customer_id')
    wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
    rows = db.execute(text("SELECT * FROM dsip_ufi_sms_policy" + wsql + " ORDER BY id"), params).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d['created'] = d['created'].strftime('%Y-%m-%d %H:%M') if d.get('created') else ''
        d['updated'] = d['updated'].strftime('%Y-%m-%d %H:%M') if d.get('updated') else ''
        out.append(d)
    return out


def _quiet_now(s):
    if not s.get('quiet_enabled'):
        return False
    try:
        now = datetime.now()
        h = now.hour + now.minute / 60.0
        fh = [int(x) for x in str(s.get('quiet_from', '23:00')).split(':')]
        th = [int(x) for x in str(s.get('quiet_to', '08:00')).split(':')]
        f = fh[0] + fh[1] / 60.0
        t = th[0] + th[1] / 60.0
        return (h >= f or h < t) if f > t else (h >= f and h < t)
    except Exception:
        return False


def _quiet_end(s):
    """下一个静默结束时刻（用于营销顺延）。"""
    th = [int(x) for x in str(s.get('quiet_to', '08:00')).split(':')]
    now = datetime.now()
    end = now.replace(hour=th[0] % 24, minute=th[1] % 60, second=0, microsecond=0)
    if end <= now:
        end += timedelta(days=1)
    return end


def _is_marketing(body):
    return '退订' in body or bool(re.search(r'大促|优惠|领券|满减|秒杀|折扣', body or ''))


def _sim_norm(raw):
    digits = re.sub(r'\D', '', str(raw or ''))
    if digits.startswith('86') and len(digits) > 11:
        digits = digits[2:]
    return digits


# ---------------------------------------------------------------- channels
def _carrier_label(desc, carrier):
    m = re.search(r'name:([^,|]+)', str(desc or ''))
    name = (m.group(1).strip() if m else '') or ''
    return name or ('运营商 #' + str(carrier))


def _carrier_name_map(db):
    """gwid / gwgroup → 显示名（优先 type=8 且 gwid≥100 的 VOS 类网关）。"""
    names = {}
    try:
        for gwid, desc in db.execute(text(
            "SELECT gwid, description FROM dr_gateways WHERE type=8 AND gwid>=100"
        )).all():
            names[str(gwid)] = _carrier_label(desc, gwid)
            gm = re.search(r'gwgroup:(\d+)', str(desc or ''))
            if gm and gm.group(1) not in names:
                names[gm.group(1)] = _carrier_label(desc, gm.group(1))
    except Exception:
        pass
    return names


def _channels(db, pol=None, customer_id=_CID_UNSET):
    """短信通道 = 已注册 + SIM 就绪的 UFI（按 IMEI 关联台账与池 / 运营商）。"""
    extra, params = '', {}
    if customer_id is _CID_UNSET:
        extra, params = _scope_and('d')
    elif customer_id not in (None, '', 0, '0'):
        extra, params = ' AND d.customer_id=:__cid', {'__cid': int(customer_id)}
    rows = db.execute(text("""
        SELECT d.imei, d.sim_number, d.signal_level, d.network_type,
               COALESCE(p.pool_id, '—') AS pool_id, COALESCE(p.in_pool, 0) AS in_pool,
               COALESCE(NULLIF(p.carrier, ''), '') AS carrier,
               COALESCE(c.enabled, 1) AS enabled
        FROM dsip_ufi_device d
        LEFT JOIN dsip_ufi_pool p ON p.imei = d.imei
        LEFT JOIN dsip_ufi_sms_ch c ON c.imei = d.imei
        WHERE d.voip_status = '1'
          AND COALESCE(d.sim_state, '') NOT IN ('ABSENT', 'PIN_REQUIRED', 'PIN1_REQUIRED')
    """ + extra), params).mappings().all()

    day0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    hour0 = datetime.now().replace(minute=0, second=0, microsecond=0)
    per_hour = int((pol or _settings(db)).get('per_hour') or 40)
    names = _carrier_name_map(db)

    out = []
    for r in rows:
        cday = db.execute(text(
            "SELECT COUNT(*) c FROM dsip_ufi_sms_msg WHERE dir='out' AND imei=:i AND created>=:d0 AND state<>'failed'"),
            {'i': r['imei'], 'd0': day0}).scalar()
        chour = db.execute(text(
            "SELECT COUNT(*) c FROM dsip_ufi_sms_msg WHERE dir='out' AND imei=:i AND created>=:h0 AND state<>'failed'"),
            {'i': r['imei'], 'h0': hour0}).scalar()
        sent = db.execute(text(
            "SELECT COUNT(*) c FROM dsip_ufi_sms_msg WHERE dir='out' AND imei=:i AND state<>'failed'"),
            {'i': r['imei']}).scalar()
        last = db.execute(text(
            "SELECT MAX(created) m FROM dsip_ufi_sms_msg WHERE dir='out' AND imei=:i"),
            {'i': r['imei']}).scalar()
        chour = int(chour or 0)
        cday = int(cday or 0)
        if not r['enabled']:
            st = 'off'
        elif chour >= per_hour:
            st = 'cool'
        else:
            st = 'ok'
        carrier = str(r['carrier'] or '').strip()
        out.append({
            'imei': r['imei'], 'sim': _sim_norm(r['sim_number']),
            'pool': (r['pool_id'] if r['in_pool'] else '—'),
            'carrier': carrier,
            'carrier_name': names.get(carrier) or (('运营商 #' + carrier) if carrier else '未绑定运营商'),
            'signal': min(4, max(0, int(r['signal_level'] or 0))),
            'net': r['network_type'] or 'LTE',
            'sent': int(sent or 0), 'today': int(cday or 0), 'hour': chour,
            'cap': per_hour, 'enabled': bool(r['enabled']), 'state': st,
            'last': last.strftime('%H:%M:%S') if last else '—',
        })
    out.sort(key=lambda x: (x.get('carrier') or 'zzz', -x['sent']))
    return out


def _pick_channel(db, prefer_imei=None, pol=None, pool_id=None, customer_id=_CID_UNSET):
    """选路：wrr=时计数最少优先 / rr=累计计数最少 / lru=最久未发。全部硬上限受频控约束。
    pool_id 非空时仅从该号码池内选通道。
    返回 (channel_or_None, reason)：
      ok    — 已选中
      empty — 池内无已注册可用通道
      cool  — 有通道但均在间隔/时日上限冷却（应延后，勿记 503）
    """
    s = pol or _settings(db)
    chs = [c for c in _channels(db, pol, customer_id=customer_id) if c['state'] == 'ok']
    pool = str(pool_id or '').strip()
    if pool and pool != '—':
        chs = [c for c in chs if c.get('pool') == pool]
    if prefer_imei:
        chs = [c for c in chs if c['imei'] == prefer_imei] or chs
    if not chs:
        return None, 'empty'
    gap = int(s.get('gap_s') or 6)
    now = datetime.now()
    ok = []
    for c in chs:
        if c['hour'] >= int(s.get('per_hour') or 40):
            continue
        if c['today'] >= int(s.get('per_day') or 400):
            continue
        if c['last'] != '—':
            # c.last 是当天 HH:MM:SS；非当天发送的粗略视为已过间隔
            last_dt = None
            row = db.execute(text(
                "SELECT created FROM dsip_ufi_sms_msg WHERE dir='out' AND imei=:i ORDER BY id DESC LIMIT 1"),
                {'i': c['imei']}).scalar()
            if row:
                last_dt = row if isinstance(row, datetime) else None
            if last_dt and (now - last_dt).total_seconds() < gap:
                continue
        ok.append(c)
    if not ok:
        return None, 'cool'
    strat = s.get('strategy') or 'wrr'
    if strat == 'rr':
        ok.sort(key=lambda x: x['sent'])
    elif strat == 'lru':
        ok.sort(key=lambda x: x['last'])  # '—' 最小排最前，符合"最久未发"
    else:  # wrr
        ok.sort(key=lambda x: (x['hour'], x['sent']))
    return ok[0], 'ok'


# ---------------------------------------------------------------- SIP sender
def sip_send_message(imei, peer, body, timeout=8.0, from_user=None):
    """raw SIP MESSAGE -> Kamailio(127.0.0.1:5060) -> route[SMS_RELAY] -> UFI。
    返回 (code, reason)。200=UFI 已接收（通道确认）；0=无响应/超时。

    X-SMS / X-VOLTE 必须带完整对端号码（含 +国家码）；From 用通道 SIM，避免把 +E.164 塞进 SIP URI。
    """
    try:
        domain = _ufi_auth_domain()
    except Exception:
        domain = 'ufi.mineo.top'
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.settimeout(timeout)
    try:
        udp.bind(('0.0.0.0', 0))
        lport = udp.getsockname()[1]
    except Exception:
        lport = 5070
    branch = 'z9hG4bK' + ''.join(random.choice('0123456789abcdef') for _ in range(12))
    tag = ''.join(random.choice('0123456789abcdef') for _ in range(8))
    callid = '%012x@sms-gw' % random.getrandbits(48)
    body_b = (body or '').encode('utf-8')
    # From 仅数字/字母（SIM）；peer 可含 +，只放自定义头
    from_u = re.sub(r'[^\w]', '', str(from_user or imei or 'sms')) or 'sms'
    peer_hdr = str(peer or '').strip()
    pkt = (
        'MESSAGE sip:%s@%s SIP/2.0\r\n'
        'Via: SIP/2.0/UDP 127.0.0.1:%d;branch=%s;rport\r\n'
        'From: <sip:%s@%s>;tag=%s\r\n'
        'To: <sip:%s@%s>\r\n'
        'Call-ID: %s\r\n'
        'CSeq: 1 MESSAGE\r\n'
        'Max-Forwards: 70\r\n'
        'X-VOLTE: %s\r\n'
        'X-SMS: %s\r\n'
        'Content-Type: text/plain; charset=UTF-8\r\n'
        'Content-Length: %d\r\n'
        '\r\n%s'
    ) % (imei, domain, lport, branch, from_u, domain, tag, imei, domain, callid, peer_hdr, peer_hdr, len(body_b), body or '')
    try:
        udp.sendto(pkt.encode('utf-8'), ('127.0.0.1', 10560))
        data, _addr = udp.recvfrom(4096)
        line = data.decode('utf-8', 'ignore').splitlines()[0]
        parts = line.split(' ', 2)
        code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        reason = parts[2] if len(parts) > 2 else ''
        return code, reason
    except socket.timeout:
        return 0, 'timeout'
    except Exception as ex:
        return 0, str(ex)[:60]
    finally:
        udp.close()


# ---------------------------------------------------------------- campaign rcpts / template render
_PHONE_KEYS = ('phone', 'num', 'peer', 'mobile', '号码', '手机号', '手机', '收件人')
_CN_MOBILE_RE = re.compile(r'^1\d{10}$')
_SMS_ADDR_RE = re.compile(r'^[0-9A-Za-z+*#.\-]{2,64}$')


def norm_sms_addr(v):
    """规范化短信地址：E.164(+国际号) / 大陆手机号 / 短号 / 字母数字短码。

    - 带 ``+``：一律保留 ``+digits``（含 +86，不剥国家码，跨国短信 / X-SMS 需要）
    - ``00…``：转成 ``+…``
    - ``861…`` / ``0861…``（无加号的中国国际格式）：升为 ``+861…``，不再剥成 11 位
    - 纯 11 位 ``1…``：保持本地号（国内发国内）
    """
    s = str(v or '').strip()
    if not s:
        return ''
    s = re.sub(r'[\s\-().]', '', s)
    if s.startswith('00') and len(s) > 2 and s[2:].isdigit():
        s = '+' + s[2:]

    # E.164: keep +digits including +86 (country code required for intl SMS / X-SMS)
    if s.startswith('+'):
        digits = re.sub(r'\D', '', s[1:])
        if not digits or len(digits) < 2 or len(digits) > 15:
            return ''
        return ('+' + digits)[:64]

    # Alphanumeric / service shortcodes (* # letters)
    if re.search(r'[A-Za-z*#]', s):
        return s[:64] if _SMS_ADDR_RE.match(s) else ''

    digits = re.sub(r'\D', '', s)
    # 无 + 的中国国际号 → 升为 E.164，避免跨国 X-SMS 丢国家码
    if digits.startswith('086') and len(digits) == 14 and digits[3:].startswith('1'):
        return ('+86' + digits[3:])[:64]
    if digits.startswith('86') and len(digits) == 13 and digits[2:].startswith('1'):
        return ('+86' + digits[2:])[:64]
    return digits[:64] if digits else ''


def is_cn_mobile(v):
    a = norm_sms_addr(v)
    if not a:
        return False
    if a.startswith('+'):
        d = a[1:]
        return d.startswith('86') and len(d) == 13 and bool(_CN_MOBILE_RE.match(d[2:]))
    return bool(_CN_MOBILE_RE.match(a))


def _cn_addr_variants(num):
    """大陆号黑名单比对：+861… 与 11 位本地号互认。"""
    a = norm_sms_addr(num)
    if not a:
        return set()
    out = {a}
    if a.startswith('+86') and len(a) == 14 and _CN_MOBILE_RE.match(a[3:]):
        out.add(a[3:])
    elif _CN_MOBILE_RE.match(a):
        out.add('+86' + a)
    return out


def is_valid_sms_addr(v):
    a = norm_sms_addr(v)
    if not a:
        return False
    if a.startswith('+'):
        return bool(re.fullmatch(r'\+[0-9]{2,15}', a))
    return bool(_SMS_ADDR_RE.match(a))


def _tokenize_sms_addrs(text):
    """从自由文本拆出短信地址：优先整段 token / E.164，禁止从 +1… 中抠大陆 11 位。"""
    s = str(text or '').strip()
    if not s:
        return []
    out = []
    # 先抓显式 E.164，再按分隔符拆
    for m in re.finditer(r'\+[1-9]\d{6,14}', s):
        a = norm_sms_addr(m.group(0))
        if a:
            out.append(a)
    for part in re.split(r'[\s,;|/\n\r]+', s):
        part = part.strip()
        if not part or part.startswith('+'):
            continue
        a = norm_sms_addr(part)
        if a:
            out.append(a)
    # 无分隔粘连正文：仅匹配「非 + 前缀」的大陆 11 位
    if not out:
        for m in re.finditer(r'(?<![0-9+])(1\d{10})(?!\d)', s):
            a = norm_sms_addr(m.group(1))
            if a:
                out.append(a)
    return out


def _rcpt_phone(item):
    """从收件人项提取地址：走 norm_sms_addr，保留 +E.164。"""
    if isinstance(item, str):
        a = norm_sms_addr(item)
        if a:
            return a
        toks = _tokenize_sms_addrs(item)
        return toks[0] if toks else ''
    if isinstance(item, dict):
        for k in _PHONE_KEYS:
            v = item.get(k)
            if v is None:
                continue
            a = norm_sms_addr(v)
            if a:
                return a
        for v in item.values():
            a = norm_sms_addr(v)
            if a:
                return a
    return ''


def _render_body(body, item):
    """将正文中的 {变量} 按收件人参数替换；未知占位保留原样。"""
    if not body or not isinstance(item, dict):
        return body or ''
    vars_map = {}
    for k, v in item.items():
        if str(k).lower() in _PHONE_KEYS or k in ('号码', '手机号', '手机', '收件人'):
            continue
        vars_map[str(k)] = '' if v is None else str(v)

    def _repl(m):
        key = (m.group(1) or '').strip()
        if key in vars_map:
            return vars_map[key]
        # 兼容无花括号的别名（如 变量名 / var）
        return m.group(0)

    return re.sub(r'\{([^{}]+)\}', _repl, body)


def _parse_task_rcpts(raw):
    """解析群发收件人：支持纯号码串、JSON 字符串数组、[{phone, 变量...}]。"""
    src = []
    if isinstance(raw, list):
        src = raw
    elif isinstance(raw, dict):
        src = [raw]
    elif raw is None:
        src = []
    else:
        s = str(raw).strip()
        if not s:
            src = []
        elif s[0] in '[{':
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    src = parsed
                elif isinstance(parsed, dict):
                    src = [parsed]
                else:
                    src = []
            except Exception:
                src = _tokenize_sms_addrs(s) or [x for x in re.split(r'[\s,;|/]+', s) if x]
        else:
            src = _tokenize_sms_addrs(s) or [x for x in re.split(r'[\s,;|/]+', s) if x]

    out, seen = [], set()
    for it in src:
        if isinstance(it, dict):
            phone = _rcpt_phone(it)
            if not phone or not is_valid_sms_addr(phone) or phone in seen:
                continue
            seen.add(phone)
            row = dict(it)
            row['phone'] = phone
            out.append(row)
        else:
            phone = _rcpt_phone(str(it))
            if not phone or not is_valid_sms_addr(phone) or phone in seen:
                continue
            seen.add(phone)
            out.append({'phone': phone})
    return out


# ---------------------------------------------------------------- core send
def _do_send(db, peer, body, prefer_imei=None, task_id=0, pol=None, pool_id=None, customer_id=_CID_UNSET):
    """单条真实发送：选通道 -> 落库 sending -> SIP MESSAGE -> 回写状态。返回消息 dict。
    若通道仅因间隔/频控冷却不可用，返回 state='sending' 且无库记录，供群发 worker 延后重试。"""
    cid = _stamp_cid() if customer_id is _CID_UNSET else customer_id
    ch, pick_why = _pick_channel(db, prefer_imei, pol, pool_id=pool_id, customer_id=cid)
    now = datetime.now()
    if not ch and pick_why == 'cool':
        # 池内有通道，只是冷却中 — 不落失败单，交给 worker 下一 tick 再试
        return {
            'id': 0, 'dir': 'out', 'imei': '', 'sim': '', 'peer': peer, 'body': body,
            'state': 'sending', 'err': '通道冷却中', 'task_id': task_id or 0,
            'created': now.strftime('%Y-%m-%d %H:%M:%S'),
        }
    if ch:
        cur = db.execute(text(
            "INSERT INTO dsip_ufi_sms_msg (dir,imei,sim,peer,body,state,err,task_id,customer_id,created) "
            "VALUES ('out',:imei,:sim,:peer,:body,'sending','',:tid,:cid,:now)"),
            {'imei': ch['imei'], 'sim': ch['sim'], 'peer': peer, 'body': body,
             'tid': task_id, 'cid': cid, 'now': now})
        db.commit()
        msg_id = cur.lastrowid
        code, reason = sip_send_message(ch['imei'], peer, body, from_user=ch.get('sim') or ch['imei'])
        if code == 200:
            state, err = 'delivered', ''
        else:
            state = 'failed'
            err = ('%s %s' % (code or 408, reason or '无响应')).strip()
        db.execute(text("UPDATE dsip_ufi_sms_msg SET state=:st, err=:err WHERE id=:id"),
                   {'st': state, 'err': err, 'id': msg_id})
        db.commit()
    else:
        no_ch = '503 号码池无可用通道' if pool_id else '503 无可用短信通道'
        cur = db.execute(text(
            "INSERT INTO dsip_ufi_sms_msg (dir,imei,sim,peer,body,state,err,task_id,customer_id,created) "
            "VALUES ('out','','',:peer,:body,'failed',:err,:tid,:cid,:now)"),
            {'peer': peer, 'body': body, 'err': no_ch, 'tid': task_id, 'cid': cid, 'now': now})
        db.commit()
        msg_id = cur.lastrowid
        state, err = 'failed', no_ch
    m = db.execute(text("SELECT * FROM dsip_ufi_sms_msg WHERE id=:id"), {'id': msg_id}).mappings().first()
    d = dict(m)
    d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
    if d.get('state') in ('delivered', 'failed'):
        try:
            from modules.api.ufi_sms_gateway import enqueue_report_push
            enqueue_report_push(msg_id)
        except Exception:
            pass
    return d


# ---------------------------------------------------------------- worker thread
_worker_started = False
_worker_lock = threading.Lock()
WEEKDAY = {'一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6}


def _ensure_worker():
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        threading.Thread(target=_sms_worker, daemon=True, name='ufi-sms-worker').start()
        _worker_started = True


def _sms_worker():
    time.sleep(5)
    while True:
        try:
            _worker_tick()
        except Exception:
            try:
                from shared import debugException
                debugException(None)
            except Exception:
                pass
        time.sleep(2)


def _sched_due(s, now):
    """定时任务是否到点（且当前窗口未执行过）。"""
    if not s['enabled']:
        return False
    run = str(s['run'] or '').strip()
    if s['kind'] == 'once':
        for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M', '%Y-%m-%d %H:%M:%S'):
            try:
                due = datetime.strptime(run, fmt)
                return now >= due and not s['last_run']
            except ValueError:
                continue
        return False
    m = re.match(r'^周([一二三四五六日天])\s*(\d{1,2}):(\d{2})$', run)
    if s['kind'] == 'weekly':
        if not m:
            return False
        wd, hh, mm = WEEKDAY.get(m.group(1), 0), int(m.group(2)), int(m.group(3))
        if now.weekday() != wd:
            return False
        due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    else:  # daily
        m = re.match(r'^(\d{1,2}):(\d{2})$', run)
        if not m:
            return False
        due = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
    if now < due:
        return False
    lr = s['last_run']
    return not lr or lr.date() < now.date()


def _worker_tick():
    db = startSession()
    try:
        _ensure_sms_tables(db)
        now = datetime.now()
        # 1) scheduled -> running
        db.execute(text("UPDATE dsip_ufi_sms_task SET state='running' WHERE state='scheduled' "
                        "AND start_at IS NOT NULL AND start_at<=:now"), {'now': now})
        # 2) running tasks: 匀速出队
        tasks = db.execute(text("SELECT * FROM dsip_ufi_sms_task WHERE state='running'")).mappings().all()
        for t in tasks:
            pol = _policy(db, t.get('policy_id')) if t.get('policy_id') else None
            rcpts = _parse_task_rcpts(t.get('rcpts'))
            sent, fail = int(t['sent'] or 0), int(t['fail'] or 0)
            budget = min(int(t['total'] or 0), sent + max(1, int((t['rate'] or 20) / 30)))
            while sent < budget and sent < len(rcpts):
                peer = _rcpt_phone(rcpts[sent])
                body = _render_body(t['body'], rcpts[sent])
                msg = _do_send(db, peer, body, task_id=t['id'], pol=pol, pool_id=t.get('pool_id'),
                               customer_id=t.get('customer_id'))
                sent += 1
                if msg['state'] == 'failed':
                    fail += 1
                elif msg['state'] == 'sending':
                    sent -= 1  # 通道冷却中，本 tick 不推进
                    break
            state = t['state']
            note = t['note']
            if sent >= (int(t['total'] or 0) or len(rcpts)):
                state = 'done'
                note = '批次发完 · %d 条失败' % fail
            db.execute(text("UPDATE dsip_ufi_sms_task SET sent=:s, fail=:f, state=:st, note=:n WHERE id=:id"),
                       {'s': sent, 'f': fail, 'st': state, 'n': note, 'id': t['id']})
            db.commit()
        # 3) 周期/定时计划到点 -> 生成群发批次
        scheds = db.execute(text("SELECT * FROM dsip_ufi_sms_sched")).mappings().all()
        for s in scheds:
            if not _sched_due(s, now):
                continue
            rcpts = _parse_task_rcpts(s.get('targets'))
            rate = max(1, int(s.get('rate') or 20))
            ph = max(1, int(s.get('per_hour') or 40))
            pid = int(s.get('policy_id') or 0)
            pool = str(s.get('pool_id') or '')
            if rcpts:
                db.execute(text(
                    "INSERT INTO dsip_ufi_sms_task "
                    "(name,tpl_id,body,rcpts,rate,per_hour,policy_id,pool_id,total,state,note,customer_id,created) "
                    "VALUES (:n,:tpl,:b,:r,:rate,:ph,:pid,:pool,:t,'running',:note,:cid,:now)"),
                    {'n': s['name'] + '（定时）', 'tpl': str(s.get('tpl_id') or ''),
                     'b': s['body'], 'r': json.dumps(rcpts, ensure_ascii=False),
                     'rate': rate, 'ph': ph, 'pid': pid, 'pool': pool, 't': len(rcpts),
                     'note': '由计划 #%d 生成 · 池 %s' % (s['id'], pool or '全部'),
                     'cid': s.get('customer_id'), 'now': now})
            s['enabled'] = 0 if s['kind'] == 'once' else s['enabled']
            last = '今日 %s · 已执行（%d 号码）' % (now.strftime('%H:%M'), len(rcpts)) if rcpts else \
                '今日 %s · 无有效号码' % now.strftime('%H:%M')
            db.execute(text("UPDATE dsip_ufi_sms_sched SET last=:l, last_run=:now, enabled=:e WHERE id=:id"),
                       {'l': last, 'now': now, 'e': int(s['enabled']), 'id': s['id']})
            db.commit()
        # 4) 运营商回调：上行 MO + 状态报告
        try:
            from modules.api.ufi_sms_gateway import push_pending
            push_pending(db)
        except Exception:
            pass
    finally:
        db.close()


# ---------------------------------------------------------------- API: overview
@api.route(SMS_BASE + '/overview', methods=['GET'])
@api_security
def sms_overview():
    """总览：设置 + 健康 + 通道 + 计数（pills/KPI 单请求数据源）。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_sms_tables(db)
        s = _settings(db)
        chs = _channels(db)
        day0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        frag, fp = _scope_and()
        sent_today = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_msg WHERE dir='out' AND created>=:d0 AND state<>'failed'" + frag),
            dict(fp, d0=day0)).scalar()
        recv_today = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_msg WHERE dir='in' AND created>=:d0" + frag), dict(fp, d0=day0)).scalar()
        outN = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_msg WHERE dir='out' AND created>=:d0" + frag), dict(fp, d0=day0)).scalar() or 1
        failN = db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_sms_msg WHERE dir='out' AND created>=:d0 AND state='failed'" + frag),
            dict(fp, d0=day0)).scalar()
        counts = {}
        for k, tbl in (('records', 'dsip_ufi_sms_msg'),
                       ('tasks', 'dsip_ufi_sms_task'),
                       ('scheds', 'dsip_ufi_sms_sched'),
                       ('tpl', 'dsip_ufi_sms_tpl'),
                       ('black', 'dsip_ufi_sms_black'),
                       ('words', 'dsip_ufi_sms_word')):
            counts[k] = int(db.execute(text("SELECT COUNT(*) FROM " + tbl + " WHERE 1=1" + frag), fp).scalar() or 0)
        health = {
            'chAll': len(chs), 'chOk': len([c for c in chs if c['state'] == 'ok']),
            'chCool': len([c for c in chs if c['state'] == 'cool']),
            'chOff': len([c for c in chs if c['state'] == 'off']),
            'sentToday': int(sent_today or 0), 'recvToday': int(recv_today or 0),
            'failRate': round(int(failN or 0) / max(1, outN) * 100),
            'running': int(db.execute(text(
                "SELECT COUNT(*) FROM dsip_ufi_sms_task WHERE state='running'" + frag), fp).scalar() or 0),
            'scheduled': int(db.execute(text(
                "SELECT COUNT(*) FROM dsip_ufi_sms_task WHERE state='scheduled'" + frag), fp).scalar() or 0),
            'queued': int(db.execute(text(
                "SELECT COALESCE(SUM(total-sent),0) FROM dsip_ufi_sms_task WHERE state IN ('running','scheduled')" + frag), fp).scalar() or 0),
            'schedOn': int(db.execute(text(
                "SELECT COUNT(*) FROM dsip_ufi_sms_sched WHERE enabled=1" + frag), fp).scalar() or 0),
        }
        carriers = []
        try:
            from modules.api.ufi_sms_gateway import list_carriers
            carriers = list_carriers(db, chs)
        except Exception:
            carriers = []
        db.commit()
        return createApiResponse(msg='sms overview', data=[{
            'settings': {k: v for k, v in s.items() if k != 'updated_at'},
            'policies': _policies(db),
            'quiet_now': _quiet_now(s), 'health': health, 'channels': chs,
            'carriers': carriers, 'counts': counts,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: send / check
@api.route(SMS_BASE + '/send', methods=['POST'])
@api_security
def sms_send():
    """单发（真实 SIP MESSAGE）。服务端复核敏感词/黑名单/静默。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        d = getRequestData()
        peer = norm_sms_addr(d.get('peer') or '')
        body = str(d.get('body') or '').strip()
        prefer = str(d.get('imei') or '') or None
        if not is_valid_sms_addr(peer):
            return createApiResponse(status_code=400, msg='号码无效（支持手机号、短号如 10086、字母数字短码）')
        if not body:
            return createApiResponse(status_code=400, msg='内容为空')
        hits = [w for w in _words_of(db) if w in body]
        if hits:
            return createApiResponse(status_code=400, msg='命中敏感词：' + '、'.join(hits))
        if is_cn_mobile(peer) and _black_hit(db, peer):
            return createApiResponse(status_code=400, msg='黑名单号码，拒绝发送')
        pol = _policy(db, d.get('policy_id'))
        s = pol or _settings(db)
        if is_cn_mobile(peer) and _quiet_now(s) and _is_marketing(body):
            return createApiResponse(status_code=400, msg='夜间静默期（%s→次日%s），营销类内容请改用群发定时' %
                                     (s.get('quiet_from'), s.get('quiet_to')))
        msg = _do_send(db, peer, body, prefer, pol=pol)
        db.commit()
        return createApiResponse(msg='发送完成', data=[msg])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/check', methods=['POST'])
@api_security
def sms_check():
    """内容校验（敏感词/黑名单号码/静默态），供发送页即时提示。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        d = getRequestData()
        body = str(d.get('body') or '')
        nums = []
        for n in _tokenize_sms_addrs(str(d.get('nums') or '')):
            if n not in nums:
                nums.append(n)
        hits = [w for w in _words_of(db) if w in body]
        black = []
        for n in nums:
            if is_cn_mobile(n) and _black_hit(db, n):
                black.append(n)
        s = _policy(db, d.get('policy_id')) or _settings(db)
        db.commit()
        return createApiResponse(msg='check done', data=[{
            'hits': hits, 'black': black, 'quiet': _quiet_now(s),
            'quiet_from': s.get('quiet_from'), 'quiet_to': s.get('quiet_to'),
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _device_geo_map(db, imeis):
    """imei → {sim, cellular_network, sim_cc, sim_country}."""
    out = {}
    safe = ','.join("'%s'" % i for i in imeis if re.fullmatch(r'[0-9]{10,20}', i or ''))
    if not safe:
        return out
    rows = db.execute(text(
        "SELECT imei, sim_number, cellular_network FROM dsip_ufi_device WHERE imei IN (%s)" % safe
    )).mappings().all()
    for r in rows:
        sim_g = enrich_sim(r.get('cellular_network') or '')
        out[r['imei']] = {
            'sim': _sim_norm(r.get('sim_number') or ''),
            'cellular_network': r.get('cellular_network') or '',
            'sim_cc': sim_g['sim_cc'],
            'sim_country': sim_g['sim_country'],
        }
    return out


def _fmt_msg_row(r, devmap):
    d = dict(r)
    d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
    imei = d.get('imei') or ''
    info = devmap.get(imei) or {}
    if d.get('dir') == 'in' and not d.get('sim'):
        d['sim'] = info.get('sim', '')
    d.update(enrich_peer(d.get('peer') or ''))
    if info:
        d['sim_cc'] = info.get('sim_cc', '')
        d['sim_country'] = info.get('sim_country', '')
        d['cellular_network'] = info.get('cellular_network', '')
    else:
        d.setdefault('sim_cc', '')
        d.setdefault('sim_country', '')
    return d


# ---------------------------------------------------------------- API: records
@api.route(SMS_BASE + '/records', methods=['GET'])
@api_security
def sms_records():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        dirn = request.args.get('dir', '')
        q = request.args.get('q', '').strip()
        task_q = request.args.get('task', '').strip()
        country = (request.args.get('country') or '').strip().upper()
        page = max(1, int(request.args.get('page', 1) or 1))
        size = min(100, max(5, int(request.args.get('size', 15) or 15)))
        where, params = [], {}
        if dirn in ('in', 'out'):
            where.append("m.dir=:dir")
            params['dir'] = dirn
        if q:
            where.append("(m.peer LIKE :q OR m.sim LIKE :q OR m.body LIKE :q OR m.imei LIKE :q)")
            params['q'] = '%' + q + '%'
        if task_q:
            where.append("t.name LIKE :tn")
            params['tn'] = '%' + task_q + '%'
        if country and country in _PEER_CC_SQL:
            where.append(_PEER_CC_SQL[country])
        from modules.api.acl import apply_customer_filter, ensure_acl_tables
        ensure_acl_tables(db)
        apply_customer_filter(where, params, 'm.customer_id')
        _apply_date_range(where, params, 'm.created')
        wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
        base = (" FROM dsip_ufi_sms_msg m "
                "LEFT JOIN dsip_ufi_sms_task t ON t.id=m.task_id")
        total = int(db.execute(text("SELECT COUNT(*)" + base + wsql), params).scalar() or 0)
        pages = max(1, (total + size - 1) // size)
        page = min(page, pages)
        rows = db.execute(text(
            "SELECT m.*, COALESCE(t.name, '') AS task_name" + base + wsql +
            " ORDER BY m.id DESC LIMIT :o,:s"),
            dict(params, o=(page - 1) * size, s=size)).mappings().all()
        imeis = {r.get('imei') for r in rows if r.get('imei')}
        devmap = _device_geo_map(db, imeis)
        out = [_fmt_msg_row(r, devmap) for r in rows]
        # tighten country filter with precise dial_to_country when SQL is approximate
        if country:
            out = [d for d in out if (d.get('peer_cc') or '') == country]
        db.commit()
        return createApiResponse(msg='records', data=[{'list': out, 'total': total, 'page': page, 'pages': pages}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/records/thread', methods=['GET'])
@api_security
def sms_records_thread():
    """按对端号码拉取完整会话（主叫/被叫往返），时间正序。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        peer = norm_sms_addr(request.args.get('peer') or '')
        if not is_valid_sms_addr(peer):
            return createApiResponse(status_code=400, msg='号码无效（支持手机号、短号、字母数字短码）')
        limit = min(500, max(20, int(request.args.get('limit', 200) or 200)))
        frag, params = _scope_and()
        rows = db.execute(text(
            "SELECT * FROM dsip_ufi_sms_msg WHERE peer=:p" + frag + " ORDER BY created ASC, id ASC LIMIT :lim"),
            dict(params, p=peer, lim=limit)).mappings().all()
        imeis = {r.get('imei') for r in rows if r.get('imei')}
        devmap = _device_geo_map(db, imeis)
        out = [_fmt_msg_row(r, devmap) for r in rows]
        db.commit()
        return createApiResponse(msg='thread', data=[{'peer': peer, 'list': out, 'total': len(out)}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: tasks
@api.route(SMS_BASE + '/tasks', methods=['GET', 'POST'])
@api_security
def sms_tasks():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        _ensure_worker()
        if request.method == 'GET':
            where, params = [], {}
            _apply_date_range(where, params, 'created')
            _scope_bind(where, params, 'customer_id')
            wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
            rows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_task" + wsql + " ORDER BY id DESC LIMIT 500"), params).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                for k in ('created', 'start_at'):
                    d[k] = d[k].strftime('%Y-%m-%d %H:%M') if d.get(k) else ''
                d['rcpts_n'] = len(_parse_task_rcpts(d.get('rcpts')))
                d['row_type'] = 'batch'
                out.append(d)
            # 周期计划并入同一列表
            sw, sp = [], {}
            _apply_date_range(sw, sp, 'created')
            _scope_bind(sw, sp, 'customer_id')
            swsql = (' WHERE ' + ' AND '.join(sw)) if sw else ''
            srows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_sched" + swsql + " ORDER BY id DESC"), sp).mappings().all()
            for s in srows:
                rcpts_n = len(_parse_task_rcpts(s.get('targets')))
                out.append({
                    'row_type': 'recur',
                    'id': s['id'],
                    'name': s['name'],
                    'tpl_id': s.get('tpl_id') or '',
                    'body': s['body'],
                    'kind': s['kind'],
                    'run': s['run'],
                    'rate': int(s.get('rate') or 20),
                    'per_hour': int(s.get('per_hour') or 40),
                    'policy_id': int(s.get('policy_id') or 0),
                    'pool_id': str(s.get('pool_id') or ''),
                    'total': rcpts_n,
                    'rcpts_n': rcpts_n,
                    'sent': 0,
                    'fail': 0,
                    'state': 'recur_on' if s.get('enabled') else 'recur_off',
                    'note': s.get('last') or '',
                    'last': s.get('last') or '',
                    'last_run': s['last_run'].strftime('%Y-%m-%d %H:%M') if s.get('last_run') else '',
                    'created': s['created'].strftime('%Y-%m-%d %H:%M') if s.get('created') else '',
                    'start_at': '',
                    'enabled': int(s.get('enabled') or 0),
                })
            out.sort(key=lambda x: x.get('created') or '', reverse=True)
            db.commit()
            return createApiResponse(msg='tasks', data=out)
        d = getRequestData()
        body = str(d.get('body') or '').strip()
        rcpts = _parse_task_rcpts(d.get('rcpts'))
        name = str(d.get('name') or '').strip() or ('自定义内容 · %s' % datetime.now().strftime('%m-%d %H:%M'))
        pol = _policy(db, d.get('policy_id'))
        rate = max(1, int(d.get('rate') or (pol or {}).get('rate') or 20))
        if not body:
            return createApiResponse(status_code=400, msg='缺少短信内容')
        hits = [w for w in _words_of(db) if w in body]
        if hits:
            return createApiResponse(status_code=400, msg='命中敏感词：' + '、'.join(hits))
        if not rcpts:
            return createApiResponse(status_code=400, msg='收件人为空')
        bset = _black_nums(db)
        before = len(rcpts)
        rcpts = [r for r in rcpts if r.get('phone') not in bset]
        if not rcpts:
            return createApiResponse(status_code=400, msg='收件人全部命中黑名单')
        s = _settings(db)
        qs = pol or s
        when = str(d.get('when') or 'now').strip()
        run = str(d.get('run') or '').strip()
        ph = max(1, int(d.get('per_hour') or (pol or {}).get('per_hour') or s.get('per_hour') or 40))
        pid = int(pol['id']) if pol else 0
        tpl = str(d.get('tpl_id') or '')
        pool = str(d.get('pool_id') or '').strip()
        if pool in ('—', '-', 'all', '*'):
            pool = ''
        if not pool:
            return createApiResponse(status_code=400, msg='请选择发送号码池')
        # 校验池内是否有在池通道（允许创建时暂无可用，执行时再选路）
        pool_chs = [c for c in _channels(db, pol) if c.get('pool') == pool]
        if not pool_chs:
            return createApiResponse(status_code=400, msg='号码池「%s」下没有通道，请到呼叫中心把 UFI 入池' % pool)

        # 每日 / 每周 → 写入周期计划（原定时任务）
        if when in ('daily', 'weekly'):
            if when == 'daily' and not re.match(r'^\d{1,2}:\d{2}$', run):
                return createApiResponse(status_code=400, msg='每日执行时间格式应为 HH:MM，如 09:00')
            if when == 'weekly' and not re.match(r'^周[一二三四五六日天]\s*\d{1,2}:\d{2}$', run):
                return createApiResponse(status_code=400, msg='每周执行时间格式应为 周一 09:00')
            note = ('池[%s] · ' % pool) + ('策略[' + str(pol['name']) + '] · ' if pol else '') + ('周期计划 · %d 条/分' % rate)
            db.execute(text(
                "INSERT INTO dsip_ufi_sms_sched "
                "(name,kind,run,targets,body,enabled,last,note,tpl_id,rate,per_hour,policy_id,pool_id,customer_id,created) "
                "VALUES (:n,:k,:r,:tg,:b,1,'未执行',:note,:tpl,:rate,:ph,:pid,:pool,:cid,:now)"),
                {'n': name, 'k': when, 'r': run, 'tg': json.dumps(rcpts, ensure_ascii=False),
                 'b': body, 'note': note, 'tpl': tpl, 'rate': rate, 'ph': ph, 'pid': pid,
                 'pool': pool, 'cid': _stamp_cid(), 'now': datetime.now()})
            db.commit()
            sid = db.execute(text("SELECT MAX(id) FROM dsip_ufi_sms_sched")).scalar()
            return createApiResponse(msg='周期任务已创建', data=[{
                'id': sid, 'total': len(rcpts), 'state': 'recur_on', 'row_type': 'recur',
                'kind': when, 'run': run, 'pool_id': pool, 'note': note,
                'black_dropped': before - len(rcpts)}])

        start_at = None
        state = 'running'
        note = ('池[%s] · ' % pool) + ('策略[' + str(pol['name']) + '] · ' if pol else '') + ('频控：%d 条/分' % rate)
        quiet = _quiet_now(qs) and _is_marketing(body)
        if when in ('sched', 'at', 'once') and d.get('start_at'):
            start_at = datetime.strptime(str(d['start_at'])[:16], '%Y-%m-%d %H:%M')
            state = 'scheduled'
            note = (note + ' · 定时 %s' % start_at.strftime('%m-%d %H:%M'))
        elif quiet:
            start_at = _quiet_end(qs)
            state = 'scheduled'
            note = '命中夜间静默，顺延至 %s' % start_at.strftime('%H:%M')
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_task "
            "(name,tpl_id,body,rcpts,rate,per_hour,policy_id,pool_id,total,state,note,start_at,customer_id,created) "
            "VALUES (:n,:tpl,:b,:r,:rate,:ph,:pid,:pool,:t,:st,:note,:sa,:cid,:now)"),
            {'n': name, 'tpl': tpl, 'b': body, 'r': json.dumps(rcpts, ensure_ascii=False),
             'rate': rate, 'ph': ph, 'pid': pid, 'pool': pool,
             't': len(rcpts), 'st': state, 'note': note, 'sa': start_at,
             'cid': _stamp_cid(), 'now': datetime.now()})
        db.commit()
        tid = db.execute(text("SELECT MAX(id) FROM dsip_ufi_sms_task")).scalar()
        return createApiResponse(msg='任务已创建', data=[{'id': tid, 'total': len(rcpts), 'state': state,
                                                        'row_type': 'batch', 'pool_id': pool, 'note': note,
                                                        'black_dropped': before - len(rcpts)}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/tasks/<int:tid>', methods=['POST'])
@api_security
def sms_task_act(tid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        _ensure_worker()
        d = getRequestData()
        act = str(d.get('action') or '')
        row = db.execute(text("SELECT * FROM dsip_ufi_sms_task WHERE id=:id"), {'id': tid}).mappings().first()
        if not row or not _row_owned(row):
            return createApiResponse(status_code=404, msg='任务不存在')
        if act == 'start':
            db.execute(text("UPDATE dsip_ufi_sms_task SET state='running', start_at=NULL WHERE id=:id"), {'id': tid})
        elif act == 'pause':
            db.execute(text("UPDATE dsip_ufi_sms_task SET state='paused', note=CONCAT('手工暂停 · 已发送 ', sent, ' 条') WHERE id=:id"), {'id': tid})
        elif act == 'del':
            db.execute(text("DELETE FROM dsip_ufi_sms_task WHERE id=:id"), {'id': tid})
        db.commit()
        return createApiResponse(msg='任务已' + {'start': '开始', 'pause': '暂停', 'del': '删除'}.get(act, act))
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/tasks/<int:tid>/items', methods=['GET'])
@api_security
def sms_task_items(tid):
    """群发执行明细：已出队的每条短信，以及尚未发送的收件人。"""
    db = DummySession()
    try:
        db = startSession()
        _ensure_sms_tables(db)
        kind = (request.args.get('kind') or 'batch').strip()
        if kind == 'recur':
            sched = db.execute(text("SELECT * FROM dsip_ufi_sms_sched WHERE id=:id"), {'id': tid}).mappings().first()
            if not sched or not _row_owned(sched):
                return createApiResponse(status_code=404, msg='计划不存在')
            tasks = db.execute(text(
                "SELECT id, name, state, sent, fail, total, created FROM dsip_ufi_sms_task "
                "WHERE note LIKE :n ORDER BY id DESC LIMIT 30"
            ), {'n': '由计划 #%d 生成%%' % tid}).mappings().all()
            ids = [int(t['id']) for t in tasks]
            rows = []
            if ids:
                ph = ','.join(str(i) for i in ids)
                rows = db.execute(text(
                    "SELECT m.id, m.peer, m.sim, m.imei, m.state, m.err, m.created, m.task_id, t.name AS task_name "
                    "FROM dsip_ufi_sms_msg m LEFT JOIN dsip_ufi_sms_task t ON t.id=m.task_id "
                    "WHERE m.task_id IN (%s) ORDER BY m.id DESC LIMIT 500" % ph
                )).mappings().all()
            head = {'id': tid, 'name': sched['name'], 'kind': 'recur',
                    'state': 'recur_on' if sched.get('enabled') else 'recur_off',
                    'batches': [{
                        'id': t['id'], 'name': t['name'], 'state': t['state'],
                        'sent': int(t['sent'] or 0), 'fail': int(t['fail'] or 0),
                        'total': int(t['total'] or 0),
                        'created': t['created'].strftime('%Y-%m-%d %H:%M:%S') if t.get('created') else '',
                    } for t in tasks]}
        else:
            task = db.execute(text("SELECT * FROM dsip_ufi_sms_task WHERE id=:id"), {'id': tid}).mappings().first()
            if not task or not _row_owned(task):
                return createApiResponse(status_code=404, msg='任务不存在')
            rows = db.execute(text(
                "SELECT id, peer, sim, imei, state, err, created, task_id FROM dsip_ufi_sms_msg "
                "WHERE task_id=:id ORDER BY id ASC LIMIT 1000"
            ), {'id': tid}).mappings().all()
            rcpts = _parse_task_rcpts(task.get('rcpts'))
            done = int(task.get('sent') or 0)
            pending = [_rcpt_phone(r) for r in rcpts[done:]]
            head = {
                'id': tid, 'name': task['name'], 'kind': 'batch', 'state': task['state'],
                'sent': int(task.get('sent') or 0), 'fail': int(task.get('fail') or 0),
                'total': int(task.get('total') or 0), 'pool_id': task.get('pool_id') or '',
                'pending': pending[:200],
            }
        items = []
        for r in rows:
            d = dict(r)
            d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
            d['task_name'] = d.get('task_name') or head.get('name') or ''
            items.append(d)
        return createApiResponse(msg='task items', data=[{'task': head, 'items': items}])
    except Exception as ex:
        db.rollback()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: scheds
@api.route(SMS_BASE + '/scheds', methods=['GET', 'POST'])
@api_security
def sms_scheds():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        _ensure_worker()
        if request.method == 'GET':
            where, params = [], {}
            _apply_date_range(where, params, 'created')
            _scope_bind(where, params, 'customer_id')
            wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
            rows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_sched" + wsql + " ORDER BY id DESC"), params).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['last_run'] = d['last_run'].strftime('%m-%d %H:%M') if d.get('last_run') else ''
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M') if d.get('created') else ''
                out.append(d)
            db.commit()
            return createApiResponse(msg='scheds', data=out)
        d = getRequestData()
        name = str(d.get('name') or '').strip()
        run = str(d.get('run') or '').strip()
        body = str(d.get('body') or '').strip()
        kind = str(d.get('kind') or 'daily')
        if not name or not run or not body:
            return createApiResponse(status_code=400, msg='名称 / 执行时间 / 内容均必填')
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_sched (name,kind,run,targets,body,enabled,last,note,customer_id,created) "
            "VALUES (:n,:k,:r,:tg,:b,1,'未执行',:note,:cid,:now)"),
            {'n': name, 'k': kind, 'r': run, 'tg': str(d.get('targets') or ''), 'b': body,
             'note': str(d.get('note') or '手工创建'), 'cid': _stamp_cid(), 'now': datetime.now()})
        db.commit()
        return createApiResponse(msg='定时任务已创建')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/scheds/<int:sid>', methods=['POST'])
@api_security
def sms_sched_act(sid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        _ensure_worker()
        act = str((getRequestData().get('action')) or '')
        row = db.execute(text("SELECT * FROM dsip_ufi_sms_sched WHERE id=:id"), {'id': sid}).mappings().first()
        if not row or not _row_owned(row):
            return createApiResponse(status_code=404, msg='任务不存在')
        if act == 'toggle':
            db.execute(text("UPDATE dsip_ufi_sms_sched SET enabled=1-enabled WHERE id=:id"), {'id': sid})
        elif act == 'del':
            db.execute(text("DELETE FROM dsip_ufi_sms_sched WHERE id=:id"), {'id': sid})
        db.commit()
        return createApiResponse(msg='ok')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: tpl
@api.route(SMS_BASE + '/tpl', methods=['GET', 'POST'])
@api_security
def sms_tpl():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        if request.method == 'GET':
            where, params = [], {}
            _apply_date_range(where, params, 'created')
            _scope_bind(where, params, 'customer_id')
            wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
            rows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_tpl" + wsql + " ORDER BY id DESC"), params).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M') if d.get('created') else ''
                out.append(d)
            db.commit()
            return createApiResponse(msg='tpl', data=out)
        d = getRequestData()
        name = str(d.get('name') or '').strip()
        body = str(d.get('body') or '').strip()
        if not name or not body:
            return createApiResponse(status_code=400, msg='名称与内容必填')
        hits = [w for w in _words_of(db) if w in body]
        if hits:
            return createApiResponse(status_code=400, msg='命中敏感词：' + '、'.join(hits))
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_tpl (name,type,vars,body,customer_id,created) VALUES (:n,:t,:v,:b,:cid,:now)"),
            {'n': name, 't': str(d.get('type') or '通知'), 'v': str(d.get('vars') or ''),
             'b': body, 'cid': _stamp_cid(), 'now': datetime.now()})
        db.commit()
        return createApiResponse(msg='模板已保存')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/tpl/<int:tpid>', methods=['POST'])
@api_security
def sms_tpl_act(tpid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        own = db.execute(text("SELECT * FROM dsip_ufi_sms_tpl WHERE id=:id"), {'id': tpid}).mappings().first()
        if not own or not _row_owned(own):
            return createApiResponse(status_code=404, msg='模板不存在')
        d = getRequestData()
        act = str(d.get('action') or '')
        if act == 'del':
            db.execute(text("DELETE FROM dsip_ufi_sms_tpl WHERE id=:id"), {'id': tpid})
        else:
            name = str(d.get('name') or '').strip()
            body = str(d.get('body') or '').strip()
            if not name or not body:
                return createApiResponse(status_code=400, msg='名称与内容必填')
            db.execute(text("UPDATE dsip_ufi_sms_tpl SET name=:n, type=:t, vars=:v, body=:b WHERE id=:id"),
                       {'n': name, 't': str(d.get('type') or '通知'), 'v': str(d.get('vars') or ''),
                        'b': body, 'id': tpid})
        db.commit()
        return createApiResponse(msg='ok')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: blacklist
@api.route(SMS_BASE + '/black', methods=['GET', 'POST'])
@api_security
def sms_black():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        if request.method == 'GET':
            where, params = [], {}
            _apply_date_range(where, params, 'created')
            _scope_bind(where, params, 'customer_id')
            wsql = (' WHERE ' + ' AND '.join(where)) if where else ''
            rows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_black" + wsql + " ORDER BY created DESC"), params).mappings().all()
            out = [{'num': r['num'], 'src': r['src'],
                    'created': r['created'].strftime('%Y-%m-%d %H:%M') if r['created'] else ''} for r in rows]
            db.commit()
            return createApiResponse(msg='blacklist', data=out)
        d = getRequestData()
        nums = list(dict.fromkeys(re.findall(r'1\d{10}', str(d.get('nums') or ''))))
        src = str(d.get('src') or '手动')[:8]
        if not nums:
            return createApiResponse(status_code=400, msg='没有有效号码（11 位手机号）')
        added, dup = 0, 0
        for n in nums:
            try:
                db.execute(text(
                    "INSERT INTO dsip_ufi_sms_black (num,src,customer_id,created) VALUES (:n,:s,:cid,:now)"),
                    {'n': n, 's': src, 'cid': _stamp_cid(), 'now': datetime.now()})
                added += 1
            except Exception:
                dup += 1
                db.rollback()
        db.commit()
        return createApiResponse(msg='黑名单已更新', data=[{'added': added, 'dup': dup}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/black/<num>', methods=['POST'])
@api_security
def sms_black_act(num):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        act = str((getRequestData().get('action')) or '')
        frag, params = _scope_and()
        if act == 'del':
            db.execute(text("DELETE FROM dsip_ufi_sms_black WHERE num=:n" + frag), dict(params, n=num))
        elif act == 'clear':
            src = str((getRequestData().get('src')) or '')
            db.execute(text("DELETE FROM dsip_ufi_sms_black WHERE src=:s" + frag), dict(params, s=src))
        db.commit()
        return createApiResponse(msg='ok')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: words
@api.route(SMS_BASE + '/words', methods=['GET', 'POST'])
@api_security
def sms_words():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        if request.method == 'GET':
            rows = _words_of(db)
            rows.sort()
            db.commit()
            return createApiResponse(msg='words', data=rows)
        raw = str((getRequestData().get('words')) or '')
        added = 0
        cid = _stamp_cid()
        for w in [x.strip() for x in re.split(r'[,，\s]+', raw) if x.strip()]:
            try:
                db.execute(text("INSERT INTO dsip_ufi_sms_word (word, customer_id) VALUES (:w,:cid)"),
                           {'w': w[:64], 'cid': cid})
                added += 1
            except Exception:
                db.rollback()
        db.commit()
        return createApiResponse(msg='敏感词已更新', data=[{'added': added}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/words/<path:word>', methods=['POST'])
@api_security
def sms_word_del(word):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        frag, params = _scope_and()
        db.execute(text("DELETE FROM dsip_ufi_sms_word WHERE word=:w" + frag), dict(params, w=word[:64]))
        db.commit()
        return createApiResponse(msg='ok')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: policies (multi)
POLICY_FIELDS = ('strategy', 'rate', 'per_hour', 'per_day', 'gap_s', 'burst_gap_s',
                 'quiet_enabled', 'quiet_from', 'quiet_to')


def _policy_from_req(d, exist=None):
    p = dict(exist) if exist else {
        'strategy': 'wrr', 'rate': 20, 'per_hour': 40, 'per_day': 400,
        'gap_s': 6, 'burst_gap_s': 90, 'quiet_enabled': 1,
        'quiet_from': '23:00', 'quiet_to': '08:00'}
    p['name'] = str(d.get('name') or (exist or {}).get('name') or '').strip()[:64]
    p['strategy'] = str(d.get('strategy') or p.get('strategy') or 'wrr')[:8]
    for k in ('rate', 'per_hour', 'per_day', 'gap_s', 'burst_gap_s'):
        p[k] = max(0, int(d.get(k) if d.get(k) is not None else p.get(k) or 0))
    p['quiet_enabled'] = 1 if str(d.get('quiet_enabled', p.get('quiet_enabled'))) in ('1', 'true', 'True', 'on') else 0
    p['quiet_from'] = str(d.get('quiet_from') or p.get('quiet_from') or '23:00')[:8]
    p['quiet_to'] = str(d.get('quiet_to') or p.get('quiet_to') or '08:00')[:8]
    return p


@api.route(SMS_BASE + '/policies', methods=['GET', 'POST'])
@api_security
def sms_policies():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        if request.method == 'GET':
            return createApiResponse(msg='policies', data=_policies(db))
        d = getRequestData()
        p = _policy_from_req(d)
        if not p['name']:
            return createApiResponse(status_code=400, msg='策略名称必填')
        nfrag, nparams = _scope_and()
        if db.execute(text("SELECT COUNT(*) FROM dsip_ufi_sms_policy WHERE name=:n" + nfrag),
                      dict(nparams, n=p['name'])).scalar():
            return createApiResponse(status_code=400, msg='策略名已存在：' + p['name'])
        now = datetime.now()
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_policy (name,strategy,rate,per_hour,per_day,gap_s,burst_gap_s,"
            "quiet_enabled,quiet_from,quiet_to,customer_id,created,updated) "
            "VALUES (:name,:strategy,:rate,:per_hour,:per_day,:gap_s,:burst_gap_s,"
            ":quiet_enabled,:quiet_from,:quiet_to,:cid,:now,:now)"),
            dict(p, cid=_stamp_cid(), now=now))
        db.commit()
        pid = db.execute(text("SELECT MAX(id) FROM dsip_ufi_sms_policy")).scalar()
        return createApiResponse(msg='策略已创建', data=[{'id': pid}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/policies/<int:pid>', methods=['PUT', 'DELETE'])
@api_security
def sms_policy_act(pid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        exist = db.execute(text("SELECT * FROM dsip_ufi_sms_policy WHERE id=:i"), {'i': pid}).mappings().first()
        if not exist or not _row_owned(exist):
            return createApiResponse(status_code=404, msg='策略不存在')
        if request.method == 'DELETE':
            db.execute(text("DELETE FROM dsip_ufi_sms_policy WHERE id=:i"), {'i': pid})
            db.execute(text("UPDATE dsip_ufi_sms_task SET policy_id=0 WHERE policy_id=:i"), {'i': pid})
            db.commit()
            return createApiResponse(msg='策略已删除，引用它的任务回退默认设置')
        d = getRequestData()
        p = _policy_from_req(d, dict(exist))
        if not p['name']:
            return createApiResponse(status_code=400, msg='策略名称必填')
        nfrag, nparams = _scope_and()
        if db.execute(text("SELECT COUNT(*) FROM dsip_ufi_sms_policy WHERE name=:n AND id<>:i" + nfrag),
                      dict(nparams, n=p['name'], i=pid)).scalar():
            return createApiResponse(status_code=400, msg='策略名已存在：' + p['name'])
        db.execute(text(
            "UPDATE dsip_ufi_sms_policy SET name=:name, strategy=:strategy, rate=:rate, per_hour=:per_hour, "
            "per_day=:per_day, gap_s=:gap_s, burst_gap_s=:burst_gap_s, quiet_enabled=:quiet_enabled, "
            "quiet_from=:quiet_from, quiet_to=:quiet_to, updated=:now WHERE id=:i"), dict(p, now=datetime.now(), i=pid))
        db.commit()
        return createApiResponse(msg='策略已更新')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ---------------------------------------------------------------- API: settings / channel toggle
@api.route(SMS_BASE + '/settings', methods=['GET', 'PUT'])
@api_security
def sms_settings_api():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        _ensure_worker()
        if request.method == 'GET':
            s = _settings(db)
            db.commit()
            return createApiResponse(msg='settings', data=[{k: v for k, v in s.items() if k != 'updated_at'}])
        d = getRequestData()
        allowed = {'strategy': str(d.get('strategy') or 'wrr')[:8],
                   'per_hour': max(1, int(d.get('per_hour') or 40)),
                   'per_day': max(1, int(d.get('per_day') or 400)),
                   'gap_s': max(1, int(d.get('gap_s') or 6)),
                   'burst_gap_s': max(0, int(d.get('burst_gap_s') or 90)),
                   'quiet_enabled': 1 if d.get('quiet_enabled') else 0,
                   'quiet_from': str(d.get('quiet_from') or '23:00')[:8],
                   'quiet_to': str(d.get('quiet_to') or '08:00')[:8],
                   'sig': str(d.get('sig') or '')[:32]}
        db.execute(text("""UPDATE dsip_ufi_sms_settings SET strategy=:strategy, per_hour=:per_hour,
            per_day=:per_day, gap_s=:gap_s, burst_gap_s=:burst_gap_s, quiet_enabled=:quiet_enabled,
            quiet_from=:quiet_from, quiet_to=:quiet_to, sig=:sig, updated_at=:now WHERE id=1"""),
                   dict(allowed, now=datetime.now()))
        db.commit()
        return createApiResponse(msg='频控参数已更新，即时生效')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/pool-members', methods=['GET'])
@api_security
def sms_pool_members():
    """台账设备及其号码池归属，供短信策略入池。不要求 VoIP 已注册。"""
    db = DummySession()
    try:
        db = startSession()
        _ensure_sms_tables(db)
        from modules.api.ufi_comm import _ensure_comm_tables, _ensure_pool_strategy_tables
        from modules.api.acl import customer_sql, ensure_acl_tables
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        ensure_acl_tables(db)
        csql, cparams = customer_sql('d')
        rows = db.execute(text(
            "SELECT d.imei, d.sn, d.sim_number, d.voip_status, "
            "COALESCE(p.pool_id, '—') AS pool_id, COALESCE(p.in_pool, 0) AS in_pool "
            "FROM dsip_ufi_device d LEFT JOIN dsip_ufi_pool p ON p.imei=d.imei "
            "WHERE 1=1" + csql + " ORDER BY d.imei DESC LIMIT 2000"
        ), cparams).mappings().all()
        pools = [r[0] for r in db.execute(text(
            "SELECT pool_id FROM dsip_ufi_pool_cfg ORDER BY pool_id"
        )).all()]
        out = [{
            'imei': r['imei'], 'sn': r['sn'] or '', 'sim': _sim_norm(r['sim_number']),
            'voip': str(r['voip_status'] or ''),
            'pool': r['pool_id'] if int(r['in_pool'] or 0) else '—',
            'pool_id': r['pool_id'] or '—',
            'in_pool': int(r['in_pool'] or 0),
        } for r in rows]
        return createApiResponse(msg='pool members', data=[{
            'devices': out, 'pools': pools, 'total': len(out),
        }])
    except Exception as ex:
        db.rollback()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/pool-members', methods=['POST'])
@api_security
def sms_pool_member_set():
    """把台账设备加入/移出号码池。
    body: {imei?, imeis?, pool_id, in_pool?}。支持单台或批量（imeis，最多 200）。池不存在则创建。"""
    db = DummySession()
    try:
        db = startSession()
        _ensure_sms_tables(db)
        from modules.api.ufi_comm import _ensure_comm_tables, _ensure_pool_strategy_tables
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        d = getRequestData() or {}
        pool_id = str(d.get('pool_id') or '').strip()[:16]
        in_pool = 0 if str(d.get('in_pool', 1)).lower() in ('0', 'false', 'no') else 1
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,16}', pool_id):
            return createApiResponse(error='http', status_code=400, msg='号码池 ID 仅允许字母数字、下划线和短横线，最长 16 位')

        raw = d.get('imeis')
        if raw is None:
            one = str(d.get('imei') or '').strip()
            imeis = [one] if one else []
        elif isinstance(raw, list):
            imeis = [str(x or '').strip() for x in raw]
        else:
            return createApiResponse(error='http', status_code=400, msg='imeis 须为数组')
        imeis = [i for i in imeis if i]
        # 去重保序
        seen = set()
        uniq = []
        for i in imeis:
            if i not in seen:
                seen.add(i)
                uniq.append(i)
        imeis = uniq
        if not imeis:
            return createApiResponse(error='http', status_code=400, msg='请指定 IMEI')
        if len(imeis) > 200:
            return createApiResponse(error='http', status_code=400, msg='单次最多批量 200 台')
        bad = [i for i in imeis if not re.fullmatch(r'[0-9]{10,20}', i)]
        if bad:
            return createApiResponse(error='http', status_code=400, msg='IMEI 无效: ' + bad[0])

        db.execute(text(
            "INSERT IGNORE INTO dsip_ufi_pool_cfg (pool_id, strategy, updated_at) "
            "VALUES (:p, 'round_robin', NOW())"
        ), {'p': pool_id})

        updated = []
        missing = []
        sim_override = _sim_norm(d.get('sim') or '') if len(imeis) == 1 else ''
        for imei in imeis:
            dev = db.execute(text(
                "SELECT imei, sim_number FROM dsip_ufi_device WHERE imei=:i"
            ), {'i': imei}).mappings().first()
            if not dev:
                missing.append(imei)
                continue
            sim = sim_override or _sim_norm(dev.get('sim_number') or '')
            db.execute(text(
                "INSERT INTO dsip_ufi_pool (imei, sim, pool_id, enabled, in_pool, weight, max_concurrent, note, carrier, updated_at) "
                "VALUES (:imei, :sim, :pool, 1, :inp, 1, 2, '', '100', NOW()) "
                "ON DUPLICATE KEY UPDATE sim=IF(:sim2='', sim, :sim2), pool_id=:pool2, in_pool=:inp2, updated_at=NOW()"
            ), {'imei': imei, 'sim': sim, 'pool': pool_id, 'inp': in_pool,
                'sim2': sim, 'pool2': pool_id, 'inp2': in_pool})
            updated.append({'imei': imei, 'pool_id': pool_id, 'in_pool': in_pool, 'sim': sim})

        if not updated and missing:
            return createApiResponse(error='http', status_code=404, msg='台账中没有这些设备')
        db.commit()
        msg = '已更新号码池 · %d 台' % len(updated)
        if missing:
            msg += '（跳过 %d 台未在台账）' % len(missing)
        return createApiResponse(msg=msg, data=[{
            'pool_id': pool_id, 'in_pool': in_pool,
            'updated': updated, 'missing': missing, 'count': len(updated),
        }])
    except Exception as ex:
        db.rollback()
        return showApiError(ex)
    finally:
        db.close()


@api.route(SMS_BASE + '/channel/<imei>', methods=['POST'])
@api_security
def sms_channel_toggle(imei):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_sms_tables(db)
        row = db.execute(text("SELECT enabled FROM dsip_ufi_sms_ch WHERE imei=:i"), {'i': imei}).scalar()
        if row is None:
            db.execute(text("INSERT INTO dsip_ufi_sms_ch (imei,enabled) VALUES (:i,0)"), {'i': imei})
        else:
            db.execute(text("UPDATE dsip_ufi_sms_ch SET enabled=1-enabled WHERE imei=:i"), {'i': imei})
        db.commit()
        return createApiResponse(msg='通道状态已更新')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()
