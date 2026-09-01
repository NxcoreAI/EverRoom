# 连接器数据源平台化 — 域表合流与 Provider 插件化重构方案（v1 草案）

> 状态：**草案，待评审**
> 日期：2026-08-31
> 范围：`apps/gateway`（`modules/connectors` 主体重构、`modules/context-rooms` 读侧、`infrastructure/database` 迁移）、`apps/desktop`（连接入口与管理面板数据驱动化）、`packages/connector-contract`（类型放宽）
> 与既有方案的关系：**不改** `docs/unified-ingest-plan.md` 的路由瀑布与 ingest 台账语义；**不改** `docs/entity-room-plan.md` 的实体晋升制——本方案位于两者**上游的连接器层**；与 `docs/connector-orchestration-design.zh-CN.md`（OpenConnector 动作编排）**正交**：该方案的 "Provider Adapter" 指 Action 编排适配器，本方案的 **SyncProvider** 指数据拉取归一化适配器，命名刻意区分，见 D8。
> 前置阅读：`apps/gateway/src/modules/connectors/README.md`（双连接器体系边界声明）、`docs/unified-ingest-plan.md`、`docs/entity-room-plan.md`

## 1. 背景与问题

### 1.1 现状：双连接器体系

`modules/connectors/README.md` 声明了两条互相独立的连接器管道：

| | Nango 拉取路径 | CLI/OpenConnector agent 推送路径 |
| --- | --- | --- |
| HTTP | `/v1/nango-connectors/*` | `/v1/cli-connectors/*` |
| provider | gmail / outlook / google-docs / notion / google-calendar | 动态（agent 侧 Skill） |
| 存储 | 独立 `connectors.sqlite`（mail_messages、connector_records、sync_*） | 主库 `connector_emails` / `connector_calendar_events` / `connector_todos` / `connector_documents` 域表 |
| 进 Room | memorySink → `ingestConnector`（sourceId = `connector:{provider}:{connectionId}:{kind}:{id}` ref） | 同一 `ingestConnector`（sourceId = 域表行 id） |

骨架是对的：连接器数据经统一 ingest 引擎进路由瀑布、Room 通过 `room_source_memberships` 间接关联（`context_rooms` 表无任何 connectionId/scopeId 字段），天然支持任意数据源。本方案**不动这个骨架**。

### 1.2 结构性问题（按严重度）

**P0-A：Nango 路径的结构化数据不进主库域表，读侧在"考古"。**

证据：`context-rooms/overview-service.ts` `listRoomMails()`（L676-710）——Nango 来源的邮件（sourceId 是 `connector:` ref，域表查不到行）回退解析 `route_decisions.sourceMarkdown` 快照：`senderAddress: null`、`hasAttachments: false` 恒定错误、发件人/时间靠正则（`mailSenderOf` / `mailSentAtOf`）、provider 靠反解 sourceId 字符串（`connectorProviderOf`）。`roomCalendarEvents()` 同病。而完整结构化数据（地址、附件、thread、attendees）就在 `connectors.sqlite` 的 `mail_messages` / `connector_records` 里，主库读侧够不着。

根因：`create-server.ts` L1082-1100 的 memorySink 载荷只带 `markdown`，不带 `NormalizedMail` / `NormalizedCalendarEvent`；`manager.ts` L128-146 扇出时结构化对象明明在手边，被压扁成 markdown 后丢弃。

后果：邮件全文存两份（connectors.sqlite + `route_decisions.sourceMarkdown`），Room 面板却用最差的那份；**该问题随 provider 数量线性放大**——每接一个新源，邮箱/日程面板都是残的。

**P0-B：新增一个 provider 要改 ~16 个文件，provider 是"枚举"不是"插件"。**

grep 验证 `google-calendar` 字面量分布：gateway 8 处 + desktop 8 处：

- `packages/connector-contract/src/index.ts`：`ConnectorProvider` 闭集 union + `isConnectorProvider` 硬编码五元判断；
- `nango-executor.ts`：`discoverScopes()`（L98-139）与 `pull()`（L140-146）if/else 上帝类，calendar 归一化逻辑内联在 executor；
- `config.ts`（L1121-1136 configKey 默认值映射）、`nango-bootstrap.ts`（L155-171 OAuth scopes 模板写死）、`create-server.ts`（L356-369 provider→configKey 装配）；
- desktop：`connector-gateway-bridge.ts`、`shared/sources.ts`、`ConnectSourceMenu.tsx`、`SourceIcon.tsx`、`ConnectorPage.tsx`、`MailProviderIcon.tsx`、`CalendarProviderIcon.tsx`、`FilterPreferenceGuideDialog.tsx`（L50-54 硬编码 provider 显示名）。

`providers/` 目录已有 gmail/outlook 两个 normalizer 函数——方向正确，但只有函数没有接口，其余逻辑仍散落在 executor/config/bootstrap/UI。

**P1-A：授权绑死 Nango OAuth。**

IMAP/CalDAV/Exchange 密码流、飞书企业自建应用、WebCal 订阅、本地 PST 导入——这些后续必然要接的源都不走 Nango 的 OAuth 模式。当前授权（`nango-authorization.ts` connect-session + tag 轮询）、拉取（Nango `/proxy`）、同步调度（manager）三者焊死。且 `modules/connector/`（单数）vendored 了整棵 Nango 源码树，是仓库里最重的依赖。

**P1-B：sourceId 是"可解析的字符串协议"，sourceKind 硬编码进 schema。**

`connector:{provider}:{connectionId}:{kind}:{id}` 拼接串：document 分支 kind 段为空（`create-server.ts` L1093 三元），格式不自洽；读侧要按 `:` 反解；协议一变全链路遭殃。`sourceKind` 是 drizzle schema 里的闭集 enum（`route_decisions` L1645、`room_source_memberships`），"加一种数据形态 = 一次 migration"。

**P2：类型安全与双引擎重复。**

executor 里 `connection: any`、`scope: any` 满天飞，契约类型躺在 connector-contract 里没人用；CLI connector-sync agent 与 Nango manager 是两套"拉取→归一化→落库"实现，归一化逻辑各写各的（`providers/gmail.ts` vs agent Skill）。

### 1.3 已否决的备选（勿回退）

- **Room 直挂 connectionId/scopeId**（在 context_rooms 加连接外键）：违背 entity-room-plan 的证据模型——Room 归属由路由瀑布决定，不由连接决定。间接关联保留。
- **一步到位替换/删除 Nango**：vendored 树与 supervisor 是当前 OAuth 路径的唯一支撑，阶段三只做**边界冻结**，不做移除。
- **connectors.sqlite 并入主库单文件**：sync_*/lease/checkpoint 是高频写，独立库隔离主库 corruption 风险。本方案合流的是**内容投影**（域表），不是**同步状态**（D2）。
- **把归一化上收到 ingest 引擎**：违背 unified-ingest-plan "引擎统一'进入'，不统一'理解'"——归一化是连接器层职责，ingest 只收 markdown + 身份。

## 2. 总体架构

### 2.1 目标态分层

```text
┌─ AuthChannel（授权，可插拔：nango-oauth | api-token | webcal-url | password | manual-import）
├─ SyncProvider 注册表（provider 定义：数据类型/拉取/归一化/UI 元数据/过滤偏好）
├─ Pull Engine（执行环境：NangoProxy | CLI agent | 直连 HTTP）—— SyncProvider 声明所需 engine
├─ 域投影 DomainProjection（唯一实现，两路共用：Normalized* → 主库 connector_* 域表行）
├─ ingest 引擎（不变：markdown + 身份 → 台账 → 路由瀑布 → room_source_memberships）
└─ Room 读侧（不变的结构，单轨数据源：只查主库域表）
```

核心不变式：**所有数据源在"域投影"层合流；Room 读侧只认主库域表行；sourceId 是不透明身份，不可解析。**

### 2.2 关键决策

- **D1 多引擎、一投影**：Nango 拉取与 CLI agent 推送两条管道保留，但都必须终结于同一组 `connector_*` 域表；归一化→域行的映射逻辑**单一实现**（`domain-projection.ts`），两路共用。
- **D2 状态与内容分库**：sync 游标/lease/fence 留在 connectors.sqlite；域行（内容）进主库。合流的是内容不是状态。
- **D3 域投影先于 ingest**：写序 = pull → 域行 upsert（拿行 id）→ `ingestConnector`。ingest 的 sourceId 最终直接用行 id（阶段四达成的终态）。
- **D4 sourceId 终态为不透明行 id**：`connector:` ref 仅作为阶段一至阶段四之间的过渡兼容层存在，最终退役。
- **D5 注册表驱动**：provider 元数据（拉取逻辑 + nango 配置 + UI 图标/名称/分类 + 过滤偏好表单）收敛为 gateway 侧单一注册表，前端经元数据端点渲染；`ConnectorProvider` 从闭集 union 放宽为 string + 注册时校验。
- **D6 授权与拉取解耦**：AuthChannel 接口化；凭据密文只存 connectors.sqlite，加密 key 由 desktop 侧持久化并注入（复用 `nango-supervisor.ts` L63-83 keystore 先例），明文永不进主库、永不进 renderer。
- **D7 `route_decisions.sourceMarkdown` 降级为审计快照**：不再是任何读侧的数据源；保留不删（晋升批量 ingest 还原内容仍依赖它）。
- **D8 命名**：本方案的拉取适配器叫 **SyncProvider**，与 connector-orchestration-design 的 "Provider Adapter"（动作编排）刻意不同名，避免两套正交概念的术语污染。
- **D9 四阶段独立可发布**：①与②无依赖可并行；③依赖②的注册表；④依赖①的域行。顺序 ①→②→③→④，每阶段一个 release，不搞大爆炸。

## 3. 阶段一：落库合流（P0-A）

> **实施状态：已实现（2026-08-31，M1）**。代码：`modules/connectors/domain-projection.ts`（新增）、`manager.ts`、`repository.ts`、`create-server.ts`、`context-rooms/overview-service.ts`、`modules/connectors/README.md`；测试 `tests/connector-domain-projection.test.ts`（10 例全绿，connectors/context-rooms 存量回归通过）。
> 落地时对本文的四处修正：① **0044 SQL 迁移不需要**——主库域表 schema 早已存在，回填改为 create-server 启动后 1s 的幂等 TS 例程（`backfillDomainProjection`，直读 connectors.sqlite 的 connector_records 过同一投影函数）；② ownerId 在投影构造时解析（`connectorSyncOwnerId ?? "local-user"`，与 CLI 路径同源），未新增 env 变量、未改 register() 签名；③ CLI 路径的 `upsertDomainRecord` 暂未改为复用共享投影（输入形态不同：unstructured record vs NormalizedMail），M2 拆迁时收敛；④ `allDay` 恒 false——归一化层把全天事件折算成 T00:00:00Z，全天语义需先增补 NormalizedCalendarEvent 字段（列入 M2 顺手项）。

### 3.1 目标与非目标

目标：Nango 路径的邮件/日程与 CLI 路径一样落主库域表；`listRoomMails` / `roomCalendarEvents` 删掉 markdown 回退，单轨读域表；存量数据一次回填。

非目标：不动 ingest sourceId 协议（阶段四才动）；不动 connectors.sqlite 的同步状态表；不接 `connector_markdown_artifacts` 版本链（见开放问题 Q4）。

### 3.2 写路径：域投影模块

新增 `apps/gateway/src/modules/connectors/domain-projection.ts`，从 CLI 路径的 `connectors/service.ts` `upsertDomainRecord()` 抽出**单一投影实现**，两路共用。映射（以邮件为例）：

| NormalizedMail 字段 | connector_emails 列 | 说明 |
| --- | --- | --- |
| `providerMessageId` | `sourceRecordId` + `messageId` | 唯一键成员 `(ownerId, service, connectionName, sourceRecordId)`，幂等 upsert |
| `providerThreadId` | `threadId` | |
| `addresses[role="from"]` | `senderName` / `senderAddress` | |
| `addresses[role∈to/cc/bcc]` | `recipients` | |
| `subject`（缺省"（无主题）"） | `subject` | 与 CLI 路径口径一致 |
| `sentAt ?? receivedAt` | `sentAt` + `sourceUpdatedAt` | |
| `textBody ?? stripTags(htmlBody)` | `bodyText` | |
| `memberships` | `labels` | |
| `attachments.length > 0` | `hasAttachments` | |
| —（计算） | `contentHash` = `contentHashOf(bodyText)` | 复用 `modules/files/storage.ts` 的 `contentHashOf`，与 ingest 判重同源 |
| —（常量） | `schemaVersion=1`、`promptVersion=0` | promptVersion=0 表示非 agent 产出 |
| —（上下文） | `service`=provider、`connectionName`=**connection.id**、`ownerId`、`syncedAt` | connectionName 取 `ConnectorConnection.id`（内存 sink 载荷里的 `connectionId` 即它，写读两侧天然一致） |
| tombstone change | `deletedAt` 软删 | 与 CLI 路径 `isTombstone` 同语义 |

日程同理：`NormalizedCalendarEvent` → `connector_calendar_events`（`eventId`=providerEventId、`startAt`/`endAt`、`attendees`、`organizer`、`allDay`=全天判定、`description` 缺省空串）。

**ownerId 对齐**：Nango 连接目前无 owner 概念（`manager.ts`/`connectors/client.ts` 均无 ownerId）。`ConnectorManager` 增加 ownerId 解析，语义与 CLI 路径 `currentOwnerId()` 一致：`nangoConnectorSyncOwnerId ?? connectorSyncOwnerId ?? "local-user"`；`NangoAuthorizationService.complete()` → `manager.register()` 时带入。

### 3.3 写入时序与容错

`manager.ts` `execute()` 循环内，memorySink 扇出点（L128-146）改为三步：

```text
1. repository.applyPage / applyCalendarPage     （不变，connectors.sqlite）
2. domainProjection.upsert(mainDb, owner, conn, change)   （新增，主库域行）
3. memorySink({ kind, provider, connectionId, documentId, title, markdown, calendarId })  （不变）
```

容错策略（分两步收紧）：第一版——步骤 2 失败记入 `sync_failures` 并计数，**不阻断**步骤 3（邮件仍经 markdown 入 Room，读侧退化为现状即最坏不劣化）； soak 一个版本后升级为硬失败（run failed，fence/游标不推进，下次重试）。

### 3.4 读侧改造

`overview-service.ts`：

- `listRoomMails()`：对 `connector:` 前缀的 membership sourceId，经 `parseConnectorRef()`（集中一处实现，替代散落的 `connectorProviderOf`）解析为 `(provider, connectionId, kind, recordId)`，按 `(ownerId, service=provider, connectionName=connectionId, sourceRecordId=recordId)` 批量查 `connector_emails`，与直连行合并返回（`provider` 字段直接取域行 `service`，不再反解字符串）。域行命中后，senderAddress/hasAttachments 等**恢复为结构化真值**。
- `roomCalendarEvents()` 同构改造。
- markdown 回退分支保留一个版本周期作为兜底，验证域行覆盖率 100% 后删除（兑现 D7）。

### 3.5 存量回填（迁移 0044）

新增 `0044_connector_domain_backfill.sql` + 数据迁移脚本：

1. 读 `connectors.sqlite` 的 `mail_messages` / `connector_records`（calendar JSON），过**同一个** `domain-projection.ts` 投影 upsert 进主库域表——零 API 调用，数据已在本地；
2. 兜底：对个别投影不出的 scope，由用户在 ConnectorPage 手动触发 `mode=rebuild` 全量重拉（复用既有管线）；
3. 回填后校验：逐 connection 统计"membership 中 `connector:` ref 可解析且域行命中"的比例，目标 100%（软删行除外）。

membership 的 sourceId **本阶段不改写**（改写是阶段四的事），本阶段只保证"ref 可解析到域行"。

### 3.6 代码改动清单

| 文件 | 改动 |
| --- | --- |
| `modules/connectors/domain-projection.ts` | 新增；从 `connectors/service.ts` 抽出 `upsertDomainRecord` 并扩展 NormalizedMail/Event 入参 |
| `modules/connectors/service.ts` | `upsertDomainRecord` 改为调用共享投影（CLI 路径行为不变） |
| `modules/connectors/manager.ts` | execute() 循环插入步骤 2；ownerId 解析与透传 |
| `modules/connectors/repository.ts` 或新文件 | `parseConnectorRef()` 集中实现 |
| `modules/context-rooms/overview-service.ts` | 两处读侧改造 + 回退分支标记删除 |
| `server/create-server.ts` | memorySink 闭包无需改（投影在 manager 内做） |
| `infrastructure/database/` | `0044_connector_domain_backfill.sql` + data migration |
| `modules/connectors/README.md` | 更新双轨说明为"多引擎、一投影" |

### 3.7 风险与对策

- **主库体积增长**：邮件正文进入主库。对策：bodyText 截断策略与 CLI 路径对齐（CLI 已存全文，无新增语义）；评估 WAL checkpoint 频率。
- **双写不一致**（connectors.sqlite 成功、主库失败）：对策即 3.3 的失败计数 + 硬失败升级；回填脚本幂等可重跑。
- **connectionName 口径**：写读两侧都必须用 `connection.id`。对策：投影函数签名强制收 `ConnectorConnection`，不允许散传字符串。

### 3.8 验收标准

1. 新连接 Gmail → 同步后，Room 邮箱面板中该邮件 `senderAddress` 非空、`hasAttachments` 与真实一致、provider 来自域行而非字符串反解；
2. 旧连接存量回填后，全部 `connector:` ref membership 可解析到域行（软删除外），`listRoomMails` 不再走 markdown 分支（加临时计数器验证为零后移除）；
3. CLI 路径回归：推送一封邮件 → 域行 upsert 幂等（同 sourceRecordId 重复推送不产生新行）；
4. 域投影单测：NormalizedMail/CalendarEvent 各字段 → 域列映射、tombstone 软删、缺省值口径。

## 4. 阶段二：SyncProvider 注册表（P0-B）

> **实施状态：gateway 侧已实现（2026-08-31，M2）；桌面端收敛（§4.4）已于同日补齐（M2b）**。M2b 代码：契约包增 `ConnectorProviderSummary`/`ConnectorProvidersResponse` 类型（网关端点与桌面同源）；desktop bridge 增 `providers()`/`createWebcalSubscription()` 并放宽 provider 联合为格式校验；main/preload IPC 通道 `nango-connector:providers` 与 `nango-connector:create-webcal-subscription`；renderer `useConnectorProviders` hook（静态 fallback 六源清单）+ ConnectSourceMenu 的 mail/calendar OAuth 区块与 webcal 订阅入口元数据驱动 + `WebcalSubscriptionDialog`（M3 订阅入口就此点亮）+ FilterPreferenceGuideDialog/ConnectorPage 显示名与图标走元数据回退；i18n 增 webcal 键（zh/en）。Google Docs/Notion 的"OAuth↔本地 Markdown 导入"双轨按钮保留静态结构（属本地导入 UX 特例，非 provider 分发）。bridge 旧"本地白名单拒绝"测试更新为新契约（格式校验在桥层、白名单在网关注册表）。
> 落地偏差：① normalizer（`providers/gmail.ts`/`outlook.ts`）**未**迁入 sync-providers——存量测试直接 import 该路径，迁移收益小于破坏面，M3 顺手收敛；② manager.register 的兜底 scope 改由注册表提供，google-docs/notion 的兜底种子从错误的 inbox 修正为各自正确值（该路径仅在 executor 缺席时触达）。

### 4.1 接口定义

新增 `modules/connectors/sync-providers/` 目录：

```ts
// sync-providers/types.ts
export interface SyncScopeSeed { providerScopeId: string; displayName: string }

export interface PullContext {
  /** Nango 只读代理（https-only、禁内网、禁凭据——沿用 nango-agent-tools.ts 的约束语义） */
  proxy(url: string, init?: { method?: "GET" | "POST"; query?: Record<string, string>; headers?: Record<string, string> }): Promise<unknown>;
  connection: ConnectorConnection;   // 强类型，消灭 any
  configKey: string;
}

export interface PullPage {
  changes?: NormalizedMailChange[];
  calendarChanges?: NormalizedCalendarChange[];
  documents?: NormalizedDocument[];
  terminalCursor?: string;
}

export interface SyncProviderDefinition {
  provider: string;                                    // 不再是闭集字面量
  dataTypes: readonly ("mail" | "calendar" | "document")[];
  auth: { channel: "nango-oauth"; nango: { configKeyDefault: string; integrationProvider: string; oauthScopes: string[] } };
  discoverScopes(ctx: PullContext): Promise<SyncScopeSeed[]>;
  pull(ctx: PullContext, scope: SyncScope, mode: SyncMode): AsyncGenerator<PullPage>;
  ui: { label: string; category: "mail" | "calendar" | "docs"; iconKey: string; comingSoon?: boolean };
  filterGuide?: { preferences: FilterPreferenceSpec[] };   // FilterPreferenceGuideDialog 的表单描述
}
```

`auth` 字段在阶段三扩展为多通道 union（见 §5.1）。`FilterPreferenceSpec` 描述首次连接后的过滤偏好引导表单（发件人白名单/黑名单、日历勾选等），把 `FilterPreferenceGuideDialog` 现在按 provider 硬编码的表单变成声明式。

### 4.2 现有 5 个 provider 的拆迁映射

| 现位置 | 去向 |
| --- | --- |
| `nango-executor.ts` `discoverScopes()` gmail 分支 | `sync-providers/gmail.ts` |
| `discoverScopes()` google-docs / notion 分支 | `sync-providers/google-docs.ts` / `notion.ts` |
| `discoverScopes()` google-calendar 分支（calendarList API） | `sync-providers/google-calendar.ts` |
| `discoverScopes()` 末尾 outlook 文件夹递归（Graph mailFolders） | `sync-providers/outlook.ts` |
| `pull()` 四个分支 + `gmail()` / `googleDocs()` / `notion()` / `googleCalendar()` / `outlook()` 私有方法（含 historyId/deltaLink/syncToken 游标语义） | 各自 provider 文件 |
| `providers/gmail.ts` / `providers/outlook.ts`（normalize 函数） | 迁入对应 `sync-providers/*.ts` |
| calendar 归一化（现内联在 executor/repository） | `sync-providers/google-calendar.ts` |

`nango-executor.ts` 瘦身为通用 Nango 引擎：`proxy()`、类型化的 `PullContext` 构造、nango-agent-tools 共用的请求约束。**executor 里不再出现任何 provider 字符串**。

### 4.3 契约与配置

- `packages/connector-contract`：`export type ConnectorProvider = string`（原五字面量联合降级为 `BUILTIN_PROVIDERS` 常量供提示与迁移校验）；`isConnectorProvider` 改为注册表查询（gateway 侧注入注册表，包内只留接口）。**补偿编译期穷尽性检查的丢失**：注册表启动自检——每个 provider 必须有 dataTypes/discoverScopes/pull/ui，缺一启动即 fail-fast。
- `config.ts`：`nangoConnector.providers` 注册表项驱动 configKey 默认值（`NXCORE_NANGO_CONNECTOR_{PROVIDER}_CONFIG_KEY` 覆盖规则不变）、bootstrap scopes 模板由 `auth.nango.oauthScopes` 驱动（替代 `nango-bootstrap.ts` L155-171 的硬编码）。
- `create-server.ts` L356-369 的五 provider 装配循环改为遍历注册表。

### 4.4 元数据端点与前端收敛

新增 `GET /v1/nango-connectors/providers`（阶段三随通道拆分改挂 `/v1/connectors/providers`，旧路径留别名）：

```json
[{ "provider": "gmail", "label": "Gmail", "category": "mail", "iconKey": "gmail", "connected": true, "comingSoon": false }]
```

desktop 侧收敛清单（8 处注册表 → 1 份数据）：

| 文件 | 改动 |
| --- | --- |
| `shared/sources.ts` | 保留静态 fallback 清单（旧网关/离线兼容），运行时优先端点数据 |
| `ConnectSourceMenu.tsx` | 菜单项按 category 分组渲染端点数据；`comingSoon` 项禁用 |
| `SourceIcon.tsx` / `MailProviderIcon.tsx` / `CalendarProviderIcon.tsx` | 收敛为单一 `iconKey → 组件` 映射；新 provider 无图标时回退通用图标 |
| `FilterPreferenceGuideDialog.tsx` | label 查端点元数据；表单由 `filterGuide.preferences` 声明驱动（L50-54 硬编码删除） |
| `ConnectorPage.tsx` | tab 按 dataTypes 渲染（有日历能力的连接才显示 calendar tab） |
| `connector-gateway-bridge.ts` | provider 列表透传，不再 switch |

**新增 provider 的边际成本从此变成：一个 `sync-providers/xxx.ts` 文件 + 注册表一行 + （可选）一个图标资源。**

### 4.5 风险与对策

- 闭集 union 放宽后，拼写错误的 provider 名静默通过：对策 = 启动自检（4.3）+ 注册名正则约束（`^[a-z][a-z0-9-]*$`）。
- 前端离线/旧网关兼容：静态 fallback 清单兜底，端点不可用时降级为现状硬编码列表。
- 回归面大（executor 全量拆迁）：对策 = 拆迁保持函数体原样搬移不改逻辑，配合同步管线的 fence/checkpoint 既有测试；5 provider 各一条端到端冒烟（连接→discover→pull→域行→Room 面板）。

### 4.6 验收标准

1. gateway 全仓 grep 无散落的 provider 字面量分发（executor/manager/routes/config/bootstrap/create-server 内零 `=== "gmail"` 类判断）；
2. `GET /v1/nango-connectors/providers` 返回注册表全量，desktop 连接菜单/图标/过滤引导全部由该数据渲染；
3. 以"新增一个假 provider（测试桩，仅注册表注册）"验证：不改 executor/UI/contract 任何既有文件即可出现在菜单与状态接口；
4. 5 个存量 provider 同步回归通过。

## 5. 阶段三：授权通道解耦（P1-A）

> **实施状态：WebCal/ICS 试点已实现（2026-08-31，M3）；飞书试点与 REST 全量泛化留 M3b**。代码：`auth-channels/types.ts`（AuthChannel 接口 + webcal-url 通道 + URL 归一约束）、`ics.ts`（零依赖 RFC5545 解析器：行展开/全天/TZID 双遍偏移换算（与进程时区无关）/取消事件 tombstone/文本转义）、`sync-providers/ics-calendar.ts`（direct 引擎 + ETag/Last-Modified 增量）、`sync-engine.ts`（nango/direct 双路分发、直连安全约束 https+禁内网+15s 超时+5MB 上限、Nango 就绪门控）、连接模型加 `auth_method`/`credentials_ref` 列（PRAGMA 升级）、`POST /v1/connectors/connections`（webcal-url 入口，同 URL 幂等、响应不回显令牌）、轮询常开改由引擎门控。测试 `tests/ics-calendar.test.ts`（9 例，含 TZ=America/New_York 下时区稳定性）。
> 顺手兑现：契约 `NormalizedCalendarEvent` 增补 `allDay?`，域投影透传——M1 的 allDay 已知限制对 ICS 路径关闭（Gmail/Graph 路径待归一化层补齐）。
> 剩余（M3b，已实现 2026-08-31）：飞书自建应用试点（`feishu-wiki` provider：api-token 通道 "appId:appSecret"、direct 引擎、tenant_access_token → wiki 空间 → docx 原文，`DirectPullContext` 增 `httpPostJson`）；`/v1/connectors/*` 前缀泛化上线——Fastify v5 路由先于 onRequest（改写 URL 无效），别名经 404 兜底内部转发（`app.inject` 不走网络），旧前缀由插件作用域钩子打 `Deprecation`/`Warning` 头，`/v1/connectors/connections` 保持独立入口并泛化支持 api-token 凭据；测试 `tests/feishu-wiki.test.ts`（5 例）。vendored Nango 的 eslint 边界规则未做（仓库无 gateway 侧 eslint 配置，列为可选）。

### 5.1 AuthChannel 接口

```ts
// modules/connectors/auth-channels/types.ts
export type AuthChannelKind = "nango-oauth" | "api-token" | "webcal-url" | "password" | "manual-import";

export interface AuthChannel {
  kind: AuthChannelKind;
  /** 发起授权：OAuth 返回 authorizationUrl；token/url/password 类返回凭据录入句柄（桌面端表单）。 */
  start(input: { provider: string; ownerId: string }): Promise<{ authorizationUrl?: string; handle?: string }>;
  /** 轮询/确认：OAuth 沿用 connect-session tag 轮询；凭据类由桌面端录入后直接 complete。 */
  poll(handle: string): Promise<{ status: "pending" | "connected" | "failed" | "expired"; connection?: ConnectorConnectionSeed; error?: string }>;
  /** 连接健康检查（手动触发）。 */
  test(connection: ConnectorConnection): Promise<boolean>;
}
```

`SyncProviderDefinition.auth` 扩展为 `auth: { channel: AuthChannelKind }`——provider 声明自己需要哪种通道，而非隐含"Nango 一把梭"。现有 `nango-authorization.ts` 整体包装为 `nango-oauth` 通道实现，行为不变。

### 5.2 连接模型与密钥托管

- `connectors.sqlite` 的 `connector_connections` 增加 `auth_method TEXT NOT NULL DEFAULT 'nango-oauth'`、`credentials_ref TEXT`（密文或凭据引用）；
- 凭据密文存 connectors.sqlite，加密 key 由 desktop 侧生成并持久化于 userData（**复用 `nango-supervisor.ts` L63-83 的 keystore 加密 key 先例**），经 env 注入 gateway；明文凭据不进主库、不进 renderer、不进日志（与 orchestration 设计第 8 条同一红线）；
- REST 从 `/v1/nango-connectors/*` 泛化为 `/v1/connectors/*`（旧前缀保留别名一个版本周期）；授权端点的响应结构对 nango-oauth 通道保持兼容。

### 5.3 试点选型（验证通道可插拔）

1. **WebCal/ICS 订阅日历**（首试点）：`webcal-url` 通道 + 新 SyncProvider `ics-calendar`——纯 HTTP GET + ICS 解析（无 Nango、无 OAuth），产出 `NormalizedCalendarEvent`，复用 calendar 管线/域投影/路由。这是成本最低的非 OAuth 源，且直接兑现"任意网站发布的日历都能订阅"。
2. **飞书自建应用**（第二试点）：`api-token` 通道（app_id + app_secret 用户录入），SyncProvider 走飞书 OpenAPI。desktop `shared/sources.ts` 的 `DataSourceKind` 已含 `'feishu'`（UI 标注 coming soon），本试点将其点亮。

IMAP/CalDAV 密码流通道**不在本阶段**，接口预留 `password` kind，见开放问题 Q1。

### 5.4 Nango 边界冻结

vendored 树（`modules/connector/`）与 supervisor 不移除，但冻结边界：gateway 代码只经 `nango-executor.ts`（引擎）与 `nango-authorization.ts`（通道）两个喉舌接触 Nango，其余模块禁止 import；README 边界声明升级为 lint 约束（可选：eslint no-restricted-imports 规则）。长期去留见开放问题 Q3。

### 5.5 风险与对策

- 密钥托管链路（desktop 加密 → env 注入 → gateway 解密）是新攻击面：对策 = 密钥仅内存持有、日志脱敏、`credentials_ref` 永不出现在 REST 响应（`/v1/connectors/*` 响应白名单序列化）。
- 路由改名破坏既有客户端：旧前缀别名 + 弃用告警头，desktop 一次性切换。
- 试点 provider（ICS/飞书）本身的工作量失控：试点范围锁死在"读"（日历订阅/邮件读取），写操作走 orchestration 设计那条线，不混入。

### 5.6 验收标准

1. 订阅一个公开 WebCal → 无任何 OAuth 弹窗 → 日程出现在 Room 日程面板（`calendar-event` membership），增量刷新基于 ETag/Last-Modified；
2. 飞书自建应用凭据录入 → 密文仅存 connectors.sqlite，REST 响应与日志中零明文（加泄露扫描用例）；
3. nango-oauth 通道回归：Gmail 授权→同步全链路与阶段二结束时等价；
4. `/v1/connectors/*` 新前缀可用，旧前缀别名带弃用告警。

## 6. 阶段四：身份规范化（P1-B）

> **实施状态：已实现（2026-08-31，M4）**。写路径：投影返回 `{outcome, id}`，manager 经 memorySink 透传 `domainRowId`，`ingestConnector` 的 sourceId 对 mail/calendar 直接用域行 id（document 无域行保持 ref）。存量改写：`rewriteConnectorRefIdentities`（启动时随回填执行，幂等）扫六张身份表（memberships/mentions/route_decisions/entity_doc_links/room_memory_attributions/ingest_events）的 `connector:` ref 原地改写为域行 id；memberships/entity_doc_links 的业务唯一键撞车（CLI 行已持目标 id）预删 ref 行保留既有行；解析失败/域行缺失计 unresolved 不动（读侧 ref 兜底通道按计划保留一个周期，`parseConnectorSourceRef` 待下个版本删除）。测试 11 例（含撞车去重与幂等）。台账 `ingest_events.source_id` 一并改写，dedup 连续性无损。

### 6.1 sourceId 收敛为不透明行 id

终态：`ingestConnector` 的 sourceId 对连接器类源**一律为域表行 id**（阶段一后每条记录都有行 id，此改动水到渠成）：

- 写侧：`manager.ts` memorySink 调用改为携带 `domainProjection` 返回的行 id；
- 读侧：`listRoomMails` / `roomCalendarEvents` / `roomTodos` 的 ref 解析分支删除，全部直查（与 CLI 路径已经的行为一致）；
- `parseConnectorRef` 保留一个版本周期仅供迁移与日志，之后删除。

### 6.2 存量改写（迁移 00XX）

数据迁移脚本一次性改写：

1. `room_source_memberships.sourceId`：`connector:` ref → 域行 id（按阶段一的解析规则批量映射，解析失败的行落隔离表人工处理，不静默丢弃）；
2. `route_decisions.sourceId` 同构改写（`sourceMarkdown` 快照不动，D7）；
3. ingest 台账：`ingest/service.ts` 的 `ledgerHit` / `nextLedgerVersion` 以 `(sourceKind, sourceId)` 为键——改写后新记录从 version 1 重新计版，`contentHash` 判重保证不会重复扇出（同内容 hash 命中即跳过），验证脚本对比改写前后 Room 的 facts/memberships 集合无增量。

### 6.3 sourceKind 词表治理

- `sourceKind` 保持闭集 enum（migration 仅在**新数据形态**落地时发生——形态增长远慢于 provider 增长，闭集换来 LedgerSourceKind 的类型安全，值得保留）；
- 确立不变式：**provider 永不出现在 sourceKind 或 sourceId 里**；provider 归属只存在于域行（`service` 列），由读侧 join 获得。新 provider 接入不触碰任何 enum/migration。

### 6.4 验收标准

1. 全仓无 `connector:` 前缀 sourceId 的生产写入路径（测试夹具除外）；
2. 改写迁移后：任一 Room 的邮件/日程面板内容与改写前逐项一致（自动化 diff 验收）；
3. ingest 台账无重复扇出（对比改写前后 `room_entity_facts` 行数）；
4. 删除 `parseConnectorRef` 及全部字符串反解辅助函数。

## 7. 配置汇总（env 增改一览）

| 变量 | 阶段 | 变化 |
| --- | --- | --- |
| `NXCORE_CONNECTOR_SYNC_OWNER_ID`（既有） | ① | Nango 路径开始消费（ownerId 对齐），新增 `NXCORE_NANGO_CONNECTOR_SYNC_OWNER_ID` 覆盖优先级 |
| `NXCORE_NANGO_CONNECTOR_{PROVIDER}_CONFIG_KEY`（既有） | ② | 由注册表驱动，新增 provider 自动获得同规则覆盖能力 |
| `NXCORE_NANGO_CONNECTOR_*`（URL/SECRET/POLL_MS，既有） | ②③ | 不变；③起 Nango 仅是 nango-oauth 通道的引擎 |
| `NXCORE_CONNECTOR_CREDENTIALS_KEY` | ③ | 新增：connectors.sqlite 凭据加密 key（desktop 生成注入） |
| ICS/飞书试点配置 | ③ | 按试点 SyncProvider 各自注册表项声明，不新增全局散变量 |

## 8. REST 增改汇总

| 端点 | 阶段 | 动作 |
| --- | --- | --- |
| `GET /v1/nango-connectors/providers` | ② | 新增：注册表元数据（label/category/iconKey/connected/comingSoon/filterGuide） |
| `/v1/nango-connectors/*`（既有 12 个） | ①② | 行为兼容，仅响应中 provider 字段来源改为域行 |
| `POST /v1/connectors/authorizations`（泛化前缀） | ③ | 新增；按 `auth.channel` 分发到通道实现；旧前缀别名一个版本 |
| `POST /v1/connectors/connections`（凭据类） | ③ | 新增：api-token/webcal-url 类凭据录入 |
| `GET /v1/connectors/:id/test` | ③ | 新增：连接健康检查 |
| `/v1/context-rooms/:roomId/mails`（既有） | ①④ | 响应结构不变，数据源单轨化 |

## 9. 里程碑与发布顺序

| 里程碑 | 内容 | 依赖 | 发布物 |
| --- | --- | --- | --- |
| M1 | 阶段一：域表合流 + 回填 0044 + 读侧单轨 | 无 | 邮箱/日程面板结构化字段全量真值 |
| M2 | 阶段二：SyncProvider 注册表 + 元数据端点 + 前端收敛 | 无（与 M1 可并行） | 新增 provider 边际成本 ≈ 1 文件 |
| M3 | 阶段三：AuthChannel + WebCal/飞书试点 + Nango 冻结 | M2 | 非 OAuth 源可接入 |
| M4 | 阶段四：身份规范化 + 存量改写 + 删兼容层 | M1 | sourceId 协议退役 |

每个 M 独立成 release；M1/M2 并行时注意 `manager.ts` 与 `nango-executor.ts` 的拆迁顺序（先 M1 后 M2 合并冲突更小）。

## 10. 风险与对策（跨阶段总表）

| 风险 | 阶段 | 对策 |
| --- | --- | --- |
| 双写不一致 / 回填遗漏 | ① | 失败计数 → 硬失败升级；回填幂等可重跑；覆盖率校验 100% 门禁 |
| 拆迁引入同步回归 | ② | 函数体原样搬移不改逻辑；fence/checkpoint 既有测试；5 provider 冒烟 |
| union 放宽丢编译期检查 | ② | 启动自检 fail-fast + 注册名正则 |
| 凭据泄露面扩大 | ③ | 密文+key 注入模式；REST 响应白名单；日志脱敏；泄露扫描用例 |
| 台账改写后重复扇出 | ④ | contentHash 判重天然幂等；改写前后 facts/memberships 集合 diff 验收 |
| 大迁移翻车不可回退 | ④ | 改写前 connectors.sqlite + 主库双快照；隔离表人工兜底，不静默丢数据 |
| LLM 逐条抽取成本随源数放大 | 全局 | ②b 规则前置短路已有；内容 hash 缓存与批抽取列为后续独立优化（Q6） |

## 11. 验收标准（总）

1. **数据保真**：任一 Room 的邮件/日程面板字段（发件人地址、附件、与会人、时间）与源系统一致，无 markdown 解析残留；
2. **扩展成本**：新增一个 OAuth 型 provider = 1 个 SyncProvider 文件 + 注册表 1 行 + 可选图标；新增非 OAuth 源 = +1 个 AuthChannel 实现；
3. **身份健康**：生产路径零 `connector:` ref、零 provider 字符串反解、provider 不出现在 sourceKind/sourceId；
4. **边界冻结**：gateway 中接触 vendored Nango 的文件 ≤ 2 个；
5. **兼容**：CLI 推送路径、ingest 台账语义、entity-room 晋升制全链路回归通过。

## 12. 开放问题（待拍板）

- **Q1 IMAP/CalDAV 密码流通道是否排期**：接口已预留 `password` kind；IMAP 全量拉取的游标语义（无 historyId/deltaLink，只有 UIDVALIDITY/UIDNEXT）需要单独设计，建议在 WebCal 试点验证后评估。
- **Q2 connectors.sqlite 明细表的长期去留**：阶段一后 `mail_messages`/`connector_records` 与主库域行内容重复。建议降级为"原始拉取缓冲"（滚动 90 天清理 + rebuild 兜底），或直接以主库域行为准、明细表仅存投影不出的原始字段（`extensionPayload`）。
- **Q3 vendored Nango 终局**：冻结后是否有计划切自托管二进制/上游镜像以缩减仓库体积？涉及桌面构建链，建议单独立项。
- **Q4 Nango 路径是否接入 `connector_markdown_artifacts` 版本链**：CLI 路径有 markdown 版本化工件（含 `ingestSourceId`），Nango 路径目前直接快照进 `route_decisions`。合流后是否统一走 artifacts（获得版本回放能力）？
- **Q5 connectionName/账号模型统一**：Nango 路径 connectionName=connection.id，CLI 路径语义为账号名且有 `connector_accounts` 表。多账号场景（同一 provider 两个 Gmail）建议在阶段三统一到 connector_accounts，是否纳入？
- **Q6 路由瀑布 LLM 成本**：源数量放大后逐条抽取的成本与延迟（内容 hash 缓存、批抽取、规则覆盖率提升）建议作为独立优化项排期，不阻塞本方案。
- **Q7 providers 元数据端点的多客户端契约**：browser-extension / mobile 是否消费该端点？若是，iconKey 需要跨端资源约定。

