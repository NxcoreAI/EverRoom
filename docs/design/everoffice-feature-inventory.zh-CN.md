# EverOffice 原型布局与功能清单（移植盘点）

- 来源：`/Users/xjwang/EerRoom/everoffice`（main），只读盘点；目标端 `apps/desktop` 不得照搬原型样式/token，本清单只描述**结构、状态与行为**。
- 路径约定：无前缀的文件名均相对 `src/renderer/src/office-proto/`；`office-proto.css` 即该目录下文件，`home-spaces.css` 同目录。
- 原型特征：单窗口、窗口级标签栏；所有数据为 mock（`data.ts` / `workspace.ts`），状态全部在 React 内存，无持久化、无路由、无后端。
- 其它路径：`src/main/index.ts`、`src/main/genoffice/bridge.ts`、`src/renderer/src/desktop-frame.css`、`src/renderer/src/components/agent/*`。
- 目标端现状（供差集参考）：已有文件标签 + 主页 + `MainHeader` + 右侧产物面板 + 命令面板，见 §8.3。

---

## 1. 窗口外壳

结构（`OfficeProto.tsx:106-144`）：

```
.op-root (flex column, height:100vh)
├─ TabBar (窗口级，含假红绿灯/主页/文件与工作空间标签/“+”)
└─ .op-window-body (flex row)
   ├─ 主页 tabpane → HomeView（左侧栏 + 右侧滚动内容）
   └─ 每个 tab 一个 tabpane（常驻挂载，display 切换）
```

- 标签栏在最外层，侧边栏属于各 tab 内部：主页有自己的 248px 侧栏，工作空间有自己的 248px 侧栏，文件 tab 没有侧栏（`OfficeProto.tsx:108-109`）。
- 标签类型：`{type:'file', file}` 与 `{type:'workspace', meta, fresh?}`（`workspace.ts:26-31`）；`tabId` 取 `file.id` 或 `meta.id`，`tabName` 取文件名或 `meta.title`。
- 主页不是数组元素，而是 `activeId === null` 的固定 tab（`OfficeProto.tsx:119-126`），因此不可关闭、不可重排、永远排第一。

### 1.1 打开规则

- 打开文件：按 `file.id` 去重后追加并激活；已存在则只激活（`OfficeProto.tsx:35-38`）。
- 打开工作空间：**不去重**，每次追加新 tab；`id = ws-${Date.now()}`；名字取点击项，描述/目标/起始日却按“当前工作空间 tab 数量”从 `workspaceSeeds` 取（`OfficeProto.tsx:41-48`、`workspace.ts:285-326`）。→ 点第 2 个空间会拿到第 1 套种子文案，移植时必须改为按空间 id 取数。
- 新建：标签栏“+”菜单（`OfficeProto.tsx:214-241`）提供 文档/表格/演示/笔记 四项（`OfficeProto.tsx:247-252`）与“项目空间”；前四项直接 `blankFile(kind)` 开文件 tab（`data.ts:423-452`），项目空间走创建弹窗（`OfficeProto.tsx:51-65`）。
- 创建流程产出的 tab 带 `fresh:true`，初始化空任务/空智能体/不含种子文件，并自动弹三步引导（`WorkspaceView.tsx:53-68`、`WorkspaceView.tsx:336-342`）。

### 1.2 关闭与激活

- 点击 tab 或关闭后再激活：纯 `setActiveId`（`OfficeProto.tsx:190-213`）；主页按钮置 `null`。
- 关闭文件 tab：先 `window.desktop.office.close(id)` 过主进程脏关闭守卫，返回 `false`（用户在保存框点取消）则保留标签；Markdown 没有原生实例，守卫直接放行（`OfficeProto.tsx:99-103`、`bridge.ts:357-370`）。
- 关闭工作空间 tab：从 `workspaceBubbleFiles` 注册表取气泡内文件，逐个串行过脏守卫，跳过 `.md`；任一取消 → `toast("气泡内有文件未保存，项目空间已保留")` 并保留整个 tab（`OfficeProto.tsx:84-97`、`WorkspaceView.tsx:117-123`）。
- 关闭活动 tab 后激活原位置的下一个，若无则最后一个，全无则回主页（`OfficeProto.tsx:72-79`）。
- 关闭工作空间**不**确认草稿聊天内容、不确认未落成的 draft 工作；关闭 Markdown 气泡文件不等守卫，编辑内容直接丢失（`WorkspaceView.tsx:136-152`）。
- 无拖拽重排、无右键菜单、无中键关闭、无 ⌘W/⌘1..9、无标签溢出下拉；标签过多时 `.op-tablist` 横向滚动且隐藏滚动条（`office-proto.css:380-381`）。

### 1.3 每个 tab 的状态/滚动保留

- 所有 tabpane 常驻挂载，只切 `display:none/flex`（`OfficeProto.tsx:127-139`、`office-proto.css:682-683`）→ React state、CodeMirror 实例、聊天草稿、气泡状态在切 tab 后都保留。
- 工作空间内的任务会话 pane 同样常驻（`WorkspaceView.tsx:304-319`、`office-proto.css:1296-1297`）；draft 落成任务时 id 不变，React 按 key 复用同一聊天实例。
- 代码没有显式保存/恢复 `scrollTop`；滚动容器是 DOM 复用（tabpane 隐藏再显示），不要把它当契约，移植时应把滚动位置存进 tab 状态。
- 主页侧栏页是**条件渲染**（`OfficeProto.tsx:328-345`），切菜单会卸载页面组件；仅 `view` 与 `.op-scroll` 容器保留。
- 工作空间页同理：概览/资料库/产物/智能体/计划切走即卸载（`WorkspaceView.tsx:295-303`），页面局部 UI state（搜索词、当前文件夹、看板卡片）会重置；被提升到 `WorkspaceView` 的数据（任务/资料库/智能体）不丢。
- 概览里改名/描述/目标写回 `wsMeta` 局部态（`WorkspaceView.tsx:50-51`），**不回写 tab 栏**，所以标签标题会停留在旧名字。

### 1.4 窗口拖拽与红绿灯

- 标签栏空白区 `-webkit-app-region: drag`，其中按钮/标签全部 `no-drag`（`desktop-frame.css:16-24`）。
- macOS 用 `titleBarStyle:'hiddenInset'` + `trafficLightPosition:{x:16,y:20}`（`main/index.ts:30-34`）；`html[data-desktop='darwin']` 下隐藏 DOM 假红绿灯，标签栏 `padding-left:96px` 让位（`desktop-frame.css:7-14`）。非 macOS 保留系统标题栏，DOM 三色点仅作装饰（`OfficeProto.tsx:177-179`）。
- 窗口最小 1080×680，默认 1440×900（`main/index.ts:23-27`）。
- 关窗先串行跑所有原生实例的脏守卫，全部放行才 `destroy`（`main/index.ts:44-55`、`bridge.ts:100-110`）。

---

## 2. 主页 tab

外壳：`HomeView` = 248px 侧栏 + `.op-home-main > .op-scroll`（`OfficeProto.tsx:314-350`、`office-proto.css:62-72`、`office-proto.css:129-133`）。侧栏不跨 tab 共享。

### 2.1 左侧栏

- 品牌：30px squircle “E” + `EverRoom` / `Office` 两行，纯展示（`OfficeProto.tsx:266-272`）。
- 六个一级菜单（注释写“五/六”，实际 6 项）：最近 `recent`、项目空间 `spaces`、所有文件 `files`、Agent `agent`、知识库 `kb`、连接器 `connectors`（`OfficeProto.tsx:256-263`）；选中态系统蓝底白字（`office-proto.css:103-104`）。
- 账户 footer：头像“王” + “王小雨” + 齿轮；原型里是**无 onClick 的按钮**，仅 hover 显示齿轮（`OfficeProto.tsx:287-293`、`office-proto.css:111-120`）。目标端已在同位置接 `SettingsView`（目标 `OfficeProto.tsx:75`）。
- `view` 状态在 `HomeView` 内，切 tab 再回来保持上次菜单。

### 2.2 最近（RecentView）

- 问候区：按小时切“早上好/下午好/晚上好/夜深了”，副文案写死“3 封新邮件 1 场会”（`RecentView.tsx:10-16`、`RecentView.tsx:59-62`）。
- 每日洞察卡：AI 徽章 + 标题 + 来源/更新时间 + “刷新” + 打字机正文（2 字/24ms，`prefers-reduced-motion` 时全量直出）+ 动作胶囊 + 落款（`RecentView.tsx:20-39`、`RecentView.tsx:141-186`、`office-proto.css:138-187`）。
  - “刷新”只重放打字机并 toast（不取数）；动作 `type:'open'` 开文件 tab、`type:'draft'` 弹起草遮罩（`RecentView.tsx:162-168`、`RecentView.tsx:51-55`、`data.ts:187-190`）。
- 起草遮罩：4 条固定步骤（`data.ts:393-398`），每 700ms 推进、结束 450ms 后打开 `draftFile()`（AI 周报）到文件 tab（`RecentView.tsx:188-216`、`data.ts:454-465`）。
- “新建”分栏：左“项目空间”1 个“空白空间”瓦片（实际打开创建弹窗，不是直接开空白），右 4 个文件瓦片：文字文档/表格/演示/Markdown（`RecentView.tsx:66-100`、`home-spaces.css:4-14`）；瓦片 `flex:1; max-width:150px`（`office-proto.css:237-245`）。
- “最近”分栏：3 个项目空间（时间 + 工作数 + “打开”）+ 4 个文件行（图标/名/时间/大小）（`RecentView.tsx:102-131`）。点空间 → `openWorkspace(name)`（种子工作空间 tab）。

### 2.3 项目空间（SpacesView）

- 标题 + 说明 + “全部空间”卡：4 行（名称/描述/工作数·产物数/更新时间）+ 最后一行“新建项目空间”（`SpacesView.tsx:16-43`）。
- 新建行文案说“进去再命名”，实际先弹创建弹窗（`SpacesView.tsx:32-41`）。
- 无搜索、无排序、无卡片/列表切换、无删除/编辑空间入口。

### 2.4 所有文件（AllFilesView）

- 复用 `FileTable`：类型 Seg（全部/文档/表格/演示/PDF/Markdown）+ 文件名搜索（即时过滤，可清空）+ 视图切换（列表可用，网格点了只 toast“原型暂未开放”）+ 固定表头（“修改时间”带排序箭头但不可点）+ 64px 行（图标/名/时间/大小/hover “⋯”）（`parts.tsx:124-191`、`AllFilesView.tsx:12-17`）。
- 行“⋯”只 toast“重命名 / 移动 / 分享（原型）”（`parts.tsx:185`）；空结果显示“没有匹配的文件”。

### 2.5 Agent

- Hero：头像 + “工作台 Agent” + “运行中” pill + 副标题 + “管理”（占位 toast）（`AgentView.tsx:31-41`）。
- 六个页内 tab：记忆 / 会话记录 / MCP 工具 / Skills / 人格 / 用户画像（`AgentView.tsx:12-19`）。
- 记忆：5 条卡片（类型色块/标题/引文/来源/被引用数），点击仅 toast 引文；会话记录：5 条（标题/时间/时长/轮数/关联文件 chip），点击打开关联文件 tab，无关联则 toast（`AgentView.tsx:57-119`）。
- MCP 工具：4 行只读（名称/transport/连接 pill/工具 chips），无增删；Skills：4 张卡，开关只改组件内 state + toast（`AgentView.tsx:121-173`）。
- 人格：风格 chips + 提示词摘要 + “编辑”占位；用户画像：4 组信息卡（`AgentView.tsx:175-210`）。

### 2.6 知识库

- 列表：5 张卡（emoji/标题/来源数/更新时间）+ “新建知识库”占位；详情：返回 + 标题（来源数/文档数/记忆总条数，由 `file.memoryCount` 累加）+ 来源行（类型色块/标题/时间/已索引|同步中）（`KnowledgeView.tsx:18-41`、`KnowledgeView.tsx:49-84`）。
- 有 `fileId` 的来源打开文件 tab；邮件/会议/网页来源只 toast“暂不支持预览”。

### 2.7 连接器

- 标题 hint 动态计算“已连接 n/9”；分类 Seg：全部 + 4 类（`ConnectorsView.tsx:35-44`）。
- 9 张卡片：品牌 logo/名称/描述/状态圆点（✓ 或 +），点击开右侧抽屉（`ConnectorsView.tsx:46-63`）。
- 抽屉 380px：logo、名称、分类、描述、权限范围 chips、连接状态、连接/断开按钮；点遮罩或 Esc 关闭；开关只改本页 state + toast，不影响工作空间智能体的连接器列表（`ConnectorsView.tsx:26-33`、`ConnectorsView.tsx:65-102`、`office-proto.css:950-963`）。

---

## 3. 工作空间 tab

`WorkspaceView` 是整个迁移的核心：一个 tab 一个实例，全部状态组件级，多开天然隔离（`WorkspaceView.tsx:24-29`）。

### 3.1 左栏（248px）

- 顶部标题 = `wsMeta.title` 单行省略（`WorkspaceView.tsx:241`、`office-proto.css:1243-1246`）。
- 六个菜单：概览 / 新建工作 / 资料库 / 产物 / 智能体 / 计划（`WorkspaceView.tsx:31-38`）。
- 下段“工作”列表：标题 + 数量徽标（只算已落成任务，不含 draft）+ 可滚动列表（`WorkspaceView.tsx:257-291`、`office-proto.css:1260-1272`）。
  - draft 行：标题“新工作” + 右侧“草稿”（`WorkspaceView.tsx:263-275`）。
  - 任务行：置顶图标 + 标题 + `updatedLabel` + hover 才出现的“⋯”（`WorkspaceView.tsx:405-421`、`office-proto.css:1595-1613`）。
  - 排序：置顶稳定前置，其余保持原序（`WorkspaceView.tsx:112-115`）。
- “⋯”菜单（fixed 定位，避滚动裁剪）：置顶/取消置顶、重命名、删除；越界时翻到按钮上方（`WorkspaceView.tsx:89-94`、`WorkspaceView.tsx:344-360`）。
- 重命名：整行变 input，Enter/失焦提交，Esc 取消；删除：从列表移除，若正开着该任务会话则跳回概览，均 toast（`WorkspaceView.tsx:365-403`、`WorkspaceView.tsx:106-110`）。
- 无搜索、无分组、无拖拽排序、无批量操作。

### 3.2 内容栏

- 菜单页统一包在 `.op-scroll`：概览/资料库/产物/智能体/计划（`WorkspaceView.tsx:295-303`）。
- 任务/草稿会话 pane：`[...tasks, draft]` 全量常驻，active 才显示（`WorkspaceView.tsx:304-320`）；pane 内是 `AgentChatDock`，文件用 `pseudoTaskFile(t)` 伪造（`workspace.ts:363-374`）。
- “新建工作”不建页面：已有空稿复用，否则 `blankDraftTask()` 开草稿；草稿首次发消息才落成任务（标题取前 22 字、`running`、摘要“已接收工作，正在准备”、插到最前，id/chatLabel 不变）（`WorkspaceView.tsx:165-178`、`workspace.ts:346-360`）。
- 打开文件统一走 `onOpenFile → openBubbleFile`（气泡窗），不会开文件 tab（`WorkspacePages.tsx:20-24`、`WorkspaceView.tsx:231`）。

### 3.3 新建项目空间（两段式）

第一段 `WsCreateModal`（`WsCreateFlow.tsx:24-152`）：

- 字段：项目名称（必填，Enter 提交，创建按钮 disabled 直到非空）、描述 textarea、多个目标（Enter 或逗号添加、重复忽略、空输入 Backspace 删最后一个、失焦也添加）、本地目录（系统目录选择器，单选，可清除）。
- Esc / 遮罩关闭？只有 Esc 与取消按钮；点遮罩不关闭（`WsCreateFlow.tsx:37-41`、`WsCreateFlow.tsx:66`）。
- 创建后：新 tab `{meta:{id:ws-<ts>, title:'项目空间 · name', description, goals, localDir, startedLabel:'M/D', origin:'fresh'}, fresh:true}`，并关闭弹窗（`OfficeProto.tsx:51-65`）。

第二段 `WsSetupWizard`（空间内，`WsCreateFlow.tsx:172-395`）：

- 标题“欢迎来到「name」” + “一键全部跳过”；无 Esc、点遮罩不关闭。
- 三个步骤可点圆点跳转（无校验/无门禁）：上传资料 / 添加智能体 / 添加任务（`WsCreateFlow.tsx:162-166`、`WsCreateFlow.tsx:243-260`）。
- 步骤 1：文件/文件夹多选，显示类型图标、名称、大小或“n 项”，可移除；空态提示可跳过（`WsCreateFlow.tsx:263-298`）。
- 步骤 2：全部系统智能体（emoji/名/定位）逐个“添加/已添加”切换；步骤 3：任务名 input + 指派下拉（自己/已添加智能体）+ 添加、可移除，未加智能体时提示回第 2 步（`WsCreateFlow.tsx:300-379`）。
- 跳过语义：“跳过此项”清空本步已选再下一步；底部提示写明“下一步保存本步选择；跳过此项不保存”（`WsCreateFlow.tsx:210-215`、`WsCreateFlow.tsx:382-391`）。
- **已知缺陷**：在最后一步点“跳过此项”会 `onDone(empty)`，把前两步已选资料/智能体一起丢弃（`WsCreateFlow.tsx:211-215`）；移植时应改为提交已完成步骤。
- 完成后写入：资料 → 新文件夹树 + `extraFiles` + `fileFolder` 映射（每个上传文件给空内容占位）；智能体 → 追加选中项；任务 → `status:'idle'`、摘要“待启动 · 指派给 X/自己”、`assigneeLabel`（`WorkspaceView.tsx:180-221`、`workspace.ts:408-446`）。
- 全部跳过也能完成，toast“空间已就绪，可随时补充设置”；随后 `onSetupDone` 摘掉 `fresh`（`OfficeProto.tsx:68-70`）。
- 上传只是命名/目录结构，**不落盘、不读真实内容**；资料库页也没有上传入口。

### 3.4 概览页

单列三区，最大宽 1080、gap 24（`WorkspacePages.tsx:61-254`、`office-proto.css:1472-1475`）：

- 项目头：大标题（点击或笔图标行内改名，Enter 提交 / Esc 取消，“前缀 · X”只改 X）+ “＋ 新建工作” + 描述（点击编辑 textarea）+ 目标带（Crosshair 药丸，只能新增，无删除/编辑）+ meta 行“M/D 开始 · M/D 目标 · n 项工作” + 本地目录（有才显示）（`WorkspacePages.tsx:126-197`）。
- 洞察卡：复用主页卡外观，但**无刷新按钮、无动作胶囊**；`fresh` 空间显示“等待第一项工作”占位，否则打字机播放 `workspaceInsight`（`WorkspacePages.tsx:199-218`、`workspace.ts:98-103`）。
- 动态卡：标题 + “工作与文件名可点击”提示；每行 = 类型色块图标（7 类）+ 可点片段（task → 会话；file → 气泡）+ 相对时间；默认 5 条，超过可“显示更早/收起”；`fresh` 不显示 mock 洞察/动态（`WorkspacePages.tsx:74-75`、`WorkspacePages.tsx:220-251`、`workspace.ts:107-146`）。
- 页内局部状态：`editing`、`draft`、`addingGoal`、`goalDraft`、`showAllActivities`（`WorkspacePages.tsx:64-68`）。

### 3.5 资料库（文件管理器）

- 顶部工具行：返回上一级、面包屑（资料库 / 子夹…）、搜索框（210px）、网格/列表切换（搜索中禁用）（`WorkspacePages.tsx:359-420`、`office-proto.css:1774-1788`）。
- 数据：`(includeSeedFiles ? files : []) + extraFiles`，再应用 `deleted` 与 `renames`（`WorkspacePages.tsx:281-284`）。
- 网格：文件夹在前（44px 图标 + 名称 + 直接子项数）、文件在后（46px 图标 + 名称 + 更新时间），`minmax(104px,1fr)`；计数只算直接子文件，空文件夹显示“此文件夹为空”（`WorkspacePages.tsx:461-477`、`WorkspacePages.tsx:315`、`office-proto.css:1790-1805`）。
- 列表：6 列 = 图标/名称/本地位置/修改时间/大小/操作，`minmax(170,1.5fr)` 等（`WorkspacePages.tsx:479-514`、`office-proto.css:1811-1815`）。
- 搜索：全局搜文件夹与文件（忽略当前目录），文件夹行显示父路径与子项数；点文件夹清空搜索并进入（`WorkspacePages.tsx:318-321`、`WorkspacePages.tsx:422-460`）。
- 文件菜单（fixed 两步浮层）：打开 / 移动到… / 重命名 / 删除；“移动到…”列出根目录 + 全部文件夹（缩进表示层级，当前所在禁用）（`WorkspacePages.tsx:518-547`）。
- 重命名行内 input；删除是软删除（进 `deleted` 数组），toast（`WorkspacePages.tsx:341-350`、`WorkspacePages.tsx:553-620`）。
- 计数只算直接子文件，不含子文件夹递归；空文件夹显示“此文件夹为空”（`WorkspacePages.tsx:315`、`WorkspacePages.tsx:515`）。
- 无新建文件夹、无上传、无排序/筛选、无拖拽移动。

### 3.6 产物

- 由所有任务的 `outputIds` 去重后映射到全局 `files`（`WorkspacePages.tsx:624-637`）。
- 复用 `FileTable`（类型筛选、搜索、行菜单 toast）；无产物时是空表 + “没有匹配的文件”。
- 不会展示气泡里的临时文件或上传文件（除非其 id 进了 `outputIds`）。

### 3.7 智能体

- 列表：卡片网格（emoji/名/启停/定位/“n 技能 · n 连接器 · n 条经验”）+ “新增智能体”卡（`WorkspacePages.tsx:919-953`、`office-proto.css:1829-1845`）。
- 新增表单：名称（必填，缺失 toast）、头像 emoji（默认 🤖）、一句话定位、人格提示词；创建后追加到 `agents` 并 toast（`WorkspacePages.tsx:676-738`、`workspace.ts:259-272`）。
- 详情：返回、大头像、名称、启用 pill、启停开关；四个页内 tab：人格（风格 chips + 提示词）、技能（已添加卡 + 移除 + “添加技能”弹窗）、连接器（已添加行 + 移除 + “添加连接器”弹窗）、经验（只读时间线，无新增）（`WorkspacePages.tsx:741-917`）。
- 选择弹窗只列未添加项，点“+”加入且弹窗不关，Esc / 遮罩 / 完成关闭；无删除智能体、无编辑人格、经验不可写（`WorkspacePages.tsx:871-914`、`WorkspacePages.tsx:956-973`）。

### 3.8 计划（看板）

- 4 列固定：未开始/进行中/已完成/已取消，每列 flex 1 min 230，列头圆点+标题+计数（`PlanKanban.tsx:13-20`、`PlanKanban.tsx:95-124`、`office-proto.css:1425-1440`）。
- 卡片：标题 + 负责人头像（王/E）；HTML5 draggable，跨列 drop 改 status，拖动中降透明，列 hover 高亮（`PlanKanban.tsx:126-151`、`PlanKanban.tsx:102-118`）。
- 新建：点“新建任务”出现行内 input，Enter 添加（固定落“未开始”、owner 王小雨），Esc 取消（`PlanKanban.tsx:60-93`、`PlanKanban.tsx:49-55`）。
- 搜索/筛选按钮是占位（`tabIndex:-1`，无 handler）；无卡片菜单、无编辑/删除、无负责人切换、无截止日期；状态只在组件内，**切到别的菜单页就重置为种子 6 条**（`WorkspaceView.tsx:301` 条件渲染）。

### 3.9 工作空间状态清单

- 提升到 `WorkspaceView`、切页不丢：`wsMeta`（`:51`）、`tasks`（`:53`）、`draft`（`:55`）、`bubble`（`:56-58`）、`lib`（`:60-65`）、`agents`（`:66`）、`setupOpen`（`:68`）；瞬时 `taskMenu`/`renamingId`（`:72-74`）。
- 留在页面组件、切页即丢：概览编辑态、资料库当前文件夹/搜索词/视图模式、看板全部卡片（`:295-303` 条件渲染）。
- 关 tab 后以上全部丢失（无持久化）；tab 栏标题也不跟随 `wsMeta` 改名。

---

## 4. 文件 tab 与气泡窗

### 4.1 文件从哪开

- 开**文件 tab**：主页最近/所有文件、Agent 会话记录、知识库文档来源、标签栏“+”、主页新建瓦片、AI 起草结果。
- 开**气泡窗**：工作空间概览动态里的文件引用、资料库任意文件、产物页任意文件（`WorkspaceView.tsx:231`、`WorkspacePages.tsx:99-120`）。
- 同一文件可同时存在于文件 tab 和某个工作空间气泡里；两处都按 `file.id` 打开同一个原生实例，会互相抢矩形（见 4.4）。

### 4.2 气泡状态机

- `BubbleState = { mode:'closed'|'open'|'minimized', width, maximized, files[], activeFileId }`（`BubbleWindow.tsx:22-28`）。
- 打开文件：`mode` 从 closed → open 时把 `width` 重置为默认 480、`maximized` 重置 false；已打开则保留宽/最大化；文件按 id 去重后追加并设为 active（`WorkspaceView.tsx:125-134`）。
- 最小化：整窗换成右缘 20px 把手，显示文件数，点击恢复（`BubbleWindow.tsx:77-89`、`office-proto.css:1384-1395`）。
- 最大化：`position:absolute` 盖住内容栏（`left: calc(248px + 10px)`，top/bottom/right 10px，z-index 10），**不挤压**内容栏；再点还原（`BubbleWindow.tsx:123-125`、`office-proto.css:1316-1321`）。最大化时禁用拖宽。
- 关闭单个文件：`.md` 直接摘除；原生文件先 `office.close`，取消则保留；摘掉 active 后 active 回退到列表最后一个；列表空则整窗 closed（`WorkspaceView.tsx:136-152`）。
- 关闭整窗：串行关闭所有原生文件，任一取消 → toast“有文件未保存，气泡窗已保留”并中止；成功后重置为 closed 且宽度回默认；关闭工作空间 tab 时复用同一串行守卫（`WorkspaceView.tsx:154-163`）。

### 4.3 气泡布局

- 参与 flex：`.op-ws` = 侧栏 + 内容栏 + 气泡，气泡 `flex:none`，宽 480 起，直接把内容栏挤窄；内容栏 `min-width:320`，到极限后拖宽被 `dynMax` 卡住（`office-proto.css:1231`、`office-proto.css:1294`、`BubbleWindow.tsx:54-59`）。
- 宽高：默认 480，拖拽范围 360–720，且 `min(720, innerWidth - 侧栏宽 - 320 - 40)`；拖的是左缘，`startW + (startX - clientX)`（`BubbleWindow.tsx:47-69`）。
- 外框 `margin:10px`、圆角 12、投影；头部最小 38px：多标签列表（26px 高、max-width 180、图标+名+关闭）+ 最小化/最大化/关闭三个 22px 按钮；主体 `padding:10px`，每个文件一层 `.op-ws-bubble-doc`，只显示 active（`office-proto.css:1310-1381`）。
- 拖宽时给根加 `.dragging` → CSS `display:none` 掉原生宿主，让 WebContentsView 不再吞指针事件（`BubbleWindow.tsx:44-46`、`office-proto.css:1322-1324`）。

### 4.4 原生编辑器宿主矩形上报

- `NativeEditorHost` 挂载后 `office.open({fileId,title,spec})`（按 fileId 幂等），成功后进入 ready；失败显示运行时错误与修复提示（`NativeEditorHost.tsx:32-48`、`NativeEditorHost.tsx:87-102`）。
- 上报规则：宿主矩形非零 → 首次先 `office.activate(fileId)` 再 `sendBounds(rect)`；变零 → 仅在之前可见时发一次 ZERO；`ResizeObserver` + window `resize` + 捕获阶段 `scroll` 都重报；卸载时发 ZERO（`NativeEditorHost.tsx:50-85`）。
- 主进程只把 bounds 应用到“当前 active 实例”，并按窗口内容区裁剪/取整（`bridge.ts:189-200`、`bridge.ts:48-62`、`bridge.ts:303-322`）。
- 竞态：旧宿主迟到的 ZERO 会把新激活实例藏掉；切气泡标签后 `BubbleWindow` 会延迟 80ms 派发一次 `resize` 强制重报（`BubbleWindow.tsx:71-75`）。移植时建议给每个实例加可见性令牌，而不是靠全局 resize 兜底。
- 坐标直接用 `getBoundingClientRect()` 的 CSS px，未做 DPR 换算；主进程按窗口内容区 clamp。

---

## 5. 编辑器页与 SideDock

### 5.1 文件 tab 的编辑布局

- 入口分流：`.md` → `MdView`；docx/xlsx/pptx/pdf → `NativeFileView`（`EditorView.tsx:15-18`）。
- Markdown：左右分屏 `flex 1.1 / 1`，左侧 CodeMirror（history + defaultKeymap + historyKeymap + indentWithTab + lineWrapping + markdown 语法），右侧 `react-markdown + remarkGfm` 实时预览，预览内容 max-width 640 居中（`EditorView.tsx:76-108`、`office-proto.css:620-635`）。
  - 编辑器只建一次（按 file.id 重挂载），doc 变化只同步 `source` state；**无保存、无 dirty 标记**，关 tab 直接丢（`EditorView.tsx:70-98`）。
- 原生：`.op-ed-dock-row` = 左列（可选“由 Agent 依据 n 条记忆起草”横幅 + `NativeEditorHost`）+ 右侧 `SideDock`；没有顶栏/工具栏，文件名只出现在 tab 上；横幅仅在 `kind==='docx' && name.includes('AI 起草')` 时显示，引用数由带 `cite` 的 block 统计（`EditorView.tsx:42-61`、`office-proto.css:981`）。
- `nativeSpec` 把 mock 内容映射为 docx blocks / xlsx columns+rows / pptx slides / pdf 段落（`EditorView.tsx:20-39`）。

### 5.2 SideDock（右侧停靠栏）

- 三个页签：Agent / 材料库 / 历史记录，对应内容面板互斥渲染（`SideDock.tsx:16-22`、`SideDock.tsx:56-82`）。
- 展开态：内容体 + 右缘 44px 竖条图标（贴窗口右缘）；默认宽 360，可拖 280–560（拖左缘 5px 手柄）；点当前图标收起，收起后整体 44px 只剩竖条，点任意图标展开（`SideDock.tsx:25-54`、`office-proto.css:983-1006`）。
- 展开状态与宽度是**每个编辑 tab 各自记忆**（组件内 state，tab 常驻）。
- 窄窗下不做响应式收起，靠原生编辑器 ResizeObserver 自动让位。

### 5.3 Agent 聊天面板

- 复用 EverRoom `AgentChatView/AgentComposer/AgentToolbar/AgentSessionSwitcher/useAgentSession`，外面包 `LocaleProvider + DocumentOperationProvider + RoomDocumentsProvider`，数据来自 `agentChatMock` 的脚本化事件流（`AgentChatDock.tsx:38-46`、`AgentChatDock.tsx:21`）。
- 会话隔离键 = `file.name`（pageLabel）；同一文件名的任务会话共享（`AgentChatDock.tsx:54`、`workspace.ts:71-76`）。
- 工具栏：会话切换器（新建/重命名/删除/选择）、连接状态、当前标题（`AgentChatDock.tsx:103-121`）。
- 空会话显示按文件类型预置的 3 条开场建议（`AgentChatDock.tsx:55`、`AgentChatDock.tsx:132`、`data.ts:574-580`）；点建议填入输入框不发送。
- 输入框：Enter 发送、Shift+Enter 换行、IME 组合态保护、空态建议 Tab/Enter 采纳、斜杠选择器、模型档位（有 session 后锁定）、权限模式、排队发送、停止运行、@提及（`AgentComposer.tsx:347-425`）。
- `onFirstSend` 只在实例首条消息触发一次，用于草稿落成任务（`AgentChatDock.tsx:57-67`、`WorkspaceView.tsx:315`）。
- 工作空间任务 pane 里面板铺满高度但 `max-width:820` 居中，停靠栏内则铺满；EverRoom 的 toast 事件桥到外壳 toast（`office-proto.css:905-921`、`AgentChatDock.tsx:34-36`）。

### 5.4 材料库

- 初始列表按 file.id 取 mock（`fileMaterials[file.id] ?? defaultMaterials`），局部 state（`MaterialsPanel.tsx:32-35`、`data.ts:507-535`）。
- 顶部统计“n 个文件 · 总大小 · 供 Agent 引用”（总大小由字符串反解析后累加）；空态引导拖入（`MaterialsPanel.tsx:82-90`、`MaterialsPanel.tsx:20-30`）。
- 添加：系统多选文件（`office.pickMaterials`）或直接拖文件进面板，加到顶部并 toast；移除 hover 出现 X；点行只 toast“预览将在下一阶段接入”（`MaterialsPanel.tsx:37-62`、`MaterialsPanel.tsx:91-131`）。
- 不持久化、不上传内容、不关联会话上下文。

### 5.5 历史记录

- 筛选：全部 / 我的修改 / Agent（`HistoryPanel.tsx:11-17`）。
- 条目：actor 圆点 + 徽标（王小雨/Agent/系统）+ 标题 + 细节；`diffable` 显示“查看改动”，`restorable` 显示“恢复此版本”（`HistoryPanel.tsx:45-88`）。
- 恢复走 `window.confirm`，确认后只 toast“已恢复（演示）”；无真实版本链、无 diff 视图（`HistoryPanel.tsx:39-43`）。

---

## 6. 快捷键、toast、命令面板

- 原型**没有**应用级快捷键：无 ⌘W/⌘T/⌘1..9、无 tab 循环、无命令面板、无全局搜索。
- 各处的键盘行为：
  - Esc：关闭标签栏“+”菜单、任务/文件浮层菜单、创建弹窗、智能体选择弹窗、连接器抽屉（`OfficeProto.tsx:166`、`WorkspaceView.tsx:80`、`WorkspacePages.tsx:272`、`WsCreateFlow.tsx:37-41`、`ConnectorsView.tsx:19-24`）。工作空间三步引导**不响应 Esc**。
  - Enter：创建空间名称、目标、任务、重命名、看板新建；具体输入框各自处理（`WsCreateFlow.tsx:82`、`WorkspaceView.tsx:396`、`PlanKanban.tsx:69-72`）。
  - CodeMirror：`Mod-z/Shift-Mod-z` 等默认历史键位、Tab 缩进；聊天输入：Enter 发送 / Shift+Enter 换行 / Tab 采纳空态建议（`EditorView.tsx:82-85`、`AgentComposer.tsx:385-425`）。
- Toast：单一字符串，2.2s 自动消失，新 toast 直接覆盖旧的；固定底部 30px 居中、深色胶囊、z-index 70，无队列/无类型/无操作按钮（`OfficeProto.tsx:25-33`、`office-proto.css:332-338`）。
- Toast 承担了大量“占位实现”的反馈（网格视图、文件菜单、恢复版本、管理设置等），移植时要逐条替换成真实行为，而不是保留 toast。

---

## 7. 布局度量

| 区域 | 值 | 固定/弹性 | 来源 |
| --- | --- | --- | --- |
| 根 / 标签栏 | 根 `100vh` column、`overflow:hidden`；栏高 52、`padding:0 14`、macOS `padding-left:96`、z 20 | 固定高 | `office-proto.css:5-13`、`office-proto.css:346-356`、`desktop-frame.css:11-14` |
| 标签 / 列表 / “+” | 标签高 36、左右 13、圆角 9、`max-width:230`；列表 flex gap 4 横滚隐藏滚动条；“+” 30×30，菜单 fixed | 固定高 + 弹性列表 | `office-proto.css:357-388`、`office-proto.css:1213-1227` |
| 主页侧栏 | 宽 248；padding 16/12/12；导航项 padding 10/12、gap 12 | 固定 | `office-proto.css:62-107` |
| 主页内容 / 分栏 / 瓦片 | 内容 `padding:30px 36px 64px`、无 max-width；分栏两列 `minmax(0,1fr)` gap 18，≤980px 单列；瓦片 `flex:1; max-width:150` | 弹性 + 980 断点 | `office-proto.css:133`、`home-spaces.css:4-14`、`office-proto.css:237-245` |
| 工作空间侧栏 / 列表 | 宽 248；padding 12/10/10；菜单项 6.5/10 gap 9；工作列表占满剩余高度并内部滚动 | 固定 + 弹性 | `office-proto.css:1234-1272` |
| 工作空间内容 | `flex:1; min-width:320` | 弹性（下限 320） | `office-proto.css:1294` |
| 概览 / 会话 pane | 概览 `max-width:1080` 居中、padding 30/4/64、gap 24；会话 `max-width:820` 居中 | 最大宽 | `office-proto.css:1472-1475`、`office-proto.css:919` |
| 气泡 / 最大化 | 默认 480、min 360、max 720；`margin:10`；头 ≥38、tab 26/≤180、body padding 10；最大化绝对定位 top/bottom/right 10、left `248+10` | 弹性（可拖） | `BubbleWindow.tsx:18-20`、`office-proto.css:1310-1321` |
| 停靠栏 / Markdown | 停靠 360（280–560）、收起 44、竖条 44、手柄 5；Markdown 源 `1.1` / 预览 `1`、正文 max 640 | 弹性 | `SideDock.tsx:27`、`office-proto.css:983-1006`、`office-proto.css:620-635` |
| 文件表 / 资料库列表 | 文件表 `36 / minmax(220,1fr) / 150 / 100 / 30`，行 64、表头 40；资料库列表 `36 / minmax(170,1.5fr) / minmax(130,1fr) / 120 / 70 / 30` | 半固定 | `office-proto.css:287-299`、`office-proto.css:1811-1815` |
| 网格族 | 资料库 `minmax(104,1fr)`；智能体/知识库 `minmax(230,1fr)`；连接器 `minmax(320,1fr)`；看板 4 列 `flex:1 1 0; min-width:230` gap 12 | 弹性 | `office-proto.css:1790-1792`、`office-proto.css:1829`、`office-proto.css:319`、`office-proto.css:924`、`office-proto.css:1425-1427` |
| 抽屉 / 弹窗 / Toast | 抽屉 380 右侧绝对定位；弹窗 `min(520, 100vw-48)`、`max-height:min(640, 100vh-100)`；toast 底部 30 居中 z 70 | 固定/弹性上限 | `office-proto.css:956-963`、`office-proto.css:1937-1942`、`office-proto.css:332-338` |

- 断点只有一条：980px（主页双栏→单栏）。其余全靠 flex/min-width 与滚动；未做窄窗专门布局。
- 溢出策略：根/窗口体不滚；滚动都在 `.op-scroll`、`.op-nav`、`.op-ws-tasks-list`、`.op-md-preview`、`.op-materials-list`、`.op-hist-list` 等容器上；宽表/看板在内容栏过窄时会产生横向滚动（`.op-scroll` 单轴 auto 的另一轴按 auto 计算）。
- Z 序：标签栏 20 < 构建遮罩/弹窗 50–60 < toast 70；抽屉 40/41；气泡最大化 10；任务菜单 50（fixed）。

---

## 8. 真实数据映射与缺口

### 8.1 映射表

| 原型 mock | 关键字段 | 目标端自然落点 | 缺口/注意 |
| --- | --- | --- | --- |
| 每日/空间洞察 `dailyInsight`、`workspaceInsight` | `text/source/updatedLabel/actions` | 会话/文件聚合后由 Agent 生成的摘要（无现成接口） | 无摘要 API；来源计数（42 封邮件等）是硬编码，需真实统计或去掉；空间洞察没有 action |
| 项目空间 `spaceSummaries` | `name/desc/taskCount/outputCount/updatedLabel` | `AgentWorkspace`（`id/name/path/kind/createdAt/updatedAt`，`packages/agent-contract/src/index.ts:94-103`） | 无 desc/goals；`taskCount`=该 workspace 的 session 数；`outputCount` 需按产物聚合 |
| 文件 `files` | `id/name/kind/roomId/updatedLabel/sizeLabel/memoryCount/content` | 文件库 `FileCatalogDto`（目标 `OfficeFile.realCatalog`）+ `sources:list-files` | `roomId`→知识库归属在文件模型里没有；`memoryCount` 无来源；`sizeLabel/updatedLabel` 要格式化 |
| 任务 `workspaceTasks` | `title/status/summary/updatedLabel/outputIds/skillIds/pinned/assigneeLabel/chatLabel` | `AgentSession`（`workspaceId/title/status/updatedAt/pageLabel`）+ 其 run | 状态枚举不同（原型 running/review/done/idle vs `idle/running/interrupted/closed`）；`summary/outputIds/skillIds/pinned/assigneeLabel` 均无字段，需扩展或旁路存储 |
| 工作空间智能体 `workspaceAgents` | `name/emoji/tagline/enabled/prompt/styleTags/skillIds/connectorIds/experiences` | 本地 Agent（`discoverLocalAgents`）/ 内置 Agent 定义 | 智能体是 workspace 级还是全局级需要定；经验（experiences）无模型；启用态无持久化 |
| 材料 `MaterialItem` | `kind/title/sizeLabel/addedLabel` | 文档级上下文附件 / 会话 context items | 无“按文档挂材料”的持久化模型；上传只留文件名 |
| 历史 `HistoryEntry` | `actor/title/detail/restorable/diffable` | 文档版本链（docx/pptx） | Markdown 无版本；Agent 改动与用户改动需按 run 关联；diff 视图未实现 |
| 动态 `workspaceActivities` | `kind/segments(taskId 或 fileId)/timeLabel` | 由 session run 事件 + 产物写入推导 | 无事件表；`taskId/fileId` 混合引用需要稳定 id；建议做成派生视图而非持久化 feed |
| 目标 `goals` | `string[]` | `AgentWorkspace` 无字段 | 需扩展 workspace schema 或存本地设置；概览只支持新增，删除/编辑也要补 |
| 计划 `PlanTask` | `title/status/owner` | 无对应模型 | 需新建排期任务表（spaceId/title/status/owner/order）；当前状态切页即丢 |
| 知识库 `KnowledgeBase` | `title/icon/sources[]` | 知识库/来源（`sources:*` IPC） | 来源的 indexed/syncing 状态与“记忆条数”需后端提供 |
| 连接器 `Connector` | `connected/lastSyncLabel/scopes` | connector 模块 / `connector-contract` | 连接状态目前只在本页 mock；`scopes` 是静态文案；连接后要回写全局 |

### 8.2 关键缺口（按移植优先级）

1. **workspace 元数据扩展**：`description`、`goals`、`pinned`、`assignee`、`outputIds`、`skillIds` 在真实模型里都没有，先定 schema 再写 UI。
2. **任务状态语义**：`review`/`done` 无法由 `AgentSessionStatus` 直接表达，建议由最近一次 run 的状态 + 产物存在性派生，避免另造枚举。
3. **动态/洞察是派生数据**：不要为它们建表；用 session runs + artifacts 聚合，否则很快与真实状态漂移。
4. **同一文件多处打开**：文件 tab 与气泡、两个工作空间气泡会共享同一个原生实例，矩形上报会互相覆盖；移植时实例应按“打开位置”或引入可见性 token。
5. **工作空间隔离**：原型所有 tab 共享同一份 `files`/`agents` 数组的拷贝，真实产品必须按 workspaceId 过滤（尤其资料库与产物）。
6. **跨页状态与未实现项**：计划看板、资料库搜索/目录、概览编辑态都是页面局部 state，应提升到 workspace store；上传/新建文件夹、模板选择（`templates` 未被任何页面使用）、diff、版本恢复、网格视图、连接器真实连接、Agent 删除/编辑、看板搜索筛选均未实现。

### 8.3 与目标端现状的差集（迁移起点）

- 目标端外壳是单窗口 Workbench：左栏 + 主区（对话/页面）+ 右侧产物面板，用 `react-resizable-panels`；无窗口级标签栏（`apps/desktop/src/renderer/src/workbench/shell/Workbench.tsx:16-18`、`Workbench.tsx:48-60`）。
- 目标端已有：文件 tab + 主页 + 设置页（`office-proto/OfficeProto.tsx:19-88`）、`MainHeader`（标题/搜索/新建/文件面板开关）、命令面板与快捷键 ⌘K/⌘N/⌘B/⌘J（`Workbench.tsx:57-60`、`sidebar/CommandPalette.tsx`）、按上下文隔离的产物标签（`workbench/types.ts:23-57`）。
- 目标端 `office-proto/` 目前只有 `data/EditorView/SideDock/Materials/History/NativeEditorHost/OfficeProto/pages/{Recent,AllFiles,Agent,Knowledge,Connectors,parts}`；**缺** `WorkspaceView.tsx`、`workspace.ts`、`WsCreateFlow.tsx`、`BubbleWindow.tsx`、`pages/WorkspacePages.tsx`、`pages/PlanKanban.tsx`、`pages/SpacesView.tsx`。
- 因此移植时建议：① 工作空间 = 目标端 `AgentWorkspace`，任务 = `AgentSession`，不新造平行概念，且“项目空间”页与目标侧栏 workspace 切换重复，应合并而非照搬；② 气泡窗与目标 `ArtifactPanel` 二选一——气泡的“挤压内容 + 多标签 + 原生实例”更贴近需求，产物面板的“按上下文作用域恢复”更完整，建议以气泡布局 + 产物作用域持久化合并；③ 原型 `office-proto.css` 只作结构参考，颜色/圆角/阴影/毛玻璃全部换目标 token。
