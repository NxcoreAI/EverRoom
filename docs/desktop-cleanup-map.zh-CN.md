# 桌面端清理地图（Office + Agent 保留 / memory·Context Room·采集链路移除）

> 状态：**只读审计产物**。本文件是执行清单，不含代码改动。
> 范围：`apps/desktop`（Electron 主进程 + preload + renderer + shared + 配置/脚本/CI）。
> 锚点行号取自审计当时的 `apps/desktop` 工作树；执行时以「函数名 / 通道名 / 文件名」为准，行号仅作定位参考。
> 网关侧已先行完成（模块 `knowledge`/`context-rooms`/`memory`/`writing-style`/`ingest`/`clipper`/`materials`/`perception`/`reality`/`screen-memory`/`diary`/`asr` 已删），因此大量桌面代码当前是**指向已删网关路由的悬空调用**——它们不会在 typecheck 报错，但运行时必然 404。这是本清单的主要检测手段：**凡是只服务已删 `/v1/*` 路由的桌面代码，一律删除**。

---

## 0. 判定口径

| 判定 | 含义 |
| --- | --- |
| **DELETE** | 纯废弃能力，整文件/整目录删除，无幸存调用方 |
| **TRIM** | 混合文件：保留文件，按条目外科删除指定函数/分支/字段/常量 |
| **KEEP** | 服务 Office / Agent / 文件库 / 连接器，保留（部分需 TRIM 内部小段） |
| **待确认** | 不确定是否服务幸存流程；已给出「能定论的证据来源」 |

网关侧权威事实（审计已核对 `apps/gateway/src/modules/**` 中的 `/v1/*` 字面量）：
现存 `v1` 家族只有 `documents`、`document-import`、`document-operations`、`document-understanding`、`document-blocks`、`files`、`file-imports`、`file-entries`、`local-file-references`、`materials/:hash`、`agent`、`agent-access`、`agent-scheduler`(经 `agent/schedules`)、`subagents`、`subagent-invocations`、`connectors`/`connector-session`、`slides`、`slides-*`、`thesis-format`、`search`、`runtime-config`、`mcp`、`external-calls`、`external-document-*`、`data-migrations`、`ai-relay`、`notifications`、`system`、`health`、`processing/{conversation-suggestion,session-title,starter-prompts}`、`rooms/:roomId/documents/*`（仅外部文档导入，roomId 只是命名空间）。
**已消失**：`v1/knowledge*`、`v1/context-rooms*`、`v1/memory*`、`v1/perception*`、`v1/reality*`、`v1/screen-memory*`、`v1/diary*`、`v1/asr*`、`v1/writing-style*`、`v1/ingest*`、`v1/clipper*`、`v1/processing/transcription-summary`、`v1/materials`（列表搜索；仅剩 `GET /v1/materials/:hash`）、`v1/documents/folders`。

---

## 1. 主进程 `apps/desktop/src/main/**`

### 1.1 纯废弃能力 —— 整目录 / 整文件 **DELETE**

| 路径 | 依据（下游/上游） |
| --- | --- |
| `src/main/memory/`（`embedding-env.ts`、`memory-core-config.ts`、`memory-core-supervisor.ts`） | 只服务 MemoryCore 子进程；`embedding-env.ts` 仅被 `knowledge/llm-env.ts` 引用 |
| `src/main/knowledge/`（`knowledge-supervisor.ts`、`llm-env.ts`） | 只服务 KnowledgeService 子进程（`/v1/knowledge*` 已删） |
| `src/main/asr/`（`asr-coordinator.ts`） | 只被 `index.ts:96/3016/4628` 使用，落 `/v1/asr/jobs`（已删） |
| `src/main/transcription/`（9 个文件） | `private-transcription-sync` / `private-audio-sync` / `processing-coordinator` 落 `/v1/processing/transcription-summary`（已删）；`summary-quality.ts`、`private-sync-scheduler.ts` 只服务它 |
| `src/main/recording/`（`recording-store.ts`、`recording-segment-uploader.ts`） | 只被 ASR 链路使用；`recording-segment-uploader.cleanupAtStartup`（`index.ts:4186`）随之删除 |
| `src/main/screen-memory/`（16 个文件，含 `screen-memory-gateway-bridge.ts`） | 全部落 `/v1/screen-memory/*`（已删） |
| `src/main/screenshot/`（`index.ts`、`screenshot-outbox.ts`、`window-screenshot-service.ts`） | `screenshot-outbox.ts:94` 落 `/v1/perception/visual-observations`（已删）；`window-screenshot-service` 只被 `index.ts` 截图调度与 screen-memory 使用 |
| `src/main/vision-ocr/`（`vision-ocr-client.ts` + test） | 只被 `screen-memory/*` 与 `index.ts:121/964/3606/3618` 使用 |
| `src/main/browser-extension/`（`browser-extension-service.ts` + 2 test） | 网页剪藏桥；下游 `/v1/clipper/captures*`（已删） |
| `src/main/gateway/knowledge-gateway-bridge.ts` | 全部落 `/v1/knowledge*`（已删） |
| `src/main/gateway/memory-gateway-bridge.ts` | 全部落 `/v1/memory*`（已删） |
| `src/main/gateway/reality-gateway-bridge.ts` | 落 `/v1/reality/events`、`/v1/reality/stream`（已删） |
| `src/main/gateway/diary-gateway-bridge.ts` | 落 `/v1/diary/*`（已删） |
| `src/main/gateway/perception-gateway-bridge.ts` | 落 `/v1/perception/settings`（已删） |
| `src/main/gateway/ingest-gateway-bridge.ts` | 落 `/v1/ingest/filter/rules`、`/v1/ingest/pause`（已删） |
| `src/main/gateway/asr-gateway-bridge.ts` | 落 `/v1/asr/jobs`（已删） |
| `src/main/gateway/writing-style-gateway-bridge.ts` | 落 `/v1/writing-style*`（已删） |
| `src/main/gateway/context-room-gateway-bridge.ts` | **不可整删**，见 1.2 |
| `native/vision-ocr/`（Swift 侧车源码） | 只服务屏幕记忆 OCR |
| `build/vision-ocr/`（构建产物） | 同上 |

### 1.2 混合文件 —— **TRIM**（外科手术，逐条）

#### `src/main/gateway/context-room-gateway-bridge.ts` —— **文件保留，删 21/25 个方法**

- **保留并迁移**（这 4 个方法打的是**幸存**的 `/v1/subagent-invocations*`，必须搬到 `agent-gateway-bridge.ts` 或新建 `subagent-invocations-gateway-bridge.ts`，并同步改 IPC 命名空间）：
  - `getSubagentInvocation`（第 109 行）→ `GET /v1/subagent-invocations/:id`
  - `listRunSubagentInvocations`（第 114 行）→ `GET /v1/subagent-invocations?rootRunId=`
  - `listSubagentInvocationEvents`（第 119 行）→ `GET /v1/subagent-invocations/:id/events`
  - `cancelSubagentInvocation`（第 123 行）→ `POST /v1/subagent-invocations/:id/cancel`
  - 依赖的 DTO `SubagentInvocation` / `SubagentInvocationNode` / `SubagentInvocationEvent` 来自 `@nxcore/agent-contract`，**保留该依赖**。
- **删除**：`list`、`create`、`syncSnapshot`、`checkDuplicates`、`listDuplicateCandidates`、`updateDuplicateCandidate`、`previewMerge`、`startMerge`、`suggestMergeNames`、`checkRoomDuplicates`、`getMergeOperation`、`retryMerge`、`cancelMerge`、`dispatchSelectionRewrite`、`refreshBrief`、`promoteMemoryItem`、`overview`、`refreshOverview`、`listMails`、`readMail`、`roomEntities`、`completeLocalAction`（第 24–108、127–176 行），以及私有 `request()` 中「Room 请求失败」文案。
- 迁完后文件名可从 `context-room-gateway-bridge.ts` 改为 `subagent-invocations-gateway-bridge.ts`；如改名，`src/main/index.ts:63` 的 import 同步。

#### `src/main/gateway/files-gateway-bridge.ts` —— 文件 **KEEP**，删剪藏/感知/记忆字段

- **DELETE 方法**（唯一调用方是剪藏或已删路由）：
  - `listClipCaptures`（第 214 行）、`setClipCaptureFavorite`（227）、`getClipCaptureDetail`（234）
  - `createClipCapture`（752）、`uploadClipAsset`（768）、`finalizeClipCapture`（774）、`retryClipCapture`（780）、`getClipCapture`（784）、`readClipAsset`（788）→ 全部落 `/v1/clipper/*`（已删）
  - `registerVisualObservation`（546）→ `POST /v1/perception/visual-observations`（已删）
- **DELETE 分支/字段**：
  - `delete()`（362）返回体去掉 `knowledgeCleanup`、`deletedMemoryDocuments`（仅保留 `deleted`、`blobCollected`）
  - `purgeLocalSource()`（711）返回体去掉 `deletedMemoryDocuments`
  - `importAgentGeneratedFile`（862）与 `importArtifactFiles`（888）里 `pipelines: { room: true, wiki: false, memory: true }` → 见 §5「管线字段漂移」
- **KEEP**：`collectImportPlan`、`collectImportCandidates`、`list`、`catalog`、`catalogEntry`、`capabilities`、`get`、`readMarkdown`、`readDataUrl`、`readMaterial`（`/v1/materials/:hash` 幸存，服务 `everroom-material://`）、`importAgentAttachments`、`rename`、`pinClusterTitle`、`reveal`、`storagePath`、`openOriginal`、`exportReveal`、`pickAndImport`、`pickImportPaths`、`importPathsOnce`、`importObsidianProject`（随 Obsidian 判定，见 1.4）、`importMigrationFile`、`importLocalFile`、`markLocalFileMissing`、`projectVaultNote`（随 Obsidian 判定）、`importConnectorFile`、`importPath`、`importAgentGeneratedFile`、`importArtifactFiles`、`waitForMarkdown`。

#### `src/main/gateway/runtime-config-bridge.ts` —— **TRIM**

- 删除 `memoryCoreConfig` 写入路径：第 47 行 `PUT /v1/memory/config`、第 51 行 `DELETE /v1/memory/config`（**已删路由**）。
- 保留 `get` / `saveUser` / `clearUser` / `test` / `selectSource` / `relayReady`（`/v1/runtime-config*` 幸存）。

#### `src/main/gateway/agent-gateway-bridge.ts` —— **TRIM**

- 删除第 253 行 `POST /v1/processing/transcription-summary`（**已删路由**）及其包装方法（转录摘要落库）。
- 保留其余（会话/运行/事件/审批/日程/导出）。

#### `src/main/cloud/saas-client.ts` —— **TRIM**

- 删除转录摘要标签相关：`RealityTag` 类型 import（第 26 行）、`listSummaryTags()`（1361）、`replaceSummaryTags()`（1365）——它们只被 `transcription:list-tags` / `transcription:replace-summary-tags` 使用。
- 这是让 `@nxcore/reality-contract` 在 desktop 侧变为未使用的唯一原因（见 §6）。
- 保留：账号/OIDC/配对/设备准入/额度/私有记录/通知等主体。

#### `src/main/core/local-data-service.ts` —— 文件 **KEEP**，随 SourcesPage 结论裁剪证据

- 与 Room/memory 无耦合（已核对：无 `roomId`/`memory`/`knowledge` 引用）。
- 「证据解析」（`evidence/evidence-service.ts` 注入，第 16/133/164/390/648/746 行）→ 见 1.4 `evidence/` 判定。
- 其余（本地文件夹扫描、GitHub / Google Docs / Notion 连接器、高风险导入队列）保留。

#### `src/main/monitoring/sentry.ts`、`logging/`、`network/`、`security/`、`core/data-migrations.ts`、`migrations/`、`updater.ts`、`process-cleanup.ts`、`file-format-policy.ts`、`cross-origin-isolation.ts`、`document-*`、`high-risk-import-coordinator.ts`、`system-clipboard.ts`、`desktop-locale.ts` —— **KEEP**（无已删路由依赖）

#### `src/main/migrations/` —— **KEEP**

`openclaw` / `cherry` / `notion-zip` / `hermes` 适配器 + `coordinator.ts` 落幸存模块 `data-migrations`（`/v1/data-migrations/*`）。仅需确认 `cherry-watcher.ts` 不写 memory：当前无 memory 引用，**KEEP**。

#### `src/main/agent-access/`、`agent-auth/`、`local-agents/`、`connectors/`、`agent-scheduler` 相关桥、`office/`、`gateway/gateway-supervisor.ts`、`gateway/office-bridge.ts`、`gateway/document-gateway-bridge.ts`、`gateway/external-documents-gateway-bridge.ts`、`gateway/mcp-gateway-bridge.ts`、`gateway/search-gateway-bridge.ts`、`gateway/slides-gateway-bridge.ts`、`gateway/thesis-format-gateway-bridge.ts`、`gateway/connector-gateway-bridge.ts`、`gateway/agent-access-gateway-bridge.ts`、`gateway/agent-scheduler-gateway-bridge.ts`、`gateway/external-calls-gateway-bridge.ts`、`gateway/migrations-gateway-bridge.ts`、`gateway/cursor-completion-env.ts`、`gateway/web-contents-lifecycle.ts`、`gateway/saas-connector-bridge.ts` —— **KEEP**

### 1.3 `src/main/index.ts`（4823 行）—— 精确手术清单

**A. 通道常量组（`const *_CHANNELS`）**

| 行范围 | 常量 | 判定 |
| --- | --- | --- |
| 295–302 | `BROWSER_EXTENSION_CHANNELS` | DELETE |
| 359–386 | `CONTEXT_ROOM_CHANNELS` | TRIM：删 `list`…`completeLocalAction` 全部；`getSubagentInvocation` / `cancelSubagentInvocation` / `listRunSubagentInvocations` / `listSubagentInvocationEvents` **改名迁移**到新常量（如 `SUBAGENT_INVOCATION_CHANNELS`，值建议 `subagent-invocations:*`，避免与已删命名空间混淆） |
| 465–479 | `ASR_CHANNELS` | DELETE |
| 480–484 | `PRIVATE_AUDIO_CHANNELS` | DELETE |
| 486–501 | `REALITY_CHANNELS` | DELETE |
| 532–539 | `TRANSCRIPTION_CHANNELS` | DELETE |
| 541–566 | `MEMORY_CHANNELS` | DELETE |
| 588–633 | `KNOWLEDGE_CHANNELS` | DELETE |
| 662–670 | `INGEST_CHANNELS` | DELETE |
| 681–691 | `SCREEN_CAPTURE_CHANNELS` | DELETE |
| 693–700 | `PERCEPTION_CHANNELS` | DELETE |
| 702–710 | `DIARY_CHANNELS` | DELETE |
| 717–732 | `WRITING_STYLE_CHANNELS` | DELETE |
| 247–264 | `SOURCE_CHANNELS` | TRIM：删 `listEvidence`、`previewFile`、`searchEvidence`（随 `evidence/` 与 SourcesPage 证据视图）；其余随 SourcesPage 结论 |
| 266–282 | `OBSIDIAN_CHANNELS` | TRIM：随 §1.4 Obsidian 判定 |
| 284–286 | `GATEWAY_CHANNELS` | KEEP |
| 287–294 | `MIGRATION_CHANNELS` | KEEP |
| 303–310 | `RUNTIME_CONFIG_CHANNELS` | KEEP |
| 312–357 | `CONNECTOR_CHANNELS` / `OPEN_CONNECTOR_CHANNELS` / `AGENT_AUTH_CHANNELS` / `EXTERNAL_DOCUMENT_CHANNELS` | KEEP |
| 388–463 | `AGENT_CHANNELS` / `CURSOR_COMPLETION_AGENT_CHANNELS` / `DOCUMENT_CHANNELS` | KEEP |
| 503–530 | `ACCOUNT_CHANNELS` | KEEP |
| 568–586 | `SEARCH_CHANNELS` / `MCP_CHANNELS` / `EXTERNAL_CALL_CHANNELS` | KEEP |
| 635–660 | `FILES_CHANNELS` | TRIM：删 `listClipCaptures`、`getClipCaptureDetail`、`setClipCaptureFavorite`、`getClipCapture`（4 个剪藏通道）；其余 KEEP |
| 672–679 | `THESIS_FORMAT_CHANNELS` | KEEP |
| 713–715 | `SLIDES_CHANNELS` | KEEP |
| 734–759 | `AGENT_SCHEDULER_CHANNELS` / `AGENT_ACCESS_CHANNELS` | KEEP |
| `screen-memory` 模块内 | `SCREEN_MEMORY_CHANNELS` | DELETE（随目录） |

**B. `installIpcRouters()` 的 `channelGroups` 数组（第 793–828 行）**

删除其中这些成员：`CONTEXT_ROOM_CHANNELS`、`ASR_CHANNELS`、`PRIVATE_AUDIO_CHANNELS`、`REALITY_CHANNELS`、`MEMORY_CHANNELS`、`KNOWLEDGE_CHANNELS`、`INGEST_CHANNELS`、`SCREEN_CAPTURE_CHANNELS`、`SCREEN_MEMORY_CHANNELS`、`BROWSER_EXTENSION_CHANNELS`、`PERCEPTION_CHANNELS`、`DIARY_CHANNELS`、`WRITING_STYLE_CHANNELS`；新增迁移后的 `SUBAGENT_INVOCATION_CHANNELS`。

**C. 模块级状态变量（第 878–939 行）DELETE**

`browserExtensionService`(878)、`clipperAssetBridge`(879)、`memoryCoreSupervisor`(900)、`knowledgeServiceSupervisor`(901)、`realityGatewayBridge`(905)、`perceptionGatewayBridge`(906)、`diaryGatewayBridge`(907)、`writingStyleGatewayBridge`(908)、`recordingStore`(914)、`recordingSegmentUploader`(915)、`privateAudioSync`(916)、`privateTranscriptionSync`(928)、`privateSyncScheduler`(929)、`transcriptionProcessingCoordinator`(930)、`screenshotOutbox`(956)、`screenshotScheduler`(962)、`visionOcrClient`(964)、`screenMemoryController`(967)、`screenMemoryPersistence`(965)、`screenMemoryControllerSummaryDispatch`(966)、`memoryCoreAiEnvApplied`(1565)、`knowledgeServiceAiEnvApplied`(1738)。
保留 `thesisFormatBridgeRef`(939)、`officeFilesBridge`(925)、`officePreviewRegistry`(933)、`saasClient`、`agentStatusReporter`、`sessionLeaseKeeper`、`aiRelayKeeper`、`remoteAgentCommandClient`、`agentNotificationBridgeServer`、`macosPushNotifications` 等。

**D. 函数体 DELETE（整段）**

| 行 | 函数 |
| --- | --- |
| 844–850 | `publishBrowserExtensionStatus` |
| 852–868 | `registerBrowserExtensionHandlers` |
| 957–962 | `captureAndQueueCurrentWindow`（连同其上的 `screenshotOutbox`） |
| 1146–1360 | `registerObsidianHandlers`（与 Obsidian 判定联动；若保留则 TRIM 掉 `roomId`/`memory` 参数） |
| 1577–1676 | `syncMemoryCoreEnvironment`（整体删） |
| 1704–1735 | runtime config 同步总入口里的 `syncMemoryCoreEnvironment(secrets)`(1724) 与 `syncKnowledgeServiceEnvironment(secrets)`(1726) 调用点 |
| 1740–1763 | `syncKnowledgeServiceEnvironment` |
| 2295–2329 | `registerContextRoomHandlers` → **TRIM**：只保留 4 个 subagent invocation 的 `handle(...)`，其余删 |
| 2757–2816 | `registerKnowledgeHandlers` |
| 2995–3015 | `registerIngestHandlers` |
| 3016–3062 | `registerAsrHandlers` |
| 3063–3079 | `registerPrivateAudioHandlers` |
| 3080–3102 | `openCloudMaterializeGate` / `waitForCloudMaterializeGate`（只服务云端转写 materialize） |
| 3120–3181 | `registerMemoryHandlers` |
| 3182–3217 | `registerRealityHandlers` |
| 3371–3405 | `registerPrivateTranscriptionHandlers` |
| 3406–3458 | `showScreenPermissionCard` |
| 3459–3552 | `registerScreenCaptureHandlers` |
| 3553–3633 | `registerScreenMemoryHandlers` |
| 3634–3644 | `computeDirectorySize`（只被 screen-memory storage 用） |
| 3645–3714 | `registerWritingStyleHandlers` |
| 3715–3812 | `registerPerceptionAndDiaryHandlers` |

**E. 函数体 TRIM（保留函数，删内部片段）**

- `registerFilesHandlers`（2863–2994）：删 4 个剪藏 `handle(...)` 及剪藏 payload 组装。
- `registerSourceHandlers`（1361–1503）：删 `listEvidence` / `previewFile` / `searchEvidence` 三个 `handle`（随 `evidence/` 判定）。
- `registerDocumentHandlers`（2605–2743）：`roomId` 参数**保留为可空透传**（网关 `documents` 仍以 roomId 作命名空间），但要确认不再有真实 Room id 来源。
- `registerMigrationHandlers`（2330–2351）：保留。
- `registerAccountHandlers`（3252–3347）：保留；确认 `aiRelayStatus` / `aiRelayVerdict` 不动。

**F. 启动链（`app.whenReady` 附近，4117–4660）DELETE 片段**

- `registerScreenMemoryHandlers()`(4172)、`registerScreenCaptureHandlers()`(4171 区)、`registerBrowserExtensionHandlers(...)`(4139) 及 `new BrowserExtensionService(dataDirectory)`(4133)+`start()`(4135)。
- `recordingStore = new RecordingStore(...)`(4178)、`recordingsDirectory`(4177)、`recordingSegmentUploader = new RecordingSegmentUploader(...)`(4181) 与其 `setPreviewListener`(4182–4189)+`cleanupAtStartup()`(4190)。
  - ⚠️ `saasClient = new SaasClient(credentials, app, recordingsDirectory, ...)`(4180) **KEEP**，但构造参数 `recordingsDirectory` 需要改成 `join(dataDirectory, 'recordings')` 或去掉该参数（取决于 `SaasClient` 构造签名；执行时改签名并同步测试 `tests/saas-client*.test.ts`）。
- `memoryCoreSupervisor = new MemoryCoreSupervisor(...)`(4222)+`start()`(4223)、`knowledgeServiceSupervisor = new KnowledgeServiceSupervisor(...)`(4229)+`start()`(4233)。
- `perceptionGatewayBridge = new PerceptionGatewayBridge(...)`(4354)、`screenMemoryControllerSummaryDispatch = ...`(4357)、`diaryGatewayBridge = ...`(4365)、`writingStyleGatewayBridge = ...`(4366)、`registerWritingStyleHandlers()`(4367)、`registerPerceptionAndDiaryHandlers()`(4369)、`perceptionGatewayBridge.getSettings()`(4370)、`screenshotScheduler.start(...)`(4372)、`screenMemoryController.ensureRunningState()`(4373)、`screenshotScheduler.updateInterval(...)`(4378)。
- `registerContextRoomHandlers(new ContextRoomGatewayBridge(gatewaySupervisor))`(4396) → 改为只注册 subagent invocation 通道。
- `realityGatewayBridge = ...`(4403)、`registerRealityHandlers(...)`(4404)。
- `registerMemoryHandlers(memoryGatewayBridge)`(4435)、`registerKnowledgeHandlers(...)`(4441)。
- `browserExtensionService?.setCaptureHandlers({...})`(4463)。
- `registerIngestHandlers(...)`(4480)。
- `privateTranscriptionSync = new PrivateTranscriptionSyncService(...)`(4542)+`initialize()`(4549)+`setMaterializeGate(...)`(4553)、`privateSyncScheduler = new PrivateSyncScheduler(...)`(4562)、`privateAudioSync.setEventResolver(...)`(4568)、`privateTranscriptionSync.materializeCached()`(4571)。
- `registerPrivateTranscriptionHandlers(...)`(4627)、`registerAsrHandlers(...)`(4628)、`registerPrivateAudioHandlers(...)`(4629)。
- **KEEP 且勿误删**：`registerObsidianHandlers`(4130)（视判定）、`installIpcRouters()`(4128)、`registerSystemClipboardHandler()`(4129)、`registerGatewayHandlers()`(4130 区)、`registerOpenConnectorHandlers()`、`AgentAuthController`(4141–4155)、`registerAgentAuthHandlers()`、`ai-relay:status/verdict`(4158–4162)、`createWindow()`(4163)、`CredentialStore`(4165–4166)、`startDesktopUpdater(saasClient)`(4191)、连接器栈(4192+)、`registerSourceHandlers(...)`(4655)。

**G. 退出清理（4663–4700、4720–4800）DELETE 对应 dispose**

`browserExtensionService?.stop()`+置空(4663–4664)、`realityGatewayBridge?.dispose()`(4684)、`perceptionGatewayBridge`/`diaryGatewayBridge` 置空(4685–4687)、`recordingStore?.dispose()`(4691)、`memoryCoreSupervisor?.shutdown()`(4697)、`knowledgeServiceSupervisor?.shutdown()`(4699)；`before-quit` 里的快照变量 `browserExtension`(4726)、`memoryCore`(4732)、`knowledgeService`(4733)、`realityBridge`(4741)、`recordings`(4742) 及其置空、`screenshotScheduler.stop()`(4775)、`screenMemoryController.dispose()`(4776)。

**H. 其他 `index.ts` 片段**

- `ipcMain.on(MEMORY_CHANNELS.onboardingFinished, ...)`(3122) DELETE。
- `ipcMain.on(SCREEN_CAPTURE_CHANNELS.startAppDrag, ...)`(3485) DELETE。
- `createWindow()` 内 macOS `setDisplayMediaRequestHandler`（系统音频采集，service 服务于转写）→ **TRIM**：若 RealityPage/录音链路整体删除，则整段删除；`setPermissionCheckHandler` / `setPermissionRequestHandler`（麦克风）也随录音链路删除。保留 `installCrossOriginIsolation`。
- `office-material-resolver` / `everroom-material://` 协议注册（4113 区）**KEEP**。

### 1.4 逐项判定（用户点名的 ambiguous 项）

| 目录 | 判定 | 理由 / 定论依据 |
| --- | --- | --- |
| `knowledge/` | **DELETE** | 纯 KnowledgeService 子进程守护 + LLM env；无幸存调用方 |
| `memory/` | **DELETE** | 纯 MemoryCore 子进程守护 + embedding env；`embedding-env.ts` 被 `knowledge/llm-env.ts` 使用，二者同删 |
| `asr/` | **DELETE** | 只落 `/v1/asr/jobs`（已删） |
| `transcription/` | **DELETE** | 只落 `/v1/processing/transcription-summary`（已删）与 SaaS 私有转写记录 |
| `screen-memory/` | **DELETE** | 全部落 `/v1/screen-memory/*`（已删） |
| `screenshot/` | **DELETE** | `screenshot-outbox.ts` 落 `/v1/perception/visual-observations`（已删）；`window-screenshot-service` 唯一消费方是截图调度与 screen-memory |
| `recording/` | **DELETE** | 录音会话/分段上传只服务 ASR 转写 |
| `browser-extension/`（clipper） | **DELETE** | 落 `/v1/clipper/captures*`（已删） |
| `cloud/` | **KEEP** | SaaS 账号/额度/ai-relay/配对/远程命令/通知桥全在 Agent 与账号范围内；**仅 `saas-client.ts` 需 TRIM**（见 1.2） |
| `evidence/` | **待确认（建议 DELETE）** | 它是**纯本地** markdown/文本解析 + sqlite 证据块（不依赖已删路由），唯一消费方是 `SOURCE_CHANNELS.listEvidence/previewFile/searchEvidence` → `SourceDrawer` 证据 Tab / `EvidenceSearch` / `EvidenceViewer`。**能定论的问题**：SourcesPage 是否保留「数据源 → 本地证据检索」视图？若 SourcesPage 只留「连接管理 + 文件库」则整目录删；若保留证据检索则保留（无需改动）。 |
| `obsidian/` | **待确认（建议 DELETE）** | 深度绑定 Room/memory：`mountMode: 'dedicated' \| 'memory'`、`roomId`、`memoryEnabled`、`memoryProjectionFileId`、`registryId`（见 `obsidian-vault-service.ts:365/374/395/398/400/494–522/643–681/719`），memory 挂载模式本质是向 MemoryCore 投影。幸存价值只剩「把笔记导入文件库」，与 `local-folder-connector` 重叠。**能定论的问题**：产品是否保留 Obsidian 笔记库数据源（`SourcesPage` 的 `ObsidianImportDialog`、`FolderSettingsOnboarding`、`ObsidianVaultMountMode` 是否保留）；若保留则必须 TRIM 掉 `'memory'` 挂载模式与 `roomId` 参数，并同步 `vault-document-sync.ts`、`OBSIDIAN_CHANNELS`、`preload`、`shared/obsidian.ts`。 |
| `vision-ocr/` | **DELETE** | 只服务屏幕记忆 OCR；同时删 `native/vision-ocr/`、`build/vision-ocr/`、`scripts/prepare-vision-ocr.mjs` 及其在 `package.json` `dev`/`build`/`prepare:vision-ocr` 脚本与 `extraResources` 中的引用 |

---

## 2. preload + shared

### 2.1 `src/preload/index.ts`（1067 行）

`const api: NxcoreDesktopApi` 内**整块删除**的命名空间（行号为 `api` 内块起点）：

| 行 | 命名空间 | 曾由谁 / 哪个网关端点支撑 |
| --- | --- | --- |
| 309–326 | `browserExtension` | `browser-extension:*` ↔ `BrowserExtensionService` ↔ `/v1/clipper/*` |
| 419–450 | `screenCapture`（含 `perceptionSettings`/`updateOnlineVlm`/`listPerceptionNodes`/`getPerceptionNode`/`retryPerceptionNode`/`deletePerceptionNode`） | `screen-capture:*`+`perception:*` ↔ `screenshotScheduler`+`PerceptionGatewayBridge` ↔ `/v1/perception/*` |
| 436–450 | `screenMemory` | `screen-memory:*` ↔ `ScreenMemoryController` ↔ `/v1/screen-memory/*` |
| 451–459 | `diary` | `diary:*` ↔ `DiaryGatewayBridge` ↔ `/v1/diary/*` |
| 460–475 | `writingStyle` | `writing-style:*` ↔ `WritingStyleGatewayBridge` ↔ `/v1/writing-style*` |
| 622–645 | `asr` | `asr:*` ↔ `AsrCoordinator` ↔ `/v1/asr/jobs` |
| 646–650 | `privateAudio` | `private-audio:*` ↔ `PrivateAudioSyncService` |
| 651–666 | `transcriptions` | `transcription:*` ↔ `PrivateTranscriptionSyncService` ↔ `/v1/processing/transcription-summary` |
| 675–713 | `memory` | `memory:*` ↔ `MemoryGatewayBridge` ↔ `/v1/memory*` |
| 714–738 | `reality` | `reality:*` ↔ `RealityGatewayBridge` ↔ `/v1/reality/*` |
| 913–969 | `knowledge` | `knowledge:*` ↔ `KnowledgeGatewayBridge` ↔ `/v1/knowledge*` |
| 1050–1066 | `ingest` | `ingest:*` ↔ `IngestGatewayBridge` ↔ `/v1/ingest/*` |
| 516–556 | `contextRooms` | **TRIM**：只保留 `getSubagentInvocation`/`cancelSubagentInvocation`/`listRunSubagentInvocations`/`listSubagentInvocationEvents`（建议移入新命名空间 `subagentInvocations`，调用方改 `window.nxcore?.subagentInvocations`） |
| 970–1027 | `files` | **TRIM**：删 `listClipCaptures`/`setClipCaptureFavorite`/`getClipCaptureDetail`/`getClipCapture` |
| 858–882 | `sources` | **TRIM**：删 `listEvidence`/`previewFile`/`searchEvidence`（随 `evidence/`）；其余随 SourcesPage |
| 883–912 | `obsidian` | **TRIM/整删**：随 §1.4 Obsidian 判定 |

**import 清理**（文件头部）：
- 删第 4 行 `import type { KnowledgeAttachInput, KnowledgeEntityStatus } from '../shared/knowledge'`
- 删第 20–27 行 `Memory*` 类型 import
- 删第 33 行 `import type { IngestPipelines } from '../shared/ingest'` → **注意**：`files.pickAndImport` 等仍在用 `IngestPipelines`（`shared/ingest.ts` 保留），所以是**保留**该 import 而不是删除
- 删第 30 行 `BrowserExtensionMessage, BrowserExtensionStatus`（若 `browserExtension` 整块删）
- 第 31 行 `isCursorCompletionAgentErrorPayload` **KEEP**
- 第 32 行 `AsrResult`、`RoomAgentSelectionRewriteInput`：`AsrResult` 随 asr 删；`RoomAgentSelectionRewriteInput` 随 `dispatchSelectionRewrite` 删，其余 `NxcoreDesktopApi` 等保留
- 删 `OIDC_LOGIN_CANCELLED_MESSAGE`? —— **KEEP**（账号 OIDC 仍用）
- `src/shared/i18n/desktop.ts` 的 `error.network.memory` / `error.network.knowledge` / `error.memoryUnreachable.*` 文案键与 `networkOperation()`（第 71–82 行）里的 `/memory/`、`/knowledge|wiki/` 分支 → **TRIM**（删分支与对应 i18n 键，否则 `tests/i18n.test.ts` 会因成为孤儿键而失败）。

### 2.2 `src/shared/**`

| 文件 | 判定 | 说明 |
| --- | --- | --- |
| `shared/knowledge.ts`（584 行） | **DELETE** | 全部 DTO 只服务 `/v1/knowledge*`；唯一外部消费者是 preload + context-room（同删） |
| `shared/memory.ts`（222 行） | **DELETE** | 同上；消费者：preload、`MemoryPipelineStatus`、`pages/memory/*`、`onboarding/*`、`context-room/ported/*` |
| `shared/writing-style.ts`（75 行） | **DELETE** | 消费者：`preload`、`main/gateway/writing-style-gateway-bridge.ts`、`pages/memory/WritingStylePane.tsx`、`agent/WritingStyleInsightBanner.tsx` |
| `shared/browser-extension.ts`（151 行） | **DELETE** | 消费者：preload、`main/browser-extension/*`、`main/gateway/files-gateway-bridge.ts`、`pages/InspirationPage.tsx`、`pages/FilesPage.tsx` |
| `shared/sources.ts`（1730 行） | **TRIM**（见 §5） | 巨型 DTO 文件；删 `reality`/`memory`/`knowledge`/`diary` 命名空间与 `reality-contract` re-export；保留 `documents`/`files`/`sources`/`agent`/`account`/`gateway` |
| `shared/ingest.ts`（173 行） | **TRIM** | 删 `IngestPipelines`（`{room,wiki,memory}`，见 §5）、`IngestResultDto`、`IngestFilterVerdictDto`、`IngestFilterRulesDto`、`FileImportOutcome.memoryResult`/`routeJobId`/`pipelines`；保留 `FileDto`/`FileCatalogDto`/`FileFormatCapabilityDto`/`FileImportAcceptedDto`/`FileImportOutcome`(其余)/`FileImportProgressEvent`/`HighRiskImport*`/`IngestEventDto`(若台账保留) |
| `shared/obsidian.ts`（110 行） | **TRIM/整删** | 随 §1.4 |
| `shared/agent-access.ts`、`agent-auth.ts`、`local-agents.ts`、`mcp.ts`、`external-calls.ts`、`migrations.ts`、`notifications.ts`、`open-connector.ts`、`office.ts`、`slides.ts`、`search.ts`、`cursor-completion.ts` | **KEEP** | 全部对应幸存网关模块 |
| `shared/i18n/locales/*.json`（desktop 主进程用） | **TRIM** | 删 `error.network.memory`、`error.network.knowledge`、`error.memoryUnreachable.*` 等随 `networkOperation()` 删除的键 |

---

## 3. renderer `apps/desktop/src/renderer/**`

### 3.1 整体删除（页面 + 组件 + 资源）

**页面（`components/pages/` 与顶级页面组件）**
- `components/pages/MemoryPage.tsx`
- `components/pages/WikiPage.tsx` + `WikiPage.css`
- `components/pages/InspirationPage.tsx` + `InspirationPage.css`（剪藏灵感页）
- `components/pages/RichClipMarkdown.tsx` + `RichClipMarkdown.test.tsx`（仅被 InspirationPage 使用；删后 `echarts`/`mermaid` 依赖可去）
- `components/pages/RoomPickerDialog.tsx`
- `components/pages/HomePage.tsx`、`DocsPage.tsx`、`FilesPage.tsx`、`SourcesPage.tsx`、`SettingsPage.tsx`、`useRoomAgentFiles.ts` → **不整删，见 3.2**

**目录整删**
- `components/pages/memory/`（16 个文件 + `MemoryPage.css` 2591 行）
- `components/context-room/`（整目录：`ContextRoomPage.tsx`、`ContextRoomStateProvider.tsx`、`RoomDocumentsProvider.tsx`、`RoomOverviewCitationControls.tsx`、`artifactCreateIntent.ts`、`contextRoomTabs.ts`、`knowledgeMarkdownImport.ts`、`roomMemoryChange.ts`、`roomOverviewChange.ts`、`roomOverviewCitation.ts`、`roomOverviewDiagnostics.ts`、`AllRoomsViewSkeleton.tsx`、`ContextRoomHomeSkeleton.*`、`ported/`（含 `ContextRoom.css` 16243 行、`ContextRoom.sels.tmp`））
  - ⚠️ **例外**：`context-room/ported/hooks/useRoomDocuments.ts` 的**文档事件合并逻辑**（`documentFromEvent`/`mergeRoomDocuments`/`replaceRoomDocuments`）在把 `HomePage`/`DocsPage` 改成工作区级文档源后可能仍需要。建议把该 hook 复制到 `components/documents/useWorkspaceDocuments.ts` 并改造，而不是直接丢弃。
- `components/diary/`（`DiaryPage.tsx` 1222 行、`DiaryPage.css`、`DiaryPageSkeleton.*`、`DiaryPage.test.tsx`）
- `components/reality/`（`RealityPage.tsx` 1034 行、`RealityPage.css`、`ScreenMemoryPanel.tsx`、`VisualPerceptionPanel.tsx`、`reality-event-state.ts`）
- `components/recording/`（`RecordingPage.tsx`、`RecordingPage.css`、`SpeakerLabel.*`）
- `components/graph/`（15 个文件：`PixiForceGraphCanvas.tsx`、`layout/forceGraph*`、`pixi/*`、`useForceGraphLayout.ts`）——唯一消费者是 `context-room/ported/*`
- `components/MemoryPipelineStatus.tsx` + `.css`
- `components/onboarding/MemoryOnboardingGate.tsx` + `.css`、`memoryOnboardingState.ts`
- `components/onboarding/RoomOnboardingGate.tsx` + `.css`、`roomOnboardingState.ts`、`roomUsageGuide.ts`
- `components/settings/ScreenMemorySettingsSection.tsx`、`components/settings/ScreenRecordingPermissionCard.tsx`
- `components/onboarding/ScreenRecordingPermissionOnboarding.tsx` + `.css`（截图/录音授权）
- `src/renderer/permission-card-entry.tsx`、`src/renderer/permission-card.html`
- `src/renderer/public/fonts/context-room/`
- `src/renderer/src/state/realitySettings.ts`
- `src/renderer/src/components/pages/sources/` **部分删除**（见 3.2）

**mock 入口（临时浏览器验证入口，随能力同删）**
`mock-ctxroom-home-entry.tsx`、`mock-room-entry.tsx`、`mock-thoughts-entry.tsx`、`mock-diary-entry.tsx`、`mock-reality-entry.tsx`、`mock-sources-entry.tsx`、`mock-overview-entry.tsx`（依赖 `context-room-app` token 作用域）、`mock-screen-perm-entry.tsx`。
**保留**：`mock-agent-office-entry.tsx`、`mock-agent-stress-entry.tsx`（需删其中 `contextRooms` mock 键）、`mock-composer-entry.tsx`、`mock-dispatch-card-entry.tsx`、`mock-files-entry.tsx`、`mock-gate-entry.tsx`、`mock-highrisk-entry.tsx`、`mock-qrcode-entry.tsx`、`mock-search-entry.tsx`、`mock-settings-entry.tsx`、`mock-toast-entry.tsx`。

### 3.2 需编辑（**TRIM**）

| 文件 | 手术内容 |
| --- | --- |
| `components/Sidebar.tsx` | 删 `MemoryPipelineStatus` import（第 7 行）与 `<MemoryPipelineStatus onNavigate={onNavigate} />`（第 173 行）。其余保留（含 gateway 状态、账号额度）。i18n 键 `surface:sidebar.minutesTranscriptionMinutesRemaining` 可改成中性文案（可选）。 |
| `src/data/navigation.ts` | `PageId` 删 `'rooms' \| 'recording' \| 'inspiration' \| 'memory' \| 'wiki' \| 'diary'`；`navigationSections` 删对应 item（`rooms`、`recording`、`sources`?见下、`memory`、`wiki`、`diary`）；`LEGACY_PAGE_LABEL_KEYS` 删 Context Room / Reality perception / Inspiration / Memory / Wiki / Diary 条目；清理不再使用的 lucide 图标 import（`BookOpen`、`BookOpenText`、`Brain`、`AudioLines`、`NotebookPen`）。 |
| `components/PageCanvas.tsx` | 删 `ContextRoomPage`/`DiaryPage`/`RealityPage` 的 lazy import 与 `page === 'rooms' \| 'diary' \| 'recording'` 分支、`reality-page-host` 兜底 div（第 129–141 行）；删 `contextRoomHomeRequest`/`onContextRoom*`/`memoryFocusId`/`agentDocumentFocus.roomId` 等 props；`if (page === 'inspiration')`、`if (page === 'memory')`、`if (page === 'wiki')` 删。`office-document`、`office`、`docs`、`files`、`sources`、`schedules`、`agent-connections`、`settings`、`home` 保留。 |
| `App.tsx`（1308 行） | 删：`ContextRoomStateProvider`/`RoomDocumentsProvider` 相关接线；`fullOnboardingStage` 的 `'memory'`/`'room'` 两阶段与 `markOnboardingStageCompleted('memory')`(1027–1028)、`setActivePage('rooms')`(565/587/593/943/983/1007)、`navigate('memory')`(1218/1237)、`fullOnboardingStageRef.current='memory'`(1279–1280)；`checkAutomaticOnboarding`(415+) 里的 `memoryApi`/`roomApi` 探测与 `apisAvailable` 条件（425–430）；agent 导航目标 `target.objectType === 'room'`(939) 与 `target.roomId ? 'rooms' : 'home'`(1001)；`if (activePage === 'rooms')` 系列分支(180–191/233/253/344–358)；`nxcore:reality:focus-event` 派发。**保留** `office-document`、`dock`、`SearchPalette`、账号/额度门、`RuntimeConfigGate`、`AgentPanel`。 |
| `components/TopBar.tsx` | 检查 `pageLabels[activePage]`（`PageId` 收窄后自然收敛）；无 Room/memory 专属分支则不动。 |
| `components/pages/HomePage.tsx` + `HomePage.css` | 删 `useContextRoomState`/`useRoomDocumentsState` 依赖，改用工作区级文档源（`window.nxcore.documents.list(null)` + `documents:subscribe`）；删「Context Room」快捷卡（第 188–226 行）、`recentRooms`、`roomTitle` 列；保留「最近文稿」「快速动作（新建/导入/打开 Agent）」等。`HomePage.css` 删 `.room-card`/`.room-grid`/`.room-glyph` 段。 |
| `components/pages/DocsPage.tsx` | 删 `useContextRoomState`/`useRoomDocumentsState`/`requestArtifactCreateIntent`/`saveRoomWorkspaceState`/`RoomPickerDialog` import；删 `roomFilter` 状态与筛选 UI、`roomTitleById`、`onOpenRoom`、`pickRoomForNewDocument`；`+新建文档` 改为直接 `documents.import({ roomId: null })` 或跳 `files`；`useRoomAgentFiles.ts` 要么改造成工作区级、要么删除。 |
| `components/pages/FilesPage.tsx`（821 行） | 删：`window.nxcore?.ingest` 用法与「台账」视图（第 146/226–232/652–673 行）、`describeMemory`（817–821）、`'memory'` 列定义（第 26 行）；删剪藏预览整段（`clipperPreview` 状态、`getClipCapture` 分支 483–489、674–720 的 dialog、`surface:files.clipper*` 文案、`nxcore-clipper-asset://` urlTransform）；`fileCategories.ts` 里的 `clipper` 分类过滤（第 296 行）需复查。**保留**：文件库列表、重命名/删除/定位、高风险复核、`everroom-material://` 预览、`openOriginal`、导入。 |
| `components/pages/SourcesPage.tsx`（844 行） | **TRIM（推荐）**：删 `'ingest'` 子页（第 93/702–730 行）与 `IngestFeed`、`FilterPreferenceGuideDialog`（依赖已删 `MEMORY_TAB_EVENT`）；证据相关 `EvidenceSearch`/`EvidenceViewer` 随 `evidence/` 判定。**保留**：连接卡（本地文件夹 / GitHub / Google Docs / Notion / Obsidian?）、`SourceDrawer`(裁剪证据 Tab)、`ReconnectAccountDialog`、`WebcalSubscriptionDialog`、`GitHubConnectDialog`、`MarkdownSourceDialog`。**注意**：`SourceIcon.tsx` 与 `sourceKinds.ts` **必须保留**——它们被幸存代码大量引用（`AgentComposer.tsx`、`office-editor/editor/ExternalExportDialog.tsx`、`DocumentHistoryPanel.tsx`、`ImportedCommentsPanel.tsx`、`settings/LocalAgentSettingsSection.tsx`、`onboarding/AgentMigrationOnboarding.tsx`）。 |
| `components/pages/fileCategories.ts`、`RichClipMarkdown.css`(若有) | 随 FilesPage/Inspiration 裁剪 |
| `components/pages/SettingsPage.tsx`（1035 行）+ `.css` | 删：`settings-reality` 段（904–956，转写服务/录音源/语言）、`ScreenMemorySettingsSection`(959)、`settings-capture` 段（961–1034，自动截图/权限卡/视觉理解/截图间隔/立即捕获）、`perceptionSettings` 状态与 `updateOnlineVlm`(144–145/434–437/991–999)、`realitySettings` import 与 `window.sessionStorage 'everroom:post-login-memory-check'`(318)。**保留**：接口/语言、引导、账号、文档编辑、连接器模式、MCP、本机 Agent、RuntimeConfig、用量预算、Token 用量、更新。 |
| `components/onboarding/` | 删 `MemoryOnboardingGate`、`RoomOnboardingGate`、`ScreenRecordingPermissionOnboarding`；`fullOnboardingState.ts` 的 stage 联合类型收窄为 `'folder' \| 'microphone' \| 'agents'`（`'screen'`/`'memory'`/`'room'` 删）；`OnboardingFlowChrome.tsx`、`FolderSettingsOnboarding.tsx`、`AgentMigrationOnboarding.tsx`、`MicrophonePermissionOnboarding.tsx`、`RuntimeConfigGate.*` **KEEP**（需删各自 Room/memory 分支与 `contextRoom:` 文案键引用）。 |
| `components/agent/agentNavigation.ts` | 第 13 行 `objectTypes` 集合删 `'memory'`、`'diary'`（`'room'`/`'source'` 视网关 §5 同步情况，建议一并删，与网关枚举对齐）；第 109/117 行分支同步。 |
| `components/AgentPanel.tsx` | 第 344 行 `objectType: 'room'` 的生产点删除/改为 `'document'`；第 8/856 行 `WritingStyleInsightBanner` import 与渲染删除。 |
| `components/agent/WritingStyleInsightBanner.tsx` | **DELETE**（writing-style 能力移除） |
| `components/agent/AgentExecutionTimeline.tsx` | 第 41/51 行 `ToolKind` 的 `'memory'` 只是工具分类词（非网关 objectType），**KEEP**（可选改名）。 |
| `components/office-editor/editor/TiptapSelectionRewrite.tsx` | 第 362 行 `window.nxcore?.contextRooms` → 改为新 `subagentInvocations` 命名空间；`selectionRewriteAgent.ts` 的 `SelectionRewriteBridge` 接口（11–13 行）中 `dispatchSelectionRewrite` 落 `/v1/context-rooms/selection-rewrite`（**已删**）→ 需决策：划线改写是 Office 编辑能力，若保留则必须找替代端点（当前网关无替代）→ **待确认**。能定论的问题：网关是否为 Office 划线改写保留/新增 dispatch 端点？若否，整条 `selectionRewriteAgent` / `TiptapSelectionRewrite` / 相关 toolbar 与测试一并删除。 |
| `components/office-editor/editor/ExternalImportDialog.tsx` | 使用 `contextRoom:externalImportDialog.hideImported`、`allImported` 两个键 → **KEEP 文件**，但这说明 **`contextRoom.json` 不能整删**，见 3.3。 |
| `components/office-editor/editor/DocumentOverviewCard.tsx` | 使用 `contextRoom:documentQuickView.*`（9 个键）→ 同上。注意其测试 `DocumentOverviewCard.test.tsx` 当前**失败**（见 §7）。 |
| `components/pages/useRoomAgentFiles.ts` | 随 DocsPage 改造；无 Room 后该 hook 语义失效 → 删除或重写为工作区级。 |
| `components/search/SearchPalette.tsx` | 检查结果类型 `memory`/`wiki`/`room` 是否仍在 `search:*` 范围内；若网关 `search` 模块已收窄则同步删对应筛选与图标。 |
| `src/renderer/src/styles.css`（3742 行） | 删 `.room-card`/`.room-grid`/`.room-meta`/`.room-stats`/`.room-glyph`/`.memory-symbol` 段（约 1056–1310）、`.room-picker-*` 段（1441–约 1660）、`.reality-page-host` 段（793–约 830）。保留 `.doc-search`(1670+)、文稿页工具栏等。 |
| `src/renderer/src/components/App.css`、`styles.css` 中 diary/reality 引用 | 随页面删除清理 |

### 3.3 i18n

| 文件 | 判定 |
| --- | --- |
| `src/renderer/src/i18n/locales/{zh-CN,en-US}/contextRoom.json`（2035 行 / 107KB） | **KEEP（必须）**：`contextRoom:` 命名空间被 **721 处** 非 context-room 目录代码引用，集中在 `office-editor/**`（`TiptapDocumentEditor.tsx`、`ExternalImportDialog.tsx`、`DocumentOverviewCard.tsx`、`TiptapBubbleToolbar.tsx`、`DocumentHistoryPanel.tsx`、`operations/*` 等）、`pages/RoomPickerDialog.tsx`、`onboarding/*`。**只能 TRIM**：删/保留由引用面决定；不建议在 2g-1~2g-3 阶段整删，否则 `office-editor` 大面积出现原始键。可留待后续单独一轮「contextRoom 命名空间瘦身」。 |
| `src/renderer/src/i18n/locales/*/memory.json`（425 行） | **DELETE**（仅 `pages/memory/*`、`MemoryPipelineStatus` 使用） |
| `src/renderer/src/i18n/locales/*/diaryReality.json`（17KB） | **DELETE**（仅 diary/reality/recording 页面使用） |
| `src/renderer/src/i18n/locales/*/search.json` | **KEEP**（SearchPalette 保留；需删 memory/room/wiki 结果类型键） |
| `src/renderer/src/i18n/locales/*/surface.json`（2035 行） | **TRIM**：删 `surface:files.clipper*`、`surface:files.memory*`、`surface:settings.{realityPerception,transcriptionService,recordingSource,transcriptionLanguages,windowScreenshots,automaticScreenshots,visualUnderstanding,screenshotInterval,captureNow,captureCurrentWindow}`、`surface:sidebar.minutesTranscription*`（可选）、`surface:sources.recentIngest`、`surface:home.contextRooms/noContextRooms`、`surface:docs.unknownRoom`、`surface:pageCanvas.loadingPerception` 等孤儿键 |
| `src/renderer/src/i18n/resources.ts` | 删 `memory`、`diaryReality` 命名空间注册；`contextRoom` **保留** |
| `src/renderer/src/i18n/locales/*/surface.json` 中 `agentChat.` | ⚠️ `tests/i18n.test.ts` 报 `surface:agentChat.` 缺失（来源 `SlidesProgressCard.test.tsx` 的动态拼接键）——**既有失败，非本次引入**，见 §7 |

### 3.4 renderer 内存/认识论相关 CSS 汇总

- DELETE：`ContextRoom.css`(16243)、`MemoryPage.css`(2591)、`WikiPage.css`(936)、`InspirationPage.css`、`DiaryPage.css`(1359)、`RealityPage.css`、`RecordingPage.css`、`SpeakerLabel.css`、`MemoryPipelineStatus.css`、`MemoryOnboardingGate.css`(821)、`RoomOnboardingGate.css`、`ContextRoomHomeSkeleton.css`、`graphShell.css`、`ScreenMemorySettingsSection.css`(若有)
- TRIM：`styles.css`（见 3.2）、`HomePage.css`、`FilesPage` 相关（`styles.css` 内 `clipper-preview-*`）、`AppToast.css`(KEEP)

---

## 4. 测试资产（`apps/desktop/tests/**`）

**DELETE（其测模块已删）**：`context-room-*.test.*`（27 个）+ `context-room-fixture.ts`、`knowledge-*.test.*`（5 个）、`memory-*.test.*`（5 个）、`atomic-memory-room.test.tsx`、`diary-gateway-bridge.test.ts`、`reality-*.test.*`（2）、`screenshot-outbox.test.ts`、`window-screenshot.test.ts`、`recording-segment-uploader.test.ts`、`asr-coordinator.test.ts`、`private-transcription-sync.test.ts`、`transcription-processing-coordinator.test.ts`、`browser-extension-popup-state.test.ts`、`embedding-env.test.ts`、`llm-env.test.ts`、`memory-core-config.test.ts`、`pixi-force-graph-renderer.test.ts`、`force-graph-layout.test.ts`、`use-force-graph-layout.test.tsx`、`graph-kernel-boundary.test.ts`、`link-graph-model.test.ts`、`entity-fact-graph-model.test.ts`、`room-graph-visuals.test.ts`、`room-*.test.*`（5）、`wiki-*.test.*`（2）、`obsidian-*.test.*`（2，随 Obsidian 判定）、`artifact-import.test.ts`、`artifact-create-intent.test.ts`、`screen-recording-permission-card.test.tsx`、`move-document-to-room-dialog.test.tsx`、`full-onboarding-state.test.ts`（TRIM 而非删）、`agent-room-overview-citation.test.tsx`、`knowledge-recommendation-run.test.tsx`、`cloud-source-drawer.test.tsx`（待确认：若 SourcesPage 保留连接抽屉则改写）、`sources-page-subpages.test.tsx`（改写为裁剪后形态）

**需改写（TRIM）**：`docs-page.test.tsx`（去掉 context-room mock）、`room-document-events.test.ts`（去掉 Room 语义，保留文档事件合并）、`agent-navigation.test.ts`（去 `'room'`）、`i18n.test.ts`（键集合随 locale 变更）、`files-page-refresh.test.tsx`、`file-categories.test.ts`（去 `clipper` 分类）、`use-async-data-refresh.test.tsx`（待确认，看是否引用 room）。

**KEEP（全部 Office/Agent/doc/connector/account 测试）**：`office-*.test.*`、`document-*.test.*`、`slides-*`、`thesis-*`、`agent-*.test.*`（除上列）、`local-agent-*.test.*`、`open-connector-*.test.*`、`oo-cli-bridge.test.ts`、`saas-*.test.ts`（TRIM 掉摘要标签用例）、`gateway-*.test.ts`、`migration`/`obsidian-vault`（随判定）等。

---

## 5. 网关阶段已造成的类型/契约漂移（必须先修，否则删完仍留半死代码）

### 5.1 `apps/desktop/src/shared/sources.ts`（1730 行）

| 行 | 内容 | 处理 |
| --- | --- | --- |
| 104–115 | `CreateRealityEventInput` / `FinishRealityCaptureInput` / `MarkRealityEventInput` / `RealityEvent` / `RealityEventType` / `RealityEventStatus` / `UpdateRealityTranscriptInput` import | DELETE |
| 1714–1730 | `export type { … } from '@nxcore/reality-contract'` re-export 块 | DELETE |
| 820 | `realityEventId?: string \| null`（在某 DTO 内） | 确认宿主 DTO 是否幸存；若宿主是 diary/reality 类型则随宿主删，否则删字段 |
| 1375–1391 | `NxcoreDesktopApi.reality` 整块 | DELETE |
| 1303–1331 | `NxcoreDesktopApi.asr` + `privateAudio` + `transcriptions` | DELETE |
| 1338–1374 | `NxcoreDesktopApi.memory` | DELETE |
| 1172–1211 | `NxcoreDesktopApi.screenMemory` + `diary` + `writingStyle` | DELETE |
| 1151–1171 | `NxcoreDesktopApi.screenCapture` | DELETE |
| 1008–1017 | `NxcoreDesktopApi.browserExtension` | DELETE |
| 1523–1592 | `NxcoreDesktopApi.knowledge` | DELETE |
| 1609–1610 | `files.delete()` 返回体的 `knowledgeCleanup: boolean`、`deletedMemoryDocuments: string[]` | DELETE（与 §1.2 files-gateway-bridge 同步） |
| 1664–end | `NxcoreDesktopApi.ingest`（`getFilterRules`/`updateFilterPreference`/`reinstateEvent`/`getEventContent`/`getPause`/`setPause`） | TRIM：保留 `listEvents`（若 FilesPage 台账视图保留）；否则整块删 |
| 1238–1266 | `NxcoreDesktopApi.contextRooms` | TRIM：只留 4 个 subagent invocation 方法（若改名，则从 `NxcoreDesktopApi` 移到新命名空间） |
| 1593–1644 | `NxcoreDesktopApi.files` | TRIM：删 4 个剪藏方法 |
| 1504–1522 | `NxcoreDesktopApi.sources` | TRIM：随 `evidence/` 判定 |
| — | `import type { Memory*, … } from './memory'`（约 1700–1713 行） | DELETE（随 `shared/memory.ts`） |

### 5.2 `src/main/gateway/files-gateway-bridge.ts`

- 第 285 行 `/v1/materials/:hash`：**幸存**（`everroom-material://` 回源）→ KEEP。
- 第 547 行 `/v1/perception/visual-observations`：**已删路由** → DELETE（方法 `registerVisualObservation`）。
- 剪藏 9 个方法（`/v1/clipper/*`）：**已删** → DELETE。
- `pipelines` 字段：`/v1/file-imports` 的 `metadata.pipelines` 在网关 `modules/files/routes.ts:295` **仍被解析并透传**，但下游（ingest）已删 → **静默无效果**。建议 desktop 侧停止发送 `pipelines`（`importAgentGeneratedFile` 862、`importArtifactFiles` 888），并把 `IngestPipelines` 从 `shared/ingest.ts` 删除；这是一个「双方都能编译但语义已死」的字段。

### 5.3 `src/main/gateway/reality-gateway-bridge.ts`

- 整文件 DELETE（`/v1/reality/events`、`/v1/reality/stream` 均已删）。其 DTO 从 `@nxcore/reality-contract` 引入 → desktop 侧该依赖随之清空（见 §6）。

### 5.4 `src/shared/knowledge.ts`

- 整文件 DELETE；同时清 `preload/index.ts:4`、`shared/sources.ts`（`Knowledge*` DTO 引用，如 `KnowledgeAttachInput`、`KnowledgePreferencesDto`、`EmergenceRequest`、`RouteMindmapActionInput`、`KnowledgeRuleDto`、`KnowledgeEntityStatus`）、`context-room/ported/*` 的引用。
- ⚠️ 注意 `context-room/ported/*` 被删时其 import 一并消失，所以只要顺序为「先删 context-room 再删 shared/knowledge」即可一次清干净。

### 5.5 Agent 活动 `objectType` 枚举

- 网关 `apps/gateway/src/modules/agent/routes.ts:64–71` 仍接受 `'room' | 'document' | 'source' | 'memory' | 'task' | 'diary'`；desktop `components/agent/agentNavigation.ts:13` 的白名单是同一集合。
- 建议（**网关 + 桌面需同 PR 或前后紧随**）：两端都收窄为 `'document' | 'task'`（`'source'`/`'room'`/`'memory'`/`'diary'` 已无生产者）。desktop 侧生产点只有 `AgentPanel.tsx:344` 的 `objectType: 'room'`。
- 若网关暂不改，desktop 侧至少不能**生产** `'room'`，否则导航会跳到已删页面。

---

## 6. `apps/desktop/package.json` 依赖

**依据：删除后按 `grep -rn "from '<pkg>'" src tests scripts` 复核，count=0 即可移除。**

| 依赖 | 唯一/主要消费者 | 判定 |
| --- | --- | --- |
| `@antv/g6` | `context-room/ported/components/emergence-graph/{g6FocusGraph.ts,FocusTreeCanvas.tsx}` | **DELETE** |
| `d3-force` + `@types/d3-force`(dev) | `components/graph/layout/forceGraphSimulation.ts` | **DELETE**；⚠️ 同时删 `electron.vite.config.ts:85` 的 `renderer.optimizeDeps.include: ['d3-force']` |
| `pixi.js`, `pixi-viewport` | `components/graph/PixiForceGraphCanvas.tsx`、`pixi/*` | **DELETE** |
| `gsap` | `context-room/ported/components/emergence-graph/{WalkJourneyCanvas,useGraphCamera,useGraphTransition}` + `components/diary/DiaryPage.tsx` | **DELETE** |
| `echarts`, `mermaid` | 仅 `components/pages/RichClipMarkdown.tsx`（动态 `import()`，grep 静态 import 为 0，需按文件名核） | **DELETE**（随 InspirationPage） |
| `@tencentdb-agent-memory/knowledge-service`, `@tencentdb-agent-memory/memory-tencentdb-v2` | 由主进程 spawn（`KnowledgeServiceSupervisor` / `MemoryCoreSupervisor`），grep import = 0 | **DELETE**；⚠️ 同步删 `package.json build.files` 中两行 `node_modules/@tencentdb-agent-memory/.../src/**` 与 `build.asarUnpack` 中 `sqlite-vec-*`（如仅 memory 使用），以及 §8 的 CI asar 断言 |
| `@nxcore/reality-contract` | `shared/sources.ts`、`main/gateway/reality-gateway-bridge.ts`、`main/transcription/private-transcription-sync.ts`、`main/cloud/saas-client.ts`（`RealityTag`） | **DELETE（桌面侧）**；`packages/reality-contract` 仍被网关 `modules/vision` 使用，**包不删** |
| `@codemirror/*`（commands/lang-markdown/state/view，5 个包） | grep = 0（无任何 import） | **DELETE（已冗余）** |
| `prosemirror-changeset` | grep = 0 | **DELETE（已冗余）** |
| `tar-stream` + `@types/tar-stream` | `main/migrations/openclaw-adapter.ts` | **KEEP** |
| `jszip` | `main/migrations/notion-zip-adapter.ts`、`main/office/xlsx-generation.ts` | **KEEP** |
| `docx` | office | **KEEP** |
| `qrcode` | `account/QrLoginPanel.tsx`、`agent/AgentAuthChallengeCard.tsx`、`SettingsPage.tsx` | **KEEP** |
| `axios` | 幸存 gateway bridges + `network/http-client.ts` + `cloud/*` | **KEEP** |
| `react-markdown` + `remark-gfm` | `AgentChatView`、`office-editor/MarkdownBody`、`RemoteAgentNotificationView`、`FilesPage`（+ 删除的 `pages/memory/MemoryMarkdown`、`RichClipMarkdown`） | **KEEP** |
| `better-sqlite3` + `@types/better-sqlite3` | `core/local-data-service.ts`、`evidence/evidence-service.ts`、`obsidian/obsidian-vault-service.ts`、`screen-memory` | **KEEP**（前三者均保留） |
| `ntn` | CLI 可执行（`resolveNtnCliExecutable`），非 import | **KEEP** |
| `ws` | gateway bridge / runtime（`electron.vite.config.ts` external） | **KEEP** |
| `npm` | `extraResources` 内置 npm | **KEEP** |
| `@sentry/*`、`electron*`、`react*`、`lucide-react`、`i18next`、`react-i18next`、`@tiptap/*`、`@radix-ui/*`、`@nxcore/{agent-contract,connector-contract,connectors-module,document-model,migration-kit}` | 大量幸存引用 | **KEEP** |

**待确认**：
- `build.asarUnpack` 的 `node_modules/sqlite-vec-{darwin-arm64,darwin-x64,windows-x64}/**` → 仅 MemoryCore/knowledge 使用 sqlite-vec；删除 `@tencentdb-agent-memory/*` 后需确认无其它 native 依赖它（`grep -rn "sqlite-vec" src` 当前为 0 → **建议 DELETE**）。
- `build.extraResources` 的 `build/vision-ocr` 条目与 `scripts/prepare-vision-ocr.mjs` → 随 `vision-ocr/` 删除；`package.json` 的 `dev`/`build` 脚本首行 `node scripts/prepare-vision-ocr.mjs &&` 与 `prepare:vision-ocr` 脚本一并删。

---

## 7. 验证配方（无 pnpm）

### 7.1 类型检查（覆盖范围经核实）

```bash
cd /Users/zyt/EverOffice_office/apps/desktop
fnm exec --using=22.22.1 node /Users/zyt/EverOffice_office/node_modules/.pnpm/typescript@5.6.2/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

**覆盖范围（已核实 `apps/desktop/tsconfig.json`）**：`include: ["src", "electron.vite.config.ts"]`，无 `references`、无 `extends`。因此**单个 tsconfig 同时覆盖 main + preload + renderer + shared**（`src/main/**`、`src/preload/**`、`src/renderer/**`、`src/shared/**`），外加 `electron.vite.config.ts`。
**不覆盖**：`tests/**`、`scripts/**`、`vitest.config.ts`、`vite.browser.config.mts`、`vite.gate-mock.config.mts`、`vendor/**`。
`paths` 已含 `@/* → src/renderer/src/*` 与 4 个 `@nxcore/*` submodule 映射；jsx=react-jsx、noEmit、strict。

**当前基线（本次实跑，`EXIT=2`）**：**10 个错误，全部集中在 1 个文件**
`src/renderer/src/components/context-room/ported/components/detail-panels/ThoughtsPane.tsx`
- `(54,5)` TS2339 `focusResult` 不存在
- `(54,32)` TS2339 `focusLoading` 不存在
- `(55,58)` TS2353 `'locked'` 不在 `UseEmergenceOptions`
- `(61,73)` `(64,64)` `(93,76)` `(98,15)` `(174,37)` TS7006 参数隐式 any（node/card/candidate）
- `(179,17)` `(245,17)` TS2322 `Map<unknown,unknown>` 不能赋给 `Map<string,string>`

→ **该文件属于本次 DELETE 范围**（context-room）。因此 2g-1~2g-3 完成后 typecheck 的期望是 **0 error**；若出现新错误，一定是本次改动引入。

### 7.2 桌面测试

Vitest 入口（本仓库实际路径）：
```
/Users/zyt/EverOffice_office/node_modules/.pnpm/vitest@4.1.10_@opentelemetry+api@1.9.1_@types+node@22.20.1_happy-dom@20.11.2_vite@6.4.3_c5cc40c9ca79b24c845722825a784986/node_modules/vitest/vitest.mjs
```

全量（`apps/desktop` 为 cwd，`vitest run`，**含 `vendor/genoffice/**`**）：
```bash
cd /Users/zyt/EverOffice_office/apps/desktop
fnm exec --using=22.22.1 node "<上面 vitest.mjs 路径>" run
```
**基线（本次实跑，`EXIT=1`）**：
- Test Files：**153 failed | 761 passed | 1 skipped (915)**
- Tests：**785 failed | 8342 passed | 15 skipped (9142)**
- Duration：89.2s（transform 68.0s / setup 14.6s / import 377.0s / tests 220.1s）
- 失败文件分布：**134 个在 `vendor/genoffice/**`**（无关既有失败：`apps/docs` 82、根 20、`apps/slides` 15、`apps/pdf` 10、`apps/markdown` 6、`packages/docx-engine` 1），**18 个在 `tests/`**，**1 个在 `src/renderer/.../office-editor/`**。
- ⚠️ 根因是 `apps/desktop/vitest.config.ts` **没有配置 `include`**，默认 glob 会扫到 `vendor/genoffice/**`。

桌面自有信号（排除 vendor，**推荐作为执行期的对照基线**）：
```bash
cd /Users/zyt/EverOffice_office/apps/desktop
fnm exec --using=22.22.1 node "<vitest.mjs 路径>" run --exclude 'vendor/**' --exclude '**/node_modules/**'
```
**基线（本次实跑，`EXIT=1`）**：Test Files **19 failed | 219 passed (238)**；Tests **37 failed | 1426 passed (1463)**；19.3s。

**19 个失败文件与失败数（桌面自有）**：
| 文件 | 失败/总数 | 备注 |
| --- | --- | --- |
| `src/renderer/src/components/office-editor/editor/DocumentOverviewCard.test.tsx` | 5/7 | 断言 `documentQuickView.*` 原始键；实际渲染出中文文案 → **既有失败**（幸存 Office 代码） |
| `tests/agent-room-overview-citation.test.tsx` | 6/7 | context-room 相关 → 将删 |
| `tests/cloud-source-drawer.test.tsx` | 3/5 | SourcesPage 抽屉 → 待改写 |
| `tests/i18n.test.ts` | 1/12 | 缺 40 个键：38 个 `contextRoom:emergence.*` 等（随 context-room 消失）+ `surface:agentChat.`（`SlidesProgressCard.test.tsx` 动态键）+ `contextRoom:externalImportDialog.{hideImported,allImported}`（**幸存 office-editor 正在用**，删 `contextRoom.json` 会加剧） |
| `tests/office-preview-registry.test.ts` | 1/31 | `registry.openTest is not a function` → **既有失败**（幸存 Office 代码） |
| `tests/document-comments-panel.test.tsx` | 1/5 | 折叠期渲染断言 → **既有失败**（幸存） |
| `tests/document-comments-anchor-marks.test.tsx` | 1/8 | 同上 → **既有失败**（幸存） |
| `tests/document-image-assets.test.ts` | 1/4 | resizable image node view 配置 → **既有失败**（幸存） |
| `tests/context-room-memory-pane.test.tsx` | 1/7 | 将删 |
| `tests/context-room-pane-object-detail.test.tsx` | 1/3 | 将删 |
| `tests/context-room-snapshot.test.ts` | 1/5 | 将删 |
| `tests/knowledge-recommendation-run.test.tsx` | 2/9 | phase 期望 `importing` 实得 `timeout` → 将删 |
| `tests/room-creation-studio.test.tsx` | 1/4 | 将删 |
| `tests/sources-page-subpages.test.tsx` | 3/6 | 待改写 |
| `tests/obsidian-source-discovery.test.tsx` | 1/3 | 随 Obsidian 判定 |
| `tests/transcription-processing-coordinator.test.ts` | 1/8 | 将删 |
| `tests/graph-kernel-boundary.test.ts` | 1/2 | 将删 |
| `tests/pixi-force-graph-renderer.test.ts` | 3/25 | 将删 |
| `tests/use-force-graph-layout.test.tsx` | 3/12 | 将删 |

**执行期判读规则**：清理完成后，桌面自有失败数应降到 **4~6 个**（即上表里标记「既有失败（幸存）」的 `DocumentOverviewCard` 5 个 + `office-preview-registry` 1 个 + `document-comments-*` 2 个 + `document-image-assets` 1 个 + `i18n` 中残留键），且 **不得出现新的失败文件**。建议在 2g-1 之前先把「幸存基线」跑一遍存档，作为回归对照。

### 7.3 编译产物验证（可选，用于 2g-4）

```bash
cd /Users/zyt/EverOffice_office/apps/desktop
fnm exec --using=22.22.1 node node_modules/electron-vite/bin/electron-vite.js build
```
（`pnpm run build` 等价；`build` 脚本会先跑 `prepare-vision-ocr.mjs` 与 `prepare-genoffice-runtime.mjs`，前者在 2g-4 删除后需同步改脚本。）

---

## 8. 配置 / 脚本 / CI（2g-4 内容）

| 文件 | 处理 |
| --- | --- |
| `apps/desktop/package.json` | §6 依赖删减；`build.files` 删两行 `@tencentdb-agent-memory/**`；`build.asarUnpack` 删 `sqlite-vec-*`（待确认）；`build.extraResources` 删 `build/vision-ocr` 条目；`mac.extendInfo` 的 `NSMicrophoneUsageDescription`/`NSAudioCaptureUsageDescription` 随录音链路删除（**保留 `NSDocumentsFolderUsageDescription`/`NSDesktopFolderUsageDescription`**）；`scripts` 删 `prepare:vision-ocr` 并改 `dev`/`build` 首段 |
| `apps/desktop/electron.vite.config.ts` | 删 `renderer.optimizeDeps.include: ['d3-force']`；`permission-card` rollup input 随 `permission-card.html` 删除；`preload/main` 配置不动 |
| `apps/desktop/vitest.config.ts` | 建议加 `test.include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}']`，把 `vendor/genoffice/**` 排除，避免每次全量 915 文件（与本清理无关但强烈建议） |
| `apps/desktop/scripts/prepare-vision-ocr.mjs` | DELETE |
| `apps/desktop/native/vision-ocr/`、`build/vision-ocr/` | DELETE |
| `apps/desktop/scripts/verify-windows-package.mjs` | 第 72 行 TS 白名单 `@tencentdb-agent-memory` 例外删除；第 81–90 行「bundled memory runtimes」断言与「Windows native packages for the memory stack」断言删除 |
| `.github/workflows/release-desktop.yml` | 第 228 行 `unexpected_typescript` 的 `@tencentdb-agent-memory` 例外分支删除；第 231–233 行三条 memory/knowledge asar 断言删除。⚠️ 这三条是 `grep -Fq` **断言必存在**，不删会直接让发版失败 |
| `apps/desktop/vite.browser.config.mts` | 内联 `nxcore.js` mock 里的 `contextRooms`/`knowledge`/`memory`/`screenMemory` 分支与 Notion/Context Room 示例数据 → TRIM（该文件自称「验证后删除」） |
| `apps/desktop/vite.gate-mock.config.mts` | 最小 mock，保留 |
| `packages/reality-contract/` | **不删**（网关 `modules/vision` 仍用）；仅 desktop 解除依赖 |
| `pnpm-workspace.yaml` / 根 `package.json` | 无需改动（`typecheck` 脚本仍含 `@nxcore/reality-contract`，保留） |

---

## 9. 建议执行顺序（可独立验证的提交）

> 每步都以「`tsc --noEmit` 无新增错误 + 桌面自有 vitest 无新增失败」为验收。

### 2g-1 主进程服务与桥（风险：中）
1. 删 18 个纯废弃目录/文件（§1.1）+ 9 个再删桥中的 8 个（`knowledge`/`memory`/`reality`/`diary`/`perception`/`ingest`/`asr`/`writing-style`）。
2. `context-room-gateway-bridge.ts`：迁移 4 个 subagent invocation 方法 → 新建 `subagent-invocations-gateway-bridge.ts`；其余删除。
3. `files-gateway-bridge.ts` / `runtime-config-bridge.ts` / `agent-gateway-bridge.ts` / `saas-client.ts` 按 §1.2 TRIM。
4. `index.ts` 按 §1.3 逐段删（常量组 → `channelGroups` → 状态量 → 函数 → 启动链 → 退出清理）。
5. 删 `native/vision-ocr/`、`build/vision-ocr/`、`scripts/prepare-vision-ocr.mjs`。
**风险**：`index.ts` 4800 行、启动链交错（`saasClient` 构造依赖 `recordingsDirectory`）；`before-quit` 快照变量漏删会造成「引用已置空变量」编译错误。**验收**：`tsc` 后 `src/main/**` 不应再有 `memory|knowledge|context-rooms|reality|perception|diary|asr|screen-memory|clipper` 字面路由。

### 2g-2 preload + shared DTO（风险：低-中）
1. `preload/index.ts` 删 §2.1 命名空间与 import；`contextRooms` 迁移 4 方法；`files`/`sources`/`obsidian` TRIM。
2. 删 `shared/{knowledge,memory,writing-style,browser-extension}.ts`；TRIM `shared/sources.ts`（§5.1）、`shared/ingest.ts`（§5.5/§5.2）、`shared/obsidian.ts`。
3. 清 `shared/i18n/locales/*.json` 中 `error.network.memory|knowledge`、`error.memoryUnreachable.*`，同步删 `preload` 的 `networkOperation()` 分支。
**风险**：`shared/sources.ts` 是 1730 行巨型类型文件，`NxcoreDesktopApi` 一处漏改会让 renderer 大面积 TS2339（这其实是好事：编译期就能定位）。**验收**：`tsc` 仅剩 renderer 侧的引用错误（2g-3 处理）。

### 2g-3 renderer 页面/路由/导航/文案（风险：高，工作量最大）
1. 删 §3.1 页面与目录；改 §3.2 表格逐项 TRIM。
2. `data/navigation.ts` → `PageCanvas.tsx` → `App.tsx` → `Sidebar.tsx` 依序收窄 `PageId`（从叶子到根，避免中间态）。
3. i18n：删 `memory.json`/`diaryReality.json`，`resources.ts` 去注册，`surface.json` TRIM；**`contextRoom.json` 保留**（§3.3）。
4. 删/改写 §4 测试资产。
**风险最高**：`HomePage`/`DocsPage` 目前通过 `ContextRoomStateProvider`+`RoomDocumentsProvider` 取文档，删 Room 后需要新建「工作区级文档源」（`documents.list(null)` + `documents:subscribe` + 事件合并逻辑取自 `context-room/ported/hooks/useRoomDocuments.ts`）。建议把它作为本提交内的**独立小步**（先落地新 provider 并让 DocsPage/HomePage 切过去，再删 context-room），否则中间态无法编译。
**次高**：`TiptapSelectionRewrite` 依赖已删的 `/v1/context-rooms/selection-rewrite`——先在 2g-1 定论「是否保留划线改写」，再决定本步删还是改。

### 2g-4 依赖 + 配置 + CI/asar 断言（风险：低，但漏改会卡发版）
1. `package.json` 依赖与 `build.*` 三段（§6、§8）。
2. `electron.vite.config.ts` 去 `d3-force` 与 `permission-card` input。
3. `scripts/verify-windows-package.mjs`、`.github/workflows/release-desktop.yml` 的 memory asar 断言。
4. 建议顺带给 `vitest.config.ts` 加 `include`。
5. 复核：`grep -rn "tencentdb\|vision-ocr\|reality-contract\|@antv/g6\|pixi" apps/desktop/{src,scripts,package.json}` 应为空（允许 `packages/reality-contract` 与根 `package.json` typecheck 保留）。
**验收**：`electron-vite build` 通过；asar 清单无 `@tencentdb-agent-memory`。

### 建议拆成两个可选尾单
- **2g-5**：`contextRoom.json` 命名空间瘦身（把 `office-editor` 实际使用的键迁到 `office`/`surface` 命名空间，再删废弃键）。独立可验证：`tests/i18n.test.ts` 通过。
- **2g-6**：网关 `agent/routes.ts` 的 `objectType` 枚举收窄，与 desktop `agentNavigation.ts` 同步。

---

## 10. 一页速查（按判定聚合）

**DELETE（整目录/整文件）**
`main/{memory,knowledge,asr,transcription,recording,screen-memory,screenshot,vision-ocr,browser-extension}`、`main/gateway/{knowledge,memory,reality,diary,perception,ingest,asr,writing-style}-gateway-bridge.ts`、`shared/{knowledge,memory,writing-style,browser-extension}.ts`、renderer `components/{context-room,diary,reality,recording,graph}`、`components/pages/{MemoryPage,WikiPage,InspirationPage,RoomPickerDialog,RichClipMarkdown}`、`components/pages/memory/`、`components/{MemoryPipelineStatus,onboarding/MemoryOnboardingGate,onboarding/RoomOnboardingGate,settings/ScreenMemorySettingsSection,settings/ScreenRecordingPermissionCard,onboarding/ScreenRecordingPermissionOnboarding}`、`permission-card.html|entry.tsx`、`public/fonts/context-room/`、i18n `{memory,diaryReality}.json`、`native/vision-ocr/`、`scripts/prepare-vision-ocr.mjs`。

**TRIM（保留文件，删片段）**
`main/index.ts`（§1.3 A–H）、`main/gateway/{context-room(subagent 迁移),files,runtime-config,agent}-gateway-bridge.ts`、`main/cloud/saas-client.ts`、`main/core/local-data-service.ts`（随 evidence 判定）、`preload/index.ts`（§2.1）、`shared/{sources,ingest,obsidian}.ts`、renderer `{Sidebar,PageCanvas,App,HomePage,DocsPage,FilesPage,SourcesPage,SettingsPage,onboarding/*,agent/agentNavigation,agent/AgentPanel,TiptapSelectionRewrite}`、`styles.css`/`HomePage.css`/`surface.json`/`resources.ts`、`vite.browser.config.mts`、`verify-windows-package.mjs`、`release-desktop.yml`。

**KEEP（含内部小 TRIM）**
`main/{office,gateway(其余桥),connectors,agent-access,agent-auth,local-agents,core,logging,monitoring,network,migrations,security,cloud}` + `index.ts` 顶部 KEEP 文件、`updater.ts`、`document-*`、`file-format-policy.ts`、`cross-origin-isolation.ts`、`high-risk-import-coordinator.ts`、`system-clipboard.ts`、`desktop-locale.ts`、`process-cleanup.ts`；`shared/{agent-access,agent-auth,local-agents,mcp,external-calls,migrations,notifications,open-connector,office,slides,search,cursor-completion,sources(TRIM),ingest(TRIM)}`；renderer `office-editor/`、`agent/`(去 writing-style banner)、`pages/{AgentStatusPage,AgentSchedulesPage,AgentConnectionsPage,ConnectorSyncPage,ConnectorConsolePage,ConnectorDocumentImportPanel,PageHeader,PelicanRider}`、`pages/sources/{SourceIcon,sourceKinds,SourceDrawer(TRIM),...}`、`settings/`(去 screen-memory)、`search/`、`ui/`、`account/`、`onboarding/`(去 memory/room/screen 三 gate)、i18n `{contextRoom,surface(TRIM),search}.json`。

**待确认（3 项）**
1. `main/evidence/` + `SourceDrawer` 证据 Tab：定论 = SourcesPage 是否保留「本地证据检索」视图。
2. `main/obsidian/`（含 `vault-document-sync.ts`）：定论 = 是否保留 Obsidian 笔记库数据源；保留则必须删 `mountMode:'memory'`/`roomId`/`memoryProjectionFileId`/`registryId`。
3. `components/office-editor/editor/{selectionRewriteAgent,TiptapSelectionRewrite}`：定论 = 网关是否为 Office 划线改写保留/新增 dispatch 端点（当前 `/v1/context-rooms/selection-rewrite` 已删，无替代）。

---

## 附：本次审计实跑命令与结果留档

```text
# 类型检查（EXIT=2）
fnm exec --using=22.22.1 node …/typescript@5.6.2/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
→ 10 error / 1 file（ThoughtsPane.tsx）

# 全量测试（EXIT=1）
fnm exec --using=22.22.1 node …/vitest@4.1.10_…/node_modules/vitest/vitest.mjs run
→ Test Files 153 failed | 761 passed | 1 skipped (915)
→ Tests     785 failed | 8342 passed | 15 skipped (9142)

# 桌面自有测试（EXIT=1，推荐基线）
fnm exec --using=22.22.1 node …/vitest/vitest.mjs run --exclude 'vendor/**' --exclude '**/node_modules/**'
→ Test Files 19 failed | 219 passed (238)
→ Tests      37 failed | 1426 passed (1463)
```