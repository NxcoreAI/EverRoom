# 演示文稿质量升级设计：内容压缩 + 排版语法 v2 + Storyboard

- 日期：2026-10-19
- 状态：设计稿（方向验证已附 3 页黄金样张）
- 范围：PPT 生成链路（slides-planner / slides-layouter / slides-layout / slides-reviewer）与 genoffice 的少量渲染能力
- 样张：[golden-sample](../materials/ppt-style-experiments/golden-sample/README.md)（3 页真实 PPTX + PNG + 验收报告）

---

## 0. 一页结论

当前问题的上限不在「组件数量」和「配色」，而在两处：

1. **链路里没有「编辑」**：草稿是文档（完整句子 2~5 条/页），arrange 只换 density 标签，layouter 被「内容保真」禁止改写 → 页面必然是小字墙。
2. **版式语法只表达「盒子怎么切」**：固定标题带 + 固定内容框 + 5 个字号档 + 整组居中 → 空、板、重复；风格管线选出来的构图家族只变成一句 400 字提示，引擎不执行。

本设计新增三件东西，且互相咬合：

- **内容压缩**：新增 `slides-editor`（编辑/剪辑）子代理，把用户确认的草稿压成「1 句 message + 0~1 行 supporting + ≤3 条 facts + speakerNotes」，并给出 storyboard（composition / intent / takeaway / emphasis）。
- **排版语法 v2**：type token、12×8 slot 栅格、bleed、content-fit、per-leaf runs、chart token、footer；composition 变成**可执行的版式配方**，不再只是一句提示。
- **Storyboard**：编辑层与排版层之间的唯一契约；layouter 不再看原始长文，只按 storyboard + 压缩文案排页；reviewer 拿到同一份预算做判断。

验收以「可量化」为准（见 §6）：页面文字量、composition 数量与相邻差异、type token、溢出错位为 0、非满版页占墨 3~30%、盲测偏好 ≥70%、失败兜底 ≤2%、审页覆盖率 100%。

---

## 1. 问题、目标与不做什么

### 1.1 已确认的四层根因（摘要）

| 层 | 机制 | 证据 |
|---|---|---|
| 内容 | 草稿写完整句子、单条 ≤200 字、每页 ≤8 条；arrange 不压缩；layouter「不改写、不扩写、不丢内容」 | [slides-planner/SYSTEM.md](../agents/slides-planner/SYSTEM.md#L7-L9)、[slides-layouter/SYSTEM.md](../agents/slides-layouter/SYSTEM.md#L17) |
| 版式 | 1280×720 固定；标题带 44~136、内容 140~680、margin 32~96；5 个文字变体固定字号；容器只 flex 切分 | [grid.ts](../apps/gateway/src/modules/slides-layout/grid.ts#L11-L13)、[compile.ts](../apps/gateway/src/modules/slides-layout/tree/compile.ts#L216-L222)、[schema.ts](../apps/gateway/src/modules/slides-layout/tree/schema.ts#L32-L39) |
| 风格/素材 | 风格来自一张 AI 图的像素聚类（≤6 色/240px）+ 6 种字体；composition 只被翻成一句 styleBrief；图表不带主题；配图无主体/构图质检 | [extract.ts](../apps/gateway/src/modules/slides-style/extract.ts#L22-L30)、[validate.ts](../apps/gateway/src/modules/slides-style/validate.ts#L31-L38)、[slides-layout-tail.ts](../apps/gateway/src/modules/subagents/slides-layout-tail.ts#L95-L111) |
| 闭环 | layouter 盲排；reviewer 只能改几何，且 12 页只审到 4 页；失败路径砍半要点/整页兜底；无金标准与视觉评分 | [slides-layout-tail.ts](../apps/gateway/src/modules/subagents/slides-layout-tail.ts#L159-L198)、[slides-reviewer/SYSTEM.md](../agents/slides-reviewer/SYSTEM.md#L19-L26) |

### 1.2 目标（可验收）

1. 页面叙事文字降到现状的 10~30%（copy 含标签/来源约为现状的 50~70%），且不丢事实：每页 1 个 message，细节进 speakerNotes。
2. 同一套主题下，8 页以上 deck 至少出现 3 种 composition，相邻页不同构；非满版页占墨 3~30%。
3. 文字层级由 type token 控制（body ≥16pt），不再靠 14pt 正文+11pt caption 堆叠。
4. 风格承诺可执行：用户选「杂志编辑 / 海报大字 / 沉浸大图」时，引擎按对应版式配方落页。
5. 失败兜底率 <2%，审页覆盖率 100%，盲测偏好新方案 ≥70%。

### 1.3 不做什么

- 不重写 genoffice 引擎；只补 **chart 主题 token**、**PPTX notes** 两个必要能力。
- 不保留「33 个预设版式」那种硬模板；composition 是**配方 + 槽位**，不是固定页面。
- 不把设计交给单一模型自由发挥：content/storyboard/layout 各有 schema 与确定性校验。
- 首版不追求「自动生成商业级信息图 / 复杂图表」；先把封面、数据、叙事三类主页面做对。

---

## 2. 目标链路

### 2.1 当前链路

```
instruction
  → slides-planner(draft) → 草稿文档（用户确认/修改）
  → slides-styler(direction/settle) → 风格卡
  → slides-planner(arrange) → pages[title/points/data/density/role/materials]
  → 配图（可选）
  → slides-layouter（每页一棵树，盲排）
  → compile/measure → 落页
  → slides-reviewer（只能修树）
```

### 2.2 新链路

```
instruction
  → slides-planner(draft) → 草稿文档（用户确认/修改）
  → slides-editor(condense) → storyboard.json（3 类产物：storyboard / page copy / speaker notes）
  → slides-styler(direction/settle，输入加 deck.visualThesis) → 风格卡
  → slides-layouter（输入 = storyboard + copy + neighbors + styleBrief；按 composition 配方排 slot，不读原始长文）
  → compile-v2/measure → 落页
  → slides-reviewer（看截图 + 对话目标 + 预算；可改树，不可改文案；可“要求压缩/换构图”打回 editor）
```

关键边界：

- **draft 文档保持“人话”**：用户仍然逐字改内容；它是唯一事实源。
- **editor 只压缩、不新增事实**：把草稿 points 映射成 message/supporting/facts，未上页的细节进 speakerNotes；删除必须写 `dropped[]` 并让用户可见。
- **layouter 不再看到 points 原文**：只看到最多 24 字的 message + ≤3 条 facts + 数据 + storyboard。这是“小字墙”能不能消失的结构性开关。

---

## 3. 内容压缩：`slides-editor`

### 3.0 在现有流程中的插入点

- `slides_draft(task="style")` 进入时：以 `draftDocumentId + 草稿内容 hash` 为 key，后台启动 `slides-editor`（不阻塞风格候选生成）；hash 变化（用户又改了草稿）则作废重跑。
- `slides_draft(task="generate")` 进入时：storyboard 已就绪直接用；未就绪则同步跑 editor（超时 45s；正常与 style 并行），失败降级到旧 arrange（warning 明示“本次未压缩”）。
- 存储：新增 `slides_storyboards(id, room_id, draft_document_id, draft_hash, storyboard_json, created_at)`；同一 draft 只认最新 hash。
- 兼容：影子模式默认开启（装配层传入 `slidesEditor` 即启用）；只记录 storyboard 与 diff，不替换默认链路。关闭在装配层去掉传入即可，不占用 `.env`。

### 3.1 角色与边界

- 新子代理 `agents/slides-editor/`（mode: dispatch_only；allowedCallers: primary-agent；maxToolCalls: 8；timeout: 120s）。
- 输入：`instruction`、`draftPages`（用户确认后的页）、`audience`、`occasion`、`durationMin`、`visualThesis?`、`outline?`。
- 输出：`storyboard` + `pages`（压缩文案）+ `dropped[]` + `warnings[]`。
- 禁止：检索、写文档、落页、改用户事实；不得把制作信息（页数/时长/配比）写成页面内容。

### 3.2 输出字段

```jsonc
{
  "schemaVersion": "storyboard/v2",
  "deck": {
    "title": "深圳：一座仍在生长的城市",
    "audience": "对深圳感兴趣的一般读者与来访者",
    "occasion": "城市专题分享",
    "durationMin": 15,
    "spine": "城市不是自然生长出来的，而是一轮接一轮被设计出来的。",
    "visualThesis": "极简人文：照片承担叙事，数字承担锚点，文字只留一句话。",
    "narrativeArc": ["起点", "制度", "产业", "人", "收尾"]
  },
  "pages": [
    {
      "id": "page-02",
      "role": "data",                    // cover|section|content|data|table|flow|quote|closing
      "density": "dense",                // sparse|standard|dense
      "composition": "hero-data",        // immersive|hero-data|editorial|swiss|poster|chapter
      "emphasis": "number",              // title|number|image|quote|chart|table
      "intent": "用一个量级跨越建立规模的事实底座。",
      "takeaway": "四十五年，经济量级已完全不同。",
      "copy": {
        "kicker": "45 年 · 经济总量",
        "message": "从 2.7 亿到 3.87 万亿元",
        "supporting": [],
        "facts": [
          { "label": "1980 年 GDP", "value": "2.7", "unit": "亿元", "note": "期初口径" },
          { "label": "2025 年 GDP", "value": "3.87", "unit": "万亿元", "note": "初步统计" }
        ],
        "quote": { "text": "", "attribution": "" },
        "source": "数据来源：深圳市 2025 年统计公报。口径不同，只列绝对数。",
        "speakerNotes": "这一页只让听众记住两个量级……"
      },
      "data": {
        "chart": { "kind": "bar", "categories": ["2020 年", "2025 年"], "series": [{ "name": "GDP（万亿元）", "values": [2.83, 3.87] }], "highlight": "last" },
        "stats": [{ "value": "21.38", "unit": "万元", "label": "2025 年人均 GDP" }]
      },
      "visual": { "kind": "none" },
      "dropped": [
        { "from": "draft-page-05", "text": "1980 年…两个数字口径不同…", "reason": "进 speakerNotes", "movedToNotes": true }
      ]
    }
  ],
  "warnings": []
}
```

### 3.3 字段与预算

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | string | 与草稿页对应 | 解析/回流用 |
| `role` | enum | 8 类 | 内容语义 |
| `density` | enum | sparse/standard/dense | 只影响预算与节奏，不直接决定版式 |
| `composition` | enum | 6 类，≥8 页 deck 至少 3 种、相邻不同 | 见 §4.4 |
| `emphasis` | enum | 6 类 | 该页唯一视觉锚点 |
| `intent` | string | 10~60 字 | 这页要改变听众什么认知 |
| `takeaway` | string | ≤22 字 | 听众离场后记得的一句 |
| `copy.kicker` | string? | ≤12 字 | 时间/地点/章节眉标 |
| `copy.message` | string | **≤24 字**（封面 ≤20），必填 | 页面唯一主张 |
| `copy.supporting` | string[] | ≤1 条、≤32 字 | 只补充 message，不重复 |
| `copy.facts` | object[] | ≤3 条；label ≤10，value/body ≤14 | 只放真实数字/短事实 |
| `copy.quote` | object? | 引文 ≤40 字 | 引语页用，配 attribution |
| `copy.source` | string? | ≤80 字 | 数据口径/出处（页面或 footer 用 `@source` 绑定） |
| `copy.speakerNotes` | string | 60~260 字 | 讲稿；承接被压缩掉的细节 |
| `proseChars` | derived | 封面 ≤60、内容 ≤80、数据 ≤60 | message+supporting+quote，不含 facts/source/labels；防止“压缩后仍是一句话墙” |
| `data.chart` | object? | 2~24 类目、1~6 系列 | 结构化，不走页面文字 |
| `data.stats` | object[] | ≤4 | KPI 用（layout 走 stats 节点） |
| `visual` | object | `{ kind: none|material|generated, url?/materialHash?/imagePrompt?, treatment?: inline|sideBleed|fullBleed, focus?, scrim?: none|bottom|top|vignette }` | 素材/生图计划；treatment 决定 node bleed 策略 |
| `dropped` | object[] | 每条含 from/text/reason/movedToNotes | 保真审计：被删内容必须可追溯；未映射项必须出现在这里 |

### 3.4 压缩规则（写进 SYSTEM.md 的硬规则）

1. **一页一 message**：message 只写结论，不写背景；超过 24 字先删修饰语，不许换行硬塞。
2. **supporting 只在增加信息时存在**：能合并进 message 就不写；三行 supporting 一律视为失败。
3. **事实走 facts/data**：数字、口径、单位进结构化字段；正文不再出现「2025 年…亿元，增长 5.5%」这类完整句。
4. **细节进 speakerNotes**：草稿里被压缩掉的解释、来源、限定条件，全部搬进讲稿；`dropped` 里标 `movedToNotes`。
5. **制作元数据禁上页**：`全篇/页数/时长/板块配比/平均每页/受众：/共 N 页` 一律剔除，只允许进 `deck` 元数据。
6. **保真审计**：每个草稿 point 必须映射到 message/supporting/facts/notes 之一；未映射项进 `dropped[]`，UI 或日志可见。
7. **不发明数字**：数字必须来自草稿或 `source`；口径不一致时写 `warnings`，不得换算成倍数。
8. **用户可见的压缩结果**：生成前给一张轻量 storyboard 预览（每页 message + facts + “已移入讲稿 N 条”）；用户可退回草稿页改内容，草稿 hash 变化后 editor 重跑。不能出现“用户不知道细节去哪了”。

### 3.5 验收

- schema 校验通过；`message` 预算、`supporting`/`facts` 上限、`speakerNotes` 长度全部达标。
- 元数据正则 0 命中；`dropped[]` 覆盖所有未映射 point；数字与草稿一致（diff 抽查 100%）。
- 同一份草稿连续跑 3 次：页数一致，message 不得出现“每次都换一种说法”的事实漂移（数字/年份一致）。
- 人工抽检 10 页：每页能在 3 秒内说出 message；supporting 不重复 message。

---

## 4. 排版语法 v2

### 4.1 设计原则

1. **只给 token，不给像素**：字号/间距/颜色全部走主题 token；agent 不能写 `32pt`、`#493432`。
2. **槽位而非盒子**：页面是 12×8 栅格，节点声明 `slot`；不再从固定标题带开始切。
3. **composition 是配方**：页面先声明 `immersive / hero-data / editorial / swiss / poster / chapter`，引擎按配方给默认栅格、边距、标题处理和图片策略；layouter 只在配方内填槽。
4. **bleed 是一等公民**：图片/色块可出血到画布边缘；文字不能出安全区。
5. **内容自适应**：`fit: "content"` 的组按内容高度收缩；`fit: "fill"` 才拉伸。组件默认 content-fit，不再“永远撑满整块”。
6. **每页一个视觉锚点（emphasis）**：hero 数字 / 大图 / 引语 / 图表；锚点缺失计缺陷（不新增 `anchor` 字段，沿用 `emphasis`）。
7. **v1 兼容**：`version` 缺省 = 1，旧树照常编译；v2 通过 `version: 2` 显式启用。

### 4.2 页面与栅格

```jsonc
{
  "version": 2,
  "id": "page-02",
  "composition": "hero-data",
  "safeArea": "content",          // content | full；full 时栅格从画布 0,0 起
  "background": "#f6f7f8",
  "grid": { "cols": 12, "rows": 8, "gutter": 24, "rowGutter": 16, "margin": 64 },
  "footer": { "left": "数据来源：…", "pageNumbers": true, "tone": "muted" },
  "nodes": []
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `version` | 2 | 1 | 2 = 新语法 |
| `composition` | enum | 必填 | 见 §4.4 |
| `safeArea` | content/full | content | full 用于满版配方 |
| `background` | hex | 主题 background | 只允许主题色板内色值 |
| `grid.cols/rows` | int | 12/8 | 栅格 |
| `grid.gutter/rowGutter` | px token | 24/16 | 4 的倍数 |
| `grid.margin` | px token | 64 | 32~96 |
| `footer` | object | 无 | left/center/right + pageNumbers + tone |
| 优先级 | — | — | page.grid 覆盖 theme.grid；page 未写 grid 时用 theme；layout 节点不写像素 |

### 4.3 节点语法

**槽位与出血**

```jsonc
{ "slot": { "col": [1, 8], "row": [2, 4] }, "bleed": ["right", "top"] }
```

- `col/row` 为闭区间，1 起；`bleed` 支持 `true | "left" | "right" | "top" | "bottom" | "x" | "y" | 数组`。
- 槽位越界、bleed 后超出画布：validate 报 `slot_out_of_range`。

**文本**

```jsonc
{
  "type": "text",
  "token": "hero",                  // display/hero/h1/h2/h3/lead/body/label/kicker/caption
  "runs": [
    { "text": "2.7", "token": "hero", "bold": true, "tone": "primary" },
    { "text": " 亿元", "token": "lead", "bold": true, "tone": "muted" }
  ],
  "tone": "text",                   // text|muted|primary|accent|inverse|inverseMuted
  "align": "left",
  "valign": "top",
  "lineHeightPct": 100,             // 80~160
  "letterSpacing": 0,               // -2~8pt
  "fit": "none",                    // none|shrink|ellipsis
  "maxLines": 2,
  "slot": { "col": [1, 4], "row": [4, 6] }
}
```

| 字段 | 约束 | 说明 |
|---|---|---|
| `token` | 主题 typeScale 内 | 唯一字号来源；不再接受任意 pt |
| `runs` | ≤8 段 | 行内混排：主色/加粗/衬线/字号 token |
| `paragraphs` | ≤4 段 | 多段文本（hero+label 两段结构用它，等价于多个 run 段落） |
| `spaceBeforePt` | 0~96 | 段落前距；与 `lineHeightPct` 一起控制排印 |
| `tone` | 语义档（见下表） | 颜色只从语义档取 |
| `font` | heading/body/serif | run 级可选；serif 只给引语/年代 |
| `lineHeightPct` | 80~160 | 中文正文默认 120；大标题 100 |
| `fit` | none/shrink/ellipsis | 缺省 none，**不允许静默降字号**；shrink 只能降到该 token 的 floor |
| `maxLines` | 1~4 | 配合 ellipsis；用于 kicker/脚注 |

**tone 语义档**（禁止裸色号；`tone:` 前缀可用于 shape fill/stroke 与 chart colors）：

| tone | 取色 |
|---|---|
| `text` / `muted` | theme.text / theme.textMuted |
| `primary` / `accent` | theme.primary / theme.accent |
| `inverse` / `inverseMuted` | theme.onDarkText / 其向暗底混合 |
| `surface` / `primarySoft` / `divider` | theme.cardSurface / 主色浅档 / theme.divider |
| `chart1`~`chart6` | theme.colors.chartSeries[n] |

**文案绑定**：text 的 `text` / run.text 支持 `@source`、`@kicker`、`@message`，从 storyboard 的 `copy` 取值——页面 JSON 不手抄来源，改一处处处生效。

**图片**

```jsonc
{
  "type": "image",
  "url": "everroom-material://…",
  "fit": "cover",
  "focus": { "x": 38, "y": 55 },
  "caption": "蛇口 · 1979",
  "grayscale": false,
  "duotone": false,
  "slot": { "col": [8, 12], "row": [1, 6] },
  "bleed": ["right", "top"]
}
```

- `contain` 校验 AR 偏差 ≤15%；`cover` 必须有 `focus`，且框 AR 与素材 AR 偏差 >40% 时报警（不再静默条带化）。
- `caption` 生成压图小字签；同一图不叠加第二次图注。

**stats**

```jsonc
{ "type": "stats", "items": [
  { "value": "2.83", "unit": "万亿元", "label": "2020 年 GDP" },
  { "value": "21.38", "unit": "万元", "label": "2025 年人均 GDP" }
], "slot": { "col": [9, 12], "row": [2, 6] } }
```

- `items` 2~4 条；数值用 `h2` token、标签用 `caption`；一列或一行由 slot 比例决定。layouter 不再把 KPI 手写成自由 text。

**形状 / 图表 / 页脚**

```jsonc
{ "type": "shape", "shape": "roundRect", "fill": "tone:primarySoft", "stroke": { "color": "tone:divider", "widthPt": 1 }, "radius": true, "slot": {} }
{ "type": "chart", "kind": "bar", "categories": [], "series": [], "colors": ["tone:chart1"], "pointColors": [], "dataLabels": true, "legend": false, "gridlines": false, "axis": { "labelSize": "caption", "ticks": 4, "hideY": false }, "slot": {} }
```

- `fill/stroke/colors` 允许 `tone:` 语法，禁止裸色号（主题内例外）。
- shape 额外字段：`gradient`（2~3 stops，pos 0~1，含 alpha）、`stroke`、`radius`（按主题圆角换算 adj）。
- `chart.axis.labelSize/ticks/hideY/gridlines` 是新增的引擎字段（genoffice page-spec 目前只有 series 颜色），落地前先补 `parsePageSpec` 与 chart 写出。
- `footer`：`{ left?, center?, right?, pageNumbers?, tone? }`；`left/center/right` 支持 `@source` 等绑定；满版页 `tone:"inverse"`。

### 4.4 Composition 配方（引擎执行）

| composition | 栅格/边距 | 标题处理 | 图片策略 | 允许的节点 | 典型页 |
|---|---|---|---|---|---|
| `immersive` | 内容栅格；图片/色块节点 bleed 到画布 | 无固定标题带；message 压暗部 | 必须一张 full-bleed 图 + 纱罩 | 图、1 个 message、≤1 supporting、页脚 | 封面/收尾 |
| `hero-data` | 7/5 或 8/4 非对称 | 无标题带；kicker+message 左上 | 无图或小证据图 | 2 个 hero 数字、≤4 stats（stats 节点）、1 个 chart/table、1 句结论 | 数据页/KPI 页 |
| `editorial` | 7/5 或 6/6；可单边出血 | kicker+message；允许 serif 引语 | 侧图可 top/right bleed | 图、引语、≤3 条 labeled facts、1 个 chart | 叙事/观点 |
| `swiss` | 12 列严格等分；标题带可选 | 标题带（title/message） | 图只占整列 | 3/6/9 列模块、表格、图表 | 对比/流程 |
| `poster` | full 或大留白；文字锚定 | 一句超大字/一个超大数字 | 无图或整版色块 | 1 message（≥48pt）、≤1 supporting | 章节/金句 |
| `chapter` | full 深底；章节号+标题 | 无标题带 | 深底+主色光斑/图 | 章节号、title、1 行说明 | 章节分隔 |

落地方式：`composition` 在 `layout-contract.ts` 里映射为机器可读的 `LayoutRecipe`（见 `golden-sample/recipes.json`：safeArea / titleBand / requires / maxProse / anchor）。layouter 只能选 recipe 内的槽位；validate 逐条检查 `requires`（如 immersive 必须有一个 bleed 图片节点、hero-data 必须有 ≥64pt 的 hero 文字或图表、editorial 必须有图片 + 一级标题），并检查 `maxProse`。

### 4.5 编译语义

- `slot → frame`：`cw = (area.w-(cols-1)*gutter)/cols`，`rh = (area.h-(rows-1)*rowGutter)/rows`；取整到 4px 网格（v2 修正当前 `Math.round` 造成的奇数像素）。
- `bleed`：按边扩展到画布；与 `safeArea` 无关。
- `fit:"content"`：先量内容自然高（text 用字形测量，image 用 AR），再在父容器里按 justify 落位；`fit:"fill"` 才均分。
- 字号：只从 `typeScale` 取；`shrink` 仅在显式声明时启用，且不得低于 token floor（caption 10 / body 16 / label 12 / h3 24 / h2 30 / h1 36 / hero 64 / display 48）。
- 对比度：文字/背景、图表标签/背景、表格文字/底色统一走 WCAG 4.5:1（大字号 3:1）；深色主题自动切 dark token（含图表轴/标签）。
- 页脚：统一在安全区下方 16px，左侧来源、中间品牌、右侧页码；满版页 footer 用 `tone: inverse`。

### 4.6 校验与缺陷

`slides_layout_validate` 增加 v2 检查，缺陷分 blocking / warning：

| 缺陷 | 级别 | 处理 |
|---|---|---|
| `token_invalid` | blocking | 提交拒收，模型重交 |
| `slot_out_of_range` | blocking | 拒收 |
| `text_overflow`（measured） | blocking | 拒收；不许静默 shrink |
| `overlap` / `emoji` / `canvas` | blocking | 沿用现有 |
| `contrast` | blocking（文字）/ warning（图表） | 深色主题自动换 token 后再判 |
| `emphasis_missing` | warning | 该页无与 emphasis 匹配的视觉锚点 |
| `image_ar`（含 cover 偏差 >40%） | warning/blocking（contain） | 提示换槽或换图 |
| `composition_mismatch` | warning | 页面的锚点/密度与 recipe 不符 |
| `copy_over_budget` | blocking | 来自 editor/storyboard 的文案超预算 |

### 4.7 v1 → v2 兼容

- `normalizeTree` 按 `version` 分流；v1 保持现有字段与编译结果（快照测试锁死）。
- v2 新增字段先只对 `version:2` 生效；theme 的 `typeScale` 缺省从现 sizes 推导，保证旧主题可用。
- 组件库继续可复用；v2 组件增加 `variant`（如 stats `row/stack`、timeline `spine/rail`）和 `fit:"content"`。

### 4.8 验收

- 快照：同一 v2 页面 JSON 编译出的 PageSpec 稳定（CI 比对）。
- 溢出：100 页随机文案 fixture，`text_overflow` 为 0（不允许“能装下但裁字”）。
- token：所有 text 节点的 token 在 typeScale 内；body 字号 ≥16（table 12、caption 10 例外）。
- 占墨：非满版页 3~30%；满版页过对比度。
- 元素：≤48/页、图 ≤8、path ≤4；超限直接拒收。
- v1 回归：`tree.test.ts` 全绿，旧 deck 可编辑。

---

## 5. Storyboard：编辑层与排版层的契约

### 5.1 为什么需要

现在 planner 的 `role/density` 只是输入字段，layouter「消化」但不执行；composition 只是一句提示。Storyboard 把「这页要说什么、给谁看、用什么视觉锚点、什么构图」变成结构化契约，让 layouter/style/reviewer 共用同一份意图，避免各说各话。

### 5.2 字段

见 §3.2。storyboard 由 `slides-editor` 产出，`slides-planner(arrange)` 退役。`deck.visualThesis` 进入 style 阶段，`pages[].composition/emphasis/density` 进入 layouter，`copy` 进入版式与审页，`dropped/speakerNotes` 进入保真审计。

### 5.3 Layouter 输入变化

```jsonc
{
  "task": "layout",
  "deckToken": "…",
  "pageIndex": 1,
  "totalPages": 12,
  "composition": "hero-data",
  "emphasis": "number",
  "density": "dense",
  "copy": { "kicker": "…", "message": "…", "supporting": [], "facts": [...], "source": "…" },
  "data": { "chart": {...}, "stats": [...] },
  "visual": { "kind": "none" },
  "neighbors": [
    { "pageIndex": 0, "composition": "immersive", "takeaway": "…" },
    { "pageIndex": 2, "composition": "editorial", "takeaway": "…" }
  ],
  "styleBrief": "极简人文；主色…；标题…；页脚…",
  "budget": { "prose": 60, "copy": 120, "notes": 260 },
  "deckTypeScale": { "display": 56, "hero": 72, "body": 16, "caption": 10 }
}
```

约束：

- 不传原始 `points` 长文（防止小字墙回潮）；不传 `notes` 方向建议（storyboard 已结构化）。
- `neighbors` 只给 composition/takeaway，不给完整内容；避免同构，但不泄露隐私。
- `styleBrief` 从风格卡生成，包含色号/字号/构图的可执行描述，不再只是 400 字散文。

### 5.4 Reviewer 变化

- 输入：截图 + storyboard 的 intent/takeaway/composition/emphasis + `budget:{prose,copy,notes}`（与生成侧同一份预算对象，字段名固定）。
- 权限：改树；不能改文案/风格/图；发现“文案超预算/构图不符”时提交 `request_editor`（打回 editor），而不是硬排。
- 每页最多一次修正；审页覆盖率 100%、单页超时 ≤5%、失败降级到“保留原页 + warning”；review 阶段有独立时间预算，不占生成主预算。

### 5.5 验收

- 同一 storyboard 喂给 layouter 3 次：composition 一致；相邻页不出现同构树（签名对比）。
- 换 `composition` 字段（其余不变）：页面结构必须变化（fixture 断言）。
- storyboard schema 校验 100%；`message/takeaway` 预算违规为 0。
- 人工抽检：给 5 个人看 10 页，能复述 message 的比例 ≥80%。

---

## 6. 总验收标准（可直接变成 CI / 人工清单）

### 6.1 内容与 storyboard

| # | 标准 | 阈值 | 检查方式 |
|---|---|---|---|
| C1 | message 长度 | ≤24 字（封面 ≤20） | schema + regex |
| C2 | supporting | ≤1 条、≤32 字 | schema |
| C3 | facts | ≤3 条；label ≤10、value/body ≤14 | schema |
| C4 | speakerNotes | 60~260 字/页 | schema |
| C5 | 页面叙事文字（message+supporting+quote，不含 facts/source/labels） | 封面 ≤60、内容 ≤80、数据 ≤60 字 | 统计 |
| C6 | 制作元数据 | 0 命中 | 正则 |
| C7 | 保真 | 每个 draft point 有映射或 dropped；数字一致 | diff 脚本 |
| C8 | composition | ≥8 页 deck ≥3 种；相邻不同；≥8 页 deck ≥2 页 sparse | schema + 检查器 |
| C9 | 意图完整 | 每页 intent/takeaway/emphasis 必填 | schema |

### 6.2 排版

| # | 标准 | 阈值 | 检查方式 |
|---|---|---|---|
| L1 | 文字只用 type token | 100% | validate |
| L2 | body 字号 | ≥16pt（table 12、caption 10 例外） | validate |
| L3 | 溢出/重叠/裁字 | 0 | measure + 截图目检 |
| L4 | 元素/图/path | ≤48 / ≤8 / ≤4 | validate |
| L5 | 非满版页占墨 | 3~30%（满版页单独判） | 渲染统计 |
| L6 | 视觉锚点（emphasis） | 每页 ≥1 个（图片/图表 ≥12% 面积或文字 ≥48pt） | validate |
| L7 | 图片 AR | contain ≤15%；cover 有 focus 且偏差 >40% 报警 | validate |
| L8 | 图表可读 | 轴/标签 ≥10pt；刻度 ≤6；网格默认关（M4 引擎 token 后生效） | 引擎 + 截图 |
| L9 | 页脚 | 满版页 inverse；有 source 的页在页面或 footer 呈现 | validate |

### 6.3 质量与工程

| # | 标准 | 阈值 | 检查方式 |
|---|---|---|---|
| Q1 | 盲测偏好 | 5 个 deck × 3 位评审 = 15 次配对，顺序随机，平票剔除；有效判定 ≥10 且新方案 ≥70% 胜出 | 盲评 |
| Q2 | 视觉 rubric | 每页 ≥4/5（层级/留白/图文/可读） | 评审表 |
| Q3 | 失败兜底 | <2% 页；兜底不丢 message/facts | 日志 + 文本 diff |
| Q4 | 审页覆盖 | 100%（每页有 reviewer 记录） | sqlite 查询 |
| Q5 | 审页超时 | <5% 页 | sqlite |
| Q6 | 生成时长 | editor 与 style 并行；p95 ≤ 当前 ×1.25（同步兜底 45s） | 埋点 |
| Q7 | v1 回归 | 现有 tree 测试全绿；旧 deck 可编辑 | CI |
| Q8 | 数字正确 | 与草稿/来源一致；口径标注 | 抽查 100% 数据页 |

### 6.4 Golden benchmark（建议）

- 固定 5 个主题（城市/产品/融资/研究/文化），每个 8~12 页。
- 每套跑 3 次：current / new / human-fork，乱序盲评。
- 记录：文案字数、占墨、composition 分布、缺陷数、时长、fallback、review 覆盖。
- 新方案连续 2 个版本达标才允许替换默认链路；回退走装配层开关，不放 `.env`。

---

## 7. 3 页黄金样张（方向验证）

位置：[golden-sample](../materials/ppt-style-experiments/golden-sample/README.md)；对照页 [compare.html](../materials/ppt-style-experiments/golden-sample/compare.html)；配方 [recipes.json](../materials/ppt-style-experiments/golden-sample/recipes.json)；现状基线 [current-plan.json](../materials/ppt-style-experiments/golden-sample/current/current-plan.json)。

| 页 | composition | 现状页面文字 | 样张页面文字 | 验证点 |
|---|---|---|---|---|
| 封面 | immersive | 151 字（points） | prose 41 / copy 80 | full-bleed + 纱罩 + 标题压暗部；无固定标题带 |
| 数据（GDP） | hero-data | 214 字（points） | prose 17 / copy 115 | 72pt hero 数字 + stats 节点；不用图表的理由见 §7 说明 |
| 叙事（蛇口） | editorial | 132 字（points） | prose 17 / copy 90 | kicker + 40pt 主张 + 32pt 引语 + 3 条标签事实；图片右侧 bleed、顶部与主张对齐 |

样张由 `compile-v2.mts` 调用真实 genoffice 生成；`out/report.json` 通过全部内容/storyboard/recipe 检查；占墨 4.0% / 21.5%（数据/叙事页，目标 3~30%）。样张证明了：

1. 同样的素材与主题，只靠「压缩文案 + type token + slot + bleed」就能明显提升层级与呼吸感。
2. storyboard 的 composition/intent/copy 能直接驱动版面（3 页 3 种配方，`recipes.json` 可机器校验）。
3. 内容预算可以在生成前被机器检查（`[PASS]/[FAIL]`），不依赖人肉目检。

**数据页为什么不用图表**：2020 与 2025 只有两个可比点，柱图作为“45 年跨越”的证据会与 1980 的起点混淆；按“图表只在支撑 message 时使用”的原则，改为 hero 数字 + stats 列。图表语法仍在 §4.3/§4.4，但样张不为了展示组件而放图表。

**数字怎么复现**：`current/current-plan.json` 是从 gateway.sqlite 取出的生成前 plan（points/data），[count-copy.mts](../materials/ppt-style-experiments/golden-sample/count-copy.mts) 输出 `out/count.json`；151/214/132 是 points 字符数，41/17/17 是 storyboard 的叙事文字（message+supporting+quote），不是目测。`out/report.json` 的 `checks` 是逐项实际检查结果，不是硬编码标签。

**样张没有证明**：`fit:"content"`/`page.grid` 覆盖（仍未实现）、5 套 deck 盲评、serif 在 PowerPoint 的最终表现（LibreOffice 预览已确认把 Songti 回退为 Hiragino，需加字体 fallback gate）。图表轴 token 与 PPTX notes 已在 M4 实现，生产样本可验证。

---

## 8. 实施计划

### M0（本次，0.5 天）：设计与样张

- 本设计文档；3 页 golden sample；验收报告；用户/团队确认方向。
- 产物：`docs/slides-quality-upgrade-design.zh-CN.md`、`materials/.../golden-sample/`。

### M1（3 天）：内容压缩

- 新增 `agents/slides-editor/`（SYSTEM.md、agent.yaml、schemas）。
- `tools.ts`：draft 确认后调用 editor（可与 style 并行），storyboard 落 `slides_storyboards` 表；generate 读取。
- 预算/元数据/保真检查器 + `dropped[]` 展示；`speakerNotes` 存 plan。
- 影子模式：同一草稿跑 current/new 两版，先只记录差异，不替换默认链路。
- 验收：C1~C9；3 次重复事实不漂移。

### M1 落地记录（2026-10-19，影子模式）

- 新增 `agents/slides-editor/`（SYSTEM.md / agent.yaml / input+output schema）：把用户确认的 draftPages 压成 `storyboard/v2`。
- 新增 `apps/gateway/src/modules/subagents/slides-editor.ts`：结构归一 + C1~C9 确定性检查 + shadow report。
- 新增 `slides_storyboards` 表（migration `0082_slides_storyboards`）与 `slides-storyboards-store.ts`：按草稿 + 内容 hash 覆盖保存。
- `tools.ts` generate 分支：与 arrange/落页并行调度 editor，结果挂到最终返回的 `details.storyboardShadow`；**不替换现有 plan**（影子）。
- 开关：无 `.env` 开关；装配层默认传入 `slidesEditor` 即启用影子，不改变可见产物。关闭只需在 `create-server.ts` 不传该项（后续做应用内灰度开关，而不是环境变量）。
- 测试：`apps/gateway/tests/slides-editor.test.ts`（6 项，含迁移建表/幂等覆盖）。
- 验证：重启网关（加载新 agent 与 migration）后走一次 draft→style→generate，再查
  `select draft_hash, json_extract(report,'$.passed') from slides_storyboards;`；
  tool 返回的 `details.storyboardShadow` 里有逐页 prose/copy/dropped/errors。
- 2026-10-19 真机修复：editor 90s 从 12 页 plan 压缩必超时（DB 两条 timed_out 均 90s）；改为 `timeoutSeconds:420` / `maxToolCalls:8`，超时只回退 v1，tool content 只报 `storyboard.applied:false`，不把内部错误当用户可见失败。
- 下一步 M2：把 storyboard 的 composition/copy 接进 layouter；M3 再切默认链路。

### M2（4 天）：排版语法 v2

- `tree/schema.ts` 加 v2 字段；`compile.ts` 支持 slot/bleed/fit/runs/typeScale；`theme.ts` 加 typeScale + chart tokens；`layout-contract.ts` 加 recipe。
- `slides-layouter` SYSTEM/skill/schema 更新；v1 兼容与快照测试。
- 验收：L1~L7、L9（L8 轴 token 在 M4）；v1 测试全绿。

### M2 落地记录（2026-10-19，引擎侧）

- `theme.ts` 增加 `TYPE_TOKENS` / `TypeToken` 与 `ResolvedTheme.typeScale`，由旧 `sizes` 确定性推导，可由 `styleParams.typography.typeScale` 覆盖；styler 输出 schema 与 `normalizeStyleParams` 已支持可选 `typeScale`。
- 新增 `tree/v2/schema.ts`（slot/grid/bleed/token/runs/stats/chart/recipe 归一与硬约束）与 `tree/v2/compile.ts`（slot→frame、bleed、type token、runs、stats、footer → PageSpec）。
- `normalizeTree` 支持 `version:2`；`compileTree` 分叉到 v2；`measure` 增加 v2 flexible 豁免与 v2 shrink no-op；`similarity` 增加 v2 签名。
- v1 零改动：`tree.test.ts` 119 项全过；v2 新增 8 项（cover/data/editorial、recipe 拒收、slot/token 越界、typeScale 覆盖、签名）。
- 生产链路验证：`golden-sample/build-production.mts` 用生产 v2 编译器重编 3 页并渲染到 `out/render-production/`。
- 引擎侧验收：L1/L2/L3/L4/L6/L7 有单测或夹具（token 唯一、body≥16、溢出/重叠、元素上限、锚点、contain AR）；L5 占墨与 L9 页脚需真实 deck 渲染，M3 回归。
- 未做（按计划到 M3/M4）：layouter 的 v2 prompt/skill 切换（需要 storyboard 提供 copy）、chart.axis 主题 token、`fit:"content"`、`page.grid` 覆盖（引擎已有字段，后续接）。

### M3（3.5 天）：Storyboard 接线

- `slides-layout-tail.ts`：layouter 输入换成 storyboard+copy+neighbors；composition recipe 选择；相似度/重排按 composition 判断。
- reviewer 输入加 storyboard；`request_editor` 回路；审页预算与覆盖率埋点。
- 验收：§5.5；Q3/Q4/Q5。

### M3 落地记录（2026-10-19，storyboard 接线）

- layouter/reviewer 新增 `layout-tree-v2-skill`；SYSTEM 按输入 `layoutVersion:2` 分派 v2，v1 不变。
- layouter input：`layoutVersion` / `composition` / `emphasis` / `intent` / `takeaway` / `copy` / `neighbors` / `budget`；reviewer input 同步加 `layoutVersion/composition/emphasis/budget`。
- `slides-layout-tail`：v2 页面走 `layouterInputFor` v2 分支（不传 points）、`trimmedPage` 保留 storyboard、reviewer 修订降回 v1 直接拒收；v2 树编译/量测沿用 M2。
- `tools.ts`：`dispatchBuilderTail` 先让 editor 对 **planner arrange 的 plan** 压缩（保留 materials/points 作兜底），`mergeStoryboardIntoPlan` 生成 v2 plan；editor 失败/页数不一致回退 v1；storyboard/report 落库并挂到 `details.storyboard`。
- 默认 active（create-server 传入 `slidesEditor.active:true`），无 `.env` 开关；单页 v2 失败仍走 v1 兜底，不阻断整册。
- 测试：`subagent-tools` 47（含 active storyboard 全链路）、`slides-layout-tail` 9（含 v2 input）、`slides-editor` 9（含 merge）、v2 8、v1 119 全过。
- 未做（M4）：reviewer 的 `request_editor` 回打、图片 AR/主体质检、chart axis token、`fit:"content"`、真实 5 套 deck 盲评。

### M4 落地记录（2026-10-19，分批）

> Nexwing BP 真机对标差距的完整证据与修复清单见 [slides-nexwing-reference-gap.zh-CN.md](./slides-nexwing-reference-gap.zh-CN.md)。

- **chart token**：`page-spec` 的 `SpecChart.axis` + `chart-insert` 动态 axis/legend/data-label 字体与颜色；gateway `elements.ts` / v1 `renderChartLeaf` / v2 `compile` 统一传主题 token。实测图表 XML：label 10pt、`6F6663`、`D7D4D4`。
- **PPTX notes**：`PageSpec.notes` + `pptx-engine#setSlideNotes`；v2 页面 `notes` 从 `copy.speakerNotes` 透传；`golden-production.pptx` 已生成 notesSlide（可解压验证）。
- **图片 AR**：`measure` 对 cover 框与素材 AR 偏差 >40% 报 `image_ar` warning（不再静默条带化）；v2 flexible 槽位仍允许小图。
- **图片确定性 QC**：新增 `slides-image-qc.ts`（分辨率/全黑/全白/纯色/颜色过少），接进 `generateSlidesPageImages` 与后台 runner；不通过该页不落图、计入 failed。
- **图片 VLM 切题 QC**：新增 `slides-image-vlm-qc.ts`，复用网关 VLM 通道；score ≤2 拒图、score 3 记 warning、未配置 VLM 时放行；接进同步生图与后台 runner。
- **字体 stack 归一**：`primaryFontFamily` 把 `"Songti SC, Georgia"` 归一成 `"Songti SC"`，避免 OOXML 把整串当字体名；`page.grid` 覆盖已有 v2 测试。
- **盲评 harness**：`golden-benchmark/` 用 5 套主题变体 × 3 页重编/渲染，输出 `blind.html`、`review.csv`、`metrics.json`、`key.json`；真实 5 套题材 deck 可按 fixtures 结构接入。
- 测试：v2 10、v1 119、layout-tail 9、subagent-tools 48、editor 9、image QC 3、VLM QC 4、page-images 10、theme 2 全过；chart XML、notesSlide、盲评渲染已人工/脚本验证。
- 未做/边界：5 套真实题材 deck 的模型生成 + 人工盲评（harness 已就绪）、`fit:"content"`（v2 slot 语法用 slot 尺寸替代内容撑开，不再实现自由 flex）、serif 在 PowerPoint 的最终字体检查。

### M4（4.5 天）：质感与资产

- genoffice：chart axis/label/grid token、PPTX notes；image AR-aware 槽位 + VLM 主体/清晰度质检 + focus 默认。
- golden benchmark harness（5 套 × 3 次盲评）；CI 指标看板。
- 验收：Q1/Q2/Q6/Q7/Q8。

总计约 15 人天（1~2 人并行可压到 2 周）。M1 可独立上线（只改文案），M2 是主收益，M3 保证不倒退。

---

## 9. 风险与决策点

| 风险 | 影响 | 缓解 |
|---|---|---|
| editor 压缩过头，丢信息 | 用户不满 | `dropped[]` + speakerNotes + 用户确认卡；先影子模式对比 |
| 模型不守预算 | 页面仍密 | schema 拒收 + 重试 1 次 + editor 降级（保守压缩规则） |
| v2 语法复杂，layouter 学不会 | 收敛率下降 | recipe 收窄 choose；skill 只写「填槽」；validate 报错带 path/hint |
| composition 变成新模板 | 页页一样 | 每配方 ≥2 个栅格变体；相邻检查；benchmark 卡同构 |
| 字体/LibreOffice 回退 | 预览与 PowerPoint 不一致 | 用 PowerPoint 验收字体；记录 fallback 字体；serif 只用于引语 |
| 图表轴 token 要改引擎 | 数据页仍普通 | M4 单独排期；M2 先用「无网格/单系列/直接标注」降风险 |
| 生成时长增加 | 体验 | editor 与 style 并行；storyboard 缓存；layouter 只填槽更快 |
| 旧 deck 不兼容 | 回归 | v1 分流 + 快照测试；装配层开关回退 |

需要拍板的决策：

1. editor 是独立子代理，还是 planner 的第三阶段？（建议独立：prompt/预算/失败降级都更清晰）
2. 是否允许 storyboard 在 UI 上给用户预览（3-up 缩略图）再生成？（建议 M3 做轻量预览）
3. composition 首版做 4 个（immersive/hero-data/editorial/swiss）还是 6 个？（建议先 4，poster/chapter 复用 immersive）
4. 图表轴 token 是否值得改 genoffice，还是数据页统一走「大数字 + stats 列」？（建议：数据页默认 hero-data 不用图表；图表 token 仍排 M4，用于真正需要图表的页）
5. speakerNotes 是否进 PPTX（需要引擎 notes），还是先存应用内讲稿视图？（建议先存 plan，PPTX 后置）

---

## 附录 A：storyboard 最小示例

```jsonc
{
  "schemaVersion": "storyboard/v2",
  "deck": { "title": "…", "audience": "…", "occasion": "…", "durationMin": 15, "spine": "…", "visualThesis": "…" },
  "pages": [{
    "id": "page-02", "role": "data", "composition": "hero-data", "density": "dense", "emphasis": "number",
    "intent": "用一个量级跨越建立规模的事实底座。",
    "takeaway": "四十五年，经济量级已完全不同。",
    "copy": {
      "kicker": "45 年 · 经济总量",
      "message": "从 2.7 亿到 3.87 万亿元",
      "supporting": [],
      "facts": [
        { "label": "1980 年 GDP", "value": "2.7", "unit": "亿元", "note": "期初口径" },
        { "label": "2025 年 GDP", "value": "3.87", "unit": "万亿元", "note": "初步统计" }
      ],
      "source": "数据来源：深圳市 2025 年统计公报。",
      "speakerNotes": "这一页只让听众记住两个量级……"
    },
    "data": { "chart": { "kind": "bar", "categories": ["2020 年", "2025 年"], "series": [{ "name": "GDP", "values": [2.83, 3.87] }] } },
    "visual": { "kind": "none" },
    "dropped": []
  }]
}
```

## 附录 B：v2 页面最小示例

```jsonc
{
  "version": 2, "id": "page-02", "composition": "hero-data", "safeArea": "content", "background": "#f6f7f8",
  "grid": { "cols": 12, "rows": 8, "gutter": 24, "rowGutter": 16, "margin": 64 },
  "footer": { "pageNumbers": true },
  "nodes": [
    { "type": "text", "token": "kicker", "text": "45 年 · 经济总量", "tone": "primary", "letterSpacing": 2,
      "slot": { "col": [1, 6], "row": [1, 1] } },
    { "type": "text", "token": "hero",
      "runs": [
        { "text": "2.7", "token": "hero", "bold": true, "tone": "primary" },
        { "text": " 亿元", "token": "lead", "bold": true, "tone": "muted" }
      ],
      "slot": { "col": [1, 4], "row": [4, 6] } },
    { "type": "chart", "kind": "bar", "categories": ["2020 年", "2025 年"],
      "series": [{ "name": "GDP（万亿元）", "values": [2.83, 3.87] }],
      "colors": ["tone:chart1"], "dataLabels": true, "gridlines": false,
      "slot": { "col": [9, 12], "row": [2, 6] } }
  ]
}
```

## 附录 C：检查器规则（伪代码）

```text
for page in storyboard.pages:
  assert message.length <= 24
  assert supporting.length <= 1 and max(len) <= 32
  assert facts.length <= 3 and all(label <= 10, value <= 14)
  assert 60 <= speakerNotes.length <= 260
  assert not METADATA_RE.match(onSlideText)
  assert composition in COMPOSITIONS
  assert emphasis in EMPHASIS
assert distinct(composition for pages) >= 3 if len(pages) >= 10
assert all(adjacent.composition != composition)

for page in layout.pages:
  assert every text.token in theme.typeScale
  assert page.composition == storyboard.page.composition
  assert elementCount <= 48 and images <= 8
  assert no overflow/overlap/token_invalid
  assert nonBleedInk in [0.08, 0.30]
  assert emphasisAnchor(page) exists
```

## 2026-10-21 单一产出路径

- 同一套原子被四份文档抄写已经漂移：reviewer 的 v2 文档只写 27 个组件、缺 `group/connector/icon/path/table` 五节，而 layouter 正在产出这些节点。v2 语法升格为唯一技能，正文只在 `docs/slides-layout-tree-spec.zh-CN.md` 维护，两个 agent 的 `SKILL.md` 由脚本生成。
- `group.tree` 是「预想栅格不够用，先留一条旧语法通道」：通道存在，模型就会用；用一次就得永远同时维护两套词表。因此删除 `tree`，`group` 只放 v2 原生子节点。
- 兜底页原由 `fallbackTree` 产出 v1 树，这是 v1 技能存在的真实理由。兜底页改出 v2 页后，v1 只保留历史 deck 的读兼容，不再有写入路径。
