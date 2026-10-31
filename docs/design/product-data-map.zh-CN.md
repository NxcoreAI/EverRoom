# 产品数据 / IPC 现状地图（标签页工作台迁移前置勘察）

> 只读勘察（2026-10-30）。回答：新外壳（窗口级标签 + 工作空间六页）要用的数据，今天哪些是真的、从哪个 IPC/字段来、哪些必须新建。
> 配套：`docs/design/tabs-workbench.zh-CN.md`（标签模型）、`docs/workbuddy-shell-redesign.zh-CN.md`、`docs/ui-refresh-20261029.zh-CN.md`（主题）。
> 路径相对仓库根。第 9 节是结论区。

---

## 1. Preload API 全景（`window.nxcore.*`）

单一事实源：`apps/desktop/src/preload/index.ts:200` 的 `const api: NxcoreDesktopApi`；类型全量在 `apps/desktop/src/shared/sources.ts:600`。渲染层只声明 `window.nxcore?: NxcoreDesktopApi`（`src/renderer/src/env.d.ts:25`），没有第二套 API 类型。

38 个命名空间：`platform` `app` `updater` `window` `appearance` `office` `locale` `clipboard` `errors` `diagnostics` `gateway` `migrations` `nangoConnector` `cliConnector` `agentAuth` `externalDocuments` `mcp` `externalCalls` `writingStyle` `agentSchedules` `agentAccess` `agentDebug` `slides` `subagents` `account` `aiRelay` `notifications` `runtimeConfig` `permissions` `search` `agent` `workspace` `cursorCompletionAgent` `documents` `sources` `obsidian` `files` `thesisFormat`。

另有一座**原型桥** `window.desktop`（`preload/index.ts:815`），只服务 `office-proto` 的 GenOffice fixture，不是产品数据面（§5.6）。

**不存在的命名空间（最易踩空）**：`fileLibrary`、`knowledge`、`kb`、`models`、`agents`。文件只在 `files.*`；知识库无任何 IPC；模型档位不是独立 API（§2.3）；智能体无 CRUD API。

### 1.1 工作区（`nxcore.workspace`）

| 方法 | 签名 | 主进程 |
| --- | --- | --- |
| `list` | `() => Promise<AgentWorkspace[]>` | `main/index.ts:2103` → bridge:198 → `GET /v1/agent/workspaces` |
| `create` | `(input: CreateAgentWorkspaceInput) => Promise<AgentWorkspace>` | `main/index.ts:2104` → bridge:202 |
| `update` | `(id, input: UpdateAgentWorkspaceInput) => Promise<AgentWorkspace>` | `main/index.ts:2106` → bridge:206 → `PATCH` |
| `remove` | `(id) => Promise<void>` | `main/index.ts:2108` → bridge:213 → `DELETE` |
| `pickDirectory` | `() => Promise<string \| null>` | `main/index.ts:2110`（原生 dialog，取消 null） |

通道名 `main/index.ts:340-344`；网关路由 `apps/gateway/src/modules/agent/routes.ts:175-232`，service `.../agent/service.ts:858-955`。`create` 只收 `name/path`（`routes.ts:180-196`），`update` 只收 `name/path/lastOpenedAt`（`routes.ts:201-220`）——**没有描述、目标、图标、颜色、排序**。

坑：删空间时网关把会话**回落到 default**（`service.ts:946-950`），但 store 立刻本地移除（`workbench/state/store.ts:299-308`），弹窗文案还写「会话会一并移除」（`sidebar/WorkspaceDialog.tsx:253`）；下一次 3.5s 轮询（`shell/Workbench.tsx:22`）它们会以默认空间会话重新出现。

### 1.2 Agent 会话（`nxcore.agent`）

| 方法 | 签名 | 实现 |
| --- | --- | --- |
| `listSessions` | `(pageLabel?: string, roomId?: string \| null) => Promise<AgentSession[]>` | `main/index.ts:2121` → bridge:156 → `GET /v1/agent/sessions` |
| `createSession` | `(input: CreateAgentSessionInput) => Promise<AgentSession>` | `main/index.ts:2122` → bridge:140 |
| `getSession` | `(id) => Promise<AgentSessionSnapshot>` | `main/index.ts:2129` → bridge:190 |
| `updateSession` | `(id, { title: string }) => Promise<AgentSession>` | `main/index.ts:2126` → bridge:179 |
| `deleteSession` | `(id) => Promise<void>` | `main/index.ts:2128` → bridge:186 |
| `getEvents` | `(sessionId, runId, afterSeq) => Promise<AgentEvent[]>` | bridge:217 |
| `startRun` / `cancelRun` | `(sessionId, StartAgentRunInput) => Promise<AgentRun>` / `(runId)` | bridge:250 起 |
| `resolveApproval` | `(approvalId, decision: AgentApprovalDecision, feedback?) => Promise<{approvalId, decision}>` | bridge:228 |
| `getPermissionMode` / `setPermissionMode` | `(id) => Promise<AgentPermissionModeState>` / `(id, mode)` | `shared/sources.ts:930-931` |
| `subscribe` / `unsubscribe` / `onEvent` | 订阅 `agent:event`（`AgentSocketFrame`） | `preload/index.ts:577-585`，bridge:345-374 |
| `getStatus` | `() => Promise<AgentStatusSnapshot>` | `main/index.ts:2101` → `GET /v1/agent/status`（`routes.ts:136`） |
| `getUsage` | `(range?: '24h'\|'7d'\|'30d') => Promise<AgentUsageSnapshot>` | `main/index.ts:2102` → `routes.ts:142` |
| `generateSessionTitle` / `suggestConversationPrompt` / `suggestStarterPrompts` | `shared/sources.ts:902-917` | `main/index.ts:2127` 起 |
| `createSessionLink` / `listSessionLinks` / `markSessionLinkReturned` | 跨会话跳转 | `shared/sources.ts:899-901` |
| `getLocalAgentDispatch` / `discoverLocalAgents` / `checkLocalAgentAdapters` / `installLocalAgentAdapter` / `importLocalAgentHistory` / `bindLocalAgentWorkspace` | 本机 CLI Agent / 子 Agent | `shared/sources.ts:888-895` |
| `submitPendingIntent` | `(intentId, input) => Promise<{intent, run}>` | `preload/index.ts:571` |

**关键缺口（直接卡住「按空间列会话」）**：网关 `GET /v1/agent/sessions` **已支持** `workspaceId`（`routes.ts:245-258`，过滤逻辑 `service.ts:1066-1080`），但桌面桥只转发 `pageLabel/roomId`（`gateway/agent-gateway-bridge.ts:156-160`），preload 签名也没有第三参。今天只能拉全量再内存过滤（`workbench/types.ts:91`）。且 `service.listSessions` 是「全表读 + JS filter」（`service.ts:1073-1078`），每个空间标签刷新都会全量传输；索引已存在（`drizzle/0089_agent_workspaces.sql:25`）。

### 1.3 文件库（`nxcore.files`）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `list` | `(limit?, offset?) => Promise<{items: FileCatalogDto[]; total}>` | `main/index.ts:2457` → `GET /v1/files/catalog`（**只有 limit/offset**，≤200） |
| `catalogEntry` / `get` | `(id) => Promise<FileCatalogDto>` / `Promise<FileDto & {storagePath; currentParsedId}>` | `main/index.ts:2458-2459` |
| `readMarkdown` / `readDataUrl` | `(id, options?) => Promise<{markdown}>` / `Promise<{dataUrl}>` | 解析正文 / 图片 |
| `rename` / `delete` / `reveal` / `exportReveal` | `shared/sources.ts:1031-1042` | 改名/删除/访达定位/导出 |
| `openOriginal` | `(fileId, originalName?, contentHash?, options?: {editable?; roomId?}) => Promise<{openedWith:'office';instanceId;kind;title} \| {openedWith:'external';legacyFallback?}>` | `main/index.ts:2476` 起；Office 唯一入口 |
| `pickAndImport` | `(options?: {pipelines?; roomId?}) => Promise<FileImportOutcome[]>` | 选择框 + `/v1/files` + `/v1/ingest` |
| `pickPaths` / `importPaths` / `importDropped` | 两段式导入 | `preload/index.ts:749-757` |
| `importArtifacts` | `(files: File[], roomId: string) => Promise<{fileId;originalName}[]>` | 产物库导入 → `artifact-imported` |
| `importAgentAttachments` | `(files: File[]) => Promise<AgentAttachmentReference[]>` | 对话附件 |
| `listHighRiskReviews` / `resolveHighRiskReview` / `onHighRiskReviewsChanged` | 高风险批次确认 | `shared/sources.ts:1063-1067` |
| `onOpenFromOs` / `takePendingOsOpen` | 系统「打开方式」 | `shared/sources.ts:1069-1073` |

### 1.4 Office（`nxcore.office`）

只有 7 个成员（`shared/sources.ts:626-641`），**没有 `open`**（打开走 `files.openOriginal`）：

- `setActiveInstance(id|null)`（null=全隐藏；false=实例不存在）、`closeInstance(id)`（false=脏关闭被取消，标签应保留）。
- `generateDocxPrototype({title, html}) => Promise<{fileEntryId, originalName}>`。
- `setWorkspaceBounds({x,y,width,height}) => void`（`ipcRenderer.send`，无返回）。
- `onAgentFile`（生成进度/完成，带 `fileId` 自动开预览）、`onAgentAsk`（slides「AI 修改」跳会话）、`onInstanceReloaded`（Agent 改写后重开，需重报矩形）。

### 1.5 连接器 / 账号 / 设置

- `nangoConnector`：`status()/providers()/oauthConfigs()/startAuthorization/authorizationStatus/remoteAccount/purgeConnection/reconnectConnection`（`shared/sources.ts:669-682`；主进程 `main/gateway/connector-gateway-bridge.ts` + `saas-connector-bridge.ts`）。
- `cliConnector`（`open-connector:*`）、`agentAuth`（飞书授权状态机）、`externalDocuments`（连接器文档导入/导出）、`agentAccess`、`mcp`、`agentSchedules`。
- `account`：`status/devices/login/loginWithOidc/logout/keyringStatus/二维码登录/配对设备/onAdmissionRequired` 等（`preload/index.ts:466-491`）。
- `runtimeConfig`、`notifications`、`appearance.setTheme`、`permissions.*`。
- `search`：`invoke(SearchRequestDto) => SearchPageDto`、`status()`、`prioritize`、`messageContext`（`shared/sources.ts:882-887`）——目前**唯一**能跨文件/文档/消息按时间倒序列东西的接口（空 query，§3.4）。

---

## 2. 工作区 / 会话契约与数据库

### 2.1 类型（`packages/agent-contract/src/index.ts`）

```ts
// :94-115
interface AgentWorkspace { id; name; path: string | null; kind: 'default'|'custom'; createdAt; updatedAt; lastOpenedAt }
interface CreateAgentWorkspaceInput { name: string; path?: string | null }
interface UpdateAgentWorkspaceInput { name?; path?; lastOpenedAt? }
const DEFAULT_AGENT_WORKSPACE_ID = 'default'                       // :111

// :118-140
interface AgentSession {
  id; workspaceId: string | null       // 唯一的工作空间归属字段
  roomId: string | null                // legacy，用户会话不是 Room 维度
  pageLabel: string                    // 只记「最后/创建时的 UI 面」，不是分区键
  runtimeId; activeAgentId?: string; modelPreference?: 'smart'|'primary'|'lite'
  channelAgentId?: string; title: string | null
  status: 'idle'|'running'|'interrupted'|'closed'                 // :9
  createdAt; updatedAt
}
// :313-329
interface CreateAgentSessionInput { pageLabel; workspaceId?; roomId?; modelPreference?; channelAgentId? }
// :357-359 —— 只能改标题
interface UpdateAgentSessionInput { title: string }
// :1998-2005
interface AgentSessionSnapshot { session; participants; activeRun: AgentRun|null; messages: AgentMessage[]; lastEventSeq }
```

- 状态只有四值；**没有 paused / done / archived / needs_review**（DB 同 `schema.ts:222-229`）。看板「进行中/待开始/已结束」只能映射 running / idle / closed·interrupted。
- `AgentSessionParticipant`（`:166-176`）带 `workspaceRoot` 与 `permissionProfile`（`inspect|workspace_write|full_access`，`:917`）——是**单会话的 Agent 沙箱**，不等于用户工作空间。
- `AgentWorkspaceStatus`（`:206-233`）里的 `workspace: {id:'agent://<id>', isolation:'dedicated'}` 是 Agent 自己的隔离区，**与 `AgentWorkspace` 同名不同义**。

### 2.2 数据库

`agent_workspaces`（`apps/gateway/src/infrastructure/database/schema.ts:189-203`；迁移 `drizzle/0089_agent_workspaces.sql:1-19`）：`id` text pk、`name` text、`path` text null、`kind` (`default|custom`)、`created_at/updated_at/last_opened_at` integer(ms)。列表按 `last_opened_at DESC`（`service.ts:877-884`）；默认空间不可删（`service.ts:939-944`）。

`agent_sessions`（`schema.ts:205-234`）：`workspace_id`（nullable + 索引）、`room_id`、`page_label`、`runtime_id`、`runtime_session_ref`、`active_agent_id`（默认 `main`）、`title`、`permission_mode`、`status`、时间戳。迁移把存量会话回填 `default`（`0089:24-26`）。

**能加 description/goals 吗？** 能且便宜：新增 `0090_*.sql` 走 `ALTER TABLE agent_workspaces ADD COLUMN ...`（照 `0089` 写法），同步改 `schema.ts`、契约、网关 route body schema（`routes.ts:180-220` 是显式 `Type.Object`，不加字段会被 Fastify 剥掉）。桌面 preload **不用改签名**（`UpdateAgentWorkspaceInput` 透传），只改类型。

### 2.3 模型 / 额度

没有 `agent.models`。模型是「档位」：`smart/primary/lite` → 内置 agentId（`agent-contract:347-354`），创建会话时锁定，不能中途换；可用性由 composer 打开选择器时判断（`components/agent/AgentComposer.tsx:146`）。用量是 `getUsage(range)` → `AgentUsageSnapshot{provider, model, range, inputTokens, outputTokens, cacheHitTokens, points[]}`（`:29-38`）。

---

## 3. 文件数据模型

### 3.1 `FileCatalogDto`（`apps/desktop/src/shared/ingest.ts:26-47`）

| 字段 | 取得方式 |
| --- | --- |
| `id/originalName/displayName/sharedTitle` | `sharedTitle = displayName ?? originalName`；聚类已退役（`gateway/src/modules/files/service.ts:495-496`） |
| `sourceKind` | `manual-upload \| local-folder \| connector \| web-clipper \| legacy-upload \| agent-generated \| artifact-imported` |
| `sourceLabel` | 中文展示名；`provider` 优先，否则按 sourceKind 映射（`files/service.ts:499`） |
| `relativePath` | 来源内相对路径；**不是绝对路径，也不含来源 id** |
| `provider` | 连接器 provider；本地文件 null |
| `bytes` | `file_blobs.byte_size` |
| `dataType` | 扩展名能力表推导，可能 null |
| `agentCategory/summary/tags` | 最新版本的 `file_classifications`（`schema.ts:1280-1298`）；未分类为 null/[] |
| `processingState` | `processing\|ready\|failed\|missing`（DB `deleted`→missing） |
| `clusterId` | **恒 null**（`files/service.ts:508` 硬编码，聚类退役） |
| `contentHash/currentVersionId` | 版本指纹与版本 id（@ 文件引用用） |
| `parsed` | 是否已有解析产物 |
| `updatedAt` | 列表排序键 |

`FileDto`（`ingest.ts:10-24`）另有 `assetKind/originChannel/visibility/capturedAt/mime`。

**类型漂移**：DB `source_kind` 枚举含 `migration`（`schema.ts:1196-1197`），渲染层 `FileCatalogDto.sourceKind` 没有（`ingest.ts:31`）。新 UI 的分组/图标要留 default 分支。

### 3.2 文件 ↔ 工作空间 / Room？

**没有。** `file_entries` 只有来源列（`schema.ts:1188-1228`），无 `workspace_id`、无 `room_id`。导入时的 `roomId` 只在 ingest job payload 透传给下游（`files/service.ts:312/422/765-768`），不落表。Room 表已在 `drizzle/0085_drop_room_tables.sql` 全删（`context_rooms/rooms/room_doc_links/room_overviews/room_source_memberships`）。`documents` 也扁平：`schema.ts:521-543` 只有 `origin(native/import)`、状态、版本；契约只余「无房文稿」频道常量（`agent-contract:5`）。

因此 `tabs-workbench.zh-CN.md:113` 的「`workspace.path` 命中 local-folder source 时按该目录过滤」**当前做不到**：catalog 不返回 `sourcePath/localSourceId`，接口只认 `limit/offset`（`apps/gateway/src/modules/files/routes.ts:183-195`）。只能：①给 `file_entries` 加 `workspace_id`（+迁移/DTO/list 过滤/导入元数据）；②新 `GET /v1/workspaces/:id/files` 由网关 join。

### 3.3 「Agent 生成」产物

- 落库 `sourceKind='agent-generated'`（`main/gateway/files-gateway-bridge.ts:786-800`；`office-bridge.ts:697`）。
- `sourceKey` 形如 `agent:docx:<idempotencyKey>` / `agent:slides:…`；编辑回填 `agent:word:edit:<fileId>` / `agent:slides:edit:<fileId>`（`main/office/office-preview-registry.ts:782`）。
- 产物库口径：`ROOM_ARTIFACT_SOURCE_KINDS = ['agent-generated','artifact-imported']`（`shared/sources.ts:564-569`）。
- **没有「属于哪个会话/空间」的列**；`sourceKey` 里只有幂等键/文件 id，反查不到 session。

### 3.4 列表 / 搜索

- 全库分页 `files.list(limit, offset)`（≤200/页，`files/routes.ts:188`）；单条 `files.catalogEntry(id)`。
- 跨类型最近：`search.invoke({query:'', limit, offset})`。空 query 走「按 `ingested_at` 倒序」分支（`gateway/src/modules/search/service.ts:404-411`），返回 `SearchHitDto{itemType:'file'|'message'|'document'|'export', refId, title, snippet, sourceKind, occurredAt, ingestedAt, sessionId}`（`shared/search.ts:9-24`）。做「动态/最近」最省事，但**无 workspace 维度**（`roomIds` 还在，Room 已删，实际为空）。
- 又一处漂移：`search` route 枚举没有 `room`（`search/routes.ts:5-10`），`SearchItemType` 有（`shared/search.ts:3`）。

---

## 4. 知识库 / 连接器 / 智能体：页面今天接什么

### 4.1 知识库（`office-proto/pages/KnowledgeView.tsx`）——纯 mock

所有内容来自 `office-proto/data.ts` 的 `knowledgeBases/files/sourceMeta`（`KnowledgeView.tsx:6-8`、`:43-52`、`:108-128`）；「新建知识库」只弹 toast（`:47`）。`shared/knowledge.ts` 是残留 DTO，头注释指向 `apps/gateway/src/modules/knowledge/routes.ts`，**模块与目录都不存在**；`knowledge_*` 表已在 `0084/0085` 清掉。新外壳不迁移知识库入口是对的。

### 4.2 连接器（`ConnectorsView.tsx` + `connectorsData.ts`）——真实且完整

一次快照并行四路（`connectorsData.ts:15-20`）：`nangoConnector.providers()` → `ConnectorProvidersResponse{providers: ConnectorProviderSummary[]}`；`nangoConnector.status()` → `ConnectorStatus{enabled, connections: ConnectorConnection[], scopes[], runs[]}`；`nangoConnector.oauthConfigs()` → `[{provider, displayName, iconUrl}] | string[] | null`；`agentAuth.status()` → `AgentAuthEnvironmentStatus{feishu, activeChallenge}`。

动作全真实：授权+轮询、断开（`purgeConnection`）、重连（`reconnectConnection`）、飞书（`agentAuth.start/disconnect`）（`ConnectorsView.tsx:465-610`）。目录缓存 + 账号代际失效在 `connectorsData.ts:76-100`。**复用 `ConnectorsView` 即可，不用改数据层。**

### 4.3 智能体（`office-proto/pages/AgentView.tsx`）——页面 mock，数据面分散

6 个 tab（记忆/会话/MCP/Skills/人格/画像）全读 `data.ts` mock（`AgentView.tsx:8-10`），唯一真实调用是 `agentDebug.openWindow()`（`:31-37`）。真实可用只有四块：

1. `agent.getStatus()` → `AgentStatusSnapshot`（`agent-contract:237-246`）：内置/开发者 Agent 的 `state/activeRunCount/currentRun/lastRun`，由 `AgentStatusService.snapshot()` 聚合（`gateway/src/modules/agent/status-service.ts:55-100`）。**全局，不按空间。**
2. `agent.getUsage(range)`：token 用量。
3. `agent.discoverLocalAgents()` → `LocalAgentInstallation[]`（`shared/local-agents.ts:1-20`）：本机 CLI Agent 与 ACP 适配器。
4. 子 Agent：网关有 `GET /v1/subagents` → `SubagentDefinition[]`（`gateway/src/modules/subagents/routes.ts:7-9`），**preload 未暴露**；只有按 invocation 查/取消/看事件五个方法（`preload/index.ts:454-465`）。`agent_schedules` 无 `workspace_id`（`schema.ts:1321-1341`）。

---

## 5. Office 预览 / 编辑：能否塞进任意 DOM 矩形（气泡窗）

### 5.1 打开链路

1. 渲染层 `files.openOriginal(fileId, originalName, contentHash, {editable})`（`preload/index.ts:740-746`；调用点 `office-proto/NativeEditorHost.tsx:60-85`）。
2. 主进程 `main/index.ts:2476` 起：无 `originalName`/非 OOXML/PDF → 外部应用；否则取 `storagePath` + 有效 hash，`editable` 进实例身份，调 `registry.open(window, file)`。
3. 注册表按 `fileId` 复用/重建（`main/office/office-preview-registry.ts:222-296`，`instanceId = fileId`）；`contentHash` 或 `editable` 变 → 先脏关闭守卫再原地重建（`:242-262`）。
4. `createView`（`:852-875`）按 kind 分派。每个 manager 都 `view.setVisible(false)` + `window.contentView.addChildView(view)`（`office-view-manager.ts:134`）+ `ipcMain.on('office:workspace-bounds', manager.handleBounds)`（`:137`）。

### 5.2 矩形上报

- 通道 `office:workspace-bounds`（`office-view-manager.ts:13`），四类 manager 共用（spreadsheet:69、slides:69、pdf:49）。
- 渲染层 `getBoundingClientRect()` + `ResizeObserver` + 捕获阶段 scroll 上报；尺寸归零发零矩形隐藏（`NativeEditorHost.tsx:125-161`）。
- 主进程钳制到窗口内容区：`x/y>=0`，`width/height<=contentBounds-x/y`（`office-view-manager.ts:31-41`）。坐标是**窗口内容区坐标**，不是屏幕坐标。
- 首帧门控 `OfficeViewFirstFrameGate` 等首帧后再显示，避免空视图透出宿主占位（`office-view-manager.ts:145-150`）。

### 5.3 多实例 / 任意矩形？

现状是「**多实例并存，但同一时刻只有一个可见，且所有实例共享同一矩形**」：

- 实例表 `Map<fileId, instance>`（`registry.ts:136`），可多开。
- `setActive(id)` 把其他实例全 `setActive(false)`，只留一个可见（`registry.ts:688-713`）。
- bounds 消息**不带实例 id**：每个 manager 都监听同一通道（`office-view-manager.ts:137`、`spreadsheet:69`、`slides:69`、`pdf:49`），一条 `setWorkspaceBounds(rect)` 会被**所有**打开实例收到；非激活实例虽不可见但矩形已被覆盖。
- 注册表只持有一个 `window`（`registry.ts:137`）；`bindWindow` 换窗口先 `disposeAll()`（`:877-885`），视图是 `BrowserWindow.contentView` 的子视图。

**对气泡窗的结论**：

- ✅ 可在**主窗口内容区的任意矩形**显示一份文档（拖宽/最大化/浮动均可），只要它是 active。
- ❌ 不能同时显示两份在两个矩形（共享矩形 + 只有一个 active）。
- ❌ 不能放进独立 OS 浮动窗口（换窗口销毁现有实例；单窗口注册表）。
- ❌ 原生 `WebContentsView` 永远画在 DOM 之上，气泡窗不能与标签栏/弹层/悬浮按钮重叠（`NativeEditorHost.tsx:6-13` 注释即此约束）。

最小改造：bounds 载荷改成 `{instanceId, x, y, width, height}`，manager 只处理自己的 id，并允许多个 `setVisible(true)`（需改 `OfficeViewFirstFrameGate` 与 `setActive` 语义）。要独立浮动窗口则按窗口拆注册表（`Map<windowId, instances>` 或每窗口一个 registry）。

### 5.4 标签 / 关闭

主进程**没有标签模型**，只有实例表 + `activeId`（`registry.ts:136-139`）。标签是渲染层状态：原型 `office-proto/OfficeProto.tsx:21` 的本地 `tabs`；工作台 `workbench/types.ts:22-43` 的 `ArtifactTab` + 按上下文隔离的 `artifactScopes`。关闭标签前调 `office.closeInstance(fileId)`，false 则保留（`workbench/artifacts/ArtifactPanel.tsx:15-22`）。可编辑实例保存事件去抖 2s 后按 `fileEntryId` 重导入（`registry.ts:765-830`）；脏关闭走 `requestDocsClose`（`office-view-manager.ts:168-186`）。

### 5.5 生成完成自动打开

`office:agent-file`（`shared/office.ts:4-27`）带 `fileId`，渲染层自动开预览；`office:agent-ask` 用于 slides「AI 修改」跳回会话（Room 已删，`roomId` 为 nullable legacy）。

### 5.6 `window.desktop`（原型桥，别混用）

`preload/index.ts:815-832` + `main/genoffice/bridge.ts`：`office:open/activate/close/dirty/bounds/pick-materials`，用 `OfficeFixtureStore` 把 mock spec 落成沙箱 fixture（`genoffice/bridge.ts:1-25`）。它**有 per-instance bounds**，但内容不是真实文件库，只服务 `office-proto` 的 mock 文件。新外壳一律走 `nxcore.*`。

---

## 6. 当前 workbench store：字段/动作 → 标签模型

`src/renderer/src/workbench/state/store.ts`（zustand，`create()` :158）+ `types.ts`。

### 6.1 字段

| 字段 | 真数据？ | 说明 |
| --- | --- | --- |
| `booted/loading/error` | UI | 启动态 + 全局错误条（`Workbench.tsx:113-119`） |
| `workspaces` | **IPC** | `workspace.list`（:178-182）；失败回落硬编码默认空间（:19-27） |
| `sessions` | **IPC** | `agent.listSessions()` 全量，再按 workspaceId 内存分组（`types.ts:91`） |
| `activeWorkspaceId` | 混合 | localStorage `everroom:workbench:active-workspace:v1`（:16） + `workspace.update({lastOpenedAt})`（:254） |
| `activeSessionId` | UI | 当前对话；null = 草稿 hero |
| `view` | UI | `{kind:'conversation'} \| {kind:'page', page}`（`types.ts:17-19`） |
| `artifactScopes` | UI | `Record<'session:<id>'\|'page:<page>'\|'draft', {artifacts, activeArtifactId, open}>`（`types.ts:30-57`） |
| `sidebarCollapsed` | UI | 无持久化 |

页面键：`recent|files|kb|connectors|agent|settings`（`types.ts:6-15`），图标 `sidebar/nav.ts:6-13`。

### 6.2 动作

| 动作 | 后端调用 | 备注 |
| --- | --- | --- |
| `boot` | `workspace.list` + `agent.listSessions` | 停在 hero 草稿态（:190-196） |
| `refresh` / `refreshSessions` | 同上 | 3.5s 轮询（`Workbench.tsx:22、40-56`）+ focus；`sessionsRefreshInFlight` 去重（:156-158） |
| `selectWorkspace` | `workspace.update({lastOpenedAt})` | 失败静默（:241-255） |
| `create/rename/deleteWorkspace` | `workspace.*` | 删除不级联删会话（网关回落 default，§1.1） |
| `createSession` | `agent.createSession({pageLabel:'Agent', roomId:null, workspaceId})` | 直接建库；hero 首条消息由 `useAgentSession` 建（:326-348） |
| `selectSession` / `syncActiveSession` | 无 | 后者迁移草稿产物作用域（:364-380） |
| `renameSession` / `deleteSession` | `agent.updateSession` / `deleteSession` | 运行中禁止删除（:401-404） |
| `openPage` / `showConversation` | 无 | 纯 `view` 切换 |
| `openArtifact/closeArtifact/activateArtifact/setArtifactOpen` | 无（关实例在 `ArtifactPanel`） | 纯 UI |
| `toggleSidebar` | 无 | 纯 UI |

### 6.3 改成窗口级标签必须动的地方

1. **导航真相源**：`view + activeWorkspaceId + activeSessionId` → `tabs: WindowTab[] + activeTabId`（模型见 `tabs-workbench.zh-CN.md:53-68`）。`Workbench.tsx:100-129`、`MainHeader.tsx:24-36`、`PageHost.tsx:12-29` 都要改成按 activeTab 解析。
2. **产物作用域键**：`artifactScopeKeyFor(view, activeSessionId)`（`types.ts:51-57`）只认 conversation/page，应改成 `tab.id`（或 `file:<fileId>` 独立作用域），否则同一会话出现在两个空间标签会串。
3. **会话过滤**：`sessionsOfWorkspace` 依赖全量 `sessions`；每个空间概览/侧栏/计划同时要过滤结果，必须给 `listSessions` 加 `workspaceId`（§1.2），否则每开一个空间标签全量拉一次。
4. **持久化**：今天只存 active workspace；标签模型要存「打开的空间标签 + 激活标签 + 每个空间标签的 view」，建议单键 JSON + 版本号，文件标签按设计不恢复。
5. **草稿态**：现在全局唯一 draft；标签模型里 draft 属于某个空间标签（`{kind:'draft'}`），`syncActiveSession` 要改对应标签的 view，而不是改全局 `activeSessionId`。
6. **快捷键**：`⌘N/⌘B/⌘J/⌘K`（`Workbench.tsx:71-90`）要重定义（⌘J=气泡窗、⌘W=关标签），并处理「文件标签无侧栏」布局。
7. **删空间行为**：store 本地删会话（:299-308），网关却回落 default（`service.ts:946-950`）；应改成「刷新后按网关结果重建」，否则标签指向不存在的空间。

---

## 7. 主题 / token / 可复用组件

### 7.1 Token（唯一源 `styles/tokens.css`，253 行，98 个 `--ui-*`）

- **品牌**（:18-21，只用于品牌时刻）：`--brand-ink/teal/peach/paper`。
- **背景/表面**（:24-29）：`--ui-bg` `--ui-chrome(-strong)` `--ui-surface(-alt/-sunken)`。
- **文字**（:32-35）：`--ui-text` `-2` `-3` `-inverse`；**线条**（:38-40）：`--ui-border(-strong/-subtle)`。
- **交互态**（:43-46）：`--ui-hover(-strong)` `--ui-selected(-strong)`。
- **强调色两角色**（:51-59）：`--ui-accent`（文字/描边）vs `--ui-accent-fill`（实底）+ `-soft/-softer/-line/-contrast/-hover/-strong`。
- **暖色**（:62-64）、**遮罩/滚动条**（:67-70）、**状态**（:73-82：danger/success/warning/running + soft）、**文件类型图标色**（:85-91：doc/sheet/slide/pdf/md/image/audio）。
- **字体**（:94-98）、**字号/行高/字距**（:102-117：`--ui-text-2xs…3xl`、`--ui-leading-*`、`--ui-tracking-*`）、**间距**（:119-128：`--ui-space-1…10`，4→64）、**圆角**（:131-137）、**阴影**（:140-143）、**动效**（:146-150）、**布局**（:153-158：`--ui-sidebar-width/header-height/content-max`）。

兼容别名：旧语义 `--bg/--surface/--text/--border/--accent…`（:166-179）与工作台 `--wb-*`（:185-217）都从 `--ui-*` 派生。新代码只用 `--ui-*`；token 挂 `:root`，Radix portal 也能继承。

### 7.2 主题（`styles/themes.css`）

`<html data-theme="paper|plain|moss|night" data-color-mode="light|dark">`：`paper` 默认（`tokens.css` 的 `:root`），`plain` :14、`moss` :90、`night` :165。枚举与主进程建窗底色 `shared/sources.ts:16-24`；写入/持久化 `renderer/src/state/appearanceSettings.ts:34-50`（`initAppearanceTheme` :66），并同步 `nxcore.appearance.setTheme`。**不要再造第三套色板**。

### 7.3 兼容层（`styles/legacy-ui.css`，267 行）

只保留登录门/启动闪屏/设置页用到的旧全局类（`.page/.page-header/.primary-button/.segmented-control` 等），作用域锁在 `.runtime-config-gate/.startup-splash/.op-settings-view`（:13-38），零特异性 `:where()`。新页面不要依赖。

### 7.4 组件与依赖

- 已有原语很薄：`components/ui/FilterSelect.tsx`（Radix DropdownMenu 封装）、`BrandRibbon`、`ProductBrand/ProductLogo`、`StartupSplash`；`components/WindowControls.tsx`；`components/pages/PageHeader.tsx`。**没有** Button/Input/Dialog/Tabs/Badge 通用 kit（`office-proto/parts.tsx` 的 `PageHead/Seg` 只服务原型样式）——需建 `workbench/ui/*`。
- Radix（`apps/desktop/package.json:30-39`）：avatar、collapsible、context-menu、dialog、dropdown-menu、popover、scroll-area、separator、tabs、tooltip。其它：`cmdk`、`react-resizable-panels`（`Workbench.tsx:102`）、`zustand`、`clsx`、`lucide-react`、`react-markdown`+`remark-gfm`、CodeMirror、TipTap。
- 约定：1px hairline + 底色分层，阴影只给浮层；portal 内容加 `wb-portal` 类（`MainHeader.tsx:60`）以拿全局 token。

---

## 8. 测试 / 浏览器 mock

### 8.1 渲染层单测

- `apps/desktop/vitest.config.ts`：`setupFiles: ./tests/setup.ts`，排除 `vendor/build/out/dist`；alias `@ -> src/renderer/src`、`@/shared -> src/shared`。setup 只 mock i18n（`tests/setup.ts`）。
- 现有 workbench 模式（`tests/workbench-file-panel.test.tsx`、`tests/workbench-artifact-scopes.test.ts`）：文件头 `// @vitest-environment happy-dom`；`react` 的 `act` + `createRoot` 手写渲染（**无 @testing-library**）；只装用到的 `window.nxcore` 命名空间（`workbench-file-panel.test.tsx:66-75`）；每例前 `useWorkbenchStore.setState({...})` 重置（:77-90）；`vi.mock('@/office-proto/EditorView')` 隔离原生编辑器（:30-32）；`flush(rounds)` 多轮 `act + setTimeout`（:57-64）。
- 命令：`pnpm --filter @nxcore/desktop test`（`apps/desktop/package.json:13`）；单文件 `node apps/desktop/node_modules/vitest/vitest.mjs run tests/xxx.test.tsx`；类型 `pnpm --filter @nxcore/desktop typecheck`。多实例/激活/编辑已有 `tests/office-preview-registry.test.ts`（710 行），气泡窗改造应扩在这里。

### 8.2 浏览器 mock（不启 Electron 也能截图）

- `apps/desktop/vite.browser.config.mts`：`root = src/renderer`（:691），端口 `process.env.PORT || 5181`（:699），COEP/COOP 与 Electron 一致。
- 插件 `nxcoreMock`（:10-16）注入 `/@mock/nxcore.js`：显式 mock 了 `files.list/openOriginal`、`agent.listSessions/createSession/getSession/startRun`、`nangoConnector`、`agentAuth`、`sources`、`knowledge`（仅 mock）等；未实现的方法落到万能 Proxy `magic()`（:42-56、:681）——**不崩 ≠ 数据真实**。
- 启动：`cd apps/desktop && npx vite --config vite.browser.config.mts`，打开 `http://localhost:5181`。
- **迁移必改**：mock 的 `agent.listSessions` 返回的会话**没有 `workspaceId`**，而 `sessionsOfWorkspace` 要求严格相等（`workbench/types.ts:91`）→ 空间侧栏/概览在浏览器预览里永远空。新增 description/goals 后也要同步 mock。

---

## 9. 缺口清单（按计划功能）

| 计划功能 | 今天有真数据？ | 用哪个字段 / IPC | 还缺什么 |
| --- | --- | --- | --- |
| **空间描述 / 目标** | ❌ schema 无列 | 只有 `name/path/kind/lastOpenedAt`（`schema.ts:189-203`） | 新迁移 `ALTER TABLE agent_workspaces ADD description/goals`（goals 可 JSON 数组）+ 契约 + 网关 route body schema（`routes.ts:180-220`，不加会被剥）+ preload 类型。桌面桥无需改。 |
| **洞察（概览 B 区）** | ⚠️ 只能派生 | `agent.getSession(id).messages[]` 取最近会话最后一条 assistant 文本（`agent-contract:1998-2005`）；或 `AgentStatusSnapshot.currentRun/lastRun` | 无洞察实体。**别用 `writingStyle.insights`**：本 worktree 没有写作风格网关模块（`apps/gateway/src/modules` 无此目录），`writing_style_insights` 表已在 `drizzle/0084_drop_memory_room_ingest_tables.sql:72` 删除，`preload/index.ts:388-403` 的 `writingStyle.*` 今天会 404。要多条/可忽略/可确认 → 新表 + 路由。 |
| **动态 / activity feed** | ⚠️ 部分 | ① `search.invoke({query:''})` 空查询按 `ingested_at` 倒序跨 file/document/message（`search/service.ts:404-411`）② `sessions[].updatedAt` + `files.list` 客户端合并 | 无 workspace 过滤（`SearchRequestDto` 只有 `roomIds`，Room 已删）；无 Agent 运行事件全局流（`agent_events` 只按 run 查，`schema.ts:472-489`）。空间级动态 = 新 `GET /v1/agent/workspaces/:id/activity`，或严格按「该空间 sessions + 客户端已知文件」派生（会漏未加载文件）。 |
| **资料库（按空间）** | ✅（0091 起） | `files.list(limit, offset, { workspaceId })`（`shared/sources.ts`） | `file_entries.workspace_id`（迁移 0091：存量回填 default + `file_entries_workspace_idx`）；`/v1/file-imports` metadata、`/v1/local-file-references` 与 catalog 查询参数均带 workspaceId，NULL 归一为 default。 |
| **产物（按空间）** | ✅（0091 起） | `sourceKind ∈ {agent-generated, artifact-imported}`（`shared/sources.ts`）+ `files.list({ workspaceId })` 服务端过滤 | Agent 产物入库自动带会话所属空间：`agent_sessions.workspace_id` → `StartRuntimeRunInput.workspaceId` → `DocumentExecutionContext.workspaceId` → office-bridge `/v1/office-generate` → `/v1/file-imports`。 |
| **智能体（按空间）**（页面已于 2026-10-30 移除，见 `tabs-workbench.zh-CN.md` §12） | ❌（只有全局） | `agent.getStatus()`（全局）、`agent.discoverLocalAgents()`、`agent.getUsage()`；子 Agent 定义仅网关 `GET /v1/subagents`（**preload 未暴露**）；`agentSchedules` 无 `workspace_id` | 「空间内启用列表」只能 localStorage（设计稿已如此），跨设备不生效。真做需 `workspace_agents` 关联表 + IPC；并把 `AgentWorkspaceStatus`（Agent 沙箱）与 `AgentWorkspace`（用户空间）在命名/类型上区分开。 |
| **计划看板** | ❌（无 task 实体） | 只能用 `sessions[].status`（`idle/running/interrupted/closed`，`agent-contract:9`）+ `updatedAt` 做只读三列 | 没有 tasks/plans 表（schema 无 `tasks`；`agent_schedules` 只是每日定时，`schema.ts:1321-1341`）。拖拽改状态/排序/负责人/截止日 → 新表（如 `workspace_plan_items`）+ 路由 + IPC。接受只读可零后端先上，但「新建/移动卡片」不能实现。 |
| （附带）按空间列会话 | ⚠️ 能做但低效 | `agent.listSessions()` 全量 + 内存过滤（`workbench/types.ts:91`） | 桌面桥加第三参 `workspaceId`（网关 `routes.ts:245-258` 已支持），并让 `service.listSessions` 用 SQL 过滤（现在全表读+JS filter，`service.ts:1073-1078`）。 |
| （附带）文件标签 / 气泡窗 | ⚠️ 单矩形单可见 | `files.openOriginal` + `office.setActiveInstance/closeInstance/setWorkspaceBounds` | bounds 通道无 instanceId、所有 manager 共享一条消息、`setActive` 互斥、注册表单窗口（§5.3）。并排多文件需扩协议；独立 OS 窗口需按窗口拆注册表。 |

---

## 10. 一句话结论

**会话与工作空间的关系是真的（`agent_sessions.workspace_id`）；0091 起文件与工作空间的关系也是真的（`file_entries.workspace_id`，存量回填 default）——资料库/产物库按空间隔离，Agent 产物自动归属其会话所在空间。连接器是真的，知识库是假的；Office 编辑是真的，但一次只能在一个矩形里显示一份。** 数据工作重点：给 `agent_workspaces` 补描述/目标（已做）、给 `agent.listSessions` 补 workspace 参数、给 bounds 通道补 instanceId；其余（洞察/动态/计划/空间内智能体）可先用现有 API 在渲染层派生，代价是全局无隔离。
