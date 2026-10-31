# 标签页工作台（Tabs + 双层侧栏）设计

> 状态：**首版已实现**（2026-10-30）。目标是把桌面端外壳从「WorkBuddy 式单侧栏工作台」改成 everoffice 原型的最新布局：
> **窗口级标签栏 + 互斥的两层侧栏 + 工作空间标签页**。只参考原型的布局与功能，视觉/组件用
> 本项目自己的 token 体系 + Radix 等开源件重写，不复制原型的配色与 CSS。
>
> 参考实现（只读）：`/Users/xjwang/EerRoom/everoffice`（最新 main）。
> 产品目录：`apps/desktop/src/renderer/src/workbench/`。

## 1. 交互蓝图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [●●●]  ⌂ 主页   ▦ 项目空间 · 连接器项目   W 周报.docx   ＋        [搜索][窗口按钮] │  ← TabBar（窗口级）
├────────────┬─────────────────────────────────────────────────────────────────┤
│ 侧栏(互斥) │ 内容区                                                           │
│            │                                                                  │
│ 主页标签:   │ 主页标签内容：最近 / 项目空间 / 所有文件 / Agent / 连接器 / 设置       │
│  品牌       │                                                                  │
│  最近       │ 工作空间标签内容：概览 / 资料库 / 产物 / 计划 / 工作会话          │
│  项目空间   │   （右侧可拖拽「气泡窗」打开文件，参与 flex 挤压内容栏）               │
│  所有文件   │                                                                  │
│  Agent      │ 文件标签内容：全宽编辑器（含 Agent 停靠栏）                          │
│  连接器     │                                                                  │
│  账户       │                                                                  │
│            │                                                                  │
│ 工作空间标签:│                                                                  │
│  空间标题   │                                                                  │
│  概览       │                                                                  │
│  新建工作   │                                                                  │
│  资料库     │                                                                  │
│  产物       │                                                                  │
│  计划       │                                                                  │
│  ── 工作 N ─│                                                                  │
│  会话列表   │                                                                  │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

- **标签栏**：窗口最顶层。固定最左「主页」标签（不可关闭）；每个工作空间一个标签（打开过就复用）；
  文件标签（从主页/工作空间页面打开真实文件时创建，可多开）；最右 `＋` 菜单（新建项目空间 / 打开最近文件）。
- **侧栏互斥**：标签决定侧栏形态——主页标签 → 全局侧栏（品牌/一级入口/账户）；工作空间标签 →
  空间侧栏（标题/功能菜单/工作列表）；文件标签 → 不渲染侧栏（编辑器占满）。切换标签即整条侧栏换内容。
- **工作空间内文件**：默认在内容栏右侧以「气泡窗」打开（可拖宽/最小化/最大化/多文件标签），
  不做全窗口文件标签；主页里打开文件才进窗口级文件标签。
- **会话订阅**：网关的 `agent:subscribe` 是「每个 WebContents 单订阅」——同一时刻只能有一个会话在订阅。
  因此会话 pane 只在「该工作空间标签激活且视图是会话/草稿」时挂载；切标签/切视图会卸载并重新拉快照
  （run 仍在网关继续），草稿输入不跨标签保留。这是与原型「pane 常驻」的有意偏差。
- **原生编辑器**：`office:workspace-bounds` 不带实例 id、同一时刻只有一个 Office 实例可见。
  所以文件标签只在激活时挂载；气泡窗只挂载激活文件的编辑器，切文件时先让旧宿主矩形归零、再广播 resize
  让新宿主立即重报。

## 2. 标签模型（renderer 状态）

```ts
// workbench/types.ts
export type HomePageKey = 'recent' | 'spaces' | 'files' | 'agent' | 'connectors' | 'settings'
export type WorkspacePageKey = 'overview' | 'library' | 'outputs' | 'plan'

export type WorkspaceTabView =
  | { kind: 'page'; page: WorkspacePageKey }
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft' }                    // 新建工作：草稿会话；首条消息落成 session

export type WindowTab =
  | { id: 'home'; kind: 'home'; page: HomePageKey }
  | { id: `ws:${string}`; kind: 'workspace'; workspaceId: string; view: WorkspaceTabView }
  | { id: `file:${string}`; kind: 'file'; file: OfficeFile }

export interface WindowTabsState {
  tabs: WindowTab[]          // home 恒在 index 0
  activeTabId: string
}
```

store 增删（`workbench/state/store.ts`）：
- 新增：`tabs`、`activeTabId`、`openHome(page?)`、`openWorkspaceTab(id, view?)`、`openFileTab(file)`、
  `activateTab(id)`、`closeTab(id)`、`setHomePage(page)`、`setWorkspaceView(tabId, view)`。
- 保留：`workspaces`、`sessions`、`boot/refresh/refreshSessions`、workspace/session CRUD、`toggleSidebar`。
- 移除：旧 `view`/`activeSessionId`/`artifactScopes`/`openPage`/`showConversation`/`openArtifact` 系列
  （右侧产物面板由「文件标签 + 工作空间气泡窗」取代；`workbench/artifacts/*` 删除）。
- 草稿落成会话：`syncActiveSession(session)` 把对应工作空间标签的 `view` 从 `draft` 切到
  `{kind:'session',sessionId}`，并 upsert 进 `sessions`。
- 标签持久化：只把「打开的工作空间标签 + 激活标签」写 localStorage，重启恢复；文件标签不恢复。

## 3. 侧栏规格

| 区域 | 内容 | 行为 |
| --- | --- | --- |
| 全局侧栏（240px） | 品牌区（app 图标 + EverRoom / 副标题）；一级入口：最近 / 项目空间 / 所有文件 / Agent / 连接器；底部账户行（头像/名称/套餐，齿轮进设置） | 点入口 = 激活主页标签并切页；选中态用白卡浮起；账户行打开设置页 |
| 工作空间侧栏（248px） | 空间名（可点开重命名）；菜单：概览 / 新建工作 / 资料库 / 产物 / 计划；「工作 N」列表（= 该空间 sessions，运行中状态点 + 标题 + 相对时间，行悬停菜单：重命名/删除）；底部「在 <空间> 新建工作」按钮 | 点菜单切 `view`；点工作切到该 session；新建工作进草稿会话；列表 hover 出操作菜单 |
| 文件标签 | 无侧栏 | — |

窗口控制：macOS 继续 `hiddenInset`，标签栏左侧留红绿灯位并整条可拖拽；Windows 自绘按钮固定在
标签栏右端（复用 `components/WindowControls`）。

## 4. 主页标签内容

| 页面 | 真实数据 | 主要 UI |
| --- | --- | --- |
| 最近 | 文件库最近 N 条（`files.list`）、工作空间列表、recent sessions | 问候头 + 新建卡片（项目空间/文档入口）+ 最近空间 + 最近文件 |
| 项目空间 | `workspace.list` + 每空间 sessions 计数 | 空间网格/行表：名称、路径、工作数、最近打开；新建空间；点开进工作空间标签 |
| 所有文件 | `files.list`（分页/搜索） | 列表/网格切换、按来源筛选、搜索、点开文件进文件标签 |
| Agent | `agent.discoverLocalAgents` / `agent.getStatus` / `agent.getUsage` / `mcp.listServers` | 本机 Agent 卡片（状态/渠道）、用量、MCP 工具、打开 Agent 调试窗口 |
| 连接器 | 复用现有 `ConnectorsView`（已接真实 nango/agentAuth） | 包一层页面头，行为不变 |
| 设置 | 复用 `SettingsPage` | 从账户行进入 |

> 注：产品侧已无 knowledge 后端（Room/Wiki 模块删除），原型里的「知识库」入口不迁移；
> 主页一级入口收敛为真实能力。

## 5. 工作空间标签内容

| 视图 | 真实数据 | 说明 |
| --- | --- | --- |
| 概览 | workspace（名称/描述/目标/创建时间）+ sessions + 文件库 | A 项目头（名称行内编辑、描述、目标药丸、`MM/DD 开始 · N 项工作`、新建工作按钮）；B 洞察（取最近一次会话的最后一条 assistant 文本作一段话，空态文案）；C 动态（sessions + 文件按时间合并的倒序时间线，≤8 条） |
| 工作会话 | 会话（`useAgentSession` + AgentChatView/Composer） | 沿用 `conversation/ConversationPane`，放在工作空间标签内容区 |
| 资料库 | 文件库全量（**无法按空间过滤**：`file_entries` 没有 workspace 归属列、catalog 也不带 sourcePath，见 product-data-map；页面文案如实标「全局文件库」） | 文件管理器：搜索、来源筛选、上传、按相对目录分组/路径列、行操作（气泡窗打开/系统应用打开/导出定位）、点开进气泡窗 |
| 产物 | `sourceKind ∈ {agent-generated, artifact-imported}` 的文件（同上，全局范围） | 卡片/列表、按时间倒序、预览、导出定位 |
| 计划 | sessions（按 status 分列：进行中 running / 待开始 idle / 已结束 closed·interrupted） | 看板三列，卡片点开对应工作会话；新建工作入口 |
| 新建工作 | `agent.createSession` | 打开草稿会话；首条消息建会话并落进工作列表 |

新建流程：
1. 主页/项目空间页「新建项目空间」→ 弹窗：名称、描述、目标（药丸增删）、本地目录（`workspace.pickDirectory`），
   调 `workspace.create`（含 description/goals）。
2. 创建成功开工作空间标签，并弹两步引导：①上传资料（`files.pickAndImport`）
   ②添加工作（新建会话并命名）；每步可跳过。

气泡窗：
- 打开：资料库/产物/动态/会话文件提及 → 以 `{ files[], activeFileId, width, maximized }` 状态挂在
  工作空间标签组件里（组件级状态，多开隔离）。
- 交互：左缘拖拽调宽 360–720、最小化成右缘把手、最大化为覆盖内容栏的悬浮层、内部多文件标签、关闭走
  编辑器脏关闭守卫（`files.openOriginal`/实例关闭）。
- 内容：`office-proto/EditorView`（真实文件走 `NativeEditorHost`，Markdown 走 CodeMirror）；气泡内隐藏 Agent 停靠栏。

## 6. 真实数据映射 / 缺口

| 原型 mock | 真实来源 | 状态 |
| --- | --- | --- |
| 项目空间 | `window.nxcore.workspace` | 已有 |
| 空间描述/目标/开始日 | 已扩展 `agent_workspaces.description/goals` + contract + gateway 迁移 0090 + API 透传 | **已完成**（开始日直接用 createdAt） |
| 工作（task） | `AgentSession`（workspaceId 归属） | 已有 |
| 工作状态 | `session.status`（running/idle/interrupted/closed） | 已有，映射为进行中/待开始/已结束 |
| 资料库文件 | `window.nxcore.files`（`files.list` / `pickAndImport` / `openOriginal`） | 已有 |
| 产物 | 文件库 `sourceKind=agent-generated/artifact-imported` | 已有 |
| 计划看板 | sessions 按 status 分行 | 已有（只读排序；不伪造拖拽改状态） |
| 洞察 | 最近会话最后一条 assistant 文本（`agent.getSession/getEvents`） | 已有 API，渲染层派生（不要用已失效的 `writingStyle.*`） |
| 动态 | sessions + 文件库条目按时间合并 | 渲染层派生 |
| 知识库 | **无真实后端** | 不迁移 |
| 每日洞察（主页） | 无 | 不迁移，主页改为真实最近数据 |

## 7. 视觉与组件

- 只使用 `styles/tokens.css` + `styles/themes.css` 的 `--ui-*` token；四套主题（暖纸/素白/苔原/夜墨）继续生效。
- 新增 `workbench/ui/` 原语（Radix + CSS）：`Button`、`IconButton`、`Tooltip`、`DropdownMenu`、`Dialog`、
  `Segmented`、`Badge/Pill`、`EmptyState`、`Spinner`、`PageHeader`、`ScrollArea`、`Field`（输入/标签）。
  组件规则：1px hairline + 底色分层，不用默认阴影；浮层才用 `--ui-shadow-md/lg`；主操作才用实底主色。
- 图标统一 `lucide-react`；快捷键保留 ⌘N（新建工作/会话）、⌘K（命令面板）、⌘B（侧栏）、⌘J（工作空间气泡窗）。

## 8. 目录与文件归属（并行开发防冲突）

| 路径 | 内容 | 归属 |
| --- | --- | --- |
| `workbench/types.ts`、`state/store.ts`、`api.ts` | 标签模型 / 状态 / 网关适配 | Lead |
| `workbench/shell/*`、`workbench/ui/*`、`workbench/styles/workbench.css` | 外壳、标签栏、双侧栏宿主、UI 原语 | Lead |
| `workbench/home/*`、`workbench/home/home.css` | 主页六个页面 | Home 页 owner |
| `workbench/shell/CommandPalette.tsx`、`palette.css` | ⌘K 搜索跳转 | Lead |
| `workbench/workspace/OverviewPage.tsx`、`activity.ts`、`workspace-overview.css` | 概览 + 派生数据 hooks | Overview owner |
| `workbench/workspace/LibraryPage.tsx`、`OutputsPage.tsx`、`library.css` | 资料库/产物 | Files owner |
| `workbench/workspace/BubbleWindow.tsx`、`useBubble.ts`、`bubble.css` | 气泡窗（原生宿主时序敏感） | Lead |
| `workbench/workspace/PlanPage.tsx`、`CreateWorkspaceDialog.tsx`、`SetupWizard.tsx`、`setupData.ts`、`tools.css` | 计划/新建流程 | Workspace-tools owner |
| `workbench/conversation/*` | 会话 pane（复用，小改） | Lead |
| `packages/agent-contract`、`apps/gateway`（workspace 元数据）、`src/main`/`src/preload` | 后端字段 | Backend owner |
| `workbench/artifacts/*` | 删除 | Lead |

## 9. 验收

- `pnpm --filter @nxcore/desktop typecheck`、`pnpm --filter @nxcore/desktop test`（新增/更新 workbench 测试）。
- `vite.browser.config.mts` mock 渲染层 + Electron CDP 截图：主页标签、工作空间概览、资料库气泡窗、
  文件标签、新建空间流程、四套主题下无破版。
- 真实 dev 实例冒烟：建空间 → 传资料 → 新建工作 → 发消息 → 概览动态/洞察更新 → 气泡窗编辑保存。


## 10. 验收截图（浏览器 mock + 真实组件/Tokens 渲染）

> 截图放在 `docs/assets/tabs-workbench/`；mock 数据仅用于填内容，布局/组件/主题全部是真实代码。

| 主页 · 最近 | 主页 · 项目空间 | 主页 · 所有文件 | 主页 · Agent |
| --- | --- | --- | --- |
| ![最近](assets/tabs-workbench/01-home-recent.png) | ![空间](assets/tabs-workbench/02-home-spaces.png) | ![文件](assets/tabs-workbench/03-home-files.png) | ![Agent](assets/tabs-workbench/04-home-agent.png) |

| 主页 · 连接器 | 工作空间 · 概览 | 工作空间 · 资料库 | 工作空间 · 产物 |
| --- | --- | --- | --- |
| ![连接器](assets/tabs-workbench/05-home-connectors.png) | ![概览](assets/tabs-workbench/06-workspace-overview.png) | ![资料库](assets/tabs-workbench/07-workspace-library.png) | ![产物](assets/tabs-workbench/08-workspace-outputs.png) |

| 工作空间 · 智能体 | 工作空间 · 计划 | 气泡窗（挤压内容栏） | 新建空间三步引导 |
| --- | --- | --- | --- |
| ![智能体](assets/tabs-workbench/09-workspace-agents.png) | ![计划](assets/tabs-workbench/10-workspace-plan.png) | ![气泡窗](assets/tabs-workbench/11-workspace-bubble.png) | ![引导](assets/tabs-workbench/12-create-wizard.png) |

| 文件标签（窗口级） | ⌘K 命令面板 |
| --- | --- |
| ![文件标签](assets/tabs-workbench/13-file-tab.png) | ![命令面板](assets/tabs-workbench/14-command-palette.png) |

> 注：09（工作空间 · 智能体）与 12（新建空间三步引导）是当时的留档；「智能体」页已于同日移除、
> 引导改为两步，见 §12。

## 11. 实施记录（2026-10-30）

### 已完成

- **外壳**（Lead）：`workbench/shell/{Workbench,TabBar,HomeSidebar,WorkspaceSidebar,WorkspaceTabHost,FileTabHost,CommandPalette}.tsx`。
  窗口级标签栏（主页固定 + 每空间一标签 + 文件标签，⌘W 关标签）；侧栏随激活标签互斥切换
  （主页侧栏 / 工作空间侧栏 / 文件标签无侧栏）；⌘K 命令面板（工作空间/工作/文件跳转）；⌘B 侧栏；⌘J 气泡窗；
  标签恢复只持久化工作空间；每个标签页有独立错误边界（页面崩溃只影响该标签）。
- **状态层**（Lead）：`workbench/types.ts` 标签模型 + `state/store.ts`（tabs/activeTabId、标签增删激活、
  恢复/持久化、空白空间引导状态、脏关闭守卫注册表 `registerTabCloser`）。
- **后端**（backend-workspace-meta）：`AgentWorkspace.description/goals` + gateway 迁移
  `0090_agent_workspace_meta.sql` + 校验/单测；桌面端经 bridge 透传，无主进程改动。
- **主页**（home-owner）：最近 / 项目空间 / 所有文件 / Agent / 连接器 / 设置六页真实数据实现，
  设置与连接器复用现有组件（只包几何宿主）。
- **工作空间**（overview/files/tools owner）：概览（项目头行内编辑、真实洞察、动态时间线）、
  资料库/产物（真实文件库、筛选/搜索/导入、行操作）、智能体（主 Agent/本机 Agent/MCP/本空间偏好）、
  计划看板（按会话状态三列只读）、新建空间三步引导（修复原型「跳过丢结果」bug）。
- **气泡窗**（Lead）：`workspace/{BubbleWindow,useBubble}.tsx` —— 停靠右侧、拖宽 360–720、最小化把手、
  最大化为内容栏悬浮层、多文件标签、脏关闭守卫；原生编辑器只挂载激活文件并做矩形时序兜底。
- **文件标签**（Lead）：`shell/FileTabHost.tsx` —— 全宽 `office-proto/EditorView`（自带 Agent 停靠栏），
  仅激活标签挂载原生宿主。
- **测试**：`apps/desktop/tests/workbench-tabs.test.ts`（10）、`workbench-home.test.tsx`（6）、
  `workbench-overview.test.tsx`（12）、`workbench-library.test.tsx`（10）、
  `workbench-workspace-tools.test.tsx`（10）；gateway `agent-workspaces.test.ts` 4 例。
  渲染层 `tsc --noEmit` 0 错误。
- **视觉验收**：浏览器 mock 渲染层（`vite.browser.config.mts`）+ Electron 隐藏窗口截图核对
  主页六页 / 工作空间五页 / 新建空间弹窗 / 三步引导 / 气泡窗 / 文件标签 / ⌘K；四套主题走 token 自动生效。

### 与原型的有意偏差

1. 会话 pane 只在「该工作空间标签激活」时挂载（网关订阅单实例限制），不再让全部会话常驻；
   切走/切回会重新拉快照，run 在网关继续。
2. 资料库/产物是全局文件库（后端无 workspace 归属列），页面文案如实标注，不做假过滤。
3. 不迁移无真实数据支撑的「每日洞察 / 每天问候 / 知识库」；主页只展示真实文件/空间/会话/Agent/连接器。
4. 计划看板只读（状态由 run 驱动），不实现拖拽改状态。
5. 本空间「启用的智能体 / 经验便签」是 localStorage 本机偏好（后端无归属），UI 已标注。

### 2026-10-30 修补：顶栏「收起侧栏」按钮

- **根因 1（交互）**：`IconButton`/`Button` 是普通函数组件，被 Radix `Tooltip.Trigger asChild`
  包住时不转发 ref（控制台有 "Function components cannot be given refs" 警告），tooltip 与触发器
  语义不可靠。已改为 `forwardRef`，全站 Hint/菜单/弹窗的 asChild 触发器都恢复正常。
- **根因 2（死按钮）**：文件标签本来没有侧栏，但顶栏仍渲染「收起侧栏」按钮——点了当然没有可见效果。
  现在按激活标签决定是否渲染：主页/工作空间标签才有侧栏按钮，文件标签不渲染。
- **状态可见性**：按钮图标随状态切换（`PanelLeftClose` 收起 / `PanelLeftOpen` 展开），
  带 `aria-expanded`；侧栏改为「保持挂载 + max-width 过渡」收起，内容区平滑铺满，
  再次展开不丢侧栏内部滚动/选中状态。
- 回归测试：`apps/desktop/tests/workbench-tabbar.test.tsx`（3 例：点击切换、工作空间标签、文件标签无死按钮）。
- 截图：`docs/assets/tabs-workbench/15-sidebar-collapsed.png`。

### 2026-10-30 补充：对话区右上角「资料与文件」入口

旧版工作台在顶栏右侧有「文件面板」入口；新布局里对话区（工作会话/新建工作草稿）顶部新增了一条 42px 会话头：

- 左上：当前工作标题 + 工作空间名；右上：**「资料与文件」按钮**（旧版入口的对应物）。
- 点击后右侧气泡窗展开为**浏览态**：搜索 + 「全部 / 资料 / 产物」筛选计数 + 真实文件库列表，
  点任意文件就在气泡内打开成标签；顶部文件夹按钮可在「浏览 / 当前文件」之间来回切；
  「导入」按钮走 `files.pickAndImport`，完成后自动刷新；⌘J 同样打开浏览态（没有打开文件也能开）。
- 关掉最后一个文件标签不再收起面板，而是回到浏览列表；只有气泡右上角的关闭按钮才真正收起（走脏关闭守卫）。
- 新增回归测试 `apps/desktop/tests/workbench-bubble.test.tsx`（5 例：入口打开浏览态 / 打开文件 / 切回浏览 /
  关最后一个文件回浏览 / 显式关闭收起）。

#### 极简化 + 状态动画（同日第二轮）

- **入口与面板按钮全部去文字**：对话区右上角只剩一个文件夹图标（tooltip 说明），面板头只有
  文件夹 / 收起 / 最大化 / 关闭四个图标按钮；面板内「导入」也改成图标按钮。
- **会话头更轻**：38px、无底色、仅一条 hairline；标题降为 12.5px 次级色，不再显示空间名（侧栏已有）。
- **收起 / 关闭各有独立退场动画**：
  - 收起（最小化）→ 面板向右收拢淡出 150ms，再换成右缘把手（把手淡入）；
  - 关闭 → 面板向右淡出 160ms 后才卸载 DOM（关闭仍先走原生编辑器脏关闭守卫）；
  - 打开 / 从最小化还原 → 面板自右滑入；浏览列表 ↔ 文档切换有一次 140ms 淡入；
  - 最大化 → 右缘锚点 180ms 缩放淡入；
  - `prefers-reduced-motion` 下全部关闭动画。
- **最小化态语义修正**：把手不再显示「0 个文件」，只有存在文件时才显示数量；最小化时对话区入口
  的 aria-expanded 为 false，点它直接还原面板（而不是误触发关闭）。
- 截图：`16-chat-files-entry.png`、`17-chat-files-open.png`、`18-chat-files-minimized.png`。

### 2026-10-30 修补：文件标签停靠栏「对话记录」看不到 / 离开再回来就丢

现象：文件标签右侧 Agent 停靠栏的会话下拉（「本地会话 / 新对话」）不显示任何历史会话；
在停靠栏里聊完、切到别的标签再回来，刚才的对话既不在下拉里也选不回来。

根因（读写分区键不一致）：停靠栏用 `useAgentSession(file.name)` 列会话，即按 `pageLabel`
（= 文件名）调 `GET /v1/agent/sessions`，网关对 `pageLabel` 做**精确匹配**；但
`useAgentSession` 内部 `createSession` 把 `pageLabel` 写死成 `'Agent'`。于是停靠栏新建的
会话没有一个能被自己列出来：首次打开下拉为空；文件标签宿主只在激活时挂载（见上文
「原生编辑器」），切走再回来组件重挂、重新 `listSessions(file.name)`，会话从下拉里消失。
用文件名当分区键本身也不稳：改名/同名/超长（网关 pageLabel 上限 120）都会让历史落到别的分区。

修复（`components/agent/useAgentSession.ts` + `office-proto/AgentChatDock.tsx`）：
1. `useAgentSession` 增加 `sessionKey`（会话读写的分区键，缺省回退 `pageLabel`）。停靠栏传
   文件稳定 id（`file.id`）；`pageLabel`（文件名）只作为「当前页面」运行上下文，不参与分区。
   `listSessions` 与 `createSession` 都用 `sessionKey`，写入/读取一致；改名、同名、超长文件名
   都不会丢历史。
2. 启动恢复：显式传 `initialSessionId`（工作台的会话视图）时严格按它选；未传（停靠栏）时
   若 localStorage 里全局记住的会话不属于当前分区，回落到本分区最近一条会话，不再误停在
   草稿态（改动前这里会直接丢掉列表里的历史会话）。
3. 工作台（`workspaceId` 模式）行为不变：仍全量拉取后按工作区过滤、隐藏 AI 辅助会话。

回归测试：`apps/desktop/tests/agent-session-page-scope.test.tsx`（6 例，修改前红——写入的
pageLabel 是 `'Agent'` 而非分区键；修改后绿：含重挂恢复、改名不丢、超长文件名、跨分区回落、
工作台模式）与 `apps/desktop/tests/agent-chat-dock-sessions.test.tsx`
（2 例，断言真实 `AgentChatDock` 的「对话记录」下拉能看到本文件会话、重挂后仍能看到并选中）。
注：停靠栏会话没有工作区归属，网关按默认工作区暴露，因此也会出现在默认工作区的「工作」列表里。

### 2026-10-30 第三轮：过渡同步 + 精简面板控件

- **打开/收起右侧文件面板时对话区同步平滑让位**：面板开合的关键帧改为「宽度 0 ↔ 目标宽度」一起动画
  （`wb-bubble-in` / `is-closing` / `is-minimizing` 都带 width 收放），内容区不再先跳一下再等面板滑入；
  实测面板 0→330→470→480px 的同时，对话区 1190→854→712→702px 连续变化。
- **去掉重复按钮**：面板打开时对话区右上角的文件夹入口不再渲染（面板自己已有浏览/收起/关闭），
  任何时刻只有一个同样的图标；关闭面板后入口自动回来。
- **精简面板内的多余控件**：删除搜索框、刷新、上传三个控件；面板只保留「全部 / 资料 / 产物」三个过滤
  chip + 文件列表（列表仍支持点击打开、顶部文件夹切回浏览）。
- 截图：`docs/assets/tabs-workbench/19-chat-files-clean.png`。

### 2026-10-30 第四轮：统一面板状态机（消除长条把手与闪烁）

- **收起不再出现长条**：删掉右缘「最小化把手」。收起 = 面板宽度动画到 0 后卸载，
  对话区右上角的**同一个图标按钮**重新出现；首次打开与收起后的入口外观完全一致。
- **一套可动画状态机**：可见性 / 退场类型（close / minimize）统一在 `useWorkspaceBubble` 里管理，
  宿主只按 `visible + exitKind` 渲染，避免「面板 ↔ 把手」两套 UI 切换导致的闪烁。
- **最大化改为布局内展宽**（不再用 absolute 悬浮层）：宽度走 240ms 过渡，对话区逐帧同步收窄，
  不再出现「瞬间跳一下 + 悬浮层盖上来」。
- **抖动治理**：
  - 宽度动画期间把面板内层冻结在目标宽度（外层 `overflow:hidden` 只做裁剪），列表文字不逐帧重排；
  - 退场 keyframes 把宽度、右外边距、边框一起收到 0，面板卸载瞬间对话区不会再跳 8px/2px；
  - 对话区入口按钮用固定占位（隐藏而非卸载），收起/展开完成时标题不再被挤动一下；
  - `.wb-ws-main` / 对话区加 `contain: layout paint`，把重排限制在局部；
  - 缓动改为 `cubic-bezier(0.4, 0, 0.6, 1)`（起止都更柔），退场 220ms、宽度过渡 240ms。
- **关闭退场期间保留内容**：不会出现「点关闭 → 文档瞬间变成空文件列表 → 再淡出」的闪烁，
  等 220ms 退场动画结束后才清空标签并卸载。
- 截图：`20-panel-open.png`、`21-panel-maximized.png`、`22-panel-collapsed.png`（收起后入口仍是同一个按钮，
  没有长条把手）。
- **最大化态收起也走同一条动画**：`.is-maximized` 的宽度之前带 `!important`（退场 keyframes 抢不过它，
  面板会「宽度不动、直接消失」）；现在去掉 `!important`、退场期间保留 maximized 状态（宽度起点就是
  clamp 后的实际宽度），最大化 → 收起也能从 854px 连续收到 0，对话区 320→1190px 同步展开。

### 2026-10-30 第五轮：侧栏开关移到标签栏左侧

- 全局「收起/展开侧栏」按钮从标签栏右上角移到**最左侧**（macOS 红绿灯右侧，应用惯例位置），
  图标仍是 `PanelLeftClose / PanelLeftOpen`，⌘B 不变。
- 左侧保留固定 30px 占位：切到文件标签（没有侧栏）时只隐藏按钮，主页/标签位置不会左右跳。
- 右侧只留搜索与 Windows 自绘窗口按钮。
- 截图：`23-sidebar-toggle-left.png`。

### 运行/验收提示

- 新迁移与新字段需要**重启 dev 的 gateway 进程**后生效（`pnpm --filter @nxcore/desktop dev` 会拉起）。
- `vite.browser.config.mts` 的 mock 已补 workspace/session/文件/MCP/用量数据，供无后端预览；
  设置页在旧 mock 下会因缺 MCP/用量形状白屏，现已补齐入口且外壳有错误边界兜底。

## 12. 变更：移除工作空间「智能体」页（2026-10-30）

工作空间标签不再有「智能体」页面（主页侧栏的「Agent」页保留，全局 Agent 状态仍在那里看）。

- **入口/路由**：`WORKSPACE_PAGES` 去掉 `agents`（侧栏只剩 概览 / 新建工作 / 资料库 / 产物 / 计划），
  `WorkspacePageKey` 收窄为 `overview | library | outputs | plan`；`WorkspaceTabHost` 删除路由分支。
- **页面与数据层**：删除 `workspace/AgentsPage.tsx` 与 `workspace/agentCatalog.ts`（主 Agent 状态 /
  本机 Agent / MCP / 本空间启用列表 / 经验便签）。仅引导还需要的导入结果归一、本地 id、错误文案
  迁到 `workspace/setupData.ts`。
- **新建空间引导**：由三步改为**两步**（上传资料 / 添加工作）——「添加智能体」步骤与工作表单里的
  「指派给」下拉一并移除（启用列表原本只在该页展示，留着会写进无处可见的本机偏好）。
  localStorage 键 `everroom:workspace:agents:*`、`everroom:workspace:agent-notes:*` 不再读写；
  旧数据留在浏览器本地，不做迁移/清理。
- **样式**：`tools.css` 删除 `wb-main-agent-*`、`wb-agent-*`、`wb-switch*`、`wb-mcp-*`、`wb-note-*`、
  `wb-tool-section* / wb-tool-scope / wb-tool-count / wb-tool-hint / wb-tool-loading` 等只服务该页的规则，
  保留计划看板与引导仍用的部分。
- **测试**：`tests/workbench-workspace-tools.test.tsx` 删除智能体页用例，引导用例按两步重写
  （含「最后一步跳过不丢已导入资料」回归）。
- **不受影响**：legacy 外壳 `office-proto/pages/AgentView.tsx`（只读原型，未挂在产品路由上）、
  `agent.discoverLocalAgents / getStatus / getUsage`、`mcp.listServers` 桥接口，
  以及主页「Agent」页。
