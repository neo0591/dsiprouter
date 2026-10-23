# Device-facing UFI HTTP APIs (UFI API v2.9) plus admin device/config endpoints.

import base64
import hashlib
import hmac
import json
import os
import re
import time
from urllib.parse import urlparse
from flask import jsonify, request, send_file
from sqlalchemy.sql import text
from werkzeug import exceptions as http_exceptions

from database import DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import (
    api,
    _normalize_ufi_imei,
    _normalize_ufi_sim,
    _ufi_auth_domain,
    _ufi_password,
    _upsert_ufi_account,
)
from shared import debugEndpoint, getRequestData
from util.ipc import STATE_SHMEM_NAME, getSharedMemoryDict
import settings


def _require_imei(db, imei):
    from modules.api.acl import ensure_acl_tables, require_owned_imei
    ensure_acl_tables(db)
    require_owned_imei(db, imei)

# fields the device firmware excludes from its SHA-256 sign string (verified against device-side log)
SIGN_SKIP_KEYS = {'sign', 'encryptionType', 'mac', 'simOperator', 'operatorName', 'serviceCellBand', 'cellularSignalRsrp'}
DEFAULT_UFI_SECRET = '123456'
UFI_TS_SKEW_MS = 5 * 60 * 1000


def _device_payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = getRequestData() or {}
    if not isinstance(data, dict):
        return {}
    flat = {}
    for key, value in data.items():
        if isinstance(value, list) and len(value) == 1:
            flat[str(key).strip()] = value[0]
        else:
            flat[str(key).strip()] = value
    return flat


def _field(payload, *names, default=''):
    for name in names:
        if name in payload and payload[name] not in (None, ''):
            return str(payload[name]).strip()
        for key, value in payload.items():
            if str(key).lower() == str(name).lower() and value not in (None, ''):
                return str(value).strip()
    return default


def _flag01(value, default='0'):
    """Normalize device ON/OFF / true/false / 1/0 into '1' or '0'."""
    s = str(value or '').strip().lower()
    if not s:
        return default
    if s in ('1', 'on', 'true', 'yes', 'enable', 'enabled'):
        return '1'
    if s in ('0', 'off', 'false', 'no', 'disable', 'disabled'):
        return '0'
    return default


UFI_DEVICE_COLUMNS = (
    ('lte_status', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('sim_type', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('volte_status', "VARCHAR(8) NOT NULL DEFAULT ''"),
    ('voip_status', "VARCHAR(8) NOT NULL DEFAULT ''"),
    ('ws_status', "VARCHAR(8) NOT NULL DEFAULT ''"),
    ('network_type', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('airplane_mode', "VARCHAR(8) NOT NULL DEFAULT ''"),
    ('signal_level', "VARCHAR(8) NOT NULL DEFAULT ''"),
    ('earfcn', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('linphone_status', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('wfc_status', "VARCHAR(16) NOT NULL DEFAULT ''"),
    ('cpu_use', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('mem_use', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('storage_use', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('build_number', "VARCHAR(64) NOT NULL DEFAULT ''"),
    ('status_json', "MEDIUMTEXT"),
    ('ws_online', "TINYINT NOT NULL DEFAULT 0"),
    ('last_cmd_json', "MEDIUMTEXT"),
    ('pending_settings', "MEDIUMTEXT"),
    ('saved_settings', "MEDIUMTEXT"),
    ('sim_state', "VARCHAR(32) NOT NULL DEFAULT ''"),
    ('claim_status', "TINYINT NOT NULL DEFAULT 0"),
    ('tunnel_ready', "TINYINT NOT NULL DEFAULT 0"),
    ('tunnel_admin_host', "VARCHAR(64) NOT NULL DEFAULT '127.0.0.1'"),
    ('tunnel_admin_port', "INT NOT NULL DEFAULT 8080"),
    ('tunnel_admin_path', "VARCHAR(128) NOT NULL DEFAULT '/'"),
    ('tunnel_json', "MEDIUMTEXT"),
)


def _ensure_ufi_tables(db):
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_config ("
        "id INT UNSIGNED NOT NULL PRIMARY KEY,"
        "secret_key VARCHAR(128) NOT NULL DEFAULT '123456',"
        "auto_provision TINYINT NOT NULL DEFAULT 1,"
        "sip_host VARCHAR(128) NOT NULL DEFAULT '',"
        "sip_port INT NOT NULL DEFAULT 10560,"
        "transport VARCHAR(8) NOT NULL DEFAULT 'UDP',"
        "base_url VARCHAR(255) NOT NULL DEFAULT '',"
        "ws_url VARCHAR(255) NOT NULL DEFAULT ''"
        ")"
    ))
    cfg_cols = {r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_config")).all()}
    if 'secret_pending' not in cfg_cols:
        db.execute(text("ALTER TABLE dsip_ufi_config ADD COLUMN secret_pending TINYINT NOT NULL DEFAULT 0"))
    row = db.execute(text("SELECT id FROM dsip_ufi_config WHERE id = 1")).first()
    if row is None:
        db.execute(text(
            "INSERT INTO dsip_ufi_config (id, secret_key, auto_provision, sip_host, sip_port, transport) "
            "VALUES (1, :secret, 1, :host, 10560, 'UDP')"
        ), {
            'secret': str(getattr(settings, 'UFI_API_SECRET', '') or DEFAULT_UFI_SECRET),
            'host': str(getattr(settings, 'EXTERNAL_IP_ADDR', '') or ''),
        })
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_device ("
        "id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "sn VARCHAR(64) NOT NULL DEFAULT '',"
        "imsi VARCHAR(32) NOT NULL DEFAULT '',"
        "sim_number VARCHAR(32) NOT NULL DEFAULT '',"
        "agent_type VARCHAR(64) NOT NULL DEFAULT '',"
        "sip_reg_status VARCHAR(32) NOT NULL DEFAULT '',"
        "cellular_status VARCHAR(32) NOT NULL DEFAULT '',"
        "cellular_network VARCHAR(64) NOT NULL DEFAULT '',"
        "wlan_status VARCHAR(16) NOT NULL DEFAULT '',"
        "last_ip VARCHAR(64) NOT NULL DEFAULT '',"
        "last_msg_type VARCHAR(64) NOT NULL DEFAULT '',"
        "last_seen DATETIME NULL,"
        "provisioned TINYINT NOT NULL DEFAULT 0,"
        "raw_json MEDIUMTEXT,"
        "UNIQUE KEY imei_idx (imei)"
        ")"
    ))
    existing = {row[0] for row in db.execute(text("SHOW COLUMNS FROM dsip_ufi_device")).all()}
    for name, spec in UFI_DEVICE_COLUMNS:
        if name not in existing:
            db.execute(text("ALTER TABLE dsip_ufi_device ADD COLUMN {} {}".format(name, spec)))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_event ("
        "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "msg_type VARCHAR(64) NOT NULL DEFAULT '',"
        "payload MEDIUMTEXT,"
        "created_at DATETIME NOT NULL,"
        "KEY imei_time_idx (imei, created_at)"
        ")"
    ))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_alert ("
        "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "kind VARCHAR(32) NOT NULL DEFAULT '',"
        "level VARCHAR(8) NOT NULL DEFAULT 'warn',"
        "detail VARCHAR(255) NOT NULL DEFAULT '',"
        "offline_from DATETIME NULL,"
        "offline_to DATETIME NULL,"
        "created_at DATETIME NOT NULL,"
        "KEY imei_time_idx (imei, created_at)"
        ")"
    ))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_sms ("
        "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "sms_id VARCHAR(64) NOT NULL DEFAULT '',"
        "sms_type VARCHAR(16) NOT NULL DEFAULT '',"
        "sms_body TEXT,"
        "smsm_tel VARCHAR(64) NOT NULL DEFAULT '',"
        "sms_timestamp VARCHAR(64) NOT NULL DEFAULT '',"
        "result_code VARCHAR(16) NOT NULL DEFAULT '',"
        "fail_result VARCHAR(255) NOT NULL DEFAULT '',"
        "payload MEDIUMTEXT,"
        "created_at DATETIME NOT NULL,"
        "KEY imei_time_idx (imei, created_at)"
        ")"
    ))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_call ("
        "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "trace_id VARCHAR(64) NOT NULL DEFAULT '',"
        "dir VARCHAR(16) NOT NULL DEFAULT '',"
        "peer VARCHAR(64) NOT NULL DEFAULT '',"
        "answered TINYINT NOT NULL DEFAULT 0,"
        "rejected TINYINT NOT NULL DEFAULT 0,"
        "reject_code INT NOT NULL DEFAULT 0,"
        "duration_sec INT NOT NULL DEFAULT 0,"
        "start_ts VARCHAR(64) NOT NULL DEFAULT '',"
        "end_ts VARCHAR(64) NOT NULL DEFAULT '',"
        "result VARCHAR(32) NOT NULL DEFAULT '',"
        "fail_reason VARCHAR(128) NOT NULL DEFAULT '',"
        "volte_log MEDIUMTEXT,"
        "sip_log MEDIUMTEXT,"
        "payload MEDIUMTEXT,"
        "created_at DATETIME NOT NULL,"
        "KEY imei_time_idx (imei, created_at)"
        ")"
    ))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_file ("
        "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL,"
        "file_name VARCHAR(255) NOT NULL DEFAULT '',"
        "file_size BIGINT NOT NULL DEFAULT 0,"
        "stored_path VARCHAR(512) NOT NULL DEFAULT '',"
        "created_at DATETIME NOT NULL,"
        "KEY imei_time_idx (imei, id)"
        ")"
    ))


def _load_ufi_config(db):
    _ensure_ufi_tables(db)
    row = db.execute(text(
        "SELECT secret_key, auto_provision, sip_host, sip_port, transport, base_url, ws_url "
        "FROM dsip_ufi_config WHERE id = 1"
    )).mappings().first()
    cfg = dict(row) if row else {}
    sip_host = str(cfg.get('sip_host') or getattr(settings, 'EXTERNAL_IP_ADDR', '') or _ufi_auth_domain())
    sip_port = int(cfg.get('sip_port') or 10560)
    gui_port = str(getattr(settings, 'DSIP_PORT', '') or '5000')
    default_base = str(cfg.get('base_url') or '').strip()
    default_ws = str(cfg.get('ws_url') or '').strip()
    if not default_base:
        default_base = 'https://{}:{}/ufi-app'.format(sip_host, gui_port)
    if not default_ws:
        default_ws = 'wss://{}:{}/ufi-app/ufi/websocket'.format(sip_host, gui_port)
    secret = str(cfg.get('secret_key') or '').strip()
    pending = 1 if secret in ('', '123456') else 0
    try:
        db.execute(text("UPDATE dsip_ufi_config SET secret_pending=:p WHERE id=1"), {'p': pending})
    except Exception:
        pass
    return {
        'secret_key': secret,
        'secret_pending': bool(pending),
        'auto_provision': bool(int(cfg.get('auto_provision') or 0)),
        'sip_host': sip_host,
        'sip_port': sip_port,
        'transport': str(cfg.get('transport') or 'UDP').upper(),
        'base_url': default_base.rstrip('/'),
        'ws_url': default_ws,
    }


def _canonical_sign_string(payload, secret):
    parts = []
    for key in sorted(payload.keys(), key=lambda item: str(item)):
        if str(key) in SIGN_SKIP_KEYS:
            continue
        value = payload[key]
        if value is None or isinstance(value, (dict, list)):
            continue
        parts.append('{}={}'.format(key, value))
    return '{}&secret_key={}'.format('&'.join(parts), secret)


def _sign_fail_reason(payload, secret):
    """Return None if the Hutool SHA-256 sign is valid; otherwise a device-facing comment."""
    if not str(secret or '').strip():
        return 'secret not configured'
    raw_ts = str(payload.get('ts') or '0')
    try:
        ts = int(float(raw_ts))
    except (TypeError, ValueError):
        return 'ts invalid'
    now_ms = int(time.time() * 1000)
    if ts < 10 ** 12:
        ts *= 1000
    if abs(now_ms - ts) > UFI_TS_SKEW_MS:
        return 'ts expired'
    expected = hashlib.sha256(_canonical_sign_string(payload, secret).encode('utf-8')).hexdigest()
    given = str(payload.get('sign') or '').strip().lower()
    if not given or not hmac.compare_digest(expected, given):
        return 'sign invalid'
    return None


def _sign_ok(payload, secret):
    return _sign_fail_reason(payload, secret) is None


def _client_ip():
    return (
        request.headers.get('X-Real-IP')
        or (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        or request.remote_addr
        or ''
    )


def _device_error(payload, code, comment):
    return jsonify({
        'code': code,
        'msgType': _field(payload, 'msgType') or 'Ufi-Error',
        'requestId': _field(payload, 'requestId'),
        'comment': comment,
        'lteStatus': 'failed',
    }), 200


def _upsert_device(db, payload, extra=None):
    imei = _field(payload, 'imei')
    if not imei:
        return None
    extra = extra or {}
    sim = extra.get('sim_number') or _field(payload, 'simNumber', 'sim_number')
    voip = _field(payload, 'voipRegisterStatus', 'sipregeststatus')
    wfc_raw = _field(payload, 'wfcStatus', 'wlanCallingStatus', 'wifiCallingStatus')
    values = {
        'imei': imei,
        'sn': extra.get('sn') or _field(payload, 'sn'),
        'imsi': extra.get('imsi') or _field(payload, 'imsi', 'Imsi'),
        'sim_number': sim,
        'agent_type': extra.get('agent_type') or _field(payload, 'agentType'),
        'sip_reg_status': extra.get('sip_reg_status') or voip or _field(payload, 'sipregeststatus', 'sipRegestStatus'),
        'cellular_status': extra.get('cellular_status') or _field(payload, 'cellularStatus'),
        'cellular_network': extra.get('cellular_network') or _field(payload, 'cellularNetwork', 'ellularNetwork'),
        'wlan_status': extra.get('wlan_status') or _field(payload, 'wlanStatus'),
        'last_ip': extra.get('last_ip') or '',
        'last_msg_type': extra.get('last_msg_type') or _field(payload, 'msgType'),
        'provisioned': int(extra.get('provisioned') or 0),
        'lte_status': _field(payload, 'lteStatus'),
        'sim_type': _field(payload, 'simType'),
        'volte_status': _field(payload, 'volteRegisterStatus'),
        'voip_status': _field(payload, 'voipRegisterStatus'),
        'ws_status': _field(payload, 'websocketStatus'),
        'network_type': _field(payload, 'networkType'),
        'airplane_mode': _field(payload, 'airplaneMode'),
        'signal_level': _field(payload, 'cellularSignalLevel'),
        'earfcn': _field(payload, 'serviceCellEARFCN'),
        'linphone_status': _field(payload, 'linphoneProcessStatus'),
        'wfc_status': _flag01(wfc_raw, '0') if wfc_raw else '',
        'cpu_use': _field(payload, 'cpuUseRate'),
        'mem_use': _field(payload, 'memoryUseRate'),
        'storage_use': _field(payload, 'storageUseRate'),
        'build_number': _field(payload, 'buildNumber'),
        'sim_state': _field(payload, 'simState'),
        'raw_json': json.dumps(payload, ensure_ascii=False, default=str)[:16000],
        'status_json': json.dumps(payload, ensure_ascii=False, default=str)[:16000],
    }
    try:
        from modules.api.acl import ensure_acl_tables, resolve_device_customer
        ensure_acl_tables(db)
        values['customer_id'] = resolve_device_customer(db, imei, values.get('sim_number') or '')
    except Exception:
        values['customer_id'] = None
    if not values['last_ip']:
        try:
            values['last_ip'] = _client_ip()
        except Exception:
            values['last_ip'] = extra.get('last_ip') or ''
    db.execute(text(
        "INSERT INTO dsip_ufi_device ("
        "imei, sn, imsi, sim_number, agent_type, sip_reg_status, cellular_status, "
        "cellular_network, wlan_status, last_ip, last_msg_type, last_seen, provisioned, raw_json, "
        "lte_status, sim_type, volte_status, voip_status, ws_status, network_type, airplane_mode, "
        "signal_level, earfcn, linphone_status, wfc_status, cpu_use, mem_use, storage_use, "
        "build_number, status_json, sim_state, customer_id, claim_status) "
        "VALUES (:imei, :sn, :imsi, :sim_number, :agent_type, :sip_reg_status, :cellular_status, "
        ":cellular_network, :wlan_status, :last_ip, :last_msg_type, NOW(), :provisioned, :raw_json, "
        ":lte_status, :sim_type, :volte_status, :voip_status, :ws_status, :network_type, :airplane_mode, "
        ":signal_level, :earfcn, :linphone_status, :wfc_status, :cpu_use, :mem_use, :storage_use, "
        ":build_number, :status_json, :sim_state, :customer_id, IF(:customer_id IS NULL, 0, 1)) "
        "ON DUPLICATE KEY UPDATE "
        "sn = IF(:sn = '', sn, :sn), "
        "imsi = IF(:imsi = '', imsi, :imsi), "
        "sim_number = IF(:sim_number = '', sim_number, :sim_number), "
        "agent_type = IF(:agent_type = '', agent_type, :agent_type), "
        "sip_reg_status = IF(:sip_reg_status = '', sip_reg_status, :sip_reg_status), "
        "cellular_status = IF(:cellular_status = '', cellular_status, :cellular_status), "
        "cellular_network = IF(:cellular_network = '', cellular_network, :cellular_network), "
        "wlan_status = IF(:wlan_status = '', wlan_status, :wlan_status), "
        "last_ip = IF(:last_ip = '', last_ip, :last_ip), last_msg_type = :last_msg_type, last_seen = NOW(), "
        "provisioned = IF(IF(customer_id IS NULL, :customer_id, customer_id) IS NULL, 0, GREATEST(provisioned, :provisioned)), raw_json = :raw_json, "
        "lte_status = IF(:lte_status = '', lte_status, :lte_status), "
        "sim_type = IF(:sim_type = '', sim_type, :sim_type), "
        "volte_status = IF(:volte_status = '', volte_status, :volte_status), "
        "voip_status = IF(:voip_status = '', voip_status, :voip_status), "
        "ws_status = IF(:ws_status = '', ws_status, :ws_status), "
        "network_type = IF(:network_type = '', network_type, :network_type), "
        "airplane_mode = IF(:airplane_mode = '', airplane_mode, :airplane_mode), "
        "signal_level = IF(:signal_level = '', signal_level, :signal_level), "
        "earfcn = IF(:earfcn = '', earfcn, :earfcn), "
        "linphone_status = IF(:linphone_status = '', linphone_status, :linphone_status), "
        "wfc_status = IF(:wfc_status = '', wfc_status, :wfc_status), "
        "cpu_use = IF(:cpu_use = '', cpu_use, :cpu_use), "
        "mem_use = IF(:mem_use = '', mem_use, :mem_use), "
        "storage_use = IF(:storage_use = '', storage_use, :storage_use), "
        "build_number = IF(:build_number = '', build_number, :build_number), "
        "sim_state = IF(:sim_state = '', sim_state, :sim_state), "
        "status_json = :status_json, "
        "customer_id = IF(customer_id IS NULL, :customer_id, customer_id), "
        "claim_status = IF(customer_id IS NULL, 0, 1)"
    ), values)
    if extra.get('event'):
        db.execute(text(
            "INSERT INTO dsip_ufi_event (imei, msg_type, payload, created_at) "
            "VALUES (:imei, :msg_type, :payload, NOW())"
        ), {
            'imei': imei,
            'msg_type': values['last_msg_type'],
            'payload': values['raw_json'],
        })
        db.execute(text(
            "DELETE FROM dsip_ufi_event WHERE imei = :imei AND id NOT IN ("
            "SELECT id FROM (SELECT id FROM dsip_ufi_event WHERE imei = :imei ORDER BY id DESC LIMIT 50) t)"
        ), {'imei': imei})
    _ingest_records(db, payload)
    return values


def persist_ufi_payload(payload, extra=None):
    db = DummySession()
    try:
        db = startSession()
        _ensure_ufi_tables(db)
        _upsert_device(db, payload, extra)
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _json_obj(raw):
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_ALERT_KIND_CN = {
    'offline': ('设备离线', 'err', '离线'),
    'online': ('设备恢复在线', 'ok', '恢复'),
    'ws_down': ('心跳保活失败', 'err', '掉线'),
    'ws_up': ('心跳已恢复', 'ok', '恢复'),
    'sip_down': ('SIP 掉注册', 'err', '掉注册'),
    'sip_up': ('SIP 重新注册', 'ok', '注册'),
    'volte_down': ('VoLTE 掉线', 'err', '掉线'),
    'volte_up': ('VoLTE 已恢复', 'ok', '恢复'),
    'cpu_high': ('CPU 高负荷', 'warn', '资源'),
    'cpu_ok': ('CPU 恢复正常', 'ok', '资源'),
    'storage_high': ('存储空间紧张', 'warn', '资源'),
    'sim_bad': ('SIM 卡异常', 'err', 'SIM'),
}


def _format_alert_event(row):
    kind = str(row.get('kind') or '')
    title, level, tag = _ALERT_KIND_CN.get(kind, (kind or '设备告警', str(row.get('level') or 'warn'), '告警'))
    return {
        'imei': row.get('imei') or '',
        'title': title,
        'desc': str(row.get('detail') or title)[:240],
        'kind': level if level in ('ok', 'warn', 'err') else (
            'err' if str(row.get('level')) == 'err' else 'warn'),
        'tag': tag,
        'sn': tag,
        'ts': str(row.get('created_at') or ''),
        'created_at': str(row.get('created_at') or ''),
        'source': 'alert',
    }


def _status_log_summary(payload):
    """把 Ufi-Status-Log-Indication 的 log/result/side 转成可读标题与摘要。"""
    result = str(payload.get('result') or '').upper()
    side = str(payload.get('side') or '').lower()
    log = str(payload.get('log') or '')
    lines = [ln.strip() for ln in log.splitlines() if ln.strip()]
    # 去掉时间前缀，取最有信息量的一行（优先含 reject / state= / send / forward）
    body_lines = []
    for ln in lines:
        m = re.match(r'^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*\|\s*(.*)$', ln)
        body_lines.append((m.group(1) if m else ln).strip())
    pick = ''
    for key in ('call reject', 'reject reason', 'state=END', 'state=ACTIVE', 'state=ALERTING',
                'state=DIALING', 'state=INCOMING', 'cellular send', 'forward SMS',
                'SIP message', 'SIP state='):
        for bl in reversed(body_lines):
            if key.lower() in bl.lower():
                pick = bl
                break
        if pick:
            break
    if not pick and body_lines:
        pick = body_lines[-1]

    tel = ''
    m = re.search(r'tel=([0-9+*#]+)', pick or log)
    if m:
        tel = m.group(1)
    dir_mo = bool(re.search(r'dir=MO\b|dir=Outgoing|call_direction.?=.?out', pick or log, re.I))
    dir_mt = bool(re.search(r'dir=MT\b|dir=Incoming|call_direction.?=.?in', pick or log, re.I))
    direction = '呼出' if dir_mo else ('呼入' if dir_mt else '')

    low = (pick or '').lower()
    if 'call reject' in low or 'reject reason' in low:
        reason = pick
        m = re.search(r'reason=([^;]+)', pick)
        if m:
            reason = m.group(1).strip()
        return '通话未接通', ('拒接 · %s' % reason)[:200], 'warn', '拒接'
    if 'cellular send ok' in low:
        return '短信转发成功', '蜂窝侧发送成功（SIP → VoLTE）', 'ok', '短信'
    if 'cellular send' in low and ('fail' in low or result == 'FAIL'):
        return '短信转发失败', pick[:200] or '蜂窝侧发送失败', 'err', '短信'
    if 'forward sms' in low:
        return '短信转发中', '正在把 SIP 短信转到蜂窝网', 'ok', '短信'
    if 'sip message received' in low:
        return '收到 SIP 短信', pick[:200] or '设备收到 SIP MESSAGE', 'ok', '短信'
    if 'state=dialing' in low:
        return '正在外呼', (('对端 ' + tel) if tel else 'VoLTE 拨号中'), 'ok', '通话'
    if 'state=incoming' in low:
        return '来电振铃', (('主叫 ' + tel) if tel else 'VoLTE 来电'), 'ok', '通话'
    if 'state=alerting' in low:
        return '对方振铃中', (('对端 ' + tel) if tel else '等待接听'), 'ok', '通话'
    if 'state=active' in low:
        return '通话已接通', (('对端 ' + tel) if tel else 'VoLTE ACTIVE'), 'ok', '通话'
    if 'state=end' in low or 'sip state=end' in low:
        code_m = re.search(r'(?:code|failCode)=(-?\d+)', pick or log)
        code = code_m.group(1) if code_m else ''
        fail = result == 'FAIL' or (code and code not in ('-1', '0', '200'))
        title = '通话结束（失败）' if fail else '通话已结束'
        bits = []
        if direction:
            bits.append(direction)
        if tel:
            bits.append('号码 ' + tel)
        if code and code not in ('-1', '0'):
            bits.append('code ' + code)
        if side:
            bits.append(side.upper() + ' 侧')
        return title, (' · '.join(bits) or pick[:200]), ('err' if fail else 'ok'), '通话'

    side_cn = {'volte': 'VoLTE', 'sip': 'SIP'}.get(side, side.upper() or '设备')
    if result == 'FAIL':
        return '%s 流程失败' % side_cn, (pick or '上报失败')[:200], 'err', side_cn
    if result == 'OK':
        return '%s 流程正常' % side_cn, (pick or '上报成功')[:200], 'ok', side_cn
    if result == 'END':
        return '%s 流程结束' % side_cn, (pick or '已结束')[:200], 'ok', side_cn
    return '设备状态上报', (pick or result or side_cn)[:200], 'ok', '上报'


def _format_device_event(msg_type, payload, created_at, imei):
    """设备原始事件 → 概览「实时事件流」可读结构。"""
    mt = str(msg_type or '')
    p = payload if isinstance(payload, dict) else {}
    ts = str(created_at or '')

    if 'Reject' in mt or mt == 'Ai-Post-Call-Reject-Request' or mt == 'Ufi-Save-Call-Reject-Record':
        direction = str(p.get('call_direction') or p.get('dir') or '').lower()
        dir_cn = '呼出' if 'out' in direction else ('呼入' if 'in' in direction else '通话')
        peer = str(p.get('callee_number') or p.get('peer') or p.get('teleNumber') or '')
        caller = str(p.get('caller_number') or '')
        reason = str(p.get('reason') or p.get('hangup_reason') or p.get('failReason') or '拒接/未接通')
        reason = reason.split(';')[0].strip()[:120]
        who = peer or caller or '未知号码'
        return {
            'imei': imei, 'title': '通话未接通',
            'desc': '%s %s · %s' % (dir_cn, who, reason),
            'kind': 'warn', 'tag': '拒接', 'sn': '拒接',
            'ts': ts, 'created_at': ts, 'source': 'device',
        }

    if 'Sms' in mt or 'sms' in mt.lower() or mt == 'Ufi-Transfer-Sms-Indication':
        peer = str(p.get('smsmTel') or p.get('peer') or '')
        body = str(p.get('smsBody') or '')[:60]
        sms_type = str(p.get('smsType') or '').lower()
        rc = str(p.get('resultCode') or '')
        fail = str(p.get('failResult') or '')
        ok = (not fail) and (not rc or rc in ('0', '1000', '200', 'OK', 'ok'))
        title = '短信接收' if sms_type in ('inbox', 'in', 'mo') else (
            '短信发送' if sms_type else '短信事件')
        if not ok:
            title = '短信转发失败' if 'Transfer' in mt or 'transfer' in mt.lower() else (title + '失败')
        desc_bits = []
        if peer:
            desc_bits.append('号码 ' + peer)
        if body:
            desc_bits.append(body)
        if fail:
            desc_bits.append(fail)
        elif rc and not ok:
            desc_bits.append('code ' + rc)
        return {
            'imei': imei, 'title': title,
            'desc': (' · '.join(desc_bits) or '短信状态上报')[:200],
            'kind': 'ok' if ok else 'err', 'tag': '短信', 'sn': '短信',
            'ts': ts, 'created_at': ts, 'source': 'device',
        }

    if mt == 'Ufi-Status-Log-Indication' or 'Status-Log' in mt:
        title, desc, kind, tag = _status_log_summary(p)
        return {
            'imei': imei, 'title': title, 'desc': desc,
            'kind': kind, 'tag': tag, 'sn': tag,
            'ts': ts, 'created_at': ts, 'source': 'device',
        }

    # 兜底：尽量用 comment / lteStatus，不再把 msgType 原文当标题
    comment = str(p.get('comment') or p.get('lteStatus') or p.get('result') or '')
    title_map = {
        'Ufi-Get-Cmd-Request': '远程指令',
        'Ufi-Get-Log-Request': '日志采集',
        'Ufi-Set-Request': '设备设置',
        'websocket-connect': 'WebSocket 已连接',
        'websocket-disconnect': 'WebSocket 断开',
    }
    title = title_map.get(mt, '设备事件')
    return {
        'imei': imei, 'title': title,
        'desc': (comment or mt)[:200],
        'kind': 'err' if 'fail' in (mt + comment).lower() else 'ok',
        'tag': '事件', 'sn': '事件',
        'ts': ts, 'created_at': ts, 'source': 'device',
    }


def _ingest_records(db, payload):
    msg_type = _field(payload, 'msgType')
    imei = _field(payload, 'imei')
    if not imei:
        return
    indication = msg_type in (
        'Ufi-Status-Log-Indication', 'Ufi-Transfer-Sms-Indication',
        'Ufi-Save-Call-Reject-Record', 'save-call-reject-record',
    )
    has_sms = bool(_field(payload, 'smsBody', 'smsmTel'))
    has_call = bool(_field(payload, 'traceId', 'sessionId', 'volteLog', 'sipLog', 'log'))
    if not indication and not has_sms and not has_call:
        return
    raw = json.dumps(payload, ensure_ascii=False, default=str)[:16000]
    if has_sms:
        db.execute(text(
            "INSERT INTO dsip_ufi_sms (imei, sms_id, sms_type, sms_body, smsm_tel, sms_timestamp, "
            "result_code, fail_result, payload, created_at) "
            "VALUES (:imei, :sms_id, :sms_type, :sms_body, :smsm_tel, :sms_timestamp, "
            ":result_code, :fail_result, :payload, NOW())"
        ), {
            'imei': imei,
            'sms_id': _field(payload, 'smsId'),
            'sms_type': _field(payload, 'smsType'),
            'sms_body': _field(payload, 'smsBody'),
            'smsm_tel': _field(payload, 'smsmTel'),
            'sms_timestamp': _field(payload, 'smsTimestamp'),
            'result_code': _field(payload, 'resultCode'),
            'fail_result': _field(payload, 'failResult'),
            'payload': raw,
        })
        try:
            from modules.api.ufi_sms_alert import record_sms_alert
            sid = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
            record_sms_alert(
                db, imei=imei, peer=_field(payload, 'smsmTel'),
                body=_field(payload, 'smsBody'), src='device',
                src_id=int(sid or 0),
            )
        except Exception:
            pass
    if has_call and not has_sms:
        reject = _field(payload, 'rejectCode')
        # new firmware: single `log` blob + `side`(volte/sip); legacy: separate volteLog/sipLog
        side = str(_field(payload, 'side') or '').strip().lower()
        log_text = _field(payload, 'log')
        if log_text:
            if side == 'sip':
                sip_log_v = log_text
                volte_log_v = _field(payload, 'volteLog')
            else:
                volte_log_v = log_text
                sip_log_v = _field(payload, 'sipLog')
        else:
            volte_log_v = _field(payload, 'volteLog')
            sip_log_v = _field(payload, 'sipLog')
        db.execute(text(
            "INSERT INTO dsip_ufi_call (imei, trace_id, dir, peer, answered, rejected, reject_code, "
            "duration_sec, start_ts, end_ts, result, fail_reason, volte_log, sip_log, payload, created_at) "
            "VALUES (:imei, :trace_id, :dir, :peer, :answered, :rejected, :reject_code, "
            ":duration_sec, :start_ts, :end_ts, :result, :fail_reason, :volte_log, :sip_log, :payload, NOW())"
        ), {
            'imei': imei,
            'trace_id': _field(payload, 'traceId', 'sessionId'),
            'dir': _field(payload, 'dir', 'callDirection'),
            'peer': _field(payload, 'peer', 'peerNumber', 'teleNumber'),
            'answered': 1 if str(payload.get('answered')).lower() in ('1', 'true', 'yes') else 0,
            'rejected': 1 if str(payload.get('rejected')).lower() in ('1', 'true', 'yes') or reject else 0,
            'reject_code': int(reject) if str(reject).isdigit() else 0,
            'duration_sec': int(payload.get('durationSec') or 0) if str(payload.get('durationSec') or '0').isdigit() else 0,
            'start_ts': _field(payload, 'startTs'),
            'end_ts': _field(payload, 'endTs') or _field(payload, 'ts'),
            'result': _field(payload, 'result'),
            'fail_reason': _field(payload, 'failReason'),
            'volte_log': volte_log_v,
            'sip_log': sip_log_v,
            'payload': raw,
        })


def _row_to_console(row, live, domain):
    item = dict(row)
    raw = _json_obj(item.pop('status_json', None) or item.get('raw_json'))
    pending = _json_obj(item.get('pending_settings'))
    saved = _json_obj(item.get('saved_settings'))

    def _pref(*vals):
        for val in vals:
            if val not in (None, ''):
                return val
        return ''
    if item.get('last_seen') is not None:
        item['last_seen'] = str(item['last_seen'])
    # 活性仲裁 = 心跳新鲜度：拔电/断网后 last_seen 不再更新，
    # 而 location 条目要等 expires 过期（最长 5 分钟）、WS 半开连接要等 TCP 超时，
    # 单靠它们会把已拔电的设备继续显示为在线。
    try:
        _gap = item.pop('gap_sec', None)
        recent = _gap is not None and int(_gap) <= UFI_HEARTBEAT_STALE_SECS
    except (TypeError, ValueError):
        recent = False
    online = bool(item.get('online')) and recent
    ws_online = bool(item.get('imei') in live or (item.get('ws_online') and recent))
    item['online'] = online
    item['ws_online'] = ws_online
    item['wsOnline'] = ws_online
    item['sip_user'] = item.get('imei')
    item['sip_domain'] = domain
    item.update({
        'lteStatus': ('LTE-Disconnect' if not recent else (item.get('lte_status') or raw.get('lteStatus') or 'LTE-Connect')),
        'simNumber': item.get('sim_number') or raw.get('simNumber'),
        'simType': item.get('sim_type') or raw.get('simType'),
        'simState': item.get('sim_state') or raw.get('simState') or 'READY',
        'cellularStatus': item.get('cellular_status') or raw.get('cellularStatus'),
        'cellularNetwork': item.get('cellular_network') or raw.get('cellularNetwork'),
        'volteRegisterStatus': item.get('volte_status') or raw.get('volteRegisterStatus') or '0',
        'voipRegisterStatus': item.get('voip_status') or raw.get('voipRegisterStatus') or ('1' if online else '0'),
        'websocketStatus': item.get('ws_status') or raw.get('websocketStatus') or ('1' if ws_online else '0'),
        'wfcStatus': _flag01(
            item.get('wfc_status') or raw.get('wfcStatus') or raw.get('wlanCallingStatus')
            or raw.get('wifiCallingStatus'), '0'),
        'airplaneMode': _flag01(item.get('airplane_mode') or raw.get('airplaneMode'), '0'),
        'cellularSignalLevel': item.get('signal_level') or raw.get('cellularSignalLevel') or '0',
        'serviceCellEARFCN': item.get('earfcn') or raw.get('serviceCellEARFCN') or '0',
        'networkType': item.get('network_type') or raw.get('networkType') or 'none',
        'cpuUseRate': item.get('cpu_use') or raw.get('cpuUseRate') or '0',
        'memoryUseRate': item.get('mem_use') or raw.get('memoryUseRate') or '0',
        'storageUseRate': item.get('storage_use') or raw.get('storageUseRate') or '0',
        'linphoneProcessStatus': item.get('linphone_status') or raw.get('linphoneProcessStatus') or '',
        'buildNumber': item.get('build_number') or raw.get('buildNumber') or '',
        'agentType': item.get('agent_type') or raw.get('agentType') or '',
        'wlanName': raw.get('wlanName') or '',
        # device-reported operator info (raw passthrough; frontend resolves CN names)
        'operatorCode': raw.get('simOperator') or raw.get('operatorCode') or '',
        'operatorShort': raw.get('operatorName') or raw.get('operatorShort') or '',
        'band': raw.get('band') or raw.get('serviceCellBand') or '—',
        'rsrp': raw.get('rsrp') or raw.get('cellularSignalRsrp'),
        'rsrq': raw.get('rsrq'),
        'sipServerAddress': _pref(pending.get('sipServerAddress'), saved.get('sipServerAddress'), raw.get('sipServerAddress'), domain),
        'sipServerPort': _pref(pending.get('sipServerPort'), saved.get('sipServerPort'), raw.get('sipServerPort'), 10560),
        'sippassWord': '' if not item.get('customer_id') else (pending.get('sippassWord') or (_ufi_password(str(item.get('imei') or '')) if item.get('imei') else '')),
        'unclaimed': not item.get('customer_id'),
        'transportProtocol': pending.get('transportProtocol') or raw.get('transportProtocol') or 'UDP',
        'encryptionType': pending.get('encryptionType') or raw.get('encryptionType') or 'dtls',
        'smsCryptionStatus': pending.get('smsCryptionStatus') or raw.get('smsCryptionStatus') or 'OFF',
        'logStatus': pending.get('logStatus') or raw.get('logStatus') or 'OFF',
        'ufiHotpotstaus': pending.get('ufiHotpotstaus') or raw.get('ufiHotpotstaus') or 'OFF',
        'hotspotName': pending.get('hotspotName') or raw.get('hotspotName') or '',
        'lastSeen': item.get('last_seen'),
        'sipregeststatus': item.get('sip_reg_status') or raw.get('sipregeststatus') or '',
        'apkVersion': raw.get('apkVersion') or '',
    })
    # Cloud reverse admin: live WS tunnel preferred; never expose device private IP.
    tunnel_live = None
    try:
        from modules.api.ufi_ws import get_ufi_tunnel, UFI_SOFTAP_ADMIN
        tunnel_live = get_ufi_tunnel(item.get('imei'))
    except Exception:
        UFI_SOFTAP_ADMIN = 'http://192.168.43.1:8080'
        tunnel_live = None
    if tunnel_live and tunnel_live.get('ready') and ws_online:
        tunnel_ready = True
        admin_port = int(tunnel_live.get('adminPort') or item.get('tunnel_admin_port') or 8080)
        admin_path = str(tunnel_live.get('adminPath') or item.get('tunnel_admin_path') or '/')
    else:
        tunnel_ready = bool(item.get('tunnel_ready') and ws_online)
        admin_port = int(item.get('tunnel_admin_port') or 8080)
        admin_path = str(item.get('tunnel_admin_path') or '/')
    proxy_base = '/api/v1/ufi/devices/{}/admin-proxy/'.format(item.get('imei') or '')
    item['tunnelReady'] = tunnel_ready
    item['tunnel_ready'] = tunnel_ready
    item['tunnelAdminPort'] = admin_port
    item['tunnelAdminPath'] = admin_path
    item['adminProxyUrl'] = proxy_base if tunnel_ready else ''
    item['adminProxyPath'] = proxy_base
    item['softApUrl'] = UFI_SOFTAP_ADMIN
    item['softApHint'] = (
        '设备有外网时通过云端反向代理访问本地管理台；无外网时请连接设备 SoftAP 后打开 '
        + UFI_SOFTAP_ADMIN
    )
    item.pop('pending_settings', None)
    item.pop('saved_settings', None)
    item.pop('raw_json', None)
    item.pop('tunnel_json', None)
    return item


def _pending_setting_fields(payload):
    keys = (
        'sipServerAddress', 'sipServerPort', 'transportProtocol', 'encryptionType',
        'wlanCallingStatus', 'wlanStatus', 'wlanName', 'wlanPassword', 'otgStatus',
        'ecmStatus', 'ufiHotpotstaus', 'hotspotName', 'hotspotPassword',
        'smsCryptionStatus', 'logStatus', 'airplaneMode', 'isSet', 'sippassWord',
    )
    out = {'msgType': 'Ufi-Set-Request', 'isSet': 'Set'}
    for key in keys:
        value = payload.get(key)
        if value in (None, '', '••••••••'):
            continue
        out[key] = value
    return out


def _handle_get_url():
    payload = _device_payload()
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        cfg = _load_ufi_config(db)
        sign_err = _sign_fail_reason(payload, cfg['secret_key'])
        if sign_err:
            return _device_error(payload, 401, sign_err)
        imei = _field(payload, 'imei')
        if imei:
            _upsert_device(db, payload)
            db.commit()
        return jsonify({
            'code': 200,
            'msgType': 'Ufi-Get-Url-Response',
            'requestId': _field(payload, 'requestId'),
            'url': cfg['base_url'],
            'wsUrl': cfg['ws_url'],
            'comment': 'success',
        })
    except Exception as ex:
        db.rollback()
        db.flush()
        return _device_error(payload, 500, str(ex))
    finally:
        db.close()


def _handle_sip_setting():
    payload = _device_payload()
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        cfg = _load_ufi_config(db)
        sign_err = _sign_fail_reason(payload, cfg['secret_key'])
        if sign_err:
            return _device_error(payload, 401, sign_err)
        if str(cfg.get('secret_key') or '').strip() in ('', '123456'):
            return _device_error(payload, 401, 'secret not configured')

        imei_raw = _field(payload, 'imei')
        try:
            imei = _normalize_ufi_imei(imei_raw)
        except http_exceptions.HTTPException:
            return _device_error(payload, 400, 'IMEI is invalid')

        sim = ''
        try:
            sim = _normalize_ufi_sim(_field(payload, 'simNumber', 'sim_number'), required=False)
        except http_exceptions.HTTPException:
            sim = re.sub(r'\D', '', _field(payload, 'simNumber', 'sim_number'))

        _upsert_device(db, payload, {
            'sim_number': sim,
            'provisioned': 0,
            'sip_reg_status': _field(payload, 'sipregeststatus') or 'none',
        })
        owned = db.execute(text(
            "SELECT customer_id FROM dsip_ufi_device WHERE imei=:imei"
        ), {'imei': imei}).scalar()
        provisioned = 0
        if owned and cfg['auto_provision']:
            from modules.api.acl import tenant_domain
            _upsert_ufi_account(db, imei, sim, tenant_domain(db, owned))
            provisioned = 1
            db.execute(text(
                "UPDATE dsip_ufi_device SET provisioned=1, claim_status=1 WHERE imei=:imei"
            ), {'imei': imei})
            getSharedMemoryDict(STATE_SHMEM_NAME)['kam_reload_required'] = True
        pending_row = db.execute(text(
            "SELECT pending_settings FROM dsip_ufi_device WHERE imei = :imei"
        ), {'imei': imei}).first()
        pending = _json_obj(pending_row[0] if pending_row else None)
        if pending:
            db.execute(text(
                "UPDATE dsip_ufi_device SET pending_settings = NULL WHERE imei = :imei"
            ), {'imei': imei})
        db.commit()

        password = _ufi_password(imei)
        sip_host = cfg['sip_host']
        sip_port = cfg['sip_port']
        resp = {
            'code': 200,
            'msgType': 'Ufi-Set-Request',
            'requestId': _field(payload, 'requestId'),
            'lteStatus': 'success',
            'sn': _field(payload, 'sn'),
            'isSet': 'Set' if (owned and cfg['auto_provision']) or pending else 'None',
            'comment': 'success' if owned else 'pending claim',
            'imei': imei,
            'imsi': _field(payload, 'imsi', 'Imsi'),
            'simNumber': sim,
            'agentType': _field(payload, 'agentType') or 'Linkcircle-UFI-C',
            'cellularStatus': _field(payload, 'cellularStatus'),
            'cellularNetwork': _field(payload, 'cellularNetwork'),
            'wifiCallingStatus': _field(payload, 'wlanCallingStatus', 'wifiCallingStatus') or 'ON',
            'wlanCallingStatus': _field(payload, 'wlanCallingStatus', 'wifiCallingStatus') or 'ON',
            'wlanStatus': _field(payload, 'wlanStatus') or 'OFF',
            'wlanName': _field(payload, 'wlanName'),
            'wlanPassword': _field(payload, 'wlanPassword'),
            'otgStatus': _field(payload, 'otgStatus') or 'OFF',
            'ecmStatus': _field(payload, 'ecmStatus') or 'OFF',
            'transportProtocol': cfg['transport'],
            'sipServerAddress': sip_host if owned else '',
            'sipServerPort': sip_port if owned else '',
            'sippassWord': password if owned else '',
            'sipregeststatus': _field(payload, 'sipregeststatus') or 'none',
            'ufiHotpotstaus': _field(payload, 'ufiHotpotstaus') or 'OFF',
            'hotspotName': _field(payload, 'hotspotName'),
            'hotspotPassword': _field(payload, 'hotspotPassword'),
            'encryptionType': _field(payload, 'encryptionType') or 'dtls',
            'smsCryptionStatus': _field(payload, 'smsCryptionStatus') or 'OFF',
            'logStatus': _field(payload, 'logStatus') or 'OFF',
        }
        skip_overlay = {'code', 'msgType', 'requestId', 'imei', 'comment', 'lteStatus', 'sippassWord'}
        for key, value in pending.items():
            if key not in skip_overlay and value not in (None, ''):
                resp[key] = value
        if pending:
            resp['isSet'] = 'Set'
        return jsonify(resp)
    except Exception as ex:
        db.rollback()
        db.flush()
        return _device_error(payload, 500, str(ex))
    finally:
        db.close()


UFI_ALERT_CPU_THRESHOLD = 85      # percent
UFI_ALERT_STORAGE_THRESHOLD = 88  # percent
UFI_ALERT_OFFLINE_SECS = 300      # gap between status pushes treated as an outage
UFI_HEARTBEAT_STALE_SECS = 180    # last_seen older than this => device considered offline


def _alert_pct(value):
    try:
        return float(str(value).replace('%', '').strip())
    except (TypeError, ValueError):
        return None


def _insert_alert(db, imei, kind, level, detail, offline_from=None, offline_to=None):
    db.execute(text(
        "INSERT INTO dsip_ufi_alert (imei, kind, level, detail, offline_from, offline_to, created_at) "
        "VALUES (:imei, :kind, :level, :detail, :of, :ot, NOW())"
    ), {'imei': imei, 'kind': kind, 'level': level, 'detail': detail[:250],
        'of': offline_from, 'ot': offline_to})
    db.execute(text(
        "DELETE FROM dsip_ufi_alert WHERE imei = :imei AND id NOT IN ("
        "SELECT id FROM (SELECT id FROM dsip_ufi_alert WHERE imei = :imei ORDER BY id DESC LIMIT 200) t)"
    ), {'imei': imei})


def _detect_alerts(db, imei, payload, prev):
    """状态变更检测：对比本次上报与上一条设备记录，异常转换写入 dsip_ufi_alert。"""
    if not prev:
        return  # first report from this device: nothing to compare against

    def cur(*names):
        v = _field(payload, *names)
        return str(v).strip() if v is not None else ''

    alerts = []
    # SIP / VoLTE registration flips (only clean 1->0 / 0->1 transitions count)
    pairs = (
        ('voip_status', cur('voipRegisterStatus', 'sipregeststatus'), 'sip_down', 'SIP 掉线', 'sip_up', 'SIP 重新注册成功'),
        ('volte_status', cur('volteRegisterStatus'), 'volte_down', 'VoLTE 掉线', 'volte_up', 'VoLTE 恢复注册'),
        ('ws_status', cur('websocketStatus'), 'ws_down', '心跳保活失败（WebSocket 断开）', 'ws_up', '心跳恢复（WebSocket 已重连）'),
    )
    for col, now_v, down_kind, down_txt, up_kind, up_txt in pairs:
        old_v = str(prev.get(col) or '').strip()
        if old_v == '1' and now_v == '0':
            alerts.append((down_kind, 'err', down_txt, None, None))
        elif old_v == '0' and now_v == '1':
            alerts.append((up_kind, 'ok', up_txt, None, None))

    # offline window: this push arrives after a silent gap -> device was unreachable
    gap_sec = prev.get('gap_sec')
    try:
        gap_sec = int(gap_sec) if gap_sec is not None else None
    except (TypeError, ValueError):
        gap_sec = None
    if gap_sec is not None and gap_sec > UFI_ALERT_OFFLINE_SECS:
        mins, secs = divmod(gap_sec, 60)
        dur = ('{}小时{}分'.format(mins // 60, mins % 60) if mins >= 60 else
               ('{}分'.format(mins) if mins else '{}秒'.format(secs)))
        ls = prev.get('last_seen')
        alerts.append(('offline', 'err',
                       '设备离线 {} 后恢复在线（离线始于 {}）'.format(dur, str(ls)[:19] if ls else '未知'),
                       ls, None))

    # CPU / storage threshold crossings
    p_cpu, c_cpu = _alert_pct(prev.get('cpu_use')), _alert_pct(cur('cpuUseRate'))
    if p_cpu is not None and c_cpu is not None:
        if p_cpu < UFI_ALERT_CPU_THRESHOLD <= c_cpu:
            alerts.append(('cpu_high', 'warn', 'CPU 使用率 {}%，超过阈值 {}%'.format(int(c_cpu), UFI_ALERT_CPU_THRESHOLD), None, None))
        elif p_cpu >= UFI_ALERT_CPU_THRESHOLD > c_cpu:
            alerts.append(('cpu_ok', 'ok', 'CPU 使用率恢复正常（{}%）'.format(int(c_cpu)), None, None))
    p_sto, c_sto = _alert_pct(prev.get('storage_use')), _alert_pct(cur('storageUseRate'))
    if p_sto is not None and c_sto is not None:
        if p_sto < UFI_ALERT_STORAGE_THRESHOLD <= c_sto:
            alerts.append(('storage_high', 'warn', '存储使用率 {}%，存储紧张（阈值 {}%）'.format(int(c_sto), UFI_ALERT_STORAGE_THRESHOLD), None, None))

    # SIM trouble: state changed away from READY
    p_sim = str(prev.get('sim_state') or '').strip()
    c_sim = cur('simState')
    if c_sim and c_sim != 'READY' and c_sim != p_sim:
        alerts.append(('sim_bad', 'err', 'SIM 卡状态异常：{}（原 {}）'.format(c_sim, p_sim or '未知'), None, None))

    for a in alerts:
        _insert_alert(db, imei, *a)


def _handle_status_push():
    payload = _device_payload()
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        cfg = _load_ufi_config(db)
        sign_err = _sign_fail_reason(payload, cfg['secret_key'])
        if sign_err:
            return _device_error(payload, 401, sign_err)
        imei = str(_field(payload, 'imei') or '').strip()
        prev = None
        if imei:
            prev = db.execute(text(
                "SELECT voip_status, volte_status, ws_status, cpu_use, storage_use, sim_state, "
                "last_seen, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS gap_sec "
                "FROM dsip_ufi_device WHERE imei = :imei"
            ), {'imei': imei}).mappings().first()
        _upsert_device(db, payload)
        if imei:
            try:
                _detect_alerts(db, imei, payload, prev)
            except Exception:
                pass
        db.commit()
        return jsonify({
            'code': 200,
            'msgType': _field(payload, 'msgType') or 'Ufi-Status-Request',
            'requestId': _field(payload, 'requestId'),
            'lteStatus': 'success',
            'comment': '成功',
        })
    except Exception as ex:
        db.rollback()
        db.flush()
        return _device_error(payload, 500, str(ex))
    finally:
        db.close()


@api.route('/ufi-app/api/ufi/get-url-info', methods=['POST', 'GET'])
@api.route('/ufi-app/api/ufi/get-url', methods=['POST', 'GET'])
@api.route('/api/ufi/get-url-info', methods=['POST', 'GET'])
@api.route('/api/ufi/get-url', methods=['POST', 'GET'])
def ufi_get_url():
    return _handle_get_url()


@api.route('/ufi-app/api/ufi/sip-setting', methods=['POST'])
@api.route('/api/ufi/sip-setting', methods=['POST'])
def ufi_sip_setting():
    return _handle_sip_setting()


@api.route('/ufi-app/api/ufi/register-status-push', methods=['POST'])
@api.route('/api/ufi/register-status-push', methods=['POST'])
def ufi_register_status_push():
    return _handle_status_push()


@api.route('/api/v1/ufi/devices', methods=['GET'])
@api_security
def listUfiDevices():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        domain = _ufi_auth_domain()
        from modules.api.acl import customer_sql, ensure_acl_tables
        ensure_acl_tables(db)
        csql, cparams = customer_sql('d')
        rows = db.execute(text(
            "SELECT d.id, d.imei, d.sn, d.imsi, d.sim_number, d.agent_type, d.sip_reg_status, "
            "d.cellular_status, d.cellular_network, d.wlan_status, d.last_ip, d.last_msg_type, "
            "d.last_seen, d.provisioned, d.lte_status, d.sim_type, d.volte_status, d.voip_status, "
            "d.ws_status, d.network_type, d.airplane_mode, d.signal_level, d.earfcn, "
            "d.linphone_status, d.wfc_status, d.cpu_use, d.mem_use, d.storage_use, d.build_number, "
            "d.ws_online, d.sim_state, d.customer_id, d.claim_status, d.status_json, d.pending_settings, d.saved_settings, "
            "d.tunnel_ready, d.tunnel_admin_host, d.tunnel_admin_port, d.tunnel_admin_path, "
            "(SELECT COUNT(*) FROM location loc WHERE loc.username = d.imei AND loc.expires > NOW()) AS online, "
            "TIMESTAMPDIFF(SECOND, d.last_seen, NOW()) AS gap_sec "
            "FROM dsip_ufi_device d WHERE 1=1" + csql + " ORDER BY d.last_seen DESC"
        ), cparams).mappings().all()
        live = set()
        try:
            from modules.api.ufi_ws import ws_connected_imeis
            live = ws_connected_imeis()
        except Exception:
            live = set()
        data = []
        for row in rows:
            data.append(_row_to_console(row, live, domain))
        return createApiResponse(msg='UFI devices found', data=data)
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _delete_ufi_account(db, imei):
    """删掉该 IMEI 在所有域上的 SIP 账号和别名。"""
    imei = str(imei or '').strip()
    if not imei:
        return
    db.execute(text("DELETE FROM dbaliases WHERE username=:u"), {'u': imei})
    db.execute(text("DELETE FROM subscriber WHERE username=:u"), {'u': imei})


@api.route('/api/v1/ufi/devices/unclaimed', methods=['GET'])
@api_security
def listUnclaimedDevices():
    from modules.api.acl import is_platform_admin
    if not is_platform_admin():
        return createApiResponse(error='http', msg='仅平台管理员可查看待认领设备', status_code=403)
    db = DummySession()
    try:
        db = startSession()
        _ensure_ufi_tables(db)
        rows = db.execute(text(
            "SELECT imei, sn, sim_number, last_seen, last_ip FROM dsip_ufi_device "
            "WHERE customer_id IS NULL ORDER BY last_seen DESC LIMIT 500"
        )).mappings().all()
        data = []
        for r in rows:
            d = dict(r)
            if d.get('last_seen') is not None:
                d['last_seen'] = str(d['last_seen'])
            data.append(d)
        return createApiResponse(msg='unclaimed', data=data)
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>/claim', methods=['POST'])
@api_security
def claimUfiDevice(imei):
    from modules.api.acl import is_platform_admin, set_device_customer, tenant_domain, ensure_acl_tables
    if not is_platform_admin():
        return createApiResponse(error='http', msg='仅平台管理员可认领设备', status_code=403)
    db = DummySession()
    try:
        imei = _normalize_ufi_imei(imei)
        body = request.get_json(silent=True) or {}
        cid = int(body.get('customer_id') or 0)
        if not cid:
            raise http_exceptions.BadRequest('customer_id is required')
        db = startSession()
        _ensure_ufi_tables(db)
        ensure_acl_tables(db)
        exists = db.execute(text("SELECT id FROM dsip_customer WHERE id=:i"), {'i': cid}).first()
        if not exists:
            raise http_exceptions.BadRequest('客户不存在')
        dev = db.execute(text("SELECT imei, sim_number FROM dsip_ufi_device WHERE imei=:imei"), {'imei': imei}).mappings().first()
        if not dev:
            raise http_exceptions.NotFound('设备不存在')
        _delete_ufi_account(db, imei)
        set_device_customer(db, imei, cid)
        db.execute(text("DELETE FROM dsip_ufi_import WHERE imei=:imei"), {'imei': imei})
        db.execute(text(
            "INSERT INTO dsip_ufi_import (customer_id, imei, sim, matched, note, created, matched_at) "
            "VALUES (:c,:imei,:sim,1,'claimed',NOW(),NOW())"
        ), {'c': cid, 'imei': imei, 'sim': str(dev.get('sim_number') or '')})
        _upsert_ufi_account(db, imei, str(dev.get('sim_number') or ''), tenant_domain(db, cid))
        db.execute(text("UPDATE dsip_ufi_device SET provisioned=1 WHERE imei=:imei"), {'imei': imei})
        db.commit()
        getSharedMemoryDict(STATE_SHMEM_NAME)['kam_reload_required'] = True
        return createApiResponse(msg='已认领')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>', methods=['DELETE'])
@api_security
def deleteUfiDevice(imei):
    """删除设备及其全部关联数据（事件/短信/通话/文件记录，含磁盘日志文件）"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        imei = str(imei or '').strip()
        if not imei:
            raise http_exceptions.BadRequest('imei is required')
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        file_rows = db.execute(text(
            "SELECT stored_path FROM dsip_ufi_file WHERE imei = :imei"
        ), {'imei': imei}).mappings().all()
        deleted = {}
        # child tables first, device row last
        _delete_ufi_account(db, imei)
        for table in ('dsip_ufi_file', 'dsip_ufi_call', 'dsip_ufi_sms', 'dsip_ufi_event', 'dsip_ufi_alert', 'dsip_ufi_device'):
            r = db.execute(text(
                "DELETE FROM {} WHERE imei = :imei".format(table)
            ), {'imei': imei})
            deleted[table] = int(r.rowcount or 0)
        db.commit()
        # best-effort cleanup of stored log files (outside the transaction)
        removed_files = 0
        for row in file_rows:
            p = str(row.get('stored_path') or '')
            if p and os.path.isfile(p):
                try:
                    os.remove(p)
                    removed_files += 1
                except OSError:
                    pass
        return createApiResponse(msg='UFI device deleted', data=[{
            'imei': imei,
            'device_deleted': deleted.get('dsip_ufi_device', 0) > 0,
            'files_removed': removed_files,
            'rows_deleted': deleted,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/alerts', methods=['GET'])
@api_security
def listUfiAlerts():
    """设备异常状态变更记录（心跳/SIP/VoLTE 掉线、离线时段、CPU/存储、SIM 异常）"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        from modules.api.acl import scoped_imei
        imei = str(request.args.get('imei') or '').strip()
        sql = ("SELECT imei, kind, level, detail, offline_from, offline_to, created_at "
               "FROM dsip_ufi_alert WHERE 1=1")
        params = {}
        frag, fp = scoped_imei('')
        sql += frag
        params.update(fp)
        if imei:
            sql += " AND imei = :imei"
            params['imei'] = imei
        sql += " ORDER BY id DESC LIMIT 200"
        rows = db.execute(text(sql), params).mappings().all()
        data = []
        for r in rows:
            data.append({
                'imei': r.get('imei'),
                'kind': r.get('kind'),
                'level': r.get('level'),
                'detail': r.get('detail'),
                'offlineFrom': str(r.get('offline_from')) if r.get('offline_from') else '',
                'offlineTo': str(r.get('offline_to')) if r.get('offline_to') else '',
                'createdAt': str(r.get('created_at')),
            })
        return createApiResponse(msg='UFI alerts found', data=data)
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/config', methods=['GET', 'PUT'])
@api_security
def ufiDeviceConfig():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        if request.method == 'PUT':
            payload = _device_payload()
            _ensure_ufi_tables(db)
            current = _load_ufi_config(db)
            secret = _field(payload, 'secret_key') or current['secret_key']
            auto_provision = payload.get('auto_provision')
            if auto_provision in (True, False, 1, 0, '1', '0', 'true', 'false', 'on', 'off'):
                auto_flag = 1 if str(auto_provision).lower() in ('1', 'true', 'on') or auto_provision is True else 0
            else:
                auto_flag = 1 if current['auto_provision'] else 0
            sip_host = _field(payload, 'sip_host') or current['sip_host']
            sip_port = int(payload.get('sip_port') or current['sip_port'] or 10560)
            transport = (_field(payload, 'transport') or current['transport'] or 'UDP').upper()
            base_url = _field(payload, 'base_url')
            ws_url = _field(payload, 'ws_url')
            db.execute(text(
                "UPDATE dsip_ufi_config SET secret_key = :secret_key, auto_provision = :auto_provision, "
                "sip_host = :sip_host, sip_port = :sip_port, transport = :transport, "
                "base_url = :base_url, ws_url = :ws_url WHERE id = 1"
            ), {
                'secret_key': secret,
                'auto_provision': auto_flag,
                'sip_host': sip_host,
                'sip_port': sip_port,
                'transport': transport,
                'base_url': base_url,
                'ws_url': ws_url,
            })
            db.commit()
        cfg = _load_ufi_config(db)
        db.commit()
        return createApiResponse(msg='UFI device config', data=[cfg])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>', methods=['GET'])
@api_security
def getUfiDevice(imei):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        row = db.execute(text(
            "SELECT * FROM dsip_ufi_device WHERE imei = :imei"
        ), {'imei': imei}).mappings().first()
        if row is None:
            raise http_exceptions.NotFound('UFI device not found')
        item = dict(row)
        for key in ('last_seen',):
            if item.get(key) is not None:
                item[key] = str(item[key])
        events = [dict(event) for event in db.execute(text(
            "SELECT id, msg_type, payload, created_at FROM dsip_ufi_event "
            "WHERE imei = :imei ORDER BY id DESC LIMIT 20"
        ), {'imei': imei}).mappings().all()]
        for event in events:
            if event.get('created_at') is not None:
                event['created_at'] = str(event['created_at'])
        item['events'] = events
        try:
            from modules.api.ufi_ws import ws_connected_imeis, get_ufi_tunnel, UFI_SOFTAP_ADMIN
            item['ws_online'] = imei in ws_connected_imeis()
            tunnel = get_ufi_tunnel(imei)
            ready = bool(tunnel and tunnel.get('ready') and item['ws_online'])
            item['tunnelReady'] = ready
            item['tunnel_ready'] = ready
            item['adminProxyUrl'] = (_admin_proxy_prefix(imei) + '/') if ready else ''
            item['softApUrl'] = UFI_SOFTAP_ADMIN
            if tunnel:
                item['tunnelAdminPort'] = tunnel.get('adminPort')
                item['tunnelAdminPath'] = tunnel.get('adminPath')
        except Exception:
            item['ws_online'] = bool(item.get('ws_online'))
        return createApiResponse(msg='UFI device', data=[item])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>/command', methods=['POST'])
@api_security
def sendUfiDeviceCommand(imei):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        payload = _device_payload()
        cmd = _field(payload, 'cmd')
        msg_type = _field(payload, 'msgType') or 'Ufi-Get-Cmd-Request'
        from modules.api.ufi_ws import UFI_ALLOWED_CMDS, send_ufi_command
        body = {'msgType': msg_type, 'imei': imei}
        if msg_type == 'Ufi-Get-Log-Request':
            if cmd not in ('start', 'stop', 'pull'):
                raise http_exceptions.BadRequest('unsupported log cmd')
            body['cmd'] = cmd
            if cmd == 'pull':
                days = str(payload.get('days') or '1')
                if days not in ('1', '2', '3', '4'):
                    days = '1'
                body['days'] = days
        elif msg_type in ('Ufi-Admin-Http-Proxy',) or cmd == 'admin_http_proxy':
            # Prefer cmd path; dedicated msgType also accepted.
            if msg_type != 'Ufi-Admin-Http-Proxy':
                body['msgType'] = 'Ufi-Get-Cmd-Request'
                body['cmd'] = 'admin_http_proxy'
            else:
                body['msgType'] = 'Ufi-Admin-Http-Proxy'
            body['method'] = (_field(payload, 'method') or 'GET').upper()
            path = _field(payload, 'path') or '/'
            if not path.startswith('/'):
                path = '/' + path
            body['path'] = path
            headers = payload.get('headers') if isinstance(payload.get('headers'), dict) else {}
            body['headers'] = headers
            body['bodyBase64'] = _field(payload, 'bodyBase64')
            try:
                body['timeoutMs'] = int(payload.get('timeoutMs') or 15000)
            except (TypeError, ValueError):
                body['timeoutMs'] = 15000
        elif msg_type == 'Ufi-Get-ESIM-Request' or cmd == 'esim_profile':
            # Download / install eSIM profile via activation code (LPA:... / AC).
            body['msgType'] = 'Ufi-Get-ESIM-Request'
            esim = _field(payload, 'esimMessage', 'esim_message', 'activationCode', 'lpa')
            esim = re.sub(r'\s+', '', esim or '')
            if not esim:
                raise http_exceptions.BadRequest('esimMessage is required')
            if len(esim) > 512:
                raise http_exceptions.BadRequest('esimMessage too long')
            # Common forms: LPA:1$smdp.example$MATCHING-ID  or bare matching-id codes
            if not (esim.upper().startswith('LPA:') or re.match(r'^[A-Za-z0-9.$_\-:/]+$', esim)):
                raise http_exceptions.BadRequest('esimMessage format invalid')
            body['esimMessage'] = esim
        elif msg_type == 'Ufi-Set-Request':
            body.update(_pending_setting_fields(payload))
        else:
            if cmd not in UFI_ALLOWED_CMDS:
                raise http_exceptions.BadRequest('unsupported cmd')
            body['cmd'] = cmd
            for key in (
                'wlanName', 'wlanPassword', 'ssid', 'password', 'status', 'wfcStatus',
                'wlanCallingStatus', 'hotspotName', 'hotspotPassword', 'simPin', 'oldPin',
                'simPuk', 'pin', 'newPin', 'puk',
            ):
                value = payload.get(key)
                if value not in (None, ''):
                    body[key] = value
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        result = send_ufi_command(imei, body)
        db.execute(text(
            "UPDATE dsip_ufi_device SET last_cmd_json = :raw WHERE imei = :imei"
        ), {'raw': json.dumps(result, ensure_ascii=False, default=str)[:16000], 'imei': imei})
        db.commit()
        if not result.get('ok'):
            return createApiResponse(error='http', msg=result.get('error') or 'command failed', data=[result], status_code=409)
        return createApiResponse(msg='command sent', data=[result])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


_HOP_BY_HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length', 'host',
}


def _admin_proxy_prefix(imei):
    return '/api/v1/ufi/devices/{}/admin-proxy'.format(imei)


def _rewrite_admin_location(imei, location, admin_port):
    """Map device-local Location to the cloud reverse-proxy path (no private IP leak)."""
    if not location:
        return location
    loc = str(location).strip()
    prefix = _admin_proxy_prefix(imei)
    for base in (
        'http://127.0.0.1:{}'.format(admin_port),
        'http://localhost:{}'.format(admin_port),
        'https://127.0.0.1:{}'.format(admin_port),
        'https://localhost:{}'.format(admin_port),
    ):
        if loc.startswith(base):
            rest = loc[len(base):] or '/'
            if not rest.startswith('/'):
                rest = '/' + rest
            return prefix + rest
    if re.match(r'^https?://', loc, flags=re.I):
        # Absolute URL to somewhere else — do not rewrite (and do not leak 192.168.x).
        if re.match(r'^https?://(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)', loc, flags=re.I):
            parsed = urlparse(loc)
            return prefix + (parsed.path or '/') + (('?' + parsed.query) if parsed.query else '')
        return loc
    if loc.startswith('/'):
        return prefix + loc
    return prefix + '/' + loc


def _cookie_prefix(imei):
    # Namespace device cookies so they never collide with Flask `session`.
    safe = re.sub(r'[^0-9A-Za-z]', '', str(imei or ''))[:32] or 'dev'
    return 'ufi{}_'.format(safe)


def _rewrite_set_cookie(imei, cookie_value):
    prefix = _admin_proxy_prefix(imei)
    cpref = _cookie_prefix(imei)
    cookie = str(cookie_value or '')
    if not cookie:
        return cookie
    # name=value; Attr=...
    parts = cookie.split(';')
    nv = parts[0].strip()
    if '=' not in nv:
        return cookie
    name, val = nv.split('=', 1)
    name = name.strip()
    if not name.startswith(cpref):
        name = cpref + name
    parts[0] = '{}={}'.format(name, val)
    attrs = []
    have_path = False
    for raw in parts[1:]:
        item = raw.strip()
        if not item:
            continue
        if item.lower().startswith('path='):
            attrs.append('Path=' + prefix + '/')
            have_path = True
        elif item.lower().startswith('domain='):
            # Drop Domain so cookie stays host-only on the cloud portal.
            continue
        else:
            attrs.append(item)
    if not have_path:
        attrs.append('Path=' + prefix + '/')
    return '; '.join([parts[0]] + attrs)


def _device_cookie_header(imei):
    """Map namespaced browser cookies back to device cookie names."""
    cpref = _cookie_prefix(imei)
    pairs = []
    for key, value in request.cookies.items():
        if key.startswith(cpref):
            pairs.append('{}={}'.format(key[len(cpref):], value))
    return '; '.join(pairs)


def _rewrite_absolute_paths(text, imei):
    """Rewrite root-absolute URLs so device UI stays inside the cloud proxy."""
    prefix = _admin_proxy_prefix(imei)

    def _reb(match):
        head, path = match.group(1), match.group(2)
        full = '/' + path
        if full == prefix or full.startswith(prefix + '/'):
            return match.group(0)
        return head + prefix + full

    # href="/x" src="/x" action="/x"
    text = re.sub(
        r'''((?:href|src|action)\s*=\s*["'])/((?!/)[^"']*)''',
        _reb,
        text,
        flags=re.I,
    )
    # url(/x) in CSS
    text = re.sub(
        r'''(url\(\s*["']?)/((?!/)[^"')\s]*)''',
        _reb,
        text,
        flags=re.I,
    )
    # fetch('/x') / fetch("/x")
    text = re.sub(
        r'''(fetch\s*\(\s*["'])/((?!/)[^"']*)''',
        _reb,
        text,
    )
    # XMLHttpRequest.open("GET", "/x"
    text = re.sub(
        r'''(\.open\s*\(\s*["'][A-Za-z]+["']\s*,\s*["'])/((?!/)[^"']*)''',
        _reb,
        text,
    )
    # location.href = "/x" / location.replace("/x")
    text = re.sub(
        r'''(location\.(?:href|replace|assign)\s*=\s*["'])/((?!/)[^"']*)''',
        _reb,
        text,
    )
    text = re.sub(
        r'''(location\.(?:replace|assign)\s*\(\s*["'])/((?!/)[^"']*)''',
        _reb,
        text,
    )
    return text


def _inject_html_base(body, imei):
    try:
        text_body = body.decode('utf-8')
    except Exception:
        try:
            text_body = body.decode('latin-1')
        except Exception:
            return body
    prefix = _admin_proxy_prefix(imei)
    # Rewrite device absolute paths BEFORE injecting base/hook (so we don't double-prefix).
    text_body = _rewrite_absolute_paths(text_body, imei)
    base = prefix + '/'
    tag = '<base href="{}">'.format(base)
    # Force absolute /api|/static fetch/XHR onto the proxy prefix (base tag ignores leading '/').
    # Use %s (not str.format) — the JS payload contains many `{` / `}` braces.
    hook = (
        '<script>(function(p){if(window.__ufiProxyHook)return;window.__ufiProxyHook=1;'
        'function fix(u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf(p)!==0)return p+u;return u;}'
        'var f=window.fetch;if(f){window.fetch=function(u,o){if(u&&typeof u==="object"&&u.url)'
        '{try{u=new Request(fix(u.url),u)}catch(e){u=fix(String(u.url))}}else{u=fix(u)}'
        'return f.call(this,u,o)};}'
        'var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){'
        'if(arguments.length>1)arguments[1]=fix(arguments[1]);return o.apply(this,arguments)};'
        '})("%s")</script>'
    ) % prefix
    if not re.search(r'<base\s', text_body, flags=re.I):
        if re.search(r'<head[^>]*>', text_body, flags=re.I):
            text_body = re.sub(r'(<head[^>]*>)', r'\1' + tag, text_body, count=1, flags=re.I)
        else:
            text_body = tag + text_body
    if '__ufiProxyHook' not in text_body:
        if re.search(r'<head[^>]*>', text_body, flags=re.I):
            text_body = re.sub(
                r'(<head[^>]*>)',
                lambda m: m.group(1) + hook,
                text_body,
                count=1,
                flags=re.I,
            )
        else:
            text_body = hook + text_body
    return text_body.encode('utf-8')


def _rewrite_proxied_body(body, content_type, imei):
    if not body:
        return body
    ct = (content_type or '').lower()
    if 'text/html' in ct:
        return _inject_html_base(body, imei)
    if any(x in ct for x in ('javascript', 'ecmascript', 'text/css', 'application/json')):
        try:
            text = body.decode('utf-8')
        except Exception:
            try:
                text = body.decode('latin-1')
            except Exception:
                return body
        if 'javascript' in ct or 'ecmascript' in ct or 'text/css' in ct:
            text = _rewrite_absolute_paths(text, imei)
        # Avoid leaking device LAN URLs into the browser.
        if 'json' in ct:
            text = re.sub(
                r'https?://(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(?::\d+)?',
                _admin_proxy_prefix(imei),
                text,
            )
            text = re.sub(
                r'https?://127\.0\.0\.1(?::\d+)?',
                _admin_proxy_prefix(imei),
                text,
            )
            text = re.sub(
                r'https?://localhost(?::\d+)?',
                _admin_proxy_prefix(imei),
                text,
            )
        return text.encode('utf-8')
    return body


@api.route('/api/v1/ufi/devices/<imei>/tunnel', methods=['GET'])
@api_security
def getUfiDeviceTunnel(imei):
    """Admin tunnel status for reverse management (no device private IP)."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        imei = str(imei or '').strip()
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        from modules.api.ufi_ws import get_ufi_tunnel, UFI_SOFTAP_ADMIN, ws_connected_imeis
        tunnel = get_ufi_tunnel(imei)
        ws_on = imei in ws_connected_imeis()
        ready = bool(tunnel and tunnel.get('ready') and ws_on)
        return createApiResponse(msg='UFI admin tunnel', data=[{
            'imei': imei,
            'wsOnline': ws_on,
            'tunnelReady': ready,
            'adminHost': '127.0.0.1',
            'adminPort': (tunnel or {}).get('adminPort') or 8080,
            'adminPath': (tunnel or {}).get('adminPath') or '/',
            'adminProxyUrl': (_admin_proxy_prefix(imei) + '/') if ready else '',
            'softApUrl': UFI_SOFTAP_ADMIN,
            'registeredAt': (tunnel or {}).get('registeredAt'),
        }])
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>/admin-proxy/', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
@api.route('/api/v1/ufi/devices/<imei>/admin-proxy/<path:subpath>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
@api_security
def ufiDeviceAdminProxy(imei, subpath=''):
    """
    Cloud reverse proxy into device local admin (via WS admin_http_proxy).
    Login required. A tenant can only open a tunnel for its own IMEI.
    """
    from flask import Response
    from modules.api.ufi_ws import proxy_ufi_admin_http, get_ufi_tunnel, UFI_SOFTAP_ADMIN

    imei = str(imei or '').strip()
    if not imei:
        raise http_exceptions.BadRequest('imei is required')
    if not re.fullmatch(r'[0-9A-Za-z]{8,32}', imei):
        raise http_exceptions.BadRequest('imei is invalid')
    db = startSession()
    try:
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
    finally:
        db.close()

    tunnel = get_ufi_tunnel(imei)
    if tunnel is None or not tunnel.get('ready'):
        return createApiResponse(
            error='http',
            msg='admin tunnel not ready; device SoftAP (no internet): {}'.format(UFI_SOFTAP_ADMIN),
            data=[{
                'imei': imei,
                'tunnelReady': False,
                'softApUrl': UFI_SOFTAP_ADMIN,
                'adminProxyPath': _admin_proxy_prefix(imei) + '/',
            }],
            status_code=409,
        )

    admin_path = str(tunnel.get('adminPath') or '/').rstrip('/') or ''
    sub = str(subpath or '').lstrip('/')
    path = (admin_path + '/' + sub) if sub else (admin_path + '/' if admin_path else '/')
    if not path.startswith('/'):
        path = '/' + path
    qs = request.query_string.decode('utf-8', errors='ignore') if request.query_string else ''
    if qs:
        path = path + '?' + qs

    fwd_headers = {}
    for key, value in request.headers:
        if key.lower() in _HOP_BY_HOP or key.lower() in ('authorization', 'cookie'):
            continue
        fwd_headers[key] = value
    # Prefer JSON/HTML from device admin UIs
    fwd_headers.setdefault('Accept', request.headers.get('Accept') or '*/*')
    # Forward only namespaced device cookies (never Flask session).
    dev_cookie = _device_cookie_header(imei)
    if dev_cookie:
        fwd_headers['Cookie'] = dev_cookie

    body = request.get_data() if request.method not in ('GET', 'HEAD') else b''
    try:
        timeout_ms = int(request.headers.get('X-UFI-Proxy-Timeout') or 15000)
    except (TypeError, ValueError):
        timeout_ms = 15000

    result = proxy_ufi_admin_http(
        imei,
        method=request.method,
        path=path,
        headers=fwd_headers,
        body=body,
        timeout_ms=timeout_ms,
    )
    if not result.get('ok') and result.get('body') is None:
        return createApiResponse(
            error='http',
            msg=result.get('error') or 'proxy failed',
            data=[{
                'imei': imei,
                'error': result.get('error'),
                'softApUrl': result.get('softApUrl') or UFI_SOFTAP_ADMIN,
                'requestId': result.get('requestId'),
            }],
            status_code=504 if result.get('pending') else 502,
        )

    admin_port = int(result.get('adminPort') or tunnel.get('adminPort') or 8080)
    status = int(result.get('httpStatus') or 502)
    raw_headers = result.get('headers') or {}
    out_headers = {}
    content_type = ''
    set_cookies = []
    for key, value in raw_headers.items():
        lk = str(key).lower()
        if lk in _HOP_BY_HOP:
            continue
        if lk == 'set-cookie':
            # Device may return multiple Set-Cookie; headers dict may collapse them.
            if isinstance(value, (list, tuple)):
                for item in value:
                    set_cookies.append(_rewrite_set_cookie(imei, item))
            else:
                set_cookies.append(_rewrite_set_cookie(imei, value))
            continue
        if lk == 'location':
            out_headers[key] = _rewrite_admin_location(imei, value, admin_port)
            continue
        if lk == 'content-security-policy':
            # Device CSP often blocks proxied inline hooks / absolute paths.
            continue
        if lk == 'content-type':
            content_type = str(value)
        out_headers[key] = value

    body_out = _rewrite_proxied_body(result.get('body') or b'', content_type, imei)

    resp = Response(body_out, status=status)
    for key, value in out_headers.items():
        resp.headers[key] = value
    for cookie in set_cookies:
        if cookie:
            resp.headers.add('Set-Cookie', cookie)
    if content_type and 'Content-Type' not in resp.headers:
        resp.headers['Content-Type'] = content_type
    resp.headers['X-UFI-Admin-Proxy'] = imei
    # Helpful for operators debugging blank pages / auth.
    resp.headers['X-UFI-Admin-Path'] = path.split('?', 1)[0]
    return resp


@api.route('/api/v1/ufi/devices/<imei>/settings', methods=['POST'])
@api_security
def saveUfiDeviceSettings(imei):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        payload = _device_payload()
        settings_body = _pending_setting_fields(payload)
        settings_body['imei'] = imei
        dispatch = str(payload.get('dispatch') or '').lower() in ('1', 'true', 'yes', 'on')
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        raw_settings = json.dumps(settings_body, ensure_ascii=False, default=str)[:16000]
        db.execute(text(
            "UPDATE dsip_ufi_device SET pending_settings = :raw, saved_settings = :raw WHERE imei = :imei"
        ), {'raw': raw_settings, 'imei': imei})
        db.commit()
        from modules.api.ufi_ws import send_ufi_command, ws_connected_imeis
        result = {'ok': True, 'queued': True, 'sent': settings_body, 'dispatched': False}
        if dispatch and imei in ws_connected_imeis():
            result = send_ufi_command(imei, settings_body)
            result['dispatched'] = True
            db.execute(text(
                "UPDATE dsip_ufi_device SET last_cmd_json = :raw WHERE imei = :imei"
            ), {'raw': json.dumps(result, ensure_ascii=False, default=str)[:16000], 'imei': imei})
            db.commit()
        return createApiResponse(msg='settings queued', data=[result])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>/sim', methods=['POST'])
@api_security
def saveUfiDeviceSim(imei):
    """手工填写 SIM 号码。设备心跳若仍上报空号，不会覆盖这里保存的值。"""
    db = DummySession()
    try:
        payload = _device_payload()
        raw = str(payload.get('simNumber') or payload.get('sim_number') or '').strip()
        sim = re.sub(r'\D', '', raw)
        if raw and not sim:
            return createApiResponse(error='http', status_code=400, msg='SIM 号码只能包含数字')
        if sim and not re.fullmatch(r'\d{5,20}', sim):
            return createApiResponse(error='http', status_code=400, msg='SIM 号码需为 5–20 位数字')
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
        found = db.execute(text(
            "SELECT id FROM dsip_ufi_device WHERE imei=:imei"
        ), {'imei': imei}).first()
        if not found:
            return createApiResponse(error='http', status_code=404, msg='设备不存在')
        db.execute(text(
            "UPDATE dsip_ufi_device SET sim_number=:sim WHERE imei=:imei"
        ), {'sim': sim, 'imei': imei})
        if sim:
            pool = db.execute(text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema=DATABASE() AND table_name='dsip_ufi_pool'"
            )).first()
            if pool:
                db.execute(text(
                    "UPDATE dsip_ufi_pool SET sim=:sim, updated_at=NOW() WHERE imei=:imei"
                ), {'sim': sim, 'imei': imei})
        db.commit()
        return createApiResponse(msg='SIM 号码已保存', data=[{'imei': imei, 'simNumber': sim}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _call_outcome(item):
    """归一化呼叫结果：answered / rejected / failed / unanswered"""
    if int(item.get('answered') or 0):
        return 'answered'
    if int(item.get('rejected') or 0):
        return 'rejected'
    blob = '%s %s' % (item.get('result') or '', item.get('fail_reason') or item.get('failReason') or '')
    if re.search(r'fail|error|timeout|busy|cancel', blob, re.I):
        return 'failed'
    return 'unanswered'


def _call_direction(item):
    """归一化呼叫方向：in / out"""
    d = str(item.get('dir') or '').strip().lower()
    if d in ('out', 'outgoing', 'mo', 'outbound'):
        return 'out'
    if d in ('in', 'incoming', 'mt', 'inbound'):
        return 'in'
    m = re.search(r'dir=(MO|MT)', str(item.get('volte_log') or item.get('volteLog') or ''))
    if m:
        return 'out' if m.group(1) == 'MO' else 'in'
    return 'in'


def _aggregate_ufi_calls(db, call_rows, with_route_log=True):
    """将固件分片上报聚合成一通电话一条记录（语义边界：DIALING/INCOMING）。"""
    import datetime as _dt

    def _ts_sec(v):
        s = str(v or '')
        try:
            x = float(s)
            return x / 1000.0 if x > 1e11 else x
        except ValueError:
            pass
        try:
            return _dt.datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S').timestamp()
        except ValueError:
            return None

    def _row_ts(r):
        return _ts_sec(r.get('start_ts') or r.get('created_at')) or 0.0

    def _row_end(r):
        return _ts_sec(r.get('end_ts') or r.get('start_ts') or r.get('created_at')) or 0.0

    _START_RE = re.compile(r'state=(?:DIALING|INCOMING)\b')
    _MAX_IDLE = 600.0
    _groups = []
    cur = None
    for row in sorted(call_rows, key=_row_ts):
        _logtxt = str(row.get('volte_log') or '') + '\n' + str(row.get('sip_log') or '')
        is_start = bool(_START_RE.search(_logtxt))
        t0 = _row_ts(row)
        if (cur is None or is_start
                or str(row.get('imei') or '') != cur['imei']
                or t0 - cur['t_end'] > _MAX_IDLE):
            if is_start and cur is not None and not cur['started'] \
                    and str(row.get('imei') or '') == cur['imei']:
                cur['rows'].append(row)
                cur['started'] = True
                cur['t_end'] = max(cur['t_end'], _row_end(row))
                continue
            cur = {'rows': [row], 'imei': str(row.get('imei') or ''),
                   't_start': t0, 't_end': _row_end(row), 'started': is_start}
            _groups.append(cur)
        else:
            cur['rows'].append(row)
            if is_start:
                cur['started'] = True
            cur['t_end'] = max(cur['t_end'], _row_end(row))

    def _ts_key(v):
        s = str(v or '')
        try:
            return (0, float(s))
        except ValueError:
            return (1, s)

    calls = []
    for gi, grp in enumerate(_groups):
        rows = grp['rows']
        item = dict(rows[0])
        if len(rows) > 1:
            item['start_ts'] = rows[0].get('start_ts') or rows[0].get('created_at')
            _ends = [r.get('end_ts') for r in rows if r.get('end_ts')]
            if _ends:
                item['end_ts'] = max(_ends, key=_ts_key)
            else:
                item['end_ts'] = max(
                    (r.get('created_at') or r.get('start_ts') for r in rows),
                    key=_ts_key, default=item.get('end_ts'))
            item['answered'] = max(int(r.get('answered') or 0) for r in rows)
            item['rejected'] = max(int(r.get('rejected') or 0) for r in rows)
            item['reject_code'] = next(
                (int(r.get('reject_code') or 0) for r in rows if int(r.get('reject_code') or 0)), 0)
            item['duration_sec'] = max(int(r.get('duration_sec') or 0) for r in rows)
            last = rows[-1]
            item['result'] = last.get('result') or item.get('result') or ''
            item['fail_reason'] = last.get('fail_reason') or item.get('fail_reason') or ''
            item['dir'] = next((r.get('dir') for r in rows if r.get('dir')), '') or item.get('dir') or ''
            item['peer'] = next((r.get('peer') for r in rows if r.get('peer')), '') or item.get('peer') or ''
            for _col in ('volte_log', 'sip_log'):
                _lines, _seen = [], set()
                for r in rows:
                    for ln in str(r.get(_col) or '').splitlines():
                        _k = ln.strip()
                        if _k and _k not in _seen:
                            _seen.add(_k)
                            _lines.append(ln)
                item[_col] = '\n'.join(_lines)
        if not int(item.get('duration_sec') or 0):
            _vl = str(item.get('volte_log') or '')
            _tact = re.findall(
                r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\s*\|\s*VoLTE state=ACTIVE', _vl)
            _tend = re.findall(
                r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\s*\|\s*VoLTE state=END', _vl)
            if _tact and _tend:
                try:
                    _d = (_dt.datetime.strptime(_tend[-1], '%Y-%m-%d %H:%M:%S')
                          - _dt.datetime.strptime(_tact[0], '%Y-%m-%d %H:%M:%S')).total_seconds()
                    if _d > 0:
                        item['duration_sec'] = int(_d)
                except ValueError:
                    pass
        if item.get('created_at') is not None:
            item['created_at'] = str(item['created_at'])
        # 保留 JOIN 带来的通信属性（若有）
        if 'carrier' in rows[0]:
            item['carrier'] = rows[0].get('carrier') or item.get('carrier') or ''
        if 'pool_id' in rows[0]:
            item['pool_id'] = rows[0].get('pool_id') or item.get('pool_id') or ''
            item['poolId'] = item['pool_id']
        item['traceId'] = item.get('trace_id')
        item['rejectCode'] = item.get('reject_code')
        item['durationSec'] = item.get('duration_sec')
        item['startTs'] = item.get('start_ts') or item.get('created_at')
        item['endTs'] = item.get('end_ts') or item.get('created_at')
        item['failReason'] = item.get('fail_reason')
        item['volteLog'] = item.get('volte_log')
        item['sipLog'] = item.get('sip_log')
        _cap = _groups[gi + 1]['t_start'] - 1 if gi + 1 < len(_groups) else None
        if with_route_log:
            item['routeLog'] = _route_log_for_call(
                db, item.get('imei'), item.get('start_ts'), item.get('end_ts'), _cap)
        else:
            item['routeLog'] = ''
            item['_route_cap'] = _cap
        _cids = set(re.findall(
            r'\|\s*([0-9a-fA-F]{12,40})\s*$', str(item.get('routeLog') or ''), re.M))
        item['routeCallId'] = (
            sorted(_cids)[0] if len(_cids) == 1 else (','.join(sorted(_cids)) if _cids else ''))
        if not item.get('peer'):
            m = re.search(r'ouser\s+([0-9*+#]+)', str(item.get('routeLog') or ''))
            if not m:
                m = re.search(r'tel=([0-9*+#]+)', str(item.get('volte_log') or ''))
            if m:
                item['peer'] = m.group(1)
        if not item.get('dir'):
            m = re.search(r'dir=(MO|MT)', str(item.get('volte_log') or ''))
            if m:
                item['dir'] = 'outgoing' if m.group(1) == 'MO' else 'incoming'
        item['outcome'] = _call_outcome(item)
        item['direction'] = _call_direction(item)
        calls.append(item)
    calls.reverse()
    return calls


def _attach_route_logs(db, items):
    """仅为当前页通话补齐 route 侧日志（避免全量关联 acc）。"""
    for item in items:
        if item.get('routeLog'):
            continue
        _cap = item.pop('_route_cap', None)
        item['routeLog'] = _route_log_for_call(
            db, item.get('imei'), item.get('start_ts'), item.get('end_ts'), _cap)
        _cids = set(re.findall(
            r'\|\s*([0-9a-fA-F]{12,40})\s*$', str(item.get('routeLog') or ''), re.M))
        item['routeCallId'] = (
            sorted(_cids)[0] if len(_cids) == 1 else (','.join(sorted(_cids)) if _cids else ''))
        if not item.get('peer'):
            m = re.search(r'ouser\s+([0-9*+#]+)', str(item.get('routeLog') or ''))
            if not m:
                m = re.search(r'tel=([0-9*+#]+)', str(item.get('volte_log') or ''))
            if m:
                item['peer'] = m.group(1)
        item.pop('_route_cap', None)
    return items


def _route_log_for_call(db, imei, start_ts, end_ts, max_end_sec=None):
    """关联 kamailio acc 表，取该设备在通话时间窗内的呼叫记录（route 侧日志）。"""
    try:
        s = int(str(start_ts or '')[:13]) / 1000.0
    except (TypeError, ValueError):
        return ''
    if not s:
        return ''
    try:
        e = int(str(end_ts or '')[:13]) / 1000.0
    except (TypeError, ValueError):
        e = 0.0
    if not e or e < s:
        e = s + 120.0
    # 关联窗口 [s-10, e+30]，且不越过下一通电话的开始时间（背靠背通话防串组）
    t1 = e + 30.0
    if max_end_sec:
        t1 = min(t1, max_end_sec)
    try:
        rows = db.execute(text(
            "SELECT time, method, sip_code, sip_reason, src_user, dst_user, dst_ouser, src_ip, callid "
            "FROM acc "
            "WHERE (src_user = :imei OR dst_user = :imei) "
            "AND time BETWEEN FROM_UNIXTIME(:t0) AND FROM_UNIXTIME(:t1) "
            "ORDER BY time"
        ), {'imei': imei, 't0': s - 10, 't1': t1}).mappings().all()
    except Exception:
        return ''
    lines = []
    for r in rows:
        lines.append('{} | {} {} {} | {} -> {} (ouser {}) | gw {} | {}'.format(
            str(r.get('time')), r.get('method'), r.get('sip_code'), r.get('sip_reason'),
            r.get('src_user'), r.get('dst_user'), r.get('dst_ouser'),
            r.get('src_ip'), str(r.get('callid'))[:18]))
    return '\n'.join(lines)


@api.route('/api/v1/ufi/records', methods=['GET'])
@api_security
def listUfiRecords():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        from modules.api.acl import scoped_imei
        sms_frag, sms_p = scoped_imei('')
        call_frag, call_p = scoped_imei('c')
        ev_frag, ev_p = scoped_imei('')
        sms_rows = db.execute(text(
            "SELECT imei, sms_id, sms_type, sms_body, smsm_tel, sms_timestamp, result_code, fail_result, created_at "
            "FROM dsip_ufi_sms WHERE 1=1" + sms_frag + " ORDER BY id DESC LIMIT 500"
        ), sms_p).mappings().all()
        call_rows = db.execute(text(
            "SELECT c.imei, c.trace_id, c.dir, c.peer, c.answered, c.rejected, c.reject_code, c.duration_sec, "
            "c.start_ts, c.end_ts, c.result, c.fail_reason, c.volte_log, c.sip_log, c.created_at "
            "FROM dsip_ufi_call c WHERE 1=1" + call_frag + " ORDER BY c.id DESC LIMIT 500"
        ), call_p).mappings().all()
        event_rows = db.execute(text(
            "SELECT imei, msg_type, payload, created_at FROM dsip_ufi_event WHERE 1=1" + ev_frag + " ORDER BY id DESC LIMIT 40"
        ), ev_p).mappings().all()
        sms = []
        for row in sms_rows:
            item = dict(row)
            if item.get('created_at') is not None:
                item['created_at'] = str(item['created_at'])
            item['smsId'] = item.get('sms_id')
            item['smsType'] = item.get('sms_type')
            item['smsBody'] = item.get('sms_body')
            item['smsmTel'] = item.get('smsm_tel')
            item['smsTimestamp'] = item.get('sms_timestamp') or item.get('created_at')
            item['resultCode'] = item.get('result_code')
            item['failResult'] = item.get('fail_result')
            sms.append(item)
        # 设备固件分片上报 → 语义边界聚合成一通电话（见 _aggregate_ufi_calls）
        calls = _aggregate_ufi_calls(db, call_rows, with_route_log=True)
        events = []
        for row in event_rows:
            payload = _json_obj(row.get('payload'))
            events.append(_format_device_event(
                row.get('msg_type'), payload, row.get('created_at'), row.get('imei') or ''))
        # 合并异常告警（心跳/SIP/VoLTE 掉线等），概览「实时事件流」一并可读展示
        try:
            alert_rows = db.execute(text(
                "SELECT imei, kind, level, detail, created_at FROM dsip_ufi_alert WHERE 1=1" + ev_frag + " "
                "ORDER BY id DESC LIMIT 40"
            ), ev_p).mappings().all()
            for ar in alert_rows:
                events.append(_format_alert_event(ar))
        except Exception:
            pass

        def _event_ts_key(ev):
            s = str(ev.get('ts') or ev.get('created_at') or '')
            return s

        events.sort(key=_event_ts_key, reverse=True)
        events = events[:40]
        return createApiResponse(msg='UFI records', data=[{
            'sms': sms,
            'calls': calls,
            'keyLogs': calls[:80] + [{
                'imei': s.get('imei'),
                'traceId': s.get('smsId'),
                'volteLog': '',
                'sipLog': s.get('failResult') or s.get('resultCode'),
                'endTs': s.get('smsTimestamp'),
            } for s in sms[:80]],
            'events': events,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/calls', methods=['GET'])
@api_security
def listUfiCalls():
    """通话记录（聚合后）：支持 IMEI / 运营商组 / 时间区间 / 结果 / 方向过滤与分页。"""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)

        imei = str(request.args.get('imei') or '').strip()
        carrier = str(request.args.get('carrier') or '').strip()
        day_from = str(request.args.get('from') or '').strip()[:10]
        day_to = str(request.args.get('to') or '').strip()[:10]
        outcome = str(request.args.get('result') or request.args.get('outcome') or '').strip().lower()
        direction = str(request.args.get('dir') or request.args.get('direction') or '').strip().lower()
        if direction in ('outgoing', 'mo', 'outbound'):
            direction = 'out'
        elif direction in ('incoming', 'mt', 'inbound'):
            direction = 'in'
        try:
            page = max(1, int(request.args.get('page') or 1))
        except (TypeError, ValueError):
            page = 1
        try:
            page_size = int(request.args.get('page_size') or request.args.get('pageSize') or 25)
        except (TypeError, ValueError):
            page_size = 25
        page_size = max(1, min(200, page_size))

        # 日期过滤在聚合后按 startTs 做；SQL 侧放宽 1 天以免切掉跨日分片
        sql = (
            "SELECT c.imei, c.trace_id, c.dir, c.peer, c.answered, c.rejected, c.reject_code, "
            "c.duration_sec, c.start_ts, c.end_ts, c.result, c.fail_reason, "
            "c.volte_log, c.sip_log, c.created_at, "
            "COALESCE(p.carrier, '') AS carrier, COALESCE(p.pool_id, '') AS pool_id "
            "FROM dsip_ufi_call c "
            "LEFT JOIN dsip_ufi_pool p ON p.imei = c.imei "
            "WHERE 1=1"
        )
        from modules.api.acl import scoped_imei
        params = {}
        frag, fp = scoped_imei('c')
        sql += frag
        params.update(fp)
        if imei:
            sql += " AND c.imei LIKE :imei"
            params['imei'] = '%' + imei + '%'
        if carrier:
            sql += " AND COALESCE(p.carrier, '') = :carrier"
            params['carrier'] = carrier
        if day_from:
            # 放宽 1 天：前一日分片可能属于本区间通话；聚合后再按 startTs 精确裁剪
            sql += " AND c.created_at >= DATE_SUB(:d0, INTERVAL 1 DAY)"
            params['d0'] = day_from + ' 00:00:00'
        if day_to:
            sql += " AND c.created_at < DATE_ADD(:d1, INTERVAL 2 DAY)"
            params['d1'] = day_to + ' 00:00:00'
        sql += " ORDER BY c.id DESC LIMIT 5000"
        call_rows = db.execute(text(sql), params).mappings().all()

        calls = _aggregate_ufi_calls(db, call_rows, with_route_log=False)

        def _day_of(item):
            s = str(item.get('startTs') or item.get('created_at') or '')
            if len(s) >= 10 and s[4] == '-' and s[7] == '-':
                return s[:10]
            # epoch ms / s
            try:
                x = float(s)
                if x > 1e11:
                    x = x / 1000.0
                import datetime as _dt
                return _dt.datetime.fromtimestamp(x).strftime('%Y-%m-%d')
            except (ValueError, OSError, OverflowError):
                return ''

        hits = []
        for c in calls:
            if day_from or day_to:
                day = _day_of(c)
                if day_from and day and day < day_from:
                    continue
                if day_to and day and day > day_to:
                    continue
            if outcome and c.get('outcome') != outcome:
                continue
            if direction and c.get('direction') != direction:
                continue
            hits.append(c)

        total = len(hits)
        pages = max(1, (total + page_size - 1) // page_size)
        if page > pages:
            page = pages
        start = (page - 1) * page_size
        page_items = hits[start:start + page_size]
        _attach_route_logs(db, page_items)

        # 精简列表字段体积：日志保留供详情弹窗，但去掉未使用的内部键
        for it in page_items:
            it.pop('_route_cap', None)

        return createApiResponse(msg='UFI calls found', data=[{
            'total': total,
            'page': page,
            'pageSize': page_size,
            'pages': pages,
            'calls': page_items,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _handle_device_record():
    payload = _device_payload()
    persist_ufi_payload(payload, {'event': True, 'last_msg_type': _field(payload, 'msgType')})
    return jsonify({
        'code': 200,
        'msgType': _field(payload, 'msgType') or 'Ufi-Status-Log-Indication',
        'requestId': _field(payload, 'requestId'),
        'lteStatus': 'success',
        'comment': 'success',
    })


@api.route('/ufi-app/api/ufi/status-log', methods=['POST'])
@api.route('/api/ufi/status-log', methods=['POST'])
@api.route('/ufi-app/api/ufi/transfer-sms', methods=['POST'])
@api.route('/api/ufi/transfer-sms', methods=['POST'])
@api.route('/ufi-app/api/ufi/save-call-reject-record', methods=['POST'])
@api.route('/api/ufi/save-call-reject-record', methods=['POST'])
def ufiDeviceRecords():
    return _handle_device_record()


def _ufi_log_dir():
    return str(getattr(settings, 'UFI_LOG_DIR', '') or '/var/lib/dsiprouter/ufi_logs')


def _handle_upload_file():
    """Device log upload (UFI API v2.9): multipart form fileName/sign/imei/file,
    sign = sha256(fileName + imei + secretKey). Also tolerates JSON+base64 uploads."""
    try:
        if settings.DEBUG:
            debugEndpoint()
        imei = file_name = sign = ''
        orig_name = ''
        blob = None
        if request.files:
            upload = request.files.get('file') or next(iter(request.files.values()), None)
            form = request.form.to_dict()
            imei = _field(form, 'imei')
            file_name = _field(form, 'fileName', 'filename')
            sign = str(form.get('sign') or '').strip()
            if upload is not None:
                # prefer the real filename of the file part (e.g. ufi_log_tcpdump.tgz);
                # the fileName form field may carry the msgType name instead
                orig_name = (upload.filename or '').strip()
                if not file_name:
                    file_name = orig_name
                blob = upload.read()
        else:
            payload = _device_payload()
            imei = _field(payload, 'imei')
            file_name = _field(payload, 'fileName', 'filename', 'name')
            sign = str(payload.get('sign') or '').strip()
            b64 = _field(payload, 'fileData', 'file', 'content')
            if b64:
                try:
                    blob = base64.b64decode(b64)
                except Exception:
                    blob = None

        if not imei:
            return jsonify({'code': 400, 'imei': '', 'comment': 'imei required'}), 200
        if blob is None or len(blob) == 0:
            return jsonify({'code': 400, 'imei': imei, 'comment': 'file missing or empty'}), 200

        db = DummySession()
        try:
            db = startSession()
            _ensure_ufi_tables(db)
            secret = _load_ufi_config(db)['secret_key']
            # doc: sign = sha256(fileName + imei + secretKey), no separator
            expected = hashlib.sha256('{}{}{}'.format(file_name, imei, secret).encode('utf-8')).hexdigest()
            if not sign or not hmac.compare_digest(expected.lower(), sign.lower()):
                db.rollback()
                return jsonify({'code': 401, 'imei': imei, 'comment': 'sign invalid'}), 200

            imei_clean = re.sub(r'[^0-9A-Za-z_-]', '_', imei)
            log_dir = os.path.join(_ufi_log_dir(), imei_clean)
            os.makedirs(log_dir, exist_ok=True)
            # service runs with umask 0117 -> dirs created 660 (no x bit), breaking later opens
            if not os.access(log_dir, os.X_OK):
                os.chmod(log_dir, 0o750)
            safe_name = re.sub(r'[^0-9A-Za-z._-]', '_', orig_name or file_name) or 'upload.log'
            # stored & recorded as <imei>_<original name>_<YYYYmmdd_HHMMSS_mmm><ext> (readable, collision-free)
            root, ext = os.path.splitext(safe_name)
            if not ext and blob[:2] == b'\x1f\x8b':
                ext = '.tgz'  # gzip content without extension (e.g. fileName carries msgType)
            now = time.time()
            ts = time.strftime('%Y%m%d_%H%M%S', time.localtime(now)) + ('_%03d' % int((now % 1) * 1000))
            stored_name = '{}_{}_{}{}'.format(root, imei_clean, ts, ext or '.log')[:255]
            stored_path = os.path.join(log_dir, stored_name)
            with open(stored_path, 'wb') as fh:
                fh.write(blob)
            os.chmod(stored_path, 0o640)
            db.execute(text(
                "INSERT INTO dsip_ufi_file (imei, file_name, file_size, stored_path, created_at) "
                "VALUES (:imei, :file_name, :file_size, :stored_path, NOW())"
            ), {
                'imei': imei,
                'file_name': stored_name,
                'file_size': len(blob),
                'stored_path': stored_path[:512],
            })
            db.commit()
            return jsonify({'code': 200, 'imei': imei, 'comment': '成功'})
        except Exception as ex:
            db.rollback()
            return jsonify({'code': 500, 'imei': imei, 'comment': str(ex)[:200]}), 200
        finally:
            db.close()
    except Exception as ex:
        return jsonify({'code': 500, 'imei': imei if isinstance(imei, str) else '', 'comment': str(ex)[:200]}), 200


@api.route('/ufi-app/api/ufi/upload-file', methods=['POST'])
@api.route('/api/ufi/upload-file', methods=['POST'])
def ufiUploadFile():
    return _handle_upload_file()


@api.route('/api/v1/ufi/files', methods=['GET'])
@api.route('/api/v1/ufi/devices/<imei>/files', methods=['GET'])
@api_security
def listUfiFiles(imei=None):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        try:
            limit = min(max(int(request.args.get('limit') or 200), 1), 500)
        except (TypeError, ValueError):
            limit = 200
        from modules.api.acl import scoped_imei
        query = "SELECT id, imei, file_name, file_size, stored_path, created_at FROM dsip_ufi_file WHERE 1=1 "
        params = {'limit': limit}
        frag, fp = scoped_imei('')
        query += frag + " "
        params.update(fp)
        if imei:
            _require_imei(db, imei)
            query += "AND imei = :imei "
            params['imei'] = imei
        query += "ORDER BY id DESC LIMIT :limit"
        rows = db.execute(text(query), params).mappings().all()
        data = []
        for row in rows:
            item = dict(row)
            item.pop('stored_path', None)
            if item.get('created_at') is not None:
                item['created_at'] = str(item['created_at'])
            data.append(item)
        return createApiResponse(msg='UFI log files', data=data)
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/files/<int:file_id>/download', methods=['GET'])
@api_security
def downloadUfiFile(file_id):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        row = db.execute(text(
            "SELECT imei, file_name, stored_path FROM dsip_ufi_file WHERE id = :id"
        ), {'id': file_id}).mappings().first()
        if row is None:
            raise http_exceptions.NotFound('UFI log file not found')
        _require_imei(db, row['imei'])
        stored_path = str(row['stored_path'] or '')
        if not stored_path or not os.path.isfile(stored_path):
            raise http_exceptions.Gone('file content missing on server')
        # Flask/werkzeug streams the file with WSGI-file wrapper; conditional adds Range/304 support
        return send_file(
            stored_path,
            as_attachment=True,
            download_name=str(row['file_name'] or 'ufi-log.log'),
            conditional=True,
        )
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/devices/<imei>/command/<request_id>/result', methods=['GET'])
@api_security
def getUfiCommandResult(imei, request_id):
    """Long-poll the reply of a previously dispatched command (device replies via WebSocket)."""
    db = DummySession()
    try:
        db = startSession()
        _ensure_ufi_tables(db)
        _require_imei(db, imei)
    finally:
        db.close()
    try:
        wait = min(max(int(request.args.get('wait') or 25), 1), 30)
    except (TypeError, ValueError):
        wait = 25
    from modules.api.ufi_ws import poll_ufi_command_result
    result = poll_ufi_command_result(request_id, wait)
    if not result.get('ok'):
        return createApiResponse(error='http', msg=result.get('error') or 'result unavailable', data=[result], status_code=404)
    return createApiResponse(msg='command result', data=[result])
