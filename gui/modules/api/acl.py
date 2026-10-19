# -*- coding: utf-8 -*-
"""客户、角色与菜单权限。

- 平台超级管理员（内置账号或 is_super 角色）可见全部客户数据。
- 普通用户归属一个客户，查询时按 customer_id 隔离。
- 角色保存菜单/子页签 key 列表；空列表且角色名为历史 dsip_admin 时视为全部菜单。
"""
from __future__ import annotations

import json
from datetime import datetime

from flask import session
from sqlalchemy import text

# key, label, parent (None = top)
MENU_CATALOG = [
    ('dashboard', '仪表盘', None),
    ('biz', '营业管理', None),
    ('biz.ufi', 'UFI 设备', 'biz'),
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
    db.commit()
    _ensure_customer_cols(db)


_SCOPED_TABLES = (
    'dsip_ufi_device', 'dsip_ufi_pool', 'dsip_ufi_sms_msg', 'dsip_ufi_sms_task',
    'dsip_ufi_sms_sched', 'dsip_ufi_sms_tpl', 'dsip_ufi_sms_black', 'dsip_ufi_sms_word',
    'dsip_ufi_sms_apikey', 'dsip_ufi_sms_policy', 'dsip_ip_whitelist', 'dr_gw_lists',
)


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


def stamp_customer():
    """写入新行时使用的 customer_id（平台管理员为 NULL）。"""
    if is_platform_admin():
        return None
    return current_customer_id()


def _menus_of_roles(db, names, customer_id):
    if not names:
        return [], False
    ph = ','.join([':n' + str(i) for i in range(len(names))])
    params = {'n' + str(i): names[i] for i in range(len(names))}
    # platform roles (customer_id NULL) plus this customer's roles
    sql = ("SELECT name, menus, is_super, customer_id FROM dsip_role "
           "WHERE enabled=1 AND name IN (" + ph + ") AND (customer_id IS NULL")
    if customer_id:
        sql += " OR customer_id=:cid"
        params['cid'] = int(customer_id)
    sql += ")"
    rows = db.execute(text(sql), params).mappings().all()
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
                "SELECT c.id, c.name, c.code, c.note, c.enabled, c.created, "
                "(SELECT COUNT(*) FROM dsip_user u WHERE u.customer_id=c.id) AS users "
                "FROM dsip_customer c ORDER BY c.id DESC"
            )).mappings().all()
            out = []
            for r in rows:
                d = dict(r)
                d['created'] = d['created'].strftime('%Y-%m-%d %H:%M:%S') if d.get('created') else ''
                d['enabled'] = int(d.get('enabled') or 0)
                d['users'] = int(d.get('users') or 0)
                out.append(d)
            return createApiResponse(msg='customers', data=out)
        body = request.get_json(silent=True) or {}
        name = str(body.get('name') or '').strip()
        if not name:
            return createApiResponse(error='http', msg='客户名称不能为空', status_code=400)
        code = str(body.get('code') or '').strip()[:64] or ('c' + datetime.now().strftime('%H%M%S%f'))
        note = str(body.get('note') or '').strip()[:255]
        db.execute(text(
            "INSERT INTO dsip_customer (name, code, note, enabled, created) VALUES (:n,:c,:o,1,:t)"
        ), {'n': name[:128], 'c': code, 'o': note, 't': datetime.now()})
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
            db.execute(text("DELETE FROM dsip_customer WHERE id=:i"), {'i': cid})
            db.execute(text("UPDATE dsip_user SET customer_id=NULL WHERE customer_id=:i"), {'i': cid})
            db.commit()
            return createApiResponse(msg='已删除')
        body = request.get_json(silent=True) or {}
        db.execute(text(
            "UPDATE dsip_customer SET name=:n, code=:c, note=:o, enabled=:e WHERE id=:i"
        ), {
            'n': str(body.get('name') or '').strip()[:128],
            'c': str(body.get('code') or '').strip()[:64],
            'o': str(body.get('note') or '').strip()[:255],
            'e': 1 if str(body.get('enabled', 1)) in ('1', 'true', 'True') else 0,
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
        scope_cid = None if is_platform_admin() else current_customer_id()
        if request.method == 'GET':
            if is_platform_admin():
                rows = db.execute(text(
                    "SELECT id, customer_id, name, menus, is_super, enabled FROM dsip_role ORDER BY customer_id IS NULL DESC, id"
                )).mappings().all()
            else:
                rows = db.execute(text(
                    "SELECT id, customer_id, name, menus, is_super, enabled FROM dsip_role "
                    "WHERE customer_id=:c ORDER BY id"
                ), {'c': scope_cid or 0}).mappings().all()
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
        cid = body.get('customer_id')
        if not is_platform_admin():
            cid = scope_cid
            is_super = 0
        elif cid in ('', None, 0, '0'):
            cid = None
        else:
            cid = int(cid)
        db.execute(text(
            "INSERT INTO dsip_role (customer_id, name, menus, is_super, enabled) VALUES (:c,:n,:m,:s,1)"
        ), {'c': cid, 'n': name, 'm': json.dumps(menus if not is_super else ALL_MENU_KEYS), 's': is_super})
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
        row = db.execute(text("SELECT id, customer_id, name FROM dsip_role WHERE id=:i"), {'i': rid}).mappings().first()
        if not row:
            return createApiResponse(error='http', msg='角色不存在', status_code=404)
        if not is_platform_admin() and int(row.get('customer_id') or 0) != int(current_customer_id() or 0):
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
            "UPDATE dsip_role SET name=:n, menus=:m, is_super=:s, enabled=:e WHERE id=:i"
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
