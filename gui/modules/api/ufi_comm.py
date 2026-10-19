# UFI communication-management APIs (call-center module).
# Device ledger (dsip_ufi_device) is owned by the device module; this module only
# overlays per-IMEI comm attributes (pool membership / weight / concurrency caps)
# stored in dsip_ufi_pool, plus a read view of kamailio.dbaliases for inbound mapping.

import hashlib
import re

from flask import request
from sqlalchemy.sql import text

from database import DummySession, startSession
from modules.api.api_functions import api_security, createApiResponse, showApiError
from modules.api.api_routes import api, _ufi_auth_domain
from modules.api.ufi_device import _ensure_ufi_tables, _row_to_console
from shared import debugEndpoint, getRequestData
import settings


BULK_ACTIONS = ('enable', 'disable', 'maintain', 'reset-conc')

# ---- route auto-sync: dsip_ufi_pool <-> dr_rules(8000/9000) <-> subscriber ----
# Verified 2026-10-09: inbound path (UFI MT) uses REQINIT registered() trust + dr_rules
# groupid=8000 via NEXTHOP drouting; the FLT_INBOUND(9000) carrier-DID branch is not
# reached by any current call leg, so 9000 entries are safe DID-mapping records.
SYNC_GWLIST = '100'          # VOS3000 carrier gateway (dr_gateways gwid=100)
_RE_IMEI = re.compile(r'^[0-9]{15}$')
_RE_SIM = re.compile(r'^[0-9]{10,15}$')


def _kam_reload():
    """Flag GUI reload and try an immediate drouting reload."""
    try:
        from shared import getSharedMemoryDict, STATE_SHMEM_NAME
        getSharedMemoryDict(STATE_SHMEM_NAME)['kam_reload_required'] = True
    except Exception:
        pass
    try:
        import subprocess
        r = subprocess.run(['kamcmd', 'drouting.reload'], capture_output=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def _carrier_set(db):
    """Valid carrier gateway ids (multi-VOS): dr_gateways type=8 with gwid >= 100.

    gwid 1-55 are dSIPRouter sample carriers (not ours); 100 is the live VOS3000.
    New VOS systems are added as type=8 gateways (GUI Carrier page) and appear here automatically.
    """
    try:
        rows = db.execute(text(
            "SELECT gwid FROM dr_gateways WHERE type = 8 AND gwid >= 100"
        )).mappings().all()
        return {str(int(r['gwid'])) for r in rows} or {SYNC_GWLIST}
    except Exception:
        return {SYNC_GWLIST}


def sync_ufi_routes(db, prune_imei=None):
    """Idempotent calibration of routing config against dsip_ufi_pool.

    Desired state = pool rows with enabled=1 AND in_pool=1:
      - dr_rules groupid=8000 (FLT_OUTBOUND): prefix=<IMEI> -> gwlist=<carrier>  (UFI MT -> its VOS)
      - dr_rules groupid=9000 (FLT_INBOUND):  prefix=<SIM>  -> gwlist=<carrier>  (DID mapping record)
      - subscriber: username=<IMEI>, password=md5(IMEI)[:16]
    prune_imei: also drop that device's pool row + subscriber (device deleted).
    Caller commits. Only touches 9000 entries it owns (description marker).
    """
    changes = {'pools_pruned': [], 'rules_added': [], 'rules_removed': [], 'rules_updated': [],
               'imaps_added': [], 'imaps_removed': [], 'imaps_updated': [], 'carriers_fixed': [],
               'subscribers_ensured': 0, 'reloaded': False}
    if prune_imei and _RE_IMEI.match(str(prune_imei)):
        db.execute(text("DELETE FROM dsip_ufi_pool WHERE imei = :imei"), {'imei': prune_imei})
        db.execute(text("DELETE FROM subscriber WHERE username = :u AND domain = :d"),
                   {'u': prune_imei, 'd': _ufi_auth_domain()})
        changes['pools_pruned'].append(str(prune_imei))
    valid_carriers = _carrier_set(db)
    rows = db.execute(text(
        "SELECT imei, sim, carrier FROM dsip_ufi_pool WHERE enabled = 1 AND in_pool = 1"
    )).mappings().all()
    desired = {}
    for r in rows:
        imei = str(r['imei'] or '').strip()
        if _RE_IMEI.match(imei):
            carrier = str(r['carrier'] or '').strip()
            if carrier not in valid_carriers:
                db.execute(text("UPDATE dsip_ufi_pool SET carrier = :c WHERE imei = :imei"),
                           {'c': SYNC_GWLIST, 'imei': imei})
                changes['carriers_fixed'].append(imei + ':' + carrier + '->' + SYNC_GWLIST)
                carrier = SYNC_GWLIST
            desired[imei] = {'sim': str(r['sim'] or '').strip(), 'carrier': carrier}
    domain = _ufi_auth_domain()
    for imei in desired:
        pw = hashlib.md5(imei.encode()).hexdigest()[:16]
        db.execute(text(
            "INSERT INTO subscriber (username, domain, password, email_address, rpid) "
            "VALUES (:u, :d, :pw, '', '') ON DUPLICATE KEY UPDATE password = :pw"
        ), {'u': imei, 'd': domain, 'pw': pw})
        changes['subscribers_ensured'] += 1
    # outbound rules (8000): any 15-digit prefix is managed (UFI IMEIs)
    cur = db.execute(text(
        "SELECT ruleid, prefix, gwlist FROM dr_rules WHERE groupid = '8000' AND prefix REGEXP '^[0-9]{15}$'"
    )).mappings().all()
    cur_map = {str(r['prefix']): (int(r['ruleid']), str(r['gwlist'] or '')) for r in cur}
    for imei in desired:
        gw = desired[imei]['carrier']
        if imei not in cur_map:
            db.execute(text(
                "INSERT INTO dr_rules (groupid, prefix, timerec, priority, routeid, gwlist, description) "
                "VALUES ('8000', :p, '', 0, '', :gw, :d)"
            ), {'p': imei, 'gw': gw, 'd': 'name:UFI inbound %s (auto-sync)' % imei})
            changes['rules_added'].append(imei)
        elif cur_map[imei][1] != gw:
            db.execute(text("UPDATE dr_rules SET gwlist = :gw WHERE ruleid = :r"),
                       {'gw': gw, 'r': cur_map[imei][0]})
            changes['rules_updated'].append(imei)
    for imei, (rid, _gw) in cur_map.items():
        if imei not in desired:
            db.execute(text("DELETE FROM dr_rules WHERE ruleid = :r"), {'r': rid})
            changes['rules_removed'].append(imei)
    # inbound mapping (9000): only entries this sync owns (description marker)
    sim_desired = {}
    for imei, info in desired.items():
        sim = info['sim']
        if sim and _RE_SIM.match(sim):
            sim_desired[sim] = info['carrier']
    cur_im = db.execute(text(
        "SELECT ruleid, prefix, gwlist FROM dr_rules WHERE groupid = '9000' "
        "AND prefix REGEXP '^[0-9]{10,15}$' AND description LIKE 'name:UFI DID %'"
    )).mappings().all()
    im_map = {str(r['prefix']): (int(r['ruleid']), str(r['gwlist'] or '')) for r in cur_im}
    for sim in sim_desired:
        gw = sim_desired[sim]
        if sim not in im_map:
            db.execute(text(
                "INSERT INTO dr_rules (groupid, prefix, timerec, priority, routeid, gwlist, description) "
                "VALUES ('9000', :p, '', 0, '', :gw, :d)"
            ), {'p': sim, 'gw': gw, 'd': 'name:UFI DID %s (auto-sync)' % sim})
            changes['imaps_added'].append(sim)
        elif im_map[sim][1] != gw:
            db.execute(text("UPDATE dr_rules SET gwlist = :gw WHERE ruleid = :r"),
                       {'gw': gw, 'r': im_map[sim][0]})
            changes['imaps_updated'].append(sim)
    for sim, (rid, _gw) in im_map.items():
        if sim not in sim_desired:
            db.execute(text("DELETE FROM dr_rules WHERE ruleid = :r"), {'r': rid})
            changes['imaps_removed'].append(sim)
    if (changes['rules_added'] or changes['rules_removed'] or changes['rules_updated']
            or changes['imaps_added'] or changes['imaps_removed'] or changes['imaps_updated']
            or changes['pools_pruned']):
        changes['reloaded'] = _kam_reload()
    return changes


def _routes_snapshot(db):
    """Consistency snapshot: pool members vs dr_rules vs subscriber."""
    pool = db.execute(text(
        "SELECT imei, sim, pool_id, carrier, enabled, in_pool FROM dsip_ufi_pool ORDER BY imei"
    )).mappings().all()
    active = set()
    sims = set()
    for r in pool:
        imei = str(r['imei'] or '').strip()
        if _RE_IMEI.match(imei) and int(r['enabled'] or 0) == 1 and int(r['in_pool'] or 0) == 1:
            active.add(imei)
            if str(r['sim'] or '').strip() and _RE_SIM.match(str(r['sim']).strip()):
                sims.add(str(r['sim']).strip())
    r8 = db.execute(text(
        "SELECT ruleid, prefix, gwlist, description FROM dr_rules "
        "WHERE groupid = '8000' AND prefix REGEXP '^[0-9]{15}$' ORDER BY prefix"
    )).mappings().all()
    r9 = db.execute(text(
        "SELECT ruleid, prefix, gwlist, description FROM dr_rules "
        "WHERE groupid = '9000' AND prefix REGEXP '^[0-9]{10,15}$' ORDER BY prefix"
    )).mappings().all()
    subs = db.execute(text(
        "SELECT username FROM subscriber WHERE domain = :d AND username REGEXP '^[0-9]{15}$'"
    ), {'d': _ufi_auth_domain()}).mappings().all()
    rules_out = {str(r['prefix']) for r in r8}
    rules_in = {str(r['prefix']) for r in r9}
    sub_set = {str(r['username']) for r in subs}
    gw_by_prefix = {str(r['prefix']): str(r['gwlist'] or '') for r in r8}
    carrier_by_imei = {str(r['imei']): str(r['carrier'] or '100') for r in pool}
    stale_rules = sorted(i for i in active if gw_by_prefix.get(i) != carrier_by_imei.get(i))
    return {
        'pool': [{'imei': str(r['imei']), 'sim': str(r['sim'] or ''), 'pool_id': str(r['pool_id'] or ''),
                  'carrier': str(r['carrier'] or '100'),
                  'enabled': bool(r['enabled']), 'in_pool': bool(r['in_pool']),
                  'active': str(r['imei']) in active} for r in pool],
        'rules_out': [{'ruleid': int(r['ruleid']), 'prefix': str(r['prefix']),
                       'gwlist': str(r['gwlist']), 'description': str(r['description'] or '')} for r in r8],
        'rules_in': [{'ruleid': int(r['ruleid']), 'prefix': str(r['prefix']),
                      'gwlist': str(r['gwlist']), 'description': str(r['description'] or '')} for r in r9],
        'missing_rules': sorted(active - rules_out),
        'extra_rules': sorted(rules_out - active),
        'missing_subs': sorted(active - sub_set),
        'missing_imaps': sorted(sims - rules_in),
        'stale_rules': stale_rules,
        'consistent': (active == rules_out) and not stale_rules and not (sims - rules_in) and not (active - sub_set),
    }


POOL_STRATEGIES = ('round_robin', 'failover', 'least_load')
STRAT_LABELS = {'round_robin': '严格轮询', 'failover': '主备故障转移', 'least_load': '负载均衡'}
# Sentinels in dsip_ufi_pool_did (not real phone numbers):
#   _DEFAULT_       = global fallback when source VOS has no per-VOS mapping
#   _DEFAULT_<gwid> = arbitrary long callee from that VOS (dr_gateways gwid), e.g. _DEFAULT_100
POOL_DEFAULT_DID = '_DEFAULT_'


def _vos_default_did(gwid):
    """gwid 100 -> '_DEFAULT_100' (POOL_DEFAULT_DID + gwid)."""
    return POOL_DEFAULT_DID + str(gwid).strip()


def _gwid_from_sentinel(did):
    """'_DEFAULT_100' -> '100'; global '_DEFAULT_' -> None."""
    did = str(did or '')
    if did == POOL_DEFAULT_DID or not did.startswith(POOL_DEFAULT_DID):
        return None
    rest = did[len(POOL_DEFAULT_DID):]
    return rest if rest.isdigit() else None


def _is_pool_sentinel(did):
    did = str(did or '')
    return did == POOL_DEFAULT_DID or _gwid_from_sentinel(did) is not None


def _list_carriers(db):
    """Live VOS / carrier gateways for GUI multi-pool binding."""
    try:
        rows = db.execute(text(
            "SELECT gwid, address, description FROM dr_gateways "
            "WHERE type = 8 AND gwid >= 100 ORDER BY gwid"
        )).mappings().all()
        out = []
        for g in rows:
            desc = str(g.get('description') or '')
            name = desc.split(',')[0].strip() if desc else ('VOS#' + str(int(g['gwid'])))
            out.append({'gwid': str(int(g['gwid'])), 'name': name or ('VOS#' + str(int(g['gwid']))),
                        'address': str(g.get('address') or '')})
        return out or [{'gwid': SYNC_GWLIST, 'name': 'VOS3000', 'address': ''}]
    except Exception:
        return [{'gwid': SYNC_GWLIST, 'name': 'VOS3000', 'address': ''}]


def _ensure_pool_strategy_tables(db):
    """UFI_POOL v6: pool strategy config + did->pool mapping (outbound bridge trigger).

    Seed DIDs only when the table is empty. Never re-INSERT on every request —
    that made GUI deletes appear to fail (e.g. 18960700521 kept coming back).
    """
    db.execute(text("CREATE TABLE IF NOT EXISTS dsip_ufi_pool_cfg (pool_id VARCHAR(16) NOT NULL PRIMARY KEY, strategy VARCHAR(16) NOT NULL DEFAULT 'round_robin', updated_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"))
    db.execute(text("CREATE TABLE IF NOT EXISTS dsip_ufi_pool_did (did VARCHAR(32) NOT NULL PRIMARY KEY, pool_id VARCHAR(16) NOT NULL, updated_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"))
    db.execute(text("INSERT IGNORE INTO dsip_ufi_pool_cfg (pool_id, strategy, updated_at) VALUES ('P1', 'round_robin', NOW())"))
    try:
        n = int(db.execute(text("SELECT COUNT(*) FROM dsip_ufi_pool_did")).scalar() or 0)
    except Exception:
        n = 0
    if n == 0:
        db.execute(text(
            "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES ('18960700521', 'P1', NOW())"
        ))
        db.execute(text(
            "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, 'P1', NOW())"
        ), {'d': POOL_DEFAULT_DID})
        db.execute(text(
            "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, 'P1', NOW())"
        ), {'d': _vos_default_did(SYNC_GWLIST)})


def _normalize_pool_dids(raw):
    """Parse did list; strip sentinels; return unique phone-like triggers."""
    if isinstance(raw, str):
        items = re.split(r'[,，\s]+', raw)
    else:
        items = list(raw or [])
    out, seen = [], set()
    for d in items:
        d = str(d or '').strip()
        if not d or _is_pool_sentinel(d) or len(d) > 32:
            continue
        if d in seen:
            continue
        seen.add(d)
        out.append(d)
    return out


@api.route('/api/v1/ufi/comm/pool-strategy', methods=['GET'])
@api_security
def listUfiPoolStrategy():
    """Pool strategy list: pools with member stats + current strategy + did mapping."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        pool_set = set(r[0] for r in db.execute(text("SELECT DISTINCT pool_id FROM dsip_ufi_pool")).all())
        cfgs = {r[0]: r[1] for r in db.execute(text("SELECT pool_id, strategy FROM dsip_ufi_pool_cfg")).all()}
        pool_set.update(cfgs.keys())
        pool_set.add('P1')
        pools = sorted(pool_set)
        dids = {}
        default_vos = {}  # pool_id -> [gwid, ...]
        default_pool = None
        for r in db.execute(text("SELECT did, pool_id FROM dsip_ufi_pool_did ORDER BY did")).all():
            did, pid = str(r[0]), str(r[1])
            if did == POOL_DEFAULT_DID:
                default_pool = pid
                continue
            gwid = _gwid_from_sentinel(did)
            if gwid is not None:
                default_vos.setdefault(pid, []).append(gwid)
                continue
            dids.setdefault(pid, []).append(did)
        stats = {}
        for r in db.execute(text("SELECT pool_id, COUNT(*) total, SUM(CASE WHEN enabled=1 AND in_pool=1 THEN 1 ELSE 0 END) active, SUM(active_calls) conc, SUM(max_concurrent) cap FROM dsip_ufi_pool GROUP BY pool_id")).all():
            stats[r[0]] = dict(total=int(r[1] or 0), active=int(r[2] or 0), conc=int(r[3] or 0), cap=int(r[4] or 0))
        members = {}
        for r in db.execute(text(
                "SELECT p.pool_id, p.imei, p.sim, p.enabled, p.in_pool, "
                "CASE WHEN d.ws_online=1 AND d.last_seen >= NOW() - INTERVAL 180 SECOND THEN 1 ELSE 0 END "
                "FROM dsip_ufi_pool p LEFT JOIN dsip_ufi_device d ON d.imei=p.imei ORDER BY p.weight DESC, p.imei")).all():
            members.setdefault(r[0], []).append(dict(
                imei=str(r[1]), sim=str(r[2] or ''), enabled=bool(int(r[3] or 0)),
                in_pool=bool(int(r[4] or 0)), online=bool(int(r[5] or 0))))
        carriers = _list_carriers(db)
        data = [dict(pool_id=p, strategy=cfgs.get(p, 'round_robin'),
                     strategy_label=STRAT_LABELS.get(cfgs.get(p, 'round_robin'), cfgs.get(p, 'round_robin')),
                     dids=dids.get(p, []), is_default=(p == default_pool),
                     default_vos=sorted(default_vos.get(p, []), key=lambda x: int(x) if str(x).isdigit() else 0),
                     members=members.get(p, []),
                     **stats.get(p, dict(total=0, active=0, conc=0, cap=0)))
                for p in pools]
        db.commit()
        return createApiResponse(msg='pool strategy', data=[dict(
            pools=data, strategies=list(POOL_STRATEGIES), labels=STRAT_LABELS,
            default_pool=default_pool, default_did=POOL_DEFAULT_DID, carriers=carriers)])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/pool-strategy', methods=['PUT'])
@api_security
def setUfiPoolStrategy():
    """Upsert pool strategy. body: {pool_id, strategy}."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        body = request.get_json(silent=True) or getRequestData() or {}
        if not isinstance(body, dict):
            body = {}
        pool_id = str(body.get('pool_id') or '').strip()
        strategy = str(body.get('strategy') or '').strip()
        if not pool_id or not _pool_valid(pool_id):
            return createApiResponse(status_code=400, msg='池 ID 无效（1–16 位字母/数字/下划线/横线）')
        if strategy not in POOL_STRATEGIES:
            return createApiResponse(status_code=400, msg='策略无效，可选：' + '、'.join(STRAT_LABELS.get(s, s) for s in POOL_STRATEGIES))
        db.execute(text("INSERT INTO dsip_ufi_pool_cfg (pool_id, strategy, updated_at) VALUES (:p, :s, NOW()) ON DUPLICATE KEY UPDATE strategy=:s2, updated_at=NOW()"),
                   {'p': pool_id, 's': strategy, 's2': strategy})
        db.commit()
        return createApiResponse(msg='pool strategy updated', data=[dict(pool_id=pool_id, strategy=strategy, strategy_label=STRAT_LABELS.get(strategy))])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _pool_valid(pid):
    return bool(pid) and bool(re.match(r'^[A-Za-z0-9_-]{1,16}$', pid))


@api.route('/api/v1/ufi/comm/pools', methods=['POST'])
@api_security
def createUfiPool():
    """Create pool. body: {pool_id, strategy?, dids?:[]}."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        body = request.get_json(silent=True) or getRequestData() or {}
        if not isinstance(body, dict):
            body = {}
        pool_id = str(body.get('pool_id') or '').strip()
        strategy = str(body.get('strategy') or 'round_robin').strip()
        dids = _normalize_pool_dids(body.get('dids'))
        if not _pool_valid(pool_id):
            return createApiResponse(status_code=400, msg='池 ID 无效（1–16 位字母/数字/下划线/横线）')
        if strategy not in POOL_STRATEGIES:
            return createApiResponse(status_code=400, msg='策略无效，可选：' + '、'.join(STRAT_LABELS.get(s, s) for s in POOL_STRATEGIES))
        if db.execute(text("SELECT 1 FROM dsip_ufi_pool_cfg WHERE pool_id=:p"), {'p': pool_id}).first():
            return createApiResponse(status_code=400, msg='号码池 %s 已存在' % pool_id)
        for d in dids:
            if len(d) > 32:
                return createApiResponse(status_code=400, msg='invalid did: %s' % d)
        db.execute(text("INSERT INTO dsip_ufi_pool_cfg (pool_id, strategy, updated_at) VALUES (:p, :s, NOW())"),
                   {'p': pool_id, 's': strategy})
        for d in dids:
            db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': d})
            db.execute(text("INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, :p, NOW())"),
                       {'d': d, 'p': pool_id})
        db.commit()
        return createApiResponse(msg='pool created', data=[dict(pool_id=pool_id, strategy=strategy, dids=dids)])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/pools/<pool_id>', methods=['DELETE'])
@api_security
def deleteUfiPool(pool_id):
    """Delete pool: members fall back to P1, pool dids removed. P1 is not deletable."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        if pool_id == 'P1':
            return createApiResponse(status_code=400, msg='P1 是默认池，不可删除')
        # Re-home sentinels (global + per-VOS) to P1 before dropping pool rows
        for (d,) in db.execute(text("SELECT did FROM dsip_ufi_pool_did WHERE pool_id=:p"), {'p': pool_id}).all():
            if _is_pool_sentinel(str(d)):
                db.execute(text(
                    "UPDATE dsip_ufi_pool_did SET pool_id='P1', updated_at=NOW() WHERE did=:d"
                ), {'d': str(d)})
        moved = db.execute(text("UPDATE dsip_ufi_pool SET pool_id='P1' WHERE pool_id=:p"), {'p': pool_id}).rowcount
        db.execute(text("DELETE FROM dsip_ufi_pool_cfg WHERE pool_id=:p"), {'p': pool_id})
        db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE pool_id=:p"), {'p': pool_id})
        db.commit()
        return createApiResponse(msg='pool deleted, %d member(s) moved to P1' % max(0, moved),
                                 data=[dict(pool_id=pool_id, moved=int(max(0, moved)))])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/pools/<pool_id>/members', methods=['POST'])
@api_security
def poolMembersAct(pool_id):
    """Add/remove pool members. body: {imeis:[], action:'add'|'remove'}.
    remove from P1 -> in_pool=0 (quit routing); remove from others -> back to P1."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        body = request.get_json(silent=True) or {}
        action = str(body.get('action') or '').strip()
        imeis = [str(i).strip() for i in (body.get('imeis') or []) if str(i).strip()]
        if action not in ('add', 'remove'):
            return createApiResponse(status_code=400, msg='action must be add or remove')
        if not pool_id == 'P1' and not db.execute(text("SELECT 1 FROM dsip_ufi_pool_cfg WHERE pool_id=:p"), {'p': pool_id}).first():
            return createApiResponse(status_code=404, msg='pool %s not found' % pool_id)
        changed = []
        for imei in imeis:
            if not re.match(r'^[0-9]{10,17}$', imei):
                continue
            row = db.execute(text("SELECT pool_id FROM dsip_ufi_pool WHERE imei=:i"), {'i': imei}).first()
            if not row:
                continue
            if action == 'add':
                db.execute(text("UPDATE dsip_ufi_pool SET pool_id=:p, in_pool=1 WHERE imei=:i"), {'p': pool_id, 'i': imei})
                changed.append(imei)
            else:
                if pool_id == 'P1':
                    db.execute(text("UPDATE dsip_ufi_pool SET in_pool=0 WHERE imei=:i"), {'i': imei})
                else:
                    db.execute(text("UPDATE dsip_ufi_pool SET pool_id='P1' WHERE imei=:i"), {'i': imei})
                changed.append(imei)
        db.commit()
        return createApiResponse(msg='%d member(s) %s pool %s' % (len(changed), action, pool_id),
                                 data=[dict(pool_id=pool_id, action=action, changed=changed)])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/pools/<pool_id>/dids', methods=['PUT'])
@api_security
def poolDidsSet(pool_id):
    """Replace pool trigger DIDs / per-VOS arbitrary routing.

    body: {
      dids: ["1896..."],           # exact R-URI triggers
      default_vos: ["100","101"],  # this pool handles arbitrary callees from these VOS gwid
      is_default?: bool            # optional global fallback (_DEFAULT_) when VOS unmapped
    }

    Multi-VOS: each carrier gwid maps to at most one pool via sentinel `_DEFAULT_<gwid>`.
    Kamailio resolves source IP → dr_gateways.gwid → that sentinel → pool.
    """
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        _ensure_pool_strategy_tables(db)
        body = request.get_json(silent=True) or {}
        dids = _normalize_pool_dids(body.get('dids'))
        if pool_id != 'P1' and not db.execute(text("SELECT 1 FROM dsip_ufi_pool_cfg WHERE pool_id=:p"), {'p': pool_id}).first():
            return createApiResponse(status_code=404, msg='pool %s not found' % pool_id)
        valid = _carrier_set(db)

        # Full replace of phone trigger DIDs for this pool (input box overwrites; empty = clear all)
        for r in db.execute(text("SELECT did FROM dsip_ufi_pool_did WHERE pool_id=:p"), {'p': pool_id}).all():
            d = str(r[0])
            if not _is_pool_sentinel(d):
                db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': d})
        for d in dids:
            db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': d})
            db.execute(text(
                "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, :p, NOW())"
            ), {'d': d, 'p': pool_id})

        # Per-VOS arbitrary: default_vos list (omit key = leave unchanged)
        owned_vos = []
        if 'default_vos' in body:
            raw_vos = body.get('default_vos') or []
            if isinstance(raw_vos, str):
                raw_vos = re.split(r'[,，\s]+', raw_vos)
            want = []
            for g in raw_vos:
                g = str(g).strip()
                if not g:
                    continue
                if g not in valid:
                    return createApiResponse(status_code=400, msg='无效 VOS/carrier gwid: %s' % g)
                want.append(g)
            want = sorted(set(want), key=lambda x: int(x) if x.isdigit() else 0)
            # Drop this pool's old per-VOS sentinels
            for (d,) in db.execute(text("SELECT did FROM dsip_ufi_pool_did WHERE pool_id=:p"), {'p': pool_id}).all():
                g = _gwid_from_sentinel(str(d))
                if g is not None:
                    db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': str(d)})
            for g in want:
                sd = _vos_default_did(g)
                db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': sd})
                db.execute(text(
                    "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, :p, NOW())"
                ), {'d': sd, 'p': pool_id})
            owned_vos = want
        else:
            for (d,) in db.execute(text("SELECT did FROM dsip_ufi_pool_did WHERE pool_id=:p"), {'p': pool_id}).all():
                g = _gwid_from_sentinel(str(d))
                if g is not None:
                    owned_vos.append(g)

        was_default = bool(db.execute(
            text("SELECT 1 FROM dsip_ufi_pool_did WHERE did=:d AND pool_id=:p"),
            {'d': POOL_DEFAULT_DID, 'p': pool_id}).first())
        is_default = body.get('is_default')
        if is_default is None:
            is_default = was_default
        else:
            is_default = bool(is_default)
        if is_default:
            db.execute(text("DELETE FROM dsip_ufi_pool_did WHERE did=:d"), {'d': POOL_DEFAULT_DID})
            db.execute(text(
                "INSERT INTO dsip_ufi_pool_did (did, pool_id, updated_at) VALUES (:d, :p, NOW())"
            ), {'d': POOL_DEFAULT_DID, 'p': pool_id})
        elif was_default:
            db.execute(text(
                "DELETE FROM dsip_ufi_pool_did WHERE did=:d AND pool_id=:p"
            ), {'d': POOL_DEFAULT_DID, 'p': pool_id})

        db.commit()
        return createApiResponse(msg='pool dids updated', data=[dict(
            pool_id=pool_id, dids=dids, is_default=is_default, default_vos=owned_vos)])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/routes', methods=['GET'])
@api_security
def listUfiRoutes():
    """Consistency snapshot: pool members vs outboundroutes(8000) vs inboundmapping(9000) vs subscriber."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        snap = _routes_snapshot(db)
        db.commit()
        return createApiResponse(msg='route sync snapshot', data=[snap])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


def _topo_snapshot(db):
    """Live end-to-end link snapshot for callcenter #topo (no mock hosts/counts)."""
    from datetime import datetime
    _ensure_pool_strategy_tables(db)
    host = (getattr(settings, 'EXTERNAL_IP_ADDR', None) or '').strip() or request.host.split(':')[0]
    domain = _ufi_auth_domain()
    carriers = _list_carriers(db)

    # IP auth rows for carrier addresses (permissions.address)
    addr_by_ip = {}
    try:
        for r in db.execute(text(
            "SELECT ip_addr, port, grp, tag FROM address ORDER BY ip_addr"
        )).mappings().all():
            ip = str(r.get('ip_addr') or '').strip()
            if ip:
                addr_by_ip[ip] = dict(
                    port=int(r['port'] or 0), grp=int(r['grp'] or 0),
                    tag=str(r.get('tag') or ''))
    except Exception:
        pass

    for c in carriers:
        ip = (c.get('address') or '').split(':')[0].strip()
        c['ip'] = ip
        auth = addr_by_ip.get(ip)
        c['auth'] = dict(
            present=bool(auth),
            port=(auth or {}).get('port'),
            ok=bool(auth) and int((auth or {}).get('port') or 0) == 0,
            detail=('port=0 任意源端口' if auth and int(auth.get('port') or 0) == 0
                    else ('port=%s' % auth.get('port') if auth else '未在 address 放行'))
        ) if ip else dict(present=False, ok=False, detail='无地址')

    # Pool strategy + trigger DIDs / per-VOS arbitrary
    cfgs = {str(r[0]): str(r[1]) for r in db.execute(text(
        "SELECT pool_id, strategy FROM dsip_ufi_pool_cfg")).all()}
    phone_dids, default_vos, global_default = {}, {}, None
    for r in db.execute(text("SELECT did, pool_id FROM dsip_ufi_pool_did")).all():
        did, pid = str(r[0]), str(r[1])
        if did == POOL_DEFAULT_DID:
            global_default = pid
            continue
        gwid = _gwid_from_sentinel(did)
        if gwid is not None:
            default_vos.setdefault(pid, []).append(gwid)
            continue
        phone_dids.setdefault(pid, []).append(did)

    pool_stats = {}
    try:
        for r in db.execute(text(
            "SELECT pool_id, COUNT(*) total, "
            "SUM(CASE WHEN enabled=1 AND in_pool=1 THEN 1 ELSE 0 END) active, "
            "SUM(active_calls) conc, SUM(max_concurrent) cap "
            "FROM dsip_ufi_pool GROUP BY pool_id"
        )).all():
            pool_stats[str(r[0])] = dict(
                total=int(r[1] or 0), active=int(r[2] or 0),
                conc=int(r[3] or 0), cap=int(r[4] or 0))
    except Exception:
        pass

    pool_ids = sorted(set(list(cfgs.keys()) + list(pool_stats.keys()) + ['P1']))
    pools = []
    for pid in pool_ids:
        st = cfgs.get(pid, 'round_robin')
        pools.append(dict(
            pool_id=pid, strategy=st, strategy_label=STRAT_LABELS.get(st, st),
            dids=phone_dids.get(pid, []),
            default_vos=sorted(default_vos.get(pid, []), key=lambda x: int(x) if str(x).isdigit() else 0),
            is_default=(pid == global_default),
            **pool_stats.get(pid, dict(total=0, active=0, conc=0, cap=0))))

    # Device / location / alias counts
    try:
        loc_regs = int(db.execute(text(
            "SELECT COUNT(DISTINCT username) FROM location "
            "WHERE expires > NOW() AND username REGEXP '^[0-9]{15}$'"
        )).scalar() or 0)
    except Exception:
        loc_regs = 0
    try:
        did_n = int(db.execute(text("SELECT COUNT(*) FROM dbaliases")).scalar() or 0)
    except Exception:
        did_n = 0
    try:
        device_n = int(db.execute(text("SELECT COUNT(*) FROM dsip_ufi_device")).scalar() or 0)
        ws_online = int(db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_device WHERE ws_online=1 "
            "AND last_seen >= NOW() - INTERVAL 180 SECOND"
        )).scalar() or 0)
    except Exception:
        device_n, ws_online = 0, 0
    try:
        conc = int(db.execute(text(
            "SELECT COALESCE(SUM(active_calls),0) FROM dsip_ufi_pool WHERE enabled=1 AND in_pool=1"
        )).scalar() or 0)
        cap = int(db.execute(text(
            "SELECT COALESCE(SUM(max_concurrent),0) FROM dsip_ufi_pool WHERE enabled=1 AND in_pool=1"
        )).scalar() or 0)
        in_pool = int(db.execute(text(
            "SELECT COUNT(*) FROM dsip_ufi_pool WHERE enabled=1 AND in_pool=1"
        )).scalar() or 0)
    except Exception:
        conc, cap, in_pool = 0, 0, 0

    routes = _routes_snapshot(db)
    primary = carriers[0] if carriers else dict(gwid='100', name='VOS', address='', ip='')

    return dict(
        dsip=dict(host=host, domain=domain, sip_port=5060,
                  cfg='/etc/kamailio/kamailio.cfg',
                  endpoint='%s:5060' % host),
        carriers=carriers,
        primary_vos=dict(
            gwid=primary.get('gwid'), name=primary.get('name'),
            address=primary.get('address') or primary.get('ip') or '',
            auth=primary.get('auth') or {}),
        pools=pools,
        global_default_pool=global_default,
        counts=dict(
            devices=device_n, ws_online=ws_online, location_regs=loc_regs,
            did_aliases=did_n, in_pool=in_pool, active_calls=conc, capacity=cap,
            phone_triggers=sum(len(p['dids']) for p in pools),
            vos_bound=sum(len(p['default_vos']) for p in pools)),
        routes=dict(
            consistent=bool(routes.get('consistent')),
            missing_subs=len(routes.get('missing_subs') or []),
            missing_rules=len(routes.get('missing_rules') or []),
            stale_rules=len(routes.get('stale_rules') or []),
            extra_rules=len(routes.get('extra_rules') or [])),
        dialect=dict(
            register='username=IMEI, password=md5(IMEI)[:16]',
            bridge='R-URI=IMEI, X-VOLTE=真实被叫'),
        updated_at=datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    )


@api.route('/api/v1/ufi/comm/topo', methods=['GET'])
@api_security
def getUfiTopo():
    """End-to-end link snapshot for 线路总览 / #topo — live config + counts."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        data = _topo_snapshot(db)
        db.commit()
        return createApiResponse(msg='ufi topo', data=[data])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/sync-routes', methods=['POST'])
@api_security
def syncUfiRoutes():
    """Idempotent calibration: make dr_rules/subscriber match dsip_ufi_pool, then reload drouting."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        changes = sync_ufi_routes(db)
        snap = _routes_snapshot(db)
        db.commit()
        return createApiResponse(msg='route sync done', data=[dict(changes, snapshot=snap)])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


_DID_RE = re.compile(r'^[A-Za-z0-9_+\-]{2,32}$')


def _normalize_did(value):
    did = str(value or '').strip()
    return did if _DID_RE.match(did) else None


def _ensure_comm_tables(db):
    """§5.5 ufi_pool spec: per-IMEI comm attributes, keyed to the device ledger."""
    db.execute(text(
        "CREATE TABLE IF NOT EXISTS dsip_ufi_pool ("
        "id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
        "imei VARCHAR(32) NOT NULL UNIQUE,"
        "sim VARCHAR(32) NOT NULL DEFAULT '',"
        "pool_id VARCHAR(16) NOT NULL DEFAULT '—',"
        "enabled TINYINT NOT NULL DEFAULT 1,"
        "in_pool TINYINT NOT NULL DEFAULT 0,"
        "weight INT NOT NULL DEFAULT 1,"
        "max_concurrent INT NOT NULL DEFAULT 2,"
        "active_calls INT NOT NULL DEFAULT 0,"
        "note VARCHAR(255) NOT NULL DEFAULT '',"
        "updated_at DATETIME NULL,"
        "KEY idx_pool (pool_id)"
        ")"
    ))
    # multi-VOS (2026-10-09): carrier = dr_gateways gwid this UFI lands on (default 100 = VOS3000)
    has_c = db.execute(text(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dsip_ufi_pool' AND COLUMN_NAME = 'carrier'"
    )).mappings().first()
    if not int(has_c['n'] if has_c else 0):
        db.execute(text("ALTER TABLE dsip_ufi_pool ADD COLUMN carrier VARCHAR(16) NOT NULL DEFAULT '100'"))


def _comm_rows(db):
    rows = db.execute(text("SELECT * FROM dsip_ufi_pool")).mappings().all()
    return {str(r['imei']): dict(r) for r in rows}


def _normalize_imei(value):
    imei = str(value or '').strip()
    if not imei.isdigit() or not (10 <= len(imei) <= 20):
        return None
    return imei


def _clamp_int(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _as_bool(value, default):
    if value in (None, ''):
        return default
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'on')
    return bool(value)


@api.route('/api/v1/ufi/comm', methods=['GET'])
@api_security
def listUfiComm():
    """Merged view: device ledger (read-only) + comm attributes (this module) + dbaliases."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        domain = _ufi_auth_domain()
        rows = db.execute(text(
            "SELECT d.id, d.imei, d.sn, d.imsi, d.sim_number, d.agent_type, d.sip_reg_status, "
            "d.cellular_status, d.cellular_network, d.wlan_status, d.last_ip, d.last_msg_type, "
            "d.last_seen, d.provisioned, d.lte_status, d.sim_type, d.volte_status, d.voip_status, "
            "d.ws_status, d.network_type, d.airplane_mode, d.signal_level, d.earfcn, "
            "d.linphone_status, d.wfc_status, d.cpu_use, d.mem_use, d.storage_use, d.build_number, "
            "d.ws_online, d.sim_state, d.status_json, d.pending_settings, "
            "(SELECT COUNT(*) FROM location loc WHERE loc.username = d.imei AND loc.expires > NOW()) AS online, "
            "TIMESTAMPDIFF(SECOND, d.last_seen, NOW()) AS gap_sec "
            "FROM dsip_ufi_device d ORDER BY d.last_seen DESC"
        )).mappings().all()
        live = set()
        try:
            from modules.api.ufi_ws import ws_connected_imeis
            live = ws_connected_imeis()
        except Exception:
            live = set()
        comm = _comm_rows(db)
        data = []
        for row in rows:
            item = _row_to_console(row, live, domain)
            c = comm.get(str(item.get('imei')))
            sim = str(item.get('simNumber') or '').replace('+86', '').replace('+', '')
            item['comm'] = {
                'sim': (c or {}).get('sim') or sim,
                'pool_id': (c or {}).get('pool_id') or '—',
                'carrier': (c or {}).get('carrier') or '100',
                'enabled': bool((c or {}).get('enabled', 1)),
                'in_pool': bool((c or {}).get('in_pool', 0)),
                'weight': (c or {}).get('weight', 1),
                'max_concurrent': (c or {}).get('max_concurrent', 2),
                'active_calls': (c or {}).get('active_calls', 0),
                'note': (c or {}).get('note') or '',
                'managed': bool(c),
            }
            data.append(item)
        # inbound mapping: read-only view of kamailio dbaliases (alias_username -> username)
        dids = []
        try:
            alias_rows = db.execute(text(
                "SELECT alias_username, alias_domain, username, domain FROM dbaliases ORDER BY alias_username"
            )).mappings().all()
            for r in alias_rows:
                alias = str(r['alias_username'] or '')
                user = str(r['username'] or '')
                kind = 'imei' if user == alias else ('main' if not user else 'sim')
                dids.append({
                    'did': alias,
                    'kind': kind,
                    'imei': user,
                    'domain': str(r['domain'] or ''),
                    'target': '话机 1002',
                })
        except Exception:
            dids = []
        carriers = []
        try:
            gw_rows = db.execute(text(
                "SELECT gwid, address, description FROM dr_gateways "
                "WHERE type = 8 AND gwid >= 100 ORDER BY gwid"
            )).mappings().all()
            for g in gw_rows:
                m = re.search(r'name:([^,]+)', str(g['description'] or ''))
                carriers.append({'gwid': str(int(g['gwid'])),
                                 'name': (m.group(1).strip() if m else ('VOS ' + str(g['gwid']))),
                                 'address': str(g['address'] or '')})
        except Exception:
            carriers = [{'gwid': '100', 'name': 'VOS3000', 'address': '8.136.109.38'}]
        return createApiResponse(msg='UFI comm view', data=[{'devices': data, 'dids': dids, 'carriers': carriers}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/<imei>', methods=['PUT'])
@api_security
def updateUfiComm(imei):
    """Upsert comm attributes for one IMEI (device ledger untouched)."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        imei = _normalize_imei(imei)
        if imei is None:
            return createApiResponse(error='http', msg='invalid imei', status_code=400)
        payload = getRequestData() or {}
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        exists = db.execute(text(
            "SELECT id FROM dsip_ufi_device WHERE imei = :imei"
        ), {'imei': imei}).first()
        if exists is None:
            return createApiResponse(error='http', msg='device not found in ledger', status_code=404)
        comm = _comm_rows(db).get(imei) or {}
        sim = str(payload.get('sim') if payload.get('sim') not in (None, '') else (comm.get('sim') or '')).strip()
        pool_id = str(payload.get('pool_id') if payload.get('pool_id') not in (None, '') else (comm.get('pool_id') or '—')).strip()[:16]
        enabled = 1 if _as_bool(payload.get('enabled'), bool(comm.get('enabled', 1))) else 0
        in_pool = 1 if _as_bool(payload.get('in_pool'), bool(comm.get('in_pool', 0))) else 0
        weight = _clamp_int(payload.get('weight', comm.get('weight', 1)), 1, 99, 1)
        max_conc = _clamp_int(payload.get('max_concurrent', comm.get('max_concurrent', 2)), 0, 999, 2)
        note = str(payload.get('note') if payload.get('note') is not None else (comm.get('note') or ''))[:255]
        carriers = _carrier_set(db)
        carrier = str(payload.get('carrier') if payload.get('carrier') not in (None, '') else (comm.get('carrier') or '100')).strip()
        if carrier not in carriers:
            return createApiResponse(error='http', msg='invalid carrier (not a type=8 gateway with gwid>=100)', status_code=400)
        db.execute(text(
            "INSERT INTO dsip_ufi_pool (imei, sim, pool_id, enabled, in_pool, weight, max_concurrent, note, carrier, updated_at) "
            "VALUES (:imei, :sim, :pool, :enabled, :in_pool, :weight, :max_conc, :note, :carrier, NOW()) "
            "ON DUPLICATE KEY UPDATE sim=:sim, pool_id=:pool, enabled=:enabled, in_pool=:in_pool, "
            "weight=:weight, max_concurrent=:max_conc, note=:note, carrier=:carrier, updated_at=NOW()"
        ), {'imei': imei, 'sim': sim, 'pool': pool_id, 'enabled': enabled, 'in_pool': in_pool,
            'weight': weight, 'max_conc': max_conc, 'note': note, 'carrier': carrier})
        sync = sync_ufi_routes(db)
        db.commit()
        return createApiResponse(msg='comm attributes saved', data=[{
            'imei': imei, 'sim': sim, 'pool_id': pool_id, 'carrier': carrier, 'enabled': bool(enabled),
            'in_pool': bool(in_pool), 'weight': weight, 'max_concurrent': max_conc, 'note': note,
            'route_sync': sync,
        }])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/bulk', methods=['POST'])
@api_security
def bulkUfiComm():
    """Bulk actions over comm attributes: enable / disable / maintain / reset-conc."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        payload = getRequestData() or {}
        action = str(payload.get('action') or '').strip()
        imeis = payload.get('imeis') or []
        if action not in BULK_ACTIONS or not isinstance(imeis, list) or not imeis:
            return createApiResponse(error='http', msg='action or imeis missing', status_code=400)
        imeis = [i for i in (_normalize_imei(x) for x in imeis) if i]
        if not imeis:
            return createApiResponse(error='http', msg='no valid imei', status_code=400)
        db = startSession()
        _ensure_ufi_tables(db)
        _ensure_comm_tables(db)
        updated = []
        for imei in imeis:
            comm = _comm_rows(db).get(imei) or {}
            if action == 'enable':
                pool_id = comm.get('pool_id') or 'P1'
                db.execute(text(
                    "INSERT INTO dsip_ufi_pool (imei, pool_id, enabled, in_pool, updated_at) "
                    "VALUES (:imei, :pool, 1, 1, NOW()) "
                    "ON DUPLICATE KEY UPDATE enabled=1, in_pool=1, pool_id=:pool, updated_at=NOW()"
                ), {'imei': imei, 'pool': pool_id})
            elif action == 'disable':
                db.execute(text(
                    "INSERT INTO dsip_ufi_pool (imei, enabled, in_pool, updated_at) "
                    "VALUES (:imei, 0, 0, NOW()) "
                    "ON DUPLICATE KEY UPDATE enabled=0, in_pool=0, updated_at=NOW()"
                ), {'imei': imei})
            elif action == 'maintain':
                db.execute(text(
                    "INSERT INTO dsip_ufi_pool (imei, in_pool, updated_at) "
                    "VALUES (:imei, 0, NOW()) "
                    "ON DUPLICATE KEY UPDATE in_pool=0, updated_at=NOW()"
                ), {'imei': imei})
            elif action == 'reset-conc':
                db.execute(text(
                    "UPDATE dsip_ufi_pool SET active_calls=0 WHERE imei=:imei"
                ), {'imei': imei})
            updated.append(imei)
        sync = sync_ufi_routes(db)
        db.commit()
        return createApiResponse(msg='bulk %s applied' % action,
                                 data=[{'action': action, 'updated': updated, 'route_sync': sync}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/dids', methods=['POST'])
@api_security
def createUfiDid():
    """Insert an inbound mapping (kamailio.dbaliases): alias_username -> username(IMEI)."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        payload = getRequestData() or {}
        did = _normalize_did(payload.get('did'))
        imei = str(payload.get('imei') or '').strip()
        # main-kind mapping maps the alias to the trunk main number (empty username);
        # otherwise imei must be a valid device identifier
        if imei and _normalize_imei(imei) is None:
            imei = ''
        if did is None:
            return createApiResponse(error='http', msg='invalid did or imei', status_code=400)
        db = startSession()
        dup = db.execute(text(
            "SELECT id FROM dbaliases WHERE alias_username = :a AND username = :u"
        ), {'a': did, 'u': imei}).first()
        if dup is not None:
            return createApiResponse(msg='mapping already exists', data=[{'did': did, 'imei': imei, 'created': False}])
        domain = _ufi_auth_domain()
        db.execute(text(
            "INSERT INTO dbaliases (alias_username, alias_domain, username, domain) "
            "VALUES (:a, :d, :u, :d)"
        ), {'a': did, 'u': imei, 'd': domain})
        db.commit()
        return createApiResponse(msg='mapping created', data=[{'did': did, 'imei': imei, 'domain': domain, 'created': True}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()


@api.route('/api/v1/ufi/comm/dids/<did>', methods=['DELETE'])
@api_security
def deleteUfiDid(did):
    """Delete inbound mapping(s) by alias_username (all rows for that alias)."""
    db = DummySession()
    try:
        if settings.DEBUG:
            debugEndpoint()
        alias = _normalize_did(did)
        if alias is None:
            return createApiResponse(error='http', msg='invalid did', status_code=400)
        db = startSession()
        res = db.execute(text("DELETE FROM dbaliases WHERE alias_username = :a"), {'a': alias})
        db.commit()
        if res.rowcount == 0:
            return createApiResponse(error='http', msg='mapping not found', status_code=404)
        return createApiResponse(msg='mapping deleted', data=[{'did': alias, 'deleted': res.rowcount}])
    except Exception as ex:
        db.rollback()
        db.flush()
        return showApiError(ex)
    finally:
        db.close()
