# 语义页面设计实测与启用结论

日期：2026-10-22。结论（同日更新）：semantic-v3 已设为唯一内容路径，legacy-v2 链路与运行模式开关删除（回退策略不再存在）。实现和代码验证已经完成，真实产物验收未完成；线上质量以失败语义兜底——契约不过即失败重试，不回退旧链路。

## 已交付

| 任务 | 状态与证据 |
|---|---|
| 来源与内容契约 | storyboard/v3、来源 ID、关系、重点、必留内容、原文与数据校验、指定页修复已实现 |
| Agent 自主设计 | 语义模式绕开旧 form/数量/骨架映射；Layouter 决定组件和位置；正常链路没有新增理解调用 |
| 校验与自审 | 实际节点绑定、组件展开载荷、最终图对应最终树、自审修改后重渲染已实现 |
| 兼容与恢复 | 默认旧模式、版本隔离存储、配图确认恢复时固定模式已实现 |
| 固定样本与采集工具 | 12 类单页、3 套各 8 页完整草稿；真实生产调用、隔离文档落点、截图/PPTX/耗时/token 采集已实现 |
| 对照与评审工具 | 分配置报告、兜底/中断排除、匿名成对评审与人工投票导入已实现 |
| 代码验证 | 28 个测试文件 551 项通过，项目类型检查、schema 与技能同步检查通过 |
| 真实基线与新版效果 | 部分完成，见下表；不满足完整对照要求 |
| 默认启用与删除旧映射 | 未执行，启用门槛未通过 |

## 同一配置组的实际结果

glm-5.3 同时负责内容编排、页面设计和视觉自审。输出上限统一为 32768，主推理档 medium。配置摘要 ece07064，完整数据在 `.local/slides-semantic-evaluation-final/report.json`。这是图标修复后、正式提交立即结束之前的配置组；后续运行时修订不可与它混合统计。

| 套件与模式 | 未主动中断的尝试 | 设计交付成功 | 自审核实 | 尝试 P50 | 尝试 P95 | token 合计 |
|---|---:|---:|---:|---:|---:|---:|
| 单页旧路径 | 6 | 4 | 3 | 465 秒 | 827 秒 | 556900 |
| 单页语义路径 | 5 | 5 | 4 | 338 秒 | 1094 秒 | 453665 |
| 融资 BP 旧路径 | 1 | 1 | 0 套完整自审 | 2030 秒 | 2030 秒 | 1060501 |

尝试时延包含失败和重试。单页只覆盖并列收益与两方比较，样本数不同，不能用 token 总和直接判断每页成本。旧路径两张兜底页排除在设计成功数之外。旧路径整册已导出 8 页，但最后两页在桌面重启后未完成自审。新路径整册在内容讲稿覆盖检查阶段进入修复，修复期间停止，未开始落页。

该目录共有 16 条记录，计划中的 72 次单页和 6 次整册矩阵尚缺 62 条；已采集记录另有 4 条主动中断。机器代码校验通过不代表人工视觉质量通过。人工偏好尚未收集。

## 截图发现

1. 并列收益页在新旧路径都倾向于两个并排面板。解除代码锁定确实允许 Agent 选择，但当前证据不能证明它能避免版式趋同。应继续比较关系不同的完整样本。
2. 实际截图中的原子图标被拉满横向区域。v2 编译器已修复为区域内居中等比呈现，横向/纵向区域回归与真实重渲染均验证通过。这是渲染修复，不是版式多样性证据。
3. 旧路径融资 BP 的第 2、3、4、6 页多次使用两栏空间结构；封面、资金用途和收尾缺少确认草稿中的部分文案。精确匹配报告还列出第 4 页两条改写，截图看得见对应表达，因此不能把全部字符串差异都当作语义丢失。
4. 语义单页的 mustShow 与数值校验通过，但语义整册没有完成，不能推断整册保真和可读性合格。

基线纵览：

![旧路径融资 BP 八页纵览](../.local/slides-semantic-evaluation-final/decks-1-1-legacy-v2/overview.png)

产物：[旧路径融资 BP](../.local/slides-semantic-evaluation-final/decks-1-1-legacy-v2/deck.pptx)、[对照评审](../.local/slides-semantic-evaluation-final/review.html)、[机器报告](../.local/slides-semantic-evaluation-final/report.json)。这些本机产物未纳入 Git，原始提交、最终 PageSpec 和截图可逐页追溯。

## 真实运行发现与修复

- Editor 顶层联合 schema 缺少根 properties，提供商把工具参数视为 `{}`；补齐根属性并保留分支校验。
- Planner 标题来源未进入必留 block；明确要求所有必留来源有展示单元。
- 旧模式因模型多输出 content 字段误进语义路径（历史问题）；现已结构性解决——只有 semantic-v3 一条路径，无模式可选。
- 合格结果提交后，末尾确认请求失败或超时导致结果丢失、等待冗长；编排器现在以收集器已校验的正式提交为完成点，主动取消仍优先。覆盖伪造 accepted、失败后修正、提交前后取消的测试；真实 Planner smoke 已返回，完整新版本对照待补。
- 桌面网关重启导致渲染桥地址失效；采集器按实时 PID 重发现渲染桥，提供 `--render-only` 恢复已有 PageSpec 的导出，原自审状态不变。
- 预览渲染桥限制最多 4 页；整册导出使用同一桌面引擎的单页合并方式。渲染页与生产产物使用同一生成器；合并对讲稿的限制沿用该引擎，内容讲稿以 capture.json 为核对来源。

## 当前阻塞与剩余工作

约 19:51 桌面重启后，实时 primary/background 配置一度显示 `deepseek-v4-flash`，且端点和密钥均为空，实际 Planner 返回 `runtime_config_not_ready`。这不是模型视觉能力结论。没有更改用户的模型设置，也没有使用旧凭据绕过新配置。该批采集进程已停止。20:07 复查时连接恢复，当前模型为 `deepseek-v4.1-flash`，另开配置组重新实测。

恢复当前应用的模型连接后，必须在最新代码和同一配置下重新采集矩阵，不能把缺少凭据的毫秒失败算作性能样本。人工评审、内容保真、最终渲染与成本门槛通过后，才考虑默认启用。默认 8192 上限下还观察过截断；32768 对照不能证明默认预算门槛通过。

```sh
pnpm --filter @nxcore/gateway exec tsx scripts/slides-semantic-capture.ts --suite layouts --repetitions 3 --concurrency 3 --vision-source background --max-tokens 32768 --output ../../.local/slides-semantic-evaluation-resume
pnpm --filter @nxcore/gateway exec tsx scripts/slides-semantic-capture.ts --suite decks --repetitions 1 --concurrency 1 --deck-concurrency 2 --vision-source background --max-tokens 32768 --output ../../.local/slides-semantic-evaluation-resume
pnpm --filter @nxcore/gateway exec tsx scripts/slides-semantic-report.ts --output ../../.local/slides-semantic-evaluation-resume
```

同一输出目录在相同 generationHash 下自动跳过已有采集，`--retry-failed` 重跑失败/兜底/中断记录；更换代码或模型会归档旧记录与产物。人工导出的投票通过报告脚本 `--review <paired-review.json>` 导入，不由 Agent 代填。
