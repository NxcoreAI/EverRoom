# Baud 分支移植方案：EverOffice Agent 原生编辑 / 评论 / PPT 生成 → EverRoom

源：EverOffice main @ bfad3dd0（367 commits 自分叉点 38ed4e7a）
目标：EverRoom `baud` 分支（Room 模型保留；genoffice 子模块已替换至 9142831d）

## 核心裁决（架构对齐）

1. **Room vs 工作空间**：EverRoom 保留 `roomId` 模型（contextRooms 表、context_room_* 工具名、
   mcp-host roomId 绑定、桌面 room 路由）。所有 EverOffice 代码中的 `workspaceId`
   （文件归属/产物入库）在移植时一律改写为 `roomId: context.roomId`；
   不引入 agent_workspaces 表、不加 file_entries.workspace_id 列、不移植
   workspace-layout/workspace-index/room-scope 等模块。
   调查结论：工具面内所有 workspaceId 均为「归属透传」（class b）或「依赖缺失列」（class c），
   无一为功能必需（class a）。
2. **工具命名**：新增工具用 EverOffice 无前缀名（word_agent_*、sheets_agent_*、pdf_agent_*、
   office_read/office_edit、file_read/file_search、slides_create/slides_read/slides_edit、
   word_compare/word_export_pdf、file_open）。既有 context_room_* 工具全部保留
   （桌面 agentRunActivity、task-plugin 指南、mcp-host 校验都钉在旧名上）。
   slides 例外：见第 4 条。
3. **SLIDES_TOOL_NAMES 冲突**：EverRoom 版含 4 个名字（create/set_page/read/edit，主 Agent
   面剔除、slides-builder 独占）；EverOffice 版 3 个（create/read/edit，脚本直生）。
   移植策略：SLIDES_TOOL_NAMES 改为「子代理独占名单」= EverRoom 4 件套照旧；新增的
   slides_create（脚本路径）/slides_read/slides_edit 以新名字注册进主 Agent 工具面，
   与 4 件套并存。task-plugin 指南不改（继续指向 context_room_slides_create 4 件套流程）。
4. **PPT 生成双轨**：保留 EverRoom 既有 slides_draft 四阶段管线（草稿→风格→生成→编辑，
   slides 子代理群 enabled），同时移植 EverOffice 的「pptx skill 脚本直生」路径
   （slides_create + apply_theme.js + agent-pptx-script vm 沙箱）作为第二通道。
   主 SYSTEM.md 增补脚本直生章节（工具路由策略），但保留 slides_draft 为默认路线。
   slides-layout tree v2（block-needs/component-candidates）、page-preview-context、
   review-context、semantic-bindings 增强、storyboards、checkpoints、deck 计划卡一并移植
   （EverRoom 已有对应表，仅代码升级）。
5. **运行时护栏**：agent-runtime-pi 的 tool-loop-guard / tool-result-dedupe / noop-tool-call /
   office-bash-guard 四件随 office 工具移植（EverOffice 主 Agent 刹车），knowledge/memory
   子目录保留 EverRoom 原样。
6. **评论能力**：
   - 云文档侧（documents 表/Tiptap）：EverRoom 已有全套（context_room_document_comment_add、
     comment-routes、锚点装饰、AI 审阅）；仅补「划词评论进对话」：noteCards/displayContent
     契约 + agent_messages 两列 + 0103/0104 迁移 + TiptapBubbleToolbar note 模式 + 队列 UI。
   - Office 文件侧（genoffice 原生编辑器）：移植 office-ask 队列链（OfficeAskAnchor、
     wire*AgentAsk、pushAskQueue、office:ask-queue-sync/action IPC、NoteQueueChip），
     roomId 为主键（ EverRoom 无 workspace tab，按 Room 路由）。
7. **genoffice 运行时重建**：prepare-genoffice-runtime.mjs 升至 v7（markdown 应用 + PDF wasm），
     package.json 增 pptxgenjs 依赖，dev 脚本保持 EverRoom 自有 prepare 链。
8. **不移植**：workbench UI、genoffice proto 桥（main/genoffice/*）、os-open（保留最小
   write-back 支撑）、billing/积分、journal、hippo memory、agent-debug 面板、
   workspace-activity/insight、main-direct/main-lite 提示词改动、connectors 改版
   （open-connector MCP 化）、SaaS/云文档工作空间索引、daily-journal、i18n 全量中英。

## 分阶段执行

### Phase A：契约与包基座
- packages/agent-contract：+AgentNoteCard、AgentMessage.noteCards/displayContent、
  StartAgentRunInput.noteCards/displayContent、AgentActiveFileKind/Context/OpenFileContext。
- packages/agent-runtime：StartRuntimeRunInput +activeFile/openFiles（可选）。
- packages/agent-runtime-pi：+4 守卫文件 + active-file-context.ts；index.ts 装配守卫
  （保留 knowledge/memory）。
- gateway schema：agent_messages +note_cards/display_content；drizzle 0084/0085 迁移
  （自 EverOffice 0103/0104 改编号）。

### Phase B：网关文档/文件工具面
- files：copy docx-edit/xlsx-edit/paragraph-compare/file-kind/pi-tools(file_read/file_search)/
  library-browse；service.ts 增 searchCatalog/listVersions/revertToVersion/
  currentVersionIdOf/findBySourcePath（去 workspaceId 过滤）。
- documents/capabilities：copy agent-image-input.ts；office-plugin.ts 大改——保留 EverRoom
  4 个 context_room_slides_* 工具 + task/route-mindmap 插件注册，叠加 EverOffice 的
  office_create(重命名保留 context_room_office_create？→ 新增独立 office_create)、
  office_read/office_edit、word_agent_read/edit/ops/revert/illustration、word_compare、
  word_export_pdf、sheets_read/edit、sheets_agent_read/edit、pdf_agent_read/edit、
  slides_create(脚本)/slides_read/slides_edit、file_open、markdown_create（桌面支持后）。
- office-bridge-client.ts：整体替换为 EverOffice 版（apply-bytes/agent-tools/export-pdf/
  open 四端点 + script/applyThemeJs），roomId 保留、workspaceId 透传 null。
- builtins.ts：officePlugin 增 fileAccess/illustration 参数；create-server 增
  documentIllustration（复用 MaterialsService+SlidesStyleImageGenerator）。
- agents/main：skills/pptx 目录整体拷入；agent.yaml 增新工具名；SYSTEM.md 增补
  「Office 修改路线 + PPT 脚本直生（备选通道）」章节。
- 主 Agent 装配（runtime-factory）：新工具不剔除（除非与 4 件套重名）；加刹车参数
  maxToolCallsPerRun/maxToolResultChars（EverOffice 实测值）。

### Phase C：桌面办公桥
- office-runtime.ts → EverOffice 版（+markdown runtime 类型 + agent 面）+ runtime/genoffice-root.ts。
- copy：office-agent-{doc,sheet,pdf,slides}-session、agent-pptx-script、docx-pdf-export、
  write-back、working-copy、office-view-first-frame、office-diag、office-fontconfig、
  pptx-theme-fonts、markdown-view-manager。
- patch：office-preview-registry（合并 EverOffice 1874 行版：headless 会话/applyAgentFileBytes/
  describe*/apply*/pushAskQueue/instance-reloaded；thesis 桥保持 roomId 键控）、
  office-generation（+script 路径 +4 个 ask 组包）、view-managers（first-frame gate/isDirty/
  agent 工作副本）、office-material-resolver（+compressForEmbed，保留 EverRoom 名）、
  legacy-convert（+fontconfig/textutil）。
- gateway/office-bridge.ts：替换为 EverOffice 版 8 参构造；index.ts 接线
  （4 个新处理器 + setThesisProductHook + office:ask-queue-sync/action + setAgentFileResolver
  + openFiles 桥）；shared/office.ts 扩展（OfficeAskAnchor/队列 DTO，roomId 保留必填）。
- preload：+syncAskQueue/onAskQueueAction/onInstanceReloaded。
- package.json：+pptxgenjs；prepare-genoffice-runtime.mjs → v7。

### Phase D：PPT 管线升级
- slides-layout：tree/v2 +block-needs/component-candidates（含测试）、page-preview-context、
  review-context、theme numeral 默认、deck-contract lastValidatedTreeJson、
  组件族升级（20 文件）、measure/compile。
- slides-style：COMPOSITION_FILL_ORDER、style-session 去 roomId 参数（EverRoom 保留 roomId
  写入——见对齐：EverRoom slidesStyleSessions 表有 roomId 列，保留 create(roomId) 原签名）、
  validate 增补、image-store/image-routes（新增文件，与 MaterialsService 并存：
  SlideImageStore 服务 /v1/materials/:hash 之外的图片对象库）。
- subagents：slides-semantic-stage（修复上限 12/24+semanticErrors）、slides-agent-tools
  （workspace_file_read——EverRoom 对应映射为读文件库，简化）、slides-semantic-bindings、
  layout-tail 合并、storyboards-store、checkpoints、arrange-batches、draft-doc、editor。
- tools.ts：slides_draft 增 previewPages/regenerateDeck/regeneratePages/pageImagesDecision
  扩展（保留 EverRoom room_analysis/room_correction 工具）。
- 主 SYSTEM.md：slides_draft 章节同步 EverOffice 新语义（试看/重排/恢复），保留 Room 语境。

### Phase E：评论链路收尾
- 桌面：TiptapBubbleToolbar note 模式、askDrafts.ts（roomId 化）、NoteQueueChip、
  App.tsx/AgentPanel 队列消费（沿用 agentAskRequest 模式）、useAgentSession
  noteCards/displayContent 参数、AgentChatView UserNoteCards 渲染、
  office-editor 划词→队列（Word 先行）。
- 网关：agent/routes.ts + service.ts（sanitizeNoteCards/持久化）。

### Phase F：集成验证
- pnpm install（根 + 子模块位置）；gateway/desktop typecheck；vitest 相关套件；
  prepare-genoffice-runtime 构建；修编译错；提交分层 commit。

## 风险清单（来自侦察）
- 桌面桥 4 端点是网关工具的硬依赖（只移网关=运行期 404）。
- manifest() 参数个数差异（EO 5 参 vs ER 6 参 requiresRoom）——复制插件时逐个核对。
- CatalogFileDto 无 workspaceId 字段——移植代码去掉该字段解构。
- genoffice runtime prepareVersion 7 强制 markdown 产物存在——必须重建。
- agent-gateway-bridge openFiles 选项需契约类型先落。
- file_read 依赖 understanding.describeImageVersion 只在 images-describe 用——不移植
  workspace-images-describe，避免拖入 describeImageVersion 缺口。
