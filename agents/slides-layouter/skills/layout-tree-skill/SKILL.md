---
name: layout-tree-skill
description: 布局树语法与硬约束——容器/叶子/25 组件词汇表、比例/缝隙/justify 打包、整页背景图与 overlay 叠层、容器面板、data 行内格式翻译、多样性与收敛规则
---

# 布局树（LayoutTree）

页面是一棵递归嵌套的容器树。你只写结构与比例；坐标/字号/配色由引擎按 deck 契约确定性计算。每页版式由这页的内容决定——信息密度、数字量级、图文关系、对比结构，都应反映到你给的分区方式上。

## 语法

### 根节点（root）

```json
{
  "role": "content",
  "title": "页标题（进固定标题带）",
  "dark": false,
  "bg": { "image": "https://example.com/cover.jpg" },
  "direction": "row",
  "weights": [1.6, 1],
  "gapScale": 1.5,
  "pad": 16,
  "children": []
}
```

- `role`：照抄输入的 role（内容语义标签）。
- `title`：填输入的 `title`（标题带自动渲染，不算 children）。需要整页构图时可省略 title、设 `dark: true`，把大标题作为 `display` 文字叶子排进版面。
- `bg`：整页背景图（裁切铺满不变形）。设了 bg 的页视同深色页——文字自动换深色页配色，且自动压一层深色纱罩保证对比度；`"scrim": "gradient"` 换成上深下透的渐层纱罩（标题区可读、图片下缘保留细节）；确认图够暗才可加 `"scrim": "none"` 关掉纱罩。
- `direction` / `weights` / `gapScale` / `pad` / `justify`：同容器。

### 容器节点

```json
{ "direction": "row | column | overlay", "weights": [2, 1], "gapScale": 1.5, "pad": 16, "justify": "center", "children": [] }
```

- `direction`：row＝左右分，column＝上下分，overlay＝叠层（子节点自由定位、按声明顺序层叠，后面的压在前面的上面）。
- `weights`：子区域比例（正数，个数＝children 数；缺省均分）。悬殊比例用 1.6/1、2/1、3/1 这一档，别超过 20。
- `gapScale`：缝隙倍率（0~4，0＝无缝贴齐，2＝呼吸感）。
- `pad`：容器内边距（0~48px）。
- `justify`（仅 column）：主轴打包 start/center/end。设置后子节点按内容排：text 叶子取自然高、其余叶子均分剩余空间，整组按 start/center/end 落位——适合「一组内容居中或沉底」。缺省按 weights 分满全高。
- `panel`：`{ tone, radius?: false, stroke?: false }` 给整组子节点垫一块底板（先铺板再排内容），同一组件的七种视觉变种：`surface` 主题卡面平贴；`soft` 主色浅档；`tint` 渐层釉面（主色 8.5%→3.5% 上下渐层+发丝描边，通用内容面板）；`dark` 墨面（深底三档渐层，板内文字自动换深色页口径，金句/章节强调，每页最多一块）；`leftBar` 白卡+左主色胶囊刻标（论述/结论）；`nested` tint 洗地+内白卡浮起（子节点落内卡，卖点组合）；`outline` 细线框（零填充近直角，引言/框架）。radius/stroke 缺省开，显式 false 才关。
- `children`：1~12 个节点（容器或叶子），嵌套层级不设上限。

### overlay 容器与 place

overlay 容器不带 weights/gapScale/justify；每个直接子节点必须带 `place`（容器区域的百分比）：

```json
{ "direction": "overlay", "children": [
  { "type": "image", "url": "https://example.com/hero.jpg", "place": { "x": 0, "y": 0, "w": 100, "h": 100 } },
  { "type": "text", "variant": "heading", "text": "右下角注解", "tone": "inverse",
    "place": { "x": 58, "y": 74, "w": 36, "h": 14 } }
] }
```

- `place.x/y/w/h`：0~100，x+w 与 y+h 不得超过 100；子区域按百分比换算成像素。
- 叠层只允许文字压图、压无字内容；文字压文字仍会被拒。压图文字用 `tone: "inverse"`。

### 叶子节点（八种）

| 叶子 | 字段 | 说明 |
|---|---|---|
| `text` | `variant`（display/heading/subtitle/body/caption）、`text`（\n 分段）、`align?`、`bullet?`、`tone?`（normal/muted/inverse） | 字号由 variant 定档；display 最大、body 是正文 |
| `image` | `url`、`contain?`、`radius?`、`circle?`、`focus?`、`duotone?`、`grayscale?`、`caption?` | 缺省 cover（裁切填满）；`contain: true` 完整呈现（可能留空带）。两者都不变形；框比例尽量贴近图比例。`radius: true` 圆角卡；`circle: true` 圆形裁切（头像/徽标用，框宜取方形，与 radius 二选一）；`focus: {x?, y?}`（0~100）把 cover 裁切对准画面主体；`duotone: true` 主题双色调；`grayscale: true` 灰度化（与 duotone 二选一）；`caption` 压图小字签（≤40 字，左下角玻璃底） |
| `path` | `d`（SVG path） | 装饰性自由路径，默认主题浅色填充 |
| `chart` | `kind`、`categories`、`series`（name+values）、`highlight?`、`delta?` | kind: bar/barStacked/line/area/waterfall/pie/doughnut/scatter/comboBarLine（≥2 系列）；values 与 categories 等长。`highlight`: 数字（0 基类目下标）或 "last"——该列主色实心、其余主色浅档（bar/line/area/comboBarLine 用）；`delta`: ≤12 字涨跌徽章（图表右上角主色圆角签，如 "+42%"）。waterfall 单系列、≤8 列：values 有符号（正=升、负=降），末列画 0→合计的结果柱（营收→减项→…→利润的商用读法） |
| `table` | `rows`（首行表头，2~12 行、2~8 列）、`colWidths?`、`style?`（lines/darkHeader/zebra）、`header?: false`、`topRule?: true` | 单元格是字符串或 {text, bold?, align?}。`header: false`＝无表头，rows 全数据行（账目式两列表；与 darkHeader 互斥）；`topRule: true`＝顶部压一条 2px 墨线，表格下移让位 |
| `divider` | 无 | 分隔线：高框渲染竖线、扁框渲染横线，主题分隔线色 |
| `icon` | `icon`（引擎图标集名称） | 主题主色图标；名称如 check-circle、light-bulb、chart-bar、rocket-launch、users |
| `component` | `name` + 各组件参数 | 参数化积木（见下节），只给文案/条目/方向 |

### 组件（参数化积木）

组件是参数化的复合叶子：只给文案与条目，内部结构与配色由引擎确定性展开；展开产物照常受 48 元素、墨迹不重叠、装不下报缺陷的约束。「约几元素」是排页时的预算参考。组件是排印系统的：无卡片无色面，靠发丝线、衬线大数字（stats/steps/agenda/时间轴年份/引文）与唯一主色刻标表达层级；stats/featureCards/comparison/prosCons/persona/calloutBox/pointList 的内容高跟内容走、整组在区域内垂直居中，过高的框只增加留白。progress 条目可选 target（0~100）画目标刻度。

| 组件 | 形态与语义 | 参数 | 条目/取值 | 约几元素 |
|---|---|---|---|---|
| `timeline` | 轴线串节点，上标签下说明——进程与先后 | `direction?`（h/v）、`items: [{ label, text }]` | 3~6 条 | 10~19 |
| `steps` | 大编号+标题+说明横排——有序步骤 | `items: [{ title, text? }]` | 3~5 步 | 6~15 |
| `stats` | 大数字+标签的指标卡横排——量化基本面 | `items: [{ value, unit?, label }]` | 2~4 项 | 6~12 |
| `featureCards` | 图标或图片+标题+正文的卡片行——并列卖点 | `items: [{ title, body?, icon?, image? }]` | 2~4 张；条目给 `image`（http(s) 直链）时顶部画圆角图块、icon 不画 | 4~16 |
| `quote` | 大引号+居中引文+署名——引用定调 | `text`、`author?` | — | 2~3 |
| `comparison` | 2~4 方对照，中央竖线分栏——多方横评 | `sides: [{ title, tag?, points }]`、`featured?`（重点列下标）；点为字符串或 `{ text, mark: "yes"\|"mid"\|"no" }`（钩/横/叉打头） | 2~4 方；每方 2~5 点（4 方时限 4 点） | 6~20 |
| `matrix2x2` | 四块面板田字格+四边轴标——双维度交叉定位 | `quadrants: [{ title, points? }]×4`、`axes?: { top?, right?, bottom?, left? }` | 象限固定 4；每象限 1~4 点 | 8~20 |
| `prosCons` | 左优势右风险两栏，钩/叉图标打头——利弊清单 | `pros`/`cons`: 字符串数组 | 各 2~5 条 | 4+2×条数 |
| `agenda` | 大编号+条目纵列，超四条分两栏——目录 | `items: 字符串数组` | 4~8 条 | 2×条数 |
| `chevron` | 箭头形横排相扣，文字压箭头上——单向推进 | `items: [{ title, text? }]` | 3~5 段 | 6~15 |
| `pyramid` | 顶三角+梯形逐层加宽——层级与体量 | `items: [{ title, text? }]`（顶到底） | 3~5 层 | 6~15 |
| `funnel` | 横条逐级收窄，每级阶段+数值——转化收窄 | `items: [{ stage, value? }]` | 3~4 级 | 6~12 |
| `venn` | 两交叠圆+两侧与交集标签——交集关系 | `a`、`b`、`both?` | 各 ≤10 字 | 3~4 |
| `calloutBox` | 主题色底板+一句加粗结论——单点强调 | `text`、`icon?` | ≤120 字 | 2~3 |
| `cycle` | 中央圆环+节点圆均匀分布——循环互驱 | `items: [{ title }]`（节点内短标题） | 3~5 个、每题 ≤6 字 | 1+2×个数 |
| `progress` | 标签行+轨道条与前景条——完成度 | `items: [{ label, value(0~100), unit? }]` | 2~4 项 | 4×项数 |
| `orgChart` | 根在上、子横排、细线连接——隶属结构 | `root`/`children`: `{ title, subtitle? }` | 子节点 2~4 | 10~16 |
| `persona` | 左头像圆+右姓名/角色/要点——人物画像 | `person: { name, role? }`、`points`、`image?` | 要点 2~5 | 4~6 |
| `bentoGrid` | 两列格子拼版，wide 占整行——信息拼贴 | `items: [{ title, body?, icon?, image?, wide? }]` | 3~5 格；条目给 `image`（http(s) 直链）时格子顶部画圆角图块、icon 不画 | 6~20 |
| `layeredStack` | 整宽横条逐层堆叠，左标题右说明——分层堆叠 | `items: [{ title, text? }]` | 3~5 层 | 6~15 |
| `teamGrid` | 圆头像+姓名+职位（主色）+两行简介——团队网格 | `members: [{ name, role?, bio?, image? }]` | 2~6 人（≤4 单行，5~6 两行各 3） | ~4×人数 |
| `quotes` | 星级+引文+短发丝线+头像署名——评价墙 | `items: [{ text, name, role?, avatar?, rating?(1~5) }]` | 2~3 条 | 6~10×条数 |
| `pricingTiers` | 套餐定价卡，featured 档垫板描边上浮+实心按钮 | `tiers: [{ name, price, unit?, features, cta? }]`、`featured`（恰一个） | 2~4 档；每档 2~4 特性行 | ~7×档数+3 |
| `logoWall` | 灰度图标/文字字标网格——客户墙 | `logos: [{ image?, text? }]`（二选一；图自动灰度 contain） | 4~8 个 | ≤8 |
| `pointList` | 刻度要点纵列：可选衬线序号+粗标签+静音正文，条目间发丝线——分类词条、要点清单 | `items: [{ label, body }]`、`numbered?: true`（衬线序号 01/02/…） | 2~5 条；标签 ≤12 字、正文 ≤140 字 | 5~17 |

```json
{ "type": "component", "name": "timeline",
  "items": [ { "label": "2026", "text": "品类验证" }, { "label": "2027", "text": "渠道扩张" }, { "label": "2028", "text": "品牌溢价" } ] }
```

### 上限与硬约束（引擎限制，超了 validate 会报）

元素总数 48、图片 8、路径 4、单文本 2000 字符、图表类目 2~24、表格 12 行 8 列。

**文本只写文字**：emoji（含符号表情字符）会被引擎整页拒绝——装饰图形用 path 叶子。

## data 行内格式翻译

输入 `data` 按约定格式解析后装进对应叶子：

- 图表行「`bar | categories: 2023, 2024 | 营收: 1.2, 1.8`」→ `chart` 叶子（kind=bar）。
- 表格行「`维度 | 本品 | 竞品A`」每行一条 → `table` 叶子的 rows。
- KPI 行「`指标名: 数值 单位`」→ `stats` 组件的 items（value=数值，unit=单位，label=指标名）。

## 设计纪律

### 输入信号

`role` 与 `density` 是 planner 对这页的内容语义与密度意图：这页在讲什么、信息量多大。设计分区时消化它们。

### 多样性

1. 每页一副新骨架。变化轴任选：方向（row↔column）、权重（50/50↔62/38↔70/30↔更悬殊）、层级（平铺↔分组嵌套）、留白位置、justify 打包。
2. 相邻页不同构；重排任务给了 `neighborSignatures` 时避开其中每一个。

### 收敛

validate 缺陷的典型修法：

- `overflow`（文字超出区域 / justify 打包超高）：加大该子树 weights、精简 text、把大 text 拆成多个小 text、或调整 justify。
- `min_size`：减少兄弟节点或调平 weights。
- `image_ar`：调图片叶所在区域的比例贴近图，或改用 cover。
- `contrast`：背景图页未压纱罩且有普通色文字——去掉 `bg.scrim: "none"`，或压图文字全部改 `tone: "inverse"`。
- `element_cap`：删装饰性 path、合并碎卡。

3 轮修不完就简化整树：减叶子、减层级，朴素优先于破碎。
