# PPT 子代理执行边界

保留 Planner → Editor → Layouter 的角色分工，由 Gateway 持有预算、检查点和写入权限。设计依据是 Anthropic 的 [Subagents](https://code.claude.com/docs/en/sub-agents)、[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 和 [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，这些是设计原则，并非可认证的统一规范。

## 取消与恢复

父调用取消会传给并发等待、退避、逐页布局、自审和流式页读取。排队中的写入在实际执行前再检查取消状态；已发出的 Office 桥调用允许结束，并保存成功写入的页号。取消后不再开始后续页面写入、草稿归档或成功收尾。

SQLite 保存校验通过的批次、deck 文件、已落定页号和已消耗预算。内容、指令、风格、Revision、模型配置或素材命中改变会产生新的检查点。配图确认会话保存的方案固定原检查点身份，确认后在原 deck 上续落。

## 正式结果

Layouter 通过 `subagent_submit_result` 提交 `done` 与完整 `tree`，或者提交 `blocked`、`reason`、`attempts` 和 `requestedAction`。受阻分支禁止携带树，不触发减配重试或替换占位页。Gateway 将页号与阻塞原因返回给主代理，已完成的其他页保留。

## 共享预算

同一生成链路**默认不设预算**：不再限制活动时长、token 与子代理调用次数，冒烟测试期按真实用量跑完整册。`createSubagentPiTools` 的 `slidesGenerationBudget` 仍可显式传入有限上限（单元测试与需要硬边界的宿主用），字段缺省或传 `Infinity` 即该维度不设限。冒烟期同时放宽了各 bundle 的单次墙钟（planner/builder/layouter 1800s、editor 900s、styler 600s），planner/editor 不再声明 `maxToolCalls`，builder/styler 显式 32k 输出上限；这些只是单次调用的兜底，不会累积成整轮预算。

checkpoint 仍记录已消耗额度供诊断，但重试与重启不会再因历史用量触发中断；等待用户确认期间不累计活动时长。`resetGenerationBudget: true` 保留给显式限额的宿主，用于清零已消耗额度。草稿交付后的独立风格预热延续原有后台生命周期，使用其自身代理限制。

token 统计依赖模型返回的 usage，按调用累计快照去重，并在工具执行前上报；提供方未上报的用量无法计入。Office 桥与真实模型的端到端效果需要另行实测，自动化测试使用本地桥桩与兼容接口。
