# 幻灯片质量整改 · 第一册验收报告

日期：2026-10-22　分支：`feat/slides-layout-tree`　计划书：`docs/slides-quality-batch1-plan.zh-CN.md`

本报告只写**已经跑出来的数**。凡是需要真实落页 + 渲染才能量的指标（字号分布、对比度、ΔL、组件种类），
都标了「待真机验收」，没有用估算值填充。

---

## 1. 五个原始缺陷 → 改了什么

| 缺陷（用户原话） | 根因 | 本次改动 | 证据 |
| --- | --- | --- | --- |
| 过多的无意义小字，显得很 AI 风 | 引擎按绘图区自动推字号与刻度；页脚/图注写死 10pt | 场景驱动的最小字号表（`scene.ts`）+ 场景 caption；值轴刻度可控（类目少且有标签时整条隐藏） | `tests/slides-scene.test.ts`、`tests/slides-chart-axis.test.ts`、`tests/slides-node-contrast.test.ts` |
| 每次都压大纲，一压好几分钟，为什么不直接输出短的 | 整册草稿按 6 页一批丢给 LLM 压缩（1~4 批） | 压缩改成**代码**（`slides-condense.ts`）：0 批 LLM、0.1ms 级；planner 提示词加「文案收口」把字写短在源头 | 第 3 节指标表；`tests/slides-condense.test.ts` 25 条 |
| 版式很垃圾，agent 自己排得差，写死又太死板 | 版式名是审美偏好，没有客观对错 | 判「内容形态」（9 类可校验的 form）+ 形态推导构图；版式仍不写死 | `slides-page-form.ts`、`tests/slides-page-form.test.ts` |
| agent 不会用高级原子组件，只会堆表格 | 组件没有和内容形态绑定 | 第一册先锁「形态 → 骨架意图」，第二册再落组件映射表 | `PAGE_FORM_SPEC[...].skeleton` |
| 色彩对比度爆炸 | 色板只在角色层校验，落到具体承载面就失控 | 三步守门：色板级（L/S 重算）→ 图表标签级 → **节点级**（承载面感知） | `tests/slides-color-guard.test.ts` 14 条、`tests/slides-node-contrast.test.ts` 6 条 |

---

## 2. 场景与字号（Step 1）

场景静默判断，只看用户指令里的场合词，判不出来落最保守一档：

| 指令片段 | 判定场景 | 距离 | 密度 | 正文最小 |
| --- | --- | --- | --- | --- |
| 「给投资人做一轮路演」 | fundraising | far | dense | 16pt |
| 「周一内部周会复盘」 | internal-review | far | standard | 16pt |
| 「产品发布会演讲」 | keynote | far | airy | 16pt |
| 「新人入职培训」 | training | near | standard | 14pt |
| 「打印出来尽调研读」 | reading | near | dense | 14pt |

- far 字阶：display 60 / hero 54 / h1 40 / h2 32 / h3 26 / lead 24 / body 20 / label 15 / kicker 14 / caption 13
- near 字阶：display 46 / hero 42 / h1 32 / h2 25 / h3 21 / lead 19 / body 16 / label 13 / kicker 12 / caption 11
- 96pt 那档已删除：中文字形在 720p 画布上排不下，是上一轮 v2 布局测试溢出的真实原因。

旧版对照（nexwing 真实产物实测）：13 页、最小 10pt、**39.3% 的字小于 12pt**，11pt 一个档位就占 26.2%。

---

## 3. 压缩从「几分钟」到「0.1 毫秒」（Step 5）

跑法：`cd apps/gateway && npx tsx scripts/slides-condense-metrics.ts`

| 材料 | 页数 | 密度 | 改造前 LLM 批数 | 改造后 | 压缩耗时(中位) | 每页可见字数 | 进讲稿条数 | 形态数 | 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 内部周会复盘（7 页 · 投影） | 7 | standard | 2 批 | 0 | 0.1 ms | 21.1 | 0 | 4 | 通过 |
| 融资路演（9 页 · 投影） | 9 | dense | 2 批 | 0 | 0.1 ms | 23.0 | 0 | 4 | 通过 |
| 尽调研读材料（7 页 · 打印） | 7 | dense | 2 批 | 0 | 0.1 ms | 19.7 | 0 | 5 | 通过 |

读法：

- **批数**：改造前每个 deck 要 1~4 批 editor 调用（每批几十秒），改造后 **0 批**；
- **耗时**：一批 LLM 通常 20~60s，代码压缩 0.1ms，四批就是两分钟量级的差距；
- **每页可见字数** 20 上下：这是「一页一句结论 + 两三个短事实」的形状，和 nexwing 的 77~324 字/页是两个物种；
- **进讲稿条数 0** 说明这版 fixture 的要点都装得下；装不下的进 `dropped[]` + `speakerNotes`，测试里有专门用例。

失败时才有模型介入：校对器报错 → 只把出错页（≤4 页）打回 `slides-editor` 做**页级修复**，
最多 2 轮。修复器顺手改到别的页会被代码丢弃（`mergeRepairedPages`）。

---

## 4. 颜色守门（Step 3，三道闸）

1. **色板级** `guardPalette`：C5 大面积饱和度 ≤0.35 → C1/C2 对比度 → C4 同色相 ΔL* ≥0.15，只动 L/S、不动色相；
2. **图表标签级**：任一标签色 vs 底色 <3:1 就不出数据标签；出标签时关网格线；图例只在 >1 系列且 >2 点时显示；
3. **节点级**（`tree/v2/compile.ts` 的 `guardElementText`）：承载面按「元素自身填充 > 当前面板 > 页面底色」取值，
   ≥24pt 按 3:1、其余 4.5:1 判，只改文字色。出血大图页与 alpha 纱罩不介入（算不准就不猜）。

回归样本固定了两张真实坏图：`screenshots/ppt-audit/01-red-theme-data-page.png`（深红满屏 + 同色系暗柱 + 系列色数据标签）、
`02-latest-deck-data-page.png`（2 根柱配 10 条 Y 轴刻度、10pt 标签 vs 64pt 数字）。这两类在单测里都有对应用例。

---

## 5. 验证

```
cd apps/gateway
npx tsc --noEmit -p tsconfig.json        # 干净
npx vitest run tests/slides- src/modules/slides-layout
# Test Files 40 passed (40) / Tests 507 passed (507)
```

全量 `npx vitest run`：181 个文件通过，9 个文件失败——均为本分支改动前就存在的非 slides 失败
（数据库迁移、同步 provider、导入流水线、bundled-agent 等），与本次改动无关。

引擎侧（`apps/desktop/vendor/genoffice`，git submodule）：`pptx-engine` 77 文件 / 780 条全绿，
含本次新增的值轴刻度 4 条用例（`<c:majorUnit>` 落位顺序 + parse 回环 + 非法值忽略）。

---

## 6. 待真机验收（需要你跑一次）

合格线里这三条只能从**真实产物的渲染图**上量，代码侧盖不了章：

1. 无低于 floor 的字号 → `deckQualityReport` 的 `minFontPt` / `bodyFontPt`；
2. 所有正文对比度 ≥4.5:1、非文本 ≥3:1 → `report.palette.minContrast`；
3. 同色相并置 ΔL* ≥0.15 → `report.palette.minDeltaLstar`。

外加：每册组件种类 ≥4 种、超预算页数为 0、总时长比改造前短、与旧版并排盲测。

跑法：用三份真实材料各生成一次 → 出 `deckQualityReport` → 渲染成图 → 交你拍板。

---

## 7. 遗留（第二册）

1. **引擎改动要单独提交**：值轴刻度改在 submodule `apps/desktop/vendor/genoffice`（分支 `feat/everroom-ai-tab`），
   父仓库只能指到子模块提交；桌面端从 `apps/slides/out` 拷贝运行时，还需重新 build 才生效。
2. `form → 组件` 强制映射表、5 个新部件（hero-number / split-text-image / table-with-conclusion-bar / cover / closing）、
   8~12 套骨架——第二册主体。
3. v1 旧布局树与表格单元格配色未接承载面守门（v1 颜色成对给定，表格表头 fill + 反白字写死）。
4. `reading` 场景 95 字/页的基准对文档式长册偏紧，是否上调仍待你拍板。
