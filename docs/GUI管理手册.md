# dSIPRouter GUI 管理手册

> 管理台：`https://106.75.29.22:5000/`  
> 对应代码版本：dSIPRouter `0.792`  
> 更新日期：2026-10-04

日常开通请走 **营业管理 → 配置向导**：按拓扑把 VOS 网关、UFI 开户、话机 DID 绑在一条路径上，不必再在终端组 / 入站路由里东找西找。

完成后请点右上角 **重载 → 重载 Kamailio**，配置才对 SIP 生效。

---

## 1. 页面地图（上级入口）

| 上级页面 | 侧栏位置 | 地址 | 下级页面 / 能力 |
|----------|----------|------|-----------------|
| 仪表盘 | 仪表盘 | `/` | 状态监控；管理入口卡片 |
| **营业管理** | 营业管理 | `/setup` `/onboarding` `/phones` | 配置向导、UFI 开户、话机 DID |
| 运营商组 | 运营商组 | `/carriergroups` | 组内运营商终端（IP、权重、认证） |
| 终端组 | 终端组 | `/endpointgroups` | 认证、终端主机、呼叫限制、FusionPBX、话单邮件 |
| 域名 | 域名 | `/domains` | 托管 PBX / Teams 域名映射 |
| 入站路由 | 入站路由 | `/inboundmapping` | DID → 终端组 |
| 出站路由 | 出站路由 | `/outboundroutes` | 前缀 → 运营商组 |
| 通话详单 | 通话详单 | `/cdrs` | 全部通话 / 计费通话 |
| 号码 | 号码 | `/gui/numbers` | 号码库存（动态模块） |
| 语音 AI 座席 | 语音 AI 座席 | `/gui/agents` | 座席（动态模块） |
| 系统设置 | 系统设置（子菜单） | `/settings` 等 | 全局、用户、备份、证书、Teleblock、TransNexus、STIR/SHAKEN、许可证、升级 |

登录后默认进入仪表盘。开户是客户开通的上级界面，不要从「终端组添加弹窗」当作唯一开户入口。

---

## 2. 登录

打开 `https://106.75.29.22:5000/`，输入管理员用户名和密码。

右上角可切换 **中文 / English**。会话超时后会回到登录页。

---

## 3. 仪表盘（全局上级页）

显示：活跃 SIP 呼叫、排队消息、CPS、注册失败、终端组/运营商组消息图、系统状态、热门终端组、告警。

**管理入口** 卡片（上级跳转）：

- 配置向导
- 开户
- 话机
- 通话详单

---

## 4. 营业管理（推荐路径）

目标拓扑：

```
手机 A ──蜂窝──→ UFI×N（SIM）──SIP REGISTER/INVITE（用户=IMEI，密码=MD5(IMEI)[:16]）
        → dSIPRouter :5060（开户、呼入 From/X-VOLTE 透传、呼出 R-URI=注册名+X-VOLTE）
        → VOS3000（IP 认证、无鉴权头）→ 话机 1002 / 100x
```

侧栏 **营业管理** 下三页，按向导顺序操作：

1. **配置向导** `/setup`：看拓扑、完成进度、当前注册
2. **运营商组**（向导第 1 步）：VOS IP 认证网关
3. **开户** `/onboarding`：手工 IMEI + SIM
4. **UFI 设备** `/ufi`：上电自动 get-url / sip-setting 开户
5. **话机** `/phones`：SIM 绑到 1002 DID

### 4.0 配置向导

路径：营业管理 → 配置向导（仪表盘卡片也可进）。

页面显示：SIP 地址（给 UFI app 填）、UFI 数量 / 在线数、SIM 别名、话机 DID、VOS 网关 IP，以及当前 `location` 注册。四张卡片按完成情况标出「下一步」。

### 4.1 dSIPRouter 开户

路径：营业管理 → 开户。

等价于：

```bash
ssh root@106.75.29.22 "python3 /root/dsip_add_ufi.py <IMEI> <SIM号>"
```

- `subscriber`：用户=IMEI、密码=MD5(IMEI) 前 16 位、domain=公网 IP
- `dbaliases`：SIM → IMEI（呼出被叫翻译）

列表先显示已开通账号。点 **添加** 开通单台；点 **导入** 上传/粘贴 CSV（`imei,sim`），幂等更新。完成后 **重载 Kamailio**。

### 4.1.1 UFI 自动注册（get-url / sip-setting）

路径：**营业管理 → UFI 设备**。

对接《UFI API 接口文档 v2.9》：设备上电先请求 **get-url** 拿 Base URL，再请求 **sip-setting** 拿 SIP 服务器并注册。

| 设备接口 | 本平台地址 |
|----------|------------|
| get-url | `https://106.75.29.22:5000/ufi-app/api/ufi/get-url-info`（别名 `/ufi-app/api/ufi/get-url`） |
| sip-setting | `https://106.75.29.22:5000/ufi-app/api/ufi/sip-setting` |
| 状态上报 | `https://106.75.29.22:5000/ufi-app/api/ufi/register-status-push`（每 10 秒整机状态） |
| WebSocket | `wss://106.75.29.22:5000/ufi-app/ufi/websocket?token=sha256(密钥+IMEI)&imei=IMEI` |

签名：请求 JSON 字段按 key 升序拼接 `k=v&...&secret_key=密钥`，再 SHA-256。默认密钥 `123456`，与文档示例一致，可在 UFI 设备页修改。`encryptionType` 不参与签名。时间戳 `ts` 允许 ±5 分钟。

`register-status-push` 写入整机状态（LTE/VoLTE/SIP/信号/CPU 内存等）。WebSocket 收心跳（10 秒 ping/pong）和状态日志，后台 **cmd** 可下发 reboot / restart_linphone / wifi_* / hotspot_* / wificall_* / `admin_http_proxy`；另支持 **`Ufi-Get-ESIM-Request`**（字段 `esimMessage`，如 `LPA:1$SM-DP+$MatchingID`）经控制台「下发 eSIM」写入设备。

`sip-setting` 在 **自动开户=开** 时写入 `subscriber`/`dbaliases`，返回 `isSet=Set`、`sipServerAddress`、`sipServerPort`、`sippassWord`（MD5(IMEI) 前 16 位）、`transportProtocol`。设备列表约 10 秒刷新。

#### 云端反向管理（设备管理台）

设备有外网后：`get-url-info` → 连接 `wsUrl` → 上报 `Ufi-Admin-Tunnel-Register`（本地 `adminHost/adminPort/adminPath`）。云端据此开放反向入口，**不把设备私网 IP 暴露给公网**。

| 能力 | 地址 / 说明 |
|------|-------------|
| 隧道状态 | `GET /api/v1/ufi/devices/<imei>/tunnel` |
| 反向代理入口 | `/api/v1/ufi/devices/<imei>/admin-proxy/`（**无需平台登录**，设备页自带密码；经 WS `cmd=admin_http_proxy` 访问 `127.0.0.1:adminPort`） |
| 控制台操作 | UFI 设备页 → **远程管理**（地球图标） |
| 无外网现场 | 设备 SoftAP：`http://192.168.43.1:8080`（云端 WS 断开） |

完成后请 **重载 Kamailio**。

### 4.2 话机 DID 绑定

路径：**营业管理 → 话机 → 编辑（如 1002）→ DID 列表**。

把 UFI 的 SIM 号追加进该话机 DID（逗号分隔，可几十上百个），例如：

```
15005902474,861717067605136,<新UFI的SIM号1>,<新UFI的SIM号2>,...
```

- 话机分机打外线：用该 DID 作主叫
- 呼叫 SIM 号：入站路由到所选运营商组（默认 VOS3000），由该话机振铃

操作：

1. 打开话机 1002（首次自动创建）
2. 在 DID 列表粘贴或勾选已开通 UFI 的 SIM
3. 点 **追加 SIM** 或 **更新**
4. **重载 Kamailio**

规模化：几百台 UFI 的 SIM 可集中绑到少数话机（每话机几百 DID），或按省/业务分桶。VOS 侧无需为每台 UFI 建网关。

---

## 5. 运营商组

上级：侧栏「运营商组」→ 列表。

子界面：点编辑进入 **认证 / 配置 / 终端**。

- **配置**：组名、负载均衡  
- **认证**：IP 或用户名密码（对接上游）  
- **终端**：点 **添加** 打开「编辑运营商详情 / 添加运营商详情」弹窗（IP、strip、prefix、权重）

组的 `description` 必须含 `type:8`（例如 `name:VOS3000 Carrier Group,type:8`），否则列表不显示，但话单里仍可能出现组名。

---

## 6. 终端组

上级：侧栏「终端组」或开户页链接。

列表点一行打开编辑弹窗（子界面）：

- Auth、Endpoints、Call Settings、Notifications、CDR、FusionPBX

开户页创建的组会出现在此列表，可继续补终端行或 FusionPBX 同步。

---

## 7. 域名

上级：侧栏「域名」。

用于 Hosted PBX：把 SIP 域名指到终端组，或配置 Microsoft Teams Direct Routing。  
Teams 行可点测试按钮进入 `domains/msteams/<id>` 连通性页（域名页的子界面）。

---

## 8. 入站路由

上级：侧栏「入站路由」或开户页。

把 DID（或前缀）映射到终端组。支持单条添加和 **Import DID**。

开户时填过 DID 的，会在本页看到对应规则。

---

## 9. 出站路由

上级：侧栏「出站路由」。

按被叫前缀选择运营商组。开户本身不创建出站规则；客户能打出网，依赖这里已有默认/匹配前缀。

---

## 10. 通话详单

上级：侧栏「通话详单」。

可筛 **全部通话 / 计费通话**，以及按终端组过滤。列含呼叫方向、原始主被叫、挂机原因等（依赖 Kamailio acc 增强字段）。

---

## 11. 号码 / 语音 AI

侧栏由动态模块注入：

- `/gui/numbers` 号码  
- `/gui/agents` 语音 AI 座席  

若侧栏没有对应项，说明该模块未加载，检查 `journalctl -u dsiprouter` 的 module load 日志。

---

## 12. 系统设置（上级菜单）

点 **系统设置** 展开子页：

| 子页 | 说明 |
|------|------|
| 全局设置 | GUI/SIP 相关全局参数 |
| 用户 | 仅 `dsip_admin` 可见 |
| 备份与恢复 | 备份、还原 |
| 证书 | TLS 证书 |
| Teleblock | 号码拦截对接 |
| TransNexus | TransNexus |
| STIR/SHAKEN | 签名配置 |
| 许可证管理 | 上游许可证（本云端已去掉功能门禁，页仍在） |
| 升级 | 在线升级 |

---

## 13. 推荐操作顺序（客户开户）

1. 确认运营商组 + 出站路由已能出网（平台级，通常已做好）。  
2. 打开 **开户**，创建客户终端组（IP 或账号密码），需要时填第一个 DID。  
3. **重载 Kamailio**。  
4. 需要托管域名或 Teams 时去 **域名**。  
5. 继续加号去 **入站路由** 或 **号码**。  
6. 用 **通话详单** 验证呼入/呼出。

---

## 14. 与运维手册的关系

进程重启、502、共享内存、日志见 [`云端运维手册.md`](云端运维手册.md)。  
本手册只覆盖登录后的 GUI 路径与开户上级界面。
