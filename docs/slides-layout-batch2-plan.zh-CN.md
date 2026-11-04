# 幻灯片版式整改 · 第二册方案：骨架参数化

日期：2026-10-22　分支：`feat/slides-layout-tree`　上一册：`docs/slides-quality-batch1-plan.zh-CN.md`

---

## 0. 一句话方案

**把"切版"从模型手里拿走，交给一张人写的骨架表；模型只交内容与主角；几何与参数由代码算。**

版式 = **骨架（人写 24 个）× 组件（人写 32 个）× 比例档（代码 3 档）× 密度档（代码 2 档）**。
不是 24×32×3×2 个模板，是 24 个函数 + 参数解析 + 一张打分表。

---

## 1. 现状诊断（都在代码里，不是感觉）

### 1.1 自由度放错了层

`agents/slides-layouter/SYSTEM.md:16` 现在让模型「先读 `form` 与 `skeleton` 定骨架，再填 slot」。
但 `skeleton` 只是 `slides-page-form.ts:64-128` 里的一句**中文散文建议**，例如：

> 「两块并置，权重 1.4:1（有重点方时）或 1:1；中缝用细分隔线或留白分开；两块各自有栏头。」

模型读到的是建议，输出的是 `{ slot: { col: [1,6], row: [1,4] } }` 的自由网格。
**建议不可执行，网格才是真的**——所以结构决策仍然全在模型手里，崩坏也是这样产生的。

### 1.2 表格是被"闸门"奖励出来的

`tree/v2/richness.ts` 的准入门槛是「至少一个信息图形原子」，而 `VISUAL_TYPES` 里**包含 `table`**。
于是「堆一个表」是满足闸门最省力的解——**模型不是审美差，是它在按我们的分数打最优解**。
这一条直接对应你提的第 4 个缺陷（"只会无脑堆砌平凡的表格等简单 UI 元素"），也是本册必须同时改闸门的原因：
只加骨架不改闸门，模型会在每个骨架里继续塞表格。

### 1.3 组件库并不薄，是"用不上"

`tree/components/index.ts:88` 已注册 **27 个组件**（timeline / steps / comparison / matrix2x2 / funnel / pyramid / venn / orgChart / bentoGrid / pricingTiers / eraRail / pointList…）+ 原子组件。
它们没被用起来的原因有三条，都不是"数量不够"：

1. 组件要一块足够大的 `frame`，而 `frame` 由模型自己切的 slot 决定——切小了就装不下，装不下就报缺陷重试。**模型的理性选择是别用组件**。
2. 组件的载荷形状（items 的条数、字段名）比 `table` 严格，写错即拒；`table` 几乎不会写错。
3. 没有任何"这页该用组件而不是表"的判据。`pointList`、`comparison`、`pricingTiers` 在语义上都能被一张表替代，而表更便宜。

### 1.4 那两条路的成本账

| 路线 | 下限 | 上限 | 成本 | 真正的问题 |
|---|---|---|---|---|
| A 继续让模型自由切版 | 低 | 偶尔惊艳，方差极大 | 低 | 无法预测哪两成塌 |
| B 预设整页版式 | 高 | 锁死在作者想象里 | **O(版式数) 爆炸** | 24 页 deck 要几百个版式才不重复 |
| **C 骨架参数化（本方案）** | 高 | 高（靠组件与参数，不靠版法数量） | **O(骨架数)，一次性** | 需要人真的懂排版 |

C 与 B 的差别是**正交分解**：B 把"结构 + 比例 + 单元排布 + 留白"焊死在一个模板里，所以组合爆炸；
C 只焊死结构，比例/留白/单元数由参数解析，所以 24 个骨架就能覆盖同一批内容的不同强调方式。

---

## 2. 设计

### 2.1 三层分工（谁定什么，写死）

| 层 | 谁定 | 可校验性 | 交付物 |
|---|---|---|---|
| 内容 | agent | 字数预算、事实可追溯 | `copy`（batch 1 已有） |
| 形态 form | agent | 9 类封闭词表 + 声明义务 | `form` + `units` |
| **骨架** | **代码查表**（模型只能在校验失败时换，见 §8） | 骨架表本身即白名单 | `skeletonId` |
| 参数（比例/对齐/密度/留白） | 代码按内容量算 | 档位区间断言 | 几何 token |
| 几何（坐标/字号/颜色） | 代码 | 现有 `compile.ts` | v2 树 |

一句话：**模型决定"说什么、强调什么"，代码决定"长什么样"。**

### 2.2 骨架是什么

一个骨架不是一页设计稿，是**语义槽位 + 参数维度 + 容量上下限**：

```
skeletonId: "single-fact.number.hero-left"
form: single-fact              emphasis: number
slots:
  hero   : rect(0.00–0.62 w, 0.18–0.52 h)   容量: 1 个数字          ← 唯一的视觉主角
  claim  : rect(0.00–0.62 w, 0.56–0.72 h)   容量: message ≤24 字
  support: rect(0.64–1.00 w, 0.18–0.72 h)   容量: 0–2 条 ≤32 字
  footer : 全局页脚
params:
  split      ∈ {5:7, 6:6, 7:5}      按 support 字数选
  align      ∈ {left, center}       按 emphasis 选
  whitespace ∈ {airy, standard}     按场景密度选
容量上限:
  support.maxItems = 2（超出进讲稿，不进页面）
```

关键约束（都能写成断言）：

- **一页一主角**：每个骨架恰好一个 `hero` 槽，面积 ∈ 版心的 35%~65%；
- **对齐轴 ≤2**：槽位的左边缘只允许落在两条 x 轴上；
- **留白率** = 1 − Σ槽位面积 ∈ 0.18~0.45（按密度档）；
- **容量上限**：装不下的内容与 batch 1 的字数超预算同路——进讲稿并记 `dropped`，不硬塞、不改页数。

### 2.3 册内重复政策（决定骨架库规模）

**允许重复，禁止连续。**
真实好 deck 的骨架重复率极高（章节页长一样、数据页长一样）。追求每页新排法正是"版式爆炸"的成因。
所以：同一 `skeletonId` 不得连续三页出现；全册骨架种类 ≥ `min(4, ceil(页数/3))`；连续两页不得同骨架同比例档。

这条政策一旦成立，**骨架库可以只要 24 个，但每个都打磨到位**——比 200 个半成品版式观感好一个量级。

---

## 3. DSL v3（新增输入层，编译到 v2 树）

不推翻 v2。v3 是**输入层**：模型（或代码）产出 v3 页，`tree/v3/compile.ts` 把它编译成现有 v2 树，落页链路完全不动。

```jsonc
{
  "version": 3,
  "role": "data",
  "form": "single-fact",
  "units": 1,
  "skeleton": "single-fact.number.hero-left",   // 代码给的，模型原样带回
  "params": { "split": "5:7", "align": "left" }, // 代码算的，模型可空
  "content": {
    "hero":    { "kind": "number", "value": "1.5", "unit": "亿" },
    "claim":   { "text": "营收涨了两成" },
    "support": [{ "text": "Q2 环比转正" }]
  }
}
```

- `content.*` 的键**由骨架声明**，模型填不存在的槽 = 报错（不是静默丢弃）；
- `skeleton` / `params` 缺省时由代码填——**模型不写也能渲染**，这是"不会用高级组件"的解药：默认就对；
- v3 → v2 的编译是纯函数，可单测；v2 语法、校验、渲染器一行不改。

灰度：`slides-layouter` 的输入带 `layoutVersion: 3` 时走 v3，否则走 v2；`compileTree` 两条入口并存一个版本周期。

---

## 4. 骨架库（24 个）

> **进度（2026-10-22）**：15 / 24 已落且全部通过「编译零缺陷 + 结构指标在档 + 画廊真实渲染」。
> 剩余 9 个集中在 image-led / chart-led / 封面收尾三组，需要图片与图表 fixture，排在下一步。

已落地的 15 个（括号内是实际渲染页数）：

| form | 骨架 | 说明 |
|---|---|---|
| single-fact | `number.hero-left`(4)、`title.claim-only`(2) | 大数字 / 一句主张 |
| contrast | `title.two-column-split`(4)、`title.before-after-rail`(2) | 两栏对照、左缘引导线 |
| sequence | `title.horizontal-track`(4)、`title.vertical-ladder`(2)、`title.timeline-band`(2) | 轨道、纵向阶梯、timeline 组件 |
| breakdown | `title.grid-2x2`(4)、`title.point-list`(2) | 宫格、pointList 组件 |
| hierarchy | `title.pyramid`(1) | pyramid 组件（outline 形态） |
| table | `table.with-conclusion`(2)、`table.full-width`(2) | 表格必带结论 / 满宽表 |
| quotation | `quote.center`(2)、`quote.offset-rule`(1) | 居中引文、偏置引文 |
| light-page | `title.center`(2) | 过渡/收尾 |

骨架里有两类做法，都要保留：
1. **自己摆槽位**（`slot(cols, rows)` 网格，确定性）；
2. **直接点名组件**（timeline / pointList / pyramid / funnel…）——这正是"替模型选高级组件"的落点，
   条目不够时不硬上组件，退化成"标签 + 正文"纵列并记 `rejected`。

## 5. 组件库补强（与本册同步）

### 5.1 表格去魅（先做这条，成本最低、收益最大）

1. `richness.ts` 的 `VISUAL_TYPES` **移除 `table`**：表格不再是视觉锚点，只是数据载体。
2. 新增配额：`table` 页数 ≤ `max(1, ceil(页数/5))`，超出即缺陷（"这页用对照表替代了本该有的结构"）。
3. 表格骨架必须带结论位（`table-with-conclusion`）：表旁/表上必有一句结论或一个数字，禁止表格孤零零居中。

### 5.2 新增 5 个组件（batch 1 已排期，本册落地）

`hero-number`、`split-text-image`、`table-with-conclusion-bar`、`cover`、`closing`。

### 5.3 现有 27 个组件的"可发现性"

骨架表里直接写清每个骨架的 `preferredComponents`，例如 `sequence.horizontal-track → [timeline, steps, chevron]`。
模型不需要知道组件目录，它只要按骨架填内容；组件由骨架默认选定。**这是"不会用高级组件"的正解：不是教它，是让它不必选。**

---

## 6. 排版手艺的确定性化（上限的真正来源）

放进 `tree/v3/craft.ts`，全部是常量与断言，不是"审美建议"：

| 规则 | 内容 | 为什么 |
|---|---|---|
| 基线网格 | 版心按 8pt 基线取整；所有块间距是 8pt 的整数倍 | 现在间距是模型给的百分比，几乎没有可对齐性 |
| measure（行长度） | 中文正文 ≤22 字/行、h2 ≤16 字/行；超了就加宽或加大字号 | 长行是"AI 味"的隐形来源 |
| 光学对齐 | 所有文字槽共享左 x 轴；数字右对齐；引号/署名单独一条轴 | 现在每块各自居中，视觉上是散的 |
| 留白节奏 | 相邻页留白率差 ≤0.12；全册留白率方差有上限 | 避免"一页挤一页空"的抖动 |
| 层级对比 | 同一页字号档跨度 ≥2 档（如 54 vs 20），且不超过 4 档 | 现在是 3~4 档挤在一起，看着"平" |
| 一页一主角 | 见 §2.2 | 很多页崩坏的真因是三个东西抢注意力 |

---

## 7. 闸门与指标（把"放开"变成"可控"）

新增 `slides-layout/page-structure.ts`，输出进 `deckQualityReport`：

| 指标 | 合格线 |
|---|---|
| `heroAreaRatio` | 每页 0.35~0.65 |
| `alignAxes` | 单栏 ≤2、两栏 ≤3、轨道/宫格按列数（见 `FORM_RULES`） |
| `heroAreaRatio` | 单栏 ≥30%、多栏 ≥18%、表格可到 85%（见 `FORM_RULES` 的 min/max） |
| `whitespaceRatio` | **提示级**：只硬卡下限与相邻页跳变；上限按形态放宽（过渡页本就该空） |
| `measureMax` | 正文 ≤22 字/行（≥40pt 大字不参与） |
| `skeletonRepeatRun` | 无连续 3 页同骨架 |
| `skeletonVariety` | ≥ min(4, ceil(页数/3)) |
| `componentVariety` | 每册 ≥4 种组件 |
| `tableShare` | ≤ max(1, ceil(页数/5)) |
| `structuralDefects` | 0（overflow / font_floor / 空槽 / 越界） |

这些是**能自动判死的**，所以可以硬门槛；观感类的东西（好不好看）不进闸门，进盲测。

---

## 8. `slides-layouter` 的新合同

| 模式 | 触发 | 模型干什么 |
|---|---|---|
| 默认 | 每次生成 | **不参与**：代码按 `form × emphasis × 内容量` 打分选骨架、算参数、编译 v2 |
| 换骨架 | 结构闸门报错，且候选集内有更高分骨架 | 在 **≤3 个候选骨架**里选一个，并说明理由；仍不能改槽位比例 |
| 页级修复 | 编译/渲染缺陷（overflow、font_floor） | 只改这一页的 `content`（删/短化文字），不许换骨架、不许改参数 |

打分函数（确定性，可单测）：

```
score(skeleton) =
  +3  容量完全匹配（units 落在 [min,max]）
  +2  emphasis 命中骨架声明的主角
  +1  内容形状匹配（有数字→number、有图→image、有行列→table）
  +1  与上一页不同骨架
  −5  与上两页同骨架
  −2  与上一页同骨架同比例档
选 argmax，同分按 skeletonId 字典序（保证可复现）
```

---

## 9. 实施顺序（四步，每步可独立验收）

| Step | 内容 | 验收 |
|---|---|---|
| 1 ✅ | `craft.ts` + `page-structure.ts` 指标（只测不改链路） | 单测：留白率/measure/主角面积在一批 fixture 上算得出；对现有产物出报告（nexwing 13 页实测见附录 A） |
| 1.5 ✅ | 骨架画廊（真实渲染，`skeleton-gallery/index.html`） | 15 个骨架 / 36 个变体 / 超档 0；画廊反过来校准了阈值（`FORM_RULES`） |
| 2 | 骨架表 24 个 + `tree/v3/bind.ts`（选骨架/算参数/容量协商）+ **骨架画廊 HTML** | 每个骨架 1 条 golden test；打分函数 12 条；容量超限必须进讲稿并记 `dropped`；**24 个骨架全部出真实渲染图并进 HTML** |
| 3 | `tree/v3/compile.ts`（v3 → v2 树）+ 灰度开关 | 同样的 storyboard 走 v3 与 v2 都能出页；v3 产物过全部结构闸门；v2 路径零回归 |
| 4 | 组件 5 个 + `richness.ts` 去 table + 表格配额 + layouter 提示词改合同 | 组件各有渲染 test；表格配额用例；提示词只保留"填 content"与"三选一换骨架" |

**顺序理由**：先有测量（1），再有能力（2、3），最后才是替换模型行为（4）。这样任何一步出问题都能停在"链路没变"的状态。

---

## 10. 成本估算

| 项 | 量 | 备注 |
|---|---|---|
| 骨架 | 24 × ~110 行 + 24 条 golden test | 一次性，之后复用所有 deck |
| 组件 | 5 × ~120 行 + 渲染 test | batch 1 已排期 |
| craft / structure / bind / compile | ~700 行 + ~40 条测试 | 纯函数，无外部依赖 |
| 提示词 | 3 个 agent 的合同段改写 | layouter 大幅瘦身（它不用再懂几何） |

对比路线 B：24 页 deck 想不重复，至少要几百个整页版式，且每加一个版式只服务一类内容。

---

## 11. 验收

**代码侧（可自动判）**：§7 全部指标在 3 份样本上归零 + 现有 507 条 slides 测试不回归。

**人侧（必须你拍板）**：与第一册产物并排盲测，同一份材料两份 deck，你选哪份。合格线：**你在 3 份里至少 2 份选新方案**。
（第一册时你说过"并排盲测你选新的"，这条继续沿用。）

---

## 12. 风险与回滚

| 风险 | 处置 |
|---|---|
| 24 个骨架不够用，出现"内容塞不进任何骨架" | 容量协商先退化（多余进讲稿）；若占比 >10% 页，说明骨架缺一类，按缺失内容加第 25、26 个——**加骨架是加法，不改已有骨架** |
| 骨架化之后观感趋同（形态相同 → 排法相同） | 靠参数档 + 组件选择 + 母题提供差异；§2.3 的重复政策只约束"同骨架连续出现"，不强制每页不同 |
| v3 编译与 v2 渲染出现偏差 | v2 语法不改，v3 只做"组装 v2 树"，偏差面被压在 `tree/v3/compile.ts` 一个文件里 |
| 模型仍在 content 里堆表格 | 表格配额进闸门（§5.1），这是硬约束不是建议 |

回滚：`layoutVersion` 开关回到 2，骨架表留在代码里不影响 v2 路径。

---

## 13. 骨架画廊（HTML，硬要求的交付物）

**不画示意图，全部是真实渲染。** 与 `materials/ppt-style-experiments/component-variants-gallery` 同一条链路：

```bash
# 1. 编译：24 骨架 × 场景/密度变体 → v2 页面 → compileTree → buildPagePptx → 每骨架一本 deck + manifest.json
apps/gateway/node_modules/.bin/tsx materials/ppt-style-experiments/skeleton-gallery/build-skeletons.mts
# 2. 光栅化：pptx → pdf → png（soffice + pdftoppm）
/opt/homebrew/bin/soffice --headless --convert-to pdf --outdir out/pdf out/decks/xxx.pptx
/opt/homebrew/bin/pdftoppm -png -r 110 out/pdf/xxx.pdf out/render/xxx/page
# 3. PNG → 900px JPEG 缩略图
node materials/ppt-style-experiments/skeleton-gallery/postprocess.mjs
# 4. 目录页
node materials/ppt-style-experiments/skeleton-gallery/build-html.mjs
```

**已落地（2026-10-22）**：`materials/ppt-style-experiments/skeleton-gallery/` 下有
`build-skeletons.mts` / `render.mjs` / `build-html.mjs`，跑完三步得到 `index.html`，
当前 **15 个骨架 / 36 个变体 / 36 张真实渲染图，超档 0**。渲染必须走 LibreOffice Kit CLI
（系统 `soffice` 的默认 profile 在这台机器上抛 `deployment::DeploymentException`，
新建 profile 又找不到中文字体、渲成豆腐块）。

画廊第一天就逼出三处修正，都已落到代码里：

1. **指标要分形态**：`hero ≥30% / 对齐轴 ≤2` 只对单主角形态成立；两栏对照天然两个块、三栏轨道天然三条左边缘。
   已在 `craft.ts` 加 `FORM_RULES`（single-fact 0.25/2、contrast 0.20/3、sequence 0.18/5、breakdown 0.18/4…）。
2. **页脚不是内容**：页脚/页码/分隔线会凭空多一档字号、多一条对齐轴。`page-structure.ts` 加 `CHROME_TOP = 660`
   把 chrome 排除在结构指标之外；发丝线（≤3px）也不再算"块压叠"。
3. **变体必须被骨架真的消费**：第一版画廊里 4 个变体渲出来一模一样——因为骨架没吃 `density`/`split`。
   现在密度真的改缝隙倍率，画廊按骨架给不同变体（内容量 / 比例档 / 对齐）。

画廊还逼出另外四条修正（都已落代码）：

4. **上限也要分形态**：表格满版 74.8% 会被"一块吃掉整页"误杀、满宽表全表同字号会被"字号档不足"误杀。
   `FormRule` 增加 `heroMax` / `minTiers` / `whitespaceMin` / `whitespaceMax`。
5. **留白是提示级指标，不是硬闸**：同样几何下内容薄的页必然更空（两行表格不该被撑满）。
   留白只在下限与"相邻页跳变（`MAX_WHITESPACE_JUMP`）"上硬卡。
6. **行长度只约束正文**：≥40pt 的大字（一屏一句）长一点是排版问题，不是"读不动"——不计入 `measureOver`。
7. **压叠只算"文字压文字"**：色块底、发丝线、组件内部层叠都是有意的；真断的是两段字叠在一起。
   顺带补了两个 DSL 缺口：`shape.tone`（分隔线用语义色，不必写裸色号）、发丝线登记为 `divider`
   （豁免尺寸下限）、文字叶子按内容定高（一行 kicker 31px 不再被 32px 下限误杀）。

`single-fact` 无支撑变体留白 50.9% 的问题，本质同第 5 条：留白随内容量变化，已按形态放宽，不再单独修。

`index.html` 里每个骨架一张卡，卡上写明：骨架 id、form、允许的 emphasis、参数档、容量上下限、
以及**实测结构指标**（主角面积 / 留白 / 对齐轴 / 最长行 / 字号档），超档的标红。
这样"骨架好不好"不用靠嘴说：点开就能看真图，量出来的数字就在图下面。

变体维度（每个骨架出一组）：`dense/standard/airy` × `far/near` × 有/无 support 内容，
以及容量上限测试（多塞一条 → 应该进讲稿而不是挤爆版面）。

---

## 14. 我按你上一轮的口头定下的三条（如有异议随时推翻）

1. **骨架选择权归代码**，模型只在校验失败时从 ≤3 个候选里换——不给它自由切槽的权力；
2. **允许册内骨架重复、禁止连续**——这是把骨架库压在 24 个的前提；
3. **骨架库我们手写**，不从真实 deck 反推（反推会连别人的毛病一起抄进来，且难以解释"为什么这么排"）。

---

## 附录 A：结构指标基线实测（2026-10-22）

跑法（无需桌面桥，直接量 pptx）：

```bash
/Users/xjwang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 \
    apps/gateway/scripts/slides-structure-baseline.py <deck.pptx>
```

样本：`screenshots/nexwing-audit/nexwing-fixed-13p.pptx`（人工调整过的"好 deck"，研读型，13 页）

| 指标 | 实测 | 读法 |
|---|---|---|
| 页均主角面积 | **19%**（10%~37%） | 没有"一页一主角"，是多块并置的版式 |
| 页均留白率 | **38%**（27%~50%） | 留白控制得很稳，这就是它"看着不挤"的原因 |
| 对齐轴数 | **1~7 条**（多数 4 条） | 分栏排版，每栏各自一条轴 |
| 最长行 | **11~33 字**（max 33） | 研读材料的常态，不是 22 字上限 |
| 同页字号档 | **3~7 档** | 大标题 + 栏头 + 正文 + 注脚 + 页码 |

**结论（重要，改了我的初版阈值）**：我最初只写了一档阈值（主角 ≥30%、对齐轴 ≤2、正文 ≤22 字、字号 ≤4 档）。
拿这份人工好 deck 一量，**13 页里没有一页合格**——不是它差，是它本来就不是投影用的。
所以 `craft.ts` 改成两档，随观看距离切换：

| 档 | 场景 | 主角 | 对齐轴 | 行长度 | 字号档 | 留白 |
|---|---|---|---|---|---|---|
| `projected` | 路演 / 发布会 / 评审投影（far） | 30%~72% | ≤2 | 正文 ≤22 字 | 2~4 档 | 20%~50% |
| `document` | 培训讲义 / 研读材料（near） | 10%~55% | ≤6 | 正文 ≤33 字 | 2~7 档 | 18%~55% |

`document` 档的数字不是拍的：是上表实测分布的上下包络（主角 10~37%、对齐 1~7、行 11~33、档 3~7、留白 27~50%），
四边留 1 档余量。单测 `tests/slides-page-structure.test.ts` 里有一条用"仿 nexwing 页"双向验证：
同一页在 `near` 档通过、在 `far` 档判失败。

**已知缺口**：我们自己的产物还没量过——需要一次真实生成 + 渲染（桌面桥）。
在那之前，`document` 档是"拿别人的好 deck 校准过的"，`projected` 档仍是设计目标值，未经真实产物检验。
