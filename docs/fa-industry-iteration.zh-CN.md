# FA 行业版迭代：输入文档索引

> 状态：调研与规划阶段（2026-11-18）
> 范围：EverRoom 面向股权融资 FA（财务顾问）团队的行业版迭代

本迭代以三份文档为输入，分工如下：

| 文档 | 角色 | 链接 |
| --- | --- | --- |
| EverRoom 行业版-FA（产品说明书） | 产品形态：三类 Room（项目/人物/投资机构）、FA 全流程十五个环节的人机分工、试点口径 | https://vyi-tech.feishu.cn/docx/EA5pdqlxuozoPpx8vfVcGRwinVb |
| EverRoom FA 行业版迭代实施计划 | 本期迭代的实施方案：七个工作项、三批推进、效果衡量与边界 | https://vyi-tech.feishu.cn/docx/Ql6qdWT2NopFTfxmCoNcHd9dnlx |
| FA 标准化与 AI 化运行体系（升级版 v4.0） | 业务规则底座：三阶段评分模型、投资人画像三级建模、Gate 流程 SOP、两阶段匹配算法、人机权限边界、KPI 体系 | https://vyi-tech.feishu.cn/docx/SH5dd3dlDolublxVMN2cmUEynLf |
| BP 赛道分类与模块内容标准（v1.0） | BP 内容标准：T01-T18 赛道模板、M01-M13 通用模块、四种讲述顺序、发展阶段调整、逐页任务单与发布检查 | https://vyi-tech.feishu.cn/docx/FXRrdQCydo7vSax4yIRcbKz7nd3 |
| BP 赛道模板实施方案（本仓库） | BP 模板配置化接入 slides 生成管线的落地方案：数据模型、选型卡、注入链路、里程碑 | [bp-template-plan.zh-CN.md](bp-template-plan.zh-CN.md) |

## 与代码库现状的差距摘要

- **机构实体**：`ContextRoomKind` 六值枚举（人物/项目/主题/长期目标/议题/事件）无"机构"，基金/投资记录/任职关系无结构化存储（`apps/desktop/src/renderer/src/components/context-room/ported/types.ts`、`apps/gateway/src/modules/knowledge/llm.ts` 的 `ENTITY_KINDS`）。
- **事实分级**：`roomEntityFacts` 只有"属性/关系"两类，无事实/分析/假设/意见/未知五档分级，也无数字元数据（口径、币种、审计状态、责任人）。
- **关系类型**：`roomRelations` 为通用类型（related/depends_on/part_of 等），无任职（带时间）、投资、创始人、介绍路径等 FA 语义关系。
- **会前/会后闭环**：transcription-summary agent 可产出会议纪要，但无"反馈分类 → 待确认变更 → 回写三档档案 → 跟进任务"的结构化链路，也无会前 Brief 聚合。
- **匹配**：无基于结构化档案的硬筛 + 适配评分链路。
- **数据入口**：connectors 体系为 SaaS 连接器（飞书/Notion/Gmail），无通用采集源插槽。

## 相关代码

- 知识模块：`apps/gateway/src/modules/knowledge/`（实体注册表、路由、晋升、Room Profile）
- 既有方案：[entity-room-plan.md](entity-room-plan.md)（实体晋升制）、[knowledge-room-agent-plan.md](knowledge-room-agent-plan.md)（Room Profile 刷新）、[room-wiki-plan.md](room-wiki-plan.md)（Room×Wiki 沉淀）
