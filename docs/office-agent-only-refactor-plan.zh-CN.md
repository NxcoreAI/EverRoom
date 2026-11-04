# 只保留 Office + Agent：移除记忆与 Context Room 的可执行改造计划

> 版本：v1 · 2026-10-23 · 状态：执行中
> 范围：`NxcoreAI/EverRoom`（`nxcore-ce`）monorepo
> 前置审计：行号以 2026-10-23 工作区（起点 `3cbfc289`）为准。
> 关联文档：[agent-architecture-optimization-plan.zh-CN.md](./agent-architecture-optimization-plan.zh-CN.md)、[agent-document-development-sop.md](./agent-document-development-sop.md)

---

## 0. 目标与终态

**保留**：Office（文档 / 表格 / 幻灯片 / PDF 的生产、编辑、预览、导入导出）与 Agent（会话、调度、子 Agent、连接器、通知）。

**移除**：记忆（MemoryCore / 屏幕记忆 / 知识库 Wiki / 实体 / 写作风格画像）与 Context Room（房间、总览、纠错、合并、任务夹），以及只为它们供料的采集管线（现实感知、转写、摄取、素材、剪藏、日记）。

**终态关键判据**（Phase 0 完成的定义）：

1. 用户能在没有 Room 概念的前提下新建文稿 → Agent 写入 → 审阅 patch → 导出 docx/pptx/xlsx；
2. Agent 会话能正常创建、流式、取消、派发子 Agent，且工具面里不含任何 `memory_*` / `wiki_*` / `conversation_search` / `context_room_*` / `room_*`；
3. `pnpm typecheck` 与保留后的 `pnpm test` 全绿；
4. 代码里不存在对 `modules/{memory,knowledge,context-rooms,screen-memory,perception,reality,ingest,diary}` 的任何 import。

**非目标**：连接器（OpenConnector / 飞书 / Notion）、SaaS 登录与云同步、本地文件与 GitHub 源接入——这些照旧。

### 0.1 需产品/架构拍板的 3 项（已按建议默认执行）

| # | 议题 | 决策 |
|---|---|---|
| D1 | 文稿的容器模型。现状：`documents` 表无 `room_id`，容器关系在多对多表 `room_doc_links(room_id, document_id, folder_id)` 上 | 去掉房间维度，`docs` 页作为唯一文稿入口，保留任务夹作为轻量分组；`room_doc_links` 随迁移 drop |
| D2 | 「新文档写作路线导图」（`route_mindmap_*`），素材 100% 来自 Room 三图谱 | 一并删除 |
| D3 | `agents/cursor-completion`（文档光标补全），功能属 Office、命名带 Room 前缀 | 保留功能，重命名为 `document-cursor-completion` |

---

## 1. Phase 0：划界

### P0-1 迁出寄生在 `components/context-room/` 里的 Office 编辑器 —— 已完成第一刀

`git mv` 后的新布局（分支 `refactor/office-agent-only`）：

| 新路径 | 内容 |
|---|---|
| `apps/desktop/src/renderer/src/components/office-editor/editor/` | 原 `context-room/ported/components/detail-editor/` 全部 69 个文件（Tiptap 编辑器、块引用、块索引标记、批注锚点、导入导出对话框、划词改写 UI、历史 diff） |
| `apps/desktop/src/renderer/src/components/office-editor/embeddedOffice.ts` | 原 `ported/embeddedOffice.ts`，Office 实例仲裁 |
| `apps/desktop/src/renderer/src/components/office-editor/officeViewport.ts` | 原 `ported/officeViewport.ts`，Office 视口挂载 |

同步改写的引用：44 个外部文件（含 `App.tsx`、`DocsPage`、`mock-overview-entry`、`tests/**` 共 35 个测试文件），旧路径 0 残留。

**验证结果**：`tsc --noEmit` 与基线完全一致（10 个错误，全部是 `detail-panels/ThoughtsPane.tsx` 的存量错误）；编辑器相关 41 个测试文件、298 个用例中，3 个失败（`document-image-assets`、`document-comments-panel`、`document-comments-anchor-marks`）经 stash 对比确认**为基线既有失败**，与本次搬移无关。

**P0-1 后续（已完成的部分，2026-10-23）**：

| 反向依赖 | 处理 | 状态 |
|---|---|---|
| `context-room/operations/*`（文档操作中心 / 审阅 / 续写，18 文件） | 迁到 `office-editor/operations/` | 已完成 |
| `ported/types.ts`、`ported/adapters.ts` | 迁到 `office-editor/`（`ContextRoom*` 类型改名留到 P0-3） | 已完成 |
| `ported/components/shared.tsx` | 迁到 `office-editor/shared.tsx` | 已完成 |
| `ported/components/detail-panels/MarkdownBody(.test).tsx` | 迁到 `office-editor/` | 已完成 |
| `ported/components/MoveDocumentToRoomDialog` | 从 `TiptapDocumentActions` 摘除菜单项/状态/对话框 | 已完成 |
| `@/components/context-room/RoomDocumentsProvider` | P0-2 用工作区维度文稿库 Provider 替换 | **待做（P0-2 第一件事）** |

另注：`office-editor` 内 34 个文件仍含 `context-room-*` CSS 类名与 `contextRoom:` i18n key（纯样式/文案，不影响编译），在 Phase 2 收尾时统一改名，避免与 `styles.css` 大改混在同一次提交里。

### P0-2 文档域去 roomId

**问题**：`roomId` 已渗入文档内核——`capabilities/*.ts` 113 处、`service.ts` 41 处、`routes.ts` 13 处、`mcp-host.ts` 8 处。

**做法**：

1. `documents` 的表结构不动（本就无 `room_id`）；`room_doc_links` 随迁移 drop（见 §5）。
2. 文档权限判据从「同房间」改为「同工作区」：
   - `service.ts:795-847` 的 `assertRoomAccess` / `readDocumentForAgent(documentId, roomId)` → `readDocumentForAgent(documentId)`；
   - `service.ts:1056-1064` 的 `document.roomId !== input.roomId` 校验删除；
   - `mcp-host.ts:377` 的 `bound.roomId !== request.roomId` 门禁删除；
   - `mcp-host.ts:179-181` 的 `roomExists()` 删除。
3. 列表与回收站按工作区收敛：`service.ts:311` `list(roomId, …)` → `list(options)`；`service.ts:1121` `emptyTrash(roomId)` → `emptyTrash()`；`routes.ts:36-56`、`:303-307` 的 `roomId` query 参数删除。
4. `routes.ts:459` 的 WS `document.ready` 去掉 `roomId` 字段。
5. `service.ts:322-334` 的 `move(fromRoomId, roomId)` 改为 `moveToFolder(documentId, folderId | null)`。
6. `capabilities/` 各 plugin 的 `roomId` 参数逐个摘除（以 `rg roomId apps/gateway/src/modules/documents/capabilities` 收敛到 0 为验收）。

### P0-3 工具改名（25 个 `context_room_*`）

| 旧名 | 新名 | 归属 | 定义位置（起点） | 状态 |
|---|---|---|---|---|
| `context_room_list` | — 删除 | Room | query-plugin | ✅ 已删（Phase 2d-3） |
| `context_room_create` | — 删除 | Room | query-plugin | ✅ 已删（Phase 2d-3） |
| `context_room_document_list` | `document_list` | Office | query-plugin.ts:102 | ✅ 已改 |
| `context_room_document_read` | `document_read` | Office | query-plugin.ts:127 | ✅ 已改 |
| `context_room_document_delete` | `document_delete` | Office | delete-plugin.ts:20 | ✅ 已改 |
| `context_room_document_comment_add` | `document_comment_add` | Office | comment-plugin.ts:40 | ✅ 已改 |
| `context_room_write_begin` | `document_write_begin` | Office | create-plugin.ts:49 | ✅ 已改 |
| `context_room_write_append` | `document_write_append` | Office | create-plugin.ts:123 | ✅ 已改 |
| `context_room_write_commit` | `document_write_commit` | Office | create-plugin.ts:246 | ✅ 已改 |
| `context_room_write_abort` | `document_write_abort` | Office | create-plugin.ts:319 | ✅ 已改 |
| `context_room_patch_begin` | `document_patch_begin` | Office | review-plugins.ts:438 | ✅ 已改 |
| `context_room_patch_hunk` | `document_patch_hunk` | Office | review-plugins.ts:505 | ✅ 已改 |
| `context_room_patch_commit` | `document_patch_commit` | Office | review-plugins.ts:808 | ✅ 已改 |
| `context_room_patch_abort` | `document_patch_abort` | Office | review-plugins.ts:884 | ✅ 已改 |
| `context_room_office_create` | `office_create` | Office | office-plugin.ts:176 | ✅ 已改 |
| `context_room_slides_create` | `slides_create` | Office | office-plugin.ts:231 | ✅ 已改 |
| `context_room_slides_set_page` | `slides_set_page` | Office | office-plugin.ts:293 | ✅ 已改 |
| `context_room_slides_read` | `slides_read` | Office | office-plugin.ts:437 | ✅ 已改 |
| `context_room_slides_edit` | `slides_edit` | Office | office-plugin.ts `SLIDES_TOOL_NAMES` | ✅ 已改 |
| `context_room_sheets_create` | `sheets_create` | Office | office-plugin.ts:370 | ✅ 已改 |
| `context_room_task_start/read/update/clarify/attach` | — 删除 | Room 任务夹 | task-plugin.ts | ✅ 已删（Phase 2d-3） |

MCP server name 同步由 `everroom-context-room` 改为 `everroom-office`（`mcp-host.ts:348`）。

**连带改名点**：`office-plugin.ts:39-44` 的 `SLIDES_TOOL_NAMES`、`runtime-factory.ts:13,144`、`subagents/slides-agent-tools.ts:5,39`、`pi-tools.ts:59/83/93/98/113`、MCP server name（`mcp-host.ts:348` `everroom-context-room` → `everroom-office`）、`mcp-routes.ts` 路径、i18n 文案、各 agent 的 `SYSTEM.md` 与 `schemas/*.json`。

### P0-4 Agent 运行时工具面重建

**关键事实（已核实）**：`agents/*/agent.yaml` 的 `capabilities` / `tools` 字段只被解析、不参与装配（`modules/agent/builtin-bundles.ts:85-86`），真正决定工具面的是 `modules/agent/runtime-factory.ts:138-172`。**只改 YAML 不会移除能力。**

- `runtime-factory.ts:139` `...(knowledge?.tools ?? [])` → 删除；
- `:153-160` `createDocumentPiToolsWithRoomBindings(mcpHost, routedRoomByRun)` → `createDocumentPiTools(mcpHost)`；
- `:166-172` `resolveKnowledgeWikiIds` / `resolveRoomMemories` / `roomMemorySearch` → 删除；
- `:210-241` `createIngestFilterAgentRuntime` → 删除；
- `createWritingStyleRuntime` / `createIndexBackfillRuntime` → 随记忆/风格画像删除；
- `agents/main/agent.yaml`：删 `:13-16`、`:25-28`、`:29-40`、`:43-53`、`:67`；保留 `:41-42`、`:54-66`、`:68`；
- `agents/main/SYSTEM.md`：改 `:5`、`:6`、`:9`、`:10`、`:14`、`:19`；
- `agents/main-lite/agent.yaml:12-14`、`agents/main-direct/agent.yaml:12-15`：删能力声明；
- `agents/doc-writer`：`SYSTEM.md:15,17`、`schemas/input.schema.json:36-49`、三个 skill 的 SKILL.md；
- `agents/slides-planner/SYSTEM.md:12,20`、`agents/slides-builder/SYSTEM.md:5,7,8,14`；
- 删除 bundle：`agents/{context-room,room-corrector,knowledge,diary,ingest-filter,transcription-summary,route-planner}`；改 `agents/README.md:36`。

---

## 2. Phase 1：断耦合（逐文件 import 替换表）

| 文件 | 现状 | 替换方案 |
|---|---|---|
| `modules/agent/runtime-factory.ts` | 引 knowledge 工具、room 绑定、ingest-filter / writing-style runtime | 按 P0-4 |
| `modules/agent/channel-mcp-host.ts:162` | `knowledgeToolFactory` 注入 | 删除构造参数与调用点 |
| `modules/agent/*` → `diary/agent-generator` | 日记任务生成 | 删除调用点（`agent-scheduler` 保留） |
| `modules/agent/*` → `search/jobs` | 检索索引 | 保留 `search/jobs`，仅删日记/记忆入队 |
| `modules/files/clustering-service.ts:16` | `knowledge/embedding` 图片聚类 | 删除聚类服务 |
| `modules/files/image-describe.ts:3-4,28,47,62-100` | `perception/service` + `reality/insight-tags` | 删除 VLM 描述链路 |
| `modules/files/service.ts:9` | `search/jobs` | 保留 |
| `modules/subagents/tools.ts` → `context-rooms/room-context-digest` | `room_analysis` 材料组装 | 删除 `room_analysis` 与 `resolveRoomContext` |
| `modules/subagents/*` → `perception/vlm-client` | 图片理解 | 删除，图片理解改走 `multimodal-document-parser` |
| `modules/subagents/doc-writer-tools.ts:36`、`slides-agent-tools.ts:150` | `roomTools` 参数 | 删除 |
| `modules/documents/integration-outbox.ts:6,54` | `document.ingest` 作业 | 删除 |
| `modules/documents/capabilities/route-mindmap-plugin.ts` | 写作路线导图 | 按 D2 删除 |
| `submodules/.../gateway-module/manager.ts:10,20-33,207,223-262` | `memorySink` 扇出 | 删除 |
| `submodules/.../gateway-module/connector-memory.ts` | 邮件/日程 → MemoryCore | 整文件删除，改 `README.md:21` |
| `submodules/.../gateway-module/domain-projection.ts:13-21,261-345` | 六张 Room/知识身份表 ref 改写 | 删除该段 |
| `apps/gateway/src/server/connector-identity-rewrite.ts` | 同上逻辑宿主副本 | 整文件删除 |
| `apps/desktop/.../components/agent/agentRoomSelection.ts` | 会话绑定 Room | 删除，并清 `agentRoomCitations` 状态 |
| `apps/desktop/.../components/agent/agentMentions.ts` | @ 提及含 Room | 去掉 Room 提及类型 |
| `apps/desktop/.../components/agent/activeDocumentContext.ts` | 经 Room 取文档上下文 | 改为按当前文稿标签页取 |

---

## 3. `create-server.ts` 装配点删除/改写表

| 行 | 内容 | 动作 |
|---|---|---|
| :91-104、:160-162 | 四个模块 import | 删 |
| :609-614 | `ContextRoomService` + `MemoryService` | 删 |
| :633 | `RoomOverviewService` | 删 |
| :644-656 | 文档创建 / 划词改写 → 记忆捕获 | 删 |
| :730-737 | Room capabilities、room 记忆 provider | 删 |
| :771-834 | `KnowledgeService`、`RoomDuplicateService`、实体认领、记忆晋升 | 删 |
| :859-883 | `createContextRoomAgentTools` × 3 | 删 |
| :974-993 | room-agent dispatcher、总览调度器 | 删 |
| :1012-1042 | selection-rewrite / doc-writer 授权解析 | 去 `roomId`，保留 `document_draft` 授权链 |
| :1057-1069 | `channelRoomTools`、room wiki 解析 | 删，`ChannelMcpHost` 保留文档 capability |
| :1107-1117 | `ScreenMemoryService`、screen memory / room overview 工具 | 删 |
| :1138、:1248-1258 | 子 Agent 的 Room 记忆 / wiki 注入 | 删 |
| :1294 | `contextRoomService` 注入 | 删 |
| :1352、:1397 | knowledge embedding / LLM 热替换 | 删 |
| :1495 | `DataMigrationService(…, memoryService)` | 去掉 `memoryService` 参数 |
| :1561-1589 | 日记的记忆数据源 | 删 |
| :1619 | `knowledgeService.start()` | 删 |

---

## 4. Phase 2：删除顺序（按依赖倒序）

1. **Agent bundle**：`agents/{context-room,room-corrector,knowledge,diary,ingest-filter,transcription-summary,route-planner}`
2. **渲染层**：`components/{context-room 剩余部分,diary,reality,graph,recording,search}`、`components/onboarding/{RoomOnboardingGate,MemoryOnboardingGate,MicrophonePermissionOnboarding,ScreenRecordingPermissionOnboarding}`、`MemoryPipelineStatus.tsx`、`App.tsx` 页面与状态、`data/navigation.ts` 的 `rooms|recording|memory|wiki|diary|inspiration`、i18n、`mock-*` 入口与 vite mock 配置
3. **主进程**：`main/{memory,knowledge,screen-memory,evidence,recording,transcription,obsidian}`、`main/index.ts:360-385,487-500,542+`、`preload/index.ts:436-449,547,675+`、`shared/{memory,knowledge}.ts`
4. **Gateway**：`modules/{context-rooms,memory,knowledge,screen-memory,perception,reality,ingest,materials,clipper,diary,writing-style}`、`modules/files/{clustering-service,image-describe}.ts`
5. **共享包**：`packages/agent-runtime-pi/src/{memory,knowledge}`、`packages/reality-contract`
6. **数据迁移**：新增 drop 迁移（见 §5）

> `modules/search` 只删 Room/证据范围入口，FTS 骨架保留；`modules/files` 保留文件浏览与文档资产。

---

## 5. 数据与配置

**迁移策略**：不改历史迁移，新增 `00XX_drop_memory_and_rooms.sql`：

- drop：`room_doc_links`、`room_folders`、`rooms`、`room_wikis`、`room_memory_*`、`room_merge_*`、`room_duplicate_candidates`、`room_source_memberships`、`room_entity_*`、`room_relations`、`entities`、`entity_doc_links`、`route_mindmaps`、`route_decisions`、`routing_rules`、`knowledge_*`、`diary_*`、`screen_*`、`visual_*`、`reality_events`、`ingest_events`、`clipper_*`、`perception_settings`；
- **保留**：`documents`、`document_*`、`file_*`、`agent_*`、`audit_logs`、`connector_*`、`external_*`、`runtime_config_store`、`gateway_metadata`；
- 迁移前用现有 `data-migrations` 模块导出备份；用户文稿不受影响（`documents` 本体无房间列，仅丢容器归属）。

**配置删除**：`config.ts:108-118`、`:770-814` 的 memory/knowledge 段；`runtime-config.default.json` 的 `memory` / `knowledge` 块；`.env.example:11,78-99`；`apps/desktop/scripts/generate-packaged-env.mjs:7-8`。

**依赖删除**：`@tencentdb-agent-memory/memory-tencentdb-v2`、`@tencentdb-agent-memory/knowledge-service`、`sqlite-vec`（`apps/desktop/package.json:37-38,114-116,129-130`）；`pnpm-workspace.yaml` 的 `allowBuilds`（:23,29,33）与 `patchedDependencies`（:49-50）；`patches/{knowledge-service@0.1.0-everroom.1,memory-tencentdb-v2@2.0.0-beta.1-everroom.8,sqlite-vec@0.1.7-alpha.2}.patch`。改完由 `pnpm install` 重生成 lockfile，不要手改 `pnpm-lock.yaml`。

**CI / 打包校验**：`.github/workflows/{release-desktop,scheduled-desktop-release}.yml` 的 knowledge 变量与 asar 记忆包断言；`apps/desktop/scripts/verify-windows-package.mjs:72-108`。

**测试**：`package.json:10` 去掉 `tests/memory-onboarding.test.ts`；`apps/gateway/package.json:15` 去掉两个 memory e2e；`apps/gateway/tests/{config,server}.test.ts` 的记忆/知识断言；`apps/desktop/tests` 约 40 个 `context-room-*` / `memory-*` / `knowledge-*` / `room-*` 文件。

**文档**：归档 14 篇（`entity-room-plan`、`room-wiki-plan`、`knowledge-room-agent-plan`、`knowledge-organization-iteration-plan`、`room-corrector-plan`、`memory-app-plan`、`memory-md-source-plan`、`pi-agent-memory-plan`、`screen-memory-*`（2）、`unified-ingest-plan`、`ingest-filter-agent-plan`、`reality-wiki-ingest-design`、`graph-rendering-architecture-design`）；改写 `README.md` / `README.zh-CN.md` 定位叙事。

---

## 6. 验证闸门

| 阶段 | 命令 | 通过标准 |
|---|---|---|
| Phase 0 | `tsc --noEmit`（desktop） | 与基线错误集完全一致 |
| Phase 0 | 手动冒烟 | 新建文稿 → Agent 写入 → patch 审阅 → 导出 docx/pptx/xlsx 全通 |
| Phase 1 | `pnpm typecheck` | `rg 'modules/(memory\|knowledge\|context-rooms\|screen-memory\|perception\|reality\|ingest\|diary)' apps packages` 为 0 |
| Phase 2 | `pnpm test` / `pnpm test:ci` | 裁剪后的测试集全绿 |
| Phase 3 | `pnpm package:mac` | 打包成功、asar 断言按新清单通过、启动后无 MemoryCore 子进程 |
| 收尾 | 全量 `rg` | `memory_search`、`wiki_search`、`context_room_`、`MemoryCore`、`TencentDB` 在源码中命中为 0 |

> 环境注记：本机 `pnpm` 需在 Node 22 下运行（`fnm exec --using=22.22.1 pnpm …`），Node 20.19.4 下 corepack 报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`；`electron` postinstall 需联网下载二进制，离线会失败但不影响 typecheck。可直接调用 `node_modules/.pnpm/typescript@5.6.2/.../tsc` 与 `node_modules/.pnpm/vitest@4.1.10_.../vitest.mjs` 绕过 `pnpm` 的预检查。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Office 编辑器搬移导致编辑器回归 | 已完成；typecheck 与测试集与基线一致，后续 `operations/` 迁出单独提交 |
| 文档去 roomId 改变权限语义 | 单独提交；权限从「同房间」改为「单工作区」后原跨房间共享行为消失，需在变更说明中明示 |
| 老用户数据在 drop 迁移中丢失 | 迁移前强制备份 + 只 drop 房间/记忆表，`documents` 与 `file_blobs` 不动 |
| 工具改名破坏已有 Agent 会话/渠道 MCP 客户端 | 改名与删除分两次提交；过渡期在 MCP host 保留旧名别名 |
| 删除面过大难以 review | 按 §4 的 6 步拆 6 个提交，每步独立可编译可测 |

**回滚**：每个提交保持独立可 revert；数据迁移脚本提供 down 版本（重建空表，不恢复数据）。

---

## 8. 执行进展

| 时间 | 阶段 | 内容 | 状态 |
|---|---|---|---|
| 2026-10-23 | P0-1 | Office 编辑器 71 个文件迁至 `components/office-editor/`，改写 44 个文件的引用，旧路径 0 残留 | 完成（typecheck / 测试与基线一致） |
| 2026-10-23 | P0-1 收尾 | `operations/`（18 文件）、`types`、`adapters`、`shared`、`MarkdownBody` 迁出；改写 83 个文件引用 | 完成（office-editor→context-room 反向依赖 12 → 1） |
| 2026-10-23 | P0-1 收尾 | 移除文稿「移动到另一个 Room」入口 | 完成（46 用例全绿） |
| 2026-10-23 | P0-2a | 契约 `RoomDocument.roomId` / `DocumentEvent.roomId` / `AgentActiveDocumentContext.roomId` / `ImportRoomDocumentInput.roomId` 改 `string \| null`；新增 `WORKSPACE_DOCUMENT_CHANNEL`；网关文档内核（repository GET 改 LEFT JOIN、list(null) 全工作区、无归属不再写 `room_doc_links`、content-engine/event-broker/lifecycle/service/commit 全链路接受 null、新增 `room-scope.ts` 归一旧管线 scope） | 完成（tsc 与基线一致；document-* 329 用例全绿） |
| 2026-10-23 | P0-2b | 桌面主进程桥接与 preload：`list/listTrash/emptyTrash` 支持空 roomId，`subscribe` 落到工作区频道；回收站路由与渲染层空归属适配 | 完成（tsc 与基线一致；bridge 新增 2 用例） |
| 2026-10-23 | P0-2c | 渲染层 `RoomDocumentsProvider` → 工作区文稿库 Provider、`DocsPage` 去 Room 维度 | **改并入 Phase 2**：渲染层的文档 tab / 文稿页 / 产物库都以 `roomId` 为键，只有在删除 Room 时才能一次性收敛，单独改造反而要写两遍（决策记录见 §8.1） |
| 2026-10-23 | P0-3 | 18 个 Office 工具改名（`document_*` / `office_create` / `slides_*` / `sheets_create`），MCP server 名改 `everroom-office`，跨 50 文件 | 完成（gateway 测试回到基线；desktop 失败清单与基线逐行一致） |
| 2026-10-23 | P0-4 | Agent 工具面重建：运行时去掉 run 级 Room 粘滞与 knowledge/记忆注入，用户档剔除 `context_room_*` 工具；main/main-lite/main-direct/doc-writer/slides-planner 的能力声明、工具清单与人设去 Room/记忆 | 完成（gateway 套件维持基线 10 个失败） |
| 2026-10-23 | P0-2d | `document_operations.room_id` 放开为可空（迁移 0083，重建表并保全四张子表数据）；操作类型/读凭证/授权判定全链路可空；document.* 能力 manifest `requiresRoom=false`；摘除写入工具的 Room 守卫并去掉 `patch_begin` 记忆清单注入 | 完成（gateway tsc 干净、套件维持基线 10 个失败；新增工作区级端到端与升级路径回归用例各 1） |
| 2026-10-23 | Phase 1a | 断耦合（迁出 + 调度器）：`perception/vlm-client` + `reality/insight-tags` 迁至 `modules/vision/`（20 个引用点）；`diary` 运行时工厂从 `modules/agent` 挪进 `modules/diary`；时区换算迁至 `infrastructure/time/zone-time`；`agent-scheduler` 移除 `diary.daily` 内置槽位与 DiaryService 依赖（routes 死分支、schema 注释同步清理；create/update 时钟与 tick 统一） | 完成（gateway tsc 干净；全量套件 10 个失败 = 基线：190 文件 / 1963 用例） |
| 2026-10-23 | Phase 1b | 断耦合（聚类 + Room 材料）：删除 `files/clustering-service.ts`（图片聚类/embedding）与 `PATCH /v1/file-clusters/:id`、`FilesService.versionClassifier` 钩子及 create-server 装配；删除子 Agent 工具 `room_analysis` 与 `resolveRoomContext` 选项（保留纯投喂的 `content_analysis`） | 完成（tsc 干净；`subagent-tools` 48 / `room-context-digest` 8 全绿；`file-catalog` 仅基线 1 失败） |
| 2026-10-23 | Phase 1c | 断耦合（图片描述 + 连接级联）：删除 `files/image-describe.ts` 与 VLM 描述链路（ingest 改为图片占位 markdown，图片仍是一等格式）；`connection-purge` 去掉 memory/knowledge 两步清理与 `memoryDeleted` | 完成（tsc 干净；全量套件 10 个失败 = 基线：189 文件 / 1955 用例） |
| 2026-10-23 | Phase 1d | `data-migrations` 去 `memoryService`：`JobType` 只剩 `source_gc`、幂等门简化为内容 hash、删除 `indexMemory`/`afterJob`/记忆检索补全/GC 记忆清理，导入后运行直接完成（`phase` 由 `memory` 改 `finalizing`） | 完成（tsc 干净；套件维持基线 10 个失败；两个迁移测试文件 10 用例全绿，重启恢复用例改为真实崩溃路径） |
| 2026-10-23 | Phase 1e | 补最后一条静态边：`documents/core/{commit-service,lifecycle-service}` 不再 `enqueueWritingStyleExtract`（提交/回收站/恢复/清空共 6 处）——此前扫描漏了 `writing-style`，它是唯一「存活 → 将删」的遗漏模块；`doc-writer` 的风格注入为结构化 provider，无静态依赖 | 完成（tsc 干净；`document-*` 87 用例全绿；套件维持基线 10 个失败） |
| 2026-10-23 | Phase 1 闸门 | 网关「存活模块 → 将删模块」反向依赖 **18 → 0**（`data-migrations` 是最后一个）。剩余命中全部属于 Phase 2 范围：`create-server.ts` 40 处装配（§3 表逐行处理）+ 桌面 3 个自身即将删除的文件（`main/knowledge/llm-env.ts`、`shared/knowledge.ts`、`main/screenshot/window-screenshot-service.ts`，依赖方向均为将删→将删） | Phase 1 完成 |
| 2026-10-23 | Phase 2a | 连接器子包去记忆扇出：`submodules/everroom-connectors/gateway-module` 删除 `memorySink`/`projectedRowIds` 与 `connector-memory.ts`，`domain-projection.ts` 只剩域投影（去掉 `IdentityRewriteSummary`/`IDENTITY_TABLES`/`rewriteConnectorRefIdentities`），收敛出自有 `errors.ts`（`IngestError`/`ConnectorConvertErrorCode`），`ports.ts` 不再转出宿主 `IngestService`；同时删掉网关侧死代码 `server/connector-identity-rewrite.ts` | 完成（子包 tsc 维持基线 202 错、6 文件 28 用例全绿；网关 tsc 干净） |
| 2026-10-23 | Phase 2b-1 | 把文稿历史回填 worker 从 `modules/ingest/document-history-backfill-worker.ts` 迁到 `modules/documents/index-backfill/history-worker.ts`——它是 Yjs 版本快照能力，属 Office，不能随理解引擎一起删 | 完成（tsc 干净；`document-core`/`documents` 套件维持基线） |
| 2026-10-23 | Phase 2b-2 | 停掉文稿出队到统一理解引擎：删 `documents/integration-outbox.ts` 的 `document.ingest`/`document.delete` 作业与契约、`core/{commit-service,lifecycle-service}` 的 `enqueueDocumentIngest`/`enqueueDocumentDelete`、`files/service` 的 `VersionIngestResult.ingestEventId`（改 `{ parsedId, dataType }` + `touchVersionParsed`） | 完成（tsc 干净；`documents`/`document-core`/`files-*` 用例改断言「不再有 ingest 作业」后全绿） |
| 2026-10-23 | Phase 2b-3 | 删除统一理解引擎与网页剪藏：`modules/ingest/`（24 文件）、`modules/clipper/`、`apps/gateway/ingest-policy-defaults.json`、`agents/ingest-filter/`，连带 6 个专属测试。跨边界断点就地补齐：`knowledge/service` 内联 `truncateUtf8`、子包 `converters.ts` 改用自有 `errors.js`、删 `tests/memory-office-pdf-pipeline.test.ts` | 完成（tsc 干净；套件 9 个失败 = 基线：`file-catalog` 与 `sync-providers` 保留，`ingest-pipeline` 随用例删除） |
| 2026-10-23 | Phase 2c | 素材检索退役、图片对象库并入 slides-style：`modules/materials` 里只有「关键词检索截图/剪藏/文档图」该删，「按内容哈希存/取图片字节」是 Office 配图链路，迁为 `modules/slides-style/{image-store,image-routes}.ts`（`SlideImageStore`），`GET /v1/materials/:hash` 路径保持不变以兼容桌面 `everroom-material://` 回源器与已存 deck 引用；`slides-agent-tools` 去掉 `materialSearchTools` 与 `SLIDES_PLANNER_MATERIAL_TOOL_ALLOWLIST` | 完成（tsc 干净；`slides-agent-tools` 14 用例全绿，`slides-reviewer` 1 个为既有基线失败） |
| 2026-10-23 | Phase 2d-1 | 删除写作风格提炼 `modules/writing-style/*` 及 5 个测试；`create-server` 去掉服务/路由/worker/runtime 热替换与 `doc-writer` 两处 `writingStyleProvider` 注入；`subagents/{tools,doc-writer-dispatcher}` 去掉风格注入依赖；`agent-access` 的 `everroom_get_rules` 不再返回 `writing_style`。原 `createWritingStyleRuntime` 兼职文档版本摘要，改名 `createVersionSummaryRuntime`（独立 `version-summary` 会话目录）保留该 Office 能力 | 完成（tsc 干净；`document-draft-tool` 改断言不再注入 `writingStyle`；套件 9 个基线失败） |
| 2026-10-23 | Phase 2d-2 | 删除三个互相缠绕的网关模块：`modules/knowledge`（21 文件）、`modules/context-rooms`（11 文件）、`modules/memory`（4 文件）与 bundle `agents/{context-room,room-corrector,knowledge,route-planner}`、`modules/demo/context-room-demo.ts`、`documents/capabilities/route-mindmap-plugin.ts`；`create-server` 摘掉三模块全部路由/服务/定时器/事件钩子/MCP 宿主与工具注入；`FileDeletionHooks` 与 `RoomEntrySink` 及全部 call site 删除（`FileDeletionResult` 收敛为 `{fileId, blobCollected}`）；agent-access 去掉 memory 依赖与 memory/knowledge 规则条目；`BUILTIN_AGENT_IDS.knowledge` 与 knowledge agent 工厂删除。删 33 个测试文件、改写 9 个（-33810 行） | 完成（tsc 0 错误；套件 8 个失败 = 基线：143 文件 / 1442 用例） |
| 2026-10-23 | Phase 2f | 删除转写链路：`modules/asr`（9 文件，阿里云 ASR + 音频存储）、`modules/processing/service.ts`（转写总结）与 `agents/transcription-summary` bundle；`processingRoutes` 去掉转写参数与 `POST /v1/processing/transcription-summary`（保留 `session-title` 与 `conversation-suggestion`）；`runtime-factory` 删 `createBackgroundAgentRuntime` 与 `registerTranscriptionSummaryAgent`；`BUILTIN_AGENT_IDS.transcriptionSummary`、`ServerOverrides.asrProvider`、`config.transcriptionSummaryPi` 与 `AsrError` 错误映射一并删除 | 完成（gateway tsc 0 错误；套件 8 个失败 = 基线：132 文件 / 1343 用例。`runtime-config` 的 `asr`/`transcriptionSummary` 槽位与 `NXCORE_ASR_*` 环境变量留到 Phase 3 配置清理） |
| 2026-10-23 | Phase 2e | 删除采集管线四个叶模块：`modules/perception`（3 文件）、`modules/reality`（4）、`modules/screen-memory`（3）、`modules/diary`（9）与 `agents/diary` bundle；`create-server` 摘掉四个服务的构造/路由注册/dispose、`screenMemoryMarkDiaryStaleRef` 晚绑定、`PerceptionService.replaceVlm` 热替换、`RealityService.recoverInterruptedCaptures` 启动恢复、`DiaryAgentGenerator` 装配与 runtime 替换，以及 `RealityError` 错误映射；`BUILTIN_AGENT_IDS.diary` 删除 | 完成（gateway tsc 0 错误；套件 8 个失败 = 基线：135 文件 / 1364 用例，删 7 个模块专属测试；`server.test` 里 perception/diary 设置用例随路由删除） |
| 2026-10-23 | Phase 2d-3 | 摘除 Room 工具面与任务夹孤儿（Office/Agent 侧）：删除 `context_room_list` / `context_room_create`（query-plugin）与 `context_room_task_start/read/update/clarify/attach` 及其全部注册链（`capabilities/task-plugin.ts`、`documents/task-folders.ts`、`builtins.ts` 的 `taskFolders`/`issueTaskClarify` 参数、`/v1/documents/folders` 路由与 create-server 装配、`AgentService.issueTaskClarification`）；删除 `import/room-classifier.ts` 与其测试；删除 `subagents/tools.ts` 的 `room_correction_draft` 分支及 `resolveRoomCorrectionContext`/`resolveRoomMemoryItems`/`roomExists` 选项与 `roomTools` 管线，`mcp-host.roomExists()`、`runtime-factory` 的 `^context_room_` 前缀过滤、agent service 的 Room 总览/引用纠正 prompt 与 `attachRoomSelectionIntent` 一并摘除；`document_write_begin` 等描述与 `doc-writer` schema/skill 改为工作区文稿库与纯文档来源标记话术 | 完成（gateway tsc 0 错误；套件 8 个失败 = 基线） |
| 2026-10-23 | Phase 2h-2 | 收尾 `ingest_events`：删除最后两处读取（`files.purgeUnsupportedFiles` 的清污 DELETE、`connectors` 连接级联的台账软删与 `ledgerRows` 返回值），表定义从 `schema.ts` 摘除，0084 迁移追加 `DROP TABLE ingest_events`（总数 42）；`client.ts` 去掉该表的三处 shim，并给历史迁移重放加「目标表不存在则跳过」护栏（重放 0018 时不再撞已删表），把「补 0018 四列」的修复门限到「游标已越过 0018」以免污染旧库 | 完成（gateway tsc 0 错误；套件 131 文件 / 1339 用例，6 个失败全部 ≤ 基线：`database-repair-writ-style` 与 pre-merge Context Room 两个基线失败随用例删除消失） |
| 2026-10-23 | Phase 2h | 删除记忆/房间/采集遗留的 **41 张表**（迁移 `0084_drop_memory_room_ingest_tables.sql`，全部 `DROP TABLE IF EXISTS`、按外键倒序、幂等，已登记 journal idx 86，仓库自 0048 起不再产 snapshot 故不新增）：`clipper_{artifacts,assets,captures}`、`diary_{days,runs,schedules,versions,version_sources}`、`visual_{nodes,observations,processing_jobs}`、`screen_{intervals,keyframes}`、`perception_settings`、`reality_events`、`file_cluster{_memberships,s}`、`room_merge_{items,operations}`、`room_duplicate_candidates`、`room_memory_{attributions,suppressions}`、`room_relations`、`room_entity_{facts,mentions}`、`room_context_corrections`、`room_local_actions`、`room_folders`、`room_wikis`、`entities`、`entity_doc_links`、`route_{decisions,mindmaps}`、`knowledge_preference{_settings,s}`、`writing_style_*`（6 张）；`schema.ts` 删 41 个 `sqliteTable`（125 → 84，`grep -c sqliteTable` 126 → 85）；`client.ts` 删 `repairWritingStyleUserContentColumns`、`migrateLegacyWritingStyleDirectives`、`repairIncompleteRoomDuplicateMigration`、`adoptPreMergeContextRoomMigrations`，`context-room-compatibility.ts` 只留 `room_overviews` 形态修复，并把 `adoptAlreadyAppliedLateMigrations` 的 0036/0037/0038/0043 探测与 `repairIncompleteUnderstandingMigration` 里 0018/0019 的整条重放收敛为「只补 `uploaded_files` 四列」——否则这些 shim 会把刚删的表重新建回来；删 `tests/database-repair-writ-style.test.ts`，`database-migrations.test.ts` 去掉两个只测已删 shim 的用例、改用存活表断言，`migration-0083-room-nullable.test.ts` 的迁移目录截断到 0082 | 完成（gateway tsc 0 错误；套件 7 个基线失败 = 删掉 `database-repair-writ-style`：131 文件 / 1339 用例；新建库与「已迁移库二次启动」均验证 41 张表不存在、6 张在读表仍在） |
| 2026-10-23 | Phase 2i | 摘掉存活模块的最后一层 Room 维度：`agent-access` 删除 `everroom_list_rooms`、Room 数据行过滤与 `everroom://rooms/*` URI 解析（`list` 自检步改用 `everroom_get_status`）；`search` 删除 `room` 命中类型、`SearchFilters.roomIds`、`search_index_rooms` 写入与房间回填（保留旧行清理，`search_index_rooms` 表与列不动）；`documents` 删除 `roomId` 列表/回收站过滤、`/v1/documents/:id/move` 与 `v1/documents/move` 两条路由及 `core/move-service.ts`、`repository.list()` 的 Room 分支、`DocumentContentEngine` 的 `findDocumentRoom` 与跨 Room 引用校验、各能力里的 `ROOM_MISMATCH` 归属校验、`operations` 的 commit/create 目标 roomId 比对；`import/batch-service` 去 `rooms` 存在性校验（`mode=room` 仅作来源标注）；`index-backfill` 去 Room 扫描与 `payload.roomId`；`subagents` 只做 arity 适配（slides/thesis 的 Room 守卫留待后续相位）；`schema.ts` 摘掉最后 5 张 Room 表（`context_rooms`/`rooms`/`room_doc_links`/`room_overviews`/`room_source_memberships`，`grep -c sqliteTable` 85 → 79）并由 `drizzle/0085_drop_room_tables.sql` 删除（journal idx 87），`client.ts` 去掉 `repairContextRoomSchema` 并删除 `context-room-compatibility.ts` | 完成（gateway tsc 0 错误；套件 5 文件 / 6 用例失败 = 基线：`bundled-agent`、`database-migrations` Yjs 用例、`file-catalog`、`slides-reviewer`、`sync-providers`×2；共 130 文件 / 1332 用例，1326 通过） |
| 2026-10-23 | Phase 2i-2 | 补回划词改写端点 `POST /v1/documents/selection-rewrite`（body `documentId?`/`documentName?`/`selectedText`/`instruction?`/`contextBefore?`/`contextAfter?`/`blockType?`/`responseLanguage?`，`additionalProperties: false`，`selectedText` ≤ 20 000）：create-server 注入窄派发函数（`(taskInput) => docWriterDispatcher.dispatchDetached({ task: "rewrite", taskInput })`），documents 模块不依赖 subagents，`roomId` 不进 taskInput；空白 `selectedText` → 400，`subagent_concurrency_limit`/`subagent_global_concurrency_limit` → 503，其余派发失败 → 500；新增 3 条路由契约用例（成功返回 `{invocationId}`、空白入参 400、并发限额 503/其他 500）；桌面渲染层 `selectionRewriteAgent.ts` 注释 URL 改指新路径 | 完成（gateway tsc 0 错误、套件维持基线；新用例 3/3 绿）。**遗留**：桌面主进程 `main/gateway/context-room-gateway-bridge.ts` 仍向已删的 `/v1/context-rooms/selection-rewrite` 发请求，改路径属桌面清理相位（见 `docs/desktop-cleanup-map.zh-CN.md`） |
| 2026-10-24 | Phase 2i-3 | 连接器页批量导入收敛为**工作区文档导入**：`documents/import/batch-service.ts` 删掉 `RoomAssignmentClassifierPort`/`DocumentBatchImportPorts`（classifier/roster/incubate 三端口）、`BatchRoomRosterEntry`、`ImportClassifierVerdict`、`IMPORT_ROOM_CONFIDENCE_THRESHOLD`、`resolveAutoRoomId` 与 `mode:'room'` 显式目标分支，`BATCH_ROOM_REQUIRED`/`BATCH_AUTO_UNAVAILABLE` 两个错误码随之删除（`BatchImportServiceError` 仍留 BATCH_EMPTY/TOO_LARGE/MODE_INVALID/NOT_FOUND）；`create-server` 去掉端口/注释与失效的 `createImportClassifierRuntime` 导入，`runtime-factory` 删该工厂（已无调用方）；新增 `DocumentImportService.commitToWorkspace`——导入产物一律工作区文稿（`origin=import`、`roomId=null`），来源去重按快照 content hash（未变 → 该篇 skipped 不落版本；变了 → 同来源**同一篇**文稿追加版本），`forceNewDocument` 跳过去重与无变化守卫；`existingInRoom` 改为 `importedInWorkspace`（按 `document_import_runs.targetDocumentId` 判定，不再读 `document_room_imports`），`/v1/document-import/existing-in-room` 路径保留；HTTP `mode` 两个历史取值 `'room'`/`'auto'` 与 body `roomId` 继续接收入参但语义统一为「导入工作区」、`roomId` 一律忽略（旧版桌面构建不 400），视图 DTO `targetRoomId`/`item.roomId` 形状冻结、恒填 null；`document-import-batch.test.ts` 从 18 例改写为 25 例（auto 无端口即成功 / mode=room 同义 / 重导按 content hash 去重与追加版本 / forceNew 新建 / importedInWorkspace / 路由兼容契约：mode=room+roomId 仍 200、未知 mode 400） | 完成（gateway tsc 0 错误；套件 131 文件 / 1321 用例，**1315 通过、6 个失败 = 基线原样**：`bundled-agent`、`database-migrations` Yjs 用例、`file-catalog`、`slides-reviewer`、`sync-providers`×2；`document-import-batch` 25/25 绿；`git grep "BATCH_AUTO_UNAVAILABLE\|RoomAssignmentClassifierPort\|BATCH_ROOM_REQUIRED\|BATCH_ROOM_NOT_FOUND" -- apps/gateway` 为空） |
| 2026-10-24 | Phase 3 验收 | 全仓验收：网关 tsc 0 错误、套件 1320 用例仅 6 个既有基线失败；桌面 tsc 0 错误、套件 914 用例仅 16 个既有基线失败；新库 0001→0086 全量重放 ALL-PASS（77 张 `sqliteTable` 定义 / 96 张用户表，0 缺失，19 张多出表逐一归类为 FTS5 影子 12 + 迁移记账 1 + 0015 历史连接器 6；`context_rooms`/`rooms`/`room_doc_links`/`room_overviews`/`room_source_memberships`/`search_index_rooms`/`ingest_events` 及 0084 那批记忆/知识/日记/感知/剪藏表全部不存在；游标 1792748200000 = journal `0086`；`documents` 读写删冒烟通过）；相对 import 目标存在性扫描 648 文件 / 1679 记录符 / 0 悬空；残留扫描只剩注释与 `web-clipper` 数据标签 | 通过（唯一外部动作：在有可用 pnpm 的环境执行 `pnpm install` 刷新 `pnpm-lock.yaml`，本机 pnpm 不可用） |
| 2026-10-24 | Phase 2i-4 | 网关侧最后一批 Room 命名残留：三条路由去掉无意义的房间维度——`POST /v1/rooms/:roomId/documents/:documentId/check-external-update` → `POST /v1/documents/:documentId/check-external-update`、`GET /v1/rooms/:roomId/documents/:documentId/import-history` → `GET /v1/documents/:documentId/import-history`、`POST /v1/document-import/existing-in-room` → `POST /v1/document-import/existing-in-workspace`（预检 body 去掉兼容字段 `roomId`）；`DocumentImportService.checkExternalUpdate(documentId)` / `importHistory(documentId)` 去掉 roomId 形参（导入历史与候选都按 documentId 归属；checkExternalUpdate 新建的关联行沿用该文档已有导入关联的 scope id，不伪造 Room），`importedInWorkspace` 判定口径不变；调用方同步更新：`tests/document-import-export.test.ts` 5 处、`tests/document-import-batch.test.ts`（existing-in-workspace、去 roomId）、桌面 `main/gateway/external-documents-gateway-bridge.ts`（URL 串）、`main/index.ts` 两个 IPC 处理改单参、`preload/index.ts` 与 `shared/sources.ts` 签名、渲染层 `ExternalExportDialog` / `DocumentHistoryPanel`（顺带删掉「roomId 为 null 就不查导入历史」的旧 Room 守卫）/ `ImportedCommentsPanel`（`roomId` prop 一并删除，`TiptapDocumentEditor` 调用点去参）；`/v1/documents/rooms/:id/stream` 保留 URL（桌面以 WORKSPACE_DOCUMENT_CHANNEL 订阅），注释改写为「工作区文档频道、URL 段是冻结的历史命名」；`document_room_imports` **保留**——它不是兼容表：单篇导入的关联/候选/应用/历史链路（`relation` / `imported_version` / `candidate_document_id`）仍被 `documents/import/service.ts` 与 `documents/core/repository.ts` 读写，删表会直接砍掉仍在用的「检查外部更新 / 应用此版本 / 导入历史」；`search_index_rooms` 确认零读者（唯一写入是 `SearchService.removeItem` 里的旧行清理 DELETE，schema 导出 `searchIndexRooms` 无人引用），随新增 `drizzle/0086_drop_room_compat_tables.sql` 删除（幂等 DROP TABLE IF EXISTS，journal idx 88），`schema.ts` 删表定义、`search-fts.test.ts` 删 Room join 用例；网关侧已无 `/v1/clipper/*` 路由（`grep -rn "clipper" apps/gateway/src --include=*.ts` 只剩 `web-clipper` 这个 sourceKind 取值与 0084 退役注释），桌面 `files-gateway-bridge` 仍指向已删剪藏路由，归桌面切片 | 完成（gateway tsc 0 错误；套件 131 文件 / 1320 用例，**1314 通过、6 个失败 = 基线原样**：`bundled-agent`、`database-migrations` Yjs 用例、`file-catalog`、`slides-reviewer`、`sync-providers`×2；桌面 tsc 0 错误；`git grep -n "rooms/.*documents\|existing-in-room" -- apps/gateway apps/desktop/src` 为空；`grep -c sqliteTable apps/gateway/src/infrastructure/database/schema.ts` 79 → 78） |
| 2026-11-04 | Phase 2i-5 | **Agent/工具链路彻底去 Room**（根因：`context_room_document_intent` 预检的 `!runRoomId` 条件在无 Room 时代恒真，把「改稿/续写既有文档」错误拦截成选 Room 卡片，`document_draft` 改稿入口返回 `ROOM_SELECTION_REQUIRED`）：契约侧 `SubmitPendingAgentIntentInput` 删必填 `roomId`、`AgentActiveDocumentContext`/`StartRuntimeRunInput`/`DocumentExecutionContext` 等 Room 字段移除（`AgentSession.roomId`/`AgentRun.roomId` 等 legacy 响应字段保留恒 null）；网关删 `context_room_document_intent` 预检、AgentRoomRegistry 与 `agent_room_not_available` 分支、`createTrustedMcpSession`/`validateActiveDocumentContext`/`isSelectionRewriteInvocationAuthorized` 去 Room 参、`DocumentReadAuthority` 凭证只按 sessionId+runId 比对、`documentsReadByRun` 无 roomId、diagnostics/payload 全链路去 Room 字段、`inferMaterialSourcesFromReads` 2 参化且工作区文稿不再跳过；子 Agent 侧 `document_draft`/`slides_draft` 摘除 roomId 参数与 `ROOM_SELECTION_*` 守卫（doc-writer 派发改带顶层 `blockIndexScope`，slides 内部 scope 键继续用 `WORKSPACE_DOCUMENT_CHANNEL` 哨兵、`everroom://room/{scope}/...` URI 语法冻结不动）、`agents/doc-writer` schema/SYSTEM.md 同步；桌面最小适配：`buildAgentRunContext`/`useAgentSession`/`sendPrompt`/`submitPendingIntent` 去 rooms/selectedRoomId/roomId 参数、`AgentChatView` 删 RoomSelection/DocumentIntentClarification 卡片与 pendingRoomSelection/confirmedDocumentIntent 状态（文档选择卡保留、按 documentId）、`agentRoomSelection.ts` 收敛为纯 pending intent 解析（不再要求 allowedRoomIds 非空）、`activeDocumentContext`/`agentDocumentSelection`/`useDocumentEditorOperations` 的 activeDocument 无 roomId、两个调用方（ConversationPane/AgentChatDock）与 6 个测试文件同步 | 完成（gateway tsc 源码 0 错误；桌面 tsc 0 错误；gateway 核心用例 agent/agent-access/document-draft-workspace/document-draft-tool/subagent-tools 97 用例全绿；桌面 agent 相关 13+9+6 用例全绿；跨 Room 凭证/归属类用例改写为「不同 sessionId/runId 仍被拒」语义） |
| — | Phase 2 | 删除模块 | 未开始 |
| — | Phase 3 | 外围清理 | 未开始 |

### 8.1 决策记录

- **P0-2d 新增（2026-10-23，本轮发现）**：`document_operations.room_id` 仍是
  `NOT NULL`（`drizzle/0011_flippant_killmonger.sql:51`），因此 Agent 的
  `document_write_begin → commit` 写入路径**仍必须绑定 Room**：`create-plugin.ts`
  的 `roomId: context.roomId!` 与 `ROOM_SELECTION_REQUIRED` 守卫、`patch_begin`
  的同类守卫都源于此。在 operations 表放开归属之前，把 Office 工具描述里的
  Room 话术改掉会造成"文档说支持工作区文档、运行时却报 ROOM_SELECTION_REQUIRED"
  的矛盾，故新增 P0-2d：迁移 `document_operations.room_id` 为可空（SQLite 需重建表）、
  `CreateDocumentOperationInput.roomId` 改 `string | null`、操作仓储按 `roomScopeId`
  分键，然后才摘除各写入工具的 Room 守卫并重写工具描述。
- **`context_room_*` 工具的删除时机（2026-10-23）**：P0-4 起用户档 runtime 已不把它们
  交给模型，但文档 MCP host 仍注册这些工具供 Room 界面与 context-room 子 Agent 使用；
  注册表层的删除随 Phase 2 的模块删除一起做。


- **P0-2c 并入 Phase 2（2026-10-23）**：渲染层的文稿标签页、`DocsPage` 列表、Room 产物库
  都以 `roomId` 作为键与分组维度（`ActiveDocumentDescriptor`、`openDocuments[{roomId, documentId}]`、
  `useRoomAgentFiles(roomIds)`）。在 Room 仍然存在时引入"工作区文稿库"会同时维护两套分组语义，
  并在 Phase 2 删除 Room 时再改一遍；因此 P0-2 的渲染层部分随"删除 Room"一起做：
  届时标签页改为 `documentId` 单键、`DocsPage` 直接消费工作区列表（网关与主进程的
  工作区级读取链路已在 P0-2a/P0-2b 就位，可直接使用）。
- **P0-3 保留 Room 工具不删（2026-10-23）**：`context_room_list/create/task_*` 仍被 Room
  agent bundle 引用，提前删除只会把 Phase 2 的删除面提前到 Phase 0；故 P0-3 只做 Office 侧改名，
  Room 工具的删除与 `document_write_*` 等描述里残留的 Room/记忆话术在 P0-4 与 Phase 2 处理。
- **Phase 2i 只删 Room 维度、保留客户端契约字段（2026-10-23）**：`packages/agent-contract` 里的
  `RoomDocument.roomId`、`SearchHit.roomIds`、`DocumentImportBatchView.targetRoomId`、
  `DocumentImportBatchItemView.roomId`、`DocumentBlockResolution.sourceRoomId` 等字段本轮**不改形状**
  （桌面端仍在读），网关统一填稳定空值：文稿 `roomId: null`、搜索命中 `roomIds: []`、
  引用 `sourceRoomId` 落 `WORKSPACE_DOCUMENT_CHANNEL`。`AgentAccessScopes.roomIds`/`writebackRoomId`
  同样保留（`agent_connections` 列还在、桌面连接卡片与既有连接数据都在用），只是不再参与数据过滤。
  `document_list` 仍按运行上下文回显 `roomId`（桌面选择卡片要求每条候选自带该字段）。
  划词改写的 `POST /v1/documents/selection-rewrite` 已在 Phase 2i-2 补回。
- **Phase 2h 少删 6 张表（2026-10-23）**：§5 计划里的 `context_rooms`、`rooms`、
  `room_doc_links`、`room_overviews`、`room_source_memberships`、`ingest_events` 目前**仍有存活读取方**，
  本轮不删，等 P0-2（documents 去 roomId，§8.1 已记录其并入 Phase 2）落地后再删：
  `context_rooms` ← `agent-access/tools-read.ts`、`documents/core/{query-service,move-service}`、
  `documents/index-backfill/worker.ts`；`rooms` ← `search/{service,backfill}`、
  `documents/import/batch-service.ts`；`room_doc_links` ← `documents/core/{repository,commit-service,move-service}`、
  `agent/service`、`search/service`、`index-backfill/worker`；`room_overviews` / `room_source_memberships`
  ← `agent-access/tools-read.ts`（后者还有 `search/service`）；`ingest_events` ← `files/service.purgeUnsupportedFiles`
  与 `connection-purge` 的升级路径兼容。因此 `context-room-compatibility.ts` 不能整份删除——
  `room_overviews` 的 base_projection 形态修复对早期开发库仍然必要。