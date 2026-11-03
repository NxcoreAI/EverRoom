# 选区「问 Agent」：框选 → 备注 → 打包进对话（Word / Excel，原型）

目标：不用再在对话区里手打「第 3 页第 2 段哪里不对，想干什么」。在 Word / Excel 里框选
内容 → 选区旁浮出小输入框 → 回车（或「加入批注」攒着）→ 备注进入该文件所属工作空间的
对话，Agent 按块索引 / sheetId+区域定位到那几处，**按用户原话自己判断该回答还是该改**。

与 PPT 已有的「AI 修改」弹层是同一条链路的复用：
`slides:agent-ask` / `docs:agent-ask` / `sheets:agent-ask` → `office:agent-ask`。

批注队列在**两个地方**都可见（同一份事实，宿主是唯一来源）：

- **文档内**（Word）：原文按块索引重新高亮（复用 `ai-queue-anchors` 装饰器），右侧
  悬浮面板逐条列出「原文摘录 + 我的批注」，可点原文定位、单条移除、「全部发送」。
- **对话区**：工作会话标签里、对话面板上方的一行「待发送批注 N 条」，每条同样是
  「原文 + 批注」，支持单条移除 / 清空 / 全部发送；正常打字发消息不受队列影响。
  工作空间标签上还有角标数字，任何标签下都能看到哪里有待发内容。
  > 注意：这一行不能塞进 AgentChatView 的 `composer` 插槽——那里是 absolute 定位的
  > 浮层输入框，普通流元素会被盖住；早期版本就是因此"对话区看不见"。

两种发送方式（同一个 `mode` 字段）：

- `now`（默认，回车）：立刻作为一条用户消息发出，主窗口切到对应工作空间对话。
- `queue`（点「加入批注」）：先攒进该工作空间的批注清单（不抢焦点），对话上方的
  「待发送批注 N 条」条里可以单条移除、清空或「全部发送」——全部发送时合成**一条**
  带编号的请求（技术指令带编号、气泡用圈号人话；开场白是「N 处内容上做了批注，
  逐条看原话处理」，同样不预设修改），投递成功才清空。

## 链路

```
Word：docs 选区浮层（AiAskPopover，host mode）
  → window.desktop.agentAsk({ instruction, fromBlockIndex, toBlockIndex, kind, excerpt, blockType, mode })
Excel：sheets 选区浮层（AiSelectionAsk，embed）
  → window.desktopApi.agentAsk({ instruction, sheetId, sheetName, range, mode })
  → ipc 'docs:agent-ask' / 'sheets:agent-ask'（genoffice：normalize + setXxxAgentAskHook）
  → desktop main wireDocsAgentAsk / wireSheetsAgentAsk（wcId 反查实例 → 文件 + 工作空间）
  → buildXxxAgentAskMessage / buildXxxAgentAskDisplayMessage（技术指令 / 人话分开）
  → ipc 'office:agent-ask' 扇出到渲染层（带 workspaceId / mode / title / instruction /
    excerpt / anchor）
  → workbench 消费：
       mode=now   → 激活该工作空间标签（无对话视图则切新工作草稿）+ store.pendingAgentAsk
       mode=queue → store.addAskDraft（不抢焦点，toast 报条数）
  → 批注镜像（双向，事实只在宿主侧）：
       store.askDrafts → office.syncAskQueue → main → docs 视图 'docs:ask-queue'
         → 文档内锚点高亮 + 右侧面板（原文 + 批注）
       文档面板动作 → 'docs:ask-queue-action' → main → 渲染层 'office:ask-queue-action'
         → 移除一条 = store.removeAskDraft；全部发送 = 激活该空间标签 + 请求对话面板发送
  → ConversationPane：
       pendingAgentAsk → sendPrompt(message, …, displayPrompt) 自动发送
       批注清单      → 上方「待发送批注 N 条」条（原文 + 批注），全部发送 = buildAskBatch 合成一条
```

## 载荷契约（`DocsAgentAskOp`）

Word（`DocsAgentAskOp`）：

| 字段 | 含义 |
|---|---|
| `instruction` | 用户在浮层里敲的话 |
| `fromBlockIndex` / `toBlockIndex` | 选区覆盖的**顶层块索引区间**（0 起，闭区间）。宿主 word 工具（`word_agent_edit` / `word_agent_ops`）只认块索引，不认页码/行号 |
| `kind` | `text` / `image` / `chart` / `table`（浮层按选区推导，决定 Agent 该用哪套编辑动作） |
| `excerpt` | 选区纯文本摘要（≤200 字）。块索引在编辑后会漂移，Agent 重新 `word_agent_read` 后用它交叉校验 |
| `blockType` | 首块 ProseMirror 节点名（排查/表格提示用） |
| `mode` | `now` / `queue` |

Excel（`SheetsAgentAskOp`）：

| 字段 | 含义 |
|---|---|
| `instruction` | 用户在浮层里敲的话 |
| `sheetId` | 活动工作表 id —— `sheets_agent_edit` 按 **sheetId** 定位（不认表名） |
| `sheetName` / `range` | 表名与 A1 区域：只用于文案与交叉校验 |
| `mode` | `now` / `queue` |

注入消息示例（技术指令，只进 runtime）：

> 我在 Word《方案.docx》第 4–6 块（正文「综上所述…」）选中了这段内容：这段结论太绕，改成三句以内的结论句。

**语义契约**：转发消息只带「位置事实 + 用户原话」，**不预设动作**——框选/标注不一定
是要修改（可能只是对这段内容有疑问想问 Agent），改还是答由 Agent 按用户原话自行理解。
消息里也不复述工具路线（`word_agent_read` → `word_agent_edit` 等）：这套引导已经在
`agents/main/SYSTEM.md` 路由表与各 `*_agent_read` / `slides_read` 工具描述里，转发层
再写一遍会在用户只是提问时把 Agent 推向强行修改。块索引漂移问题仍由工具描述里
「每次编辑后索引会变，需要最新索引时重新调用本工具」兜底。

气泡/会话标题只显示人话（`buildDocsAgentAskDisplayMessage`）：
「关于 Word《方案.docx》第 5–7 段选中的内容：这段结论太绕，改成三句以内的结论句。」
—— 这条规矩来自 `ppt-generation-ux-audit` P0-1（技术指令不能渲染成用户发言）。

## 改动文件

genoffice（submodule，分支 `everroom/host-agent-tools`，两个提交：
`d48bf31` Word 第一期、`498ef82` Excel + 攒批注）：

- `apps/docs/src/shared/ipc.ts`：`DocsAgentAskOp` / `DocsAgentAskResult` / `DesktopApi.agentAsk`
- `apps/docs/src/preload/index.ts`：`agentAsk → docs:agent-ask`
- `apps/docs/src/main/docs-main.ts`：`normalizeAgentAskOp`、`setDocsAgentAskHook`、`ipcMain.handle('docs:agent-ask')`
- `apps/docs/src/main/embed.ts`：导出 `setDocsAgentAskHook`
- `apps/docs/src/renderer/components/AiAskPopover.tsx`：`hostMode`（回车即发、误点外部直接丢弃）+ `onHostQueue`（加入批注）+ 导出 `selectionKind`
- `apps/docs/src/renderer/ai/protocol.ts`：导出 `blockIndexOfPos`（单一事实源）
- `apps/docs/src/renderer/App.tsx`：embed 下挂载浮层 + `submitHostAgentAsk(instruction, mode)`
- `apps/sheets/src/shared/desktop-api.ts`：`SheetsAgentAskOp` / `SheetsAgentAskResult` / `DesktopApi.agentAsk`
- `apps/sheets/src/preload/index.ts` + `src/main/sheets-main.ts` + `src/main/embed.ts`：`sheets:agent-ask` + `setSheetsAgentAskHook`
- `apps/sheets/src/renderer/ai/AiSelectionAsk.tsx`：可选 `onAddToQueue`（加入批注）
- `apps/sheets/src/renderer/ExcelShell.tsx`：embed 下把选区浮层接到宿主（`onAiSelectionAskHost`）
- `apps/sheets/src/renderer/App.tsx`：`handleAiSelectionAskHost`（取活动 sheetId/表名 + A1 区域）
- `apps/sheets/src/renderer/i18n/strings-ai.ts`：新增 `aiAskQueue`（19 个语言块）
- `apps/docs/src/renderer/components/AskQueuePanel.tsx`（新）：文档内批注面板（原文 + 批注 + 发送/移除）
- `apps/docs/src/renderer/App.tsx`：订阅宿主队列快照、块索引 → PM 位置重建锚点、面板挂载
- `apps/docs/src/main/docs-main.ts`：`pushDocsAskQueue` / `setDocsAskQueueActionHook` + 两个 IPC
- `apps/docs/src/renderer/styles.css`：面板与锚点样式（semantic tokens）

desktop：

- `src/shared/office.ts`：`OfficeAgentAskEvent` 增加 `workspaceId` / `mode` / `title` / `fileId`（`roomId` 改为可空）
- `src/main/office/office-runtime.ts`：`GenOfficeDocsRuntime.setDocsAgentAskHook`、`GenOfficeSheetsRuntime.setSheetsAgentAskHook`
- `src/main/office/office-generation.ts`：docs / sheets 两套 `build…AgentAskMessage` + `wireDocsAgentAsk` / `wireSheetsAgentAsk`（slides 路径顺带带上 `workspaceId`）
- `src/main/office/office-preview-registry.ts`：注册三条 wire
- `src/renderer/src/components/agent/askDrafts.ts`（+ `.test.ts`）：批注合批（多条 → 一条，技术指令带编号、气泡用圈号人话）
- `src/renderer/src/workbench/state/store.ts`：`pendingAgentAsk` + `askDrafts`（add/remove/clear）
- `src/renderer/src/workbench/shell/Workbench.tsx`：消费 `office.onAgentAsk`（now = 激活标签；queue = 入批注清单）；批注队列快照下发 + 文档面板动作回灌
- `src/renderer/src/workbench/conversation/ConversationPane.tsx`：消费 `pendingAgentAsk` 自动发送；渲染「待发送批注」条（原文 + 批注）+ 全部发送；消费文档侧「全部发送」请求
- `tests/office-agent-ask.test.ts`：docs / sheets 组包 + 转发 + 幂等 + 失败分支

## 手工验收

1. `apps/desktop` 下 `npm run dev`（会自动 `prepare-genoffice-runtime.mjs` 重建 embed 运行时）。
2. 在工作空间里打开/生成一份 .docx（必须归属某个工作空间）。
3. Word：框选一段文字 / 选中图片或表格 → 选区右下方出现「AI 修改」浮标 → 点开。
   Excel：**拖选单元格区域**（普通单击不会弹出）→ 出现浮标 → 点开。
4. 输入「这段太长，压成两句」→ 回车（立即发送）。
   输入后点「加入批注」→ 草稿进清单，重复几处后回到该工作空间对话，上方「待发送批注 N 条」→ 全部发送。
5. 期望：出现一条人话气泡（批注合批时是圈号列表）；Agent 侧能看到 `word_agent_read`/`word_agent_edit`
   或 `sheets_agent_read`/`sheets_agent_edit` 调用并实际改到目标；文件页签自动刷新。
6. 失败分支：文件不属于任何工作空间 → 状态行/浮层提示；Agent 正忙 → 意见回填输入框（批注清单则保留待发）。

## 已知未做（原型边界）

- 文档内锚点按**块索引**重建（不是字符级锚点）：选中之后、发送之前如果大改过文档，
  高亮可能落到相邻块；面板里的原文摘录仍以选中时的快照为准。
- 批注清单**不可在文档内编辑文字**：改批注要移除后重新加（standalone 那套锚点内联编辑没搬）。
- Excel / PPT 还没有文档内锚点（只有对话侧清单）。
- 批注清单只在内存（store），重启应用即失效；要不要落库待定。
- PPT 只补了 `workspaceId`（消息能定位到工作空间），还没有 Excel 那种「加入批注」。
- 浮层错误文案：Word 走 i18n 的 `aiErrorPrefix`，Excel 暂直接显示宿主返回的原始 code。
- 块索引漂移只靠 Agent 侧先 `word_agent_read` + `excerpt` 交叉校验，没有在宿主侧做版本指纹。
