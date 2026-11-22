---
name: entity-extraction
description: Extract searchable entities and a concise summary from a document for EverRoom knowledge routing.
---

# Entity Extraction

从资料中抽取人物、项目、机构、主题、长期目标、议题和事件，并概括资料内容。同一实体只保留一个规范叫法，通用词不算实体。kind 只能是指定七类，salience 为 0 到 1，evidence 必须是资料中的短句，最多返回 10 个实体；没有实体时返回空数组。

FA 语境：资料多来自股权融资 FA 业务（BP、会议纪要、机构调研、融资新闻）。机构判定口径：投资机构、基金、FA 服务过程中作为投资方出现的公司金融实体用「机构」；被服务的融资企业、被投资的公司用「项目」——即使资料把被投公司写成"XX 公司"，只要语境是融资标的或被投企业就用「项目」，不得因带"公司/科技/检测"字样就判「机构」。可比公司、竞品按「项目」处理。这两类实体与人物实体是 FA 档案的核心对象，在 salience 上优先保证它们被抽到。

指代归并：同一人在资料中以姓氏+称谓出现（如"陈总""沈总""李总"）时，若上下文能定位到全名（同一场会议的参会人、同一对话的双方），直接用全名做规范名，不把称谓当独立实体。公司名的前缀地名不计入比对（"苏州星析科技"与"星析科技"是同一实体）；机构的别名口径（"远帆资本"="峰瑞远帆"、"远帆五期"是旗下基金）在 evidence 可支撑时优先归并——基金是「机构」但挂在母机构名下时，用母机构规范名加别名注明。

同时抽取事实记忆：描述实体属性或实体之间关系的明确陈述，必须来自资料原文，不得编造；type 只能是「属性」（单一实体的性质、状态、归属等）或「关系」（两个及以上实体间的关系）；entities 引用本次抽取实体的规范名（最多 4 个）。最多返回 10 条事实；资料中没有明确陈述时返回空数组。

每条事实必须标注可信度分级 grade，五选一：
- `fact`：资料中有明确来源或数字支撑、可核验的事实（如"2025H1 营收 1.2 亿元（经审计）"）；
- `analysis`：基于事实的分析推断（资料写明是分析、结论由数据推导）；
- `forecast`：管理层预测、目标或前瞻假设（"预计明年收入翻番""计划做到 X"）；
- `opinion`：主观判断、观点或评价（"创始人认为赛道三年内洗牌"）；
- `unknown`：资料提到但未给出依据的关键信息。

分级硬规则：公司预测不得标 fact；行业平均值引用标 analysis 并在 content 里注明"行业平均"；拿不准时宁可标低（opinion/unknown），不得把推测标成 fact。

content 含关键数字时，尽量给 numeric 对象：`{"value":数字,"unit":"单位","period":"口径期间如2025H1","currency":"币种如CNY","audited":是否经审计}`；没有数字或不确定就不给。

再抽取实体间的**结构化关系**（FA 业务关系，可选段）。只收五类，全部要有资料原句支撑，宁缺毋滥：
- `founder_of`（创始人/联合创始人）：subject=人物，object=项目；
- `employed_by`（任职）：subject=人物，object=机构或项目，title 记职位，from/to 记年份（资料只说"至今"则 to 省略）；
- `invested_in`（投资）：subject=机构或人物，object=项目，round 记轮次（如"B轮"），role 为 lead/co_follow，票面拿不准就不给；
- `introduced_by`（介绍）：subject=项目或人物，object=人物（介绍人）；
- `partner_of`（合作/同事）：subject=人物，object=人物。

关系硬规则：subject/object 必须都在 entities 数组里（引用规范名）；方向必须按上面定义，不得反向；头衔≠任职（"创始人"头衔应抽 founder_of）；每份资料最多 5 条关系，重复出现的关系只留一条；拿不准方向或类型就丢弃，不猜。

只输出：`{"summary":"不超过300字的资料概括","entities":[{"name":"...","kind":"人物|项目|机构|主题|长期目标|议题|事件","salience":0.9,"evidence":"..."}],"facts":[{"content":"...","type":"属性|关系","grade":"fact|analysis|forecast|opinion|unknown","numeric":{"value":1.2,"unit":"亿元","period":"2025H1"},"entities":["..."]}],"relations":[{"type":"founder_of","subject":"沈屿","object":"星析科技","title":"CEO","from":2019,"round":null,"role":null,"evidence":"沈屿于2019年创立星析科技"}]}`。relations 可省略或为空数组。
