# 数据库引擎选型决策书：保持现状 / MySQL 8.0 / Apache Doris

> 背景：短信与通话记录存储方案（`docs/ufi_sms_call_storage_opt.md` v4.2，25 人日）全程按 **MySQL 5.7** 假设设计。提出"可考虑升级 8.0 或 Doris"后，本文先做**环境事实核查**，再给三方案取舍与最终结论。
> 核查方式：SSH 实测现网 + 仓库源码扫描 + 官方文档核对。所有结论标注证据来源。

---

## 一、结论（先看这个）

| # | 结论 | 一句话理由 |
|---|---|---|
| **1** | **v4.2 的"MySQL 5.7 五条约束"是错的前提** | 现网实测 `MariaDB 10.6.23`，5.7 只存在于 `docker-compose.yml` 测试栈。E3/E4/E5 三条在现网**根本不成立** |
| **2** | **MySQL 8.0 → 否决** | 相对 MariaDB 10.6 的**净增量≈0**（窗口函数/CTE/instant DDL/JSON_TABLE 10.6 全有），却要付跨厂商迁移成本，且有 2 处脚本会**原地报错** |
| **3** | **Doris → 暂不引入，设闸门** | Doris 是 OLAP 旁路，官方明确不支持跨表事务 → **不可能替代 MySQL 做业务主库**；当前查询模式（租户内窄范围过滤）正是 InnoDB 索引强项，不是 Doris 场景 |
| **4** | **推荐：保持 MariaDB 10.6 不动，25 人日方案照 v4.2 执行** | v4.2 §7.9 已设计为"分支不敏感"，代码与 DDL **一行不用改** → 换引擎不改变施工 |
| **5** | **唯一值得考虑的升级是 MariaDB 10.6 → 11.4 LTS** | 同厂商、Galera 保留、online DDL 默认 → 正打 T6a 分区重建的痛点，成本约 1 人日 |

**净工期影响：0 人日（保持现状）／+1 人日（升 11.4）／+5~8 人日（上 8.0，且收益为 0）。**

---

## 二、事实核查：前提被推翻

### 2.1 现网到底是什么（实测）

```
root@106.75.29.22 $ dpkg -l | grep mariadb-server
mariadb-server                1:10.6.23-0ubuntu0.22.04.1
mariadb-server-10.6           1:10.6.23-0ubuntu0.22.04.1
mariadb-server-core-10.6      1:10.6.23-0ubuntu0.22.04.1
```

| 部署路径 | 实际引擎 | 证据 |
|---|---|---|
| **生产（106.75.29.22）** | **MariaDB 10.6.23** | Ubuntu 22.04 源 `mariadb-server`，SSH 实测 |
| 裸机安装脚本 | MariaDB（随发行版） | `mysql/debian/*.sh`：`apt-get install default-mysql-server mariadb-server` |
| HA 集群 | MariaDB Galera | `HA/mysql/installAAGaleraReplication.sh:7` "uses mariadb" |
| Docker 测试栈 | **MySQL 5.7** | `docker-compose.yml:28` |
| Python 驱动 | `libmariadb-dev` → MySQLdb | `dsiprouter/debian/12.sh:21` 等 |

**结论：`docker-compose.yml` 里那行 5.7 被当成了"主路径"，实际它只是 CI/本地测试栈。** v4.2 §7.9 虽然写了"MariaDB 分支"，但把 5.7 标成主路径（第 723 行），这个标注是错的。

### 2.2 E1~E5 逐条重判（对 MariaDB 10.6）

| # | v4.2 原判（MySQL 5.7） | **MariaDB 10.6 实况** | 判定 |
|---|---|---|---|
| **E1** | 分区表唯一键须含分区列 | 同左（MariaDB 一样限制） | ✅ **仍成立** |
| **E2** | `ALTER ... PARTITION BY` 只能 COPY 重建 | 同左；但 `ADD/DROP PARTITION` 是 NOCOPY | ✅ **仍成立**（但 ADD/DROP 已免锁） |
| **E3** | 自增计数器不持久化 → id 复用越权 | **10.2.4 起持久化** | ❌ **不成立** |
| **E4** | 无 CTE、无窗口函数 | **10.2+ 有窗口函数/CTE，10.6 有 `JSON_TABLE`** | ❌ **不成立** |
| **E5** | 无 invisible index、无 instant ADD COLUMN | **10.3+ 表尾 `ALGORITHM=INSTANT` 加列；10.6 有 `IGNORED` 索引** | ❌ **基本不成立** |

**5 条里 3 条消失了。** 但注意——**这并不让方案变简单**，见下节。

### 2.3 为什么 3 条约束消失却省不下工期

| 原为绕开 | 实际处理 | 能否简化 |
|---|---|---|
| E3（id 复用） | 软删客户（`enabled=0, deleted_at`）**仍要做** | ❌ 否。软删的理由从"防 id 复用来越权"变成"保留归属可查 + 禁止误删"，实现量不变 |
| E4（无窗口函数） | rollup 仍走**应用层分组** | ❌ 否。`is_start` 优先 + 孤儿并入 + 600s idle 的边界规则用 SQL 表达极难维护；且 rollup 是批处理，性能不是瓶颈 |
| E5（无 instant DDL） | 灰度仍走**代码 feature flag** | ❌ 否。`IGNORED` 索引只能灰度"索引生效"，不能灰度"写路径切换" |

**真正的工期大头是 E1（分区改主键）+ E2（分区必须趁小做），这两条在所有 MySQL/MariaDB 版本上都成立。** 换引擎动不了它们。

> v4.2 §7.9 已做过这个推演并得出"两分支只差一条论证、代码与 DDL 完全一致"——这个结论**是对的**，只是把主路径标反了。所以**修文档标注即可，方案本身不用改**。

---

## 三、方案对比

### 3.1 全量矩阵

| 维度 | **A. 保持 MariaDB 10.6** | **B. MySQL 8.0** | **C. Doris 旁路** | **D. MariaDB 11.4 LTS** |
|---|---|---|---|---|
| 性质 | 现状 | **跨厂商迁移** | 新增 OLAP 组件 | 同厂商跨大版本 |
| 相对 10.6 的净增量 | — | 降序索引、Hash Join、8.0.29+ 任意位置 instant 加列 | 列存压缩、MPP 聚合、冷热分层 | **online DDL 默认**、新代价模型、降序索引、`DATE(col)` sargable |
| 对本方案的收益 | — | **≈0** | 解决"跨租户全量聚合"，但当前无此需求 | T6a 分区重建不再是长窗口；分区表选路更准 |
| 能否替代业务主库 | ✓（现状） | ✓ | ❌ **官方不支持跨表事务** | ✓ |
| 迁移成本 | 0 | **5~8 人日** + 高风险 | **15~25 人日** + 6 节点常驻 | **1 人日** + 一次维护窗口 |
| 硬阻塞点 | — | 2 处 SQL 语法原地报错（§3.3） | GUI 全部 CRUD 无事务保障 | 官方 repo + `mariadb-upgrade` |
| 结论 | ✅ **采纳** | ❌ 否决 | ⏸ 设闸门 | 🔶 可选加固 |

### 3.2 MySQL 8.0：净增量实测为零

| 能力 | MariaDB 10.6 | MySQL 8.0 | 对 v4.2 的价值 |
|---|---|---|---|
| 窗口函数 / CTE | ✅ 10.2+ | ✅ | 0（方案已选应用层分组） |
| `JSON_TABLE` | ✅ 10.6 | ✅ | 0 |
| `INSTANT` 加列 | ✅ 表尾（10.3+） | ✅ 表尾，8.0.29+ 任意位置 | 低（本方案只在表尾加列） |
| 功能性索引 | ✅ 等价（生成列 + 索引） | ✅ | 0 |
| 隐藏/忽略索引 | ✅ `IGNORED`（10.6） | ✅ `INVISIBLE` | 0 |
| 真降序索引 | ❌（10.8+ 才支持） | ✅ | 低（已有 id 快照游标） |
| Hash Join | ❌（11.x） | ✅ | 低（列表查询是索引点查，非大表 JOIN） |
| `ALTER ... PARTITION BY` 免锁 | ❌ | ❌ | 0（**8.0 同样要 COPY 重建**） |

**八个能力项里，六个打平、两个价值低，且 E1/E2 这两个真正卡工期的约束在 8.0 下毫无改善。**

### 3.3 MySQL 8.0 的确定失败点（源码实测，不是推测）

| # | 位置 | 问题 | 后果 |
|---|---|---|---|
| **B1** | `testing/sql/v0.60+ent/grants.sql:1-3` | `GRANT USAGE ON *.* TO ... IDENTIFIED BY PASSWORD '...'` — 该语法 + `PASSWORD()` 函数在 **8.0.11 已移除** | docker 栈挂载 `./testing/sql/v0.60+ent` 作 initdb → **初始化直接失败，容器起不来** |
| **B2** | `dsiprouter.sh:2116` | `GRANT ALL ON *.* TO '...'@'localhost' IDENTIFIED BY '...'` — 同为已移除语法（MariaDB 专属） | 安装脚本建 debian-sys-maint 账号失败 |
| **B3** | `dsiprouter.sh:2761` | 用 `SELECT PASSWORD('')` 探测引擎类型 | 8.0 下函数不存在 → 恰好被判为 `mysql`，**结果对但机制是巧合**；换引擎后必须改 `SELECT @@version` 解析 |
| **B4** | `kamailio/defaults/*.sql` | 存量表 `DEFAULT CHARSET=utf8`（utf8mb3）；8.0 新建表默认 `utf8mb4_0900_ai_ci` | **新建 summary / archive 表与旧表 JOIN `imei` → ERROR 1267 Illegal mix of collations**。T5b/T6 恰好要新建这两类表 |
| **B5** | 全库 | `utf8` 在 8.0 已弃用 | 全量建表告警噪声 |
| **B6** | `HA/mysql/installAAGaleraReplication.sh` | Galera 在 MySQL 8.0 无对应实现 | HA 路径需整体改 InnoDB Cluster / PXC，脚本重写 |

> B4 是最阴的一条：不报错在启动，只在**跨表 JOIN 的查询期**才爆，且只在"新表老表混用"时爆。

### 3.4 Doris：定位判断

**硬否决理由（官方文档原文）**：

> "Multi-statement transactions that contain queries or DDL are **not supported**." … "Doris does **not currently support nested transactions**." … 显式事务内仅支持 `[INSERT, UPDATE, DELETE]`，隔离级别**仅 READ COMMITTED**。
> —— Apache Doris 官方 *Transactions* 文档

GUI 需要多表事务的路径是明确的：设备交付/认领（`dsip_ufi_import` + `claim_status` + provision）、租户软删、ACL 角色授权、`ON DUPLICATE KEY UPDATE` 的 summary rollup。**这些一条都进不了 Doris。**

**数据量测算（按 v4.2 已确认的口径）**：

| 项 | 数值 | 说明 |
|---|---|---|
| 单设备日行数 | ≤300 | 用户已确认 |
| 设备数 | 1,000 | 基准 |
| 日增行数 | 30 万 | 1000 × 300 |
| 年增行数 | **1.1 亿** | 30万 × 365 |
| 年增原始体积 | **≈504 GB** | v4.2 实算 42 GB/月 |
| 热表 3 个月 | ≈126 GB | 已定保留策略 |
| Doris 三年压缩后 | ≈150~250 GB | 列存 + zstd，payload JSON 压 5~8x |

**1.1 亿行/年这个量级，InnoDB 分区表加对索引绰绰有余。** Doris 的收益在"省盘 + 跨租户全量聚合"，而当前查询模式是**租户内按 `customer_id` + `imei` + 时间窗的窄范围过滤**——这是复合索引的强项，恰好是 Doris 最不擅长的（点查/单行更新）。

**引入成本**：生产高可用最小 3 FE + 3 BE = **6 节点常驻**；数据管道需 Flink CDC 或 Routine Load + Kafka（Doris 无法直接承接 GUI 的双写）；双写一致性、延迟可见性、运维值班全要新建。

> **一句话**：Doris 解决的痛点，在当前业务里不存在。

**备选更优解**：若未来只是要"便宜存 3 年 + 做经营看板"，**ClickHouse 单机**比 Doris 划算得多——单节点、可用 `MySQL` 表引擎直接读 MySQL 做增量同步，不需要 CDC/Kafka 管道。记作 P4 备选。

### 3.5 若一定要"升级"：MariaDB 11.4 LTS

这是唯一有真实收益的选项（官方文档核对）：

| 收益 | 对应 v4.2 痛点 |
|---|---|
| **`ALTER TABLE` 默认 online**（`ALGORITHM=COPY, LOCK=NONE`，11.2 引入、11.4 默认） | **T6a 分区重建不再需要长维护窗口** ← 最大痛点 |
| 新代价模型（纯 cost-based，考虑 SSD 特性） | 分区表 + 二级索引选路更准，直接改善列表分页 P95 |
| 降序索引可用于 `MIN()/MAX()` | 列表首末页取数 |
| `DATE(col)` / `YEAR(col)` 变 sargable | 可省 `window_day` 生成列的一部分用途 |
| JSON 函数增强（`JSON_TABLE` 带 key、`JSON_SCHEMA_VALID`） | payload 审计查询 |
| LTS 到 2029-05 | 与 10.6（EOL 2026-07）相比安全窗口更长 |

**注意**：`ALTER ... PARTITION BY` 这类重组是否也享受 online，需实测确认，**列为 T6a 前置验证项**，不要照文档假设。

---

## 四、最终决策与执行项

### 4.1 决策

```
保持 MariaDB 10.6  ──►  v4.2 方案照原样执行（25 人日，工期不变）
      │
      ├─ P0 立即：修正 v4.2 的版本前提标注（0 人日）
      ├─ P2 可选：T6a 维护窗口批不下来时 → 升 11.4 LTS（+1 人日）
      └─ P3 否决 MySQL 8.0（+5~8 人日 / 收益 0 / 2 处脚本报错）
      
Doris  ──►  不引入，设触发闸门（见 4.3）
```

### 4.2 待办

| 优先级 | 任务 | 工时 | 说明 |
|---|---|---|---|
| **P0** | 修正 `ufi_sms_call_storage_opt.md` §7.0 / §7.9 版本标注 | 0 | E1~E5 改为 MariaDB 10.6 基线；主路径改 MariaDB |
| **P0** | 把 `SELECT PASSWORD('')` 换成 `SELECT @@version` 解析 | 0.2 | B3，现在改成本最低；顺便支持 8.0/11.4 探测 |
| **P1** | 按 v4.2 §十 施工 | 25 | **不变** |
| **P2** | T6a 前置：实测 `ALTER ... PARTITION BY` 在 11.4 下是否 online | 0.2 | 决定要不要升 11.4 |
| **P3** | 若升 11.4：官方 repo + `mariadb-upgrade` + Galera 滚动 | 1 | 含回滚方案 |
| **—** | 修 `grants.sql` / `dsiprouter.sh:2116` 的 `GRANT...IDENTIFIED BY` | 0.3 | 现在不阻塞；**只有决定上 8.0 才是前置**。顺手改成 `CREATE USER` + `GRANT` 更规范 |

### 4.3 Doris 触发闸门（任一满足才启动评估）

| 闸门 | 阈值 | 为什么是这个数 |
|---|---|---|
| G-D1 | 出现**跨租户/全域多维聚合**需求（经营看板、日周月环比下钻），且该查询 P95 > 3s、索引优化空间已用尽 | 这才是 Doris 的场景 |
| G-D2 | 单表 > **10 亿行** | InnoDB 分区表在 1 亿~3 亿行仍稳；10 亿是分水岭 |
| G-D3 | 留存要求 > 5 年 **且** 热表磁盘 > **1 TB** | 压缩收益才盖过 6 节点成本 |
| G-D4 | 租户数 > **50** | 分区/索引数量爆炸，行存维护成本反超 |

**当前四项全不满足** → 维持决定。

---

## 五、附：如果哪天真要迁 Doris，现在该埋什么

不改方案，只保证"迁的时候是接管道不是重写"——三条零成本约束，建议写进编码规范：

| # | 约束 | 作用 |
|---|---|---|
| 1 | 所有记录表保留**原始 `payload` JSON** | 已在 v4.2 决 4 中确认保留，Doris 侧可直接重建列 |
| 2 | 分区键用**物理列** `created_at`（不用表达式） | Doris 分区/分桶与 MySQL 语义一致，映射无损 |
| 3 | 写入路径**只追加不原地改**（summary 除外） | Doris 的 Unique Key 只擅长追加，改成 merge-on-write 成本最低 |

---

## 六、给 v4.2 的一行修正

> **E1~E5 的基线应为 MariaDB 10.6（现网实测），而非 MySQL 5.7。** 其中 E3/E4/E5 不成立，但对应的设计决策（软删、应用层 rollup、代码 flag）**保持不变**，理由已从"版本能力不足"改为"实现可维护性"。E1/E2 成立，T6a 仍须趁数据量小的时候做。
