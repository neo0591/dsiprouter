# UFI 云端反向管理 — 服务端开发说明（Java 对接）

> 目标：设备有外网时，云端通过 WebSocket 隧道反向访问设备本地管理台（`127.0.0.1:adminPort`），**不向公网暴露设备私网 IP**。  
> 无外网时：设备侧 SoftAP 现场管理（`http://192.168.43.1:8080`），云端 WS 断开。  
> 本文只描述**服务端**必须实现的能力与协议，便于 Java 团队落地。

---

## 1. 总体流程

```
设备有 INTERNET
  → HTTP get-url / get-url-info 拿到 baseUrl + wsUrl
  → 连接 WSS（带 imei + token）
  → 发送 Ufi-Admin-Tunnel-Register（注册本地管理端口）
  → 云端标记隧道就绪，开放反向入口 URL
  → 运营人员浏览器访问云端 /admin-proxy/...
  → 云端把 HTTP 请求封装成 WS 命令 admin_http_proxy
  → 设备访问本机 http://127.0.0.1:{adminPort}{path}，经 WS 回传响应
  → 云端把响应写回浏览器（必要时改写 HTML/Cookie）

设备无 INTERNET
  → SoftAP ON，现场访问 http://192.168.43.1:8080
  → 云端 WS 断开，隧道不可用
```

| 条件 | SoftAP | 云端 WS / 隧道 |
|------|--------|----------------|
| 无 INTERNET | ON（现场管理） | 断开 |
| 有 INTERNET | OFF | get-url → WS → Tunnel-Register → 可反向代理 |

**硬约束：**

1. 公网入口只能是云端 URL，禁止把 `192.168.x.x` / CGNAT / 设备公网出口 IP 当作管理入口返回给前端。
2. 设备侧实际访问目标固定为环回：`127.0.0.1`（或 `localhost` / `::1`），即使设备上报了其它 `adminHost` 也要纠正为环回。
3. 反向代理是「一次 HTTP 请求 ↔ 一次 WS 请求/响应」，不是 TCP 透明隧道。

---

## 2. 前置：设备 WebSocket 通道

假定已有设备控制面 WebSocket（与现有 UFI 指令通道共用即可）。

### 2.1 连接

- URL 示例：`wss://{cloud-host}/ufi/websocket?imei={imei}&token={token}`
- `token` 建议：`SHA-256(secretKey + imei)` 十六进制（与现有 UFI 签名体系一致即可）
- 同一 IMEI 只保留一条活跃连接；新连接顶替旧连接时，**不要**误清新连接的隧道状态

### 2.2 请求关联

所有命令/代理请求带 `requestId`（UUID）。设备回复必须回带同一 `requestId`，云端用它完成 Future/CompletableFuture 匹配。

### 2.3 签名（若沿用现有 UFI 规范）

下发给设备的 JSON：字段按 key 升序拼接 `k=v&...&secret_key=密钥`，再 SHA-256，写入 `sign`。  
时间戳 `ts` 建议毫秒，允许 ±5 分钟。

---

## 3. 协议一：隧道注册（设备 → 云端）

### 3.1 设备上报

`msgType = Ufi-Admin-Tunnel-Register`

```json
{
  "msgType": "Ufi-Admin-Tunnel-Register",
  "requestId": "<uuid>",
  "ts": "<ms>",
  "imei": "<imei>",
  "sn": "<sn>",
  "adminHost": "127.0.0.1",
  "adminPort": 8080,
  "adminPath": "/",
  "ready": true
}
```

| 字段 | 说明 |
|------|------|
| adminHost | 设备本地管理地址；云端应强制按环回处理 |
| adminPort | 本地 HTTP 端口，默认 8080 |
| adminPath | 本地管理根路径，默认 `/` |
| ready | `true` 表示可接受 `admin_http_proxy` |

### 3.2 云端处理

1. 校验该 IMEI 当前 WS 在线。
2. 规范化：`adminHost∈{127.0.0.1,localhost,::1}`，否则改成 `127.0.0.1`；`adminPort` 合法端口；`adminPath` 以 `/` 开头。
3. **内存登记**隧道会话（与 WS 连接绑定，断线即失效）：

```text
TunnelSession {
  imei, sn, adminHost, adminPort, adminPath, ready, registeredAt, wsSessionId
}
```

4. 可选落库（便于列表展示「上次就绪」），但**是否可代理必须以内存/实时 WS 为准**。
5. ACK 回复设备：

```json
{
  "msgType": "Ufi-Admin-Tunnel-Register",
  "requestId": "<原 requestId>",
  "imei": "<imei>",
  "code": 200,
  "ok": 1,
  "comment": "tunnel registered",
  "adminHost": "127.0.0.1",
  "adminPort": 8080,
  "adminPath": "/",
  "ready": true
}
```

失败（未连接等）：`code=409, ok=0`。

### 3.3 断线清理

WS 断开时：

- 删除该 IMEI 的 `TunnelSession`
- `tunnelReady=false`
- 注意重连竞态：仅当断开的是「当前活跃连接」时才清理（避免旧 socket finally 清掉新连接隧道）

---

## 4. 协议二：HTTP 代理（云端 → 设备）【推荐】

### 4.1 请求（云端下发）

`msgType = Ufi-Get-Cmd-Request`，`cmd = admin_http_proxy`

```json
{
  "msgType": "Ufi-Get-Cmd-Request",
  "requestId": "<uuid>",
  "ts": "<ms>",
  "imei": "<imei>",
  "cmd": "admin_http_proxy",
  "method": "GET",
  "path": "/api/ping",
  "headers": {
    "Accept": "application/json"
  },
  "bodyBase64": "",
  "timeoutMs": 15000,
  "adminPort": 8080
}
```

| 字段 | 说明 |
|------|------|
| method | HTTP 方法：GET/POST/PUT/PATCH/DELETE/HEAD… |
| path | 以 `/` 开头，可含 query：`/login.html`、`/api/login`、`/x?y=1` |
| headers | 转发给设备本地管理台的请求头（见下方过滤） |
| bodyBase64 | 请求体 Base64；无体则为 `""` |
| timeoutMs | 设备侧访问本机的超时，建议 1000–60000，默认 15000 |
| adminPort | 可选，与隧道注册一致 |

设备行为：访问 `http://127.0.0.1:{adminPort}{path}`，把结果回传。

### 4.2 响应（设备 → 云端）

设备通过同一 WS、同一 `requestId` 回复（常见仍带 `msgType=Ufi-Get-Cmd-Request` 或业务约定的响应类型）：

```json
{
  "msgType": "Ufi-Get-Cmd-Request",
  "requestId": "<uuid>",
  "cmd": "admin_http_proxy",
  "code": 200,
  "ok": 1,
  "httpStatus": 200,
  "headers": {
    "Content-Type": "application/json; charset=utf-8"
  },
  "bodyBase64": "<base64>",
  "adminPort": 8080
}
```

| 字段 | 说明 |
|------|------|
| ok | 设备侧代理是否成功（连接失败等为 0） |
| httpStatus | 本地管理台返回的 HTTP 状态码 |
| headers | 响应头（可裁剪 hop-by-hop） |
| bodyBase64 | 响应体 Base64 |

云端匹配 `requestId` 后解码 `bodyBase64`，写回浏览器。

### 4.3 可选：专用 msgType

请求：`msgType = Ufi-Admin-Http-Proxy`（字段同 4.1，可无 `cmd`）  
响应：同名字段 + `code` + `httpStatus` + `bodyBase64`  

建议优先实现 **cmd=`admin_http_proxy`**；专用 msgType 作为兼容。

---

## 5. 云端 HTTP 反向入口（给浏览器 / 管理台）

### 5.1 URL 设计（建议）

```text
GET|POST|PUT|PATCH|DELETE|HEAD ...
  /api/v1/ufi/devices/{imei}/admin-proxy/
  /api/v1/ufi/devices/{imei}/admin-proxy/{*subpath}
```

示例：

```text
https://{cloud}/api/v1/ufi/devices/358193589081463/admin-proxy/login.html
https://{cloud}/api/v1/ufi/devices/358193589081463/admin-proxy/api/login
https://{cloud}/api/v1/ufi/devices/358193589081463/admin-proxy/api/ping
```

路径拼装：

```text
devicePath = join(adminPath, subpath) + "?" + queryString
# 例：adminPath=/ , subpath=login.html → /login.html
```

### 5.2 鉴权（admin-proxy 免平台登录）

- **`/admin-proxy/**` 不要求云端后台登录**，拿到链接即可访问（便于分享/直开设备管理页）。
- **设备管理台自身密码登录**仍由设备侧 `/api/login` 负责，云端只做反向通道。
- 建议对 `imei` 做格式校验（如 8–32 位字母数字），降低被当成开放扫描入口的风险。
- `GET .../tunnel`、设备列表等**管理 API** 仍应要求平台登录 / API Token。

### 5.3 隧道未就绪

返回 HTTP 409（或业务码），提示 SoftAP：

```json
{
  "tunnelReady": false,
  "softApUrl": "http://192.168.43.1:8080",
  "msg": "admin tunnel not ready"
}
```

### 5.4 单次代理伪代码（Java）

```java
// 1) 查 TunnelSession，不存在或 !ready → 409
// 2) 过滤请求头，拼 path / bodyBase64
// 3) 经 WS 发送 admin_http_proxy，timeout = timeoutMs + 网络余量
// 4) 等待 requestId 对应回复
// 5) 解码 bodyBase64，改写 Location / Set-Cookie / HTML，写回 HttpServletResponse
```

超时建议：网关/Nginx `proxy_read_timeout >= 90s`；单次代理默认 15s。

---

## 6. 请求/响应头处理（必做）

### 6.1 不转发给设备的请求头

`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`,  
`Proxy-*`, `Upgrade`, `TE`, `Trailer`,  
**云端** `Authorization`、**云端** `Cookie`（平台 Session 禁止下发到设备）

### 6.2 可转发

`Accept`, `Content-Type`, `User-Agent`（可选）, 以及「设备 Cookie」（见 6.3）

### 6.3 Cookie 命名空间（强烈建议）

设备管理台 Cookie 名常与云端 `session` 冲突。

- 设备 `Set-Cookie: session=xxx; Path=/`  
  → 云端改为：`Set-Cookie: ufi{imei}_session=xxx; Path=/api/v1/ufi/devices/{imei}/admin-proxy/`  
  → 去掉 `Domain=`
- 浏览器再请求时：把 `ufi{imei}_*` 还原成设备原 Cookie 名，再放入 `admin_http_proxy.headers.Cookie`

### 6.4 Location 改写

把设备返回的：

- `http://127.0.0.1:8080/...`
- `http://localhost:8080/...`
- 以及 `192.168.*` / `10.*` / `172.16-31.*` 绝对地址  

改写为：

```text
/api/v1/ufi/devices/{imei}/admin-proxy/...
```

相对路径 `/xxx` 同样加上代理前缀。

### 6.5 丢弃设备 CSP（建议）

设备 `Content-Security-Policy` 常会阻断云端注入的脚本/路径，建议代理时剥离。

---

## 7. HTML/JS 改写（必做，否则页面「空白/登录失败」）

设备管理页大量使用**根绝对路径**，例如：

```js
fetch('/api/login', { method: 'POST', ... })
```

`<base href="...">` **无法**改写以 `/` 开头的绝对路径。必须额外处理：

### 7.1 注入 `<base>`

```html
<base href="/api/v1/ufi/devices/{imei}/admin-proxy/">
```

（仅帮助相对路径如 `index.html`）

### 7.2 改写文本中的绝对路径

对 `text/html`、`application/javascript`、`text/css`：

- `href="/x"` / `src="/x"` / `action="/x"`
- `url(/x)`
- `fetch('/x'`
- `XMLHttpRequest.open(..., '/x'`
- `location.href = '/x'`

改为带代理前缀的路径；**已带前缀的不要二次改写**。

### 7.3 注入 fetch/XHR 钩子（推荐）

在 `<head>` 尽早注入（示意）：

```js
(function (p) {
  if (window.__ufiProxyHook) return;
  window.__ufiProxyHook = 1;
  function fix(u) {
    if (typeof u === 'string' && u.charAt(0) === '/' && u.indexOf(p) !== 0) return p + u;
    return u;
  }
  var f = window.fetch;
  if (f) {
    window.fetch = function (u, o) {
      u = fix(u);
      return f.call(this, u, o);
    };
  }
  var o = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    if (arguments.length > 1) arguments[1] = fix(arguments[1]);
    return o.apply(this, arguments);
  };
})('/api/v1/ufi/devices/{imei}/admin-proxy');
```

注意：用字符串拼接注入，避免 Java `MessageFormat` / `String.format` 与 JS `{` `}` 冲突。

### 7.4 JSON 内私网 URL（建议）

设备如返回：

```json
{ "adminUrl": "http://192.168.206.135:8080/", "staIp": "..." }
```

应对 `adminUrl` / `discoverUrl` 等做脱敏或改写成云端代理前缀，避免前端跳到私网。

---

## 8. 管理 API（给控制台）

### 8.1 隧道状态

```http
GET /api/v1/ufi/devices/{imei}/tunnel
Authorization: Bearer <token> 或 Session
```

响应示例：

```json
{
  "imei": "358193589081463",
  "wsOnline": true,
  "tunnelReady": true,
  "adminHost": "127.0.0.1",
  "adminPort": 8080,
  "adminPath": "/",
  "adminProxyUrl": "/api/v1/ufi/devices/358193589081463/admin-proxy/",
  "softApUrl": "http://192.168.43.1:8080",
  "registeredAt": 1791947867889
}
```

### 8.2 设备列表字段（建议）

| 字段 | 含义 |
|------|------|
| tunnelReady | 当前可反向管理 |
| adminProxyUrl | 非空则可点「远程管理」 |
| softApUrl | 固定 `http://192.168.43.1:8080` |
| softApHint | 文案提示 |

前端：隧道就绪则 `window.open(adminProxyUrl)`；否则提示 SoftAP。

---

## 9. 容量与可靠性

| 项 | 建议 |
|----|------|
| WS 帧大小 | 管理页 HTML/资源可能较大，建议 ≥ 4MB |
| 并发 | 按 IMEI 串行化同一设备的代理请求，避免打爆设备本机 HTTP |
| 超时 | `timeoutMs` 默认 15s；云端等待 = timeoutMs + 5s |
| 多实例 | 隧道会话必须与持有该设备 WS 的节点一致（粘滞 / Redis 路由 / 单节点写） |
| 重连 | 设备重连后必须重新 Tunnel-Register 才可代理 |
| 日志 | 记录 imei、requestId、method、path、httpStatus、耗时；**不要**打满 body |

---

## 10. Java 模块拆分建议

```text
ufi-ws/
  UfiWebSocketHandler          // 连接鉴权、心跳、消息分发
  UfiTunnelRegistry            // ConcurrentHashMap<imei, TunnelSession>
  UfiCommandPendingStore       // requestId → CompletableFuture<JsonNode>

ufi-admin-proxy/
  AdminProxyController         // /devices/{imei}/admin-proxy/**
  AdminHttpProxyService        // 组装 admin_http_proxy、等待应答
  ProxyHeaderFilter            // 头过滤
  ProxyCookieCodec             // Cookie 命名空间
  ProxyHtmlRewriter            // base + 绝对路径 + fetch 钩子
  ProxyLocationRewriter        // Location / 私网 URL

ufi-api/
  TunnelStatusController       // GET .../tunnel
```

Spring 示例路由：

```java
@RequestMapping("/api/v1/ufi/devices/{imei}/admin-proxy/**")
public void proxy(HttpServletRequest req, HttpServletResponse resp,
                  @PathVariable String imei) { ... }
```

用 `HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE` 取 `subpath`。

---

## 11. 联调验收清单

1. 设备上线后上报 `Ufi-Admin-Tunnel-Register`，云端 ACK `ok=1`。
2. `GET .../tunnel` → `tunnelReady=true`，`adminProxyUrl` 非空。
3. **未登录平台**直接打开 `.../admin-proxy/login.html` 或 `index.html` → 看到 **UFI 设备登录/管理**页（不是平台登录页、不是空白/500）。
4. 浏览器 Network 中设备登录请求应是：  
   `POST .../admin-proxy/api/login`  
   **不是** `POST /api/login`（打到云端根路径即失败）。
5. 设备侧登录成功后能进入 `index.html` 等后续页；刷新不丢设备 Cookie。
6. WS 断开后 `tunnelReady=false`，代理返回 409，并提示 SoftAP。
7. 响应中不出现可被前端直接跳转的 `http://192.168.*` 管理入口。

---

## 12. 与设备侧的职责边界

| 侧 | 职责 |
|----|------|
| 设备 | 有网连 WS并 Register；执行 `admin_http_proxy` 访问本机管理端口；无网开 SoftAP |
| 云端 | 登记隧道、WS 封装 HTTP、改写 HTML/Cookie/Location、对外提供免平台登录的 admin-proxy URL |
| 前端 | 仅打开云端 `adminProxyUrl`；无隧道时提示 SoftAP |

---

## 13. 最小消息全集（复制用）

**注册**

```json
{"msgType":"Ufi-Admin-Tunnel-Register","requestId":"...","ts":"...","imei":"...","sn":"...","adminHost":"127.0.0.1","adminPort":8080,"adminPath":"/","ready":true}
```

**代理请求**

```json
{"msgType":"Ufi-Get-Cmd-Request","requestId":"...","ts":"...","imei":"...","cmd":"admin_http_proxy","method":"GET","path":"/api/ping","headers":{"Accept":"application/json"},"bodyBase64":"","timeoutMs":15000}
```

**代理响应**

```json
{"msgType":"Ufi-Get-Cmd-Request","requestId":"...","cmd":"admin_http_proxy","code":200,"ok":1,"httpStatus":200,"headers":{"Content-Type":"application/json; charset=utf-8"},"bodyBase64":"...","adminPort":8080}
```

---

文档版本：与 dSIPRouter UFI 云端反向管理实现对齐（2026-10）。  
联调时以设备固件实际回包字段为准；若 `httpStatus`/`bodyBase64` 字段名有别名，云端需兼容读取。
