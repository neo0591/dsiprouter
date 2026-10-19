# UFI WebSocket server: device heartbeat, status, and command delivery.
# Runs in a background thread because the GUI uses bjoern (no native WS).

import asyncio
import base64
import hashlib
import json
import threading
import time
import uuid
from urllib.parse import parse_qs, urlparse

from database import DummySession, startSession
from sqlalchemy.sql import text
import settings

UFI_ALLOWED_CMDS = {
    'reboot', 'restart_linphone', 'wifi_on', 'wifi_off', 'wifi_scan', 'wifi_connect',
    'wificall', 'wificall_on', 'wificall_off', 'wifi_calling_on', 'wifi_calling_off',
    'hotspot_on', 'hotspot_off', 'sim_set_pin', 'sim_verify_pin', 'sim_verify_puk',
    'admin_http_proxy',
}

# How long (seconds) a command entry stays available for result polling after dispatch.
# Covers the GUI's 120s wait budget plus slack; reaped lazily by _gc_pending().
PENDING_TTL = 300
# SoftAP fallback when the device has no INTERNET (device-side local admin).
UFI_SOFTAP_ADMIN = 'http://192.168.43.1:8080'

_loop = None
_thread = None
_connections = {}
# imei -> tunnel registration from Ufi-Admin-Tunnel-Register
_tunnels = {}
# request_id -> {'future': Future, 'reply': dict|None, 'done': bool, 'created': float}
_pending = {}
_lock = threading.Lock()


def _ws_path(websocket, path=None):
    if path:
        return path
    request = getattr(websocket, 'request', None)
    if request is not None:
        return getattr(request, 'path', '') or ''
    return getattr(websocket, 'path', '') or ''


def _query(path):
    parsed = urlparse(path or '')
    params = parse_qs(parsed.query or '')
    return {key: values[0] if values else '' for key, values in params.items()}


def ws_connected_imeis():
    with _lock:
        return set(_connections.keys())


def get_ufi_tunnel(imei):
    """Return live admin-tunnel registration for imei, or None."""
    with _lock:
        info = _tunnels.get(str(imei or '').strip())
        return dict(info) if info else None


def ufi_tunnel_map():
    """Snapshot of all live admin tunnels (imei -> info)."""
    with _lock:
        return {k: dict(v) for k, v in _tunnels.items()}


def _gc_pending():
    """Reap command entries older than PENDING_TTL (must hold _lock)."""
    now = time.time()
    stale = [key for key, entry in _pending.items() if now - entry['created'] > PENDING_TTL]
    for key in stale:
        _pending.pop(key, None)


def _set_ws_flag(imei, online):
    db = DummySession()
    try:
        db = startSession()
        try:
            from modules.api.ufi_device import _ensure_ufi_tables
            _ensure_ufi_tables(db)
        except Exception:
            pass
        if online:
            db.execute(text(
                "UPDATE dsip_ufi_device SET ws_online = 1, last_seen = NOW(), last_msg_type = :msg "
                "WHERE imei = :imei"
            ), {'imei': imei, 'msg': 'websocket'})
        else:
            db.execute(text(
                "UPDATE dsip_ufi_device SET ws_online = 0, tunnel_ready = 0, "
                "last_seen = NOW(), last_msg_type = :msg WHERE imei = :imei"
            ), {'imei': imei, 'msg': 'websocket'})
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _persist_tunnel(imei, info, clear=False):
    db = DummySession()
    try:
        db = startSession()
        try:
            from modules.api.ufi_device import _ensure_ufi_tables
            _ensure_ufi_tables(db)
        except Exception:
            pass
        if clear:
            db.execute(text(
                "UPDATE dsip_ufi_device SET tunnel_ready = 0, last_msg_type = :msg, last_seen = NOW() "
                "WHERE imei = :imei"
            ), {'imei': imei, 'msg': 'Ufi-Admin-Tunnel-Clear'})
        else:
            db.execute(text(
                "UPDATE dsip_ufi_device SET tunnel_ready = :ready, tunnel_admin_host = :host, "
                "tunnel_admin_port = :port, tunnel_admin_path = :path, tunnel_json = :raw, "
                "sn = IF(:sn = '', sn, :sn), last_msg_type = :msg, last_seen = NOW() "
                "WHERE imei = :imei"
            ), {
                'imei': imei,
                'ready': 1 if info.get('ready') else 0,
                'host': str(info.get('adminHost') or '127.0.0.1')[:64],
                'port': int(info.get('adminPort') or 8080),
                'path': str(info.get('adminPath') or '/')[:128],
                'raw': json.dumps(info, ensure_ascii=False, default=str)[:8000],
                'sn': str(info.get('sn') or ''),
                'msg': 'Ufi-Admin-Tunnel-Register',
            })
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _register_tunnel(imei, payload):
    try:
        port = int(payload.get('adminPort') or 8080)
    except (TypeError, ValueError):
        port = 8080
    if port <= 0 or port > 65535:
        port = 8080
    host = str(payload.get('adminHost') or '127.0.0.1').strip() or '127.0.0.1'
    # Never expose device LAN/CGNAT; cloud always targets loopback on the device.
    if host not in ('127.0.0.1', 'localhost', '::1'):
        host = '127.0.0.1'
    path = str(payload.get('adminPath') or '/').strip() or '/'
    if not path.startswith('/'):
        path = '/' + path
    ready_raw = payload.get('ready', True)
    ready = str(ready_raw).lower() not in ('0', 'false', 'no', 'off') and ready_raw is not False
    info = {
        'imei': imei,
        'sn': str(payload.get('sn') or '').strip(),
        'adminHost': host,
        'adminPort': port,
        'adminPath': path,
        'ready': ready,
        'registeredAt': int(time.time() * 1000),
        'requestId': str(payload.get('requestId') or ''),
    }
    with _lock:
        if imei in _connections:
            _tunnels[imei] = info
        else:
            info = None
    if info:
        _persist_tunnel(imei, info)
    return info


async def _handler(websocket, path=None):
    from modules.api.ufi_device import (
        DEFAULT_UFI_SECRET,
        _canonical_sign_string,
        persist_ufi_payload,
        _field,
        _load_ufi_config,
    )

    path = _ws_path(websocket, path)
    query = _query(path)
    imei = str(query.get('imei') or '').strip()
    token = str(query.get('token') or '').strip()
    db = DummySession()
    try:
        db = startSession()
        cfg = _load_ufi_config(db)
        db.commit()
    except Exception:
        db.rollback()
        cfg = {'secret_key': DEFAULT_UFI_SECRET}
    finally:
        db.close()

    secret = str(cfg.get('secret_key') or DEFAULT_UFI_SECRET)
    expect = hashlib.sha256((secret + imei).encode('utf-8')).hexdigest() if imei else ''
    if not imei or not token or token.lower() != expect.lower():
        try:
            await websocket.close(code=4401, reason='invalid token')
        except Exception:
            pass
        return

    with _lock:
        old = _connections.get(imei)
        _connections[imei] = websocket
    if old is not None and old is not websocket:
        try:
            await old.close()
        except Exception:
            pass
    persist_ufi_payload({'imei': imei, 'msgType': 'websocket-connect', 'websocketStatus': '1'})
    _set_ws_flag(imei, True)

    try:
        async for raw in websocket:
            try:
                payload = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode('utf-8'))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            msg_type = str(payload.get('msgType') or '').strip()
            request_id = str(payload.get('requestId') or '').strip()
            payload.setdefault('imei', imei)

            if msg_type in ('Ufi-Ws-Heartbeat-Request',):
                persist_ufi_payload(payload, {'last_msg_type': 'heartbeat'})
                await websocket.send(json.dumps({
                    'msgType': 'Ufi-Ws-Heartbeat-Request',
                    'data': 'pong',
                    'requestId': request_id,
                    'imei': imei,
                }))
                continue

            if msg_type == 'Ufi-Admin-Tunnel-Register':
                info = _register_tunnel(imei, payload)
                await websocket.send(json.dumps({
                    'msgType': 'Ufi-Admin-Tunnel-Register',
                    'requestId': request_id,
                    'imei': imei,
                    'code': 200 if info else 409,
                    'ok': 1 if info else 0,
                    'comment': 'tunnel registered' if info else 'not connected',
                    'adminHost': (info or {}).get('adminHost', '127.0.0.1'),
                    'adminPort': (info or {}).get('adminPort', 8080),
                    'adminPath': (info or {}).get('adminPath', '/'),
                    'ready': bool(info and info.get('ready')),
                }, ensure_ascii=False))
                continue

            entry = None
            if request_id:
                with _lock:
                    entry = _pending.get(request_id)
                    if entry is not None and not entry['done']:
                        entry['reply'] = payload
                        entry['done'] = True
                    else:
                        entry = None
            if entry is not None and not entry['future'].done():
                entry['future'].set_result(payload)

            if msg_type in (
                'Ufi-Status-Request', 'LTE-Status', 'Ufi-Status-Log-Indication',
                'Ufi-Get-Cmd-Request', 'Ufi-Get-Log-Request', 'Ufi-Admin-Http-Proxy',
                'Ufi-Get-ESIM-Request',
            ):
                extra = {'last_msg_type': msg_type}
                if msg_type == 'Ufi-Status-Log-Indication':
                    extra['event'] = True
                persist_ufi_payload(payload, extra)
    finally:
        # Only clear state if this socket is still the active one (reconnect race).
        with _lock:
            still_mine = _connections.get(imei) is websocket
            if still_mine:
                _connections.pop(imei, None)
                _tunnels.pop(imei, None)
        if still_mine:
            _persist_tunnel(imei, None, clear=True)
            _set_ws_flag(imei, False)


async def _send_command(imei, body, timeout=25):
    from modules.api.ufi_device import _canonical_sign_string, _load_ufi_config, DEFAULT_UFI_SECRET

    with _lock:
        websocket = _connections.get(imei)
    if websocket is None:
        return {'ok': False, 'error': 'device is not connected on websocket'}

    db = DummySession()
    try:
        db = startSession()
        cfg = _load_ufi_config(db)
        db.commit()
    finally:
        db.close()

    secret = str(cfg.get('secret_key') or DEFAULT_UFI_SECRET)
    request_id = str(body.get('requestId') or uuid.uuid4())
    payload = dict(body)
    payload['msgType'] = payload.get('msgType') or 'Ufi-Get-Cmd-Request'
    payload['requestId'] = request_id
    payload['imei'] = imei
    payload['ts'] = int(time.time() * 1000)
    payload.pop('sign', None)
    payload['sign'] = hashlib.sha256(_canonical_sign_string(payload, secret).encode('utf-8')).hexdigest()

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    entry = {'future': future, 'reply': None, 'done': False, 'created': time.time()}
    with _lock:
        _gc_pending()
        _pending[request_id] = entry
    try:
        await websocket.send(json.dumps(payload, ensure_ascii=False))
        reply = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        return {'ok': True, 'requestId': request_id, 'sent': payload, 'reply': reply}
    except asyncio.TimeoutError:
        # keep the entry around so poll_ufi_command_result() can still pick up a late reply
        return {'ok': True, 'requestId': request_id, 'sent': payload, 'reply': None, 'pending': True}
    finally:
        pass


async def _wait_for_reply(request_id, timeout=25):
    """Wait (inside the ws loop) for a device reply already being awaited by a dispatch."""
    with _lock:
        _gc_pending()
        entry = _pending.get(request_id)
    if entry is None:
        return {'ok': False, 'error': 'request not found or expired'}
    if entry['done']:
        return {'ok': True, 'requestId': request_id, 'reply': entry['reply']}
    try:
        reply = await asyncio.wait_for(asyncio.shield(entry['future']), timeout=timeout)
        return {'ok': True, 'requestId': request_id, 'reply': reply}
    except asyncio.TimeoutError:
        return {'ok': True, 'requestId': request_id, 'reply': None, 'pending': True}


def poll_ufi_command_result(request_id, timeout=25):
    """Blocking lookup of a dispatched command's reply; safe to call from Flask threads."""
    loop = _loop
    if loop is None or not loop.is_running():
        return {'ok': False, 'error': 'websocket server is not running'}
    future = asyncio.run_coroutine_threadsafe(_wait_for_reply(request_id, timeout), loop)
    try:
        return future.result(timeout + 5)
    except Exception as ex:
        return {'ok': False, 'error': str(ex)}


def send_ufi_command(imei, body, timeout=25):
    loop = _loop
    if loop is None or not loop.is_running():
        return {'ok': False, 'error': 'websocket server is not running'}
    future = asyncio.run_coroutine_threadsafe(_send_command(imei, body, timeout), loop)
    try:
        return future.result(timeout + 5)
    except Exception as ex:
        return {'ok': False, 'error': str(ex)}


def proxy_ufi_admin_http(imei, method='GET', path='/', headers=None, body=None, timeout_ms=15000,
                         use_dedicated_msg=False):
    """
    Relay one HTTP request to the device local admin via WS (admin_http_proxy).
    Returns {ok, httpStatus, headers, body, error, reply}.
    """
    imei = str(imei or '').strip()
    tunnel = get_ufi_tunnel(imei)
    if tunnel is None or not tunnel.get('ready'):
        return {
            'ok': False,
            'error': 'admin tunnel not ready',
            'softApUrl': UFI_SOFTAP_ADMIN,
        }
    method = str(method or 'GET').upper()
    path = str(path or '/')
    if not path.startswith('/'):
        path = '/' + path
    try:
        timeout_ms = int(timeout_ms or 15000)
    except (TypeError, ValueError):
        timeout_ms = 15000
    timeout_ms = max(1000, min(timeout_ms, 60000))
    timeout_sec = (timeout_ms / 1000.0) + 5

    fwd_headers = {}
    if isinstance(headers, dict):
        for key, value in headers.items():
            if value is None:
                continue
            k = str(key)
            if k.lower() in (
                'host', 'content-length', 'transfer-encoding', 'connection',
                'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
                'authorization', 'cookie',
            ):
                continue
            fwd_headers[k] = str(value)

    if body is None:
        body_b64 = ''
    elif isinstance(body, (bytes, bytearray)):
        body_b64 = base64.b64encode(bytes(body)).decode('ascii') if body else ''
    else:
        body_b64 = base64.b64encode(str(body).encode('utf-8')).decode('ascii')

    if use_dedicated_msg:
        body_msg = {
            'msgType': 'Ufi-Admin-Http-Proxy',
            'imei': imei,
            'method': method,
            'path': path,
            'headers': fwd_headers,
            'bodyBase64': body_b64,
            'timeoutMs': timeout_ms,
            'adminPort': tunnel.get('adminPort') or 8080,
        }
    else:
        body_msg = {
            'msgType': 'Ufi-Get-Cmd-Request',
            'cmd': 'admin_http_proxy',
            'imei': imei,
            'method': method,
            'path': path,
            'headers': fwd_headers,
            'bodyBase64': body_b64,
            'timeoutMs': timeout_ms,
            'adminPort': tunnel.get('adminPort') or 8080,
        }

    result = send_ufi_command(imei, body_msg, timeout=timeout_sec)
    if not result.get('ok'):
        return {'ok': False, 'error': result.get('error') or 'proxy failed', 'reply': result.get('reply')}
    reply = result.get('reply')
    if reply is None:
        return {'ok': False, 'error': 'device proxy timeout', 'pending': True, 'requestId': result.get('requestId')}

    http_status = reply.get('httpStatus', reply.get('code', 502))
    try:
        http_status = int(http_status)
    except (TypeError, ValueError):
        http_status = 502
    resp_headers = reply.get('headers') if isinstance(reply.get('headers'), dict) else {}
    body_out = b''
    raw_b64 = reply.get('bodyBase64') or ''
    if raw_b64:
        try:
            body_out = base64.b64decode(raw_b64)
        except Exception:
            body_out = b''
    ok_flag = reply.get('ok', 1)
    ok = str(ok_flag).lower() not in ('0', 'false', 'no') and ok_flag is not False
    return {
        'ok': ok and 100 <= http_status < 600,
        'httpStatus': http_status,
        'headers': resp_headers,
        'body': body_out,
        'adminPort': reply.get('adminPort') or tunnel.get('adminPort'),
        'requestId': result.get('requestId'),
        'reply': reply,
        'error': None if ok else (reply.get('comment') or reply.get('error') or 'device proxy error'),
    }


async def _serve():
    import websockets

    bind = str(getattr(settings, 'UFI_WS_BIND', '127.0.0.1') or '127.0.0.1')
    port = int(getattr(settings, 'UFI_WS_PORT', 15001) or 15001)
    async with websockets.serve(_handler, bind, port, ping_interval=20, ping_timeout=20, max_size=2 ** 22):
        await asyncio.Future()


def _run_loop():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.run_until_complete(_serve())


def start_ufi_ws_server():
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_run_loop, name='ufi-websocket', daemon=True)
    _thread.start()
