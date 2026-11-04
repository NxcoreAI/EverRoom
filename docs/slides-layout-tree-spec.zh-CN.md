# 幻灯片布局语法（v2 唯一写入格式）

状态：权威正文 · 2026-10-29（weights 统一：父级优先、缺省从子节点 weight 推导；`fit:"shrink"` 编译期缩字 ≤15%、守场景下限；`focus` 不改图框比例，不能消除 `image_ar`；完整呈现图片不得改 `cover`）

本文件是布局语法与组件参考的权威来源。`scripts/render-layout-skills.mjs` 从这里生成 layouter 的基础技能 `SKILL.md`、设计指引 `design-guide.md` 与按展示用途拆分的组件参考 `components/*.md`；语法变更在本文件维护。任务目标、内容保真、设计与自审流程由 SYSTEM.md 负责。

写入格式为 **v2 页面**（`version: 2` + `composition` + `nodes`），`group` 使用原生 `children` 分区。

## 根

```json
{
  "version": 2,
  "role": "content",
  "composition": "editorial",
  "safeArea": "content",
  "grid": { "cols": 12, "rows": 8, "gutter": 24, "rowGutter": 16, "margin": 64 },
  "footer": { "left": "数据来源：…", "pageNumbers": true },
  "notes": "演讲备注",
  "nodes": []
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `version` | `2` | 必填。 |
| `role` | 照抄输入的 `role` | 内容语义标签，不改写。 |
| `composition` | `immersive / hero-data / editorial / swiss / poster / chapter` | 必填。由 Layouter 根据实际设计选择。 |
| `safeArea` | `content`（默认）/ `full` | 图片与色块用节点 `bleed` 出血。 |
| `grid` | `cols 1~12`、`rows 1~12`、`gutter 0~48`、`rowGutter 0~48`、`margin 0~96` | 可省略，用风格卡默认（12 列 × 8 行）。 |
| `footer` | `left? / center? / right?` 各 ≤120 字；`pageNumbers?`；`tone?` `text \| muted \| inverse` | 语法可省略，使用规则见 SYSTEM.md。仅显式写 `pageNumbers:true` 时网关填入页码；省略 footer 不生成页码与页脚线。`inverse` 适用于深色页且不绘制页脚线。 |
| `background` | 色号，≤9 字符（如 `"#0E0D0C"`） | 可省略，缺省用主题底色。 |
| `dark` | `true` | 整页深色口径。封面/收尾角色在风格卡 `darkCover` 下自动深色。 |
| `notes` | 字符串，≤2000 字 | 演讲备注；输入超过此容量时报告阻塞，避免引擎截断。 |
| `nodes` | 1~64 个页面级节点 | 含 group 子节点后总数 ≤64。 |

页面不写标题带；message 与标题都做成 text 节点。

## 节点通用

- 节点类型 11 种：`text / image / shape / stats / chart / table / component / icon / path / group / connector`。其它类型报错。
- 页面级节点必须写 `slot`：`{ "col": [c1, c2], "row": [r1, r2] }`。编号 1 起、闭区间；`c1 ≤ c2 ≤ cols`、`r1 ≤ r2 ≤ rows`。
- `bleed`：`true`、`"left" | "right" | "top" | "bottom" | "x" | "y" | "all"`，或这些值的数组。出血到画布边缘。
- `group` 子节点不写 `slot`、不写 `bleed`。
- 文字层级用 type token，颜色用 tone，字体用文档列出的语义枚举。仅本文明确列出的字段接受数值尺寸或色号，取值服从 styleTokens；其余字段不自造像素样式。
- 不写 emoji：引擎直接拒页。装饰图形用 `path`，图标用 `icon`。
- 页面预算（引擎硬限制，超了 validate 报）：元素总数 ≤48、图片 ≤8、路径 ≤4、单条文本 ≤2000 字符。

## text

```json
{
  "type": "text", "token": "h1", "text": "从 2.7 亿到 3.87 万亿元",
  "tone": "text", "align": "left", "valign": "top",
  "lineHeightPct": 110, "letterSpacing": 0,
  "slot": { "col": [1, 8], "row": [2, 3] }
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `token` | `display / hero / h1 / h2 / h3 / lead / body / label / kicker / caption` | 必填。字号由 token 定档。 |
| `text` | 字符串 ≤2000 字 | `text`、`runs`、`paragraphs` 三者至少一个。 |
| `runs` | `[{ text, token?, bold?, tone?, font?, letterSpacing? }]` | 行内混排。`font` 取 `heading / body / serif`。 |
| `paragraphs` | `[{ runs, align?, lineSpacingPct?, spaceBeforePt?, spaceAfterPt? }]` | 多段混排；`runs` 非空。 |
| `tone` | `text / muted / primary / accent / inverse / inverseMuted / surface / primarySoft / divider / chart1~chart6` | 缺省 `text`。`inverse` / `inverseMuted` 是深底亮字口径（深色页、压图、深色面板用，对应 `styleTokens.palette.onDarkText`）；其余 tone 通常是深色字。 |
| `align` | `left / center / right` | 缺省 `left`。 |
| `valign` | `top / middle / bottom` | 缺省 `top`。 |
| `letterSpacing` | -4~12 | 可省略。 |
| `lineHeightPct` | 60~160 | 缺省 110。 |
| `fit` | `none / shrink / ellipsis` | 缺省 `none` 原字号。`shrink`：溢出时按同一比例缩全部 run（保留字号比例与段落结构），最多缩小 15%，且不低于场景字号下限；已低于下限的 run 保持原字号。缩到下限仍放不下照常报 `overflow`。标题与正文同规则：缺口 ≤15% 且扩区不可行时可用它收口（缩字不删字，内容保真无损）；缺口更大必须扩区或换承载结构。 |
| `maxLines` | 1~4 | 配合 `ellipsis` 截断。 |
| `direction` | `horizontal`（默认）/ `vertical` | `vertical` 是中文单字竖排。 |

## image

```json
{
  "type": "image", "url": "everroom-material://…", "fit": "cover",
  "focus": { "x": 38, "y": 55 }, "caption": "蛇口 · 1979",
  "slot": { "col": [8, 12], "row": [2, 8] }, "bleed": ["right"]
}
```

- `url` 必填，≤500 字符，只接受 `http(s)://` 直链或 `everroom-material://` 素材引用。
- `fit`：`cover`（默认，裁切填满）或 `contain`（完整呈现，可能留空带）。两者都不变形；框比例尽量贴近素材。要求完整呈现的图片不得为通过 `image_ar` 检查改成 `cover`。
- **压图文字规则（overlap 检查）**：文字与图片同区叠压时，文字须是浅色口径——`inverse` / `inverseMuted`（深底亮字），或放进 overlay 分组有意压放；默认 `text` / `muted` / `primary` 等深色字压图会报 `overlap`。实际色号以输入 `styleTokens.palette` 为准（`onDarkText` 即压图文字色）。
- `focus`：`{ x?, y? }`（0~100）把 cover 裁切对准画面主体。只改变裁切位置，不改变图框比例；不能用它消除 `image_ar` 比例检查。
- `caption` ≤40 字，只留一处。
- `grayscale / duotone / radius`：`true` 才生效；`mask` 取 `circle / rounded`。
- `scrim`：`{ color?, opacity? }`（`color` 是色号，`opacity` 0~1，缺省 0.55），给压图文字留可读底。

## icon / path

```json
{ "type": "icon", "name": "bolt", "tone": "primary",
  "slot": { "col": [1, 1], "row": [4, 4] } }
{ "type": "path", "d": "M0 0 H160", "stroke": { "color": "tone:primary", "widthPt": 2 },
  "slot": { "col": [1, 4], "row": [3, 3] } }
```

- `icon.name` 必须来自引擎图标集：`check-circle`、`check`、`bolt`、`shield-check`、`users`、`chart-bar`、`chart-pie`、`globe-alt`、`rocket-launch`、`light-bulb`、`map-pin`、`clock`、`arrow-trending-up`、`sparkles` 等。名字不在集合内报错。
- `icon.tone` 与 text 的 `tone` 同源。
- `path.d` 只写简单 SVG path（4~3000 字符），不写文字。
- `path.fill` / `path.stroke.color` 可写语义色（如 `tone:primary`）或色号；`stroke.widthPt` 0.25~12。

## table

```json
{
  "type": "table", "header": true, "style": "banded", "fontSize": 10,
  "colWidths": [1.6, 1, 1, 1.6],
  "rows": [
    ["厂商", "构型 / 路线", "单价", "市场情况"],
    ["Jetson ONE", "多旋翼", "约 12 万美元", "订单排到 2027 年"],
    ["Opener Helix", "复合翼", "19–26 万美元", "2025 年 5 月发货"]
  ],
  "slot": { "col": [1, 8], "row": [4, 8] }
}
```

- `rows` 2~12 行、每行 1~8 列；各行总列宽（含 `span`）必须一致，否则报错。
- 首行默认表头（primary 底反白）；`header: false` 时按普通行。
- 单元格是字符串，或对象 `{ "text", "bold"?, "tone"?, "fill"?, "align"?, "span"? }`；单元格 ≤120 字。
- `style` 三选一：`banded`（蓝底表头 + 隔行，默认）、`outline`（白底 + 主色边框）、`minimal`（无底色，仅横线）。
- `colWidths` 是列宽比例；按内容分配。`fontSize` 可选，8~20，缺省继承引擎字号。表格行高按单元格折行预算，超框在校验期报 `overflow`（附实测 `requiredHeight`/`availableHeight`）；缺口 ≤15% 时 `fontSize` 降 1pt（下限 8）通常可收口——缩字号不删数据，内容保真无损。
- 结构化表格 block 使用 `table`，保留表头、行列顺序和全部单元格。

## stats / chart / shape

```json
{ "type": "stats", "items": [{ "value": "2.83", "unit": "万亿元", "label": "2020 年 GDP" }],
  "slot": { "col": [9, 12], "row": [2, 8] } }
{ "type": "chart", "kind": "bar", "categories": ["2020 年", "2025 年"],
  "series": [{ "name": "GDP", "values": [2.83, 3.87] }], "dataLabels": true,
  "slot": { "col": [9, 12], "row": [2, 6] } }
{ "type": "shape", "shape": "rect", "fill": "#0e0d0c66",
  "slot": { "col": [1, 12], "row": [1, 8] }, "bleed": true }
```

- `stats.items` 2~4 条；每条 `value` ≤14 字、`unit` ≤8 字、`label` ≤20 字。这是 `stats` 节点（页面级）的口径；`stats` 组件的上限见「组件参数」表。
- `chart.kind`：`bar / barStacked / line / area / waterfall / pie / doughnut / scatter / comboBarLine`。
- `chart.categories` 2~24 个；`series` 1~6 组，每组 `values` 与 `categories` 等长且都是数字。
- `chart` 可选 `colors`（≤6 个色）、`pointColors`、`dataLabels`、`legend`、`gridlines`。
- `shape.shape`：`rect / roundRect / ellipse / line / lineArrow`。`fill`、`gradient`、`stroke` 至少给一个。
- `shape.fill` 写色号（≤9 字符，如 `"#0e0d0c66"`）。`gradient` 需要 2~3 个 stop：`{ stops: [{ pos, color }], angle }`。
- chart 只在真正支撑 message 时用；数据页优先 hero 数字 + stats。

## connector（连线 / 箭头）

```json
{ "type": "connector", "from": { "x": 18, "y": 34 }, "to": { "x": 72, "y": 62 },
  "tone": "primary", "widthPt": 1.5, "arrow": true }
```

- 坐标是画布百分比 0~100：`from` / `to` 都是 `{ x, y }`。
- `tone` 与 text 的 `tone` 同源，缺省用主题主色；`widthPt` 0.5~6，缺省 1.5。
- `arrow: false` 只画线，缺省带箭头。
- **只允许出现在页面级**。`group` 内不允许 `connector`：group 子节点只放内容区块。
- 用于时间轴节点、架构图连线、页级元素之间的关系。不要用它替代正文分隔线。

## group（v2 原生分区）

slot 栅格表达不了的自由版式，用 `group` 把一块 slot 切成 v2 原生子节点：

```json
{
  "type": "group",
  "slot": { "col": [1, 6], "row": [2, 7] },
  "direction": "row",
  "weights": [1.4, 1],
  "gapScale": 1.2,
  "pad": 16,
  "panel": "tint",
  "children": [
    { "type": "text", "token": "h3", "text": "左栏", "weight": 1 },
    { "type": "component", "name": "pointList", "weight": 2,
      "items": [{ "label": "要点", "body": "说明" }, { "label": "要点二", "body": "说明" }] }
  ]
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `direction` | `row / column / overlay` | 必填。主轴方向。 |
| `weights` | 正数数组，0.1~20，个数 = children 数 | 仅 row/column。显式父级 `weights` 优先；未提供时按各子节点 `weight` 推导（缺省 1）。`row` 的 weights 沿主轴分配宽度，`column` 的分配高度；加大一个子节点的权重会压缩兄弟节点。悬殊比例用 1.6/1、2/1 这一档。 |
| `gapScale` | 0~4 | 缝隙 = 主题 gutter（row）/ rowGutter（column）× gapScale。overlay 不写。 |
| `pad` | 0~48 | 帧内边距（px）。先扣内边距再分区。 |
| `justify` | `start / center / end` | 仅 column。子区域划分不变，内容未铺满时整组按 justify 平移。 |
| `panel` | `surface / tint / dark / outline` | 底板垫在所有子节点下面（先铺板再排内容）：卡面 / 主色浅档 / 墨面 / 细线框。用 `dark` 板时子节点文字用 `inverse`、`inverseMuted` 保对比。 |
| `children` | 1~12 个 v2 节点 | 子节点不写 `slot`、不写 `bleed`。 |

- 子节点写 `weight`（row/column）或 `place`（overlay），不写 `slot`、不写 `bleed`。
- overlay 的 `place` 是父区域百分比 `{ x, y, w, h }`：0~100，`x+w ≤ 100`、`y+h ≤ 100`。row/column 分组不写 `place`。
- overlay 分组不写 `weights`、不写 `gapScale`：子节点间距用 `place` 自己留出。
- 子节点类型与页面级完全相同：`text / image / shape / stats / chart / table / component / icon / path / group`。group 内不允许 `connector`。
- 嵌套深度 ≤3 层（`group` 套 `group` 套 `group` 为止）。第 4 层报错。
- group 子节点使用与页面级相同的节点字段和主题规则。
- slot 适合页面级分区；group 适合局部比例分配、叠放与嵌套结构。按表达需要选择。
- `tree` 已废弃：收到即报错「group 不再接受 v1 树：把 tree 拆成 children 的 v2 节点，用 weight 表达比例」。

## component（组件节点）

组件是参数化积木：只给文案与条目，内部结构与绘制由引擎确定性生成。参数错误报归一缺陷，装不下报叶子缺陷。

```json
{ "type": "component", "name": "timeline",
  "style": { "surface": "none", "separator": "line" },
  "items": [ { "label": "2026", "text": "品类验证" },
             { "label": "2027", "text": "渠道扩张" },
             { "label": "2028", "text": "品牌溢价" } ],
  "slot": { "col": [1, 6], "row": [4, 8] } }
```

- `name` 必须来自组件清单。使用组件时先查组件参考中的参数与容量，未知名字或字段会报错。
- 组件只读 `frame / theme / skin`：不含客户名、品牌色或参考页文案。样式由 deck 的 `styleTokens` 决定。
- 字段名照抄本文档；未知字段报错。
- `style` 可选，使用语义枚举，缺省继承 `styleTokens.componentDefaults`。
- 存在语义匹配且完整内容预检通过的组件时，默认采用它承载主内容；不采用时在 `designIntent` 说明候选名称、具体不适用原因与替代表达。
- 栏头（`indexHeader`/`sectionHeader`）、结论框（`calloutBox`）等辅助组件不能替代主内容的组件化表达。
- 纯文字封面、章节、引语、收尾页，以及真实明细表（`table` 节点）的既有用法不受「默认采用」约束。

## 按展示用途选组件

先确定这一页要让观众看懂什么（顺序、比较、层级、规模…），再按下表选主表达组件；每个组件只有一个主要用途，实际使用允许跨类。选中后读该类别的参数文档 `skills/layout-tree-skill/components/<文档>`，核对参数、素材要求、条目容量与槽位下限（同一类别同一对话读一次即可）。

| 展示用途 | 文档 | 组件 | 适用条件 |
|---|---|---|---|
| 导航与章节组织 | `navigation.md` | `agenda`、`sectionHeader`、`indexHeader` | 目录、章节分隔、编号开篇；不承载论据 |
| 要点、卖点与产品介绍 | `points.md` | `pointList`、`featureCards`、`bentoGrid`、`categoryCards`、`featureRail` | 平行要点或多卖点陈列；并列本身是一种内容关系，也适用于无层级结构的清单 |
| 时间与顺序推进 | `sequence.md` | `timeline`、`eraRail`、`steps`、`chevron` | 有时间节点用 `timeline`/`eraRail`，操作步骤用 `steps`，单向阶段推进用 `chevron` |
| 层级与组织结构 | `hierarchy.md` | `orgChart`、`pyramid`、`layeredStack` | 人员/组织归属用 `orgChart`，重要性分层用 `pyramid`，架构堆叠用 `layeredStack` |
| 转化、汇聚与循环 | `conversion.md` | `funnel`、`radialFunnel`、`cycle` | 逐级收窄转化用 `funnel`，中心辐射汇聚用 `radialFunnel`（汇聚不等于逐级收窄），闭环流程用 `cycle` |
| 比较、定位与选择 | `comparison.md` | `comparison`、`prosCons`、`matrix2x2`、`venn`、`competitorBoard`、`pricingTiers` | 两方对照用 `comparison`；`prosCons` 仅限明确的利弊清单（优势/风险），泛化的比较不等于利弊 |
| 指标、进度与财务 | `metrics.md` | `stats`、`kpiRows`、`progress`、`financialBoard` | 数值标签成组用 `stats`/`kpiRows`，完成度用 `progress`，财务结构用 `financialBoard` |
| 人物与团队介绍 | `people.md` | `persona`、`teamGrid`、`founderProfile` | 单人画像用 `persona`/`founderProfile`，团队陈列用 `teamGrid` |
| 引用与外部背书 | `quotes.md` | `quote`、`quotes`、`logoWall` | 单条金句用 `quote`，多条评价用 `quotes`，客户/合作方标识用 `logoWall` |
| 结论强调与视觉叙事 | `emphasis.md` | `calloutBox`、`fullBleedQuote`、`photoTriptych` | 单点结论框用 `calloutBox`，整页金句用 `fullBleedQuote`，三图并置叙事用 `photoTriptych` |

边界：趋势与分布用 `chart` 节点、逐格读取的明细用 `table` 节点；二者可与上表组件**同页组合**，但上游已定型的 table/chart 内容契约优先，须保留原有行列、分类和序列对应关系，不得因组件选型擅自转换或丢失数据。

## 设计指引（语义内容布局）

### 内容契约与必留

- `message` 是页面主标题，完整展示。`blocks` 是待呈现的内容；`mustShow` 决定必留范围，`priority` 与 `focusRefs` 决定主次。
- 上游已完成文案精炼，沿用其短句，不补写解释段落或装饰性口号。message 与标题 block 相同时共用一个标题节点，绑定到该 block；多个 block 承载相同文字时可共用节点，分别绑定，避免重复上屏。
- `relations` 及其 `basis` 说明内容之间的关系。为每项关系选择图上可指认的线索，保持其原意：比较有明确的两端标签与对应维度，先后有方向或编号，层级有字号、位置或面积主次。平等对照可以等宽同色；确有侧重点时才用面积、底色或强调区分，视觉权重须符合内容。
- `constraints.verbatimRefs` 标记逐字保留的来源。排版本身保留普通文案、数值、单位、引用归属、表格行列及图表分类与序列对应关系；可拆分、分组和调整换行。
- `content.notes` 原样写入树的 `notes`。`omissions` 是上游已记录的取舍；本轮以必留内容为底线，不通过转入备注或隐藏内容来解决拥挤。
- 图片从实际 `materials` 中取用，遵守 block 的素材引用与 fit 要求。图片保持比例，`contain` 完整呈现，`cover` 的裁切保留主体。

### 构图与选型

先理解这一页要让观众记住什么，再决定如何组织空间。表达结构先于排版，按四步决策：

1. **先定展示用途**：根据核心内容与主关系确定这一页要让观众看懂什么（顺序、比较、层级、规模、指标…），不只按页面 `role` 判断。
2. **按用途选主表达组件**：优先查「按展示用途选组件」索引；输入的 `componentCandidates` 是按本页实际 blocks 预检过的参考（`feasible:true` 附 `validatedSlot`/`suggestedSlot`/`validatedGrid` 与可直接使用的 `template` 参数；预检只对声明的完整内容组、该网格与该参数有效），候选列表不是全部可用组件。选中后读该类别的参数文档核对该组件的参数与素材要求；主表达组件先占主区域，标题与辅助信息随后布局，装不装得下交给校验回答。
3. **按需补辅助表达**：指标用 `stats`/`kpiRows`、单点结论用 `calloutBox`、引用背书用 `quote`/`logoWall`、章节与栏头组织用 `sectionHeader`/`indexHeader`。
4. **装不下时如实处理**：优先换更大区域或更少条目（必留条目完整迁移）；确实无合适组件时可用原子节点，但须在 `designIntent` 说明主关系如何表达。容量不足如实报告缺口；不得为通过校验把结构化表达退化为长文本。

在此基础上自主选择合法 `composition` 和节点结构。重点与关系决定模块数量；相同用途的连续页可以保持一致，结构变化应服务于内容和全册节奏。

选型边界：

- `pointList` 只承载无层级结构的要点清单；并列（parallel）本身是一种内容关系，可用并列类组件承载。
- 趋势、分布用 `chart` 节点；逐格读取的明细用 `table` 节点。图表、表格可与组件**同页组合**；已定型的 table/chart 内容块须保留原有行列、分类和序列对应关系，不得因组件选型擅自转换或丢失数据。
- 栏头（`indexHeader`/`sectionHeader`）、结论框（`calloutBox`）等辅助组件不能替代主内容的组件化表达。
- 纯文字封面、章节、引语、收尾页，以及真实明细表的既有用法不受「默认采用」约束。
- 静态容量（条目上限、单条字数、槽位下限）只作参考，以 `componentCandidates` 预检和最终校验的实测 `hint` 为准；禁止截断必留内容。
- `density` 是本页信息量的预期：`sparse` 页保持单焦点与少容器，`dense` 页优先结构化承载（组件、表格、图表、统计），不用大段正文占位。
- 主内容不采用候选组件时，在 `designIntent` 的取舍里说明候选名称、具体不适用原因与替代表达（内容形态不匹配、槽位不足或内容超出容量）。

### 空间分配

空间按内容量分配：内容多的一侧占更大区域，短文案优先紧凑分组。区域需求用输入里的实测数字——`blockNeeds`（各内容块按 3/6/12 列宽的实测高度、表格/图表的建议槽位）与候选的 `validatedSlot`——第一棵树照数字分区，不做字数估算；校验缺陷附实测 `frame`/`requiredHeight`，按反馈调整 slot 跨度或 `weights`。卡片大部分为空、标题与正文被空带隔开、重心偏向一角时，收紧容器、重排分区或调整图文比例。`pad` 控制内边距，父级 `weights` 分配子区域，`justify`/`valign` 只调内容位置、不增加容量；居中不解决装不下。留白须服务聚焦、分组或节奏，避免用新增文案或装饰填空。

全册页脚默认规则：除 `cover`、`closing` 外，写 `footer:{pageNumbers:true}`，为页码与页脚线留出底部空间；深色页用合适的 `tone`。明确的任务或风格约定优先于此默认值。`neighbors` 只有内容摘要时，按本页网格与主题建立稳定边距，不据此声称已核对邻页标题基线或构图。

设计完成须同时满足：必留内容完整、主焦点与关系可指认、空间与内容量匹配、主题与页脚规则一致、几何校验通过。`ok=true` 仅证明结构与几何合格；视觉质量按 SYSTEM.md「视觉自审」判据验收。

## 组件样式（style）与 styleTokens

`style` 是改组件样式的唯一入口。值全部是语义枚举，缺省从风格卡推导（输入 `styleTokens.componentDefaults`）。不写裸色号、裸 pt、裸 px；未知字段报错。

| 字段 | 取值 | 语义 |
|---|---|---|
| `surface` | `none \| card \| tint \| outline \| ink \| band` | 底面语言：无底 / 卡面（描边 + 阴影 + 圆角）/ 主色浅档 / 透明描边 / 墨面反白 / 强调色顶条 |
| `separator` | `line \| gap \| none` | 条目之间：1px 分隔线 / 只留间距 / 什么都不留（风格卡关掉分隔线时 `line` 自动降为 `gap`） |
| `align` | `start \| center` | 文本对齐与整组水平落位 |
| `density` | `tight \| normal \| airy` | 内部间距密度：间距与内边距 ×0.75 / 1 / 1.4 |
| `numeral` | `serif \| sans \| none` | 装饰性序号/年份/大数字：标题字体 / 正文字体 / 去掉装饰序号 |
| `accent` | `primary \| accent \| muted` | 唯一强调位（刻标、顶条、星、目标刻度）取色 |
| `motif` | `inherit \| none` | 是否在有底面的组件上画风格卡母题（色带 / 角标 / 幽灵块）；`inherit` 跟随风格卡，`surface:"none"` 时不重复画 |

**组件专属变体**（每个组件至多一个，全部枚举）：

| 组件 | 变体 | 取值 |
|---|---|---|
| `stats` | `layout` | `row \| column \| grid` |
| `timeline` | `direction` / `axis` | `h \| v` / `line \| dots \| none` |
| `steps` | `connector` | `line \| gap \| none` |
| `chevron` / `pyramid` / `funnel` | `form` | `outline \| filled \| tint` |
| `calloutBox` | `form` | `bar \| panel \| tint` |
| `cycle` | `marker` | `dot \| number` |
| `progress` | `fill` | `ink \| primary` |
| `orgChart` | `connector` | `elbow \| none` |
| `teamGrid` | `avatar` | `circle \| initial` |
| `logoWall` | `monochrome` | `true \| false` |

**styleTokens 语义**（输入字段，是主题口径的权威来源）：

- `composition`：构图家族（`swiss / editorial / poster / immersive`），决定页面骨架倾向。
- `darkCover`：封面/收尾是否自动深色。
- `motif`：页级母题（色带 / 角标 / 幽灵块）。母题由引擎统一铺，`surface:"none"` 的组件不重复画。
- `palette` / `typeScale` / `fonts` / `spacing` / `decoration`：色板、字号档、字体、间距和装饰的默认口径。
- `componentDefaults`：组件 `style` 的默认值。省略即继承。

组件 style 使用上述语义枚举，在主题口径内选择变体。

**组件语义子集**（哪些 style 真的有差）。组件只表达与自己语义相关的维度，未列出的组合对该组件是 no-op：不报错，也没有视觉变化。默认底面写「卡片」的组件用风格卡卡面；写「平铺」的组件只有显式 `style.surface` 才铺底。

| 组件 | 默认底面 | separator | accent | numeral | 图槽 |
|---|---|---|---|---|---|
| stats | 平铺 | ✓ | ✓ | ✓ | — |
| timeline | 平铺 | 轴线独立控制 | ✓ | ✓（年份字体） | — |
| steps | 平铺 | connector 独立控制 | ✓ | ✓ | — |
| agenda | 平铺 | ✓ | ✓ | ✓ | — |
| pointList | 平铺 | ✓ | ✓ | ✓ | — |
| featureCards | 卡片 | — | ✓ | — | ✓ |
| comparison | 卡片 | ✓ | ✓ | — | — |
| matrix2x2 | 卡片 | ✓ | — | — | — |
| prosCons | 卡片 | ✓ | ✓ | ✓ | — |
| quote | 平铺 | — | ✓（刻标） | ✓（引文字体） | — |
| quotes | 卡片 | — | ✓ | — | ✓ |
| teamGrid | 卡片 | ✓ | ✓ | ✓ | ✓ |
| persona | 卡片 | ✓ | ✓ | ✓ | ✓ |
| bentoGrid | 卡片 | — | ✓ | — | ✓ |
| layeredStack | 卡片 | ✓ | ✓ | ✓ | — |
| pricingTiers | 卡片 | ✓ | ✓ | ✓ | — |
| logoWall | 卡片 | ✓ | — | — | ✓（灰度 contain） |
| indexHeader | 平铺 | ✓ | ✓ | ✓ | — |
| eraRail | 平铺 | ✓（脊线/刻度） | ✓ | ✓ | — |
| progress | 平铺 | — | ✓ | — | — |
| cycle | 平铺 | — | ✓ | ✓ | — |
| chevron / pyramid / funnel | 平铺 | — | ✓ | — | — |
| venn | 平铺 | — | ✓ | — | — |
| calloutBox | 卡片 | — | ✓ | — | — |
| orgChart | 平铺 | — | ✓ | — | — |

## 组件清单

37 个组件 = 27 个核心组件 + 10 个页面原子。名字与引擎 `COMPONENT_NAMES` 一一对应。

| 组件 | 类别 |
|---|---|
| `timeline` | 核心 |
| `steps` | 核心 |
| `stats` | 核心 |
| `featureCards` | 核心 |
| `quote` | 核心 |
| `comparison` | 核心 |
| `matrix2x2` | 核心 |
| `prosCons` | 核心 |
| `agenda` | 核心 |
| `chevron` | 核心 |
| `pyramid` | 核心 |
| `funnel` | 核心 |
| `venn` | 核心 |
| `calloutBox` | 核心 |
| `cycle` | 核心 |
| `progress` | 核心 |
| `orgChart` | 核心 |
| `persona` | 核心 |
| `bentoGrid` | 核心 |
| `layeredStack` | 核心 |
| `teamGrid` | 核心 |
| `quotes` | 核心 |
| `pricingTiers` | 核心 |
| `logoWall` | 核心 |
| `pointList` | 核心 |
| `indexHeader` | 核心 |
| `eraRail` | 核心 |
| `founderProfile` | 原子 |
| `radialFunnel` | 原子 |
| `kpiRows` | 原子 |
| `categoryCards` | 原子 |
| `featureRail` | 原子 |
| `sectionHeader` | 原子 |
| `photoTriptych` | 原子 |
| `competitorBoard` | 原子 |
| `fullBleedQuote` | 原子 |
| `financialBoard` | 原子 |

## 组件参数

「约几元素」用于估算编译后的元素预算；组件选择依据其信息语义和实际容量。

「槽位下限」是该组件还给得出正常版面的经验最小值（列×行，12 列 × 8 行口径）。低于它时组件先按角色下限有限收缩（正文至 16pt、标题至 20pt、注释至 12pt），仍装不下报 `overflow`，并在缺陷 `hint` 里给出本页内容量下的实测需求（如「至少需要约 640×320px（6 列 × 4 行）」）。**装不下时的处理顺序：先扩大槽位 → 再减条目 → 最后换更简单的节点/组件**；不要靠缩字号、删必留内容或增加装饰绕过。

### 27 个核心组件

| 组件 | 形态与语义 | 参数 | 条目与上限 | 约几元素 | 槽位下限（列×行） |
|---|---|---|---|---|---|
| `timeline` | 轴线串节点，上标签下说明——进程与先后 | `direction?`（`h`/`v`，缺省 h）、`axis?`（`line`/`dots`/`none`）、`items: [{ label, text }]` | 3~6 条；`label` ≤24 字、`text` ≤80 字 | 10~19 | 8×4 |
| `steps` | 大编号 + 标题 + 说明横排——有序步骤 | `connector?`（`line`/`gap`/`none`）、`items: [{ title, text? }]` | 3~5 步；`title` ≤24 字、`text` ≤80 字 | 6~15 | 8×4 |
| `stats` | 大数字 + 标签的指标卡横排——量化基本面 | `layout?`（`row`/`column`/`grid`）、`items: [{ value, unit?, label }]` | 2~4 项；`value` ≤16 字、`unit` ≤8 字、`label` ≤40 字 | 6~12 | 6×3 |
| `featureCards` | 图标或图片 + 标题 + 正文的卡片行——并列卖点 | `items: [{ title, body?, icon?, image? }]` | 2~4 张；`title` ≤30 字、`body` ≤200 字；给 `image`（http(s) 直链或 `everroom-material://`）时顶部画圆角图块，`icon` 不画 | 4~16 | 8×4 |
| `quote` | 大引号 + 居中引文 + 署名——引用定调 | `text`、`author?` | `text` ≤200 字、`author` ≤40 字 | 2~3 | 6×3 |
| `comparison` | 2~4 方对照，中央分隔随 `style.separator`——多方横评 | `sides: [{ title, tag?, points }]`、`featured?`（重点列下标，0 起） | 2~4 方；`title` ≤24 字、`tag` ≤8 字；每方 2~5 点，单点 ≤60 字；点是字符串或 `{ text, mark: "yes"\|"mid"\|"no" }` | 6~20 | 8×4 |
| `matrix2x2` | 四块面板田字格 + 四边轴标——双维度交叉定位 | `quadrants: [{ title, points? }] ×4`、`axes?: { top?, right?, bottom?, left? }` | 象限固定 4 个；`title` ≤24 字；每象限 1~4 点，单点 ≤40 字；轴标各 ≤20 字 | 8~20 | 8×6 |
| `prosCons` | 左优势右风险两栏，钩/叉图标打头——利弊清单 | `pros`、`cons`: 字符串数组 | 各 2~5 条，单条 ≤60 字 | 4+2×条数 | 6×4 |
| `agenda` | 大编号 + 条目纵列，超四条分两栏——目录 | `items`: 字符串数组 | 4~8 条，单条 ≤24 字 | 2×条数 | 4×6 |
| `chevron` | 箭头形横排相扣，文字压箭头上——单向推进 | `form?`、`items: [{ title, text? }]` | 3~5 段；`title` ≤16 字、`text` ≤40 字 | 6~15 | 10×3 |
| `pyramid` | 顶三角 + 梯形逐层加宽——层级与体量 | `form?`、`items: [{ title, text? }]`（顶到底） | 3~5 层；`title` ≤16 字、`text` ≤40 字 | 6~15 | 6×4 |
| `funnel` | 横条逐级收窄，每级阶段 + 数值——转化收窄 | `form?`、`items: [{ stage, value? }]` | 3~4 级；`stage` ≤16 字、`value` ≤16 字 | 6~12 | 6×4 |
| `venn` | 两交叠圆 + 两侧与交集标签——交集关系 | `a`、`b`、`both?` | 各 ≤10 字 | 3~4 | 6×4 |
| `calloutBox` | 主题色底板 + 一句加粗结论——单点强调 | `text`、`icon?`、`form?` | `text` ≤120 字 | 2~3 | 5×2 |
| `cycle` | 中央圆环 + 节点圆均匀分布——循环互驱 | `marker?`、`items: [{ title }]` | 3~5 个；每题 ≤6 字 | 1+2×个数 | 6×4 |
| `progress` | 标签行 + 轨道条与前景条——完成度 | `fill?`、`items: [{ label, value, unit?, target? }]` | 2~4 项；`label` ≤24 字、`unit` ≤8 字；`value` / `target` 是 0~100 数字 | 4×项数 | 6×3 |
| `orgChart` | 根在上、子横排、细线连接——隶属结构 | `connector?`、`root`、`children`: `{ title, subtitle? }` | 子节点 2~4 个；`title` ≤20 字、`subtitle` ≤30 字 | 10~16 | 8×4 |
| `persona` | 左头像圆 + 右姓名/角色/要点——人物画像 | `person: { name, role? }`、`points`、`image?` | 要点 2~5 条，单条 ≤40 字；`name` ≤24 字、`role` ≤40 字 | 4~6 | 6×4 |
| `bentoGrid` | 两列格子拼版，`wide` 占整行——信息拼贴 | `items: [{ title, body?, icon?, image?, wide? }]` | 3~5 格；`title` ≤24 字、`body` ≤120 字；`wide: true` 占整行 | 6~20 | 10×5 |
| `layeredStack` | 整宽横条逐层堆叠，左标题右说明——分层堆叠 | `items: [{ title, text? }]` | 3~5 层；`title` ≤16 字、`text` ≤60 字 | 6~15 | 8×4 |
| `teamGrid` | 圆头像 + 姓名 + 职位（主色）+ 两行简介——团队网格 | `avatar?`、`members: [{ name, role?, bio?, image? }]` | 2~6 人（≤4 人单行，5~6 人两行各 3）；`name` ≤16 字、`role` ≤24 字、`bio` ≤48 字 | ~4×人数 | 10×4 |
| `quotes` | 星级 + 引文 + 条目分隔（随 `style.separator`）+ 头像署名——评价墙 | `items: [{ text, name, role?, avatar?, rating? }]` | 2~3 条；`text` ≤90 字、`name` ≤16 字、`role` ≤28 字；`rating` 是 1~5 整数 | 6~10×条数 | 8×4 |
| `pricingTiers` | 套餐定价卡，`featured` 档垫板描边上浮 + 实心按钮 | `tiers: [{ name, price, unit?, features, cta? }]`、`featured`（必填，恰一个） | 2~4 档；`name` ≤12 字、`price` ≤12 字、`unit` ≤10 字、`cta` ≤8 字；每档 2~4 条特性，单条 ≤24 字 | ~7×档数+3 | 10×5 |
| `logoWall` | 灰度图标/文字字标网格——客户墙 | `monochrome?`、`logos: [{ image?, text? }]`（二选一，至少一个） | 4~8 个；`text` ≤20 字；图自动灰度 contain | ≤8 | 8×3 |
| `pointList` | 刻度要点纵列：可选衬线序号 + 粗标签 + 静音正文，条目分隔随 `style.separator`——分类词条、要点清单 | `items: [{ label, body }]`、`numbered?: true` | 2~5 条；`label` ≤12 字、`body` ≤140 字；`numbered` 只接受 `true` | 5~17 | 5×4 |
| `indexHeader` | 衬线序号（主色）+ 标题 + 右侧小注，底部分隔随 `style.separator`——并列栏统一栏头 | `num`（1~2 字，如 壹/儒/01）、`title`、`note?` | `title` ≤12 字、`note` ≤12 字 | 3~4 | 4×2 |
| `eraRail` | 脊线压区域顶，刻度下挂衬线年代 + 静音短注，`highlight` 条目主色——年代轴、节奏带 | `items: [{ era, note }]`、`highlight?`（重点条下标） | 3~6 条；`era` ≤8 字、`note` ≤12 字，各限一行 | 1+3×条数 | 8×2 |

### 10 个页面原子

页面原子只用下表的字段。它们不走核心组件的参数校验：内容放不下时报叶子缺陷（`LAYOUT_LEAF_INVALID`）。以下容量描述用于选型；必留信息超出容量时改用其他合法节点完整承载。`style` 语义同核心组件。

| 组件 | 形态与语义 | 参数 | 条目与上限 | 槽位下限（列×行） |
|---|---|---|---|---|
| `founderProfile` | 创始人履历：左轨节点 + 章节正文 + 底部技能条 | `personName`（必填）、`role?`、`subtitle?`、`variant?`（`timeline` 默认 / `resume` 左轨更宽）、`showHeader?`（`false` 时只画正文，页面已有 `sectionHeader`）、`sections: [{ label?, heading, bullets?, columns?, timeline?, weight? }]`、`skills?: [{ title, text }]` | `sections` 每段给 `bullets` 或 `columns: [{ title, meta?, text }]`（columns 画横向公司时间轴，`timeline: false` 关掉）；`weight` 0.5~2.2（引擎夹取）；正文每行不足 44px 或单栏文字超高时报错 | 10×6 |
| `radialFunnel` | 中心辐射 → 漏斗汇聚 → 结论 | `centerTitle`（必填）、`centerSubtitle?`、`satellites: string[]`、`bridge?`、`conclusionTitle`（必填）、`conclusionBody?`、`footnote?` | `satellites` 最多画 6 个（超出丢弃）；`bridge` 是中心与结论之间的桥接字 | 10×6 |
| `kpiRows` | 左标签胶囊 + 大数字 + 注脚，逐行列出 | `rows: [{ label, value, note? }]` | 行高不足 28px 报错 | 6×4 |
| `categoryCards` | 四栏「标题条 + 图形 + 指标」卡，无照片时的图像卡替代 | `items: [{ title, metric, note?, imageUrl? }]` | `title` 画顶部标题条；给 `imageUrl` 时卡片下半画图，否则画 `metric` 大数字 | 10×4 |
| `featureRail` | 产品特征页：左侧参数块 + 中间曲线节点 + 右侧说明 | `params: [{ label, value }]`、`features: [{ title, text }]`、`imageUrl?` | 每行不足 54px 或说明文字超高时报错；给 `imageUrl` 时左上画图与同心圆注记 | 10×5 |
| `sectionHeader` | 三枚 chevron + 标题 + 副标题的章节头 | `title`（必填）、`subtitle?`、`marker?` | `marker: false` 不画 chevron；标题超宽报错 | 10×2 |
| `photoTriptych` | 三张满版图片并排，标签压在图上 | `images: [{ url, label? }]`、`overlay?`、`labelMode?`（`overlay` 默认 / `none`） | `images` 最多画 3 张（超出丢弃）；`overlay: true` 压一层深色罩 | 10×4 |
| `competitorBoard` | 竞品行：厂商 / 产品图 / 特点胶囊 / 市场数据 | `competitors: [{ name, imageUrl?, tags: string[], facts: string[] }]` | 最多画 3 家（超出丢弃）；表头固定为厂商/产品/特点/市场情况；行高不足 60px 或 `facts` 超高时报错 | 10×5 |
| `fullBleedQuote` | 满版图片 + 居中大字，文字位置由组件锁住 | `imageUrl`（必填）、`kicker?`、`titleLines: string[]`、`subtitle?`、`caption?`、`overlay?` | `titleLines` 逐行居中，引擎按最长行自动缩字；`overlay: false` 关掉压暗罩（默认压） | 10×6 |
| `financialBoard` | 财务页：左财务表 + 右销量柱 + 底部资金用途 | `columns: string[]`、`rows: string[][]`、`chart: { categories: string[], values: number[] }`、`funding: [{ label, value }]`、`caption?` | `rows` 首列左对齐、其余居中；`chart.values` 与 `chart.categories` 一一对应；`funding` 每项一条底部格子 | 10×6 |

## Composition 硬约束（validate 会拒收）

| composition | 必须 |
|---|---|
| immersive | 至少一个 `image` 节点带 bleed（页面级） |
| hero-data | 至少一个 `token:"hero"` 的 text 或一个 chart |
| editorial | 至少一个 image + 一个 `h1`/`h2` |
| poster / chapter | 至少一个 `token:"display"` |
| swiss | 无额外要求 |

约束统计递归到 group 子节点。

## 示例（hero-data）

```json
{
  "version": 2, "role": "data", "composition": "hero-data",
  "footer": { "pageNumbers": true },
  "nodes": [
    { "type": "text", "token": "kicker", "text": "45 年 · 经济总量", "tone": "primary",
      "slot": { "col": [1, 6], "row": [1, 1] } },
    { "type": "text", "token": "h1", "text": "从 2.7 亿到 3.87 万亿元",
      "slot": { "col": [1, 8], "row": [2, 3] } },
    { "type": "text", "token": "hero",
      "paragraphs": [
        { "runs": [{ "text": "2.7", "token": "hero", "bold": true, "tone": "primary" }, { "text": " 亿元", "token": "lead", "tone": "muted" }] },
        { "spaceBeforePt": 10, "runs": [{ "text": "1980 年地区生产总值", "token": "label", "tone": "muted" }] }
      ],
      "slot": { "col": [1, 4], "row": [4, 6] } },
    { "type": "stats", "items": [
      { "value": "21.38", "unit": "万元", "label": "2025 年人均 GDP" },
      { "value": "5.5", "unit": "%", "label": "「十四五」年均增速" }
    ], "slot": { "col": [9, 12], "row": [2, 8] } }
  ]
}
```
