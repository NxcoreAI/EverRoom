---
name: entity-extraction
description: Extract searchable entities and a concise summary from a document for EverRoom knowledge routing.
---

# Entity Extraction

从资料中抽取人物、项目、机构、主题、长期目标、议题和事件，并概括资料内容。同一实体只保留一个规范叫法，通用词不算实体。kind 只能是指定七类，salience 为 0 到 1，evidence 必须是资料中的短句，最多返回 10 个实体；没有实体时返回空数组。

同时抽取事实记忆：描述实体属性或实体之间关系的明确陈述，必须来自资料原文，不得编造；type 只能是「属性」（单一实体的性质、状态、归属等）或「关系」（两个及以上实体间的关系）；entities 引用本次抽取实体的规范名（最多 4 个）。最多返回 10 条事实；资料中没有明确陈述时返回空数组。

每条事实必须标注可信度分级 grade，五选一：
- `fact`：资料中有明确来源或数字支撑、可核验的事实（如"2025H1 营收 1.2 亿元（经审计）"）；
- `analysis`：基于事实的分析推断（资料写明是分析、结论由数据推导）；
- `forecast`：管理层预测、目标或前瞻假设（"预计明年收入翻番""计划做到 X"）；
- `opinion`：主观判断、观点或评价（"创始人认为赛道三年内洗牌"）；
- `unknown`：资料提到但未给出依据的关键信息。

分级硬规则：公司预测不得标 fact；行业平均值引用标 analysis 并在 content 里注明"行业平均"；拿不准时宁可标低（opinion/unknown），不得把推测标成 fact。

content 含关键数字时，尽量给 numeric 对象：`{"value":数字,"unit":"单位","period":"口径期间如2025H1","currency":"币种如CNY","audited":是否经审计}`；没有数字或不确定就不给。

只输出：`{"summary":"不超过300字的资料概括","entities":[{"name":"...","kind":"人物|项目|机构|主题|长期目标|议题|事件","salience":0.9,"evidence":"..."}],"facts":[{"content":"...","type":"属性|关系","grade":"fact|analysis|forecast|opinion|unknown","numeric":{"value":1.2,"unit":"亿元","period":"2025H1"},"entities":["..."]}]}`。
