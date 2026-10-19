# -*- coding: utf-8 -*-
"""
接入 IP 白名单：保护短信 OpenAPI 与通话运营商组（VOS）对接。

- scope=sms|all  → 第三方调用 /api/v1/sms/*、sendSms 等时校验来源 IP
- scope=carrier|all → 写入 Kamailio address（FLT_CARRIER），并限制新增/修改运营商网关 IP

开关关闭时行为与升级前一致（不拦截）。开启后须至少配置一条启用的 CIDR。
"""
from __future__ import annotations

import ipaddress
from datetime import datetime
from functools import wraps

from flask import request, session
from sqlalchemy import text

from database import Address, DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api
from shared import StatusCodes, debugEndpoint, getRequestData
import settings


WL_BASE = '/api/v1/ufi/access/whitelist'
TAG_NAME = 'ufi_ip_whitelist'
VALID_SCOPES = ('sms', 'carrier', 'all')


def _ensure_tables(db):
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ip_whitelist (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            cidr VARCHAR(64) NOT NULL,
            scope VARCHAR(16) NOT NULL DEFAULT 'all',
            note VARCHAR(255) NOT NULL DEFAULT '',
            enabled TINYINT NOT NULL DEFAULT 1,
            created DATETIME NOT NULL,
            UNIQUE KEY uk_cidr_scope (cidr, scope),
            INDEX idx_scope_en (scope, enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_ip_whitelist_cfg (
            id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
            sms_enabled TINYINT NOT NULL DEFAULT 0,
            carrier_enabled TINYINT NOT NULL DEFAULT 0,
            updated_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    row = db.execute(text("SELECT id FROM dsip_ip_whitelist_cfg WHERE id=1")).first()
    if not row:
        db.execute(text(
            "INSERT INTO dsip_ip_whitelist_cfg (id, sms_enabled, carrier_enabled, updated_at) "
            "VALUES (1, 0, 0, :n)"
        ), {'n': datetime.now()})
    db.commit()


def client_ip():
    """取真实客户端 IP（优先 X-Forwarded-For 首段 / X-Real-IP）。"""
    try:
        xff = (request.headers.get('X-Forwarded-For') or '').strip()
        if xff:
            return xff.split(',')[0].strip()
        return (request.headers.get('X-Real-IP') or request.remote_addr or '').strip()
    except Exception:
        return ''


def _parse_cidr(raw):
    s = str(raw or '').strip()
    if not s:
        raise ValueError('IP/CIDR 不能为空')
    # bare IP → /32 or /128
    try:
        if '/' not in s:
            ip = ipaddress.ip_address(s)
            return str(ip) + ('/32' if ip.version == 4 else '/128')
        net = ipaddress.ip_network(s, strict=False)
        return str(net)
    except ValueError as ex:
        raise ValueError('无效的 IP/CIDR: ' + s) from ex


def _ip_in_cidrs(ip_str, cidrs):
    try:
        ip = ipaddress.ip_address(str(ip_str).strip())
    except ValueError:
        return False
    for c in cidrs:
        try:
            if ip in ipaddress.ip_network(str(c), strict=False):
                return True
        except ValueError:
            continue
    return False


def get_cfg(db):
    _ensure_tables(db)
    r = db.execute(text(
        "SELECT sms_enabled, carrier_enabled FROM dsip_ip_whitelist_cfg WHERE id=1"
    )).mappings().first()
    return {
        'sms_enabled': int((r or {}).get('sms_enabled') or 0),
        'carrier_enabled': int((r or {}).get('carrier_enabled') or 0),
    }


def list_cidrs(db, scopes):
    """返回启用中的 CIDR 列表（scopes 为可迭代）。"""
    _ensure_tables(db)
    scopes = [s for s in scopes if s in VALID_SCOPES]
    if not scopes:
        return []
    ph = ','.join([':s' + str(i) for i in range(len(scopes))])
    params = {'s' + str(i): scopes[i] for i in range(len(scopes))}
    rows = db.execute(text(
        "SELECT cidr FROM dsip_ip_whitelist WHERE enabled=1 AND scope IN (" + ph + ")"
    ), params).fetchall()
    return [str(r[0]) for r in rows]


def is_sms_ip_allowed(db, ip=None):
    """短信 API：未开启开关 → 放行；开启后须命中 sms/all。"""
    cfg = get_cfg(db)
    if not cfg['sms_enabled']:
        return True, ''
    ip = (ip or client_ip()).strip()
    cidrs = list_cidrs(db, ('sms', 'all'))
    if not cidrs:
        return False, '短信 API 白名单已开启但未配置任何 IP'
    if not ip:
        return False, '无法识别客户端 IP'
    if _ip_in_cidrs(ip, cidrs):
        return True, ''
    return False, 'IP 不在短信 API 白名单中: ' + ip


def is_carrier_ip_allowed(db, ip_or_host):
    """通话运营商：未开启 → 放行；开启后网关 IP 须命中 carrier/all。"""
    cfg = get_cfg(db)
    if not cfg['carrier_enabled']:
        return True, ''
    cidrs = list_cidrs(db, ('carrier', 'all'))
    if not cidrs:
        return False, '运营商组白名单已开启但未配置任何 IP'
    host = str(ip_or_host or '').strip()
    # strip port / brackets
    if host.startswith('[') and ']' in host:
        host = host[1:host.index(']')]
    if ':' in host and host.count(':') == 1:
        host = host.split(':', 1)[0]
    try:
        ipaddress.ip_address(host)
    except ValueError:
        # hostname — resolve not required; allow if exact cidr match fails
        # treat as not an IP → reject under strict whitelist (must use IP)
        return False, '运营商组白名单开启时请使用 IP 地址（不支持域名）: ' + host
    if _ip_in_cidrs(host, cidrs):
        return True, ''
    return False, 'IP 不在运营商组白名单中: ' + host


def enforce_sms_ip(db=None):
    """供装饰器/路由调用；session 登录跳过。返回 (ok, err_msg)。"""
    if session.get('logged_in'):
        return True, ''
    own = False
    if db is None:
        db = startSession()
        own = True
    try:
        return is_sms_ip_allowed(db)
    finally:
        if own:
            db.close()


def sync_carrier_address(db):
    """
    将 carrier/all 白名单同步到 Kamailio address 表（tag name=ufi_ip_whitelist）。
    开启时写入；关闭时清理本模块写入的条目（不影响运营商组自带的 address）。
    """
    cfg = get_cfg(db)
    db.execute(text("DELETE FROM address WHERE tag LIKE :p"), {'p': '%' + TAG_NAME + '%'})
    db.flush()

    if not cfg['carrier_enabled']:
        db.commit()
        _reload_address()
        return {'synced': 0, 'enabled': 0}

    cidrs = list_cidrs(db, ('carrier', 'all'))
    added = 0
    for cidr in cidrs:
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            continue
        ip_addr = str(net.network_address)
        mask = int(net.prefixlen)
        db.add(Address(TAG_NAME, ip_addr, mask, settings.FLT_CARRIER))
        added += 1
    db.commit()
    _reload_address()
    return {'synced': added, 'enabled': 1}


def _reload_address():
    try:
        from modules.api.kamailio.functions import sendJsonRpcCmd
        sendJsonRpcCmd('127.0.0.1', 'permissions.addressReload')
    except Exception:
        pass


def require_sms_whitelist(func):
    """装饰器：非会话请求须通过短信白名单。"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        ok, err = enforce_sms_ip()
        if not ok:
            return createApiResponse(
                error='http', msg=err or 'Forbidden',
                status_code=StatusCodes.HTTP_FORBIDDEN
            )
        return func(*args, **kwargs)
    return wrapper


# ───────────────────────────── CRUD API ─────────────────────────────

@api.route(WL_BASE, methods=['GET', 'POST'])
@api.route(WL_BASE + '/cfg', methods=['GET', 'PUT', 'POST'])
@api_security
def whitelist_root():
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_tables(db)
        path = (request.path or '').rstrip('/')

        # GET/PUT cfg
        if path.endswith('/cfg'):
            if request.method == 'GET':
                cfg = get_cfg(db)
                return createApiResponse(msg='whitelist_cfg', data=[cfg])
            d = getRequestData() or {}
            sms_en = 1 if str(d.get('sms_enabled', d.get('smsEnabled', 0))).lower() in (
                '1', 'true', 'yes', 'on') else 0
            car_en = 1 if str(d.get('carrier_enabled', d.get('carrierEnabled', 0))).lower() in (
                '1', 'true', 'yes', 'on') else 0
            db.execute(text(
                "UPDATE dsip_ip_whitelist_cfg SET sms_enabled=:s, carrier_enabled=:c, updated_at=:n WHERE id=1"
            ), {'s': sms_en, 'c': car_en, 'n': datetime.now()})
            db.commit()
            sync_info = sync_carrier_address(db)
            return createApiResponse(msg='白名单开关已更新', data=[{
                'sms_enabled': sms_en,
                'carrier_enabled': car_en,
                'carrier_sync': sync_info,
            }])

        # list / create entries
        if request.method == 'GET':
            cfg = get_cfg(db)
            rows = db.execute(text(
                "SELECT id, cidr, scope, note, enabled, created FROM dsip_ip_whitelist "
                "ORDER BY scope, id DESC"
            )).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
                d['enabled'] = int(d.get('enabled') or 0)
                out.append(d)
            return createApiResponse(msg='whitelist', data=[{
                'cfg': cfg,
                'items': out,
                'client_ip': client_ip(),
            }])

        d = getRequestData() or {}
        try:
            cidr = _parse_cidr(d.get('cidr') or d.get('ip') or '')
        except ValueError as ex:
            return createApiResponse(error='http', status_code=400, msg=str(ex))
        scope = str(d.get('scope') or 'all').strip().lower()
        if scope not in VALID_SCOPES:
            return createApiResponse(error='http', status_code=400,
                                     msg='scope 须为 sms / carrier / all')
        note = str(d.get('note') or '').strip()[:255]
        now = datetime.now()
        try:
            db.execute(text(
                "INSERT INTO dsip_ip_whitelist (cidr, scope, note, enabled, created) "
                "VALUES (:c, :s, :n, 1, :t)"
            ), {'c': cidr, 's': scope, 'n': note, 't': now})
            rid = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()
            db.commit()
        except Exception:
            db.rollback()
            return createApiResponse(error='http', status_code=409,
                                     msg='该 scope 下已存在相同 CIDR')
        sync_carrier_address(db)
        return createApiResponse(msg='已添加白名单', data=[{
            'id': int(rid or 0), 'cidr': cidr, 'scope': scope, 'note': note, 'enabled': 1,
            'created': now.strftime('%Y-%m-%d %H:%M:%S'),
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(WL_BASE + '/<int:wid>', methods=['POST', 'PUT', 'DELETE'])
@api_security
def whitelist_item(wid):
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_tables(db)
        d = getRequestData() or {}
        action = str(d.get('action') or '').strip().lower()
        if request.method == 'DELETE':
            action = 'del'

        row = db.execute(text(
            "SELECT id FROM dsip_ip_whitelist WHERE id=:i"
        ), {'i': wid}).first()
        if not row:
            return createApiResponse(error='http', status_code=404, msg='条目不存在')

        if action in ('del', 'delete'):
            db.execute(text("DELETE FROM dsip_ip_whitelist WHERE id=:i"), {'i': wid})
            db.commit()
            sync_carrier_address(db)
            return createApiResponse(msg='已删除')

        if action == 'toggle':
            db.execute(text(
                "UPDATE dsip_ip_whitelist SET enabled = IF(enabled=1,0,1) WHERE id=:i"
            ), {'i': wid})
            db.commit()
            sync_carrier_address(db)
            return createApiResponse(msg='状态已更新')

        # update fields
        fields = []
        params = {'i': wid}
        if 'cidr' in d or 'ip' in d:
            try:
                params['c'] = _parse_cidr(d.get('cidr') or d.get('ip'))
            except ValueError as ex:
                return createApiResponse(error='http', status_code=400, msg=str(ex))
            fields.append('cidr=:c')
        if 'scope' in d:
            scope = str(d.get('scope') or '').strip().lower()
            if scope not in VALID_SCOPES:
                return createApiResponse(error='http', status_code=400, msg='无效 scope')
            params['s'] = scope
            fields.append('scope=:s')
        if 'note' in d:
            params['n'] = str(d.get('note') or '').strip()[:255]
            fields.append('note=:n')
        if 'enabled' in d:
            params['e'] = 1 if str(d.get('enabled')).lower() in ('1', 'true', 'yes', 'on') else 0
            fields.append('enabled=:e')
        if not fields:
            return createApiResponse(error='http', status_code=400, msg='无更新字段')
        db.execute(text(
            "UPDATE dsip_ip_whitelist SET " + ', '.join(fields) + " WHERE id=:i"
        ), params)
        db.commit()
        sync_carrier_address(db)
        return createApiResponse(msg='已更新')
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route(WL_BASE + '/sync-carrier', methods=['POST'])
@api_security
def whitelist_sync_carrier():
    db = DummySession()
    try:
        db = startSession()
        info = sync_carrier_address(db)
        return createApiResponse(msg='运营商白名单已同步到 Kamailio address', data=[info])
    except Exception as ex:
        db.rollback()
        return showApiError(ex)
    finally:
        db.close()
