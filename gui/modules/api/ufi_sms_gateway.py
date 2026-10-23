# ----------------------------------------------------------------------------
# UFI SMS Gateway — 对外开放 HTTP 短信 API（第三方平台对接）
#   协议：UTF-8 JSON + POST；鉴权 ts(毫秒) + SHA256(sign) + secret_key
#   发送：POST /api/v1/sms/sendSms  （兼容 /ufi-app/api/ufi/sendSms）
#   推送：运营商 mo_url / report_url（短信密文 XOR+Base64，附带 sign）
# ----------------------------------------------------------------------------
import base64
import hashlib
import json
import re
import secrets
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta
from functools import wraps

from flask import g, has_request_context, jsonify, request, session
from sqlalchemy.sql import text

from database import DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api
from modules.api import ufi_sms as sms
from shared import debugEndpoint, getRequestData, StatusCodes
from util.security import AES_CTR
import settings

GW_BASE = '/api/v1/sms'
KEY_BASE = '/api/v1/ufi/sms/apikeys'
CARRIER_BASE = '/api/v1/ufi/sms/carriers'
LOG_BASE = '/api/v1/ufi/sms/apilogs'
# 对接文档默认密钥（可在 API Key / 运营商配置中覆盖）
DEFAULT_API_KEY = '097365176B381B00C4F3079A0D11E303'
DEFAULT_SECRET_KEY = '097365176B381B00C4F3079A0D11E303'
DEFAULT_SMS_KEY = '902C4397DE9AD9ECA8F7A736FDAFA13D'
TS_SKEW_MS = 5 * 60 * 1000

_PHONE_RE = re.compile(r'^1\d{10}$')
_URL_RE = re.compile(r'^https?://', re.I)

# 模拟客户侧推送收件箱：内存缓存 + DB 持久化（避免 bjoern 单线程自回调丢消息 / 重启清空）
_SANDBOX_INBOX = deque(maxlen=200)
_SANDBOX_LOCK = threading.Lock()
SANDBOX_MO_PATH = GW_BASE + '/sandbox/mo'
SANDBOX_REPORT_PATH = GW_BASE + '/sandbox/report'


def _ensure_gw_tables(db):
    sms._ensure_sms_tables(db)
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ufi_sms_apikey (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(64) NOT NULL,
            api_key VARCHAR(64) NOT NULL,
            key_prefix VARCHAR(12) NOT NULL DEFAULT '',
            pool_id VARCHAR(16) NOT NULL DEFAULT '',
            enabled TINYINT NOT NULL DEFAULT 1,
            note VARCHAR(255) NOT NULL DEFAULT '',
            created DATETIME NOT NULL,
            last_used DATETIME NULL,
            UNIQUE KEY uk_api_key (api_key),
            INDEX idx_prefix (key_prefix)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ufi_sms_carrier (
            carrier VARCHAR(16) NOT NULL PRIMARY KEY,
            name VARCHAR(128) NOT NULL DEFAULT '',
            mo_url VARCHAR(512) NOT NULL DEFAULT '',
            report_url VARCHAR(512) NOT NULL DEFAULT '',
            enabled TINYINT NOT NULL DEFAULT 1,
            updated_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ufi_sms_sandbox_inbox (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            kind VARCHAR(16) NOT NULL,
            at DATETIME NOT NULL,
            payload MEDIUMTEXT NOT NULL,
            sign_ok TINYINT NULL,
            sms_plain TEXT NOT NULL,
            remote VARCHAR(64) NOT NULL DEFAULT '',
            INDEX idx_sandbox_at (at),
            INDEX idx_sandbox_kind (kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ufi_sms_api_log (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            created DATETIME NOT NULL,
            direction VARCHAR(8) NOT NULL DEFAULT 'in',
            api_name VARCHAR(32) NOT NULL DEFAULT '',
            method VARCHAR(8) NOT NULL DEFAULT 'POST',
            path VARCHAR(512) NOT NULL DEFAULT '',
            request_id VARCHAR(64) NOT NULL DEFAULT '',
            caller_number VARCHAR(32) NOT NULL DEFAULT '',
            callee_number VARCHAR(32) NOT NULL DEFAULT '',
            carrier VARCHAR(16) NOT NULL DEFAULT '',
            carrier_name VARCHAR(128) NOT NULL DEFAULT '',
            http_status INT NOT NULL DEFAULT 0,
            result_code INT NOT NULL DEFAULT 0,
            result_msg VARCHAR(255) NOT NULL DEFAULT '',
            msg_id VARCHAR(64) NOT NULL DEFAULT '',
            key_id INT NOT NULL DEFAULT 0,
            key_name VARCHAR(64) NOT NULL DEFAULT '',
            duration_ms INT NOT NULL DEFAULT 0,
            remote VARCHAR(64) NOT NULL DEFAULT '',
            sms_body VARCHAR(512) NOT NULL DEFAULT '',
            req_summary VARCHAR(1000) NOT NULL DEFAULT '',
            resp_summary VARCHAR(1000) NOT NULL DEFAULT '',
            INDEX idx_api_log_created (created),
            INDEX idx_api_log_caller (caller_number),
            INDEX idx_api_log_callee (callee_number),
            INDEX idx_api_log_carrier (carrier),
            INDEX idx_api_log_dir (direction),
            INDEX idx_api_log_api (api_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    try:
        log_cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_api_log")).all()]
        if 'sms_body' not in log_cols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_api_log ADD COLUMN sms_body VARCHAR(512) NOT NULL DEFAULT '' "
                "AFTER remote"
            ))
    except Exception:
        pass
    try:
        cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_msg")).all()]
        if 'ext_id' not in cols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_msg ADD COLUMN ext_id VARCHAR(64) NOT NULL DEFAULT '' AFTER task_id"
            ))
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD INDEX idx_msg_ext (ext_id)"))
        if 'push_mo' not in cols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD COLUMN push_mo TINYINT NOT NULL DEFAULT 0"))
        if 'push_report' not in cols:
            db.execute(text("ALTER TABLE dsip_ufi_sms_msg ADD COLUMN push_report TINYINT NOT NULL DEFAULT 0"))
    except Exception:
        pass
    # API Key / 运营商：补齐 secret_key、sms_key
    try:
        kcols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_apikey")).all()]
        if 'secret_key' not in kcols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_apikey ADD COLUMN secret_key VARCHAR(128) NOT NULL DEFAULT '' AFTER api_key"
            ))
        if 'sms_key' not in kcols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_apikey ADD COLUMN sms_key VARCHAR(128) NOT NULL DEFAULT '' AFTER secret_key"
            ))
    except Exception:
        pass
    try:
        ccols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_sms_carrier")).all()]
        if 'secret_key' not in ccols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_carrier ADD COLUMN secret_key VARCHAR(128) NOT NULL DEFAULT '' AFTER report_url"
            ))
        if 'sms_key' not in ccols:
            db.execute(text(
                "ALTER TABLE dsip_ufi_sms_carrier ADD COLUMN sms_key VARCHAR(128) NOT NULL DEFAULT '' AFTER secret_key"
            ))
    except Exception:
        pass
    # 首次安装：表为空时写入文档默认 api_key。
    # 注意：不要在「默认 key 被用户删除」后自动复活，否则删除按钮形同失效。
    try:
        total = int(db.execute(text("SELECT COUNT(*) FROM dsip_ufi_sms_apikey")).scalar() or 0)
        if total == 0:
            db.execute(text(
                "INSERT INTO dsip_ufi_sms_apikey "
                "(name, api_key, secret_key, sms_key, key_prefix, pool_id, enabled, note, created) "
                "VALUES ('默认对接', :ak, :sk, :mk, :p, '', 1, '文档默认密钥', :now)"
            ), {
                'ak': DEFAULT_API_KEY, 'sk': DEFAULT_SECRET_KEY, 'mk': DEFAULT_SMS_KEY,
                'p': DEFAULT_API_KEY[:10], 'now': datetime.now(),
            })
        else:
            row = db.execute(text(
                "SELECT id, secret_key, sms_key FROM dsip_ufi_sms_apikey WHERE api_key=:k LIMIT 1"
            ), {'k': DEFAULT_API_KEY}).mappings().first()
            if row:
                if not (row.get('secret_key') or '').strip():
                    db.execute(text(
                        "UPDATE dsip_ufi_sms_apikey SET secret_key=:sk WHERE id=:i"
                    ), {'sk': DEFAULT_SECRET_KEY, 'i': row['id']})
                if not (row.get('sms_key') or '').strip():
                    db.execute(text(
                        "UPDATE dsip_ufi_sms_apikey SET sms_key=:mk WHERE id=:i"
                    ), {'mk': DEFAULT_SMS_KEY, 'i': row['id']})
        # 历史 Key：secret/sms 为空时用 api_key / 文档 sms_key 回填
        db.execute(text(
            "UPDATE dsip_ufi_sms_apikey SET secret_key=api_key "
            "WHERE secret_key='' OR secret_key IS NULL"
        ))
        db.execute(text(
            "UPDATE dsip_ufi_sms_apikey SET sms_key=:mk "
            "WHERE sms_key='' OR sms_key IS NULL"
        ), {'mk': DEFAULT_SMS_KEY})
    except Exception:
        pass
    db.commit()


# ───────────────────────────── crypto / sign ─────────────────────────────
def xor_crypt(text, encrypt=True, key=''):
    """对齐 XorCipherUtil：UTF-8 XOR 后 Base64；decrypt 失败返回原文。"""
    if text is None or text == '' or not key:
        return text
    try:
        if encrypt:
            plain = str(text).encode('utf-8')
            out = bytearray(len(plain))
            kl = len(key)
            for i, b in enumerate(plain):
                out[i] = b ^ (ord(key[i % kl]) & 0xFF)
            return base64.b64encode(bytes(out)).decode('ascii')
        raw = base64.b64decode(str(text))
        out = bytearray(len(raw))
        kl = len(key)
        for i, b in enumerate(raw):
            out[i] = b ^ (ord(key[i % kl]) & 0xFF)
        decoded = bytes(out).decode('utf-8')
        if re.search(r'[\u4e00-\u9fa5a-zA-Z0-9\s\.,!?，。？！]', decoded):
            return decoded
        return text
    except Exception:
        return text


def create_sign(params, secret_key):
    """key ASCII 升序拼接 key=val&...&secret_key=SK → SHA-256 hex（对齐 hutool SignUtil）。"""
    items = []
    for k in sorted(str(x) for x in (params or {}).keys()):
        if k == 'sign':
            continue
        v = params[k]
        if v is None:
            continue
        items.append('%s=%s' % (k, v))
    raw = '&'.join(items) + '&secret_key=' + str(secret_key or '')
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _now_ms():
    return int(datetime.now().timestamp() * 1000)


def _new_request_id():
    return str(uuid.uuid4())


def _ufi_resp(request_id, code, message, data=None, http_status=None):
    body = {
        'requestId': request_id or '',
        'ts': _now_ms(),
        'code': int(code),
        'message': message or '',
    }
    if data is not None:
        body['data'] = data
    return jsonify(body), (http_status if http_status is not None else (
        200 if int(code) == 200 else (401 if int(code) == 401 else (400 if int(code) == 400 else 500))
    ))


def _sandbox_kind_of_url(url):
    """若 URL 指向本机模拟客户接口，返回 mo/report，否则 None。"""
    try:
        path = urllib.parse.urlparse(str(url or '')).path or ''
    except Exception:
        return None
    path = path.rstrip('/') or '/'
    if path.endswith('/sandbox/mo'):
        return 'mo'
    if path.endswith('/sandbox/report'):
        return 'report'
    return None


def _http_json_post(url, payload, timeout=8):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'dSIPRouter-SMS-Gateway/1.0',
    }
    # 本机公网域名走 loopback，避开 WAF / 证书 / bjoern 自回调卡死
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or '').lower()
        local_hosts = {
            '127.0.0.1', 'localhost',
            str(getattr(settings, 'DSIP_HOSTNAME', '') or '').lower(),
            'ufi.mineo.top',
        }
        local_hosts = {h for h in local_hosts if h}
        if host in local_hosts and _sandbox_kind_of_url(url):
            path = parsed.path or '/'
            if parsed.query:
                path = path + '?' + parsed.query
            url = 'http://127.0.0.1' + path
            headers['Host'] = host if host not in ('127.0.0.1', 'localhost') else (
                str(getattr(settings, 'DSIP_HOSTNAME', '') or 'ufi.mineo.top')
            )
    except Exception:
        pass
    req = urllib.request.Request(url, data=data, method='POST', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = getattr(resp, 'status', None) or resp.getcode()
            body = resp.read(512)
            return int(code or 0), body
    except urllib.error.HTTPError as ex:
        body = b''
        try:
            body = ex.read(512)
        except Exception:
            pass
        return int(ex.code or 0), body


def _deliver_customer_push(url, payload, kind):
    """推送到客户回调；本机 sandbox URL 进程内直写，避免单线程 HTTP 自调丢失。"""
    local_kind = _sandbox_kind_of_url(url) or kind
    if _sandbox_kind_of_url(url):
        _sandbox_store(local_kind, payload, remote='local-shortcircuit')
        return 200, b'{"code":200,"comment":"success","via":"local"}'
    return _http_json_post(url, payload)


def _clip_summary(obj, limit=900):
    try:
        if obj is None:
            return ''
        if isinstance(obj, (bytes, bytearray)):
            s = obj.decode('utf-8', 'ignore')
        elif isinstance(obj, str):
            s = obj
        else:
            s = json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        s = str(obj)
    s = re.sub(r'("?(?:sign|apiKey|api_key|secret_key|sms_key)"?\s*:\s*")[^"]{8,}',
               r'\1***', s, flags=re.I)
    if len(s) > limit:
        return s[:limit] + '…'
    return s


def _clip_sms_body(v, limit=480):
    s = str(v or '').replace('\r', ' ').replace('\n', ' ').strip()
    if len(s) > limit:
        return s[:limit] + '…'
    return s


def _sms_body_from_summary(summary):
    """从 req_summary 兜底提取正文（兼容旧日志无 sms_body 列值）。"""
    if not summary:
        return ''
    if isinstance(summary, dict):
        for k in ('text', 'content', 'body', 'message', 'sms_plain', 'smsBodyPlain'):
            if summary.get(k):
                return _clip_sms_body(summary.get(k))
        return ''
    s = str(summary)
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return _sms_body_from_summary(obj)
    except Exception:
        pass
    m = re.search(r'"(?:text|content|body|message)"\s*:\s*"((?:\\.|[^"\\])*)"', s)
    if m:
        try:
            return _clip_sms_body(json.loads('"' + m.group(1) + '"'))
        except Exception:
            return _clip_sms_body(m.group(1))
    return ''


def _remote_of_request():
    if not has_request_context():
        return ''
    try:
        return (request.headers.get('X-Forwarded-For') or request.remote_addr or '')[:64]
    except Exception:
        return ''


def _carrier_meta(db, carrier):
    cid = str(carrier or '').strip()
    if not cid:
        return '', ''
    row = db.execute(text(
        "SELECT carrier, name FROM dsip_ufi_sms_carrier WHERE carrier=:c LIMIT 1"
    ), {'c': cid}).mappings().first()
    if row:
        return cid, (row.get('name') or ('运营商 #' + cid))
    names = sms._carrier_name_map(db)
    return cid, names.get(cid) or ('运营商 #' + cid)


def write_api_log(fields):
    """写入开放 API 调用日志（永不抛错，使用独立会话）。"""
    if not fields:
        return
    db = DummySession()
    try:
        db = startSession()
        _ensure_gw_tables(db)
        f = dict(fields or {})
        now = f.get('created') or datetime.now()
        sms_body = _clip_sms_body(f.get('sms_body'))
        if not sms_body:
            sms_body = _sms_body_from_summary(f.get('req_summary'))
        db.execute(text("""
            INSERT INTO dsip_ufi_sms_api_log
            (created, direction, api_name, method, path, request_id,
             caller_number, callee_number, carrier, carrier_name,
             http_status, result_code, result_msg, msg_id,
             key_id, key_name, duration_ms, remote, sms_body, req_summary, resp_summary)
            VALUES
            (:created, :direction, :api_name, :method, :path, :request_id,
             :caller_number, :callee_number, :carrier, :carrier_name,
             :http_status, :result_code, :result_msg, :msg_id,
             :key_id, :key_name, :duration_ms, :remote, :sms_body, :req_summary, :resp_summary)
        """), {
            'created': now,
            'direction': str(f.get('direction') or 'in')[:8],
            'api_name': str(f.get('api_name') or '')[:32],
            'method': str(f.get('method') or 'POST')[:8],
            'path': str(f.get('path') or '')[:512],
            'request_id': str(f.get('request_id') or '')[:64],
            'caller_number': str(f.get('caller_number') or '')[:32],
            'callee_number': str(f.get('callee_number') or '')[:32],
            'carrier': str(f.get('carrier') or '')[:16],
            'carrier_name': str(f.get('carrier_name') or '')[:128],
            'http_status': int(f.get('http_status') or 0),
            'result_code': int(f.get('result_code') or 0),
            'result_msg': str(f.get('result_msg') or '')[:255],
            'msg_id': str(f.get('msg_id') or '')[:64],
            'key_id': int(f.get('key_id') or 0),
            'key_name': str(f.get('key_name') or '')[:64],
            'duration_ms': int(f.get('duration_ms') or 0),
            'remote': str(f.get('remote') or '')[:64],
            'sms_body': sms_body,
            'req_summary': _clip_summary(f.get('req_summary')),
            'resp_summary': _clip_summary(f.get('resp_summary')),
        })
        db.commit()
        # 偶尔清理 30 天前日志
        if secrets.randbelow(40) == 0:
            try:
                db.execute(text(
                    "DELETE FROM dsip_ufi_sms_api_log WHERE created < :d"
                ), {'d': datetime.now() - timedelta(days=30)})
                db.commit()
            except Exception:
                db.rollback()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


def list_carriers(db, channels=None):
    """运营商列表 = 池内 carrier ∪ 已配置 hook ∪ type=8 gwid≥100。"""
    _ensure_gw_tables(db)
    names = sms._carrier_name_map(db)
    from modules.api.acl import customer_sql
    frag, fp = customer_sql()
    hooks = {str(r['carrier']): dict(r) for r in db.execute(text(
        "SELECT carrier, name, mo_url, report_url, secret_key, sms_key, enabled, updated_at "
        "FROM dsip_ufi_sms_carrier WHERE 1=1" + frag
    ), fp).mappings().all()}

    ids = set()
    for c in (channels or []):
        if c.get('carrier'):
            ids.add(str(c['carrier']))
    for r in db.execute(text("SELECT DISTINCT carrier FROM dsip_ufi_pool WHERE carrier<>''")).all():
        ids.add(str(r[0]))
    for r in db.execute(text(
        "SELECT gwid FROM dr_gateways WHERE type=8 AND gwid>=100"
    )).all():
        ids.add(str(r[0]))
    ids.update(hooks.keys())

    chs = channels if channels is not None else sms._channels(db)
    out = []
    for cid in sorted(ids, key=lambda x: (0 if x.isdigit() else 1, int(x) if x.isdigit() else 0, x)):
        h = hooks.get(cid) or {}
        group = [c for c in chs if str(c.get('carrier') or '') == cid]
        ok = len([c for c in group if c.get('state') == 'ok'])
        name = (h.get('name') or '').strip() or names.get(cid) or ('运营商 #' + cid)
        out.append({
            'carrier': cid,
            'name': name,
            'mo_url': h.get('mo_url') or '',
            'report_url': h.get('report_url') or '',
            'secret_key': h.get('secret_key') or '',
            'sms_key': h.get('sms_key') or '',
            'enabled': int(h['enabled']) if h else 1,
            'channels': len(group),
            'channels_ok': ok,
            'updated_at': h['updated_at'].strftime('%Y-%m-%d %H:%M:%S') if h.get('updated_at') else '',
        })
    return out


def _hook_for_carrier(db, carrier):
    if not carrier:
        return None
    r = db.execute(text(
        "SELECT * FROM dsip_ufi_sms_carrier WHERE carrier=:c AND enabled=1 LIMIT 1"
    ), {'c': str(carrier)}).mappings().first()
    return dict(r) if r else None


def _default_keys(db):
    """推送签名/加密默认密钥：优先启用中的 API Key，否则文档默认值。"""
    row = db.execute(text(
        "SELECT secret_key, sms_key, api_key FROM dsip_ufi_sms_apikey WHERE enabled=1 "
        "ORDER BY id ASC LIMIT 1"
    )).mappings().first()
    if row:
        return {
            'secret_key': (row.get('secret_key') or row.get('api_key') or DEFAULT_SECRET_KEY),
            'sms_key': (row.get('sms_key') or DEFAULT_SMS_KEY),
        }
    return {'secret_key': DEFAULT_SECRET_KEY, 'sms_key': DEFAULT_SMS_KEY}


def _carrier_of_imei(db, imei):
    if not imei:
        return ''
    return str(db.execute(text(
        "SELECT carrier FROM dsip_ufi_pool WHERE imei=:i LIMIT 1"
    ), {'i': imei}).scalar() or '').strip()


def _sim_of_imei(db, imei):
    if not imei:
        return ''
    sim = db.execute(text(
        "SELECT sim FROM dsip_ufi_pool WHERE imei=:i LIMIT 1"
    ), {'i': imei}).scalar()
    if not sim:
        sim = db.execute(text(
            "SELECT sim_number FROM dsip_ufi_device WHERE imei=:i LIMIT 1"
        ), {'i': imei}).scalar()
    return sms._sim_norm(sim or '')


def _ms_of(dt):
    if not dt:
        return _now_ms()
    if isinstance(dt, datetime):
        return int(dt.timestamp() * 1000)
    return _now_ms()


def _signed_payload(params, secret_key):
    p = dict(params)
    p['sign'] = create_sign(p, secret_key)
    return p


def push_pending(db=None):
    """推送待处理的上行 MO 与下行状态报告（对接文档 3.3 / 3.4）。"""
    own = db is None
    if own:
        db = startSession()
    try:
        _ensure_gw_tables(db)
        defaults = _default_keys(db)
        since = datetime.now() - timedelta(days=2)
        # ---- MO（收短信推送）----
        mos = db.execute(text(
            "SELECT * FROM dsip_ufi_sms_msg WHERE dir='in' AND push_mo=0 AND created>=:s "
            "ORDER BY id ASC LIMIT 80"
        ), {'s': since}).mappings().all()
        for m in mos:
            carrier = _carrier_of_imei(db, m.get('imei'))
            hook = _hook_for_carrier(db, carrier) or {}
            url = hook.get('mo_url') or ''
            if not url or not _URL_RE.match(url):
                db.execute(text("UPDATE dsip_ufi_sms_msg SET push_mo=2 WHERE id=:i"), {'i': m['id']})
                db.commit()
                continue
            secret = (hook.get('secret_key') or defaults['secret_key'])
            sms_key = (hook.get('sms_key') or defaults['sms_key'])
            body_plain = m.get('body') or ''
            peer = m.get('peer') or ''
            our_sim = m.get('sim') or _sim_of_imei(db, m.get('imei'))
            payload = _signed_payload({
                'requestId': _new_request_id(),
                'smsId': str(m['id']),
                'smsType': 'inbox',
                'smsBody': xor_crypt(body_plain, True, sms_key),
                'smsTel': peer,
                'smsTimestamp': _ms_of(m.get('created')),
                'callerNumber': peer,
                'calleeNumber': our_sim,
                'failResult': 'success',
                'ts': _now_ms(),
            }, secret)
            t0 = time.time()
            code, resp_body = 0, b''
            try:
                code, resp_body = _deliver_customer_push(url, payload, 'mo')
                ok = 200 <= int(code or 0) < 300
            except Exception as ex:
                ok = False
                resp_body = str(ex)
            cid, cname = _carrier_meta(db, carrier)
            write_api_log({
                'direction': 'out', 'api_name': 'push_mo', 'method': 'POST', 'path': url,
                'request_id': payload.get('requestId') or '',
                'caller_number': peer, 'callee_number': our_sim,
                'carrier': cid, 'carrier_name': cname,
                'http_status': int(code or 0),
                'result_code': 200 if ok else int(code or 500),
                'result_msg': 'MO推送成功' if ok else 'MO推送失败',
                'msg_id': str(m['id']),
                'duration_ms': int((time.time() - t0) * 1000),
                'remote': 'customer',
                'sms_body': body_plain,
                'req_summary': {
                    'smsId': payload.get('smsId'), 'callerNumber': peer,
                    'calleeNumber': our_sim, 'smsType': 'inbox', 'text': body_plain,
                },
                'resp_summary': resp_body,
            })
            db.execute(text("UPDATE dsip_ufi_sms_msg SET push_mo=:v WHERE id=:i"),
                       {'v': 1 if ok else 0, 'i': m['id']})
            db.commit()

        # ---- Report（短信状态推送）----
        reps = db.execute(text(
            "SELECT * FROM dsip_ufi_sms_msg WHERE dir='out' AND push_report=0 "
            "AND state IN ('delivered','failed') AND created>=:s ORDER BY id ASC LIMIT 80"
        ), {'s': since}).mappings().all()
        for m in reps:
            carrier = _carrier_of_imei(db, m.get('imei'))
            hook = _hook_for_carrier(db, carrier) or {}
            url = hook.get('report_url') or ''
            if not url or not _URL_RE.match(url):
                db.execute(text("UPDATE dsip_ufi_sms_msg SET push_report=2 WHERE id=:i"), {'i': m['id']})
                db.commit()
                continue
            secret = (hook.get('secret_key') or defaults['secret_key'])
            sms_key = (hook.get('sms_key') or defaults['sms_key'])
            ok_state = m.get('state') == 'delivered'
            caller_n = m.get('sim') or _sim_of_imei(db, m.get('imei'))
            callee_n = m.get('peer') or ''
            payload = _signed_payload({
                'requestId': _new_request_id(),
                'ts': _now_ms(),
                'smsId': str(m.get('ext_id') or m['id']),
                'smsType': 'outbox',
                'failResult': '' if ok_state else (m.get('err') or 'failed'),
                'smsBody': xor_crypt(m.get('body') or '', True, sms_key),
                'smsStatus': '0' if ok_state else '1',
                'callerNumber': caller_n,
                'calleeNumber': callee_n,
            }, secret)
            t0 = time.time()
            code, resp_body = 0, b''
            try:
                code, resp_body = _deliver_customer_push(url, payload, 'report')
                ok = 200 <= int(code or 0) < 300
            except Exception as ex:
                ok = False
                resp_body = str(ex)
            cid, cname = _carrier_meta(db, carrier)
            write_api_log({
                'direction': 'out', 'api_name': 'push_report', 'method': 'POST', 'path': url,
                'request_id': payload.get('requestId') or '',
                'caller_number': caller_n, 'callee_number': callee_n,
                'carrier': cid, 'carrier_name': cname,
                'http_status': int(code or 0),
                'result_code': 200 if ok else int(code or 500),
                'result_msg': '状态推送成功' if ok else '状态推送失败',
                'msg_id': str(m.get('ext_id') or m['id']),
                'duration_ms': int((time.time() - t0) * 1000),
                'remote': 'customer',
                'sms_body': m.get('body') or '',
                'req_summary': {
                    'smsId': payload.get('smsId'), 'smsStatus': payload.get('smsStatus'),
                    'callerNumber': caller_n, 'calleeNumber': callee_n,
                    'text': m.get('body') or '',
                },
                'resp_summary': resp_body,
            })
            db.execute(text("UPDATE dsip_ufi_sms_msg SET push_report=:v WHERE id=:i"),
                       {'v': 1 if ok else 0, 'i': m['id']})
            db.commit()
    finally:
        if own:
            db.close()


def enqueue_report_push(msg_id):
    """发送完成后尽快推送状态（后台线程）。

    稍延迟，让 bjoern 先结束当前 sendSms 请求，避免同进程 HTTP 自调排队超时。
    """
    if not msg_id:
        return

    def _run():
        try:
            time.sleep(0.35)
            push_pending()
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name='sms-push-once').start()


def _master_token():
    tok = settings.DSIP_API_TOKEN
    if isinstance(tok, bytes):
        return AES_CTR.decrypt(tok)
    return tok or ''


def _extract_token():
    auth = request.headers.get('Authorization') or ''
    parts = auth.split(' ', 1)
    if len(parts) == 2 and parts[0].lower() in ('bearer', 'token'):
        return parts[1].strip()
    return (request.headers.get('X-Api-Key') or request.headers.get('X-SMS-Key') or '').strip()


def _lookup_apikey(db, token):
    if not token:
        return None
    row = db.execute(text(
        "SELECT * FROM dsip_ufi_sms_apikey WHERE api_key=:k LIMIT 1"
    ), {'k': token}).mappings().first()
    if not row or not int(row['enabled']):
        return None
    db.execute(text("UPDATE dsip_ufi_sms_apikey SET last_used=:n WHERE id=:i"),
               {'n': datetime.now(), 'i': row['id']})
    db.commit()
    return dict(row)


def _all_enabled_keys(db):
    return [dict(r) for r in db.execute(text(
        "SELECT * FROM dsip_ufi_sms_apikey WHERE enabled=1 ORDER BY id"
    )).mappings().all()]


def _verify_ts(ts_raw):
    try:
        ts = int(str(ts_raw).strip())
    except Exception:
        return False, 'ts 无效'
    now = _now_ms()
    if abs(now - ts) > TS_SKEW_MS:
        return False, '签名过期（ts 超出 ±5 分钟）'
    return True, ''


def _auth_by_sign(db, params):
    """按文档校验 ts + sign；返回 (ok, err, keyrow)。"""
    ok, err = _verify_ts(params.get('ts'))
    if not ok:
        return False, err, None
    sign = str(params.get('sign') or '').strip().lower()
    if not sign:
        return False, '缺少 sign', None

    candidates = []
    # 显式 apiKey
    ak = str(params.get('apiKey') or params.get('api_key') or
             request.headers.get('X-Api-Key') or request.headers.get('apiKey') or '').strip()
    if ak:
        row = _lookup_apikey(db, ak)
        if row:
            candidates = [row]
    if not candidates:
        candidates = _all_enabled_keys(db)
    if not candidates:
        candidates = [{
            'id': 0, 'name': 'default', 'api_key': DEFAULT_API_KEY,
            'secret_key': DEFAULT_SECRET_KEY, 'sms_key': DEFAULT_SMS_KEY, 'pool_id': '',
        }]

    for row in candidates:
        secret = (row.get('secret_key') or row.get('api_key') or DEFAULT_SECRET_KEY)
        expect = create_sign(params, secret).lower()
        if secrets.compare_digest(expect, sign):
            if row.get('id'):
                try:
                    db.execute(text("UPDATE dsip_ufi_sms_apikey SET last_used=:n WHERE id=:i"),
                               {'n': datetime.now(), 'i': row['id']})
                    db.commit()
                except Exception:
                    pass
            return True, '', row
    return False, '签名无效', None


def sms_gw_auth(func):
    """Gateway auth: session | Bearer token | ts+sign。"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        g.sms_gw = {'mode': 'anon', 'pool_id': '', 'key_id': 0, 'key_name': '', 'sms_key': DEFAULT_SMS_KEY}
        if session.get('logged_in'):
            g.sms_gw['mode'] = 'session'
            return func(*args, **kwargs)

        # IP 白名单（开启后拦截非名单来源；管理会话已在上方放行）
        try:
            from modules.api.ufi_whitelist import enforce_sms_ip
            ok_ip, err_ip = enforce_sms_ip()
            if not ok_ip:
                return createApiResponse(error='http', msg=err_ip or 'Forbidden',
                                         status_code=StatusCodes.HTTP_FORBIDDEN)
        except Exception:
            pass

        token = _extract_token()
        d = getRequestData() or {}
        # 优先 Bearer / X-Api-Key
        if token:
            master = _master_token()
            if master and secrets.compare_digest(str(master), token):
                g.sms_gw['mode'] = 'master'
                return func(*args, **kwargs)
            db = DummySession()
            try:
                db = startSession()
                _ensure_gw_tables(db)
                key = _lookup_apikey(db, token)
                if key:
                    g.sms_gw = {
                        'mode': 'apikey',
                        'pool_id': str(key.get('pool_id') or ''),
                        'key_id': int(key['id']),
                        'key_name': key.get('name') or '',
                        'sms_key': key.get('sms_key') or DEFAULT_SMS_KEY,
                        'customer_id': key.get('customer_id'),
                    }
                    return func(*args, **kwargs)
            except Exception as ex:
                return showApiError(ex)
            finally:
                db.close()

        # ts + sign
        if d.get('ts') and d.get('sign'):
            db = DummySession()
            try:
                db = startSession()
                _ensure_gw_tables(db)
                ok, err, key = _auth_by_sign(db, d)
                if not ok:
                    return createApiResponse(error='http', msg=err or 'Unauthorized',
                                             status_code=StatusCodes.HTTP_UNAUTHORIZED)
                g.sms_gw = {
                    'mode': 'sign',
                    'pool_id': str((key or {}).get('pool_id') or ''),
                    'key_id': int((key or {}).get('id') or 0),
                    'key_name': (key or {}).get('name') or '',
                    'sms_key': (key or {}).get('sms_key') or DEFAULT_SMS_KEY,
                    'customer_id': (key or {}).get('customer_id'),
                }
                return func(*args, **kwargs)
            except Exception as ex:
                return showApiError(ex)
            finally:
                db.close()

        return createApiResponse(error='http', msg='Unauthorized: missing API token or sign',
                                 status_code=StatusCodes.HTTP_UNAUTHORIZED)
    return wrapper


def _norm_phone(v):
    """兼容旧名：短信地址规范化（手机号 / 短号 / 字母数字短码）。"""
    return sms.norm_sms_addr(v)


def _body_of(d):
    return str(d.get('content') or d.get('text') or d.get('body') or d.get('message') or '').strip()


def _to_of(d):
    return _norm_phone(d.get('to') or d.get('mobile') or d.get('phone') or d.get('peer')
                       or d.get('calleeNumber') or d.get('callee') or '')


def _msg_view(m):
    if not m:
        return {}
    return {
        'id': m.get('id'),
        'to': m.get('peer') or '',
        'content': m.get('body') or '',
        'state': m.get('state') or '',
        'err': m.get('err') or '',
        'sim': m.get('sim') or '',
        'imei': m.get('imei') or '',
        'ext_id': m.get('ext_id') or '',
        'task_id': m.get('task_id') or 0,
        'created': m.get('created') if isinstance(m.get('created'), str)
        else (m['created'].strftime('%Y-%m-%d %H:%M:%S') if m.get('created') else ''),
    }


def _resolve_pool(d):
    """API key 绑定池优先；请求可指定池（master/session）；key 绑定时若请求池不一致则拒绝。"""
    req_pool = str(d.get('pool_id') or d.get('pool') or '').strip()
    key_pool = str(getattr(g, 'sms_gw', {}).get('pool_id') or '').strip()
    if key_pool:
        if req_pool and req_pool != key_pool:
            return None, 'API Key 已绑定号码池 %s，不能改用 %s' % (key_pool, req_pool)
        return key_pool, None
    return req_pool, None


def _validate_send(db, peer, body, customer_id=sms._CID_UNSET):
    """发送前校验。短号/字母数字短码放行；大陆 11 位手机号仍走黑名单与静默。"""
    if not sms.is_valid_sms_addr(peer):
        return '号码无效（支持手机号、短号如 10086、字母数字短码）'
    if not body:
        return '短信内容为空'
    if len(body) > 1000:
        return '短信内容过长（最多 1000 字）'
    hits = [w for w in sms._words_of(db, customer_id) if w in body]
    if hits:
        return '命中敏感词：' + '、'.join(hits)
    if sms.is_cn_mobile(peer):
        if sms._black_hit(db, peer, customer_id):
            return '黑名单号码，拒绝发送'
        s = sms._settings(db)
        if sms._quiet_now(s) and sms._is_marketing(body):
            return '夜间静默期（%s→次日%s），营销类请改用批量定时' % (
                s.get('quiet_from'), s.get('quiet_to'))
    return None


def _do_send_ext(db, peer, body, prefer_imei=None, pool_id=None, ext_id='', customer_id=sms._CID_UNSET):
    msg = sms._do_send(db, peer, body, prefer_imei, pol=None, pool_id=pool_id or None, customer_id=customer_id)
    ext = str(ext_id or '')[:64]
    if ext and msg.get('id'):
        db.execute(text("UPDATE dsip_ufi_sms_msg SET ext_id=:e WHERE id=:i"),
                   {'e': ext, 'i': msg['id']})
        db.commit()
        msg['ext_id'] = ext
    return msg


# ═══════════════════════════════════════════════════════════════ Gateway API
@api.route(GW_BASE + '/health', methods=['GET'])
@sms_gw_auth
def gw_health():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        pool, err = _resolve_pool(request.args)
        if err:
            return createApiResponse(status_code=400, msg=err)
        chs = [c for c in sms._channels(db) if c['state'] == 'ok']
        if pool:
            chs = [c for c in chs if c.get('pool') == pool]
        db.commit()
        return createApiResponse(msg='ok', data=[{
            'ok': True,
            'channels': len(chs),
            'pool_id': pool or '',
            'auth': g.sms_gw.get('mode'),
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _pick_imei_by_caller(db, caller, pool_id=None):
    """按发短信号码（SIM）精确选通道。"""
    caller = _norm_phone(caller)
    if not caller:
        return None
    chs = [c for c in sms._channels(db) if c['state'] == 'ok']
    if pool_id:
        chs = [c for c in chs if c.get('pool') == pool_id]
    for c in chs:
        if _norm_phone(c.get('sim')) == caller:
            return c['imei']
    return None


@api.route(GW_BASE + '/sendSms', methods=['POST'])
@api.route('/ufi-app/api/ufi/sendSms', methods=['POST'])
@api.route('/api/ufi/sendSms', methods=['POST'])
def gw_send_sms_doc():
    """对接文档 3.2 发送短信接口（ts+sign 鉴权，专用响应格式）。"""
    d = getRequestData() or {}
    request_id = str(d.get('requestId') or _new_request_id())
    t0 = time.time()
    log = {
        'direction': 'in', 'api_name': 'sendSms', 'method': 'POST',
        'path': request.path if has_request_context() else GW_BASE + '/sendSms',
        'request_id': request_id,
        'caller_number': _norm_phone(d.get('callerNumber') or d.get('caller') or ''),
        'callee_number': _norm_phone(d.get('calleeNumber') or d.get('callee') or d.get('to') or ''),
        'remote': _remote_of_request(),
        'sms_body': str(d.get('text') or d.get('content') or d.get('body') or ''),
        'req_summary': {
            'requestId': request_id,
            'callerNumber': d.get('callerNumber') or d.get('caller') or '',
            'calleeNumber': d.get('calleeNumber') or d.get('callee') or d.get('to') or '',
            'text': str(d.get('text') or d.get('content') or d.get('body') or ''),
        },
        'http_status': 500, 'result_code': 500, 'result_msg': '',
    }
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        sms._ensure_worker()

        # IP 白名单（sendSms 不走 sms_gw_auth，此处单独校验）
        try:
            from modules.api.ufi_whitelist import is_sms_ip_allowed
            ok_ip, err_ip = is_sms_ip_allowed(db)
            if not ok_ip and not session.get('logged_in'):
                log.update({'http_status': 403, 'result_code': 403, 'result_msg': err_ip or 'Forbidden'})
                return _ufi_resp(request_id, 403, err_ip or 'Forbidden')
        except Exception:
            pass

        ok, err, key = _auth_by_sign(db, d)
        if not ok:
            log.update({'http_status': 401, 'result_code': 401, 'result_msg': err or '签名无效'})
            return _ufi_resp(request_id, 401, err or '签名无效')

        g.sms_gw = {
            'mode': 'sign',
            'pool_id': str((key or {}).get('pool_id') or ''),
            'key_id': int((key or {}).get('id') or 0),
            'key_name': (key or {}).get('name') or '',
            'sms_key': (key or {}).get('sms_key') or DEFAULT_SMS_KEY,
            'customer_id': (key or {}).get('customer_id'),
        }
        log['key_id'] = g.sms_gw['key_id']
        log['key_name'] = g.sms_gw['key_name']

        caller = log['caller_number']
        peer = log['callee_number']
        body = str(d.get('text') or d.get('content') or d.get('body') or '').strip()
        if not request_id:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': 'requestId 必填'})
            return _ufi_resp(request_id, 400, 'requestId 必填')
        if not peer:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': 'calleeNumber 必填'})
            return _ufi_resp(request_id, 400, 'calleeNumber 必填')
        if not body:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': 'text 必填'})
            return _ufi_resp(request_id, 400, 'text 必填')
        if not sms.is_valid_sms_addr(peer):
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': 'calleeNumber 无效'})
            return _ufi_resp(request_id, 400, 'calleeNumber 无效')

        pool = str((key or {}).get('pool_id') or d.get('pool_id') or '').strip()
        # 敏感词对所有地址生效；黑名单/静默仅大陆手机号
        kcid = (key or {}).get('customer_id')
        bad = _validate_send(db, peer, body, kcid)
        if bad:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': bad})
            return _ufi_resp(request_id, 400, bad)

        prefer = _pick_imei_by_caller(db, caller, pool or None)
        msg = _do_send_ext(db, peer, body, prefer, pool_id=pool or None, ext_id=request_id, customer_id=kcid)
        cid, cname = _carrier_meta(db, _carrier_of_imei(db, msg.get('imei')))
        log['carrier'], log['carrier_name'] = cid, cname
        log['msg_id'] = str(msg.get('id') or '')
        if msg.get('state') == 'delivered':
            log.update({'http_status': 200, 'result_code': 200, 'result_msg': '发送成功',
                        'resp_summary': {'code': 200, 'data': str(msg.get('id') or '')}})
            return _ufi_resp(request_id, 200, '发送成功', data=str(msg.get('id') or ''))
        if '无可用' in (msg.get('err') or ''):
            em = msg.get('err') or '无可用短信通道'
            log.update({'http_status': 500, 'result_code': 500, 'result_msg': em})
            return _ufi_resp(request_id, 500, em, http_status=500)
        em = msg.get('err') or '发送失败'
        log.update({'http_status': 500, 'result_code': 500, 'result_msg': em})
        return _ufi_resp(request_id, 500, em, http_status=500)
    except Exception as ex:
        db.rollback()
        db.flush()
        log.update({'http_status': 500, 'result_code': 500, 'result_msg': '系统错误',
                    'resp_summary': str(ex)[:200]})
        try:
            debugException = __import__('shared', fromlist=['debugException']).debugException
            debugException(ex)
        except Exception:
            pass
        return _ufi_resp(request_id, 500, '系统错误')
    finally:
        log['duration_ms'] = int((time.time() - t0) * 1000)
        write_api_log(log)
        db.close()


@api.route(GW_BASE + '/send', methods=['POST'])
@sms_gw_auth
def gw_send():
    """单发（兼容旧字段 to/content；支持 Bearer 或 ts+sign）。"""
    t0 = time.time()
    d0 = getRequestData() or {}
    log = {
        'direction': 'in', 'api_name': 'send', 'method': 'POST',
        'path': request.path if has_request_context() else GW_BASE + '/send',
        'request_id': str(d0.get('requestId') or d0.get('ext_id') or ''),
        'caller_number': _norm_phone(d0.get('callerNumber') or ''),
        'callee_number': _norm_phone(d0.get('calleeNumber') or d0.get('to') or ''),
        'key_id': int((getattr(g, 'sms_gw', {}) or {}).get('key_id') or 0),
        'key_name': str((getattr(g, 'sms_gw', {}) or {}).get('key_name') or ''),
        'remote': _remote_of_request(),
        'sms_body': str(d0.get('content') or d0.get('text') or d0.get('body') or ''),
        'req_summary': {
            'to': d0.get('to') or d0.get('calleeNumber') or '',
            'content': str(d0.get('content') or d0.get('text') or d0.get('body') or ''),
        },
        'http_status': 500, 'result_code': 500, 'result_msg': '',
    }
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        d = dict(d0)
        # 文档字段别名
        if d.get('calleeNumber') and not _to_of(d):
            d = dict(d, to=d.get('calleeNumber'))
        if d.get('text') and not _body_of(d):
            d = dict(d, content=d.get('text'))
        peer = _to_of(d)
        body = _body_of(d)
        log['callee_number'] = peer or log['callee_number']
        pool, err = _resolve_pool(d)
        if err:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': err})
            return createApiResponse(status_code=400, msg=err)
        kcid = g.sms_gw.get('customer_id', sms._CID_UNSET)
        bad = _validate_send(db, peer, body, kcid)
        if bad:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': bad})
            return createApiResponse(status_code=400, msg=bad)
        prefer = _pick_imei_by_caller(db, d.get('callerNumber') or '', pool or None)
        if g.sms_gw.get('mode') in ('apikey', 'sign') and d.get('imei') and not prefer:
            prefer = None
        msg = _do_send_ext(db, peer, body, prefer, pool_id=pool or None,
                           ext_id=d.get('requestId') or d.get('ext_id') or d.get('msgid') or '',
                           customer_id=kcid)
        cid, cname = _carrier_meta(db, _carrier_of_imei(db, msg.get('imei')))
        log['carrier'], log['carrier_name'] = cid, cname
        log['msg_id'] = str(msg.get('id') or '')
        no_ch = '无可用' in (msg.get('err') or '')
        ok = msg.get('state') == 'delivered'
        log.update({
            'http_status': 503 if no_ch else 200,
            'result_code': 200 if ok else (503 if no_ch else 500),
            'result_msg': 'ok' if ok else (msg.get('err') or msg.get('state') or ''),
            'resp_summary': {'id': msg.get('id'), 'state': msg.get('state')},
        })
        return createApiResponse(
            msg='ok' if ok else (msg.get('err') or msg.get('state')),
            data=[_msg_view(msg)],
            status_code=503 if no_ch else StatusCodes.HTTP_OK
        )
    except Exception as ex:
        db.rollback()
        db.flush()
        log.update({'http_status': 500, 'result_code': 500, 'result_msg': 'error',
                    'resp_summary': str(ex)[:200]})
        return showApiError(ex)
    finally:
        log['duration_ms'] = int((time.time() - t0) * 1000)
        write_api_log(log)
        db.close()


@api.route(GW_BASE + '/batch', methods=['POST'])
@sms_gw_auth
def gw_batch():
    """批量发送：创建异步群发任务（后台匀速出队）。"""
    t0 = time.time()
    d = getRequestData() or {}
    log = {
        'direction': 'in', 'api_name': 'batch', 'method': 'POST',
        'path': request.path if has_request_context() else GW_BASE + '/batch',
        'request_id': str(d.get('requestId') or d.get('ext_id') or ''),
        'key_id': int((getattr(g, 'sms_gw', {}) or {}).get('key_id') or 0),
        'key_name': str((getattr(g, 'sms_gw', {}) or {}).get('key_name') or ''),
        'remote': _remote_of_request(),
        'req_summary': {'pool_id': d.get('pool_id') or '', 'name': d.get('name') or ''},
        'http_status': 500, 'result_code': 500, 'result_msg': '',
    }
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        sms._ensure_worker()
        body = _body_of(d)
        if not body:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': '短信内容为空'})
            return createApiResponse(status_code=400, msg='短信内容为空')
        pool, err = _resolve_pool(d)
        if err:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': err})
            return createApiResponse(status_code=400, msg=err)
        if not pool:
            em = '批量发送必须指定 pool_id（或使用已绑定号码池的 API Key）'
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': em})
            return createApiResponse(status_code=400, msg=em)

        raw = d.get('tos') or d.get('mobiles') or d.get('phones') or d.get('recipients') or d.get('rcpts') or []
        rcpts = sms._parse_task_rcpts(raw)
        if not rcpts:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': '收件号码为空'})
            return createApiResponse(status_code=400, msg='收件号码为空')
        if len(rcpts) > 5000:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': '单次批量最多 5000 个号码'})
            return createApiResponse(status_code=400, msg='单次批量最多 5000 个号码')
        log['callee_number'] = (rcpts[0].get('phone') if rcpts else '') or ''
        log['sms_body'] = body
        log['req_summary'] = {
            'pool_id': pool, 'total': len(rcpts),
            'content': body, 'first': log['callee_number'],
        }

        hits = [w[0] for w in db.execute(text("SELECT word FROM dsip_ufi_sms_word")).all()
                if w[0] and w[0] in body]
        if hits:
            em = '命中敏感词：' + '、'.join(hits)
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': em})
            return createApiResponse(status_code=400, msg=em)

        black = {r[0] for r in db.execute(text("SELECT num FROM dsip_ufi_sms_black")).all()}
        kept = [x for x in rcpts if x['phone'] not in black]
        skipped = len(rcpts) - len(kept)
        if not kept:
            log.update({'http_status': 400, 'result_code': 400, 'result_msg': '全部号码在黑名单中'})
            return createApiResponse(status_code=400, msg='全部号码在黑名单中')

        pool_chs = [c for c in sms._channels(db) if c.get('pool') == pool and c['state'] == 'ok']
        if not pool_chs:
            em = '号码池 %s 无可用短信通道' % pool
            log.update({'http_status': 503, 'result_code': 503, 'result_msg': em})
            return createApiResponse(status_code=503, msg=em)

        name = str(d.get('name') or ('API批量·' + datetime.now().strftime('%m%d %H:%M')))[:128]
        rate = max(1, min(120, int(d.get('rate') or 20)))
        per_hour = max(1, min(2000, int(d.get('per_hour') or 40)))
        now = datetime.now()
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_task "
            "(name,tpl_id,body,rcpts,rate,per_hour,policy_id,pool_id,total,state,note,start_at,created) "
            "VALUES (:n,'',:b,:r,:rate,:ph,0,:pool,:total,'running',:note,NULL,:now)"
        ), {
            'n': name, 'b': body, 'r': json_dumps_rcpts(kept),
            'rate': rate, 'ph': per_hour, 'pool': pool, 'total': len(kept),
            'note': 'gateway·%s·跳过黑名单%d' % (g.sms_gw.get('mode'), skipped),
            'now': now,
        })
        tid = db.execute(text("SELECT MAX(id) FROM dsip_ufi_sms_task")).scalar()
        db.commit()
        log.update({
            'http_status': 200, 'result_code': 200, 'result_msg': '批量任务已创建',
            'msg_id': str(tid or ''),
            'resp_summary': {'task_id': tid, 'total': len(kept), 'skipped_black': skipped},
        })
        return createApiResponse(msg='批量任务已创建', data=[{
            'task_id': int(tid),
            'name': name,
            'total': len(kept),
            'skipped_black': skipped,
            'pool_id': pool,
            'state': 'running',
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        log.update({'http_status': 500, 'result_code': 500, 'result_msg': 'error',
                    'resp_summary': str(ex)[:200]})
        return showApiError(ex)
    finally:
        log['duration_ms'] = int((time.time() - t0) * 1000)
        write_api_log(log)
        db.close()


def json_dumps_rcpts(kept):
    return json.dumps(kept, ensure_ascii=False)


@api.route(GW_BASE + '/message/<int:mid>', methods=['GET'])
@sms_gw_auth
def gw_message(mid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        row = db.execute(text("SELECT * FROM dsip_ufi_sms_msg WHERE id=:i"), {'i': mid}).mappings().first()
        db.commit()
        if not row:
            return createApiResponse(status_code=404, msg='消息不存在')
        return createApiResponse(msg='ok', data=[_msg_view(dict(row))])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(GW_BASE + '/messages', methods=['GET'])
@sms_gw_auth
def gw_messages():
    """按 id 列表或 ext_id 查询。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        ids_raw = (request.args.get('ids') or '').strip()
        ext = (request.args.get('ext_id') or '').strip()[:64]
        out = []
        if ids_raw:
            ids = [int(x) for x in re.findall(r'\d+', ids_raw)][:100]
            if ids:
                rows = db.execute(text(
                    "SELECT * FROM dsip_ufi_sms_msg WHERE id IN (%s) ORDER BY id DESC" %
                    ','.join(str(i) for i in ids)
                )).mappings().all()
                out = [_msg_view(dict(r)) for r in rows]
        elif ext:
            rows = db.execute(text(
                "SELECT * FROM dsip_ufi_sms_msg WHERE ext_id=:e ORDER BY id DESC LIMIT 50"
            ), {'e': ext}).mappings().all()
            out = [_msg_view(dict(r)) for r in rows]
        else:
            return createApiResponse(status_code=400, msg='请提供 ids 或 ext_id')
        db.commit()
        return createApiResponse(msg='ok', data=out)
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(GW_BASE + '/task/<int:tid>', methods=['GET'])
@sms_gw_auth
def gw_task(tid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        t = db.execute(text("SELECT * FROM dsip_ufi_sms_task WHERE id=:i"), {'i': tid}).mappings().first()
        db.commit()
        if not t:
            return createApiResponse(status_code=404, msg='任务不存在')
        return createApiResponse(msg='ok', data=[{
            'task_id': t['id'],
            'name': t['name'],
            'total': t['total'],
            'sent': t['sent'],
            'fail': t['fail'],
            'state': t['state'],
            'pool_id': t.get('pool_id') or '',
            'note': t.get('note') or '',
            'created': t['created'].strftime('%Y-%m-%d %H:%M:%S') if t.get('created') else '',
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════ API Key CRUD（管理台）
def _new_api_key():
    raw = secrets.token_urlsafe(32)
    return 'sms_' + raw[:40]


@api.route(KEY_BASE, methods=['GET', 'POST'])
@api_security
def sms_apikeys():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        if request.method == 'GET':
            frag, fp = sms._scope_and()
            rows = db.execute(text(
                "SELECT id, name, api_key, secret_key, sms_key, key_prefix, pool_id, enabled, note, created, last_used, customer_id "
                "FROM dsip_ufi_sms_apikey WHERE 1=1" + frag + " ORDER BY id DESC"
            ), fp).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
                d['last_used'] = d['last_used'].strftime('%Y-%m-%d %H:%M:%S') if d.get('last_used') else ''
                full = d.get('api_key') or ''
                d['api_key_masked'] = (full[:10] + '…' + full[-4:]) if len(full) > 14 else full
                # 管理台需要可编辑完整密钥，列表返回明文（仅登录会话可访问）
                out.append(d)
            db.commit()
            return createApiResponse(msg='apikeys', data=out)

        d = getRequestData() or {}
        name = str(d.get('name') or '').strip()[:64]
        if not name:
            return createApiResponse(error='http', status_code=400, msg='请填写应用名称')
        pool = str(d.get('pool_id') or '').strip()[:16]
        note = str(d.get('note') or '').strip()[:255]
        key = str(d.get('api_key') or '').strip() or _new_api_key()
        if len(key) < 8:
            return createApiResponse(error='http', status_code=400, msg='api_key 至少 8 位')
        exists = db.execute(text(
            "SELECT id FROM dsip_ufi_sms_apikey WHERE api_key=:k LIMIT 1"
        ), {'k': key}).scalar()
        if exists:
            return createApiResponse(error='http', status_code=409, msg='api_key 已存在，请换一个')
        secret = str(d.get('secret_key') or key).strip()[:128]
        sms_key = str(d.get('sms_key') or DEFAULT_SMS_KEY).strip()[:128]
        now = datetime.now()
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_apikey "
            "(name, api_key, secret_key, sms_key, key_prefix, pool_id, enabled, note, customer_id, created) "
            "VALUES (:n, :k, :sk, :mk, :p, :pool, 1, :note, :cid, :now)"
        ), {'n': name, 'k': key, 'sk': secret, 'mk': sms_key, 'p': key[:10],
            'pool': pool, 'note': note, 'cid': sms._stamp_cid(), 'now': now})
        kid = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
        if not kid:
            kid = db.execute(text(
                "SELECT id FROM dsip_ufi_sms_apikey WHERE api_key=:k LIMIT 1"
            ), {'k': key}).scalar()
        db.commit()
        return createApiResponse(msg='API Key 已创建', data=[{
            'id': int(kid or 0),
            'name': name,
            'api_key': key,
            'secret_key': secret,
            'sms_key': sms_key,
            'pool_id': pool,
            'note': note,
            'enabled': 1,
            'created': now.strftime('%Y-%m-%d %H:%M:%S'),
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(LOG_BASE, methods=['GET'])
@api_security
def sms_api_logs():
    """开放 API 调用日志：客户调用我方 + 我方推送客户，支持分页与筛选。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)

        def _parse_day(s, end=False):
            s = str(s or '').strip()
            if not s:
                return None
            for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
                try:
                    dt = datetime.strptime(s[:19], fmt)
                    if end and fmt == '%Y-%m-%d':
                        dt = dt.replace(hour=23, minute=59, second=59)
                    return dt
                except ValueError:
                    continue
            return None

        date_from = _parse_day(request.args.get('date_from'))
        date_to = _parse_day(request.args.get('date_to'), end=True)
        caller = _norm_phone(request.args.get('caller') or request.args.get('caller_number') or '')
        callee = _norm_phone(request.args.get('callee') or request.args.get('callee_number') or '')
        carrier = str(request.args.get('carrier') or '').strip()[:16]
        direction = str(request.args.get('dir') or request.args.get('direction') or '').strip().lower()
        api_name = str(request.args.get('api') or request.args.get('api_name') or '').strip()[:32]
        q = str(request.args.get('q') or '').strip()[:64]
        try:
            page = max(1, int(request.args.get('page') or 1))
        except (TypeError, ValueError):
            page = 1
        try:
            size = max(1, min(100, int(request.args.get('size') or 15)))
        except (TypeError, ValueError):
            size = 15

        where = ['1=1']
        params = {}
        if date_from:
            where.append('created >= :df')
            params['df'] = date_from
        if date_to:
            where.append('created <= :dt')
            params['dt'] = date_to
        if caller:
            where.append('caller_number LIKE :caller')
            params['caller'] = '%' + caller + '%'
        if callee:
            where.append('callee_number LIKE :callee')
            params['callee'] = '%' + callee + '%'
        if carrier:
            where.append('carrier = :carrier')
            params['carrier'] = carrier
        if direction in ('in', 'out'):
            where.append('direction = :dir')
            params['dir'] = direction
        if api_name:
            where.append('api_name = :api')
            params['api'] = api_name
        if q:
            where.append(
                '(request_id LIKE :q OR msg_id LIKE :q OR result_msg LIKE :q OR path LIKE :q OR key_name LIKE :q)'
            )
            params['q'] = '%' + q + '%'

        wh = ' AND '.join(where)
        total = int(db.execute(text(
            'SELECT COUNT(*) FROM dsip_ufi_sms_api_log WHERE ' + wh
        ), params).scalar() or 0)
        pages = max(1, (total + size - 1) // size)
        if page > pages:
            page = pages
        offset = (page - 1) * size
        params['lim'] = size
        params['off'] = offset
        rows = db.execute(text(
            'SELECT * FROM dsip_ufi_sms_api_log WHERE ' + wh +
            ' ORDER BY id DESC LIMIT :lim OFFSET :off'
        ), params).mappings().all()
        items = []
        for r in rows:
            d = dict(r)
            d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
            if not d.get('sms_body'):
                d['sms_body'] = _sms_body_from_summary(d.get('req_summary'))
            items.append(d)
        carriers = list_carriers(db)
        db.commit()
        return createApiResponse(msg='apilogs', data=[{
            'list': items,
            'total': total,
            'page': page,
            'pages': pages,
            'size': size,
            'carriers': [{'carrier': c['carrier'], 'name': c['name']} for c in carriers],
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(CARRIER_BASE, methods=['GET'])
@api_security
def sms_carriers_list():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        out = list_carriers(db)
        db.commit()
        return createApiResponse(msg='carriers', data=out)
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(CARRIER_BASE + '/<carrier>', methods=['PUT', 'POST'])
@api_security
def sms_carrier_save(carrier):
    """保存运营商短信推送地址（MO / 状态报告）。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        cid = re.sub(r'[^\w\-]', '', str(carrier or ''))[:16]
        if not cid:
            return createApiResponse(status_code=400, msg='运营商 ID 无效')
        d = getRequestData() or {}
        mo = str(d.get('mo_url') or '').strip()[:512]
        report = str(d.get('report_url') or '').strip()[:512]
        for label, u in (('客户短信推送地址', mo), ('短信状态推送地址', report)):
            if u and not _URL_RE.match(u):
                return createApiResponse(status_code=400, msg='%s 须以 http:// 或 https:// 开头' % label)
        name = str(d.get('name') or '').strip()[:128]
        if not name:
            names = sms._carrier_name_map(db)
            name = names.get(cid) or ('运营商 #' + cid)
        secret = str(d.get('secret_key') or '').strip()[:128]
        sms_key = str(d.get('sms_key') or '').strip()[:128]
        enabled = 0 if d.get('enabled') in (0, '0', False, 'false') else 1
        now = datetime.now()
        db.execute(text("""
            INSERT INTO dsip_ufi_sms_carrier
              (carrier, name, mo_url, report_url, secret_key, sms_key, enabled, updated_at)
            VALUES (:c, :n, :mo, :rp, :sk, :mk, :e, :now)
            ON DUPLICATE KEY UPDATE name=:n2, mo_url=:mo2, report_url=:rp2,
              secret_key=:sk2, sms_key=:mk2, enabled=:e2, updated_at=:now2
        """), {
            'c': cid, 'n': name, 'mo': mo, 'rp': report, 'sk': secret, 'mk': sms_key,
            'e': enabled, 'now': now,
            'n2': name, 'mo2': mo, 'rp2': report, 'sk2': secret, 'mk2': sms_key,
            'e2': enabled, 'now2': now,
        })
        # 新配置地址后，重试此前因「未配置」而跳过的推送
        if mo:
            db.execute(text(
                "UPDATE dsip_ufi_sms_msg m JOIN dsip_ufi_pool p ON p.imei=m.imei "
                "SET m.push_mo=0 WHERE m.dir='in' AND m.push_mo=2 AND p.carrier=:c AND m.created>=:s"
            ), {'c': cid, 's': now - timedelta(days=2)})
        if report:
            db.execute(text(
                "UPDATE dsip_ufi_sms_msg m JOIN dsip_ufi_pool p ON p.imei=m.imei "
                "SET m.push_report=0 WHERE m.dir='out' AND m.push_report=2 "
                "AND m.state IN ('delivered','failed') AND p.carrier=:c AND m.created>=:s"
            ), {'c': cid, 's': now - timedelta(days=2)})
        db.commit()
        return createApiResponse(msg='运营商推送地址已保存', data=[{
            'carrier': cid, 'name': name, 'mo_url': mo, 'report_url': report,
            'secret_key': secret, 'sms_key': sms_key, 'enabled': enabled,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(KEY_BASE + '/<int:kid>', methods=['POST', 'PUT', 'DELETE'])
@api_security
def sms_apikey_act(kid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_gw_tables(db)
        row = db.execute(text("SELECT * FROM dsip_ufi_sms_apikey WHERE id=:i"), {'i': kid}).mappings().first()
        if not row or not sms._row_owned(row):
            return createApiResponse(status_code=404, msg='API Key 不存在')

        if request.method == 'DELETE':
            db.execute(text("DELETE FROM dsip_ufi_sms_apikey WHERE id=:i"), {'i': kid})
            db.commit()
            return createApiResponse(msg='已删除')

        d = getRequestData() or {}
        act = str(d.get('action') or '').lower()
        if act == 'toggle' or request.method == 'POST' and 'enabled' not in d and act == 'toggle':
            db.execute(text("UPDATE dsip_ufi_sms_apikey SET enabled=1-enabled WHERE id=:i"), {'i': kid})
            db.commit()
            return createApiResponse(msg='状态已更新')
        if act == 'del':
            db.execute(text("DELETE FROM dsip_ufi_sms_apikey WHERE id=:i"), {'i': kid})
            db.commit()
            return createApiResponse(msg='已删除')

        # update fields
        name = str(d.get('name') if d.get('name') is not None else row['name'])[:64]
        pool = str(d.get('pool_id') if d.get('pool_id') is not None else row['pool_id'])[:16]
        note = str(d.get('note') if d.get('note') is not None else row['note'])[:255]
        enabled = row['enabled'] if d.get('enabled') is None else (1 if d.get('enabled') else 0)
        secret = str(d.get('secret_key') if d.get('secret_key') is not None else row.get('secret_key') or '')[:128]
        sms_key = str(d.get('sms_key') if d.get('sms_key') is not None else row.get('sms_key') or '')[:128]
        db.execute(text(
            "UPDATE dsip_ufi_sms_apikey SET name=:n, pool_id=:p, note=:note, enabled=:e, "
            "secret_key=:sk, sms_key=:mk WHERE id=:i"
        ), {'n': name, 'p': pool, 'note': note, 'e': int(enabled),
            'sk': secret, 'mk': sms_key, 'i': kid})
        db.commit()
        return createApiResponse(msg='已更新')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════ 模拟客户推送接收
def _sandbox_remote(default=''):
    if default:
        return str(default)[:64]
    if not has_request_context():
        return ''
    try:
        return (request.headers.get('X-Forwarded-For') or request.remote_addr or '')[:64]
    except Exception:
        return ''


def _sandbox_store(kind, payload, remote=''):
    """保存一条推送并尝试验签 / 解密（仅展示，不阻断接收）。持久化到 DB。"""
    d = dict(payload or {}) if isinstance(payload, dict) else {'raw': payload}
    now = datetime.now()
    entry = {
        'id': str(uuid.uuid4()),
        'kind': kind,  # mo | report
        'at': now.strftime('%Y-%m-%d %H:%M:%S'),
        'payload': d,
        'sign_ok': None,
        'sms_plain': '',
        'remote': _sandbox_remote(remote),
    }
    # 用文档默认密钥尝试验签；运营商覆盖密钥时可能不匹配，页面上也会本地再验
    try:
        got = str(d.get('sign') or '').strip().lower()
        if got and d.get('ts') is not None:
            expect = create_sign(d, DEFAULT_SECRET_KEY).lower()
            entry['sign_ok'] = secrets.compare_digest(expect, got)
            if not entry['sign_ok']:
                # 再试所有启用 Key 的 secret
                db = DummySession()
                try:
                    db = startSession()
                    _ensure_gw_tables(db)
                    for row in _all_enabled_keys(db):
                        sk = row.get('secret_key') or row.get('api_key') or ''
                        if secrets.compare_digest(create_sign(d, sk).lower(), got):
                            entry['sign_ok'] = True
                            break
                except Exception:
                    pass
                finally:
                    db.close()
    except Exception:
        entry['sign_ok'] = None
    try:
        enc = d.get('smsBody')
        if enc:
            entry['sms_plain'] = xor_crypt(enc, False, DEFAULT_SMS_KEY) or ''
            if entry['sms_plain'] == enc:
                db = DummySession()
                try:
                    db = startSession()
                    _ensure_gw_tables(db)
                    for row in _all_enabled_keys(db):
                        mk = row.get('sms_key') or DEFAULT_SMS_KEY
                        plain = xor_crypt(enc, False, mk)
                        if plain and plain != enc:
                            entry['sms_plain'] = plain
                            break
                except Exception:
                    pass
                finally:
                    db.close()
    except Exception:
        pass
    with _SANDBOX_LOCK:
        _SANDBOX_INBOX.appendleft(entry)
    # DB 持久化（失败不影响接收应答）
    db = DummySession()
    try:
        db = startSession()
        _ensure_gw_tables(db)
        sign_ok = entry.get('sign_ok')
        db.execute(text(
            "INSERT INTO dsip_ufi_sms_sandbox_inbox "
            "(id, kind, at, payload, sign_ok, sms_plain, remote) "
            "VALUES (:id, :k, :at, :p, :so, :sp, :r)"
        ), {
            'id': entry['id'], 'k': entry['kind'], 'at': now,
            'p': json.dumps(d, ensure_ascii=False),
            'so': (None if sign_ok is None else (1 if sign_ok else 0)),
            'sp': entry.get('sms_plain') or '',
            'r': entry.get('remote') or '',
        })
        # 只保留最近 200 条（单独执行，失败不影响本条入库）
        try:
            db.execute(text(
                "DELETE FROM dsip_ufi_sms_sandbox_inbox WHERE id NOT IN ("
                "  SELECT id FROM ("
                "    SELECT id FROM dsip_ufi_sms_sandbox_inbox ORDER BY at DESC LIMIT 200"
                "  ) keep_rows"
                ")"
            ))
        except Exception:
            pass
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()
    return entry


def _sandbox_list(kind='', limit=50):
    """优先读 DB；失败时回落内存。"""
    items = []
    db = DummySession()
    try:
        db = startSession()
        _ensure_gw_tables(db)
        sql = (
            "SELECT id, kind, at, payload, sign_ok, sms_plain, remote "
            "FROM dsip_ufi_sms_sandbox_inbox "
        )
        params = {'lim': limit}
        if kind in ('mo', 'report'):
            sql += "WHERE kind=:k "
            params['k'] = kind
        sql += "ORDER BY at DESC LIMIT :lim"
        rows = db.execute(text(sql), params).mappings().all()
        for r in rows:
            payload = r.get('payload') or '{}'
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode('utf-8', 'ignore')
            try:
                payload_obj = json.loads(payload) if isinstance(payload, str) else (payload or {})
            except Exception:
                payload_obj = {'raw': payload}
            so = r.get('sign_ok')
            items.append({
                'id': r.get('id'),
                'kind': r.get('kind'),
                'at': r['at'].strftime('%Y-%m-%d %H:%M:%S') if r.get('at') else '',
                'payload': payload_obj,
                'sign_ok': None if so is None else bool(so),
                'sms_plain': r.get('sms_plain') or '',
                'remote': r.get('remote') or '',
            })
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        with _SANDBOX_LOCK:
            items = list(_SANDBOX_INBOX)
        if kind in ('mo', 'report'):
            items = [x for x in items if x.get('kind') == kind]
        items = items[:limit]
    finally:
        db.close()
    return items


def _sandbox_clear():
    with _SANDBOX_LOCK:
        _SANDBOX_INBOX.clear()
    db = DummySession()
    try:
        db = startSession()
        _ensure_gw_tables(db)
        db.execute(text("DELETE FROM dsip_ufi_sms_sandbox_inbox"))
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


def _sandbox_customer_ack(payload):
    """按对接文档返回客户侧应答。"""
    d = payload if isinstance(payload, dict) else {}
    sms_id = str(d.get('smsId') or d.get('requestId') or '')
    return jsonify({'smsId': sms_id, 'code': 200, 'comment': 'success'}), 200


@api.route(SANDBOX_MO_PATH, methods=['POST'])
@api.route('/ufi-app/api/ufi/sandbox/mo', methods=['POST'])
@api.route('/api/ufi/sandbox/mo', methods=['POST'])
def sms_sandbox_mo():
    """模拟客户「短信推送地址」：接收平台上行 MO 推送（无需登录）。"""
    d = getRequestData() or {}
    _sandbox_store('mo', d)
    return _sandbox_customer_ack(d)


@api.route(SANDBOX_REPORT_PATH, methods=['POST'])
@api.route('/ufi-app/api/ufi/sandbox/report', methods=['POST'])
@api.route('/api/ufi/sandbox/report', methods=['POST'])
def sms_sandbox_report():
    """模拟客户「短信状态推送地址」：接收平台状态报告（无需登录）。"""
    d = getRequestData() or {}
    _sandbox_store('report', d)
    return _sandbox_customer_ack(d)


@api.route(GW_BASE + '/sandbox/inbox', methods=['GET', 'DELETE'])
@api_security
def sms_sandbox_inbox():
    """模拟对接页拉取 / 清空已接收的推送。"""
    if request.method == 'DELETE':
        _sandbox_clear()
        return createApiResponse(msg='inbox cleared', data=[{'total': 0, 'items': []}])
    kind = str(request.args.get('kind') or '').strip().lower()
    try:
        limit = max(1, min(100, int(request.args.get('limit') or 50)))
    except (TypeError, ValueError):
        limit = 50
    items = _sandbox_list(kind=kind, limit=limit)
    return createApiResponse(msg='sandbox inbox', data=[{
        'total': len(items),
        'mo_url': SANDBOX_MO_PATH,
        'report_url': SANDBOX_REPORT_PATH,
        'items': items,
    }])
