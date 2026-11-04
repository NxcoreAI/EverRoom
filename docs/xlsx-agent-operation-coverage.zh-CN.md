# Excel 操作区 → Agent 操作覆盖清单（逐入口审计）

> 目的：回答「Excel 操作面板里的每个入口，agent 都能做吗」。本文按 GenOffice Sheets 的实际 Ribbon 代码
> （`apps/desktop/vendor/genoffice/apps/sheets/src/renderer/ExcelShell.tsx`、`ribbon-actions.ts` 与各对话框）
> 逐个入口审计，不按「应该有什么」推断。
> 审计日期：2026-10-31。相关：`docs/xlsx-agent-editing-implementation.zh-CN.md`、`xlsx-agent-test-prompts.md`

图例：
- ✅ **已覆盖**：agent 与 UI 走同一份执行层实现，效果一致。
- ◐ **部分覆盖**：能达成主要结果，但有字段/范围/交互上的边界（下文写明）。
- ✗ **内容级缺口**：会产生文件内容/结构/设置变化，但 agent 目前没有通道（**可补齐**，见 §5）。
- — **非目标**：视图/系统剪贴板/宿主窗口/导航类，不改变文件内容；与 Word 覆盖清单的口径一致。

> 计数口径：按「功能入口」去重（颜色/样式/图表类型的每个色板格子算同一个入口）。场景：Home / Insert /
> Page Layout / Formulas / Data / Review / View / 上下文 Chart Design、Table Design / 工作表标签菜单 / 状态栏。
> 共 **135 个功能入口**：✅ 74、◐ 18、✗ 27（去重后约 **25 项能力缺口**）、— 16。
> **Batch 1–3 已补齐**（2026-10-31）：多关键字排序、自定义筛选、删除重复项、分列、合并计算、分级显示、按所选内容创建名称；边框线型、单元格锁定/隐藏、仅清除格式、主题、保护工作簿、允许编辑区域；分类汇总 + 图表配色/标签位置与格式/网格线/数值轴范围（新增 13 个 op，DSL 共 68 个 op）。

## 1. 结论速览

- **不是所有入口都能由 agent 完成。** 文件内容类的核心链路（内容、公式、格式、结构、数据验证/条件格式/筛选、
  表格/透视表/图表/图片/形状/迷你图/批注/页面设置/工作表管理/保护工作表）已经覆盖。
- 还有 **27 个入口行（去重约 25 项能力）没有 agent 通道**，主要集中在：快速填充、模拟分析/预测、图表进阶
  （切换行列/快速布局/图表样式/误差线/趋势线/图表区格式）、表格样式与尺寸修改、标签颜色、图标/公式图片/
  数据透视图/切片器等。
- 三轮补齐已完成：Batch 1（排序/筛选/去重/分列/合并计算/分级显示/按所选建名称）、Batch 2（边框线型、单元格保护、
  仅清格式、主题、保护工作簿、允许编辑区域）、Batch 3（分类汇总、图表点色/标签位置与格式/网格线/数值轴范围）——
  这些入口现在与 UI 同一执行层、同一结果。
- 另有 **16 个入口属于非目标**（剪切复制粘贴、格式刷、视图/缩放/窗口、备注导航、移去箭头、监视窗口、
  导入数据/刷新全部等）——和 Word 覆盖清单里「视图/剪贴板/宿主能力不由 agent 做」是同一口径。

## 2. Home（开始）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 1 | 剪切 / 复制 / 粘贴 / 粘贴选项 / 选择性粘贴 | — | 系统剪贴板非目标；语义等价：`copy_range`、`set_range`、`convert_to_values`、`read_formats`+`format_range` |
| 2 | 格式刷 | ◐ | 无「一键沿用格式」op；可 `read_formats` 读源格式再 `format_range` 写给目标 |
| 3 | 字体 / 字号 / 增大 / 减小 | ✅ | `format_range.fontFamily/fontSize` |
| 4 | 加粗 / 斜体 / 下划线 / 双下划线 / 删除线 | ✅ | `format_range.bold/italic/underline/strikethrough`（双下划线按单下划线处理） |
| 5 | 字体颜色 / 突出显示颜色 | ✅ | `format_range.fontColor/fillColor` |
| 6 | 边框 / 边框线型 / 边框颜色 / 绘制边框 | ✅ | `format_range.border {type, color?, style?}`（13 种 OOXML 线型）；「绘制边框」鼠标手势属视图交互，非目标 |
| 7 | 填充颜色 | ✅ | `format_range.fillColor` |
| 8 | 水平对齐 / 垂直对齐 | ✅ | `format_range.horizontalAlign/verticalAlign` |
| 9 | 自动换行 | ✅ | `format_range.wrapText` |
| 10 | 合并后居中 / 合并单元格 / 跨列合并 / 取消合并 | ✅ | `merge_cells` + `format_range` 对齐；跨列合并由多行 `merge_cells` 等价实现 |
| 11 | 增加缩进 / 减少缩进 | ✅ | `format_range.indent` |
| 12 | 文字方向 / 旋转 | ✅ | `format_range.textRotation`（-90..90 或 vertical） |
| 13 | 数字格式下拉（常规/数值/货币/会计/日期/时间/百分比/分数/科学记数/文本） | ✅ | `format_range.numberFormat`（任意 Excel 格式串；货币需 locale 锁定） |
| 14 | 增加小数位 / 减少小数位 | ✅ | 重新下发 `numberFormat`（agent 需自行算出目标格式串） |
| 15 | 单元格样式库（好/差/适中/标题/主题样式…） | ◐ | 无样式对象 op；用 `format_range` 组合复刻，无法引用文件里既有的命名单元格样式 |
| 16 | 条件格式（突出显示/项目选取/数据条/色阶/图标集/新建规则/清除/管理） | ✅ | `add_conditional_format`（number/text/blank/duplicate/top10/formula/colorScale/dataBar/iconSet）、`clear_conditional_formats`；现有规则用 `read_sheet_features` 读 |
| 17 | 套用表格格式 | ✅ | `add_table`（`style` 内置表格样式 + `bandedRows`） |
| 18 | 格式单元格对话框（数字/对齐/字体/边框/填充/保护 6 个页签） | ✅ | 6 个页签均覆盖：`format_range` 的字体/数字/对齐/边框/填充字段 + `locked`/`hidden` 保护标记（配合 `protect_sheet` 生效） |
| 19 | 插入行 / 删除行 | ✅ | `insert_rows` / `delete_rows` |
| 20 | 插入列 / 删除列 | ✅ | `insert_cols` / `delete_cols` |
| 21 | 行高 / 列宽 | ✅ | `set_row_height` / `set_col_width` |
| 22 | 填充（向下 / 向右） | ✅ | `fill_range`（公式相对引用自动平移） |
| 23 | 清除（全部 / 格式 / 内容） | ✅ | `clear_range`（内容/全部）+ `clear_formats`（仅格式，单条 op，保留值与公式） |
| 24 | 查找 | ✅ | `find_cells` |
| 25 | 替换 | ✅ | `find_replace`（文本单元格；支持大小写/整格匹配） |
| 26 | 定位 | ◐ | 地址定位用 `select_range`；「定位条件」（常量/公式/空值/可见单元格…）无对应 op |
| 27 | 排序（升序 / 降序） | ✅ | `sort_range`（单关键字、稳定排序、表头感知、公式区域明确拒绝） |
| 28 | 自定义排序（多关键字 / 排序选项 / 按颜色） | ✅ | `sort_range.keys`（1–3 个关键字，稳定多关键字排序）；按颜色排序仍属视图/格式类，未覆盖 |
| 29 | 筛选开关 | ✅ | `set_filter` |
| 30 | 按值筛选 | ✅ | `set_filter_criteria`（复选框式；values:null 清除） |
| 31 | 重新应用筛选 | ◐ | 改条件重下发即可；无单独「reapply」动作 |
| 32 | 高级筛选 / 自定义筛选（一个字段 2 个条件 + AND/OR） | ✅ | `set_filter_criteria.conditions`（1–2 个条件 + `and`），与 UI AdvancedFilterDialog 同一实现 |
| 33 | 删除重复项 | ✅ | `remove_duplicates`（整行去重、保留首次出现、≤2 万单元格；结构类，需独立成批） |
| 34 | 快速填充（Flash Fill） | ✗ | 无 op；需按样例推断规律后写公式/值 |
| 35 | 数据验证 | ✅ | `set_data_validation`（list/listRef/numberBetween/dateBetween/…/checkbox/formula，`validation:null` 清除） |
| 36 | 分列（按分隔符） | ✅ | `text_to_columns`（逗号/自定义分隔符/空白；destination/collapseConsecutive/clearSource；≤2 万） |
| 37 | 合并计算（Consolidate） | ✅ | `consolidate`（sum/count/average/max/min + 1–20 个同形引用，生成跨表活公式） |
| 38 | 分类汇总（Subtotal） | ✅ | `subtotal {range, groupColumn, valueColumn, function}`（11 种 SUBTOTAL 函数；组小计行 + 总计行；结构类必须独立成批；≤200 组） |
| 39 | 分级显示（组合 / 取消组合 / 隐藏明细 / 显示明细） | ✅ | `outline.group/ungroup/hideDetail/showDetail`（rows/cols；仅导入 xlsx，与 Data→分级显示同一 journal） |
| 40 | 单变量求解 / 模拟分析 | ✗ | 无 op（UI 为交互式求解器） |
| 41 | 数据透视表（新建 / 刷新 / 编辑字段与布局） | ◐ | 新建 `add_pivot` ✅、刷新 `refresh_pivot` ✅；**修改已有透视表字段/布局无 op** |
| 42 | 工作簿统计 | ◐ | 无单条统计动作；可用 `get_workbook_context` + `aggregate_range` 算出来 |
| 43 | 错误检查 | ◐ | 无「错误检查」入口；可用 `read_range`/公式审计工具近似 |
| 44 | 计算选项（自动/手动）、开始计算 / 计算工作表 | ✗ | 无计算模式 op；写入公式后执行层会自动重算（低价值缺口） |
| 45 | 批注 / 备注（新建 / 删除） | ✅ | `set_note`（`text:null` 删除，写入 Excel legacy comment；现状用 `read_sheet_features`） |
| 46 | 备注导航（上一条/下一条/显示/隐藏） | — | 视图导航 |
| 47 | 拼写检查 / 同义词库 / 翻译 | ✗ | 无引擎校对/翻译通道（内嵌版也没有 AI provider） |
| 48 | 保护工作表 | ✅ | `protect_sheet {protected:true|false}`（无密码；文件原有密码保护无法解除） |
| 49 | 保护工作簿 | ✅ | `protect_workbook {protected}`（仅结构锁、无密码；带密码的文件双向拒绝；与 `protect_sheet` 相互独立） |
| 50 | 允许编辑区域 | ✅ | `allow_edit_ranges {sheetId, ranges[]}`（整体替换，`[]` 清空；带密码的既有区域拒绝改写） |
| 51 | 工作表视图（普通/分页预览/页面布局） | — | 视图 |
| 52 | 显示（网格线/标题/公式/编辑栏/交叉高亮） | — | 视图 |
| 53 | 缩放（放大/缩小/重置/缩放到选定/百分比） | — | 视图 |
| 54 | 窗口（新建/拆分/全部重排/切换） | — | 宿主窗口 |
| 55 | 冻结窗格（冻结/首行/首列/取消） | ✅ | `set_freeze {rows, columns}` |

## 3. Insert（插入）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 56 | 数据透视表 / 推荐数据透视表 | ◐ | `add_pivot`；无「推荐」逻辑（agent 自己按数据形状选字段） |
| 57 | 表格 | ✅ | `add_table`（首行表头、内置样式、镶边行、命名） |
| 58 | 图片 | ✅ | `add_image {path|https url}`；只收本地绝对路径或公网 URL（≤20MB），不收 dataURL/base64 |
| 59 | 形状 / 文本框 | ◐ | `add_shape` 可插（任意 prstGeom + textbox，`fillColor`/`text`/`anchorCell`）；`edit_shape` 只能改 text/fillColor/anchor，无轮廓/旋转/大小/效果；**文件自带绘图只读** |
| 60 | 图标（内置图标库） | ✗ | 内置 gallery 栅格化成 PNG 走图片管线；agent 没有图标目录入口（可用外部图片 `add_image` 替代） |
| 61 | 截图 | ✗ | 宿主截屏交互；agent 可插用户给的图片文件 |
| 62 | 复选框 | ✅ | `set_data_validation {kind:"checkbox"}` |
| 63 | 推荐图表 | ◐ | 无「推荐」；agent 根据数据自行选类型（结果等价） |
| 64 | 图表（柱/条/折线/面积/饼/散点/雷达/圆环/组合） | ✅ | `add_chart` |
| 65 | 数据透视图 | ✗ | 无 op |
| 66 | 迷你图（折线/柱/盈亏） | ✅ | `add_sparkline` 或 `set_formula` 写 `=SPARKLINE(...)` |
| 67 | 切片器 | ✗ | 交互式对象，引擎/DSL 未暴露 |
| 68 | 日程表（Timeline） | ✗ | 同上 |
| 69 | 链接 | ✅ | `set_hyperlink`（外链/工作簿内引用，`null` 移除） |
| 70 | 文本框 | ✅ | `add_shape {shapeType:"textbox"}` |
| 71 | 页眉页脚 | ✅ | `set_page_setup.header/footer`（左/中/右，`&P/&N/&D/&A` 代码） |
| 72 | 公式（插入公式，图片化） | ✗ | UI 把公式栅格化为 PNG；agent 无 dataURL 图片通道，也没有公式生成入口 |
| 73 | 符号 | ◐ | 无符号对话框；agent 直接把 Unicode 字符写进 `set_cell`/`set_range`（结果等价） |
| 74 | 批注 | ✅ | `set_note` |

## 4. Page Layout / Formulas / Data / Review / View / 上下文页签

### 4.1 Page Layout（页面布局）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 75 | 主题（主题 / 颜色 / 字体 / 效果） | ✅ | `set_theme {theme?, colors?, fonts?}`（内置预设 id，风格实时重着色、保存后图表/条件格式配色跟进） |
| 76 | 页边距（普通/宽/窄） | ✅ | `set_page_setup.margins` |
| 77 | 纸张方向 | ✅ | `set_page_setup.orientation` |
| 78 | 纸张大小 | ✅ | `set_page_setup.paperSize` |
| 79 | 打印区域（设置/清除） | ✅ | `set_page_setup.printArea` |
| 80 | 打印标题（首行/选择/清除） | ✅ | `set_page_setup.printTitles` |
| 81 | 分页符（插入/删除/重置） | ✅ | `set_page_setup.rowBreaks/colBreaks` |
| 82 | 缩放比例 / 调整为 N 页宽高 | ✅ | `set_page_setup.scale` 或 `fitToWidth/fitToHeight`（互斥） |
| 83 | 打印网格线 / 打印标题 | ✅ | `set_page_setup.printGridlines/printHeadings` |
| 84 | 工作表选项（查看网格线/查看标题） | — | 视图 |

### 4.2 Formulas（公式）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 85 | 插入函数 / 函数库 | ✅ | `set_formula` |
| 86 | 自动求和 | ✅ | `set_formula`（`=SUM(...)`） |
| 87 | 名称管理器 / 定义名称 / 用于公式 | ✅ | `add_defined_name` / `delete_defined_name` + `set_formula`；现状 `read_sheet_features` |
| 88 | 根据所选内容创建名称 | ✅ | `create_names_from_selection`（top/left/bottom/right；绝对引用、名称净化、重复自动编号） |
| 89 | 追踪引用单元格 / 追踪从属单元格 | ✅ | `trace_precedents` / `trace_dependents` |
| 90 | 移去箭头 | — | 视图 |
| 91 | 显示公式 | — | 视图 |
| 92 | 公式求值 | ✗ | 无 op（可 `read_range` 看结果，但没有逐段求值入口） |
| 93 | 监视窗口 | — | 视图 |
| 94 | 计算选项 / 开始计算 | ✗ | 同 #44 |

### 4.3 Data（数据）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 95 | 获取数据（导入 CSV / 全部刷新） | ✗ | 宿主/编辑器导入交互；本通道只编辑已入库 `.xlsx`（用户可先导入再让 agent 改） |
| 96 | 排序 / 筛选 | ✅ | 同 #27–#31 |
| 97 | 数据工具（分列/快速填充/删除重复项/数据验证/合并计算） | ◐ | 数据验证/分列/删除重复项/合并计算 ✅；仅「快速填充」仍缺 |
| 98 | 预测（预测工作表） | ✗ | 无 op（可用公式自行实现，但无一键预测） |
| 99 | 分级显示（组合/取消组合/隐藏明细/显示明细） | ✅ | 同 #39（`outline.*`） |
| 100 | 分类汇总 | ✅ | 同 #38（`subtotal`） |
| 101 | 模拟分析（单变量求解） | ✗ | 同 #40 |
| 102 | 数据透视表 / 刷新 | ◐ | 同 #41 |
| 103 | 切片器 / 日程表 | ✗ | 同 #67/#68 |

### 4.4 Review（审阅）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 104 | 拼写检查 / 语言 / 翻译 | ✗ | 同 #47 |
| 105 | 批注 / 备注 | ✅ | `set_note` |
| 106 | 保护工作表 | ✅ | `protect_sheet` |
| 107 | 保护工作簿 | ✗ | 同 #49 |
| 108 | 允许编辑区域 | ✗ | 同 #50 |
| 109 | 工作簿统计 | ◐ | 同 #42 |

### 4.5 View（视图）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 110 | 工作簿视图（普通/分页预览/页面布局） | — | 视图 |
| 111 | 显示项（网格线/标题/公式/编辑栏/交叉高亮） | — | 视图 |
| 112 | 缩放 | — | 视图 |
| 113 | 冻结窗格 | ✅ | `set_freeze` |
| 114 | 窗口（新建/拆分/全部重排/切换） | — | 宿主窗口 |

### 4.6 上下文页签 Chart Design（选中图表时）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 115 | 更改图表类型 | ✅ | `edit_chart.chartType` |
| 116 | 切换行/列 | ✗ | 无 op（`seriesData` 可重指范围，但不是等价的一键转置语义） |
| 117 | 选择数据 | ◐ | `edit_chart.seriesData` 可重指系列范围/改名，但无法增删系列、调换系列顺序 |
| 118 | 更改颜色（配色方案） | ✅ | `edit_chart.seriesColors`（按系列 index 指定颜色） |
| 119 | 快速布局（布局 1–4） | ✗ | 无布局模板 op |
| 120 | 图表样式（样式库） | ✗ | 无图表样式/主题样式 op |
| 121 | 添加图表元素：标题 / 轴标题 / 图例 / 数据标签 | ✅ | `edit_chart.title/axisTitles/legend/dataLabels` |
| 122 | 添加图表元素：网格线 / 趋势线 / 误差线 / 数据表 / 坐标轴 / 线条 | ◐ | 网格线（`edit_chart.gridlines`）与数值轴范围（`valueAxis`）✅、数据标签位置/格式 ✅；趋势线/误差线/数据表/线条仍缺（引擎未暴露） |
| 123 | 设置图表区格式（填充/边框/效果/文字） | ✗ | 无 op |
| 124 | 删除图表 | ✅ | `delete_visual` |
| 125 | 移动图表（新工作表 / 对象位置） | ✗ | 无 op |

### 4.7 上下文页签 Table Design（选中表格时）

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 126 | 表格样式 / 镶边行 / 首行 / 末行 / 汇总行 | ◐ | `add_table` 建表时可指定 `style`/`bandedRows`；**建后改样式、首末行/汇总行选项无 op** |
| 127 | 调整表格大小 | ✗ | 无 op |
| 128 | 转换为区域 | ◐ | `delete_table` 即“转普通区域”（保留值与格式，仅移除 Table 对象），但仅限本会话 `add_table` 建的表；文件自带表只读 |
| 129 | 表格行列增删（会话内新建的表） | ✅ | `add_table_row/column`、`delete_table_row/column`；**文件自带表不能改，需保存重开**（引擎边界） |

### 4.8 工作表标签菜单 / 状态栏

| # | 操作区入口 | 状态 | Agent 能力 / 边界 |
|---|---|---|---|
| 130 | 插入 / 删除 / 重命名 / 复制 / 移动 / 隐藏 / 取消隐藏工作表 | ✅ | `add_sheet` / `delete_sheet` / `rename_sheet` / `duplicate_sheet` / `move_sheet` / `set_sheet_hidden` |
| 131 | 标签颜色 | ✗ | 无 op（引擎 sheet 元数据有 `tabColor`，未暴露） |
| 132 | 保护工作表 | ✅ | `protect_sheet` |
| 133 | 全选工作表 / 成组编辑 | ✗ | 多表同改无 op（可逐表下发同一个 op 批次） |
| 134 | 查看代码 / 宏 | — | 非目标（无 VBA 通道） |
| 135 | 状态栏：缩放 / 计算模式 / 选区统计 | — | 视图；选区统计可用 `aggregate_range` 读取 |

## 5. 缺口与补齐进度

> 以下为「面板里有、agent 没有」且会产生文件内容/结构/设置差异的入口，按「是否值得且可落地」分批。

### 5.1 已补齐（Batch 1–3，2026-10-31）

| 缺口 | 新 op / 扩展 | 边界 |
|---|---|---|
| 自定义排序（多关键字） | `sort_range.keys`（1–3 键） | 按颜色排序不做（视图/格式类） |
| 高级/自定义筛选 | `set_filter_criteria.conditions` + `and` | 需已有 AutoFilter；值按显示文本比较 |
| 删除重复项 | `remove_duplicates` | 整行删除；≤2 万单元格；结构类必须独立成批；应用后不可逆（靠文件版本回退） |
| 分列 | `text_to_columns` | 单列向右/单行向下；源与输出各 ≤2 万；公式需有可读计算值 |
| 合并计算 | `consolidate` | 1–20 个同形引用；不带标签匹配模式；输出为活公式 |
| 分级显示 | `outline.group/ungroup/hideDetail/showDetail` | 仅导入 xlsx；与 Ribbon 同一 journal（group 本身不进撤销栈） |
| 根据所选创建名称 | `create_names_from_selection` | top/left/bottom/right；标签取存储值；名称自动净化/编号 |
| 边框线型 / 粗细 | `format_range.border.style`（13 种 OOXML 线型） | 绘制边框鼠标手势非目标 |
| 单元格锁定 / 隐藏 | `format_range.locked/hidden` | 仅元数据（配合 `protect_sheet` 生效）；≤2 万单元格 |
| 仅清除格式 | `clear_formats` | 保留值与公式；≤2 万单元格；恢复默认单元格保护 |
| 主题（主题/颜色/字体） | `set_theme {theme?, colors?, fonts?}` | 仅导入且含 theme part 的 xlsx；效果预设 id 见 formatting 指南 |
| 保护工作簿 | `protect_workbook {protected}` | 仅结构锁、无密码；带密码的文件双向拒绝 |
| 允许编辑区域 | `allow_edit_ranges {sheetId, ranges[]}` | 整体替换、`[]` 清空；带密码的既有区域拒绝改写 |
| 分类汇总 | `subtotal {range, groupColumn, valueColumn, function}` | 按连续相同值分组；11 种 SUBTOTAL 函数；组小计 + 总计；结构类独立成批；≤200 组 |
| 图表逐点配色 | `edit_chart.pointColors` | 饼图/圆环图逐切片配色（series→point→#hex） |
| 图表数据标签位置/格式 | `edit_chart.dataLabelPosition` / `dataLabelFormat` | 标签位置与数字格式；设置后自动开启数值标签 |
| 图表网格线与数值轴范围 | `edit_chart.gridlines` / `valueAxis` | 数值轴主网格线开关；min/max（null 恢复自动）；轴类图表 |

三轮补齐后 DSL 共 **68 个 op**（55 + 13）。

### 5.2 剩余缺口（27 个入口行 / 去重约 25 项能力）

**A. 数据/分析（6）**
1. 快速填充 `flash_fill`（agent 可读数据后自行推断写值，暂不单独立 op）
2. 单变量求解 / 模拟分析 `goal_seek`
3. 预测工作表 `forecast`
4. 获取数据 / 全部刷新（宿主导入能力，建议留在宿主入口）
5. 公式求值 `evaluate_formula`（只读；引擎能力待评估）
6. 计算选项 / 开始计算 `set_calc_mode`（低优先）

**B. 文件级设置（1）**
7. 工作表标签颜色 `set_sheet_tab_color`（保存链路未携带 tabColor，需要 sidecar 支持）

**C. 图表/对象进阶（8）**
8. 图表切换行/列 `edit_chart.switchRowColumn`
9. 快速布局 / 图表样式 `edit_chart.layout/style`
10. 图表系列增删/排序（`edit_chart.seriesData` 扩展）
11. 图表区格式（填充/边框/效果）
12. 图表元素：趋势线/误差线/数据表/线条（网格线、数值轴、标签位置/格式已覆盖）
13. 移动图表
14. 数据透视图 `add_pivot_chart` / 透视表字段与布局编辑 `edit_pivot`
15. 内置图标插入 `add_icon` + 公式图片 `add_equation`

**D. 其它（5）**
16. 定位条件 `select_special`
17. 全选工作表 / 成组编辑 `set_sheet_group`
18. 表格样式/首末行/汇总行/调整大小 `edit_table`（转区域已由 `delete_table` 覆盖会话内表）
19. 拼写检查 / 翻译（无引擎通道，保持非目标）
20. 备注导航 / 宏等宿主与视图能力（保持非目标）

### 5.3 明确不建议 agent 做

系统剪贴板/粘贴选项、截图、视图模式、缩放、窗口管理、备注导航、移去箭头、监视窗口、
切片器/日程表（交互对象）、宏/VBA——和 Word 覆盖清单的非目标口径一致。

## 6. 与 Word 覆盖清单的关系

- 两侧口径相同：**文件内容类尽量全覆盖；视图/系统剪贴板/宿主窗口不算 agent 职责。**
- Word 侧已把内容级入口补到 63 个 op / 9 域，因此覆盖清单里 ✅ 比例更高；Excel 侧的 DSL 在 Batch 3 后是 `propose_operations`
  的 68 个 op，剩余约 25 项能力完全补齐后可达同等覆盖率。
- 当前 Excel 的「隐藏工作簿 headless 通道」已和 Word 对齐（读写、版本回填、错误模型、file_search），
  缺口只剩**操作词汇**，不是通道能力。

## 7. 复现审计的方法

1. `ExcelShell.tsx`：`ribbonTabs = ['Home','Insert','Page Layout','Formulas','Data','Review','View']` +
   上下文 `Chart Design`；每个 `RibbonGroup` / `onCommand(...)` / `MenuSelect options` 是一个入口。
2. `ribbon-actions.ts`：命令分支决定该入口是否真正写文件/走 journal（视图类命令只改 renderer 状态）。
3. `domain/workbook-dsl.ts` 的 `workbookOperationSchema`（55 个 op）+ `renderer/ai/tools.ts`（12 个 AI 工具）
   是 agent 能力的唯一事实源。
4. 对话框（`FormatCellsDialog` / `SubtotalDialog` / `ConsolidateDialog` / `AdvancedFilterDialog` /
   `GoalSeekDialog` / `PivotDialog` / `HeaderFooterDialog` / `IconsDialog` / `EquationDialog` / `ScreenshotDialog` 等）
   按「是否产生文件变更」计入 ✅/◐/✗，纯视图对话框计 —。