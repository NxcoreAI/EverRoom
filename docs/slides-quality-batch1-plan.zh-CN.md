# 幻灯片生成质量整改 · 第一册计划

- 日期：2026-10-21
- 范围：对比度 / 饱和度 / 字号体系 / 字数预算 / 场景体系 / condense 改造
- 状态：**待批准，未动任何代码**
- 第二册（版式）另出，见 §8

---

## 0. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 颜色 | **代码规范**，风格卡只作参考输入，比例由代码决定 |
| 2 | 对比度标准 | WCAG 2 AA 硬门槛（4.5 / 3 / 3）+ APCA Lc 仅作次级预警 |
| 3 | 风格卡权力 | **只继承色相**，明度与饱和度按场景 + 面积重算；`accent` 一并纳入 |
| 4 | 风格卡字号 | **完全不提取**，`styleParams.sizes` 字段移除，字号全归场景表 |
| 5 | 字号体系 | 代码规范；**agent 只决定场景** |
| 6 | 场景 | 对外 5 个场景名，对内"观看距离 × 信息密度"双旋钮；**agent 静默判断（不新增任何 UI）** |
| 7 | condense | 同意塞进第一批 |
| 8 | 计划形态 | 分两册 |
| 9 | 实施 | 先出计划，批准后再动代码 |

**关于场景可见性的落地口径**：按 Q2=A 执行——**不新增任何界面元素**。场景写入 deck 元数据（数据层可见、可查、可复现），但不呈现给用户。若后续要"藏在细节折叠里"，数据已就位，只加渲染。

---

## 1. 两条设计原则

**原则一：距离决定字号，密度决定字数。** 两个旋钮正交，互不干扰。

- 字号 → 只看观看距离（远/近），5 个场景映射到 2 套字阶。
- 字数 → 只看信息密度（疏/标准/密），再乘 form 系数。

**原则二：色相继承，明度与饱和由代码算。**

- 风格图 → 像素聚类 → 取 `primary` / `accent` 的**色相**（品牌识别度靠色相）。
- L（明度）与 S（饱和度）由代码按"场景 + 该色在画布上的面积"反算，风格卡无权指定 hex。

---

## 2. 数值表（实现时直接抄）

### 2.1 场景 → 双旋钮

| 场景 id | 用户可见标签 | 观看距离 | 信息密度 |
|---|---|---|---|
| `fundraising` | 路演融资 BP | 远 | 密 |
| `internal-review` | 内部汇报 | 远 | 标准 |
| `keynote` | 发布会 / 主题演讲 | 远 | 疏 |
| `training` | 培训教学 | 近 | 标准 |
| `reading` | 打印研读 / 尽调 | 近 | 密 |

缺省：`internal-review`（远 + 标准）。agent 判断不确定时落到缺省，不猜极端值。

### 2.2 字阶（10 档 token，pt）

| token | 远（投影） | 近（研读） |
|---|---|---|
| display | 60 | 46 |
| hero | 54 | 42 |
| h1 | 40 | 32 |
| h2 | 32 | 25 |
| h3 | 26 | 21 |
| lead | 24 | 19 |
| body | **20** | **16** |
| label | 15 | 13 |
| kicker | 14 | 12 |
| caption | **13** | **11** |

硬下限（floor，降档兜底到此为止）：

| variant | 远 | 近 |
|---|---|---|
| display | 44 | 34 |
| heading | 26 | 22 |
| subtitle | 18 | 16 |
| body | **16** | **14** |
| caption | **12** | **10** |

依据：近档字阶与已验证的好参考 deck（nexwing 13p 实测 56/44/34/26/22/17/16/13/12/11/10）基本重合；远档正文落在投影 18–24pt 最佳实践区间。

> **实施期修正（2026-10-21）：远档曾按拉丁惯例定 display 96 / hero 76，实测不可用改为 60 / 54。**
> 汉字是满宽字：96pt 在 1280 宽画布上一行只放得下 9 个字，「深圳：一座仍在生长的城市」这种正常
> 中文标题必然折行并溢出（实测 12 字标题要 406px，可用区只有 250px）。参考 deck 的最大字号也只有 56pt。
> 结论：**CJK 阶梯的上限比同尺寸拉丁阶梯低约一档**，这不是保守，是排得下。近档 display 随之下调到 46
> 以保持阶梯单调。

### 2.3 字数预算（每页正文合计，中文字符）

| 密度 | 基准字数 |
|---|---|
| 疏 | 35 |
| 标准 | 60 |
| 密 | 95 |

form 系数：

| form | 系数 | form | 系数 |
|---|---|---|---|
| `light-page` | 0.5 | `breakdown` | 1.2 |
| `image-led` | 0.6 | `contrast` | 1.2 |
| `single-fact` | 0.8 | `sequence` | 1.3 |
| `quotation` | 0.8 | `hierarchy` | 1.3 |
| `table` | 0.9 | | |

实现：`proseBudget = round(密度基准 × form 系数)`。对照现状（绝对值 40/50/60/60/60/100/100/110/110，均值 77）→ 标准密度均值降到 60 字，密档基本持平，疏档显著变空。

### 2.4 颜色守门规则

| # | 规则 | 阈值 | 违反时的动作 |
|---|---|---|---|
| C1 | 正文对比度 | ≥ 4.5:1（≥24pt 大字 ≥3:1） | 改 tone / 换承载面 / 加深板色 |
| C2 | 非文本图元对比 | ≥ 3:1 | 加描边或换色 |
| C3 | APCA 次级预警 | 正文 Lc ≥ 60 | **只记录，不改** |
| C4 | 同色相并置明度差 | ΔL ≥ 0.15 | 强制拉开明度 |
| C5 | 单色相面积占比 | > 30% 画布时饱和 ≤ 0.35 | 自动降饱和 |
| C6 | 图表数据标签 | 禁用系列色，只准 `text`/`muted`，或加 ≥1px halo | 强制替换 |

---

## 3. 改动清单

### 新建

| 文件 | 职责 |
|---|---|
| `apps/gateway/src/modules/slides-layout/scene.ts` | 5 场景档案 → 距离×密度 → 字阶 + floor + 字数基准 + 调色参数；`resolveScene(id)` / `defaultScene()`；非法 id 落缺省 |
| `apps/gateway/src/modules/slides-layout/color-guard.ts` | C1–C6 纯函数：`contrastRatio` / `apcaLc` / `relLuminance` / `guardPalette(hueAnchors, scene, areaBudget)` / `guardNodeColors(page, palette)`；无副作用、可单测 |
| `apps/gateway/tests/slides-scene.test.ts` | 场景映射与缺省、字阶单调性、floor 与阶位一致性 |
| `apps/gateway/tests/slides-color-guard.test.ts` | 6 条规则各正反例；用图 01 / 图 02 的真实色值做回归样本 |
| `apps/gateway/tests/slides-quality-report.test.ts` | 指标报告生成器：字号分布 / 最低对比度 / ΔL 最小值 / 组件种类数 / 超预算页数 |

### 修改

| 文件 | 改什么 |
|---|---|
| `apps/gateway/src/modules/slides-layout/theme.ts` | `resolveTheme(styleParams, scene)` 增加 scene 入参；字阶由 scene 决定；**忽略 `typography.sizes`**；保留 `typography.fonts`（字气质只剩字体体现） |
| `apps/gateway/src/modules/slides-layout/tree/layout-contract.ts` | `FONT_FLOORS` 从硬编码常量改为按 scene 派生（删掉 `caption: 9`） |
| `apps/gateway/src/modules/subagents/slides-page-form.ts` | `proseBudgetForForm` 返回**系数**而非绝对值；新增 `proseBudgetForScene(form, density)` |
| `apps/gateway/src/modules/slides-layout/tree/leaf-renderers.ts` | 图表数据标签改 `text`/`muted` + halo（C6）；轴标签按类目数抽稀（<5 类目不画刻度标签）；caption 取自新阶梯 |
| `apps/gateway/src/modules/slides-style/validate.ts` | 删除 `sizes` 解析与 clamp；palette 走 `color-guard` 的色相继承 + L/S 重算（替换 `sanitizePaletteRelations`） |
| `apps/gateway/src/modules/slides-style/extract.ts` | 聚类输出改为**色相锚点**（hue + 权重），不再直接给最终 hex |
| `apps/gateway/src/modules/subagents/slides-layout-tail.ts` | 调用 `contractFromStyleParams` 时传入 scene（7 处调用点的其中 2 处） |
| `agents/slides-planner/schemas/output.schema.json` | 新增 deck 级 `scene` 字段（枚举 5 值，缺省 `internal-review`） |
| `agents/slides-planner/SYSTEM.md` | 加场景判断规则（从 instruction/材料判观看距离与密度，不猜极端）；**吸收 slides-editor 的硬规则**：`copy.message` ≤24 字、supporting 最多 1 行 ≤32 字、事实走 facts/data、细节进 speakerNotes、禁免责声明；arrange 增出 `form`/`units`/`weight`/`emphasis` |
| `agents/slides-styler/SYSTEM.md` | 删"字号阶梯"整节；删 `effectLines` 里的字号描述（禁写 pt）；保留色板复核、字体映射、母题 |
| `agents/slides-styler/schemas/output.schema.json` | 删除 `sizes` 与 `typography.typeScale`，同步改 required |
| `apps/gateway/src/modules/subagents/tools.ts` | condense 路径改造（见 §4 Step 5）：从"整册分批压缩"改为"代码校验 + 单页打回" |

---

## 4. 实施顺序（每步独立可验，可单独回滚）

### Step 1 · 场景与字号体系（地基）

改：`scene.ts`（新）、`theme.ts`、`layout-contract.ts`、planner schema + SYSTEM。

验：单测断言 5 场景 → 字阶/floor 正确、缺省落 `internal-review`、字阶严格单调；跑一张现有 deck 重新编译，字号按新阶梯输出。

风险：`resolveTheme` 有 7 处调用，加**可选**入参（缺省即 `defaultScene()`）以保平滑。

### Step 2 · 字数预算

改：`slides-page-form.ts`（系数化）、`slides-editor.ts:349 proseBudget()` 与 `:659` 的预算返回。

验：单测断言 9 个 form × 3 密度共 27 个预算值；对现有 deck 的每页算超预算页数（预期大量超预算——这正是 Step 5 要收掉的）。

### Step 3 · 颜色守门

改：`color-guard.ts`（新）、`slides-style/validate.ts`、`slides-style/extract.ts`。

验：用图 01 的色值做回归——断言红底 + 暗红柱被判 C4 违反、米色强调柱面积被判 C5 违反；用图 02 做反例（应全部通过）。这是本册最强的一条回归，因为**两张真实截图的色值就是样本**。

### Step 4 · 小字清理

改：`leaf-renderers.ts`（图表标签颜色、轴标签抽稀、caption 取新阶梯）。

验：重新渲染图 02 那一类页面，人工确认"2 根柱子不再配 10 个刻度标签"、数据标签不再是系列色。

### Step 5 · condense 改造（唯一的大手术）

做三件事：

1. planner 的 arrange 阶段直接产出**短文案 + form/units/weight/emphasis**（提示词已在 Step 1 顺带改好）。
2. `tools.ts` 的 `active` 路径：停用"整册分批压缩"（`dispatchEditorStoryboard` 的 4 批调用），改为**代码校验**（字数预算 / 事实完整性 / form 合法性）；不通过时**按单页打回 ≤2 次**。
3. `slides-editor` 从"整册压缩器"降级为"页级修复器"，保留能力但不再随每次生成自动跑。

验：同一份材料的生成时长对比（预期从 4 批 LLM 降到 0 批，**总时长显著下降**）；内容保真检查（`dropped[]` 机制改为 arrange 阶段自证 + 代码校验）。

风险：这是本册唯一改变流程结构的一步，**放在最后**，前面四步都可以独立验收。

### Step 6 · 回归与指标

新建 `slides-quality-report.test.ts`，输出一份可读报告：字号分布 / 最低对比度 / ΔL 最小值 / 组件种类数 / 超预算页数 / 每阶段耗时。

---

## 5. 验收

用 3 份真实材料各生成一次，渲染成图 + 出指标报告，由你拍板。合格线：

1. 无低于 floor 的字号；
2. 所有正文对比度 ≥ 4.5:1（大字 ≥ 3:1）；
3. 无 ΔL < 0.15 的同色相并置；
4. 每册组件种类 ≥ 4 种；
5. 超预算页数为 0；
6. 总时长比改造前短。

附加（已同意）：与旧版并排盲测，你选新的。

---

## 6. 风险与回滚

| 风险 | 处置 |
|---|---|
| 远档字号变大后页面显空、信息被删 | 细节进 `speakerNotes`（已有 60–260 字承载）；字数预算按 form 系数调节，不搞一刀切 |
| 色相继承 + L/S 重算导致风格预览图与成品色值有偏差 | 偏差方向可解释（更亮/更淡），且只影响 L/S 不影响色相；在报告里列出每页重算前后的 hex |
| condense 改造使 arrange 单轮负担变重 | 分页预算前置到 arrange 的提示词；若单轮超时，回退保留 editor 但只做"页级校验+修复" |
| 场景静默判断错误 | 场景写进 deck 元数据可复现；缺省落最保守的 `internal-review` |

回滚：Step 1–4 各自可回滚（均为独立模块/常量）；Step 5 保留旧路径开关。

---

## 7. 明确不做（留给第二册）

- form → 组件强制映射表
- 补 5 个部件：`hero-number`(带注脚) / `split-text-image` / `table-with-conclusion-bar` / `cover` / `closing`
- 8–12 个结构页骨架
- 任何 composition / recipe / skeleton 推导的改动

**因此第一册做完后仍然残留的问题**：版式单调、组件仍以表格与简单块为主、`swiss` 仍是"无约束自由排"。这是设计上的取舍——先把"确定性可验证的部分"焊死，再动需要审美判断的部分。

---

## 8. 工作量

| Step | 内容 | 估计 |
|---|---|---|
| 1 | 场景 + 字号 | 中 |
| 2 | 字数预算 | 小 |
| 3 | 颜色守门 | 中（规则多但纯函数） |
| 4 | 小字清理 | 小 |
| 5 | condense 改造 | 大（唯一动流程的） |
| 6 | 回归与指标 | 中 |

Step 1、2、3 可并行；4 依赖 1；5 依赖 1、2；6 收尾。

---

## 9. 实施记录

> 完整验收报告见 `docs/slides-quality-batch1-report.zh-CN.md`（含压缩耗时/字数指标表与待真机验收清单）。
（2026-10-21）

### 已落地（Step 1、2、3、4、6 的代码部分，测试全绿）

| Step | 落地内容 | 证据 |
|---|---|---|
| 1 场景与字号 | 新增 `slides-layout/scene.ts`（5 场景 = 距离 × 密度、字阶、floor、字数基准）；`theme.ts` 字号改由场景派生，`typography.sizes/typeScale` 标记弃用并运行时忽略；`layout-contract.ts` 的 `FONT_FLOORS`（含 9pt）删除，改取场景 floor | `tests/slides-scene.test.ts` 9 条 |
| 2 字数预算 | `scene.ts` 给密度基准 35/60/95；`slides-page-form.ts` 由 `proseBudget` 绝对表改为 `proseCoefficient` × 基准；`slides-editor` 预算改为 `proseBudgetForForm(form, density)`，封面/收尾给 40 字固定额度（否则轻页系数 0.5 会把封面压到写不完一句） | `tests/slides-page-form.test.ts` 9 条、`tests/slides-editor.test.ts` 18 条 |
| 3 颜色守门 | 新增 `slides-layout/color-guard.ts`：WCAG 对比、L\*、HSL、APCA(W3 算法)、`guardPalette`（C5 降饱和 → C1/C2 调明度 → C4 拉明度差，**色相一律保留**）、`ensureSeriesVisible`、`guardToneOn`；接进 `slides-style/validate.ts`（守门在 `sanitizePaletteRelations` 之前，系列色在 `deriveChartSeries` 之后单独守） | `tests/slides-color-guard.test.ts` 14 条 |
| 4 小字清理 | `leaf-renderers.ts`：轴/图例/数据标签字号取场景 caption（删掉三处 `Math.max(9, caption)`）、瀑布图删 `Math.min(caption, 11)`、数据标签改正文色并加 C6 可读性门（`text` 与每条系列色对比 < 3 就不打标签）、有标签时关网格线、单系列/双类目不出图例 | 图表用例 + `tests/slides-color-guard.test.ts` |
| 3b 节点级守门 | `tree/v2/compile.ts` 的 `CompileState` 增加 `backdrop`（承载底色），`compileGroup` 遇面板下沉一层，`push` 单点拦截 `guardElementText`：按**元素自身填充 > 当前面板 > 页面底色**取承载面，字号 ≥24pt 按 3:1、其余按 4.5:1 判，只改文字色（色相/饱和不动）。出血大图页与带 alpha 的纱罩一律不介入（算不准就不猜）。顺带把页脚/图注两处写死的 10pt 改为场景 caption | `tests/slides-node-contrast.test.ts` 6 条 |
| 4b 值轴刻度 | 新增 `slides-layout/chart-axis.ts`（`niceStep` 吸到 1/2/2.5/5/10×10^k；`valueAxisPlan`：有数据标签且类目 ≤4 直接隐藏整条值轴，否则给 3~5 条刻度的步长）。引擎侧 `chart-insert.ts` 新增 `valAxisMajorUnit` / `hideValAxisLabels`（`c:majorUnit` + `c:tickLblPos none`，按 CT_ValAx 元素顺序落位），`page-spec.ts` 桥接 `axis.majorUnit` / `axis.hideValueAxis` | 引擎 `tests/chart.test.ts` 新增 4 条（61 条全绿）、`tests/slides-chart-axis.test.ts` 10 条 |
| 5a 代码压缩 | 新增 `slides-condense.ts`：planner 方案 → storyboard 的**确定性**压缩（`parsePlanData` 解析图表/表格/KPI 行内约定；`decideForm` 由"真的能上页面的东西"决定形态；`settleDistribution` 收敛分解/轻页配额/节奏三种分布闸门；文案只断在标点、装不下的整条进讲稿并记 `dropped`）。`tools.ts` 的 active 路径不再调 editor，改成压缩 + 校对 | `tests/slides-condense.test.ts` 25 条 |
| 5b 页级修复 | `slides-editor` 从"整册压缩器"降级为"页级修复器"：`buildEditorRepairInput` 只发被打回的页 + 缺陷清单，`mergeRepairedPages` 由代码丢弃范围外改动；`dispatchEditorStoryboard`（整册分批判）已删除；SYSTEM.md 增「页级修复模式」，input schema 增 `priorStoryboard`/`repairPageIds`/`defects` | `tests/slides-editor.test.ts` 新增 4 条；`tests/subagent-tools.test.ts` 改为断言"editor 一跳都不出现"与"修复失败即整册判失败" |
| 5c 场景接线 | `scene.ts` 增 `inferSceneId`（只看指令里的场合词，判不出落保守档）；场景从 `tools.ts` 一路传到 `contractFromStyleParams(styleParams, scene)`、字数预算与 plan 合并 | `tests/slides-scene.test.ts` 新增 4 条 |
| 6 指标报告 | 新增 `slides-layout/quality-report.ts`：`proseChars`（预算口径）/ `inkChars`（墨量口径，两者之差即小字量）、`paletteMetrics`（最低对比度、最小 ΔL\*、底色饱和度）、`deckQualityReport`、`minTextContrast` | `tests/slides-quality-report.test.ts` 10 条 |

全量：`apps/gateway` 181 个测试文件通过，slides 相关 40 个文件 507 条用例全绿；`tsc --noEmit` 无错。
剩余 15 条失败集中在 9 个与本册无关的文件（`database-migrations`、`sync-providers`、`ingest-pipeline`、`file-catalog`、`document-core`、`database-repair-writ-style`、`bundled-agent`、`agent-room-selection`、`memory-office-pdf-pipeline`），均为分支上既有问题（迁移 `ALTER TABLE documents` 重复列等），未触碰。

### 未落地 / 需你确认

1. **引擎改动落在子模块里，需要单独提交。** 值轴刻度改的是 `apps/desktop/vendor/genoffice`（git submodule，远端 `NxcoreAI/genoffice`，当前分支 `feat/everroom-ai-tab`）：`packages/pptx-engine` 与 `apps/slides` 两处已改并跑过 780 条引擎测试，但**父仓库只能指到子模块的提交**，得先在子模块提交+推送，父仓库才能更新指针。桌面端若走打包产物（`out/`），还需要重新 build 才生效。
2. **节点级守门只覆盖 v2 编译路径。** v1 旧布局树（`tree/compile.ts` 的 `WalkState`）走的是预设组件、颜色成对给定，没有接入 `backdrop`；表格单元格配色同理（表头 fill + 反白字是写死的成对关系）。这两处在第二册重写组件落位时一并处理。
3. **风格卡不再提供字号**，`slides-style/validate.ts` 里 sizes 的解析与 clamp 已随 `typography` 弃用而失效，`agents/slides-styler/SYSTEM.md` 与 schema 里"字号阶梯"整节待删（属 Step 5 同一批改动）。

### 实测基线（`screenshots/nexwing-audit/nexwing-fixed-13p.pptx`，人工好 deck，用于校准）

| 指标 | 实测 |
|---|---|
| 字号分布（按字符占比） | 11pt 26.2%、16pt 23.2%、10pt 13.1%、13pt 11.5%、34pt 8.5%… |
| 最小字号 | 10pt |
| < 12pt 字符占比 | **39.3%** |
| 正文字色对比（白底） | `#7F81A4` 3.76:1、`#31346C` 11.42:1、`#87878A` 3.58:1 |
| 每页字数 | 77–324（13 页） |

读数：连这份"好 deck"也有 39% 的字在 12pt 以下、正文色 3.76:1 刚好不合格——它是**研读型**排法。这说明两件事：① 小字问题不是我们独有，是行业默认；② 我们的 `reading` 场景基准（95 字/页）对研读型 deck 偏紧，若你确实要出这种"报告书"形态，需要单独把 `reading` 的基准上调（这一条待你定，本册未改）。
