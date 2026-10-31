# Agent 编辑 Excel：headless 会话与工作簿工具链（实现说明）

> 状态：已落地（2026-10-31）；`sheets_agent_read` / `sheets_agent_edit` 双工具 + 12 个表格 AI 工具 + `propose_operations` 工作簿 DSL（68 个 op / 11 份指南）
> 关联：`docs/xlsx-agent-operation-coverage.zh-CN.md`、`xlsx-agent-test-prompts.md`、Word 对等实现 `docs/word-agent-editing-implementation.zh-CN.md`

## 1. 目标

Excel 的 agent 编辑体验与 Word 一致：

1. 任意已入库 `.xlsx` 都能按 `fileId` 读取和编辑——文件没打开、页签已关闭、UI 隐藏时同样可用；
2. 后台编辑不弹页签、不抢焦点、不覆盖用户未保存的输入；
3. 编辑结果落盘并回填文件库版本链（`edited` 广播），后续打开看到的是最新版本；
4. 能力覆盖 Excel 编辑器 AI 工具链：读（上下文/区域/格式/特性/搜索/统计/公式审计）+ 写（`propose_operations` 全部 op）。

## 2. 架构

```
Agent (gateway)
 ├─ sheets_agent_read   → describe：工作簿上下文 + 工具词汇表 + 11 份操作指南
 ├─ sheets_agent_edit   → calls（read_range / read_cells / find_cells / aggregate_range /
 │                         propose_operations / trace_precedents / trace_dependents / …）
 └─ file_search         → 按文件名在文件库定位 fileId（gateway pi tool）
        │  POST /v1/office-agent-tools {kind:'spreadsheet', mode, fileId, roomId, workspaceId}
桌面 office-bridge
 └─ OfficePreviewRegistry
     ├─ 有可见可编辑实例 → 活会话（渲染层实时重绘 + pending-edit 脏闸门 + 版本回填）
     ├─ 有可见只读实例   → 读：renderer describe（只读可读）；写：not_editable（不绕过用户选择）
     └─ 无可见实例       → AgentSheetSessionManager（隐藏 sheets 视图，同一套渲染层工具链）
            │ queueWorkbookForView + workbook:agent-ready → waitForAgentReady
            │ fileSaved hook
            └─ importAgentGeneratedFile(fileEntryId 钉住) → 版本 +1 + edited 广播
```

关键原则：**隐藏会话与活会话跑同一份 renderer 工具/op 实现**，不新造 xlsx 引擎；网关只做元数据校验与透传，op 词汇与指南由渲染层唯一事实源下发。

## 3. 隐藏会话（AgentSheetSessionManager）

文件：`apps/desktop/src/main/office/office-agent-sheet-session.ts`
接入：`office-preview-registry.ts`（`describeSpreadsheetArtifact` / `applySpreadsheetAgentTools` 无可见实例时路由到这里）

- **创建**：`catalogEntry`（legacy `get` 兜底）→ `storagePath` + sha256 → `prepareSpreadsheet(..., { agent: true })` 工作副本 → `createSheetsView({ includeAiHandlers:false, readonly:false, claimActive:false })`。
- **工作副本隔离**：后台会话的文件名带 `agent-` 前缀，与用户可见视图的工作副本分开。GenOffice Sheets 的崩溃恢复副本按工作副本路径哈希存放；共用路径会让隐藏视图命中山「是否恢复」对话框——隐藏视图没人能回答，工作簿永远打不开。独立路径同时保证后台静默保存不会清掉用户待恢复的副本。
- **视图**：挂到主窗口 `contentView`，固定 `1100×1400` 布局尺寸、`setVisible(false)`；`claimActive:false` 不接管 `activeSheetsWebContents`（菜单/快捷键仍指向可见页签），不装 AI 面闆 handlers，因此不出现在页签清单。
- **就绪**：渲染层在 Univer 安装完目标工作簿后经 `workbook:agent-ready` 上报 `filePath`；主进程 `waitForAgentReady(contents, expectedPath, 15s)` 只有路径一致才放行。空白工作簿上报 `null` 不算就绪，避免写进空白工作簿。
- **串行**：每个 fileId 一条 promise 链；创建/describe/apply/销毁互斥。全局最多 2 个隐藏会话（LRU），空闲 3 分钟回收。
- **保存与回填**：复用 Registry 的 `editStates` + `onOfficeFileSaved` → 2s 去抖 → `performEditImport`（kind=spreadsheet → 广播 `format: xlsx`、`sourceKey: agent:sheets:edit:<fileId>`）。apply 返回前主动 drain 一次，必要时按工作副本强制 flush；用工作副本 sha256 变化证明真的落盘——有 `mutated` 但字节没变 → `save_failed`，不谎报成功。
- **失效**：catalog 当前 hash ≠ 会话基线（外部/其它版本改动）→ 关闭重建，不覆盖。
- **双写者防护**：用户打开同一文件的可见视图时（`registry.open`）先 dispose 隐藏会话；隐藏会话存在时 `teardownIfIdle()` 不会停 sidecar / 清 active 指针。
- **销毁**：`teardownSheetsRenderer(contents)`（丢弃就绪状态 + 清该渲染器的崩溃恢复副本，不弹对话框）→ `removeChildView` → `contents.close({waitForBeforeUnload:false})`；绝不走 `requestSheetsClose`。
- **防护**：CFB 魔数（加密 xlsx / 旧版 .xls）拒绝；后台只支持 `.xlsx/.xlsm`（旧版 `.xls` 先另存）；单文件上限 100MB；应用退出时硬清理。

## 4. 工作簿工具链（sheets_agent_edit 的 calls）

- 渲染层：`apps/desktop/vendor/genoffice/apps/sheets/src/renderer/ai/{tools,guides}.ts`、`renderer/plan-operations.ts`、`domain/workbook-dsl.ts`。
- 读工具（11）：`get_workbook_context` / `read_range` / `read_cells` / `read_formats` / `read_sheet_features` / `find_cells` / `aggregate_range` / `select_range` / `trace_precedents` / `trace_dependents` / `load_guide`。
- 写路径（唯一）：`propose_operations({ operations, summary })`。和手工路径共用同一套 validation / 预览 / 并发保护 / 撤销 / 保存；auto-apply 后渲染层静默保存（drain edit journal）→ 宿主 fileSaved hook 触发版本回填。
- DSL 域：内容写入（set_cell/set_formula/set_range/fill_range/copy_range/convert_to_values/clear_range/find_replace/text_to_columns）、格式（format_range 全部字段，含数字格式/边框/对齐）、布局（多关键字排序/合并/行列宽高/隐藏/冻结/页面设置/分级显示 outline.*）、结构（行列/工作表增删改移/保护/删除重复项）、表对象、透视表、图表/形状/图片/迷你图、数据工具（超链接/AutoFilter 值筛选与自定义条件/条件格式/数据验证/名称/合并计算/批注）。
- 指南（guides）：writing / formatting / layout / structure / charts / data / financial-formatting / data-attribution / table / pivot / shape-image；`sheets_agent_read` 一次带回全部正文（宿主 agent 无每次 run 的编辑器会话状态，`load_guide` 在 host 通道里没有意义）。
- 限制：calls 1–50 条；结构类 op（含 remove_duplicates）不能与非结构 op 同批；普通批最多 2000 个展开单元格，范围级 op（fill_range/copy_range/convert_to_values/clear_range/find_replace/format_range）单条最多 20 万单元格；数据工具 op（remove_duplicates/text_to_columns/consolidate）使用独立的 2 万单元格预算。**本通道不支持 dry-run**（Excel 是渲染层即时 apply，与 Word 的 `word_agent_ops dryRun` 不同，工具描述里已明确要求模型不要传 dryRun）。

## 5. 读与发现

- `sheets_agent_read` 对任意已入库 `.xlsx` 返回工作表清单（sheetId/名称/数据范围）、当前选区、已知非空单元格、工具词汇表与全部指南；`roomId/workspaceId` 由网关透传，供后台会话回填版本链时保留 Room/工作区归属。
- `file_search`（gateway pi tool）：按文件名子串 + 扩展名 + 工作区搜索文件库，返回 `fileId` 与 `kind: excel`。用户只说「那份销售表」且文件没打开时，先搜索再编辑。
- 网关的 `sheets_agent_*` 目标解析改为**元数据校验**（不读整份 xlsx 字节），去掉了网关侧 25MB 单次编辑上限；大文件由桌面侧 100MB 上限与 15s 打开超时保护。
- 可见只读实例：`sheets_agent_read` 可读（渲染层 describe 不再因只读模式拒绝），`sheets_agent_edit` 返回 `not_editable`，不拿隐藏工作簿顶替用户眼前那份。

## 6. 错误模型

| 场景 | 返回 | 行为 |
|---|---|---|
| 未打开 / UI 隐藏 / 没有页签，catalog 有文件 | 正常 | 后台隐藏工作簿编辑，版本 +1，不弹页签 |
| 可见可编辑实例 | 正常 | 活会话（实时重绘 + 静默保存） |
| 可见只读实例 | 读正常 / 写 `not_editable` | 不绕过用户选择 |
| 活实例有未保存修改 | `unsaved` | 提示先保存再改 |
| 文件不存在/已删除 | `not_found` | 不创建会话 |
| 不是 `.xlsx/.xlsm`（含旧版 `.xls`） | `not_xlsx` | 明确报错，建议先另存为 `.xlsx` |
| 加密 xlsx（CFB） | `encrypted` | 提示手动打开输入密码 |
| 损坏 / 15s 未就绪 | `open_failed` | 不写空白工作簿 |
| 外部版本改动 | — | catalog hash 变化 → 重建会话，不覆盖 |
| 静默保存被拒（字节未变） | `save_failed` | 不谎报成功，保留会话可重试 |
| 已落盘但版本回填失败 | 结果照返 + `error` | 明确告知版本未回填 |
| 超过 100MB | `too_large` | 明确拒绝 |

## 7. 与 Word 的差异

| 维度 | Word | Excel |
|---|---|---|
| 结构化操作 | 独立 `word_agent_ops`（58 op / 9 域，支持 `dryRun`） | 一个写入口 `propose_operations`（op 在 `sheets_agent_edit` 的 calls 内，即时 apply，无 dry-run） |
| 操作区隐藏 | 已上线「干净画布」（chrome-hidden + 恢复胶囊） | 未做：内嵌视图仍显示 Ribbon；agent 能力不依赖它，隐藏 sheets 操作区是后续 UI 项 |
| 读工具 | 块级 read_blocks / 文档状态 | 区域/格式/特性/搜索/统计/公式审计 |
| 版本回填 | 同一套 editStates → importAgentGeneratedFile | 同一套（kind=spreadsheet → xlsx 广播） |
| headless 身份 | 隐藏 docs 视图 + `docs:agent-ready` | 隐藏 sheets 视图 + `workbook:agent-ready` + agent 专用工作副本 |

## 8. 已知边界

- 旧版 `.xls` 后台不可编辑（CFB 魔数与加密 xlsx 无法区分）；先另存为 `.xlsx`。
- 系统剪贴板、拖拽手势、视图状态（缩放/分屏/网格线）、工作簿级保护、允许编辑区域、宏/VBA、外部数据连接不在本通道；对照见 `docs/xlsx-agent-operation-coverage.zh-CN.md`。
- 手绘/像素级图片编辑、图表高级元素（误差线/趋势线）引擎未暴露，返回清晰错误。
- 后台会话默认不弹页签；用户想边看边改时自行打开文件（打开时隐藏会话会先排空并关闭，避免双写者）。
- 极端情况下应用被强杀、隐藏会话留下恢复副本：下次后台打开使用独立 `agent-` 工作副本路径，不受影响；可见视图的恢复副本仍按原逻辑提示用户。

### 4.1 Batch 1 新增能力（2026-10-31）

在原 55 个 op 之上分三轮补齐 13 个 op，DSL 共 **68 个 op**：

| 能力 | op | 说明 |
|---|---|---|
| 多关键字排序 | `sort_range.keys`（1–3 键，兼容旧 `byColumn`+`order`） | 稳定、逐键比较；含公式区域仍明确拒绝 |
| 自定义筛选 | `set_filter_criteria.conditions`（1–2 条）+ `and` | 与 UI AdvancedFilterDialog 同一 `applyFilterCriteria` 实现 |
| 删除重复项 | `remove_duplicates` | 结构类（独立成批）；整行删除；保留首次出现；≤2 万单元格；先读区域再规划 |
| 分列 | `text_to_columns` | 单列向右/单行向下；`delimiter:null` = 空白；`collapseConsecutive`/`clearSource`；≤2 万 |
| 合并计算 | `consolidate` | sum/count/average/max/min + 1–20 个同形引用；生成跨表活公式 |
| 分级显示 | `outline.group/ungroup/hideDetail/showDetail` | rows/cols；与 Ribbon 同一 journal（`set-rows-outline`/`set-cols-outline`）；仅导入 xlsx |
| 按所选创建名称 | `create_names_from_selection` | top/left/bottom/right；绝对引用；名称净化与重复编号 |

实现方式沿用「渲染层唯一事实源」：schema + 展开/执行都在 `src/domain/workbook-dsl.ts` / `outline-ops.ts` / `App.tsx` 执行层，网关与桌面端无需新增工具；`sheets_agent_read` 的 guides 会把这些 op 的字段一并下发给模型。公式求值、快速填充、分类汇总等仍在 §「已知边界」的待办清单（见覆盖清单 §5.2）。

### 4.2 Batch 2 新增能力（文件级设置与格式扩展，2026-10-31）

| 能力 | op / 扩展 | 说明 |
|---|---|---|
| 边框线型/粗细 | `format_range.border.style` | 13 种 OOXML 线型（thin/medium/thick/dashed/dotted/double/hair/dashDot/…）；不传保持旧 thin 行为 |
| 单元格锁定/隐藏 | `format_range.locked` / `hidden` | 元数据（xf protection），配合 `protect_sheet` 生效；`null` 恢复默认；≤2 万单元格、先校验再落格式 |
| 仅清除格式 | `clear_formats` | 单条 op（展开为一个全清 `format_range`），保留值与公式；≤2 万 |
| 主题 | `set_theme {theme?, colors?, fonts?}` | 内置主题/配色/字体预设 id（见 formatting 指南）；实时重着色，保存后图表/条件格式配色跟进；需要含 theme part 的 xlsx |
| 保护工作簿 | `protect_workbook {protected}` | 仅结构锁、无密码；带密码文件双向拒绝；与工作表保护独立 |
| 允许编辑区域 | `allow_edit_ranges {sheetId, ranges[]}` | 整体替换、`[]` 清空；带密码的既有区域拒绝改写；导入 xlsx 必需 |

### 4.3 Batch 3 新增能力（数据汇总与图表进阶，2026-10-31）

| 能力 | op / 扩展 | 说明 |
|---|---|---|
| 分类汇总 | `subtotal {range, groupColumn, valueColumn, function}` | 按 groupColumn 的连续相同值分组；11 种 SUBTOTAL 函数（sum/average/count/counta/max/min/product/stdev/stdevp/var/varp）；组小计行 + 总计行；结构类独立成批；≤200 组；仅导入 xlsx，需先 read_range |
| 图表逐点配色 | `edit_chart.pointColors` | series→point→#hex，饼图/圆环图逐切片配色 |
| 图表数据标签 | `edit_chart.dataLabelPosition` / `dataLabelFormat` | 标签位置（center/inside-end/outside-end）与数字格式；设置后自动开启数值标签 |
| 图表网格线 / 数值轴 | `edit_chart.gridlines` / `valueAxis` | 数值轴主网格线开关；min/max（null 恢复自动）；轴类图表专用 |

## 9. 验证

- GenOffice sheets：`npm run typecheck -w @genoffice/sheets`；`npm run build -w @genoffice/sheets`（embed 构建，`out/main/embed.js` 含 `waitForAgentReady` / `teardownSheetsRenderer`，main/preload 含 `workbook:agent-ready`）；全量 `npx vitest run` 1938/1939 通过（唯一失败是依赖本机 LibreOffice 的 `pivot-roundtrip.e2e`，环境问题）；Batch 1/2/3 专项测试 `agent-ops-batch1`（42 例）、`agent-ops-batch2`（25 例）、`agent-ops-batch3`（31 例）全过。
- Desktop：`tsc --noEmit` 通过；`office-agent-sheet-session.test.ts`（10 例：隐藏视图参数/就绪/版本回填/指纹重建/就绪超时/加密/not_xlsx/保存失败/串行/disposeAll）、`office-preview-registry.test.ts`（含 4 例 headless Excel 与 sidecar 存活）、Word 会话与 office 既有测试无回归。
- Gateway：`sheets-agent-tools.test.ts`（14 例：元数据通道/roomId+workspaceId 透传/类型校验/多调用顺序/版本与 error 透传/无 dry-run/描述契约）、`office-bridge-client.test.ts`、`word-agent-ops.test.ts`；`packages/agent-runtime-pi` 的 `active-file-context.test.ts`（10 例）。
- Runtime：`node scripts/prepare-genoffice-runtime.mjs` 重建后，`build/genoffice-runtime/sheets/main/embed.js` 导出新增 API，renderer bundle 含 `workbook:agent-ready`。
- 手动：`xlsx-agent-test-prompts.md` 第八组（headless）、第十一组（Batch 1 新 op）与全组回归。