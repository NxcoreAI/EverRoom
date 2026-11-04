# 连接器改造实施方案：从同步管道到 Agent 即席检索

> 状态：已实施（2026-10-28）
> 实施结果：同步链路与本地存储已删除；MCP 中转、Query 层、Agent 上下文、桌面连接页、数据迁移均已完成；查询档案覆盖 Gmail / Notion / Google Drive / Google Calendar / Outlook / Slack；飞书暂不支持模糊查询。
> 日期：2026-10-28
> 关联图：[架构与 token 边界](./assets/connector-mcp-architecture.png)、[MCP 查询时序](./assets/connector-mcp-sequence.png)
> 一句话：删掉连接器的同步与存储职责，只保留「连接生命周期 + Agent 即席查询」。

---

## 1. 目标与非目标

### 1.1 目标

1. **删除同步链**：scope / run / cursor / lease、`sync-providers`、域投影、document store、format mapping、每 5 分钟轮询、首同步、断点续传。
2. **Agent 通过 MCP 使用 oo**：oo 提供 catalog / action 工具，Gateway 做 MCP 中转，并补 `connector_query` / `connector_read` 两个本地工具。
3. **支持模糊概念查询**：Agent 扩词 → 多源并发检索 → 统一命中 + coverage → 读关键原文 → 回答/落文档。
4. **连接生命周期不变**：SaaS/本地授权、oo 会话热推、断开与墓碑、账号切换。
5. **本地零内容副本**：迁移后没有 `connector_*` 数据表、没有 `connectors.sqlite`、没有连接器定时任务。

### 1.2 非目标

- 不建本地/云端语义索引，不支持离线查询。
- v1 不做写操作（发邮件、改文档）；`execute_action` 只放行只读动作。
- 不改 oo 运行时与 SaaS 服务端，只消费其现有接口。
- 不保留旧同步数据只读视图。

### 1.3 验收摘要

- 连接 Gmail 后立刻问「上次和财务聊预算的邮件」，Agent 一轮内拿到结果并引用来源。
- 查询返回 `hits + coverage`；超时、无查询档案、无连接、无权限可区分。
- 进程空闲时没有连接器定时任务和网络请求；DB 里没有连接器内容表。
- Agent 的输入、工具结果、日志里都不出现 `oct_` 与 provider token。

### 1.4 实施结果（2026-10-28）

- **已删除**：同步编排、sync-providers、域投影、document store、格式映射 agent、connectors.sqlite、10+ 张 `connector_*` 表、同步 IPC/路由/配置。
- **已新增**：ConnectorMcpServer（loopback + token-in-path）、ConnectorMcpHost（oo 5 工具转发 + 只读守卫）、ConnectorQueryService、Gmail/Notion 查询档案、HTTP runtime、墓碑过滤、连接目录、run 前 `<connectors>` 上下文。
- **已接入**：Agent 用户档 runtime 自动挂载 MCP；桌面连接器页改为真实连接/断开/轮询；旧同步端点统一 410。
- **已迁移**：`0088_connector_agent_query` 新增 `connector_tombstones`、删除同步表。
- **尚余（P4）**：飞书查询后端、写操作审批、URL 直接读取、文档归档与演示脚本。

---

## 2. 目标架构

```
Agent(pi)
  │ MCP JSON-RPC（loopback + token-in-path）
  ▼
Gateway
  ├─ ConnectorMcpServer：oo 5 个工具转发 + connector_query/read
  ├─ Query 层：查询档案 / 扇出 / 合并 / coverage / ref
  ├─ 会话：内存持有 oct_
  └─ external-calls：配额 / 审计
        │ HTTPS + Bearer oct_
        ▼
oo / OpenConnector（用户租户）
  ├─ /mcp、/v1/actions、/v1/apps
  └─ provider OAuth token（不出 oo）
        ▼
Gmail / Notion / Drive / Slack / …
```

| 组件 | 负责 | 明确不做 |
|---|---|---|
| Agent runtime（pi） | 决定查什么、调用工具、读结果、回答 | 不持 `oct_`、不持 provider token、不直连 oo |
| 本地 Gateway | MCP 中转、查询层、预算/审计、会话管理 | 不存连接器内容、不做定时同步 |
| EverRoom SaaS | 登录、代发 `oct_`、代发起 OAuth | 不在查询链路上、不转发数据 |
| oo | 凭据保管、action 执行、MCP 服务端 | 不做跨源概念检索、不做业务编排 |
| Provider | 数据与权限 | — |

详细连线与 token 归属见架构图。

---

## 3. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | MCP 由 Gateway 中转，不直连 oo | `oct_` 留在 Gateway 内存；预算/审计/只读守卫集中一处；本地/SaaS 同一套接法 |
| D2 | oo 的 5 个工具透传，本地补 `connector_query/read` | catalog 与 action 执行不重复造；查询语义是 oo 不提供的产品价值 |
| D3 | 连接目录以 oo 为准，Gateway 只存墓碑 | 不再有本地连接/scope/游标表；断开用墓碑防止对账复活 |
| D4 | 用「查询档案」替代「同步 provider」 | 每个 provider 只需描述“怎么搜、结果怎么映射、详情怎么读”，不写拉取/游标/落库 |
| D5 | 模糊查询 = Agent 扩词 + provider 原生检索 + 摘要重排 | 不建索引、不做 embedding；低成本、可解释；能力边界用 coverage 如实暴露 |
| D6 | v1 只读 | `execute_action` 加只读动作守卫；写操作与人工确认放后续阶段 |
| D7 | 文件转换能力搬出连接器包 | `converters / legacy-office / email-content / pdf-convert` 服务文档理解与导入，不属于连接器 |
| D8 | 文档导入面板保留 | 飞书/Notion 导入是用户显式动作，与“Agent 即席查询”是两条独立通道 |

---

## 4. 目标接口

### 4.1 Agent 工具面

MCP 上共 7 个工具：oo 透传 5 个 + 本地 2 个。

| 工具 | 来源 | 输入 | 输出 | 说明 |
|---|---|---|---|---|
| `list_apps` | oo | `{query?}` | 可用 provider / 连接数 | 透传 |
| `list_connections` | oo | `{service?}` | 连接清单与账号信息 | 透传 |
| `search_actions` | oo | `{query?, service?, limit?}` | action 列表 | 透传 |
| `get_action_guide` | oo | `{actionId, connectionName?}` | action 说明 + schema | 透传 |
| `execute_action` | oo | `{actionId, input, connectionName?}` | 执行结果 | 守卫：只读动作放行，写动作返回 `mutation_not_allowed` |
| `connector_query` | 本地 | `{concept, terms?, services?, since?, until?, limit?}` | `{hits, coverage}` | 模糊概念检索主入口 |
| `connector_read` | 本地 | `{ref, offset?}` | 正文 + 元数据 + 分页 | 读命中详情 |

约束：

- `connector_query/read` 只读，不执行写 action。
- `execute_action` 的 `connectionName` 省略时，由中转层解析：唯一连接自动选中，多连接报错并列出可选值，无连接报错。
- 所有 MCP 调用经 pi 的 `executeMcpCall` 钩子进入 `external-calls`，服务名映射为 `CONNECTOR`。

### 4.2 MCP 中转（ConnectorMcpServer）

- **形态**：独立 loopback HTTP listener（`127.0.0.1:0`），启动后把实际地址注入 agent runtime；不复用 Fastify 端口，避免 `--port 0` 的启动时序问题。
- **复用**：沿用 `ChannelMcpHost` / `ExchangeTransport` 的 token-in-path 与单请求 JSON-RPC 交换模式，不新造传输。
- **不写 `.mcp.json`**：URL 与 token 是进程内动态值，直接合进 runtime 的 `pi.mcp.mcpServers`；不落盘、不进模型上下文。
- **协议**：MCP Streamable HTTP；处理 `initialize`、`tools/list`、`tools/call`、`ping`。
- **tools/list**：转发 oo `/mcp` 的列表，追加 `connector_query/read`，过滤/标注只读。
- **tools/call**：
  - 本地工具 → Query 层。
  - `execute_action` → 只读守卫 + connectionName 解析 → 转发 oo。
  - 其他 oo 工具 → 原样转发（带 `Authorization: Bearer oct_`）。
- **无会话时**：仍暴露本地工具，返回 `connector_not_connected` 的可恢复错误；oo 工具列表可返回空并提示登录。
- **超时/错误**：统一映射为 MCP tool error，附恢复指令（重试 / 先 guide / 检查连接）。
- **注入**：`createUserFacingRuntime` 把该 server 合并进 `pi.mcp.mcpServers`（只对用户档 main/main-direct/main-lite；内部 runtime 不挂）。
- **批量与上限**：请求体大小、并发、单次超时与 oo 客户端一致；不做持久化。

### 4.3 Query 层

#### 类型

```ts
type HitKind = "mail" | "document" | "event" | "message" | "record";

interface Hit {
  ref: string;                 // 不透明引用，见下
  service: string;
  connection: string;
  kind: HitKind;
  title: string;
  snippet: string;
  time: string | null;
  url?: string;
}

interface Coverage {
  searched: Array<{ service: string; connection: string; action: string }>;
  skipped: Array<{ service: string; reason: "no_profile" | "no_connection" | "unsupported" }>;
  failed: Array<{ service: string; message: string }>;
  partial: boolean;            // 有超时/失败但仍有结果
}

interface QueryResult {
  query: string;
  hits: Hit[];
  coverage: Coverage;
  truncated: boolean;
}
```

`ref` 用 base64url 编码 `{v:1, s: service, c: connection, k: kind, id}`，无服务端状态：

- 进程重启后仍可读；
- 伪造 ref 只能读到该 token 本来就有权限的数据；
- 读详情时由查询档案把 `{k, id}` 映射回 detail action + input。

#### 查询档案（QueryProfile）

```ts
interface QueryProfile {
  service: string;
  dataTypes: HitKind[];
  /** 把概念 + 条件翻译成 1–2 个搜索 action 调用。 */
  buildQueries(ctx: {
    concept: string;
    terms: string[];
    limit: number;
    since?: string;
    until?: string;
  }): Array<{ action: string; input: Record<string, unknown> }>;
  /** 从 action 原始结果提取统一命中。 */
  parseHits(data: unknown): Array<Omit<Hit, "ref" | "service" | "connection">>;
  /** 命中 → 详情 action；返回 null 表示只支持摘要。 */
  buildRead(ref: { kind: HitKind; id: string }): { action: string; input: Record<string, unknown> } | null;
  /** 可选：详情结果转 Markdown。 */
  renderRead?(data: unknown): { markdown: string; title?: string; url?: string } | null;
}
```

首批档案：`gmail / notion / google-drive / google-calendar / outlook / slack`；飞书先标 `unsupported`（oo action 缺文档搜索），后续可接 lark-cli 后端。

#### 执行流程

1. 归一化输入：`services`、`since/until`、`limit`（默认 20，上限 50）。
2. `list_apps`（30s 缓存）解析连接；无连接的服务进 `skipped.no_connection`。
3. 选档案；无档案进 `skipped.no_profile`。
4. 每个服务最多 2 个查询；并发 `Promise.allSettled`，单请求 8s、总预算 12s。
5. 解析命中 → 去重（service + kind + id）→ 时间倒序 → 截断。
6. 组装 coverage；部分失败不吞掉，`partial=true`。
7. 返回结果，附 `next` 提示（用 `connector_read` 读详情）。

#### 读详情

1. 解码 `ref` → 选档案 → `buildRead`。
2. 用 ref 里的 connection 调 action。
3. `renderRead` 转 Markdown（邮件保留头部与正文；页面转 Markdown）；截断 40k 字符，返回分页信息。
4. 档案不支持详情时，返回 `detail_unsupported` 并建议改用 `execute_action`。

### 4.4 运行期上下文注入

每个 run 开始时，Gateway 生成一小段 `<connectors>` 摘要注入 prompt：

```
已连接：Gmail（2 个账号，支持模糊查）、Notion（支持模糊查）、飞书（仅按链接读取）
查询外部资料时优先用 connector_query；没有结果时看 coverage 再决定是否换词/换源。
```

- 来源：`list_apps` + 档案能力，缓存 30s。
- 未登录/无连接时不注入，避免噪音。
- 不注入全量 action 目录。

---

## 5. 代码改动清单

### 5.1 删除

| 路径/模块 | 原因 |
|---|---|
| `gateway-module/manager.ts` | 同步编排（scope/run/lease/触发） |
| `gateway-module/sync-engine.ts` | nango/direct 双引擎拉取 |
| `gateway-module/open-connector-sync-executor.ts` | REST URL → action 的同步映射 |
| `gateway-module/sync-providers/**` | 拉取适配器 |
| `gateway-module/repository.ts` | connectors.sqlite 同步表 |
| `gateway-module/document-store.ts` | 同步文档落盘 |
| `gateway-module/domain-projection.ts`、`domain-schema.ts` | `connector_*` 域表投影 |
| `gateway-module/format-mapper-port.ts`、宿主 `format-mapping-service.ts` | 全量记录归一化 |
| `gateway-module/connector-markdown.ts`、`ics.ts` | 只服务同步链路 |
| `apps/gateway/src/infrastructure/connectors/client.ts` | connectors.sqlite DDL |
| `apps/gateway/src/modules/connectors/connection-purge.ts` | 改为墓碑语义 |
| `gateway-module/index.ts` 中同步相关导出 | 含已失效的 `projectDomainRecords` |
| `agents/connector-mapper/**` | 格式映射 agent |
| 桌面同步 IPC：`triggerSync`、`cancelRun`、`scopes`、`runs`、`mail`、`failures`、`documents`、`readDocument`、`records`、`recordTotals`、`armFault`、`runtimeStatus` | 同步数据面 |
| 路由：`/scopes`、`/scopes/:id/sync`、`/runs`、`/runs/:id/cancel`、`/connections/:id/messages`、`/records`、`/documents`、`/failures`、`/status` 的同步字段 | 旧数据面，升级后返回 410 |
| 配置：`nangoConnector`、`NXCORE_CONNECTOR_POLL_MS`、`SYNC_PROVIDERS` 引用 | 定时与 provider 注册表 |
| 文档：旧的 connector-unification / platform / markdown-sync 中仍描述同步的章节 | 归档或标注历史 |

### 5.2 保留 / 搬家

| 项目 | 处理 |
|---|---|
| `open-connector-http-client.ts` | 保留（唯一传输缝） |
| `open-connector-authorization.ts` | 重写：只返回 connection，不建 scope/不触发同步 |
| `converters.ts`、`legacy-office.ts`、`email-content.ts`、`pdf-convert.ts` | 搬到文档域（`document-understanding` 或新 `document-converters`），不随连接器删除 |
| 文档导入（`documents/import/oo-runner.ts`、lark-cli、ntn） | 保留，不写连接器表 |
| `session-routes.ts`（`PUT/DELETE /v1/connector-session`） | 保留 |
| external-calls | 保留，新增 CONNECTOR 服务映射与查询上限 |
| 桌面连接/授权/断开/账号切换 | 保留，去掉同步相关状态 |

### 5.3 新增

| 模块 | 职责 |
|---|---|
| `gateway-module/runtime.ts` | 会话、`listApps`、连接解析、墓碑过滤、授权状态 |
| `gateway-module/query/types.ts` | Hit / Coverage / Ref / Profile 类型 |
| `gateway-module/query/service.ts` | 查询计划、扇出、合并、去重、coverage、读详情 |
| `gateway-module/query/profiles/*.ts` | 每家 provider 的查询档案（首期 6 家） |
| `gateway-module/mcp-host.ts` | MCP Server：工具注册、转发、只读守卫、错误映射 |
| `gateway-module/mcp-server.ts` | loopback HTTP listener + token-in-path |
| `gateway-module/tombstones.ts` | 墓碑表读写（`connector_tombstones`） |
| `apps/gateway/src/modules/connectors/connector-mcp.ts` | 启动 MCP server、注入 runtime 的装配 |
| 测试夹具 | oo `/mcp` 与 action 输出的录制回放 |

### 5.4 宿主装配调整（`create-server.ts`）

- 删除：`ConnectorManager`、`SyncEngine`、`OpenConnectorSyncExecutor`、`ConnectorDocumentStore`、`ConnectorDomainProjection`、`FormatMappingService`、polling、回填、sync 路由、格式映射 agent。
- 保留：`OpenConnectorHttpClient`、`OpenConnectorAuthorizationService`（重写）、`connectorSessionRoutes`、external-calls、文档导入。
- 新增顺序：
  1. 建 connector runtime / query 服务；
  2. 启动 `ConnectorMcpServer`（loopback，await 拿到地址）；
  3. 建 agent runtime 时合并 MCP 配置；
  4. 启动 Fastify。

### 5.5 桌面端

- **IPC/桥**：只保留 `status`、`connections`、`providers`、`oauthConfigs`、`startAuthorization`、`authorizationStatus`、`remoteAccount`、`purgeConnection`。
- **UI**：连接页改为实时连接列表（读 oo），连接/断开/换账号；删除“上次同步/同步进度/记录数”等文案；原型页接真实 API。
- **对账**：删除周期对账与本地连接注册；连接是否可用直接看 oo。墓碑在 Gateway，桌面只展示“已断开”。
- **断开语义**：优先调 oo/SaaS 的远端删除；不支持时写墓碑，MCP 中转过滤该连接（`list_apps` 不返回、`execute_action/query` 拒绝）。

### 5.6 配置与契约

- 删除：`nangoConnector`、`NXCORE_CONNECTOR_POLL_MS`、Nango 相关死字段。
- 保留：`NXCORE_CLI_CONNECTOR_URL / RUNTIME_TOKEN / ADMIN_TOKEN / CONFIG_DIR / DATA_DIR`。
- 新增（可选，均有默认值）：`NXCORE_CONNECTOR_QUERY_TIMEOUT_MS`、`NXCORE_CONNECTOR_QUERY_MAX_SERVICES`、`NXCORE_CONNECTOR_QUERY_MAX_HITS`。
- `connector-contract`：删除 `SyncScope/SyncRun/MailMessage` 等同步契约；保留连接/授权/provider summary；新增 `QueryHit/QueryResult/ConnectorCatalog`。

### 5.7 数据迁移

- 新增 drizzle migration（0088）`DROP TABLE IF EXISTS`：宿主 schema 里的 10 张 `connector_accounts / records / emails / documents / calendar_events / todos / format_mappings / markdown_artifacts / markdown_outbox / audit_events`；以及旧版本可能残留的 `connector_prompt_profiles / connector_sync_jobs / connector_sync_job_states / connector_sync_job_versions / connector_sync_runs / connector_quarantined_records`。
- 新增 `connector_tombstones(owner_id, service, connection_name, created_at)`。
- 启动清理：删除 `database/connectors.sqlite` 与 `data/connectors/documents`（幂等、只删已知目录）。
- 老 REST 端点返回 `410 Gone`，保留一个版本便于诊断。
- 迁移前提示：同步数据是派生数据，删除不可恢复；如需保留，提供一次性导出脚本（可选）。

---

## 6. 关键流程

### 6.1 登录与会话

桌面 → SaaS 换 `{baseUrl, oct_}` → `PUT /v1/connector-session` → Gateway 内存持有。MCP server 不依赖会话启动；查询时读当前会话。

### 6.2 连接

桌面 → SaaS 代发起授权 → 浏览器 OAuth → token 落 oo → 桌面轮询 oo 看到连接。**没有本地注册、没有 scope、没有首同步**。MCP 的 `list_apps/list_connections` 立即能看到。

### 6.3 查询

Agent → `connector_query` → Query 层解析连接/档案 → 并发 action → 合并 hits + coverage → Agent 选 `connector_read` → 正文。`execute_action` 只读守卫兜底长尾。

### 6.4 断开

Gateway 写墓碑（或远端删除）→ MCP `list_apps` 过滤 → 查询/执行拒绝该连接。桌面显示已断开。

### 6.5 本地模式

桌面拉起本地 oo，Gateway 拿 baseUrl + runtime/admin token；MCP 中转和 Query 层完全一致，只是 SaaS 步骤换成本地 supervisor。

---

## 7. Agent 行为规范

### 7.1 系统提示

1. 外部账号资料优先 `connector_query`；本地文件/文稿用文档工具；公开信息用 web search。
2. 查询前先从问题里抽概念、实体、时间；模糊概念自行扩同义词/中英文。
3. 结果不足时：看 coverage → 改词/放宽时间/换来源 → 仍不足就问用户或说明“没查到”。
4. 引用必须来自 `connector_read` 过的原文，带服务、标题、时间。
5. 写操作不要尝试；`connector_query/read` 是只读的。

### 7.2 工具描述要点

- `connector_query`：写清“什么时候用、services 省略代表全源、返回 coverage 的含义、ref 需要 `connector_read` 打开”。
- `connector_read`：写清“只接受 query 返回的 ref；长文会截断；不要用它猜 action”。
- `execute_action`：写清“只读动作才允许；写动作会被拒绝”。

### 7.3 典型路径

| 用户请求 | Agent 动作 |
|---|---|
| 上次和财务聊预算的邮件 | `query(gmail, terms: 预算/budget/财务, since:90d)` → `read` 1–2 封 |
| A 客户的需求文档在哪 | `query(notion+drive+feishu, terms: 客户/需求/PRD)` → `read` 命中页；coverage 提示飞书跳过 |
| 这周还有哪些会 | `query(calendar, since: 本周)` → 必要时 `read` 事件 |
| 把最近关于 X 的邮件整理成周报 | `query` → `read` 3–5 封 → 文档工具写周报 |

---

## 8. 分阶段计划

| 阶段 | 内容 | 依赖 | 预估 | 验收 |
|---|---|---|---|---|
| **P0 契约与夹具** | 录制 oo `/mcp` 与 6 家 action 输出；定 Hit/Coverage/Ref/Profile 类型；MCP server 骨架（fake oo） | — | 1–2 天 | 契约测试可跑；类型评审通过 |
| **P1 MCP 中转 + Query 层** | ConnectorRuntime（会话/连接/墓碑）、MCP host（转发 + 本地工具 + 只读守卫）、Query 服务 + 首批 3 家档案、pi runtime 注入、external-calls 映射 | P0 | 3–4 天 | 对 fake oo 完成 tools/list、query、read；超时/partial/coverage 用例通过 |
| **P2 Agent 接入 + 桌面** | `<connectors>` 上下文注入、系统提示与工具描述、桌面连接页接真实数据、删除同步 UI/对账 | P1 | 2–3 天 | 连接 Gmail 后一轮内回答模糊查询；桌面不显示同步状态 |
| **P3 删除同步 + 迁移** | 删代码/IPC/路由/配置/agent；drop 表；410 旧端点；清理 connectors.sqlite 与 documents；更新 README/设计文档 | P2 | 2–3 天 | tsc/测试通过；空闲无连接器任务；新库无数据表；旧库升级成功 |
| **P4 长尾与打磨** | 剩余档案（outlook/slack/飞书能力标注）、URL 读取、性能与日志、文档、演示脚本 | P3 | 2 天 | 6 家覆盖；p95 达标；文档可交接 |

总计约 **10–14 人日**（1 人 2–3 周，2 人 1–1.5 周）。

---

## 9. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | 档案的 query/parse/read 映射；ref 编解码；去重/排序/截断；coverage 组装 |
| 契约 | MCP `tools/list` 合并、`tools/call` 路由、未知方法、鉴权失败；oo `/mcp` 信封兼容 |
| 集成 | fake oo HTTP + Gateway：登录会话 → query → read；无会话/无连接/超时 |
| Agent | 用固定 prompt 跑工具选择：是否会先 query、是否看 coverage、是否读详情 |
| 迁移 | 0087 旧库升级到 0088；旧端点 410；connectors.sqlite 清理幂等 |
| 安全 | 只读守卫；写 action 被拒；工具结果/日志不含 `oct_`/provider token；墓碑过滤 |
| 回归 | 文档导入（飞书/Notion）、文件转换、external-calls 配额 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| oo MCP 契约/版本漂移 | 录制夹具 + 契约测试；升级 oo 作为显式决策 |
| MCP URL 的端口 0 时序 | 独立 loopback listener，启动后再创建 agent runtime |
| pi MCP 配置是静态的 | 在 runtime 构造时合并；URL/token 进程内稳定，不依赖会话轮换 |
| provider 搜索能力参差（尤其飞书文档） | 档案能力矩阵 + coverage 如实标注；飞书先标 unsupported |
| Agent 不用 query、仍自己拼 action | 上下文注入 + 工具描述 + 提示词；用固定样例做回归 |
| 查询延迟/配额 | 单服务 8s、总 12s、并发/条数上限；部分结果返回 |
| 写操作误执行 | v1 只读守卫；写操作后续加审批，不混入 query |
| 迁移不可逆 | 只删派生数据；迁移前提示；可选导出脚本 |
| 桌面 UI 仍是原型 | 后端先行，UI 单独任务；先保证 Agent 能力可验收 |

---

## 11. 待确认

1. **断开语义**：SaaS 模式能否调 oo 远端删除连接？不能就保留墓碑（当前方案默认）。
2. **execute_action 守卫**：v1 用只读动作前缀白名单，还是直接不暴露、只留 query/read？
3. **飞书**：v1 接受“不支持模糊查”，还是接 lark-cli 作为第二后端？
4. **旧同步数据**：直接 drop（推荐），还是保留一次性导出？
5. **本地模式**：保留（推荐）；若只做 SaaS，可省去 local supervisor 相关验收。

---

## 12. 完成定义（DoD）

- 同步相关代码、IPC、路由、配置、agent、表、文件全部移除，仓库内无死引用。
- Agent 通过 MCP 完成「模糊查询 → 读详情 → 引用回答」的端到端演示。
- 查询有 coverage、可区分“没查到/没查/失败”；无会话与无连接有可恢复错误。
- 迁移脚本可在旧库上幂等执行；旧端点返回 410。
- 文档：更新 connector README；新增本方案与查询档案说明；旧同步设计文档标注历史。
