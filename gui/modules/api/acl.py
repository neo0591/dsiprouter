# -*- coding: utf-8 -*-
"""客户、角色与菜单权限。

- 平台超级管理员（内置账号或 is_super 角色）可见全部客户数据。
- 普通用户归属一个客户，查询时按 customer_id 隔离。
- 角色保存菜单/子页签 key 列表；空列表且角色名为历史 dsip_admin 时视为全部菜单。
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from flask import session
from sqlalchemy import text
from werkzeug import exceptions as http_exceptions

# key, label, parent (None = top)
MENU_CATALOG = [
    ('dashboard', '仪表盘', None),
    ('biz', '营业管理', None),
    ('biz.ufi', 'UFI 设备', 'biz'),
    ('biz.ufi.overview', '运行总览', 'biz.ufi'),
    ('biz.ufi.devices', '设备监控', 'biz.ufi'),
    ('biz.ufi.commands', '指令与日志', 'biz.ufi'),
    ('biz.ufi.records', '通话与短信', 'biz.ufi'),
    ('biz.ufi.devlogs', '采集日志', 'biz.ufi'),
    ('biz.call', '通信管理', 'biz'),
    ('biz.call.topo', '线路总览', 'biz.call'),
    ('biz.call.pool', 'UFI 通信配置', 'biz.call'),
    ('biz.call.calls', '通话记录', 'biz.call'),
    ('biz.call.route', '号码与路由', 'biz.call'),
    ('biz.call.diag', '链路诊断', 'biz.call'),
    ('biz.call.pend', '变更任务', 'biz.call'),
    ('biz.call.sys', '对接参数', 'biz.call'),
    ('biz.sms', '短信中心', 'biz'),
    ('biz.sms.compose', '发送短信', 'biz.sms'),
    ('biz.sms.records', '收发记录', 'biz.sms'),
    ('biz.sms.alerts', '告警中心', 'biz.sms'),
    ('biz.sms.campaign', '群发任务', 'biz.sms'),
    ('biz.sms.channels', '通道与频控', 'biz.sms'),
    ('biz.sms.tpl', '短信模板', 'biz.sms'),
    ('biz.sms.blacklist', '黑名单', 'biz.sms'),
    ('biz.sms.words', '敏感词', 'biz.sms'),
    ('biz.sms.openapi', '开放 API', 'biz.sms'),
    ('carriers', '运营商组', None),
    ('endpoints', '终端组', None),
    ('domains', '域名', None),
    ('inbound', '入站路由', None),
    ('outbound', '出站路由', None),
    ('cdrs', '通话详单', None),
    ('help', '帮助中心', None),
    ('numbers', '号码', None),
    ('agents', '语音 AI 座席', None),
    ('sys', '系统设置', None),
    ('sys.settings', '全局设置', 'sys'),
    ('sys.customers', '客户与权限', 'sys'),
    ('sys.users', '用户管理', 'sys'),
    ('sys.backup', '备份还原', 'sys'),
    ('sys.certs', '证书', 'sys'),
    ('sys.teleblock', 'Teleblock', 'sys'),
    ('sys.transnexus', 'TransNexus', 'sys'),
    ('sys.stir', 'STIR/SHAKEN', 'sys'),
    ('sys.license', '许可证', 'sys'),
    ('sys.upgrade', '升级', 'sys'),
]

ALL_MENU_KEYS = [k for k, _l, _p in MENU_CATALOG]

# path prefix -> required menu key (first match wins, longest first)
PATH_MENU = [
    ('/users', 'sys.users'),
    ('/customers', 'sys.customers'),
    ('/settings', 'sys.settings'),
    ('/backupandrestore', 'sys.backup'),
    ('/certificates', 'sys.certs'),
    ('/teleblock', 'sys.teleblock'),
    ('/transnexus', 'sys.transnexus'),
    ('/stirshaken', 'sys.stir'),
    ('/licensing', 'sys.license'),
    ('/upgrade', 'sys.upgrade'),
    ('/ufi-sms', 'biz.sms'),
    ('/ufi-callcenter', 'biz.call'),
    ('/ufi', 'biz.ufi'),
    ('/gui/numbers', 'numbers'),
    ('/gui/agents', 'agents'),
    ('/phones', 'numbers'),
    ('/carriergroups', 'carriers'),
    ('/endpointgroups', 'endpoints'),
    ('/domains', 'domains'),
    ('/inboundmapping', 'inbound'),
    ('/outboundroutes', 'outbound'),
    ('/cdrs', 'cdrs'),
    ('/help', 'help'),
]


def menu_tree():
    nodes = {k: {'key': k, 'label': lab, 'children': []} for k, lab, _p in MENU_CATALOG}
    roots = []
    for k, _lab, parent in MENU_CATALOG:
        if parent and parent in nodes:
            nodes[parent]['children'].append(nodes[k])
        else:
            roots.append(nodes[k])
    return roots


def ensure_acl_tables(db):
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_customer (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(128) NOT NULL,
            code VARCHAR(64) NOT NULL DEFAULT '',
            note VARCHAR(255) NOT NULL DEFAULT '',
            enabled TINYINT NOT NULL DEFAULT 1,
            created DATETIME NOT NULL,
            UNIQUE KEY uk_code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS dsip_role (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            customer_id INT UNSIGNED NULL,
            name VARCHAR(64) NOT NULL,
            menus TEXT NOT NULL,
            is_super TINYINT NOT NULL DEFAULT 0,
            enabled TINYINT NOT NULL DEFAULT 1,
            UNIQUE KEY uk_role (customer_id, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    # customer_id on users
    cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_user")).all()]
    if 'customer_id' not in cols:
        db.execute(text("ALTER TABLE dsip_user ADD COLUMN customer_id INT UNSIGNED NULL"))
    # seed platform role
    n = db.execute(text("SELECT COUNT(*) FROM dsip_role WHERE customer_id IS NULL AND name='platform_admin'")).scalar()
    if not int(n or 0):
        db.execute(text(
            "INSERT INTO dsip_role (customer_id, name, menus, is_super, enabled) "
            "VALUES (NULL, 'platform_admin', :m, 1, 1)"
        ), {'m': json.dumps(ALL_MENU_KEYS)})
    n2 = db.execute(text("SELECT COUNT(*) FROM dsip_role WHERE customer_id IS NULL AND name='dsip_admin'")).scalar()
    if not int(n2 or 0):
        db.execute(text(
            "INSERT INTO dsip_role (customer_id, name, menus, is_super, enabled) "
            "VALUES (NULL, 'dsip_admin', :m, 1, 1)"
        ), {'m': json.dumps(ALL_MENU_KEYS)})
    cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_customer")).all()]
    if 'domain' not in cols:
        db.execute(text("ALTER TABLE dsip_customer ADD COLUMN domain VARCHAR(128) NULL"))
    db.execute(text("UPDATE dsip_role SET customer_id=NULL WHERE customer_id IS NOT NULL"))
    db.execute(text(
        "INSERT IGNORE INTO dsip_customer (name, code, note, enabled, created) "
        "VALUES ('默认租户', 'default', '存量数据归属', 1, NOW())"
    ))
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_import ("
        "id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,"
        "customer_id INT UNSIGNED NOT NULL,"
        "imei VARCHAR(32) NOT NULL DEFAULT '',"
        "sim VARCHAR(32) NOT NULL DEFAULT '',"
        "matched TINYINT NOT NULL DEFAULT 0,"
        "note VARCHAR(255) NOT NULL DEFAULT '',"
        "created DATETIME NOT NULL,"
        "matched_at DATETIME NULL,"
        "UNIQUE KEY uk_import_imei (imei),"
        "KEY idx_import_sim (sim),"
        "KEY idx_import_customer (customer_id, matched)"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    ))
    db.commit()
    _ensure_customer_cols(db)
    _cache_default_customer(db)
    backfill_tenants(db)


_SCOPED_TABLES = (
    'dsip_ufi_device', 'dsip_ufi_pool', 'dsip_ufi_pool_cfg', 'dsip_ufi_pool_did',
    'dsip_ufi_sms_msg', 'dsip_ufi_sms_task',
    'dsip_ufi_sms_sched', 'dsip_ufi_sms_tpl', 'dsip_ufi_sms_black', 'dsip_ufi_sms_word',
    'dsip_ufi_sms_apikey', 'dsip_ufi_sms_policy', 'dsip_ufi_sms_carrier', 'dsip_ufi_sms_sandbox_inbox',
    'dsip_ip_whitelist', 'dr_gw_lists', 'dr_rules', 'dsip_cdrinfo',
)

_DEFAULT_CID = None


def _ensure_customer_cols(db):
    for tbl in _SCOPED_TABLES:
        try:
            cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM " + tbl)).all()]
        except Exception:
            continue
        if cols and 'customer_id' not in cols:
            db.execute(text("ALTER TABLE %s ADD COLUMN customer_id INT UNSIGNED NULL" % tbl))
            db.execute(text("ALTER TABLE %s ADD INDEX idx_customer_id (customer_id)" % tbl))
    db.commit()


def _cache_default_customer(db):
    global _DEFAULT_CID
    cid = db.execute(text("SELECT id FROM dsip_customer WHERE code='default' LIMIT 1")).scalar()
    _DEFAULT_CID = int(cid) if cid else None
    return _DEFAULT_CID


def default_customer_id(db=None):
    """默认租户 id。优先用启动 seed 后的缓存，避免假设 id=1。"""
    if _DEFAULT_CID:
        return _DEFAULT_CID
    if db is None:
        return None
    return _cache_default_customer(db)


_BACKFILL_EXCLUDE = {'dsip_ufi_device'}


def backfill_tenants(db):
    """幂等回填。设备表不回填：customer_id 为空表示待认领，不能再塞进默认租户。"""
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_schema_flag ("
        "name VARCHAR(64) NOT NULL PRIMARY KEY, done TINYINT NOT NULL DEFAULT 1)"
    ))
    done = db.execute(text(
        "SELECT done FROM dsip_schema_flag WHERE name='mt_backfill_v2'"
    )).scalar()
    if not int(done or 0):
        cid = default_customer_id(db)
        if cid:
            for tbl in _SCOPED_TABLES:
                if tbl in _BACKFILL_EXCLUDE:
                    continue
                try:
                    cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM " + tbl)).all()]
                except Exception:
                    continue
                if 'customer_id' not in cols:
                    continue
                db.execute(text(
                    "UPDATE %s SET customer_id=:cid WHERE customer_id IS NULL" % tbl
                ), {'cid': cid})
        db.execute(text(
            "INSERT INTO dsip_schema_flag (name, done) VALUES ('mt_backfill_v2', 1)"
        ))
    v3 = db.execute(text(
        "SELECT done FROM dsip_schema_flag WHERE name='mt_backfill_v3'"
    )).scalar()
    if not int(v3 or 0):
        try:
            cols = [r[0] for r in db.execute(text("SHOW COLUMNS FROM dsip_ufi_device")).all()]
            if 'claim_status' not in cols:
                db.execute(text(
                    "ALTER TABLE dsip_ufi_device ADD COLUMN claim_status TINYINT NOT NULL DEFAULT 0"
                ))
            db.execute(text(
                "UPDATE dsip_ufi_device SET claim_status=1 "
                "WHERE customer_id IS NOT NULL AND claim_status=0"
            ))
        except Exception:
            pass
        db.execute(text(
            "INSERT INTO dsip_schema_flag (name, done) VALUES ('mt_backfill_v3', 1)"
        ))
    db.commit()


def resolve_device_customer(db, imei, sim=''):
    """预置表反查归属。IMEI 精确匹配，SIM 仅在预置行 sim 非空时做二次校验。未命中返回 None。"""
    imei = str(imei or '').strip()
    sim_digits = re.sub(r'\D', '', str(sim or ''))
    if not imei:
        return None
    row = db.execute(text(
        "SELECT id, customer_id, sim FROM dsip_ufi_import WHERE imei=:imei LIMIT 1 FOR UPDATE"
    ), {'imei': imei}).mappings().first()
    if row:
        preset_sim = re.sub(r'\D', '', str(row.get('sim') or ''))
        if preset_sim and sim_digits and preset_sim != sim_digits:
            return None
    elif sim_digits:
        row = db.execute(text(
            "SELECT id, customer_id, sim FROM dsip_ufi_import "
            "WHERE sim=:sim AND sim<>'' LIMIT 1 FOR UPDATE"
        ), {'sim': sim_digits}).mappings().first()
    if not row:
        return None
    db.execute(text(
        "UPDATE dsip_ufi_import SET matched=1, matched_at=NOW() WHERE id=:id"
    ), {'id': row['id']})
    return int(row['customer_id'])


def set_device_customer(db, imei, cid):
    """原子写归属。cid 为空则回到待认领并清掉已开通标记。"""
    db.execute(text(
        "UPDATE dsip_ufi_device SET "
        "customer_id=:cid, "
        "claim_status=IF(:cid IS NULL, 0, 1), "
        "provisioned=IF(:cid IS NULL, 0, provisioned) "
        "WHERE imei=:imei"
    ), {'cid': cid, 'imei': str(imei or '').strip()})


def tenant_domain(db, customer_id=None):
    """租户 domain；未配置时继承全局 EXTERNAL_IP_ADDR。"""
    import settings as _settings
    fallback = str(getattr(_settings, 'EXTERNAL_IP_ADDR', '') or '').strip()
    if not customer_id:
        return fallback
    try:
        dom = db.execute(text(
            "SELECT domain FROM dsip_customer WHERE id=:i"
        ), {'i': int(customer_id)}).scalar()
    except Exception:
        return fallback
    return str(dom or '').strip() or fallback


def is_platform_admin():
    return bool(session.get('is_platform_admin'))


def current_customer_id():
    if is_platform_admin():
        return None
    cid = session.get('customer_id')
    try:
        return int(cid) if cid not in (None, '', 0, '0') else None
    except (TypeError, ValueError):
        return None


def apply_customer_filter(where, params, col='customer_id'):
    """非平台管理员追加 customer_id 条件。无客户时匹配不可能的 id。"""
    if is_platform_admin():
        return
    cid = current_customer_id()
    if cid is None:
        where.append(col + '=-1')
        return
    where.append(col + '=:__cid')
    params['__cid'] = cid


def customer_sql(alias=''):
    """返回 AND 片段；平台管理员返回空串。"""
    col = (alias + '.' if alias else '') + 'customer_id'
    if is_platform_admin():
        return '', {}
    cid = current_customer_id()
    if cid is None:
        return ' AND ' + col + '=-1', {}
    return ' AND ' + col + '=:__cid', {'__cid': cid}


def stamp_customer(db=None):
    """写入新行时使用的 customer_id。平台管理员落默认租户，不再写 NULL。"""
    if is_platform_admin():
        return default_customer_id(db)
    return current_customer_id()


def require_owned_imei(db, imei):
    """写路径断言：非本租户（且非平台管理员）403。设备不存在对租户也返回 403。"""
    if is_platform_admin():
        return
    cid = current_customer_id()
    row = db.execute(text(
        "SELECT customer_id FROM dsip_ufi_device WHERE imei=:imei LIMIT 1"
    ), {'imei': str(imei or '').strip()}).first()
    owned = row[0] if row else None
    if cid is None or owned is None or int(owned) != int(cid):
        raise http_exceptions.Forbidden('设备不属于当前租户')


def scoped_imei(alias='d', column='imei'):
    """读路径：JOIN 语义的 EXISTS 片段。平台管理员返回空串。"""
    col = (alias + '.' if alias else '') + column
    if is_platform_admin():
        return '', {}
    cid = current_customer_id()
    if cid is None:
        return ' AND 1=0', {}
    sql = (" AND EXISTS (SELECT 1 FROM dsip_ufi_device _own "
           "WHERE _own.imei=%s AND _own.customer_id=:__cid)" % col)
    return sql, {'__cid': cid}


def tenant_gwgroup_ids(db):
    """当前租户的运营商组/网关组 id。平台管理员返回 None 表示不限制。"""
    if is_platform_admin():
        return None
    cid = current_customer_id()
    if cid is None:
        return []
    try:
        rows = db.execute(text(
            "SELECT id FROM dr_gw_lists WHERE customer_id=:cid"
        ), {'cid': cid}).all()
    except Exception:
        return []
    return [int(r[0]) for r in rows]


def assert_gwgroup(db, gwgroupid):
    """gwgroupid=0（全量）仅平台管理员。租户只能查自己的组。"""
    if is_platform_admin():
        return
    gid = int(gwgroupid) if str(gwgroupid).isdigit() else 0
    allowed = set(tenant_gwgroup_ids(db))
    if gid == 0 or gid not in allowed:
        raise http_exceptions.Forbidden('通话详单不属于当前租户')


def _menus_of_roles(db, names, customer_id=None):
    """角色不归属客户。用户勾了哪个角色，就用该角色的菜单；客户只挂在用户上。"""
    if not names:
        return [], False
    ph = ','.join([':n' + str(i) for i in range(len(names))])
    params = {'n' + str(i): names[i] for i in range(len(names))}
    rows = db.execute(text(
        "SELECT name, menus, is_super FROM dsip_role WHERE enabled=1 AND name IN (" + ph + ")"
    ), params).mappings().all()
    menus = set()
    super_ = False
    for r in rows:
        if int(r.get('is_super') or 0) == 1:
            super_ = True
        try:
            arr = json.loads(r.get('menus') or '[]')
        except Exception:
            arr = []
        if arr == ['*'] or not arr and r.get('name') in ('dsip_admin', 'platform_admin'):
            menus.update(ALL_MENU_KEYS)
        else:
            menus.update(str(x) for x in arr)
    return sorted(menus), super_


def resolve_acl(db, username, builtin=False):
    ensure_acl_tables(db)
    if builtin:
        return {
            'customer_id': None,
            'customer_name': '',
            'is_platform_admin': True,
            'menus': list(ALL_MENU_KEYS),
            'roles': ['dsip_admin', 'platform_admin'],
        }
    row = db.execute(text(
        "SELECT id, roles, customer_id FROM dsip_user WHERE username=:u LIMIT 1"
    ), {'u': username}).mappings().first()
    roles = [r for r in str((row or {}).get('roles') or '').split(',') if r]
    cid = (row or {}).get('customer_id')
    cname = ''
    if cid:
        cname = db.execute(text("SELECT name FROM dsip_customer WHERE id=:i"), {'i': cid}).scalar() or ''
    menus, super_ = _menus_of_roles(db, roles, cid)
    # 历史账号：角色名含 dsip_admin 且未绑定客户 → 平台管理员
    if (not cid) and ('dsip_admin' in roles or 'platform_admin' in roles):
        super_ = True
        menus = list(ALL_MENU_KEYS)
    if super_:
        menus = list(ALL_MENU_KEYS)
    return {
        'customer_id': int(cid) if cid else None,
        'customer_name': cname or '',
        'is_platform_admin': bool(super_),
        'menus': menus,
        'roles': roles,
    }


def apply_session(ctx):
    session['customer_id'] = ctx.get('customer_id')
    session['customer_name'] = ctx.get('customer_name') or ''
    session['is_platform_admin'] = bool(ctx.get('is_platform_admin'))
    session['menu_perms'] = ctx.get('menus') or []
    if ctx.get('roles') is not None:
        session['user_groups'] = ctx.get('roles') or []


def menu_allowed(key):
    if is_platform_admin():
        return True
    # 尚未重新登录的历史管理员会话：dsip_admin 仍放行
    groups = session.get('user_groups') or []
    if not session.get('menu_perms') and ('dsip_admin' in groups or 'platform_admin' in groups):
        return True
    perms = set(session.get('menu_perms') or [])
    if key in perms:
        return True
    # 父菜单：任一子项允许则父级可见
    prefix = key + '.'
    return any(p.startswith(prefix) for p in perms)


def path_allowed(path):
    if not session.get('logged_in'):
        return True
    if is_platform_admin():
        return True
    path = path or '/'
    if path in ('/', '/index', '/logout', '/login', '/set_language'):
        return True
    for prefix, key in PATH_MENU:
        if path == prefix or path.startswith(prefix + '/'):
            return menu_allowed(key)
    return True


# ───────────────────────────── HTTP API ─────────────────────────────
from flask import request
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api


def _require_users_menu():
    if not session.get('logged_in'):
        return createApiResponse(error='http', msg='Unauthorized', status_code=401)
    if not (is_platform_admin() or menu_allowed('sys.users') or menu_allowed('sys.customers')):
        return createApiResponse(error='http', msg='无权限', status_code=403)
    return None


@api.route('/api/v1/acl/catalog', methods=['GET'])
@api_security
def acl_catalog():
    denied = _require_users_menu()
    if denied:
        return denied
    return createApiResponse(msg='catalog', data=[{
        'tree': menu_tree(),
        'keys': ALL_MENU_KEYS,
        'is_platform_admin': is_platform_admin(),
        'customer_id': current_customer_id(),
        'customer_name': session.get('customer_name') or '',
    }])


@api.route('/api/v1/acl/customers', methods=['GET', 'POST'])
@api_security
def acl_customers():
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    if not is_platform_admin():
        return createApiResponse(error='http', msg='仅平台管理员可管理客户', status_code=403)
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        if request.method == 'GET':
            rows = db.execute(text(
                "SELECT c.id, c.name, c.code, c.note, c.domain, c.enabled, c.created, "
                "(SELECT COUNT(*) FROM dsip_user u WHERE u.customer_id=c.id) AS users, "
                "(SELECT COUNT(*) FROM dsip_ufi_device d WHERE d.customer_id=c.id) AS devices "
                "FROM dsip_customer c ORDER BY c.id DESC"
            )).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
                d['enabled'] = int(d.get('enabled') or 0)
                d['users'] = int(d.get('users') or 0)
                d['devices'] = int(d.get('devices') or 0)
                d['domain'] = d.get('domain') or ''
                out.append(d)
            return createApiResponse(msg='customers', data=out)
        body = request.get_json(silent=True) or {}
        name = str(body.get('name') or '').strip()
        if not name:
            return createApiResponse(error='http', msg='客户名称不能为空', status_code=400)
        code = str(body.get('code') or '').strip()[:64] or ('c' + datetime.now().strftime('%H%M%S%f'))
        note = str(body.get('note') or '').strip()[:255]
        domain = str(body.get('domain') or '').strip()[:128] or None
        db.execute(text(
            "INSERT INTO dsip_customer (name, code, note, domain, enabled, created) VALUES (:n,:c,:o,:d,1,:t)"
        ), {'n': name[:128], 'c': code, 'o': note, 'd': domain, 't': datetime.now()})
        db.commit()
        return createApiResponse(msg='已创建客户')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/customers/<int:cid>', methods=['POST', 'DELETE'])
@api_security
def acl_customer_one(cid):
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    if not is_platform_admin():
        return createApiResponse(error='http', msg='仅平台管理员可管理客户', status_code=403)
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        if request.method == 'DELETE':
            row = db.execute(text("SELECT code FROM dsip_customer WHERE id=:i"), {'i': cid}).mappings().first()
            if row and str(row.get('code') or '') == 'default':
                return createApiResponse(error='http', msg='默认租户为系统租户，不可删除', status_code=400)
            from modules.api.ufi_device import _delete_ufi_account
            imeis = [r[0] for r in db.execute(text(
                "SELECT imei FROM dsip_ufi_device WHERE customer_id=:i"
            ), {'i': cid}).all()]
            for imei in imeis:
                _delete_ufi_account(db, imei)
                set_device_customer(db, imei, None)
            db.execute(text("DELETE FROM dsip_ufi_import WHERE customer_id=:i"), {'i': cid})
            db.execute(text("UPDATE dsip_user SET customer_id=NULL WHERE customer_id=:i"), {'i': cid})
            db.execute(text("DELETE FROM dsip_customer WHERE id=:i"), {'i': cid})
            db.commit()
            return createApiResponse(msg='已删除，名下设备已回到待认领')
        body = request.get_json(silent=True) or {}
        current = db.execute(text(
            "SELECT enabled, domain FROM dsip_customer WHERE id=:i"
        ), {'i': cid}).mappings().first()
        if not current:
            return createApiResponse(error='http', msg='客户不存在', status_code=404)
        if 'enabled' in body:
            enabled = 1 if str(body.get('enabled')) in ('1', 'true', 'True') else 0
        else:
            enabled = int(current.get('enabled') or 0)
        if 'domain' in body:
            domain = str(body.get('domain') or '').strip()[:128] or None
        else:
            domain = current.get('domain')
        db.execute(text(
            "UPDATE dsip_customer SET name=:n, code=:c, note=:o, domain=:d, enabled=:e WHERE id=:i"
        ), {
            'n': str(body.get('name') or '').strip()[:128],
            'c': str(body.get('code') or '').strip()[:64],
            'o': str(body.get('note') or '').strip()[:255],
            'd': domain,
            'e': enabled,
            'i': cid,
        })
        db.commit()
        return createApiResponse(msg='已保存')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/customers/<int:cid>/import', methods=['GET', 'POST'])
@api_security
def acl_customer_import(cid):
    """平台管理员把 IMEI（可选 SIM）预置到客户。已属于其他客户的 IMEI 不覆盖。"""
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    if not is_platform_admin():
        return createApiResponse(error='http', msg='仅平台管理员可导入设备', status_code=403)
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        exists = db.execute(text("SELECT id FROM dsip_customer WHERE id=:i"), {'i': cid}).first()
        if not exists:
            return createApiResponse(error='http', msg='客户不存在', status_code=404)
        if request.method == 'GET':
            rows = db.execute(text(
                "SELECT id, imei, sim, matched, note, created, matched_at "
                "FROM dsip_ufi_import WHERE customer_id=:c ORDER BY id DESC"
            ), {'c': cid}).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                for k in ('created', 'matched_at'):
                    if d.get(k) is not None:
                        d[k] = str(d[k])
                out.append(d)
            return createApiResponse(msg='import', data=out)
        body = request.get_json(silent=True) or {}
        rows = body.get('devices') or []
        if isinstance(body.get('text'), str):
            for line in body['text'].splitlines():
                line = line.strip()
                if not line or line.lower().startswith('imei'):
                    continue
                parts = [p.strip() for p in re.split(r'[,;\s]+', line) if p.strip()]
                if parts:
                    rows.append({'imei': parts[0], 'sim': parts[1] if len(parts) > 1 else ''})
        created, skipped, errors = [], [], []
        for item in rows:
            imei = re.sub(r'\D', '', str(item.get('imei') or ''))
            sim = re.sub(r'\D', '', str(item.get('sim') or ''))
            if not (imei.isdigit() and len(imei) >= 10):
                errors.append({'imei': imei, 'error': 'IMEI 无效'})
                continue
            other = db.execute(text(
                "SELECT customer_id FROM dsip_ufi_import WHERE imei=:imei"
            ), {'imei': imei}).scalar()
            if other and int(other) != int(cid):
                errors.append({'imei': imei, 'error': '已属于其他客户'})
                continue
            db.execute(text(
                "INSERT INTO dsip_ufi_import (customer_id, imei, sim, matched, note, created) "
                "VALUES (:c,:imei,:sim,0,'',NOW()) "
                "ON DUPLICATE KEY UPDATE sim=IF(:sim='', sim, :sim), customer_id=:c"
            ), {'c': cid, 'imei': imei, 'sim': sim})
            if other:
                skipped.append(imei)
            else:
                created.append(imei)
        db.commit()
        return createApiResponse(msg='已导入', data=[{
            'created': created, 'updated': skipped, 'errors': errors,
        }])
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/roles', methods=['GET', 'POST'])
@api_security
def acl_roles():
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        if request.method == 'GET':
            sql = "SELECT id, customer_id, name, menus, is_super, enabled FROM dsip_role"
            if not is_platform_admin():
                sql += " WHERE is_super=0"
            sql += " ORDER BY id"
            rows = db.execute(text(sql)).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                try:
                    d['menus'] = json.loads(d.get('menus') or '[]')
                except Exception:
                    d['menus'] = []
                d['is_super'] = int(d.get('is_super') or 0)
                d['enabled'] = int(d.get('enabled') or 0)
                d['customer_id'] = d.get('customer_id')
                out.append(d)
            return createApiResponse(msg='roles', data=out)
        body = request.get_json(silent=True) or {}
        name = str(body.get('name') or '').strip()[:64]
        if not name:
            return createApiResponse(error='http', msg='角色名不能为空', status_code=400)
        menus = body.get('menus') or []
        if not isinstance(menus, list):
            menus = []
        menus = [m for m in menus if m in ALL_MENU_KEYS]
        is_super = 1 if is_platform_admin() and str(body.get('is_super') or '') in ('1', 'true', 'True') else 0
        db.execute(text(
            "INSERT INTO dsip_role (customer_id, name, menus, is_super, enabled) VALUES (NULL,:n,:m,:s,1)"
        ), {'n': name, 'm': json.dumps(menus if not is_super else ALL_MENU_KEYS), 's': is_super})
        db.commit()
        return createApiResponse(msg='已创建角色')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/roles/<int:rid>', methods=['POST', 'DELETE'])
@api_security
def acl_role_one(rid):
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        row = db.execute(text(
            "SELECT id, customer_id, name, is_super FROM dsip_role WHERE id=:i"
        ), {'i': rid}).mappings().first()
        if not row:
            return createApiResponse(error='http', msg='角色不存在', status_code=404)
        if not is_platform_admin() and int(row.get('is_super') or 0):
            return createApiResponse(error='http', msg='无权限', status_code=403)
        if request.method == 'DELETE':
            if row.get('name') in ('platform_admin', 'dsip_admin') and row.get('customer_id') is None:
                return createApiResponse(error='http', msg='内置平台角色不可删除', status_code=400)
            db.execute(text("DELETE FROM dsip_role WHERE id=:i"), {'i': rid})
            db.commit()
            return createApiResponse(msg='已删除')
        body = request.get_json(silent=True) or {}
        menus = body.get('menus') or []
        if not isinstance(menus, list):
            menus = []
        menus = [m for m in menus if m in ALL_MENU_KEYS]
        is_super = 1 if is_platform_admin() and str(body.get('is_super') or '') in ('1', 'true', 'True') else 0
        name = str(body.get('name') or row.get('name') or '').strip()[:64]
        db.execute(text(
            "UPDATE dsip_role SET name=:n, menus=:m, is_super=:s, enabled=:e, customer_id=NULL WHERE id=:i"
        ), {
            'n': name,
            'm': json.dumps(ALL_MENU_KEYS if is_super else menus),
            's': is_super,
            'e': 1 if str(body.get('enabled', 1)) in ('1', 'true', 'True') else 0,
            'i': rid,
        })
        db.commit()
        return createApiResponse(msg='已保存')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/users', methods=['GET'])
@api_security
def acl_users():
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        sql = ("SELECT u.id, u.username, u.firstname, u.lastname, u.roles, u.customer_id, "
               "c.name AS customer_name FROM dsip_user u "
               "LEFT JOIN dsip_customer c ON c.id=u.customer_id")
        params = {}
        if not is_platform_admin():
            sql += " WHERE u.customer_id=:c"
            params['c'] = current_customer_id() or 0
        sql += " ORDER BY u.id"
        rows = db.execute(text(sql), params).mappings().all()
        out = []
        for r in rows:
            d = dict(r)
            d['roles'] = [x for x in str(d.get('roles') or '').split(',') if x]
            out.append(d)
        return createApiResponse(msg='users', data=out)
    except Exception as ex:
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/acl/users/assign', methods=['POST'])
@api_security
def acl_assign_user():
    from database import startSession, DummySession
    denied = _require_users_menu()
    if denied:
        return denied
    db = DummySession()
    try:
        db = startSession()
        ensure_acl_tables(db)
        body = request.get_json(silent=True) or {}
        uid = int(body.get('id') or 0)
        roles = body.get('roles') or []
        if isinstance(roles, str):
            roles = [roles]
        roles = ','.join(str(r) for r in roles if r)
        cid = body.get('customer_id')
        if not is_platform_admin():
            cid = current_customer_id()
        elif cid in ('', None, 0, '0'):
            cid = None
        else:
            cid = int(cid)
        db.execute(text(
            "UPDATE dsip_user SET customer_id=:c, roles=:r WHERE id=:i"
        ), {'c': cid, 'r': roles, 'i': uid})
        db.commit()
        return createApiResponse(msg='已更新用户归属')
    except Exception as ex:
        try:
            db.rollback()
        except Exception:
            pass
        return showApiError(ex)
    finally:
        db.close()
