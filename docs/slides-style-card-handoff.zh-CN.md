# 风格卡交接审计：后面的 agent 拿到什么、组件里能体现多少、符不符合直觉

- 日期：2026-10-20
- 范围：slides-styler（生成风格卡）→ planner / editor / layouter / reviewer / builder → 27 个组件
- 视觉证据：[style-card-expressiveness](../materials/ppt-style-experiments/style-card-expressiveness/README.md)（同一批组件 × 4 张风格卡 × 真实渲染）

---

## 1. 一句话结论

**颜色、字体、字号、间距、装饰、母题、明暗**这些「机器字段」基本 100% 能落到组件里；**但不等于每个组件都体现所有字段**——组件只能表达与自己语义相关的子集（扁平的 quote 不会长卡面，没有图的团队卡不会体现 imageFit）。
交接上原本有三个反直觉断点：内容侧 agent 看不到风格卡、审页 agent 看不到 token、风格卡的 composition 不约束页面 composition。前两个已补上（`deckStyle` / `styleTokens`），第三个仍是「倾向」而非硬约束。

---

## 2. 风格卡到底包含什么

`StyleParams`（styler settle 产物，落在 `slides_style_sessions.styleParams`）：

| 组 | 字段 |
|---|---|
| palette | `background / surface / primary / accent / text / textMuted / onDarkText / chartSeries` |
| typography | `fontHeading / fontBody / sizes.* / typeScale.* / headingBold` |
| spacing | `margin / gutter / cardPadding / cornerRadius` |
| decoration | `cardStroke / cardStrokeWidthPt / cardShadow / divider / imageFit` |
| motif | `kind`（ghost-number / ghost-word / color-band / corner-accent / none）+ `spec` |
| 基调 | `composition`（swiss / editorial / poster / immersive）、`darkCover` |
| 用户面 | `effectLines`（5–8 条人话说明） |

**前端风格卡实际展示的**（`styleCardPayload`）：6 个色块、5 行排印信息（封面/页标题/正文/注释/字体）、3 张构图线框、演示页图、effectLines、warnings。
**没有展示但会驱动渲染的**：motif、darkCover、typeScale、cardStroke/Width/Shadow、divider、imageFit、componentDefaults。

---

## 3. 后面的 agent 各拿到什么

| Agent | 拿到的风格信息 | 拿不到 | 对结果的影响 |
|---|---|---|---|
| **主 Agent / UI** | 风格卡 payload：色块、字级、线框、演示页图、effectLines、警告 | 机器字段细节（motif/decoration/typeScale/componentDefaults） | 用户只能凭效果语言确认；可能和组件实际表现有偏差 |
| **slides-planner（arrange）** | `deckStyle`：composition / darkCover / motif / palette（primary·accent·background）；配色也用于生图调色板 | 字体、字号、间距、decoration、完整色板 | 内容编排与配图能对齐明暗/主色/构图倾向；不再产出与深色海报冲突的亮调图 |
| **slides-editor（storyboard）** | `deckStyle`（同上）+ instruction/受众/时长 | 字体、字号、间距、decoration；完整 palette | `composition` 会围绕 deck 的构图家族展开；但这是提示，不是硬校验 |
| **slides-layouter** | `styleBrief`（散文：构图倾向 + effectLines，≤400 字）+ **`styleTokens`**（palette/typeScale/fonts/spacing/decoration/motif/componentDefaults，≤1200 字符） | 风格卡线框图/演示页图/用户反馈历史 | 能按 token 选组件 style、排字号与明暗；两个信号（散文 vs token）可能冲突，token 为准 |
| **slides-reviewer** | 页面截图 + 页码/标题/role/density + manual（copy/data/currentTree）+ **`styleTokens`**（本次新增） | effectLines 散文、风格卡线框/演示页图；没有改文案权限 | 能判断「这页是否破坏风格卡」，并在修订时按 componentDefaults 做风格一致的局部变奏 |
| **slides-builder（edit）** | 现有 deck 大纲/页面；SYSTEM 要求沿用既有色板/字号/母题 | 风格卡对象 | 编辑时不重新定调；但无法知道原始风格卡 token，只能从现页反推 |
| **validate / measure** | `deckToken → contractFromStyleParams(styleParams)` 完整主题 | —— | 溢出、字号下限、对比度、元素上限等硬闸都按风格卡执行 |

> 本次补的两处：`planner/editor` 的 `deckStyle`、`reviewer` 的 `styleTokens`。layouter 的 `styleTokens` 之前已落地。

---

## 4. 每个字段在组件里能体现多少

图例：● 组件级直接可见；◐ 仅特定组件/特定条件下可见；○ 页面级或非组件消费。

| 字段 | 组件表达 | 说明 |
|---|---|---|
| `palette.background` | ◐ | 页面底色所有页生效；深底页用派生 `darkBackground`。组件自身不画页底 |
| `palette.surface` | ● | 卡面色；12 个「卡片语义」组件默认铺卡（featureCards/comparison/matrix/prosCons/quotes/teamGrid/persona/bento/layeredStack/pricingTiers/logoWall/callout） |
| `palette.primary` | ● | 结构强调：衬线序号、节点、图标、featured 顶条/CTA、图表主角 |
| `palette.accent` | ● | 唯一强调位：eyebrow 规则、刻标、星、target 刻度、featured 徽章；没有强调位的组件（如 cycle 环）不出现 |
| `palette.text / textMuted` | ● | 所有组件的标题/正文/注释 |
| `palette.onDarkText` | ◐ | 深色页、ink 反白卡、featured 反白档 |
| `palette.chartSeries` | ○ | 只服务 `chart` 叶子与 demo 页；27 组件里没有图表组件 |
| `typography.fontHeading/fontBody` | ● | 所有标题/数字/正文 run |
| `typography.sizes.*` | ◐ | v2 表格叶子、部分固定档；组件主字号已改由 typeScale + frame 推导 |
| `typography.typeScale` | ● | 组件 `metrics(frame)` 的字号锚点（display/title/body/label/serial） |
| `typography.headingBold` | ● | 所有 heading run |
| `spacing.margin` | ○ | 页面安全区；组件不透传 |
| `spacing.gutter / cardPadding` | ● | 组件 gap/pad（density 再乘系数） |
| `spacing.cornerRadius` | ◐ | 只有铺表面的组件；扁平组件不体现 |
| `decoration.cardStroke / Width / Shadow` | ◐ | 卡片语义组件 + 显式 `style.surface` 的组件 |
| `decoration.divider` | ● | 有分隔线的组件（stats/timeline/agenda/pointList/comparison/matrix/bento/layers/quotes/indexHeader/eraRail…）；`none` 时全部退为间距 |
| `decoration.imageFit` | ◐ | 有图槽的 6 个组件（featureCards/bento/teamGrid/quotes/persona/logoWall） |
| `motif.kind` | ◐ | 有底面的组件上的色带/角标/幽灵场；页级母题另由编译器统一铺；`spec` 只解释 side/width/alpha/size |
| `darkCover` | ○ | cover/section/closing 语义页确定性落深底；内容页不受影响 |
| `composition` | ◐ | 只推导组件默认 surface/density/numeral；页面 composition 由 editor/storyboard 决定 |
| `effectLines` | ○ | 只进风格卡 UI 与 styleBrief 散文，不参与渲染 |

**结论**：8 个 palette 字段里 7 个能进组件（chartSeries 例外）；typography 5 个里 4 个组件级生效（sizes 部分被 typeScale 取代）；spacing 4 个里 3 个进组件（margin 页面级）；decoration 5 个里 4 个组件级（divider 全量）；motif 1 个组件级；composition/darkCover 是页级或默认推导；effectLines 不渲染。

---

## 5. 符不符合直觉

### 符合直觉的部分

1. **换色板/字体/装饰，组件整体变样**：同一批组件在「暖纸编辑 / 冷灰瑞士 / 深色海报 / 卡片商务」四张卡下，字号、卡面、分隔、母题、明暗全部跟着变（见视觉证据）。
2. **风格卡不是皮，是设计系统**：layouter 拿 token 而不是色号猜；组件只写语义 style，引擎兜底溢出/对比度。
3. **深色卡真的会深**：darkCover 是确定性落深底，不靠 agent 自觉。
4. **卡片语言可开关**：卡面 token 缺失时，卡片语义组件会退成平铺，而不是硬画白卡。

### 反直觉 / 需要知道的断点

1. **风格卡的 `composition` 现在是「半硬约束」**：editor 至少 1 页核心构图、半数页落在家族内，否则重排一次；但不再要求每页同构（保留节奏变化）。
2. **风格卡 UI 已补机器字段摘要**：构图/明暗/母题/卡面/分隔/图片/视觉字号 7 行进入 payload 与前端；componentDefaults 仍未直接展示（组件文档承担）。
3. **散文 effectLines 与 token 仍双源**：文档已明确 token 为准，但还没有自动一致性检查；styler 写「无描边」而 decoration 有描边时仍可能误导读者。
4. **扁平组件不吃卡面默认值**：quote/timeline/stats 等即使风格卡有卡面 token，也默认平铺；只有显式 `style.surface` 才铺。这是设计选择，但和「整册卡片风」的直觉有落差。
5. **组件只表达语义子集**：没有强调位的组件看不到 accent，没有图的组件看不到 imageFit，没有分隔线的组件看不到 divider；这不是没生效，是组件不承载该语义。
6. **reviewer 现在能看到 token，但仍不能改文案**；它做的是「版式层的风格一致性」，不是重新设计风格。
7. **chartSeries / effectLines 永远不进组件**：前者只给图表叶子，后者只给人和散文。

---

## 6. 建议与落地状态（2026-10-20）

1. **把 composition 从提示升级为约束** —— ✅ 已落地：`checkStoryboard(storyboard, pages, { deckComposition })` 定义 4 个家族的允许集合；核心构图必须出现，且至少半数页落在家族内。不通过时 editor 只重排一次（`compositionFeedback` 回传），第二次仍不过才回退 v1。
2. **风格卡 UI 补机器字段** —— ✅ 已落地：`StyleCardPayload.details` 输出构图/明暗/母题/卡面/分隔/图片/视觉字号 7 行；前端 `SlidesProgressCard` 增加 `agent-slides-style-details` 行。
3. **统一风格语言入口** —— ✅ 已落地（文档层）：layouter SYSTEM/skill 明确 `styleTokens` 是像素口径唯一真源，`styleBrief` 只是叙事说明；冲突以 token 为准。
4. **reviewer 的 style 权限写清** —— ✅ 已落地：reviewer 输入新增 `styleTokens`；SYSTEM 允许按 componentDefaults 做局部变奏，但禁止换色/换字体/改文案。
5. **组件文档补「语义子集」** —— ✅ 已落地：v1/v2 skill 增加 27 组件 × surface/separator/accent/numeral/图槽 的对照表，并注明「没列出的组合是 no-op」。

### 仍未做（下一轮候选）

- 风格卡线框图与演示页图仍未进 layouter 输入（它们是用户面产物，机器侧用 tokens 已足够）。
- `effectLines` 与 token 的自动一致性检查（例如「无描边」却 cardStroke 非空）还没做；目前靠文档与人工。
- builder（edit）仍只能从现页反推风格卡，没有原始 `styleParams` 注入。

---

## 7. 视觉证据怎么读

[style-card-expressiveness](../materials/ppt-style-experiments/style-card-expressiveness/README.md)：4 行 = 4 张风格卡，6 列 = stats / timeline / featureCards / quote / pricingTiers / calloutBox。

- 第 1 行暖纸编辑：卡面 + 衬线 + 黄铜强调；
- 第 2 行冷灰瑞士：平铺、无圆角、蓝色强调、PingFang；
- 第 3 行深色海报：深底、超大字号、橙红强调、左侧色带；
- 第 4 行卡片商务：描边/柔影卡、藏蓝主色、角落母题。

同一组件在四行里的差异 > 同组件在不同内容下的差异——说明风格卡确实是组件视觉的主导变量；同时 quote/timeline 在任何卡下都保持扁平，印证「组件只表达语义子集」。
