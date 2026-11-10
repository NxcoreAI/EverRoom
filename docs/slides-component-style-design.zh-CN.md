# PPT 组件风格化设计：像前端组件一样可调，同时让风格卡真正落到组件里

- 日期：2026-10-19
- 状态：实施稿
- 范围：`apps/gateway/src/modules/slides-layout/tree/components/*`、`theme.ts`、v1/v2 编译链路、`agents/slides-layouter` 输入与技能

---

## 0. 一页结论

组件不是「模板」，也不是「任意涂画」。改成两层：

1. **设计 token 层（风格卡 → 主题）**：`StyleParams` 的调色板 / 字体字号 / 间距 / 装饰 / 母题 / 构图家族全部解析进 `ResolvedTheme.design` 与 `theme.colors`，组件只读 token，不写裸色号裸像素。
2. **组件样式层（agent → 组件）**：每个 `component` 节点可带一个 `style` 对象，值全部是**语义枚举**（surface / separator / align / density / numeral / accent / motif），由 `resolveComponentSkin` 确定性解析成填充、描边、阴影、圆角、间距、字号、对齐、母题装饰。agent 说「这块要卡片、要留白、数字用无衬线、强调用 accent」，引擎负责画对。

平衡点：**agent 决定语义，引擎决定像素**。任何裸 `#RRGGBB`、裸 `pt`、裸 `px` 仍不可写；越界枚举直接报错并给改法；默认值从风格卡确定性推导，agent 不写 `style` 时与旧行为一致（v1 回归）。

---

## 1. 问题（审计结论）

- 27 个组件全部手写 `{type:"shape"}`，绕过 `elements.ts` 的 `card()` / `shapeElement()` / `imageElement()`：`decoration.cardStroke/cardStrokeWidthPt/cardShadow/imageFit` 只在这几个工厂里生效，组件层一次都没用到。
- `decoration.divider: "none"` 解析后无人消费：17 个组件无条件画 1px 发丝线。
- `typography.typeScale` 只有 v2 `compile.ts` 用；组件仍用旧 8 档 `sizes` + 40 处自造 clamp。
- `motif` 只存在于校验与存储，没有渲染消费者；`composition` 只进缩略图与 similarity；`darkCover` 没有桥到页面 `dark`。
- 组件节点没有样式入口：`normalizeComponentLeaf` 只认 name/items/featured/highlight/direction/numbered，未知字段静默丢弃。
- 结论：风格卡「说得到、做不到」；组件「画得稳、调不动」。

---

## 2. 组件 style 词汇（agent 可写）

`component` 节点新增可选 `style`。所有值是枚举，缺省从风格卡推导。

```jsonc
{
  "type": "component",
  "name": "stats",
  "style": {
    "surface": "card",       // none | card | tint | outline | ink | band
    "separator": "gap",      // line | gap | none
    "align": "start",        // start | center
    "density": "normal",     // tight | normal | airy
    "numeral": "serif",      // serif | sans | none
    "accent": "accent",      // primary | accent | muted
    "motif": "inherit"       // inherit | none
  },
  "items": []
}
```

| 属性 | 语义 | 解析为 | 默认（从风格卡） |
|---|---|---|---|
| `surface` | 组件/条目的「底面语言」 | `none` 无底；`card` 卡面 + `decoration.cardStroke/cardStrokeWidthPt` + `cardShadow` + `cornerRadius`；`tint` 主色浅档；`outline` 透明 + 分隔线描边；`ink` 墨面反白；`band` 强调色顶条 | `cardShadow !== "none"` 或 `cardStroke != null` → `card`；否则 `immersive` → `tint`；否则 `none` |
| `separator` | 条目/栏目之间 | `line` 1px 分隔线（`divider:"none"` 时降为 `gap`）；`gap` 只留间距；`none` 什么都不留 | `decoration.divider === "none"` → `gap`，否则 `line` |
| `align` | 文本对齐 | 段落 align + 块水平落位 | `start` |
| `density` | 内部间距密度 | 间距/内边距乘 0.75 / 1 / 1.4（snap4） | `swiss`→`tight`、`poster/immersive`→`airy`、`editorial`→`normal` |
| `numeral` | 装饰性序号/年份/大数字的字体 | `serif` = 标题字体、`sans` = 正文字体、`none` = 去掉装饰性序号 | `sans`（数字默认正文字体，显式配置可恢复衬线） |
| `accent` | 强调标记取色 | `primary` / `accent` / `muted`（用于刻标、顶条、星、目标刻度等唯一强调位） | `accent`（accent 与 primary 相同时即 primary） |
| `motif` | 风格卡母题是否进入本组件 | `inherit` 跟随 `motif.kind`；`none` 关掉 | `inherit` |

**母题映射**（形状级，避免 PPTX 文字墨迹重叠闸门）：

| motif.kind | 组件内表现 |
|---|---|
| `color-band` | 卡面/整组顶部一条强调色带（高 3~6px） |
| `corner-accent` | 卡面右上/左下角小三角或圆点 |
| `ghost-number` / `ghost-word` | 卡面内低透明度几何「幽灵场」（大圆/圆角块），给编号/大字垫气 |
| `none` | 不加 |

**组件专属结构变体**（每个组件 0~1 个，全部枚举）：

| 组件 | 变体 | 取值 |
|---|---|---|
| `stats` | `layout` | `row \| column \| grid` |
| `timeline` | `axis` | `line \| dots \| none` |
| `steps` | `connector` | `line \| gap \| none` |
| `chevron` / `pyramid` / `funnel` | `form` | `outline \| filled \| tint` |
| `calloutBox` | `form` | `bar \| panel \| tint` |
| `progress` | `fill` | `ink \| primary` |
| `orgChart` | `connector` | `elbow \| none` |
| `teamGrid` | `avatar` | `circle \| initial`（无头像时的兜底） |
| `logoWall` | `monochrome` | `true \| false` |

---

## 3. 风格卡字段 → 组件

| StyleParams | 组件消费方式 |
|---|---|
| `palette.background` | 卡面/浅档/轨道的混色基色；深底页由 `darkPageTheme` 翻转 |
| `palette.surface` | `surface:"card"` 填充；`elements.card()` 默认 |
| `palette.primary` | 结构强调：刻标、序号、图标、结构线 |
| `palette.accent` | `accent` 强调位：顶条、高亮数字、星、目标刻度、featured |
| `palette.text` / `textMuted` | 标题/正文/次级文字 |
| `palette.onDarkText` | `surface:"ink"`、深色页、反白按钮 |
| `palette.chartSeries` | 图表叶子；不再被 `quotes` 星标误用 |
| `typography.fontHeading/fontBody` | 标题/正文 run 字体；`numeral:"serif"` 用标题字体、`sans` 用正文字体 |
| `typography.sizes` | 组件基础字号档（v1 兼容） |
| `typography.typeScale` | 组件内语义字号（stats 数值 = hero、标签 = label 等）与 v2 文本 |
| `typography.headingBold` | 标题 run 字重 |
| `spacing.margin` | 页面安全区（组件外） |
| `spacing.gutter` | 组件内列/行间距，乘 `density` |
| `spacing.cardPadding` | 卡面内边距，乘 `density` |
| `spacing.cornerRadius` | surface 圆角（绝对像素 → roundRect adj） |
| `decoration.cardStroke/cardStrokeWidthPt` | `surface:"card"` 描边 |
| `decoration.cardShadow` | `surface:"card"` 阴影 |
| `decoration.divider` | `separator` 默认值；`none` 时全篇无发丝线 |
| `decoration.imageFit` | 组件内图片（featureCards/bento/persona/teamGrid 等）缺省 fit |
| `motif.kind/spec` | `surface` 上的母题装饰 |
| `darkCover` | 深色页/深色 surface 的组件用深色主题视图；封面/章节语义页可取深底 |
| `composition` | `density/surface/numeral` 的默认推导轴；页面构图仍由 layouter v2 决定 |
| `effectLines` | 用户可见文案；进入 layouter `styleBrief`，不进确定性渲染 |

---

## 4. 链路

```
slides-styler → StyleParams
      │
      ▼
resolveTheme(styleParams) ──► ResolvedTheme
  colors / typeScale / fonts / sizes / spacing / decoration / design{composition,motif,darkCover,surface,separator,density,...}
      │                                   │
      ▼                                   ▼
布局代理输入 styleTokens（语义快照）     逐页 component 节点 style（agent 覆盖）
      │                                   │
      └──────────────► resolveComponentSkin(style, theme) ──► ComponentSkin
                                                     │
                                                     ▼
                                       各组件 expander（只读 skin）
```

- **默认值只在 `theme.design` 与 `resolveComponentSkin` 里定义一次**；组件不写默认。
- `resolveComponentSkin` 对显式值做白名单 + 越界报错；对省略值按风格卡推导。
- 深色页：`darkPageTheme` 翻转页面角色色；组件拿到的 skin 在深色视图上解析，`ink`/`card` 自动落到深底口径。
- 兼容：v1 树不带 `style` → 全部走缺省，旧测试不变；v2 页面新增 `component` 节点，与 `stats/chart/text` 并列。

---

## 5. 硬约束与平衡

1. **不写像素/色号**：`style` 只接受枚举；未知字段报 `LAYOUT_TREE_INVALID`（不再静默丢弃）。
2. **元素预算**：surface card 每条目 +1 元素；组件展开后仍受 48 元素 / 8 图 / 4 path 上限；`separator:"line"` 不得让组件超过预算，组件内先算再加。
3. **溢出/重叠**：组件仍先量后画；母题只画 shape，不用文字，避免引擎墨迹闸门拒页。
4. **对比度**：文字色只从 `ink/muted/primary/accent/inverse` 语义档取；深色 surface 一律用反白档。
5. **一致性**：同一 deck 的默认 `surface/separator/density` 由风格卡统一；agent 的 per-page 覆盖是「同一设计系统内的变奏」，不是换系统。
6. **可验证**：每个风格卡字段至少有一个单测断言「改字段 → 组件产出变化」；每个 style 枚举有归一拒绝用例与至少一个正向渲染用例。

---

## 6. 验收

- `theme`：`composition/motif/darkCover/cardStroke/cardShadow/divider/imageFit/typeScale/accent` 全部进入 `ResolvedTheme.design`/颜色解析。
- 组件：27 个组件全部只通过 `skin` 取样式；无裸 `theme.colors.text` 直接画强调、无裸 `#00000000`、无无条件发丝线。
- v2：`{type:"component", ...}` 页面可归一、编译、量测、落页；`style` 进入 similarity 签名。
- 测试：v1 124 项全绿；新增 theme/kit/组件样式/v2 组件用例；`pnpm --filter @nxcore/gateway typecheck` 通过。

---

## 7. 落地记录（2026-10-19）

### 7.1 引擎/主题

- `theme.ts`：新增 `STYLE_COMPOSITIONS` / `MOTIF_KINDS` / `COMPONENT_SURFACES|SEPARATORS|ALIGNS|DENSITIES|NUMERALS|ACCENTS`；`ResolvedTheme.design` 一次性解析 `composition / motif / darkCover / surface / separator / align / density / numeral / accent`；`motif.kind === "none"` 时丢弃 spec；`darkPageTheme` 保留 design。
- 组件默认值只在这里推导：卡面装饰存在 → `surface:"card"`；`immersive` → `tint`；`swiss` → `density:"tight"`，`poster/immersive` → `airy`；`divider:"none"` → `separator:"gap"`；accent 与 primary 相同 → 强调位退回 primary。

### 7.2 组件样式层

- 新增 `tree/components/kit.ts`：`normalizeComponentStyle`（未知字段/越界枚举报 `LAYOUT_TREE_INVALID`）+ `resolveComponentSkin`（surface 绘制、contentBox 内缩、dividerH/V、motifDecor、语义色/字号/字体、density 间距、imageFit、ink 反白、imageRadiusAdj）+ `pageMotifElements`（页级母题，形状级）。
- 27 个组件全部改为只读 `ComponentSkin`：移除裸 `theme.colors.*` 绘制、无条件发丝线、写死阴影/描边；`surface` 按组件语义落到整组或每条目；`separator` 统一走 `dividerH/V`；`numeral` 控制装饰序号字体；`align` 显式时才覆盖组件历史默认对齐；`density` 同时影响间距与内边距。
- 组件专属变体（顶层字段，不在 `style` 内）：`stats.layout`、`timeline.axis`、`steps.connector`、`chevron/pyramid/funnel.form`、`calloutBox.form`、`cycle.marker`、`progress.fill`、`orgChart.connector`、`teamGrid.avatar`、`logoWall.monochrome`。
- 页级接线：v1 `compileTree` / v2 `compileV2Page` 在标题/节点之前铺 `pageMotifElements`；`darkCover` 让 `cover/section/closing` 语义页确定性落深色主题视图。
- v2 新增 `component` 节点：`{ type:"component", name, style?, ...参数, slot, bleed? }`，归一复用 v1 组件层，编译复用 `expandComponent`；元素上限/量测/相似度签名照常生效。
- v2 `grid` 改为只保存显式字段，缺省 margin/gutter 回到 `theme.spacing`（风格卡不再被 64/24 覆盖）。
- `slides-layout-tail` 给 layouter 输入增加确定性 `styleTokens`（palette/typeScale/fonts/spacing/decoration/motif/composition/componentDefaults，≤1200 字符）；layouter/reviewer input schema 允许该字段；layouter SYSTEM + 两版 layout skill + reviewer skill 已同步组件 style 语法与变体表。

### 7.3 测试与视觉验收

- 新增：`theme.test.ts`（design 推导/深色视图）、`components/kit.test.ts`（19）、`components/style-batch-a.test.ts`（14）、`components/style-batch-b.test.ts`（15）、`components/style-card-consumption.test.ts`（14，逐字段「改风格卡 → 组件产物变化」）、`tree/v2/component.test.ts`（7）。
- 回归：`tree.test.ts` 119、v2 12、slides-layout 全量 207；`slides-layout-tail` / `slides-layouter` / `slides-reviewer` / `subagent-tools` / editor / style / page-images 等 379 项全过；`tsc --noEmit` 通过。
- 真实引擎验收：[component-style-gallery](../materials/ppt-style-experiments/component-style-gallery/README.md) 6 页 PPTX + PNG，覆盖卡面/描边/阴影/圆角、accent 强调位、母题色带、深底章节、三种 surface、pricing featured、timeline `axis:"dots"`。
- 全量变体目录：[component-variants-gallery](../materials/ppt-style-experiments/component-variants-gallery/README.md)（`index.html`）：27 组件 × 393 个有效变体，逐条标注触发它的 style 覆盖；144 个组合与基线渲染完全相同、0 个不可用。

### 7.3.1 全量变体渲染中发现并修复的组件缺陷

- `stats` 的 `layout:"column"|"grid"`：每个槽位改为各自垂直居中（此前整组共用一个 top，纵向/网格布局条目重叠）。
- `cycle.marker:"number"`：序数徽章直径按引擎 min 18pt 墨迹托住，标题外推距离按方向取标签外接半宽/半高（此前编号压到标题）。
- `logoWall.monochrome`：归一层接受 `false`（此前只接受 `true`，“保留原色”变体实际不可达）。

### 7.3.2 视觉美化（2026-10-19 晚）

- 新增 [组件视觉系统 v2](slides-component-visual-system.zh-CN.md)：字号阶梯、间距/卡片、结构件、27 组件艺术方向、默认底面策略；渲染验收回路见 [component-beauty](../materials/ppt-style-experiments/component-beauty/README.md)。
- 27 个组件全部按该规范重写（详见 7.3.3）；新增 `component-beauty` 快速渲染回路（27 页联系表，约 15s）与 `check-frames.mts` 多尺寸检查。
- `ComponentSkin.metrics(frame)` 改为「风格卡 typeScale 为锚 + frame 等比放大」；`expandComponent` 增加 0.85/0.72/0.6 三档自动缩字降级。
- 修复全量渲染暴露的问题：stats 纵向/网格错位、cycle 编号压标题、logoWall monochrome:false 不可达、timeline 纵向布局、venn 交集标签压线、callout 面板形态失效、pricing featured 阴影写死等。
- 回归：`tree.test` / `style-batch-a/b` / `style-card-consumption` / v2 component 全绿；`component-variants-gallery` 397 有效变体、0 不可用。

### 7.3.3 风格卡交接审计（2026-10-20）

- 新增 [风格卡交接审计](slides-style-card-handoff.zh-CN.md)：逐 agent 列出拿到的风格信息、逐字段说明组件表达力、标出 7 个直觉断点与建议。
- 补齐交接：planner/editor 输入新增 `deckStyle`（composition/darkCover/motif/palette），reviewer 输入新增 `styleTokens`；视觉证据见 [style-card-expressiveness](../materials/ppt-style-experiments/style-card-expressiveness/README.md)（4 张风格卡 × 6 组件）。
- 顺手修复 quote 断行：宽幅引语最多两行且按每行容量留一个字，避免「风格 / 卡」把词拆行。

### 7.3.4 交接建议落地（2026-10-20）

- editor 构图家族校验 + 一次重排：`checkStoryboard` 按 `deckComposition` 校验核心家族与半数页配额，失败回传 `compositionFeedback` 重排一次。
- 风格卡 payload 增加 `details`（构图/明暗/母题/卡面/分隔/图片/视觉字号），前端进度卡同步展示。
- layouter/reviewer 文档统一「styleTokens 是唯一像素口径，styleBrief 只是叙事」；reviewer 可做风格一致的局部 style 变奏。
- v1/v2 skill 增加 27 组件 × style 语义子集表；详见 [交接审计](slides-style-card-handoff.zh-CN.md)。

### 7.4 剩余边界

- `palette.chartSeries` 仍只被图表叶子消费（组件里不画图表）；`effectLines` 仍只进 `styleBrief` 与风格卡 UI。
- `motif.spec` 目前解释 `side/width/alpha/size`；`ghost-number/word` 以「幽灵场」几何块表达（避免 PPTX 文字墨迹闸门）。
- reviewer 输入尚未下发 `styleTokens`（schema 已预留），审页仍拿 styleBrief。
- 组件默认 `surface` 由装饰 token 决定：风格卡有描边/阴影时，`featureCards/pricingTiers/stats` 等会整体变成卡面语言——这是「风格卡说的话必须落到组件」的预期行为，也意味着旧 deck 若换成卡片风格会明显变样。

### 7.5 审美收敛 v3（2026-11-04）

- 面向通用融资 BP 的组件审美收敛，详见 [组件视觉系统 v3](slides-component-visual-system.zh-CN.md)：
  字号角色固定在 1280×720 基准（数据 56–80 / 标题 24 / 正文 18 / 标签 14 / 注释 12），
  不再随组件框高度缩放；`design.numeral` 缺省改 `sans`（数字默认正文字体）。
- 装饰收敛：数据/内容组件去默认短强调线与纯装饰索引（标本索引、压底序号、幽灵序号）；
  分组线、顺序连接、层级结构件保留。
- featured 收敛：comparison/pricingTiers 用浅强调底 + 一条强调边，不叠顶条/徽章/阴影/反白；
  徽章仅在已有标签文本时显示。bentoGrid 默认各项平级（不反白首格）。
- 移除 `expandComponent` 的 0.85/0.72/0.6 整体缩字兜底：溢出走「换行 → 压间距 →
  角色下限有限收缩 → 布局错误通道」；组件技能文档的槽位下限说明同步更新。
- 回归基线：`aesthetic-convergence.test.ts`（行为）+ `aesthetic-contact-sheet.test.ts`
  （KPI/卖点/竞品/里程碑/团队 × 全宽编译零缺陷 / 半页·窄栏字号下限）。
