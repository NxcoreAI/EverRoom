# FA 行业版迭代：输入文档索引

> 状态：第一/二/三批主体落地（2026-11-18）——机构档案、事实分级、会后反馈、会前简报、投资人匹配全部可用；剩余：数据源插槽
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

> 2026-11-18 更新：前两项已落地（迁移 0086），见下文"已落地"。

**已落地（第一批）**：
- "机构"入 `ContextRoomKind` / `ENTITY_KINDS` / entities 表枚举（gateway + desktop 全链，含图标/色调/图谱色值）
- `fa_funds` / `fa_investments` / `fa_positions` 三表（迁移 `0086_fa_institution_archives`）：结构化字段直接读库；来源与确认字段走确认制；投资事件不可变（去重命中返回原行，修正走删除重录）
- FA 语义关系类型：`employed_by`（任职）/ `invested_in`（投资）/ `founder_of`（创始人）/ `introduced_by`（介绍）入 `RoomRelationManualType` 与 REST 校验
- 事实分级：`room_entity_facts` 加 `grade`（fact/analysis/forecast/opinion/unknown，缺省 opinion——未标注不冒充事实）与 `numeric`（value/unit/period/currency/audited/verifiedBy）数字元数据；抽取 Skill（entity-extraction）已教五档标注与硬规则（公司预测不得标 fact、行业平均标 analysis）；`parseExtractionResponse` 严格解析 + 非法回落 opinion
- REST：`/v1/fa/institutions/:roomId/{funds,investments,positions}`（CRUD + confirm）+ `/v1/fa/persons/:roomId/positions` + `/v1/fa/rooms/:roomId/verified-facts?grade=`（BP 取数入口，缺省只出 fact）
- 服务层：`modules/fa-archive/service.ts`（Room kind 校验、幂等 upsert、软删、确认动作）

**未落地**：
- 数据源插槽（第三批剩余）：connectors 体系现为 SaaS 连接器（飞书/Notion/Gmail），通用采集源插槽待建

**已落地（第二批）**：
- 会后反馈闭环：`fa_meeting_feedbacks` 表 + `FaFeedbackService`（disposition 四分类/标准原因码十项/重启条件/三路信号确认制回写——个人观点挂人物房不上升机构策略/跟进任务按 disposition 定时限与优先级）+ REST `/v1/fa/feedbacks`（CRUD + confirm/dismiss，部分确认与确认时修订）
- 会前简报：`buildMeetingBrief` 聚合机构基金（投资期）/任职（投委会/可领投）/投资案例（组合冲突标记）/历史反馈/机构与人物信号事实/未兑现重启条件/项目已核事实（仅 fact）+ REST `/v1/fa/meeting-brief`

**已落地（第三批）**：
- 投资人匹配：`screenInstitutions` 两阶段——硬筛（过投资期/组合冲突/已拒绝无可重启条件出局且带理由；无基金档案标 unknown 不判死）+ 适配评分（赛道认知/阶段匹配/决策可达/当前姿态/数据完整度，每项带得分依据；可比公司带认知/冲突双解释）+ REST `POST /v1/fa/match`



## 相关代码

- 知识模块：`apps/gateway/src/modules/knowledge/`（实体注册表、路由、晋升、Room Profile）
- 既有方案：[entity-room-plan.md](entity-room-plan.md)（实体晋升制）、[knowledge-room-agent-plan.md](knowledge-room-agent-plan.md)（Room Profile 刷新）、[room-wiki-plan.md](room-wiki-plan.md)（Room×Wiki 沉淀）
