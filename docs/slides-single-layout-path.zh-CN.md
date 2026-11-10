# 幻灯片布局单一产出路径（v2 only）

状态：实施中 · 2026-10-21

## 1. 决定

布局只有一个产出格式：**v2 页面**（`version: 2` + `composition` + `nodes`）。

删除的东西（不是"暂时保留"，是删）：

1. layouter / reviewer 的 v1 技能文件（`skills/layout-tree-skill/SKILL.md` 的 v1 语法）。v1 编译代码保留，只服务于历史 deck 的读，不再有任何写路径。
2. `layout-tree-v2-skill` 这个"第二份文档"：v2 语法升格为唯一技能 `skills/layout-tree-skill`。
3. `group.tree`（v2 里的 v1 flex 岛）：`group` 节点保留名字，负载换成 v2 原生子节点。
4. 提示词里的降级放行条款（"预览 skipped 直接提交""同一批缺陷两轮后直接提交"）。
5. gateway 里"失败 → 换一套语法/换一套引擎"的分支：失败页必须是同格式的 v2 页。

保留的东西（这是"提高成功率"，不是"兜底"）：

- 页级 dispatch 重试、并发窗口退避、减配重试（同样是 v2，输入更小）。
- validate 缺陷自纠循环、`slides_page_preview` 视觉闸门、richness 闸门补图形重试。
- 引擎的确定性降档（shrinkToFit），它不换格式，只压缩间距。

## 2. 为什么删

- 同一套原子（引擎 `COMPONENT_NAMES`：27 核心 + 10 原子 = 37）被四份文档抄写，已经漂移：reviewer 的 v2 文档写 27 个、并缺 `group/connector/icon/path/table` 五节，而 layouter 正在产出这些节点。
- `group.tree` 是"预想栅格不够用，先留一条旧语法通道"。通道存在，模型就会用；用一次就得永远同时维护两套词表。
- 兜底页（`fallbackTree`）产出 v1 树，是 v1 技能存在的真实理由。兜底页不改 v2，v1 技能就删不掉。

## 3. `group` 的新语义（v2 原生分区）

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
      "items": [{ "label": "要点", "body": "说明" }] }
  ]
}
```

字段（全部 v2 词汇，不出现 v1 的 `variant` / `place` 之外任何 v1 字段）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `direction` | `row` / `column` / `overlay` | 主轴方向 |
| `weights` | 正数数组，个数 = children 数，0.1~20 | 仅 row/column；缺省均分 |
| `gapScale` | 0~4 | 缝隙 = 主题 gutter（row）/ rowGutter（column）× gapScale |
| `pad` | 0~48 | 帧内边距，先扣内边距再分区 |
| `justify` | `start` / `center` / `end` | 仅 column。**语义限定**：子区域划分不变，内容未铺满时整组按 justify 平移 |
| `panel` | `surface` / `tint` / `dark` / `outline` | 底板垫在所有子节点下面 |
| `children` | 1~12 个 v2 节点 | 子节点不写 `slot`、不写 `bleed`、不允许 `connector` |
| 子节点附加 | `weight?`（row/column）或 `place?`（overlay） | overlay 的 `place` 与 v1 同义：`{x,y,w,h}` 百分比，`x+w≤100`、`y+h≤100` |

约束：

- 嵌套深度 ≤ 3 层（`group` 套 `group` 套 `group` 为止）。
- 子节点可用的类型与页面级完全相同（text / image / shape / stats / chart / table / component / icon / path / group）。
- 叶子上仍然不写任何 px/pt/色号（`shape.fill` 与 `path.stroke` 例外，本就按 v2 规则）。
- `group.tree` 收到即报错：`group 不再接受 v1 树：把 tree 拆成 children 的 v2 节点，用 weight 表达比例`。

## 4. 失败页（原 `fallbackTree`）

`fallbackTree` 改名 `fallbackPage`，产出 v2 页：

- `composition` 按 `role` 定：cover→`poster`、section→`chapter`、quote→`poster`、data/table→`hero-data`、其余→`swiss`。
- 标题 `h1`（取 `page.title` 或 `copy.message`）；要点走 `pointList` 组件或 `text`；`data` 里的 stats 走 `stats`；`materials` 走 `image`。
- 必须满足该 composition 的硬约束（`poster/chapter` 有 `display`，`hero-data` 有 `hero`，`editorial` 有 image + h1/h2，`immersive` 有 bleed image）——所以按 role 选 composition 时不能选表里给不出货的那个。默认落到 `swiss`，它是无硬约束的。
- 结果与正常页同构：同语法、同校验、同编译链路。warning 文案照旧提示"已用兜底版式"。

## 5. 单一真源（文档）

- 权威正文：`docs/slides-layout-tree-spec.zh-CN.md`（v2 语法 + 37 个组件参数表，只此一份）。
- 生成：`scripts/render-layout-skills.mjs` 读权威正文 + 每个 agent 的 `skills/layout-tree-skill/appendix.md`，写出该 agent 的 `SKILL.md`（front-matter + 正文 + 增量章节）。
- 校验：`node scripts/render-layout-skills.mjs --check` 比对生成物与磁盘一致；`package.json` 的 `test:ci` 前置该命令。
- 命名守卫：`apps/gateway/src/modules/slides-layout/tree/docs-sync.test.ts` 断言权威正文里的组件名集合 === 引擎 `COMPONENT_NAMES`。

## 6. 验收

1. `apps/gateway` typecheck 通过。
2. v1 树测试全绿（引擎的读兼容没有被破坏）。
3. v2 测试全绿，新增 `group` 嵌套用例（weights 切分、overlay place、深度上限、tree 字段拒收、richness 递归计数）。
4. `tests/slides-layout-tail.test.ts` 全绿，且断言：兜底页 `tree.version === 2`；v2 页收到 v1 树时被拒并落兜底页。
5. 仓库里不再有 `layout-tree-v2-skill` 目录；`grep -r "layout-tree-v2-skill"` 为空（历史 docs 里的记录除外）。
6. layouter / reviewer 的 SKILL.md 由脚本生成，`git diff` 干净。

## 7. 落地状态（2026-10-21）

已按本契约改完，无 v1 写入路径残留：

- **引擎**：`tree/v2/schema.ts` 的 `group` 换成 v2 原生分区（`direction/weights?/gapScale?/pad?/justify?/panel?/children`，子节点用 `weight`/`place`，深度 ≤3，`tree` 字段逐字拒收）；`tree/v2/compile.ts` 抽出递归 `compileNode`，row 缝隙 = `gutter × gapScale`、column = `rowGutter × gapScale`、overlay 按 `place` 百分比换算、`justify` 整组平移并夹在 panel 内；`richness.ts` 递归统计（group 不算锚点）；`similarity.ts` 用 `g:<direction>:<n>[子摘要]`。
- **网关**：`slides-layout-tail.ts` 的 `fallbackTree` 换成 `fallbackPage`——兜底页是 v2 页（按角色选 composition），`treeFromInvocation` 只收 `version: 2`，收到 v1 树即按兜底页落；预览与 validate 都在格式层拦 v1；`tools.ts` 的 storyboard 缺失改为可重试失败，不再回退 v1 计划。保留：并发重试、validate 环、缩配重试（`trimmedPage`）、丰富度闸门、引擎 `shrinkToFit`。
- **文档**：`docs/slides-layout-tree-spec.zh-CN.md` 是唯一语法正文；两个 agent 的 `SKILL.md` 由 `scripts/render-layout-skills.mjs` 生成（`--check` 进 `test:ci`），`docs-sync.test.ts` 守住组件清单与参数表与引擎 `COMPONENT_NAMES` 一致；两个 `layout-tree-v2-skill` 目录已删除，`agent.yaml` 各留一份技能。
- **验收**：gateway `tsc --noEmit` 通过；`slides-layout/tree` 12 文件 239 例全绿（含新增 `group.test.ts` 19 例、`docs-sync` 3 例）；`tests/slides-layout-tail.test.ts` 17 例、`tests/slides-reviewer.test.ts` 7 例、`tests/subagent-tools.test.ts` 50 例、`tests/slides-layouter.test.ts` 10 例全绿。全量 gateway 套件 1853 passed / 12 failed，12 条失败在 HEAD 基线 worktree 上逐条复现（迁移/sync provider/导入链路等既有问题），与本次改动无关。

## 8. 落页顺序：占位页 + 完成即落（2026-10-21）

之前的落页是**按页序串行**：`for (i = 0..N-1) await treePromises[i]`。第 5 页即使早就排好了，也要等第 2、3、4 页落完才能落——慢页（封面/沉浸页常跑满 validate 自纠 + 预览闸门）堵住整条链，用户看到的是"最后一批一起出来"，而不是"一页生成完立刻落"。

改法（`apps/gateway/src/modules/subagents/slides-layout-tail.ts`）：

1. **建 deck 时按计划页数一次建满占位页**（`skeletonPageSpec` × N，自带"第 x / N 页 · 待填充"）。因此落页只做**按页序替换**（`slideIndex === 计划页序`），不再依赖 genoffice 的"追加"语义。
2. **落页按完成顺序**：每页的树 promise 一次建全（worker 只负责把 dispatch 窗口压到 8），谁的树先就绪谁先落自己那页。
3. **`fillPage` 仍串行**：打的是同一个活会话，用一条"到达顺序"的队伍排队——慢页只延迟自己，不再挡住已就绪的页。
4. **进度按页号集合统计**：`SlidesProgressSnapshot.appliedPages` / 载荷 `appliedPages` 带上已落定页号，卡面按集合打勾（`index < doneCount` 的旧规则在乱序下会把没落的页算成已完成）。

行为变化（都是"更诚实"的方向）：

- 打开预览立刻看到 N 页骨架，而不是"1 页慢慢长出来"——占位页显式写着"待填充"，落成后整页替换。
- 某页失败只留它自己的占位页，**不连累后页**（旧追加语义会把这页的内容顶掉，导致整册少一页、页码 05 缺失——见 `docs/slides-nexwing-reference-gap.zh-CN.md` §101）。
- 部分失败重试：槽位稳定，重试只补未落定的页（`failedPages`），已落页不重排。
- 旧的 agent 驱动工具链（`slides_create` / `set_page`，1 页骨架 + 追加）没有改动，仍是另一条路径。

验收：`apps/gateway` `tsc --noEmit` 通过；`tests/slides-layout-tail.test.ts` 18 例全绿（新增"后页先就绪就先落"用例）；`tests/subagent-tools.test.ts` 50 例、desktop `SlidesProgressCard.test.tsx` 28 例全绿。
