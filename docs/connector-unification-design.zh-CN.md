# 连接器架构统一设计 v3（OpenConnector 为唯一连接层）

> 状态：提案（待评审）
> 日期：2026-08-31
> 演进：v1 自建 OAuth 层 → v2 oo 单连接层 → **v3 定稿方向：以 oo 为唯一连接层，明确与现有架构的衔接缝**。
> 前置调研：包体积分析（800+MB dmg）、数据转换链路梳理、OpenConnector runtime 源码勘察、Nango 打包链路勘察。

---

## 1. 背景与问题

### 1.1 现状：两套 OAuth 运行时 × 两条数据链路

| | 链路 A：Nango 管线 | 链路 B：OpenConnector（oo CLI）管线 |
|---|---|---|
| 入口 | `ConnectorManager`（manager.ts，223 行） | `ConnectorSyncService`（service.ts，2808 行） |
| OAuth | Nango sidecar（fork submodule，自带 Postgres） | OpenConnector 运行时（自带 OAuth 含刷新） |
| 取数 | `NangoExecutor.proxy()` 透传 + token 注入 | spawn `oo connector run <svc> --action <act>` → stdout JSON |
| 转换 | `providers/gmail.ts`（11 行）、`outlook.ts`、executor 内联 markdown 化 | generic 确定性路径 或 LLM Agent（`agents/connector-sync/skills/*-sync`） |
| 落库/出口 | SQLite → `mailToMarkdown` → memorySink → **MemoryCore（记忆）** | records/documents → `filesService.importFile(.md)` → **知识库** |
| 触发条件 | 普通页面模式（`desktopPageMode !== 'connectors'`） | connectors 页面模式 |

### 1.2 问题清单

1. **包体积**：nango runtime ~810M（过滤后），800+MB dmg 的最大单项；
2. **冷启动**：首次拉起 Nango 装依赖 + 构建最长 10 分钟（`READY_TIMEOUT_MS = 600_000`）；
3. **安全面**：Nango 以 `FLAG_AUTH_ENABLED=false` 跑无鉴权 dashboard；
4. **维护成本**：nango fork submodule + 197 行踩坑打包脚本 + 441 行 supervisor；
5. **传输低效**：链路 B 每 action spawn 一个 `oo` 子进程（120s 超时 / 64MiB stdout 上限）；
6. **数据重复**：gmail/notion/gcal 双管线各自 OAuth、各自抓取、各自归一化；
7. **扩展性**：新增连接器在两套体系里都要适配，无法支撑「数十个核心连接器」目标。

---

## 2. 决策

### 2.1 业务标准（2026-08-31 确认）

1. 快速落地，性能/空间占用小；
2. 不重复造轮子——per-provider 的 API adapter 由上游维护；
3. 接受 SaaS 链路，OpenConnector 可部署到云端；
4. 实际支持**数十个**用户核心连接器，且维护方便。

### 2.2 三路对比与「谁维护什么」

| | OAuth/凭据 | per-provider API 调用 | 结论 |
|---|---|---|---|
| 自建 | 我们写 | **我们写** | 数十个 provider 下是无底洞，否决 |
| Nango | Nango（400+ 模板） | **仍是我们写**——Nango 是「授权 + 透传 proxy」模型，gmail history/notion 遍历全在 [nango-executor.ts](../apps/gateway/src/modules/connectors/nango-executor.ts) 里 | 只替你保管钥匙，不替你开车，否决 |
| **oo** | oo | **oo 维护**（900+ provider 的 action 目录） | **选定** |

**Nango 的 syncs / records / webhooks 为何不用**（评审必问，答案存档）：

- syncs 引擎：脚本仍是用户写的（adapter 责任不变）；游标模型是 `lastSyncDate` 近似，弱于现有 gmail `historyId`/outlook `deltaLink`/gcal `syncToken` 原生变更流；且与 gateway 已有的 lease/fence/CAS checkpoint/quarantine 体系重复。
- records：数据落进 Nango 的 Postgres = 第二数据库，与 gateway SQLite + 双 sink 冲突。
- webhooks：需要公网端点，桌面 NAT 后收不到，本地模式零价值。
- **打包证据**：[prepare-nango-runtime.mjs:45](../apps/desktop/scripts/prepare-nango-runtime.mjs) 注释——旧方案把 jobs/runner/persist 打进包后超 1GB，现有脚本只保留 server + connect-ui，这三个能力**根本不在发布的 runtime 里**。

**oo 的定位与存储选型**（源码勘察结论）：

- 无状态 action 执行器：管 OAuth、token 刷新、action 执行与幂等；**不做**定时同步、不存业务数据——同步引擎就是宿主（gateway）已有的那套，这个分工正好落在双方的最佳边界上。
- 存储：本地 `sqlite-runtime-store`（**`node:sqlite`，Node 22+ 内置，零原生依赖**——runtime 仅 98M 的根本原因）；云端 `d1-runtime-store`（Cloudflare D1）。同一 `runtime-store` 接口两个实现。
- HTTP API 完整：`server/api/runtime-api.ts`（providers/actions/connections，标准封套）；`oo` CLI 只是薄客户端，gateway 可去 spawn 直连。
- 云端化是官方场景：`server/cloudflare.ts` 部署模块 + admin token / runtime token / JWT 三模式鉴权。

### 2.3 分层职责：同步这件事谁写、写几次

| 层 | 内容 | 谁负责 | 写几次 |
|---|---|---|---|
| OAuth/凭据 | 授权流、刷新、密文存储 | oo | **0** |
| API 调用 | action 实现、分页、重试 | oo action 目录（900+） | **0** |
| 同步机制 | 调度、checkpoint、断点续传、quarantine、lease/fence | gateway `ConnectorSyncService` | **1**（已存在） |
| 落库 + 双 sink | markdown 化、MemoryCore、知识库 import | gateway | **1**（已存在） |
| **归一化映射** | action JSON → EverRoom 记录 schema | **我们** | **每 provider 一次**（很薄：现有 gmail.ts 11 行 / outlook.ts 2 行 / skill 30 行 markdown） |

### 2.4 三档接入阶梯（「数十个连接器维护方便」的答案）

| 档 | 形态 | 每 provider 成本 | 适用 |
|---|---|---|---|
| **L0 · Agent 探索** | oo action 自带 `inputSchema/outputSchema`，`connector_search`/`connector_schema` 工具已存在，同步 Agent 自行发现 action 并按领域 skill 的 schema 映射 | **零代码**（一份 skill 说明） | 长尾连接器当天接入 |
| **L1 · 声明式映射** | Agent 试出的映射固化为配置（action 序列 + 字段映射 + cursor 字段），通用引擎执行 | ~50 行配置 | 长尾转核心时固化（P2 后的增量优化） |
| **L2 · 确定性代码** | 现有 normalize 函数 | 50-150 行代码 | 五个主力 provider（高频 + 成本敏感） |

对比自建路线：每个 provider 从最贵的 L2 起步且下不来；本方案接入成本从 L0 起步、按使用量逐级固化。

---

## 3. 目标架构

```
┌────────────────────────────────────────────────────────────────────┐
│ OpenConnector 连接层（唯一）                                         │
│   云端 SaaS 实例（JWT / runtime token）      本地模式（隐私兜底可选）│
│   OAuth + 刷新 + 900+ provider action 目录 + connect UI + 密文存储  │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ HTTP 直连（runtime-api，进程内 fetch，无子进程）
┌──────────────────────────┴─────────────────────────────────────────┐
│ Gateway                                                             │
│                                                                    │
│  OpenConnectorHttpClient（新增，唯一传输缝）                          │
│     ├─ ConnectorManager（链路 A 编排器，保留）                        │
│     │    pull 适配器（5 provider，平移到 HTTP 之上）                  │
│     └─ ConnectorSyncService（链路 B 编排器，保留）                    │
│          generic 路径 / LLM Agent + skills / checkpoint / quarantine │
│                                                                    │
│  归一化（现有）→ Normalized* / CanonicalConnectorDocument            │
│     ├─ Sink 1: connector-memory → memorySink → MemoryCore（记忆）    │
│     └─ Sink 2: importFile(.md) + markdown-service → 知识库          │
└────────────────────────────────────────────────────────────────────┘
```

原则：

1. **一个连接层**：OAuth、凭据、adapter 全部收敛到 oo；Everroom 只维护归一化 + 游标 + 落库 + sink 的自家价值代码；
2. **一个传输缝**：gateway 与 oo 之间只经 `OpenConnectorHttpClient`（HTTP），消灭 CLI spawn / stdout JSON / 64MiB 上限；
3. **双 sink 不变**：记忆与知识库的分流发生在 sink 层，不在取数层；
4. **两个编排器暂不合并**：链路 A（scope/trigger/cursor）与链路 B（job/run/records）各自成熟，共享同一执行层与连接层；合并作为后续优化项，不阻塞本方案；
5. **确定性优先**：主力 provider 走 L2/L1，Agent（L0）只做长尾接入与复杂转换。

---

## 4. 与现有架构的衔接（本文档核心）

### 4.1 衔接总表：改什么、留什么、删什么

| 现有组件 | 处置 | 说明 |
|---|---|---|
| `ConnectorSyncService`（service.ts） | **保留，微改** | 调度/checkpoint/quarantine/sink 全不动；仅 `runConnectorAction` 的 spawn 换 HTTP（§4.2 Seam 2） |
| `ConnectorManager`（manager.ts） | **保留，平移** | scope/trigger/lease/memorySink 不动；pull 适配器从 `NangoExecutor.proxy` 平移到 HTTP action 调用（§4.2 Seam 1） |
| 归一化层（providers/、connector-memory、document-sync、skills） | **原样保留** | 与传输层解耦，零改动 |
| repository（SQLite） | **保留，改列** | `connector_connections.nango_config_key/nango_connection_id` → `service/connection_name`（§4.5） |
| `OpenConnectorSupervisor`（desktop） | **保留** | 本地模式生命周期管理不变；云端化后成为兜底（§4.6） |
| console 窗口 + ConnectorConsolePage | **保留，升级为唯一授权入口** | 替代 Nango connect session（§4.4） |
| `oo-cli-bridge`（renderer 开发者工具） | 保留（可选迁移） | P3 云端化时随 HTTP client 一并迁移 |
| `NangoExecutor` / `nango-authorization` / `nango-bootstrap` | **删除** | 职责由 oo + HttpClient 承接 |
| `NangoSupervisor`（441 行）+ `prepare-nango-runtime.mjs`（197 行）+ submodule | **删除** | -810M（§6 P2） |
| `createOpenConnectorPiTools`（Agent 直连工具） | **保留，换传输** | spawn → HTTP，工具语义不变（§4.2 Seam 3） |

### 4.2 五个衔接缝（Seam，逐一定义前后对照）

**Seam 1 · 取数传输（链路 A）**

```ts
// 现状：NangoExecutor.proxy(connId, configKey, url) —— 透传 provider 原生 REST
const list = await this.proxy(scope.nangoConnectionId, key,
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`);

// 目标：OpenConnectorHttpClient.runAction —— 调 oo 的 action 目录
const list = await this.oo.runAction("gmail", "fetch_emails",
  { pageToken: token, maxResults: 100, query: "-in:spam -in:trash" },
  { connectionName: scope.connectionName });
```

- `ConnectorExecutor` 接口、`PullPage`（changes/documents/continuation/terminalCursor）、游标 CAS 语义**不变**；
- 五个 provider 的 pull 循环结构不变，URL 拼接改 action 编排（依赖 P0 验证的 action 粒度）；
- `Retries: 3 / Retry-On: 408` 语义由 HttpClient 统一实现（原 Nango proxy 头携带）。

**Seam 2 · Job 执行（链路 B）**

```ts
// 现状：runConnectorAction spawn 子进程
const args = ["connector", "run", job.service, "--action", action, "--data", JSON.stringify(input)];
return connectorResultData(await this.runner(connector, args));

// 目标：同一方法签名，内部换 HTTP
private async runConnectorAction(job, action, input) {
  return this.oo.runAction(job.service, action, input,
    job.connectionName ? { connectionName: job.connectionName } : {});
}
```

`runOpenConnector`（spawn/超时/64MiB/脱敏，60 行）整体删除，超时与脱敏语义移入 HttpClient。

**Seam 3 · Agent 直连工具**：`createOpenConnectorPiTools`（connector_search/schema/run）内部从 spawn CLI 改为 HTTP，工具数量、schema、external-calls 审批链不变。

**Seam 4 · 授权流**：

```
现状：POST /v1/nango-connectors/authorizations → Nango connect session → 浏览器 OAuth
      → 轮询 GET :id → Nango /connections 按 tag 匹配 → manager.register

目标：POST /v1/connectors/connections → 返回 oo connect URL（runtime connect-app）
      → 桌面 console 窗口完成 OAuth（token 落 oo 密文存储）
      → 轮询 oo GET /api/connections?service=... → manager.register
```

`ConnectorAuthorizationAttempt` 契约不变（pending/connected/failed/expired + connection），renderer 轮询代码零改动；路由改名 + 旧路径保留一个版本别名。

**Seam 5 · 连接标识**：`connector_connections` 的 `(nango_config_key, nango_connection_id)` → `(service, connection_name)`——与链路 B 已有的 `credentialRef: open-connector:{service}:{connectionName}`（service.ts 现行格式）统一为 oo 的标识体系。

### 4.3 数据流（目标态）

```
① 建立连接   桌点「连接 Gmail」→ gateway → oo connect URL → console 窗口 OAuth
            → oo 存 token（密文）→ gateway 轮询发现 → connector_connections 落库
② 同步执行   编排器（A 的 trigger / B 的 job 调度）→ HttpClient.runAction
            → oo 执行 action（带 token 调 provider API）→ 返回 JSON
③ 归一化     provider 专属映射（L2 代码 / L1 配置 / L0 Agent）→ Normalized*/Canonical
④ 落库       A: repository.applyPage + 游标 CAS；B: records + quarantine 统计
⑤ 双 sink    记忆: mailToMarkdown → memorySink → MemoryCore（指纹去重）
            知识库: importFile(.md) → 知识库文件 + markdown-service 对账
```

### 4.4 桌面生命周期与页面分叉

- `main/index.ts` 的 `desktopPageMode === 'connectors'` 分叉消除：任意页面模式同一后端（oo 常驻 supervisor，不再按模式切换 Nango/OpenConnector）；
- `NangoSupervisor` 启动分支删除；OpenConnector supervisor 保持「页面用到才拉起、失败仅禁用工具不阻塞启动」的现有策略；
- cloud 模式（P3）：`NXCORE_CLI_CONNECTOR_URL` 指向云端，supervisor 检测 external URL 即不拉起本地进程（`NXCORE_CLI_CONNECTOR_MANAGED=false` 通道已存在）。

### 4.5 表结构变更

```sql
-- connector_connections：替换 Nango 标识
ALTER TABLE connector_connections RENAME COLUMN nango_config_key   TO service;         -- oo service
ALTER TABLE connector_connections RENAME COLUMN nango_connection_id TO connection_name; -- oo connectionName
-- 旧列在 P4 清理阶段 drop；迁移期兼容读
```

其余表（mail_messages、sync_scopes、sync_runs、connector_sync_jobs/runs、connector_documents）**零改动**。

### 4.6 配置项变更

| 现有 | 处置 |
|---|---|
| `NXCORE_NANGO_*`（URL/SECRET/POLL_MS/CONNECTOR_*_CLIENT_ID...） | **删除**（P2）；OAuth client 凭据迁移到 oo 侧 `oauth-client-config-service` |
| `NXCORE_CLI_CONNECTOR_URL / RUNTIME_TOKEN / CONFIG_DIR / DATA_DIR / CLI_PATH` | **保留**，成为唯一连接层配置；P3 后 URL 指云端 |
| `NXCORE_CLI_CONNECTOR_AGENT_MODE`（local/direct） | 保留；两模式都走 HTTP 后差异仅剩工具集选择 |

### 4.7 打包变更

| 项 | 处置 |
|---|---|
| extraResources `nango` 段 + `prepare-nango-runtime.mjs` + submodule | 删除（P2），**-810M** |
| extraResources `open-connector`（98M）/ `oo`（71M） | 保留；P3 云端化后转按需下载，**再 -169M** |
| `@oomol-lab/oo-cli` / `@oomol-lab/open-connector`（钉 commit tarball） | 保留 + **契约测试固化**（P0 产出夹具，升级 = 显式决策 + 测试通过） |

---

## 5. 分阶段实施

### Phase 0 · 覆盖验证 spike（1-2 人日，先行，是 P1 的门）

对五个主力 provider 核对 oo action 粒度是否支撑现有游标语义：

| provider | 需要 | 佐证 | 风险 |
|---|---|---|---|
| gmail | `fetch_emails` / `list_history`（historyId 增量） | gmail-sync skill 在用 | 低 |
| notion | `search` / `retrieve_page_markdown` | notion-sync skill 在用 | 低 |
| google-calendar | 事件列表 + syncToken | google-calendar-sync skill 在用 | 低 |
| google-docs | drive 列表 + export | 链路 A 现行语义 | 中：确认 action 存在 |
| outlook | **deltaLink 增量** | 无 outlook-sync skill | **高**：实测；不支持则 gateway 侧降级为全量 + 指纹 diff（repository 已有 fingerprint 去重） |

产出：action 清单 + 契约测试夹具（同时服务上游升级契约化）。

### Phase 1 · HttpClient + 双链路切换（4-5 人日）

1. 新增 `OpenConnectorHttpClient`（复用 `open-connector-client.ts` 的封套解析，扩展 action 执行端点；含超时/重试/脱敏/连接错误映射）；
2. Seam 2（runConnectorAction 换 HTTP）→ Seam 1（链路 A 五 provider pull 平移）→ Seam 3（Agent 直连工具换 HTTP）；
3. Seam 4 授权流切换 + 路由改名（旧路径别名）；
4. Seam 5 表结构迁移。

### Phase 2 · 删除 Nango（2 人日）

submodule、`prepare-nango-runtime.mjs`、`NangoSupervisor`、`nango-bootstrap/-authorization/-executor`、extraResources `nango` 段、`NXCORE_NANGO_*` config 族、`desktopPageMode` 后端分叉。**-810M。**

### Phase 3 · 云端 SaaS 部署（3 人日 + 运维，可与 P1/P2 并行）

1. 公司侧部署 oo（cloudflare 模块或容器），启用 runtime token / JWT；
2. OAuth client 凭据（google/microsoft/notion）配置到云端 `oauth-client-config-service`；
3. 桌面 `NXCORE_CLI_CONNECTOR_URL` 指向云端；本地模式保留为隐私兜底；
4. **多租户验证**：JWT per-user 连接隔离；不支持则过渡「云端单租户 + 本地兜底」，多租户作为上游共建项；
5. 云端模式下 `open-connector`/`oo` 转按需下载（**再 -169M**）。

### Phase 4 · 清理与验收（2 人日）

- 双编排器合并评估（ConnectorManager ↔ ConnectorSyncService，可选优化，不阻塞）；
- L1 声明式映射引擎评估（可选优化）；
- README 与 4 篇 connector 设计文档更新/归档；
- 打包验收（§7）。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| **云端数据面**：action 云端执行，内容/凭据经云 | 业务已接受 SaaS；本地模式兜底；UI 明示当前模式 |
| outlook delta 粒度不足 | P0 实测；降级全量 + 指纹 diff |
| 多租户隔离未知 | P3 验证；过渡单租户实例 / 本地模式；必要时与 oomol-lab 共建 |
| 上游依赖（tarball 钉 commit） | P0 契约测试固化；升级显式决策；最坏退化为「adapter 自维护」＝ Nango 模型，归一化/sink 资产仍在 |
| 云端可用性 | 本地模式一键回落（env 切换）；连接面板展示模式 |
| Agent 同步成本（L0） | 主力 provider L2/L1 固化，Agent 仅长尾 |
| 回滚 | P1/P2 期间保留 `NXCORE_CONNECTORS_LEGACY_NANGO` 开关一个版本，P4 删除 |

---

## 7. 工作量与验收

| 阶段 | 工作量 |
|---|---|
| P0 覆盖验证 | 1-2 人日 |
| P1 HttpClient + 双链路 | 4-5 人日 |
| P2 删 Nango | 2 人日 |
| P3 云端部署 | 3 人日 + 运维（可并行） |
| P4 清理验收 | 2 人日 |
| **合计** | **~12-14 人日** |

**验收标准**：

1. mac dmg：P2 后 ≤ 400M（当前 ~800M）；P3 云端模式后 ≤ 250M；
2. 无 `oo` 子进程 spawn（同步全程进程内 HTTP）；无 nango / embedded-postgres 进程；首启无 10 分钟等待；
3. E2E：gmail/notion/google-calendar（+docs/outlook 视 P0 结果）授权 → 同步 → 记忆与知识库双 sink 各自可查；增量游标续跑、断点续传、410 全量重建正常；
4. 新连接器接入演示：L0 零代码（Agent 探索）完成一个长尾 provider 的同步；
5. 云端/本地两种模式可切换，连接状态面板可见。

---

## 8. 历史版本存档

- **v1（自建 OAuth 层 + 统一执行器）**：否决。为 5 个 provider 自持是边界清晰的工程，数十个 provider 是无底洞，与标准 2/4 冲突。
- **v2（oo 单连接层，初版）**：方向正确，本版在其上补齐三路对比、Nango 三能力分析、oo 存储选型、分层职责、三档阶梯与衔接缝定义。
- 完整演进过程见 git 历史。
