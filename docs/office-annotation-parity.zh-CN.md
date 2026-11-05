# 批注（注释）能力对齐：Excel / PPT / PDF 与 Word 一致

目标：把 Word 已有的「选中内容 → 打注释 → 攒批注 → 发送给 Agent」闭环，完整复用到
Excel、PPT、PDF。用户在任何一类 Office/PDF 文件里都能像 Word 一样打注释。

## 1. 现状（本次改动前 → 改动后）

| 能力 | Word (docs) | Excel (sheets) | PPT (slides) | PDF |
| --- | --- | --- | --- | --- |
| 选中后「注释」入口（embed 宿主模式） | ✅ 铅笔浮标 + 紧凑输入框 | ⚠️ 仅「AI 修改」浮层 → ✅ 铅笔「注释」+ 紧凑输入框 | ❌ embed 下被裁掉 → ✅ 同 Word | ❌ embed 下被裁掉 → ✅ 同 Word |
| 入队（Enter 回车即加入宿主队列） | ✅ | ⚠️ 需点「加入队列」→ ✅ Enter 入队 | ❌ → ✅ | ❌ → ✅ |
| 文档内锚点（高亮/徽标 + hover 卡片 + 改写/删除） | ✅ 下划线 + Hover 卡 | ❌ → ✅ 区域虚线框 + 编号角标 + Hover 卡 | ❌ → ✅ 元素徽标/描边 + Hover 卡 | ❌ → ✅ 页面 quads 高亮 + 角标 + Hover 卡 |
| 宿主队列快照下发 / 动作回灌 IPC | ✅ docs:ask-queue | ❌ → ✅ sheets:ask-queue | ❌ → ✅ slides:ask-queue | ❌ → ✅ pdf:ask-queue |
| 对话侧批注徽章 + 气泡卡片 + 合批发送 | ✅ 通用 | ✅（缺 excerpt）→ ✅ 带 excerpt | ❌ → ✅ | ❌ → ✅ |
| 转发给 Agent 的定位信息 | 块索引 + 类型 + 摘要 | sheetId + A1 区域 → 另带摘要 | 页 + 元素 id（embed 死代码）→ 可用 + 摘要 | 无 → 原始页序 + PDF 坐标 quads + 摘要 |

本次改动后，四类文件的批注链路一致：`选区注释 → 宿主队列 → 文档内锚点 / 对话侧徽章 → 合批发送`
（详见第 4 节落地记录与第 5 节验收）。

## 2. 交互契约（三种格式统一）

1. 选区结束 → 选区旁出现铅笔浮标「注释」（复用各 app 已有 trigger 或新建）。
2. 点击/回车打开**紧凑宿主浮层**：只有一个输入框。
   - Enter（非输入法组合态）→ 入宿主队列，浮层关闭。
   - Esc / 点外部 → 关闭，不入队。
3. 宿主通过 IPC 下发该文件的批注队列快照（空数组 = 清空），编辑器按锚点渲染：
   - 锚点标记（高亮/徽标/编号），悬停显示小卡片：原文摘录 + 注释 + 「修改」「删除」。
   - 点锚点或「修改」→ 浮层进入编辑态（预填原注释），Enter 保存 = `update`；「删除」= `remove`。
4. 队列事实只在宿主（EverRoom 渲染层 store），编辑器只渲染 + 回传动作。
5. 对话侧可见性、合批发送、卡片渲染沿用 Word 已实现链路（NoteQueueChip / note cards）。
6. 语义：转发消息只带「位置事实 + 用户原话」，不预设「修改」，也不带工具名。

## 3. 数据契约

### 3.1 每个 app 的脚本 API（`window.<api>` → preload → main）

| App | 渲染 API 对象 | 现有 | 新增 |
| --- | --- | --- | --- |
| docs | `window.desktop` | agentAsk / onAskQueue / askQueueAction | （参考实现，不改） |
| sheets | `window.desktopApi` | agentAsk | onAskQueue / askQueueAction |
| slides | `window.slidesApi` | agentAsk | onAskQueue / askQueueAction |
| pdf | `window.pdfApi` | — | agentAsk / onAskQueue / askQueueAction |

主进程 IPC 通道（每 app 三条）：
- `<app>:agent-ask`（invoke，已有 / pdf 新增）
- `<app>:ask-queue`（main → renderer，推送快照）
- `<app>:ask-queue-action`（renderer → main，`send-all` | `remove` | `update`）

main 导出（写进 `apps/<app>/src/main/embed.ts`）：

```ts
push<App>AskQueue(wcId: number, items: <App>AskQueueItem[]): void
set<App>AskQueueActionHook(hook: ((wcId: number, action: <App>AskQueueAction) => void) | null): void
```

### 3.2 agent-ask 载荷扩展

公共字段：`instruction`、`mode?: 'now' | 'queue'`、`excerpt?: string`（选区纯文本快照，≤200 字）。

| App | 定位字段 |
| --- | --- |
| sheets | `sheetId`、`sheetName?`、`range`（A1） |
| slides | `slideIndex`、`targets: [{ id, desc }]`（durable id + 节点描述） |
| pdf | `pageIndex`（原始页序，旋转稳定）、`quads: number[][]`（PDF 坐标，格式同现有 markup：`[x1,yMax,x2,yMax,x1,yMin,x2,yMin]`） |

### 3.3 队列快照条目（宿主 → 编辑器）

共同：`{ id, instruction, excerpt? }` + 上表定位字段（扁平）。

### 3.4 宿主跨进程形状

`apps/desktop/src/shared/office.ts` 的 `OfficeAskAnchor` 扩展为各格式字段并集：

```ts
interface OfficeAskAnchor {
  kind?: string
  fromBlockIndex?: number; toBlockIndex?: number      // Word
  sheetId?: string; sheetName?: string; range?: string // Excel
  slideIndex?: number; elementIds?: string[]           // PPT
  pageIndex?: number; quads?: number[][]               // PDF
}
```

渲染层 → 主进程 `office:ask-queue-sync`：`{ fileId, items: [{ id, instruction, excerpt?, anchor? }] }`。
主进程按 fileId 反查实例 kind，映射成该 app 的扁平条目后调对应 `push<App>AskQueue`。
动作回灌复用现有 `office:ask-queue-action` 事件（带 fileId + workspaceId + action）。

## 4. 各端实现清单

### 4.1 genoffice（submodule，分支 everroom/host-agent-tools）

参考实现全部在 `apps/docs`：
- `src/renderer/components/AiAskPopover.tsx` 的 `hostMode` 紧凑浮层（第 302-430 行区间）
- `src/renderer/components/HostNoteCard.tsx` hover 卡片
- `src/renderer/editor/ai-queue-anchors.ts` 锚点 decoration
- `src/main/docs-main.ts` `pushDocsAskQueue` / `setDocsAskQueueActionHook`
- `src/preload/index.ts` `onAskQueue` / `askQueueAction`

#### sheets
- `src/shared/desktop-api.ts`：`SheetsAgentAskOp` 增 `excerpt`；新增 `SheetsAskQueueItem` / `SheetsAskQueueAction`；`DesktopApi` 增 `onAskQueue` / `askQueueAction`。
- `src/preload/index.ts`、`src/main/sheets-main.ts`（normalize + hook + 两条 IPC）、`src/main/embed.ts`。
- `src/renderer/ai/AiSelectionAsk.tsx`：embed 下改为紧凑宿主浮层（注释铅笔、Enter 入队、编辑态）。
- `src/renderer/ExcelShell.tsx` / `App.tsx`：选区摘要（选中区域文本，≤200 字）、订阅队列快照、渲染区域锚点（虚线框/角标 + hover 卡片，点击可编辑）、动作回传。锚点定位用 A1 区域 → Univer 单元格矩形；滚动/缩放后重算。
- i18n：从 docs 复制 `aiNoteBtn / aiNotePlaceholder / aiNoteEditPlaceholder / aiNoteCardEdit / aiNoteCardDelete` 五个 key（19 个语言块）。

#### slides
- `src/shared/ipc.ts`：`SlidesAgentAskOp` 增 `mode`、`excerpt`；新增队列条目/动作类型；`SlidesApi` 增 `onAskQueue` / `askQueueAction`。
- `src/preload/index.ts`、`src/main/slides-main.ts`、`src/main/embed.ts`。
- `src/renderer/App.tsx`：embed 下恢复注释浮标（铅笔「注释」）+ 紧凑宿主浮层（Enter 入队 / 编辑态），去掉 `!everroomEmbed` 的入口裁切；选中元素摘要；订阅宿主队列，在当前页对目标元素画编号徽标/描边 + hover 卡片（可编辑/删除）；切页后只渲染当前页锚点。
- i18n 同上（slides 已有 `aiAskQueue`，补 `aiNote*` 五个 key）。

#### pdf
- `src/shared/ipc.ts`：新增 `PdfAgentAskOp` / `PdfAskQueueItem` / `PdfAskQueueAction`，`PdfApi` 增三个方法。
- `src/preload/index.ts`、`src/main/pdf-main.ts`、`src/main/embed.ts`（新增三条 IPC + 两个 hook 导出）。
- `src/renderer/App.tsx`：embed 下选区工具条恢复「注释」按钮 → 紧凑宿主浮层；打开时用 `selectionQuadsByPage` 抓 pageIndex + quads + excerpt；订阅宿主队列，在页面上画锚点高亮（区别于原生 markup 的颜色）+ hover 卡片；点击锚点编辑、删除。
- i18n 同上。
- 复用现有 `annotations.ts` 的 `viewToPdf` / `pdfToView` 做坐标换算。

### 4.2 desktop（宿主）

- `src/shared/office.ts`：`OfficeAskAnchor` 扩展。
- `src/main/office/office-generation.ts`：
  - `SheetsAgentAskPayload` 增 `excerpt` 并写进消息/事件；
  - `SlidesAgentAskPayload` 增 `mode` / `excerpt`，`buildAgentAskMessage` 支持摘要，转发事件带 title/fileId/instruction/excerpt/mode/anchor；
  - 新增 `PdfAgentAskPayload` + `buildPdfAgentAskMessage/DisplayMessage` + `wirePdfAgentAsk`；
  - 新增 `wireSheetsAskQueue` / `wireSlidesAskQueue` / `wirePdfAskQueue`。
- `src/main/office/office-runtime.ts`：接口补三个 app 的 `push…AskQueue` / `set…AskQueueActionHook`。
- `src/main/office/office-preview-registry.ts`：`pushAskQueue` 按实例 kind 路由；`ensureRuntime` 注册三条新 wire。
- `src/main/index.ts`：`office:ask-queue-sync` 归一化保留新 anchor 字段并交给 registry。
- `src/preload/index.ts`：`syncAskQueue` 载荷类型带上通用 anchor。
- `src/renderer/src/components/agent/askDrafts.ts` + `workbench/state/store.ts` + `workbench/shell/Workbench.tsx`：`PendingAskDraft.anchor` 扩展；快照下发带 anchor。
- `apps/desktop/tests/office-agent-ask.test.ts`：补 slides/pdf 组包、mode/excerpt、队列路由用例。

## 5. 验收

### 5.1 自动化（本次已跑）

| 检查 | 结果 |
| --- | --- |
| `apps/desktop` `tsc --noEmit` | ✅ 通过 |
| `apps/desktop` `vitest run tests/office-agent-ask.test.ts` | ✅ 33/33（新增 slides excerpt/mode、PDF 组包/转发、四格式队列动作回灌） |
| `apps/desktop` `vitest run tests/office-preview-registry.test.ts` | ✅ 53/53（新增按 kind 路由：docx/sheets/slides/pdf + 空数组清空 + 未知 fileId） |
| `apps/desktop` `vitest run askDrafts` | ✅ 6/6 |
| genoffice `typecheck -w @genoffice/sheets` / `@genoffice/pdf` | ✅ 通过 |
| genoffice `typecheck -w @genoffice/slides` | ⚠️ 仅剩改动前既有的 `src/main/page-spec.ts` + `tests/page-spec.test.ts` 报错（未触碰），本次改动文件 0 报错 |
| genoffice 新增单测 | ✅ sheets 16、slides 26、pdf 30 |
| `prepare-genoffice-runtime.mjs`（GENOFFICE_EMBED_ONLY=1 全量重建） | ✅ 成功，`build/genoffice-runtime` 内四个 app 的 `main/embed.js` 均含新增导出 |
| `tools/check-theme-colors.mjs` | ✅ No new raw colors |
| `tools/check-english-comments.mjs` | 新增注释无中文命中；失败项均为既有文件历史中文注释 |
| `apps/desktop` 全量 vitest | 870 passed / 10 files 失败均为与本次无关的既有环境问题（Electron/SaaS/obsidian/local-agent discovery），office 相关全绿 |

### 5.2 手工验收（需要真机点一遍）

1. 在工作空间打开一份 `.xlsx`：拖选单元格区域 → 铅笔「注释」→ 输入 → 回车，区域出现虚线框 + 编号角标；
   对话区上方出现「N 条注释」徽章；hover 锚点可改写/删除；「全部发送」后锚点清空、Agent 收到带
   `工作表 + A1 区域 + sheetId + 原文摘要` 的消息。
2. `.pptx`：切到某页选中元素 → 铅笔「注释」→ 回车入队 → 当前页元素出现编号徽标；切页/缩放/滚动锚点跟随；
   发出去的批注卡片带元素文本摘要。
3. `.pdf`：拖选文字 → 工具条铅笔「注释」→ 回车入队 → 页面出现高亮 + 角标；缩放/旋转后锚点仍贴合；
   发送后 Agent 收到「第 N 页 + 原文摘要」。
4. 失败分支：只读打开、文件不归属工作空间、空选区。

### 5.3 已知边界

- Excel 锚点在冻结窗格下可能不贴合（普通滚动/缩放/切表已覆盖）；超大选区只读 40×20 格做摘要。
- PPT 锚点按元素 durable id 反查，元素被删除/移出当前页时不渲染；队列为空数组即清空。
- PDF 多页选区取最小原始页 + 该页 quads（契约只有单个 pageIndex），摘要保留全文；锚点可点击会拦截从已批注文字起手的拖选。
- 编辑器内没有「全部发送」按钮（队列事实与发送在对话侧，与 Word 一致）；只读视图仍显示锚点并可改写/删除（与 Word 一致）。

## 6. 落地记录（文件）

genoffice（submodule，全部未 commit，靠 dirty patch 参与 runtime 构建缓存）：

- `apps/sheets`：`main/embed.ts`、`main/sheets-main.ts`、`preload/index.ts`、`shared/desktop-api.ts`、`shared/ask-queue.ts`(新)、
  `renderer/App.tsx`、`renderer/ExcelShell.tsx`、`renderer/ai/AiSelectionAsk.tsx`、`renderer/ai/AiNoteLayer.tsx`(新)、
  `renderer/ai/note-anchors.ts`(新)、`renderer/ai/selection-excerpt.ts`(新)、`renderer/styles.css`、`renderer/i18n/strings-ai.ts`、`tests/ask-queue.test.ts`(新)
- `apps/slides`：`main/embed.ts`、`main/slides-main.ts`、`main/ask-queue.ts`(新)、`preload/index.ts`、`shared/ipc.ts`、
  `renderer/App.tsx`、`renderer/components/AiAskPopover.tsx`、`renderer/components/HostNoteAnchors.tsx`(新)、
  `renderer/ai/host-queue-anchors.ts`(新)、`renderer/styles.css`、`renderer/i18n/strings-ai.ts`、`tests/ask-queue.test.ts`(新)、`tests/host-queue-anchors.test.ts`(新)
- `apps/pdf`：`main/embed.ts`、`main/pdf-main.ts`、`main/host-ask.ts`(新)、`preload/index.ts`、`shared/ipc.ts`、
  `renderer/App.tsx`、`renderer/HostNotes.tsx`(新)、`renderer/styles.css`、`renderer/i18n/strings.ts`、
  `tests/host-ask.test.ts`(新)、`tests/host-notes.test.ts`(新)、`tests/host-ask-ipc.test.ts`(新)

desktop：

- `src/shared/office.ts`、`src/shared/sources.ts`、`src/preload/index.ts`、
  `src/main/index.ts`、`src/main/office/office-generation.ts`、`src/main/office/office-runtime.ts`、`src/main/office/office-preview-registry.ts`、
  `src/renderer/src/components/agent/askDrafts.ts`、`src/renderer/src/workbench/shell/Workbench.tsx`、
  `tests/office-agent-ask.test.ts`、`tests/office-preview-registry.test.ts`
- `build/genoffice-runtime` 已重建（manifest 记录新的 dirty/untracked 哈希）。

## 7. 独立审计结论与已修项（2026-11-04）

审计（独立只读）确认的主要问题与处置：

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| B2 | 队列快照只在 `askDrafts` 变化时下发；视图重建（关标签重开 / 内容哈希变化重开）后文档内锚点全丢 | **已修**：`office-preview-registry` 按 fileId 缓存最近一次快照（`askQueueSnapshots`），视图新建/重建后 `dom-ready` + 1.2s 兜底重放（`scheduleAskQueueReplay`）；新增单测覆盖。 |
| R1 | PDF 端 `PdfAskQueueItem.pageIndex/quads` 必填，宿主侧可选 → 无锚点行被 app 端静默丢弃 | **已修**：registry 投递 PDF 前过滤无锚点行；新增单测。 |
| R2 | `main/index.ts` quads 上限 40，与 pdf `MAX_QUADS=200` 不一致，长选区高亮被截断 | **已修**：上限对齐 200。 |
| R3 | 文档内「全部发送」动作链路在 `scopeReady=false` 时先记 handled 再 return → 切标签后会永久漏发 | **已修**：确认 ready 后才记 handled（目前四个编辑器内都没有 send-all 入口，动作链路留作后续）。 |
| R4 | docs 队列投递缺 `typeof pushDocsAskQueue === 'function'` 守卫（其它三支有） | **已修**。 |
| R5 | `wireSlidesAgentAsk` 缺 `setSlidesAgentAskHook` 能力守卫 → 旧 runtime 会让 `ensureRuntime` 抛错 | **已修**（静默降级）。 |
| R6 | PDF 批注入队失败只有 `console.warn`，用户误以为记上了 | **已修**：改为页面 notice（新增 i18n key `aiNoteQueueFailed` ×19 语言）。 |
| B1 | PPT 在「用原应用打开」的**只读预览**路径下是阅读模式，没有选区，注释入口不出现 | **不修（按设计）**：主入口（文件标签页 / 工作空间文件气泡）打开文档会带 `editable:true`，PPT 是可编辑实例，批注正常。只读预览路径保持纯看图；如需该路径也能注释，需要单独做「页级批注」（阅读视图无元素选区）。 |
| — | Excel 单格无法注释（入口只对拖选多格出现） | **暂不修**：避免每次单击都弹浮标；后续可在 AI 编辑模式下放开单格。 |

另外确认无误的接缝：三 app embed 导出名/形状与宿主声明逐一对齐；`X:agent-ask / X:ask-queue / X:ask-queue-action` 通道与方向正确；扁平字段三层无错位；draft.id 回传命中 store；excerpt 四格式都有真实来源；空数组清空语义贯通；老 runtime 缺 hooks 时静默降级。

## 8. 分工

- lead：契约、desktop 宿主全部改动、集成构建与验收。
- sheets-agent：`apps/sheets`。
- slides-agent：`apps/slides`。
- pdf-agent：`apps/pdf`。
