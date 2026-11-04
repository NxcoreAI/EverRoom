# Slides 编排分批（arrange batching）设计

- 日期：2026-10-23
- 状态：已实现
- 关联：`agents/slides-planner/`、`apps/gateway/src/modules/subagents/slides-arrange-batches.ts`、`slides-material-prefetch.ts`

## 1. 要解决的问题

2026-10-22 实测同一册 27 页 deck 的 `演示文稿编排`（arrange）：

- 8 次尝试 0 成功：5 次 `timed_out`（全部恰好 420.0s）、2 次 `Pi runtime exceeded the maximum tool calls per run (40)`、1 次网关重启中断；
- 成功样本（≤20 页）耗时 p50 151s、p95 343s、max 412s——余量只剩 8s；
- 一次超时运行的内部节奏：31 次工具（28 次 `material_search`）到 158s，随后 262s 无工具、只有推理，420s 被杀；
- 19 页另有 3 次「达到模型输出上限」。

根因不是 420s 这个数字，而是**工作单位**：生成、失败、重试、持久化都以整册为单位，而时间/工具/输出预算按一次调用计。页数一多，任何一次调用都可能同时撞上三堵墙；超时只是最先撞到的那堵。

## 2. 设计

### 2.1 把工作单位改成批

- `planArrangeBatches`：按 8 页切批（27 页 → 7/7/7/6，9 页 → 5/4；均分避免尾批只剩 1 页）。
- 每批是独立 `slides-planner` 调用，输入只含本批 `draftPages/sources/materialHits`，并带 `arrangeBatch` 元信息（全局批序、起始页、全册标题、前后页标题）。
- 单批不额外收紧超时：沿用 `slides-planner` 的 policy（冒烟期 1800s）。此前按批收紧到 5 分钟，在大册/多素材批次上会把整册打成 `slides_arrange_batch_failed`；容量等待预算单独放宽到 10 分钟。
- 并发 2 批；单批失败重试 1 次，不阻塞其他批。

### 2.2 确定性合并，而不是让模型记全册

`mergeArrangeBatchPlans` 负责：

- 页按批序拼接，必须与确认稿页数一致；
- `title` 用确认稿标题；`narrative/warnings/summary` 去重限长拼接；
- 模型写错的 `content.id` 若来源全部指向本页，按来源 pageId 规范化（与 `assembleSemanticPlan` 既有规则一致），不升级成整册失败。

合并后的整册仍走原有 `assembleSemanticPlan`：全局来源覆盖、mustShow、跨页引用校验与有限页修复都不变。批级只做确定性结构校验（页数、标题、content、来源归属），不合规则只重试该批。

### 2.3 checkpoint：用户重试只补失败批

- key = Room + 草稿文档 + 指令 + 风格/参考风格 + 来源 hash + 批大小 + Agent Revision + 模型配置 + 素材命中；任一变化即新编排。
- 成功批结果、deck 文件与已落页号、累计预算写入 SQLite `slides_generation_checkpoints`；整册落页成功后删除。
- 用户重试（新 runId）或 Gateway 重启后，命中 checkpoint 时跳过已完成批与已落定页，继续使用同一个 deck 文件。
- 单批失败返回 `slides_arrange_batch_failed`，消息明确「重试只补未完成批次」。

### 2.4 素材检索与配图预热

- 素材检索前移到网关（`slides-material-prefetch.ts`），planner 工具面不再有 `material_search`；命中随输入下发，按批重排为批内 0 基页序。
- 分批模式不把 `prewarmToken` 交给模型（模型只看到局部页序，会把 1 基序号写错）；网关在每批完成后按全局页序调用 `enqueuePrewarmImage`，合并后仍用 `reconcilePrewarm` 对账。

## 3. 验证

- `apps/gateway/tests/slides-arrange-batches.test.ts`：切批、批元信息、批校验、合并规范化、checkpoint key。
- `apps/gateway/tests/subagent-tools.test.ts`：10 页 deck 的 generate 走 2 批、按全册序合并；9 页 deck 首批失败后重试只补失败批。
- `apps/gateway/tests/subagents.test.ts`：真实 `agent.yaml` policy（900s / 80 tools / 显式模型档）+ 输入契约含 `materialHits/arrangeBatch`；`dispatch timeoutMs` 只能收紧 policy。

## 4. 边界

- 生产装配必须传入数据库 checkpoint store；未装配数据库的测试宿主仅使用实例内存。
- 批次间叙事一致性靠 `previousPageTitles/nextPageTitle` + 全局校验；不追求跨批逐字衔接。
- 单批 ≤12 页（模块上限）；批大小调整只需改 `ARRANGE_BATCH_SIZE`。

## 5. 2026-10-23 追加：thinking 未真正关闭（真正的 300s 元凶）

分批上线后同一份 27 页 deck 的 7 页批仍然 300s 超时。逐秒事件显示：

- 每批 300s 里只有 2 次 memory/conversation 检索（209~227s）和 9300+ 条 `reasoning.delta`；
- 上下文只有 42~49k token，输入不是瓶颈；
- 成功样本（18/19 页）的 reasoning 也占了 183~257s——**思考时间就是主要耗时**。

直接对中转站探测确认：`deepseek-v4.1-flash` 在请求里**不传 `thinking` 时默认思考**（连「1+1」都先写 64 token reasoning）；传 `thinking:{type:"disabled"}` 后 `reasoning_content` 为空。

根因在 `packages/agent-runtime-pi`：自定义模型注册把 `reasoning:"off"` 映射成 `model.reasoning=false`，pi-ai 的 openai thinkingFormat 就**什么都不发**，于是上游用默认（思考）。修复：

- 模型名/baseUrl 命中 deepseek 时，注册 `reasoning:true` 并声明 `compat.thinkingFormat:"deepseek"`；
- 这样 `thinkingLevel=off` 会落到 pi-ai 的 deepseek 分支，显式发送 `thinking:{type:"disabled"}`；
- `reasoning:medium` 仍发 `enabled`；非 deepseek 模型不注入该参数，避免第三方端点 400。

回归测试：`packages/agent-runtime-pi/tests/thinking-request.test.ts`（mock fetch 断言请求体）。

## 6. 2026-10-23 追加：submit 反复失败 / 历史检索死循环

thinking 真正关闭后（见 §5），同样的 27 页场景仍有两次失败：

- 一批 7 页 300s 内做了 66 次 `conversation_search`，始终没有提交；
- 另一批连续 5 次 `subagent_submit_result` 被拒：模型把 `message` 写在 page 级、把 `role`/`message` 漏在 `content` 里，或省略了 `relations/focusRefs/constraints/notes/omissions`；同时调 `slides_image_prewarm` 时把不存在的 token 写成 `"none"`。

修复（均在网关侧，不靠模型自觉）：

- **submit schema 放宽 + 网关归位**：planner 输出 schema 只要求 `content.id/sourceRefs/blocks`；`role/message` 允许写在 page 级，`relations/focusRefs/constraints/notes/omissions` 可省略。`assembleSemanticPlan` 在权威语义校验前把这些字段确定性归位/补默认（page.role/message → content，空数组/空讲稿默认值），之后仍用严格 `SEMANTIC_PAGE_SCHEMA` 校验。planner 的 submit schema 与权威 schema 字段定义一致、必填项是权威必填的子集（测试固定）。
- **会话检索限额**：arrange 阶段 `conversation_search` 最多 2 次；之后返回 skip 指令，明确要求基于 `draftPages/sources/materialHits` 产出并调用 `subagent_submit_result`。实测这样可以打断 66 次检索的死循环。
- **预热工具分批跳过**：分批输入不含 `prewarmToken`，网关在每批结果回来后统一 `enqueuePrewarmImage`；模型若仍调 `slides_image_prewarm`，工具直接返回 skip，不再产生失败轮次。非分批路径保留原预热工具。
- **提示词**：明确每页 shape、`role/message` 写在 `content` 内、可选字段可省略；明确配图确认/落页不属于本阶段，不要检索历史或等待用户。

回归测试：`slides-semantic-pipeline.test.ts`（page 级 role/message + 省略数组归位）、`slides-semantic.test.ts`（planner submit schema 容忍该 shape）、`slides-agent-tools.test.ts`（会话检索限额、分批预热跳过）。

## 7. 2026-10-23 追加：落页前的语义契约把 citation 当正文（本轮"落页失败"）

最新 27 页场景中 4 个 arrange 批都成功（45~101s），但 generate 在落页前失败：

- 报错 `slides_semantic_content_invalid`，一次 generate 里 4~6 次 `slides-editor` 单页修复，全部无进展；
- 缺陷主要是两类：
  1. `讲稿未包含 source-...:notes`：来源 notes 里带着 `^[label](everroom://...?preview=...)` citation，契约要求 `content.notes` **完整包含**整段（含 URL）；
  2. `必留数据缺失 -9 / 88 / 55 / -4 / 04`：`numbers()` 把 citation URL 的 percent-encoded preview 里的数字当成正文数据；
  3. `block b-shi-1 数值 -100 无来源`：来源原文是 typo `1-00`，模型"顺手改字"成 `1-100`；编辑器宁可不改也不复原 typo；
  4. `原文必留 ...:point-3 未完整展示`：来源值带包裹引号 `"..."`，引用 block 只放内文。

修复（确定性，不再依赖模型/编辑器自觉）：

- `assignContentSources` 清洗来源值：剥掉 `^[...](everroom://...)` citation 与裸 everroom URL；URL 里的数字不再参与校验。
- `numbersInText` 用负向后顾，日期区间 `2012-2014` 不再被当成 `-2014`。
- `assembleSemanticPlan` 在严格校验前做确定性修复：
  - `omissions disposition="notes"` 且 notes 未包含来源原文 → 直接补回原文；
  - 单来源 text block 的数值不在来源里 → 用来源原文替换该 block（本次 `1-00`→`1-100` 被还原）；
  - 修复记录进 report.warnings，仍随后执行严格 `checkSemanticStoryboard`；
- `verbatimRefs` 校验容忍来源值外层包裹引号（`"..."`/`“...”`/`「...」`），引用 block 只放内文可通过。

验证：把 12:55 那次真实失败的 4 页 repair 输入（sources + priorStoryboard）喂给新 `assembleSemanticPlan`，**repair 不再被调用、report.passed=true**，`b-shi-1` 还原为 `1-00` 并产生一条 warning。

## 8. 2026-10-24 追加：内容→布局→落页流水线（逐批落页 + 落页优先）

此前链路是「全部 arrange 批结束 → 整册内容契约 → 配图确认 → 逐页布局落页」。页要等整册编排完成才可能出现，
中断时已完成的编排批也无法变成页面。现在（仅分批路径，单批 deck 行为不变）：

1. **骨架提前**：generate 一开始就把 N 页占位 deck 建好（页标题来自确认稿），进度卡立即可打开。
2. **按批成页**：每个 arrange 批一完成，网关立刻做**批级内容契约**（`assembleSemanticPlan` + 批内 sources；
   来源是页级自包含的，批内校验等价整册）→ 通过后把该批页推进落页尾部，立即 dispatch 布局并落页。
   批级契约失败只判该批失败（可按 checkpoint 重试）。
3. **落页优先、自审随后**：布局树一到就编译落页（用户先看到这一页），随后把该页渲染图回投布局代理自审；
   采纳的修正树**再补落同一页**。自审有独立 4 路并发闸，不占页窗口、不阻塞页面出现。
4. **配图页暂停**：带 `imagePrompt` 且无素材的页不在流水线里落，攒到批次全部完成后统一走现有过目卡/自动生图；
   暂停时把 deck 进度写进配图会话的 `plan.__deck`（fileEntryId + 已落页），确认后**复用同一个 deck 文件**
   只补落剩余页（不再新建文件），完成后补发 `completeDeck(completed=true)`。
5. **兜底**：有 checkpoint（重试只补失败批）时不做流水线，走整册合并路径；最终整册复核失败时已落页保留，
   以可重试失败返回。

代码：`apps/gateway/src/modules/subagents/tools.ts`（页流 + 按批装配 + 收尾）、
`slides-layout-tail.ts`（`stream` 页源 / `existingDeck` 续落 / 先落页后自审）。

验证：`subagent-tools.test.ts`（首批完成即落页、配图确认后同一 deck 续落）、
`slides-layout-tail.test.ts`（落页优先时序、自审修正补落、existingDeck 只补未落页）。
