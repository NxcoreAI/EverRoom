# 语义页面设计实施记录

日期：2026-10-22。新链路已接通并设为唯一内容路径（legacy-v2 已删除，无回退开关）；真实产物评估部分完成，当前模型连接配置为空，完整评估尚未完成。阶段结果见 slides-semantic-evaluation.zh-CN.md。

## 运行模式

semantic-v3 是唯一内容路径（2026-10-22 起）：`NXCORE_SLIDES_CONTENT_MODE` 开关已删除，旧 `legacy-v2` 链路（代码压缩 condense、editor 整册影子、storyboard/v2 写入）一并下线。配图确认会话保存完整 contentContext，恢复时沿用保存的契约。

新链路：确认草稿完整读取 → 分配来源 ID → 现有 Planner arrange 产出 content → 校验及最多两轮指定页修复 → Layouter 自主设计 v2 页面 → 绑定与编译后内容校验 → 渲染自审 → 最终落页。

每页正常情况仍只有设计和自审两次 Layouter 调用，没有新增内容理解调用。内容契约为 storyboard/v3，布局语法仍为 v2；不使用实验性 tree/v3/skeletons。

## 已实现

- 确认草稿不再在新模式中截断要点、数据与备注。超过输入/schema 容量时明确失败，保留草稿。
- 来源 ID 在 arrange 前生成，关联确认快照中的页面、要点、数据与备注。第一页以外的目录也保留 toc 用途。
- Planner 提交 blocks、关系及依据、优先级、mustShow、焦点、原文约束、讲稿与遗漏记录。数量不再决定内容关系或整页骨架。
- Layouter 决定构图、组件、栅格、分区比例；语义模式不传 form/skeleton/composition 锁定。解除四模块、装饰凑数和强制相邻页异构。
- 检查关系/来源引用、页序、必留来源、数值、指标单位、引用和数据维度。所有确认的标题、要点和数据保守地视为必留内容。
- designIntent 与 bindings 为提交元数据。绑定检查规范化树的实际节点，检查表格行列、图表对应和图片完整呈现；再检查组件展开后的实际载荷，讲稿不充当上页证据。
- 重试传完整语义内容。素材被移除后更新实际素材，交给 Layouter 重排；必留图片无法呈现时失败。语义模式不自动压缩树或落入标题兜底页。
- 修复自审 currentTree 传内部包装对象的问题。改后树重新编译、校验和渲染，记录 reviewed / revised-rendered / unverified。修正失败保留原树并告警。
- storyboard/v2 与 v3 同表兼容。v3 使用独立 hash 命名空间，包含确认来源、模式版本、编排结果、素材、指令、风格和场景，避免覆盖旧路径或不同实验。
- TypeBox 内容 schema 是权威定义，生成 Planner / Editor / Layouter JSON schema；提供 --check 检查漂移。

## 验证与样本

样本位于 apps/gateway/tests/fixtures/slides-semantic.ts：12 类页面、3 套完整草稿。关系样例为人工定义的契约夹具，用于验证代码边界；它们不是模型理解效果的测评结果。

代码验证已扩大到 28 个相关测试文件、551 项全部通过；gateway 类型检查、内容 schema 同步检查、布局技能生成一致性检查均通过。覆盖新语义链路、旧压缩链路、指定页修复、实际调度输入 schema、绑定与编译载荷、配图恢复、存储隔离、自审修正后重渲染，以及布局编译、组件、调度收尾和主模型视觉路由回归。三个整册样例各 8 页，使用明确的合成基准数据。评估脚本单独的无配置 tsc 检查仍会遇到既有 proxy-fetch.ts BodyInit 类型冲突；项目常规类型检查通过。

改动前工作树标识（不是仅以 HEAD 代替工作树）：

- HEAD：b174f5e49f9c9256f5995689ec0966006f3da9b8。
- 128 个 slides agent、subagents、layout 和语法文件的作用域 SHA256：ea9dbd0b1fec253fc9d1b5d32d10bd1ccd68419b090d5e8f45ec02cdfd3e87d4。
- 初始回归：127 项通过、1 项失败。既有失败为 bundled-agent.test.ts 的文档解析响应预期 summary/outputFormat 为 null，与实际文本响应不符；修改前已复现。

执行命令（仓库根目录）：

```sh
pnpm --filter @nxcore/gateway typecheck
pnpm --filter @nxcore/gateway exec tsx ../../scripts/sync-slides-semantic-schemas.ts --check
node scripts/render-layout-skills.mjs --check
pnpm --filter @nxcore/gateway exec vitest run tests/slides-semantic.test.ts tests/slides-semantic-pipeline.test.ts tests/slides-editor.test.ts tests/slides-layout-tail.test.ts tests/slides-layouter.test.ts tests/slides-draft-doc.test.ts tests/subagent-tools.test.ts tests/config.test.ts
```

## 真实评估

桌面运行态提供可调用的主模型 glm-5.3 和 Office 渲染桥；仅检查 .env 无法判断实际能力。已从运行态读取配置开展真实采集，未改变用户模型设置。用户确认主模型具备视觉能力，正式对照通过 background 槽复用主模型进行设计与渲染后自审。legacy-v2 已删除：semantic-v3 是唯一内容路径，质量异常以失败重试语义暴露而不是回退。

新增 slides-semantic-capture.ts（生产调用、隔离文档落点）与 slides-semantic-report.ts（重验、统计、匿名成对评审）。layouts 套件固定人工内容契约，用真实 Layouter 隔离版式效果；decks 套件完整执行 Planner、内容修复、Layouter 和自审。评估记录包含最终 PageSpec、对应树、截图、调用次数、token、失败信息及模型/代码版本摘要。布局套件不证明 Planner 理解能力，也绕开旧内容压缩报告的整册门槛。

真实小样已发现并修复三项问题：Editor 顶层联合 schema 在工具调用中被当成空参数对象（补根 properties，分支校验保留）；Planner 必留标题来源没有对应 block（明确提示）；旧模式因 Planner 额外输出 content 而误进语义路径（改由网关固定模式并清理非选定模式的字段）。增加对应回归后，12 个测试文件 270 项通过，gateway 类型检查与 schema/技能同步检查通过。

随后真实调用发现：已通过 schema 和业务校验提交的正式结果，会因为末尾确认回复遭遇上游错误或超时而被丢弃。编排器现在保留这种已提交结果，明确取消/中断仍优先终止；增加有/无提交与四种收尾状态的回归。截图另发现原子图标被横向区域拉伸，v2 编译器改为区域内居中等比呈现，实际 placement 与图形一致，并验证横向和纵向区域；原始截图保留，单独重渲染预览验证修复。

真实样本还出现已提交结果后等待确认导致单页总耗时超过 18 分钟，因此进一步以“已通过收集器校验并持久化的正式提交”作为完成点，停止后续确认请求。工具失败后的修正提交仍可继续，伪造 accepted 事件不能放行，明确的父任务/用户取消优先。该运行时修订单独开展真实 smoke test，不与先前版本合并统计。

报告脚本排除兜底页、缺页和主动中断对成功率的污染，按模型/代码配置分组，分别记录失败尝试与成功交付耗时。匿名评审表附确认内容，可导出并通过 --review 导入人工投票；无效、重复与未知投票拒绝，条件不符的对照不计入偏好。工具不能自动产生“人工评审”结论。

当前默认输出上限 8192 下已观察到 length 截断与上游 504；扩展对照统一使用 32768 上限单列，不能据此声称默认配置成本门槛通过。早期跳过自审的诊断样本与默认完整对照分目录保存，诊断结果不纳入视觉验收。

首批高并发采集遇到持续 429/502/504，已停止并保留失败和中断记录。低并发恢复小样新旧路径均完成真实渲染与自审；同一并列收益页为旧路径 393 秒/132603 token、新路径 197 秒/76461 token，只有一对样本，不能用于总体性能或偏好结论，且属于图标修复前的单独配置组。完整重跑输出在 .local/slides-semantic-evaluation-final，过程性失败在 .local/slides-semantic-evaluation-full；两者不混合统计。

导出固定样本：

```sh
pnpm --filter @nxcore/gateway exec tsx scripts/slides-semantic-evaluate.ts
```

采集新旧模式每类页面各三次的真实输出，记录 caseName/mode/repetition、sourceHash、模型/风格/素材、耗时/调用/token、实际 Planner content、Layouter result、截图路径及最终树 hash。用同一脚本 `--results <JSON路径>` 重新验证内容和几何，检查对照条件、最终截图归属与样本缺口，报告 P50/P95 和成本。机器校验结果不能代替匿名成对视觉评审。三个完整草稿另做整册评审。

已完成部分真实基线截图、重复单页与一套旧路径 8 页整册；尚待完成完整矩阵、语义整册、人工关系表达与视觉偏好评审、成本门槛判断。桌面重启后当前主模型端点和密钥为空，实际调用返回 runtime_config_not_ready，所有采集进程已停止。已完成产物和失败记录保留，通过原计划门槛后再默认启用。

## 校验边界

来源引用与数值校验不能证明普通文案改写语义等价，不能仅靠数值集合证明源表格语义未变。指标单位目前采用保守的原文数值+单位匹配；合法单位换算与数字格式转换可能被拒绝，需要显式修复。

绑定证明实际内容存在，不证明遮挡、裁切与关系在视觉上正确；几何测量和图像自审共同补充。revised-rendered 表示最终修正已重新渲染，未宣称模型又审过最终截图。自审不可用时交付结果明确标记 unverified，不能作为默认启用门槛已通过的证据。
