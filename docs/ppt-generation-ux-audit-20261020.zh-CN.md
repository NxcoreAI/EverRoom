# PPT 生成流程 UI/交互审计（乔布斯标准）

- 日期：2026-10-20
- 范围：从「用户说要做一份 PPT」到「成品交付并可继续修改」的完整体验面
- 方式：三路独立只读代码审计（进度卡/产出物/入口与文案）＋ Lead 交叉复核；**未改任何代码，未启动真机**
- 结论适用于当前 `dev` 分支工作区（`b3fadc85` 附近）

---

## 0. 一句话结论

**工程上已经能把 PPT 造出来，产品上还没有把它交给用户。**

生成过程中最关键的十几分钟到几十分钟里，用户看到的是一个调试面板：最长的那三段等待是一片空白，自己的聊天气泡里出现 `slides_draft(task=generate, documentId="…")` 这样的机器指令，点「生成 PPT」三秒后就被宣布「已生成」——而那时文档里只有一页骨架；真正完成时反而没有任何声音，也没有「打开成品」的按钮。整个流程有 4 个硬性停点、9 个卡内动作，每个动作都不是一次交互，而是一整轮 LLM。**这不是配色的毛病，是流程被当成了日志，而不是一次创作。**

> “Design is not just what it looks like and feels like. Design is how it works.”
> 按这条标准，这条流程目前「看起来」像幻灯片，「works」起来像 CI 面板。

---

## 1. 体验分镜：今天用户实际经历什么

| # | 阶段 | 用户看到 | 用户要做 | 代码依据 |
|---|---|---|---|---|
| 1 | 想开始 | 空态只有「总结/风险/待办」三条快捷提示；动态推荐靠历史标题推断，新用户永远推不出 PPT | 自己想起「这软件能做 PPT」，或从 Room 产物库「新建 PPT」进入 | `AgentChatView.tsx:36-40`、`AgentPanel.tsx:226-254`、`conversation-suggestion.ts:177-197` |
| 2 | 起草稿 | 只有一行「正在调用工具...」；planner 检索+成稿 1–5 分钟，无阶段、无已用时 | 等 | `AgentChatView.tsx:42-72`、`tools.ts:1409`（结束才广播） |
| 3 | 草稿确认 | 卡出现，列出页清单；「打开草稿」在非 Room 页静默无反应 | 打开草稿改内容，再回聊天点「生成 PPT」；说一句「改好了」卡会消失 | `SlidesProgressCard.tsx:512-537`、`AgentPanel.tsx:856-858`、`AgentChatView.tsx:566-581` |
| 4 | 生成风格图 | 无卡，只有「正在调用工具...」，三张候选单张在百秒级（代码推断，需真机复验） | 等 | `slides-style-stage.ts:305-308`（生成完才广播） |
| 5 | 挑风格 | 约 148×83 的缩略图，点图即提交；不能放大、没有「换一批」、不能返回 | 凭色块赌一张 | `AgentChat.css:1754-1789`、`SlidesProgressCard.tsx:223-246` |
| 6 | 确认风格 | 色块 hex 值、pt 字号表、线框 SVG、效果文案；「按此风格生成」 | 读工程参数，点确认 | `SlidesProgressCard.tsx:248-309` |
| 7 | 配图过目 | 已出图的行只有图片+两个按钮，无页码无标题；未出图的行反而有 | 数着图点「不用这张/重新生成」，每点一次等一轮 LLM | `SlidesProgressCard.tsx:344-450` |
| 8 | 落页 | 点「按此配图落页」后卡折叠；最多可能沉默 15 分钟；期间「PPT 已生成」的 toast 早已弹出、1 页骨架的预览已打开 | 等，且不能改主意 | `slides-page-images-stage.ts:107-109`、`slides-layout-tail.ts:599-607`、`App.tsx:685-700` |
| 9 | 真正完成 | 无 toast、无卡变化（停在了上一次广播的 N/N）；没有「打开 PPT」 | 自己去产物库/文稿页找 | `slides-layout-tail.ts:910-940`、`SlidesProgressCard.tsx:452-506` |
| 10 | 之后 | 想在对话里说「标题小一点」没人提示；停止后无交代；失败后卡消失；重启后只剩半句话 | 猜 | 见 §3 |

**决策成本**：4 个硬停点（草稿确认 / 挑图 / 确认风格 / 配图过目确认——其中「确认配图」卡在生产环境带了后台 runner 时通常自动跳过、直接进过目）＋ 9 个卡内动作（挑图、确认风格、生成配图、跳过、重生成、打回、恢复、落页、生成 PPT）。每一个动作都不是本地状态变更，而是把一句含内部工具语法的文本当用户消息发出，触发一整轮 agent（`AgentPanel.tsx:859`）。

---

## 2. 判据：乔布斯标准下的六条尺子

| 尺子 | 一句话判据 | 这条流程的表现 |
|---|---|---|
| **焦点 Focus** | 一次只让用户做一件事，且是只有他能做的那件事 | ❌ 用户在 5 个工序上盖章，还要替系统念工具调用 |
| **简单 Simplicity** | 复杂性留给自己，不是少画几笔 | ❌ 把「风格=挑图+确认」「生成=确认内容+挑图+确认风格+配图+确认配图+落页」全摊给用户 |
| **品味 Taste** | 细节决定一切；10px 灰字也是品味 | ❌ 关键进度是全卡最小的字（10px、2.6:1 对比度）；风格决策用邮票大小的图 |
| **掌控 Control** | 用户永远知道自己在哪、能退出、能回来 | ❌ 最长等待无存在感；停止后无交代；失败把卡收走；长任务期间会话列表被锁 |
| **诚实 Truth** | 进度、完成、失败都不许演 | ❌ 1 页骨架就宣布「已生成」；「草稿已创建并打开」不成立；「重试」其实是重连；永远「生成中…」 |
| **情感 Delight** | 造物应该有揭晓时刻 | ❌ 没有揭晓，只有一条提前发出的竣工通知 |

---

## 3. P0：必须先修的六件事（阻断级）

### P0-1｜用户被迫说出机器语言（最恶劣的一条）

**证据**
- `SlidesProgressCard.tsx:235 / 300 / 320 / 336 / 367 / 391 / 406 / 420 / 443 / 530`：所有按钮都是 `onGenerate?.(t('surface:agentChat.slides*Message', …))`，共 9 条同型文案
- `AgentPanel.tsx:859`：`onSlidesGenerate={(message) => void sendPrompt(message)}`
- `AgentChatView.tsx:989-1030`：用户消息原样渲染成 `<article data-role="user"><p>{message.content}</p>`，还带复制按钮
- 文案本体：`zh-CN/surface.json:61-84`，例如「配图已确认，请用 slides_draft(task=generate, draftDocumentId="{{documentId}}", pageImagesDecision="accept") 继续落页生成 PPT。」
- 首条消息还会成为会话标题（`service.ts:861`、`useAgentSession.ts:1133`）
- 同类问题还有「新建 PPT」（`ArtifactLibraryPane.tsx:177-184`）与 PPT 内「AI 修改」（`office-generation.ts:96-103`，消息里带 `fileId="active"`、`slides-builder 子代理`、`instruction`）

**用户感受**：我只点了一下，聊天里却出现了一句我从没说过、也看不懂的话，挂着我自己的头像，还能被复制、被计入上下文、被当成会话标题。在 PPT 里点「AI 修改」更糟——面板没打开时这次修改完全无影，回到对话才看到一段带着元素 id 和「子代理」的鬼话。

**乔布斯判词**：把遥控器藏起来，让观众上台替演员念台词。这不是产品，是把调试面板刷成了皮肤。

**修复方向**：卡片动作走结构化内部意图（run 内指令 / action id），聊天层只留一行系统回执「已采用第 2 张风格图」；`documentId`、`fileId`、`task=` 这类句柄永远不出现在社交层；非对话入口（产物库/AI 修改）同样只传意图，并保证用户被带到正在发生的对话前。

---

### P0-2｜最长的三段等待是黑洞

**证据**
- 风格图：`slides-style-stage.ts:305-308` 生成完才 `onUpdate`（代码推断单张 ~100s 级；重试 0/20s/40s，单张超时 180s）
- 风格卡：`slides-style-stage.ts:436-440` 提取+VLM+演示页渲染完才广播
- 重排方案：`tools.ts:1906` 方案出来才广播
- 等待期 UI 只有 `ThinkingStatus`：「正在调用工具...」/「执行 slides draft 1:47」（`AgentChatView.tsx:42-72`、`agentRunActivity.ts:212-221`）
- 全库唯一带时长承诺的文案是「安装中…可能需要几分钟」（local agent 向导）

**用户感受**：点了「生成 PPT」，两三分钟里只有一个转圈和一句「正在调用工具」，不知道在出图、在排版、还是已经死了。退出去又没有任何「还在跑」的痕迹。

**乔布斯判词**：观众看不见换景，就不叫演出。等待不是空白，等待是承诺。

**修复方向**：阶段一开始就广播「当前阶段 + 已用时 + 在做什么 + 大致区间」；把「生成 3 张风格图」「提取风格」「重排方案」做成可见阶段；第一屏就说清「大约 X 分钟，可以切走，完成会通知」。

---

### P0-3｜假揭晓：开工瞬间宣布竣工

**证据**
- `slides-layout-tail.ts:599-607` 先用**一页骨架** `skeletonPageSpec(...)` 入库
- `office-bridge.ts:456-463` 入库即广播 `done`；`App.tsx:685-700` 收到即 toast「PPT 已生成 /《x》已保存，正在打开预览」并自动打开
- 真正的逐页落页在其后才发生（`slides-layout-tail.ts:718`、`748-756`）；全部完成后**没有任何完成事件**，只有 registry 静默刷新
- 打开的是可编辑实例（`EmbeddedOfficePreview.tsx:37-43`），没有「生成中」锁；后续 `fillPage` 会整页替换用户此刻的修改
- 产物库行只显示体积和「已沉淀」状态，半成品与成品长得一样

**用户感受**：点完风格确认几秒内就弹「已生成」，打开一看只有一页封面；之后页数慢慢变多，但再没人告诉我完成了。如果我在那期间改了封面，下一批落页可能把它盖掉。

**乔布斯判词**：你在开工的瞬间宣布了竣工，这是对「完成」这个词最直接的贬值。

**修复方向**：`done` 必须后移到全部页落定；骨架期用进行时（「已建 1/N 页」+ 生成中横幅），生成期锁编辑；真完成时给一次明确的揭晓（自动打开、播放一遍、可导出）。

---

### P0-4｜进度卡不是「任务」，是一件会消失的临时挂件

**证据**
- 卡片由 `slidesProgressFromToolCall` 从最近一次 `slides_draft` 的 partialResult 还原，全局只取最新一条（`AgentChatView.tsx:552-563`）——多份 deck 只有最新一份可达
- 失败载荷没有 stage → 函数返回 null（`SlidesProgressCard.tsx:65-99`），而「出现更新的 slides_draft 调用」又会隐藏旧卡（`AgentChatView.tsx:567-581`）——**点「重新生成」失败，图和卡一起消失**
- `draft_ready` 不在「等待态豁免隐藏」集合里：用户之后说任何一句话（最自然的是「改好了，继续」），整张带「生成 PPT」的卡被顶掉（`AgentChatView.tsx:566-581`）
- 关掉 Agent 面板即组件卸载，长任务在全局零存在感（`App.tsx:1104-1110`），只有完成 toast
- 卡片固定在消息流末尾，不锚定触发它的那一轮（`AgentChatView.tsx:1132-1140`）

**用户感受**：认真改完草稿，回聊天打一句「好了」，入口没了；只能重新描述需求，又跑一次 planner、又多一份草稿文档。做 A 做到一半想做 B，A 的入口永远回不来。

**乔布斯判词**：一个只能同时办一件事、且说一句话就自毁的工作台，是在逼用户排队。

**修复方向**：把「PPT 任务」升为一等对象——会话内任务槽/任务条（N 个并行、每个有状态与入口）；卡锚定到对应轮次并保留「未完成任务」区；失败也保留卡（失败原因 + 重试/跳过/直接用现有）；关面板时顶栏保留「PPT 生成中 x/y」常驻条。

---

### P0-5｜成品没有出口

**证据**
- 卡里只有草稿阶段有「打开草稿」；`page_applied` 阶段只有页清单，完成后没有按钮、没有跳转（`SlidesProgressCard.tsx:452-537`）
- 网关返回的 `fileEntryId / fileName` 前端全仓未消费（`slides-layout-tail.ts:924-937`；渲染层 grep 无 `fileEntryId`）
- `ArtifactLibraryPane.tsx:171` 注释声称「产物生成后自动进入本栏并打开预览」，实现里没有这个承接
- 完成态文案没有任何「还能继续让我改」的引导；唯一的显式修改入口藏在 PPT 编辑器选中元素后的浮层 chip 里，且它转发出去的是 P0-1 那种内部指令

**用户感受**：做完了，成品在哪？想再看一眼/继续改，聊天卡里找不到入口，只能凭记忆去「产物库」翻三四跳。我不知道还能直接说「标题小一点」。

**乔布斯判词**：交付物没有交付口，等于没交付。

**修复方向**：完成态固定给「打开 PPT / 继续编辑 / AI 修改 / 导出」四个动作，与草稿态的「打开草稿」对称；收尾消息给 2–3 个具体的下一步示例并说明「直接在对话里说就行」。

---

### P0-6｜失败、中断、停止都没有交代

**证据**
- 部分失败：`SlidesProgressCard.tsx:508-510` 把网关 warnings 直接 `join('；')` 渲染，且不受折叠影响——「第 5 页布局树未收敛（overflow），已用兜底版式」这类编译器话术直出，无 i18n（英文界面照显示中文），也不区分「已自动处理」与「真失败」
- 退化页不可定位、不可单页重做：逐页结果只进 tool result（`slides-layout-tail.ts:704-756`），进度快照只带 `doneCount/pages`；页级重做只存在于被裁掉的 GenOffice AI 面板里
- 停止：composer 有通用「停止」（`AgentComposer.tsx:1348-1351`），但 `run.cancelled` 只清 activeRun、标 stopped，不给任何文案、不清卡、无「我替你保住了什么」（`useAgentSession.ts:493-530`）；卡片没有「已中止」态
- 失败后的「重试」实为 `session.reload()`（`AgentPanel.tsx:851`），只是重连
- 网关重启：stale run 记 `run.interrupted`（`service.ts:748`），但重放路径不处理，用户只看到「运行未正常完成」+ 一张旧卡；「继续」只写在 Agent 内部文档（`agents/main/SYSTEM.md:11`）
- 后台生图中断/15 分钟超时后，pending 页不标 failed（`slides-page-images-runner.ts:79`），前端 2.5s 轮询永不放弃（`AgentChatView.tsx:586-617`），卡里永远「生成中…」

**用户感受**：出错时最需要那台机器，产品却把它收走了。停止后世界安静了——哪些页好了？文件在哪？要不要重来？全靠猜。

**乔布斯判词**：出错不可怕，假装没事才可怕。

**修复方向**：失败必须有卡（原因 + 可重试范围 + 已保住什么）；warnings 分两类并全部 i18n；退化页在完成摘要里列出来并给「只重做这一页」；停止立刻给结果交代 + 「继续生成剩余 / 打开已有文件 / 放弃」；恢复会话时主动识别未完成任务给恢复卡；轮询加看门狗（3 分钟无更新判中断，显式标失败并给续跑）。

---

## 4. P1：严重级（体验骨架问题）

| # | 问题 | 关键证据 | 判词 / 修复方向 |
|---|---|---|---|
| P1-1 | **一次决定被拆成多次盖章**：说「三步」，实际 4 个硬停点、9 个动作；「生成 PPT」按钮发的其实是 `task=style`（开始选风格），名不副实；卡上根本没有「内容已确认」这个动作 | `tools.ts:1119`（三步）vs `agents/main/SYSTEM.md:11`（四步）；`SlidesProgressCard.tsx:512-537`、`surface.json:77-78` | 按钮名就是承诺。「生成 PPT」→「下一步：选风格」；把内容确认做成卡上/文档顶部的明确动作；步数说真话 |
| P1-2 | **主 Agent 还在宣传一个不存在的确认卡**：`tools.ts:1418` 让模型告诉用户「在确认卡上选受众、时长、风格」，卡上只有两个按钮（该项已被 commit `e6170130` 删除） | `tools.ts:1417-1418`、`SlidesProgressCard.test.tsx:120-121` | 说了有就真有——要么做进卡，要么删掉这句话，否则用户以为 UI 坏了 |
| P1-3 | **视觉决策在 148×83 缩略图上赌**：360px 侧栏、两列候选、hover 才描边；不能放大、没有「换一批」、点错不可撤回、不能返回上一步 | `tokens.css:38`、`AgentChat.css:1754-1789`、`SlidesProgressCard.tsx:223-246` | 用邮票做最重要的视觉决定，是在让用户赌。→ 全宽大图/点击放大/「用这张」/「换一批」/可返回 |
| P1-4 | **全局 busy 锁死整卡**：`busy = activeRunId || submitting`——图已经出现、agent 还在写「我已经生成了三张…」时，所有按钮 disabled + `cursor:wait`，点击零反馈 | `AgentChatView.tsx:1136`、`AgentChat.css:1777-1780/1914-1917` | 让用户等一句他不需要的解释，才允许他做唯一该做的决定。→ 只禁用该动作自身 pending；或点击即入队 |
| P1-5 | **逐张审图被串行成 N 次 agent 回合**：每张「重新生成/不用这张」都发一条消息、跑一轮、锁全卡；重生成还会先折叠整卡；8 张图 = 8 次排队 | `SlidesProgressCard.tsx:384-399`、`:143-152` | 让每个像素调整都排一次队。→ 本地批量勾选、一次提交；重生成原位占位不折叠 |
| P1-6 | **「按此配图落页」可能沉默 16 分钟且不能改主意**：accept 时若后台仍在跑转 settling 等 runner，`SETTLING_TIMEOUT = 15min+60s`；卡已折叠只剩「配图生成中 X/Y」 | `slides-page-images-stage.ts:107-109`、`258-300` | 一个按钮能隐藏 16 分钟，它就不是按钮。→ 立即用当前状态落页；或弹「还剩 5/8 张，等还是先用这些？」 |
| P1-7 | **跨文档串台**：`pageImagesPollState` 是会话级状态，target 变化时不清 state/不重置 ref；回到较早会话时旧响应被永久拒绝；可能把 A 的图和序号打到 B 文档 | `AgentChatView.tsx:586-620` | 给用户看别人的照片还让他投票。→ poll 状态以 documentId 为 key，切换即清 |
| P1-8 | **长任务期间整个应用被扣作人质**：运行中不能新建对话、不能切会话，且不解释；「重试」实为 reload；把「忙」报成「新建会话失败」 | `AgentSessionSwitcher.tsx:57/94/117`、`useAgentSession.ts:813/834` | 不能因为要跑十分钟，就把整个应用扣作人质。→ 允许切会话（后台继续 + 列表「生成中」标记），或至少解释禁用原因 |

---

## 5. P2：语言、工艺与一致性

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | **术语崩塌**：PPT / 幻灯片 / 演示文稿三种叫法；内部行话「落页」「打回」「过目」「风格卡」「纵览图候选」直接进按钮与标题；「草稿」被当作产品名词 | `surface.json:66-84/592/1132`、`contextRoom.json:94`；en 侧 `PPT/presentation/Slides` 三套 |
| P2-2 | **机器数据当产品语言**：6 个 hex 色值直接展示（`#1E3A5F`）、字号全是 pt、线框 SVG、effectLines；用户被要求确认的东西与他将得到的东西之间没有一张「大图」 | `SlidesProgressCard.tsx:252-292`、`style-card.ts:103-142` |
| P2-3 | **调试残留**：风格挑图标题后硬编码 `·v3`（9px、`#4a90d9`，`SlidesProgressCard.tsx:194`）；时间线把 `slides_draft` 显示成「执行 slides draft」、副标题是 `generate/style/draft`；子代理显示英文「Slides Planner → Slides Layouter」；展开后印 `<code>{tool.name}</code>` 与参数 JSON | `agentRunActivity.ts:212-238/644-660`、`AgentExecutionTimeline.tsx:279-281` |
| P2-4 | **可读性与无障碍**：标题 12px、副标题/进度 10px（全卡最小字）；多处对比度 2.59:1 / 3.04:1 / 3.40:1 / 3.65:1，均低于 AA 4.5:1；卡内无 `:focus-visible`；无 `aria-live`，逐张出图对读屏静默；候选图 `aria-label`「用第 N 张」覆盖了可见的方向标签；过目卡 `alt` 是生图提示词原文；26–30px 点击区偏小 | `AgentChat.css:1577-1591/1627-1633/1698-1702/3193-3207`、`SlidesProgressCard.tsx:230/382/384-428` |
| P2-5 | **危险操作无确认**：`跳过配图` 会 `runner.abort` 并丢弃已生成的全部配图，UI 只是一行同款副按钮 + 四字文案，无二次确认、无 dangerous 样式；打回配图不告诉用户「这页将退化为无图版式」 | `slides-page-images-stage.ts:243-255`、`SlidesProgressCard.tsx:329-341`、`:415-428` |
| P2-6 | **同一份 PPT 五入口四命名三门禁**：产物库/资料面板/文稿页（标 `[只读]` 但实际可编辑）/文件页（只弹提示不跳转）/聊天卡；`TopBar.tsx:103-105` 无条件「[只读]」前缀 | `TopBar.tsx:103-105`、`surface.json:1056`、`DocsPage.tsx:168-173`、`FilesPage.tsx:451-457` |
| P2-7 | **假状态**：预览失败时回退卡固定说「已使用系统默认应用打开原件」，实际没打开；office-document 页硬编码「正在加载 Office 文档…」永不结束；产物页打开无 loading（`busyKey` 定义了但从未渲染） | `EmbeddedOfficePreview.tsx:66`、`KnowledgeFileExternalCard.tsx:55`、`PageCanvas.tsx:73-76`、`DocsPage.tsx:70/166` |
| P2-8 | **版本/命名不可辨**：同题再生成 = 新同名条目；AI 修改静默版本 +1、无提示；列表按创建时间排序；界面无版本号 | `office-bridge.ts:437-445`、`office-preview-registry.ts:448-491`、`DocsPage.tsx:105-115` |
| P2-9 | **草稿静默进回收站**：落页完成后 `trashDraft`，而产物库没有回收站视图，恢复入口藏在资料面板深处 | `slides-layout-tail.ts:912-915`、`ArtifactLibraryPane.tsx:49-50/66` |
| P2-10 | **视觉人格断裂**：卡片是冷蓝灰企业风（`#fdfefe`/`#2f5a96`/`#20252c`），与产品其他处的暖纸感（`#f7f3ec`/`#62594b`）割裂，更与用户即将得到的 deck 风格零关联；同一屏里主色、按钮、阴影各说各话 | `AgentChat.css:1516-1528`、`:1965-1972`、`:1924-1953` |

---

## 6. 如果按乔布斯的方式重做

**不是把卡片修漂亮，而是给 PPT 生成一个「创作台」。** 聊天负责说人话和汇报，创作台负责让用户看见东西、做决定。

| 幕 | 画面 | 用户能做的事 | 只此一次的决定 |
|---|---|---|---|
| 一 · 内容 | 草稿文档全屏；顶部一条常驻条「内容确认后去选风格 →」 | 改标题/要点/数据（改章节=改页） | **内容对不对** |
| 二 · 风格 | 主画布全屏三张风格示例（大图、方向短名、键盘 ←→ 翻）；底部「用这套 / 换一批」 | 看大图、一键换一批、可返回 | **感觉对不对** |
| 三 · 配图 | 九宫格，每格带「第 N 页 · 标题」；勾选「保留 / 不用 / 换一张」后**一次提交**；「全部不用」随时可用 | 批量决定，不排队 | **图要不要** |
| 四 · 成品 | 生成时看到逐页落进来（同一画布，非聊天日志）；完成自动全屏播放一遍 | 打开 / 导出 / 说一句「标题小一点」继续改 | — |

**四条铁律**
1. 技术语言永不出现在用户层：没有 `task=`、`documentId`、`fileId`、`hex`、`pt`、`overflow`、子代理名。
2. 任何超过 10 秒的等待都有：阶段名 + 已用时 + 可退出 + 回来能找到。
3. 任何「完成」都必须有交付口，任何「失败」都必须留在原地并说清代价。
4. 一次点击 = 一次决定，不是一次 agent 回合。

---

## 7. 修复路线（只描述做什么，不写代码）

### 第一刀（不动架构，三处改动体验质变）
1. **卡片动作内部化**：9 条 `slides*Message` 不再伪造用户发言；聊天层只留系统回执。这是投入产出比最高的一处——不改后端协议，只改「谁在说话」。
2. **等待具象化**：stage 一进入就广播「阶段 + 已用时 + 在做什么」；「正在调用工具...」永久消失。
3. **完成态诚实化**：`done` 后移到全部页落定；骨架期显示「已建 N/M 页」并锁编辑；完成卡给「打开 PPT」。

### 第二刀（把卡升级成任务）
4. 会话内任务槽/任务条，支持多任务、失败保留、草稿卡不因闲聊消失。
5. 关面板后顶栏常驻「PPT 生成中 x/y」；完成给系统通知。
6. 停止/失败/重启三态各有恢复卡：「继续生成剩余 / 打开已有文件 / 从头再来」。

### 第三刀（创作台）
7. 风格选择搬到主画布（大图 + 换一批 + 可返回）；配图改批量提交；成品自动播放 + 导出。
8. 语言统一与 i18n 收口（术语、warnings、分隔符、死键 `slidesPageDone`）。
9. 工艺清理：字号 ≥12px、对比度 ≥4.5:1、focus-visible、aria-live、危险操作确认、`·v3` 删除、`[只读]` 按真实 editable 显示。

---

## 8. 已核实「不是问题」的点（避免误伤）

1. **会话重载/切会话后进度卡能恢复**：工具事件（含 `tool.updated` 的 partialResult）落库并在快照重放；丢失只发生在网关重启后。
2. **逐页落页进度是真实的**：严格按页序执行、每页成功才上报，`appliedCount` 单调，无乱序假勾选。
3. **配图轮询有 `updatedAt` 单调守卫**，旧响应不会覆盖新广播（问题只在 target 切换时未重置）。
4. **存在通用「停止」入口**：composer 运行时发送键变方形停止键 → `api.cancelRun`。不是「无法中止」，问题是中止后的交代。
5. **运行中输入不丢**：会排队并显式提示「Agent 正在处理，输入将排队」。
6. **完成时确实会自动打开预览**：错在时机（1 页骨架就打开并宣布完成），不在「有无」。
7. **生成阶段有真进度**：逐页「已完成 x/y 页」、配图「x/y 张」，逐页实时画在打开的视图上。
8. **errorCode 不会直接渲染成用户文案**：黑话主要来自 warnings 与 Agent「如实转告」，不是 errorCode 直出。
9. **风格卡线框 SVG 无注入风险**：来自网关确定性本地预设，非模型/用户文本。
10. **中英 slides 文案键基本对齐（32/31）**，唯一死键 `slidesPageDone`。
11. **配图后台并发 + 逐张处置本身是好设计**：`page_images_review` 期间主对话不被阻塞；问题只在文案、批量与串行回合同步。
12. **卡片按钮在运行时 disabled，防住了连点/重复提交**；问题是力度过大（见 P1-4），不是没防。
13. **生成失败会保留草稿**，只有全部完成才回收。

---

## 9. 需真机复验的点（本次为静态审计）

1. 风格图单张真实耗时与三张总时长（代码估算 ~100s/张，需实测）。
2. `accept` 时若后台仍在跑，界面沉默的真实长度与用户可感知状态。
3. 「打开草稿」在非 Room 页面是否真的静默 no-op（依赖 `roomId` 为空的分支）。
4. `·v3`、warnings 中英混排、`[只读]` 前缀在真实界面中的视觉冲击。
5. 关掉 Agent 面板再打开，进度卡是否如代码推断般恢复，以及用户是否知道「回来能看到」。

---

## 10. 附录：证据索引（按主题）

| 主题 | 位置 |
|---|---|
| 进度卡全部阶段与动作 | `apps/desktop/src/renderer/src/components/agent/SlidesProgressCard.tsx`（540 行） |
| 卡片可见性/轮询/挂载 | `apps/desktop/src/renderer/src/components/agent/AgentChatView.tsx:552-630, 989-1030, 1132-1140` |
| 按钮 → 用户消息 | `apps/desktop/src/renderer/src/components/AgentPanel.tsx:545-641, 845-862` |
| 卡片样式 | `apps/desktop/src/renderer/src/components/agent/AgentChat.css:1516-1980, 3097-3207` |
| 阶段状态机与文案 | `apps/gateway/src/modules/subagents/tools.ts:1117-1200, 1378-1420, 1640-1720, 1900-1965` |
| 风格阶段（静默等待根因） | `apps/gateway/src/modules/subagents/slides-style-stage.ts:220, 305-318, 436-448` |
| 配图阶段（accept/settling/超时） | `apps/gateway/src/modules/subagents/slides-page-images-stage.ts:65-110, 150-168, 243-255, 258-355, 400-455` |
| 配图上限/时限 | `apps/gateway/src/modules/subagents/slides-page-images.ts:14-16`、`slides-page-images-prewarm.ts:7,130` |
| 落页完成/骨架/回收/warnings | `apps/gateway/src/modules/subagents/slides-layout-tail.ts:593-610, 704-756, 900-945, 102-114` |
| 完成事件与自动打开 | `apps/desktop/src/renderer/src/App.tsx:654-720`、`main/gateway/office-bridge.ts:437-490` |
| 顶栏只读标签 | `apps/desktop/src/renderer/src/components/TopBar.tsx:95-112` |
| AI 修改注入 | `apps/desktop/src/main/office/office-generation.ts:90-130`、`App.tsx:707-731` |
| 会话切换限制/停止 | `AgentSessionSwitcher.tsx:57/94/117`、`AgentComposer.tsx:1348-1351`、`useAgentSession.ts:493-530` |
| 文案 | `i18n/locales/zh-CN/surface.json:56-84`、`en-US/surface.json:56-84` |
| 主 Agent 流程约定（用户不可见） | `agents/main/SYSTEM.md:11` |

---

## 11. 审计说明

- 本次为**只读代码审计**：三路独立审计（进度卡状态机 / 产出物承接 / 入口文案），Lead 交叉复核并抽验关键证据行；除新增本文档外，未修改任何既有文件、未改动任何代码、未启动应用。
- 「乔布斯标准」不是修辞：判据固定为焦点、简单、品味、掌控、诚实、情感六条，每条发现都对应到用户实际感受，避免变成设计说教。
- 结论里区分了「工程已跑通」与「产品未收口」：这不是推倒重来，第一刀三处改动不动后端协议即可显著改善。

---

## 12. 修复状态（2026-10-20 落地）

> 本节在审计完成后追加。实施顺序：先改「谁在说话 / 等待 / 完成 / 出口 / 失败」，再改「卡片交互」，最后收外围假状态与文案。全部改动保持 `@nxcore/agent-contract`、`@nxcore/gateway` typecheck 绿；`@nxcore/desktop` typecheck 仅剩 10 条**既存** `ThoughtsPane.tsx` 错误（与本轮无关）。未启动真机，视觉与端到端体验仍需真机复验。

### P0

| 项 | 状态 | 落地方式 |
|---|---|---|
| P0-1 伪造用户发言 | ✅ 已修 | `StartAgentRunInput.displayPrompt` 端到端：入库消息/会话标题/乐观气泡只用人话，技术指令只进 runtime；卡片动作改两段式 `onAction(hiddenPrompt, displayText)`；AI 修改与产物库建文件同样带 `displayMessage` |
| P0-2 等待黑洞 | ✅ 已修 | 网关新增 `drafting / style_generating / style_extracting / planning / failed` 阶段广播；卡片显示人话阶段名 + mm:ss 已用时 + 细进度线 |
| P0-3 假揭晓 | ✅ 已修 | `deferDone` 让骨架入库不再广播 done；全部页落定后 `/v1/office-complete` 补发真完成（含 partial/appliedPages/totalPages/failedPages）；Toast 区分完整/部分完成 |
| P0-4 卡片不是任务 | ◐ 基本完成 | 多任务卡（最新 + 所有等待/进行中，最多 3 张折叠）、失败卡保留、草稿卡不再因闲聊消失、按 documentId 分 key 轮询；**未做**：关面板后的全局常驻任务条、系统通知 |
| P0-5 成品无出口 | ✅ 已修 | 完成态「打开 PPT / 继续修改」；真完成时才自动打开预览；无 fileEntryId 不出现打开按钮 |
| P0-6 失败/中断/停止无交代 | ✅ 大部分 | 失败卡 + 错误码人话映射 + 可展开 warnings；停止/中断状态与中性回执；配图 runner 超时标 failed；「继续生成剩余页面」；**未做**：网关重启后的自动恢复卡（目前靠「继续上次的 PPT」口令） |

### P1

| 项 | 状态 | 落地方式 |
|---|---|---|
| P1-1 多次盖章 / 按钮名不符 | ✅ | 「生成 PPT」→「内容确认，去选风格」；明确内容确认动作；停点数量按产品定义保留 |
| P1-2 宣传不存在的确认卡 | ✅ | 删除「选受众/时长/风格」，改为与现状一致的说明 |
| P1-3 148×83 挑风格 | ✅ | 全屏大图选择器（portal + 键盘 ←/→/Esc +「用这套 / 都换一批 / 关闭」） |
| P1-4 全局 busy 锁卡 | ✅ | busy 收窄为 `submitting`，动作级 `pendingAction`，不再整卡禁用 |
| P1-5 逐张审图 N 次回合 | ✅ | 九宫格批量「保留/不用/换一张」+ 一次提交（网关新增批量 `regeneratePageImages/rejectPageImages/restorePageImages`） |
| P1-6 accept 沉默 16 分钟 | ✅ | accept 立即 abort runner、用当前图落页，未完成页按退化处理并明说 |
| P1-7 跨文档串台 | ✅ | 轮询状态按 documentId 分 key、切换即清、响应校验 documentId + updatedAt |
| P1-8 会话被扣作人质 | ✅ | 运行中可切其它会话（后台继续）；新建仍禁但给出中性说明，不再把「忙」报成「失败」 |

### P2

| 项 | 状态 | 说明 |
|---|---|---|
| P2-1 术语崩塌 | ✅ | 卡片/按钮人话化（内容稿/配色与版式预览/生成页面等）；清理 28 个旧 i18n 死键 |
| P2-2 hex/pt 当产品语言 | ✅ | 演示页大图优先，配色与字号收进「细节」折叠 |
| P2-3 调试残留 | ✅ 大部分 | 删除 `·v3`；时间线 `slides_draft` 改「制作演示文稿」且不再显示 `generate/style/draft` 参数；子代理英文链仍留在展开详情（低优先） |
| P2-4 可读性/无障碍 | ✅ | 关键字号 ≥12px、对比度提升、focus-visible、aria-live、带页码/标题的 aria-label、点击区 ≥32px |
| P2-5 危险操作无确认 | ✅ | 「全部不用」danger + 二次确认；打回后果文案 |
| P2-6 五入口四命名 | ◐ | 已删除错误的「[只读]」标签；命名统一为「PPT / 演示文稿」（`files.slides`、`files.categoryLesson`、en 侧 presentation）；入口收敛**未做**（属 IA 产品决策） |
| P2-7 假状态 | ✅ | DocsPage 打开 loading/失败原因、PageCanvas 诚实空态、预览失败如实说明 + 重试、不再预设「已用系统应用打开」 |
| P2-8 版本与命名不可辨 | ✅ | 网关 `listRoomFiles` 下发 `versionNo`（`file_versions` max，legacy 为 null 不伪造）+ `updatedAt`（最新版本时间）；产物库行显示 `vN · 相对时间 · 体积`；DocsPage 版本角标并按 `updatedAt` 排序，AI 改过的产物自动上浮 |
| P2-9 草稿静默进回收站 | ✅ | 最终 `page_applied` 载荷带 `draftArchived`，完成卡显示「内容稿已归档，可在资料面板恢复」 |
| P2-10 视觉人格断裂 | ✅ | 进度卡/风格大图浮层/配图九宫格统一回**全局冷中性 token**（`--surface/--border/--text/--muted/--subtle/--danger`，主按钮用 `--text`），随 mono/soft 主题联动；消除 7 处暖色硬编码与未定义的 `--agent-card-*` 伪 token；保留单一深色主按钮与细进度线；圆角/内距对齐内联卡（10px / 12px），hover 用 color-mix 保持反馈 |

### 验证记录

- `@nxcore/agent-contract` typecheck：✅
- `@nxcore/gateway` typecheck：✅
- `@nxcore/desktop` tsc：仅 10 条既存 `ThoughtsPane.tsx` 错误，非本轮文件 0 新增
- 网关 vitest：slides 相关 6 文件 111 用例 ✅（含新增 deferDone/completeDeck/批量配图/中断标失败/失败载荷）；knowledge 13 文件 97 用例 ✅（含 v1→v2、legacy null、路由序列化）
- 桌面 vitest：进度卡 26 ✅、AgentChatView 12 ✅、useAgentSession 6 ✅、office 格式 8 ✅、office 编辑 10 ✅、AI 修改转发 6 ✅、agent 全域 160 ✅、docs-page 3 ✅
- **既存失败（HEAD 即红，非本轮引入）**：`office-preview-registry.test.ts > openTest`（源码无该方法）、`agent-room-selection.test.ts > delegation schemaVersion`（实现 2 / 测试期望 1）、`context-room-resource-import.test.tsx`（node env 下 `document is not defined`）；网关全量套件另有 12 个与 PPT 无关的 migrations/sync 失败（并行任务导致）
- 未做：真机启动与视觉走查、桌面端 E2E；P2-6 的「五入口收敛」与「同名产物合并进版本链」属 IA/产品决策，留给下一步
