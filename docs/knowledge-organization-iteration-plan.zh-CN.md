# 知识整理 / Context Room 合并机制优化 —— 迭代规划

> 状态：**方案评审稿 v1（2026-09-02，待评审）**
> 关联文档：`entity-room-plan.md`、`unified-ingest-plan.md`、`ingest-filter-agent-plan.md`、`writing-style-profile-plan.zh-CN.md`、`agent-document-development-sop.md`
> 代码基线：feat/contextroom @ `2392c4b`（新建式合并唯一路径 + merge-name 命名推荐已合入）
> 评审说明：本稿为待拍板评审稿；附 B 列出建议重点核对项。评审意见确认后按 `feishu-notion-connector-research.review.md` 惯例落 review 文档并修订为 v2。

---

## 1. 背景与目标

### 1.1 背景与问题域边界

"知识整理"指资料从进入产品到沉淀为可消费知识的全链路：**材料入口 → 过滤闸 → 路由瀑布 → 实体生命周期（weak/ready/suppressed/room）→ Room 诞生（手动创建 / 实体晋升 / 渲染器上报）→ Room 内容消费（八面板 / agent 上下文）→ Room 合并**。

前置事实：合并机制刚完成两轮重构——① 新建式合并成为唯一路径（`duplicate-service.ts:656/721`，"并入现有 Room"已废弃删除）；② 合并中心 UI 补齐伙伴搜索选择器与 merge-name agent 命名推荐（`routes.ts:260`）。合并执行链本身（三阶段事务、commitReached 恢复、启动自愈）已稳定，本文不再改动其执行语义；优化重心转向**发现时机、预览质量、判定消费与整条知识整理链的交互断层**。

### 1.2 目标与非目标

**目标**：

1. 补齐知识整理链上"后端已完备、UI 无出口"的交互断层（归错纠正、待处理资料、认领、错误可见性）
2. 优化合并机制的用户价值漏斗：候选发现 → 预览决策 → 合并产物质量 → 判定被尊重
3. 建立用户习惯学习闭环，把已持久化但零消费的用户决策信号转化为建议性智能
4. 清理死代码与已知卫生债，降低后续维护噪声

**非目标**：不改合并执行事务语义；不动 runtime 契约与 agent bundle 形态；REST 只增不改既有语义；不做跨设备同步。

### 1.3 已确认的方向决策

- 沿用仓库一贯哲学：**确定性层权威 + LLM 增强 + 失败降级保旧 + 用户显式表达接管优先**。
- 学习产物**只以建议形态存在**（prompt 措辞、排序权重、需用户确认的规则草稿），永不自动回写 `routing_rules`（该表 schema 注释即此承诺，`schema.ts:1706`），永不覆盖入口确定性、手动规则与 `decidedBy=user` 链接。
- 里程碑划分：**M1 交互补洞+死代码清理 → M2 合并机制优化 → M3 用户习惯学习**。顺序有因果性：M1 补的纠正/处置入口正是 M3 要采集的最高价值信号。
- 用户习惯学习判词：**有条件可行**，条件与论证见 §5。
- 创建时查重能力（网关 duplicate-check/overrideToken 端点）**暂保留**，去留并入 M2-B 决策（见 §4.1 M1-F 与 §2.4 说明）。

---

## 2. 现状总览（中性事实，可逐条对码核验）

### 2.1 全链路图

```
材料入口                    路由瀑布（router.ts）                实体生命周期                Room 消费
─────────                ──────────────────                ────────────                ─────────
EverRoom 文档 ─┐         ① 入口确定性（文档首链/entryRoomId）   entity_doc_links ─┐        八面板
  (防抖10min)  │         ②b 手动规则（routing_rules,仅manual）   证据分累积 scoreEvidence │       （overview/documents/
上传文件 ──────┼── fanOut ─③′ LLM 开集实体抽取（串行15-20s/个）   weak ──┐              │        relations/memories/
连接器 /v1/ingest│         │   无LLM→awaiting_review             │ 达阈值               │        wiki/schedule/tasks/mails)
  (过滤闸→误杀可恢复)│      ③″ 实体解析（精确→质心消歧→Dice模糊带） └→ ready ──用户确认──→ 晋升    │        agent 上下文 digest
手动 route/manual┘         ④ 链接落库（user链接不被覆盖）              suppress ⇄ restore    │             │
                          出口：有已晋升实体→execute 多对多沉淀        archived（仅合并/删房） │             ↓
                                                                Room 诞生三口 ───────────┘        合并（新建式唯一路径）
                                                                ①手动创建+enrich实体认领            duplicate-service
                                                                ②实体晋升 promoteEntity            两两 assess → 候选
                                                                ③渲染器 upsert（auto→user=认领）    预览 → 命名 → 执行
```

### 2.2 材料入口与路由瀑布

- **入口四条**：EverRoom 文档事件防抖 10 分钟入队；上传文件内容寻址判重（同名新内容=版本更新）；连接器走 `/v1/ingest`（先过滤闸，误杀可恢复 `reinstatedAt`）；手动 `routeDocumentNow`（`knowledge/service.ts:929`）绕过防抖。
- **瀑布四级**（`router.ts:167-383`）：① 入口确定性——文档按 `room_doc_links` 首链定源 Room（`:184`）；②b 手动规则——`routing_rules` 仅 manual、默认空表、按匹配器具体度排序（`:199`），schema 注释明示"不做自动回写"（`schema.ts:1706`）；③′ LLM 开集实体抽取——串行、实测 15-20s/文件（`KnowledgePendingPanel.tsx:75` 注释），瞬态错误退避重试不落死信（`:227`），无 LLM 落 awaiting_review（`:214/:250`）；③″ 实体解析——精确名/别名 → embedding 质心消歧 → Dice 模糊带（≥0.75 同弱自动合并、0.6-0.75 走 LLM 同一性判定）；④ 链接落库 `replaceResolutionLinks`——**`decidedBy=user` 链接不被重抽取覆盖**（`:296`）。
- **出口**：链接实体中有已晋升者 → execute 多对多沉淀（每目标 Room 一个 ingest job，`pickPromotedTargets` `:140`）；全部未晋升 → linked 孵化；抽取空 → awaiting_review。
- **手动挂载**：`attachDoc`（`knowledge/service.ts:2679`，端点 `routes.ts:1019`）upsert `role=manual` 链接，权重 1.5（`entity-registry.ts:44`），`decidedBy=user` 在证据分中显式加权（`:119`）。
- **撤销**：`revertDecision`（`service.ts:2863`，端点 `routes.ts:1128`）按落盘账本逐房清除 wiki 正文 → status=reverted → 重新入队路由且 skipEntry 防死循环。
- **未识别清单**：`GET /v1/knowledge/docs/unmatched`（`routes.ts:1048`）。

### 2.3 Room 诞生三口与晋升

- **手动创建**：`POST /v1/context-rooms` → `assertCreationAllowed`（`duplicate-service.ts:619`，含 overrideToken 查重）→ 落库 + 异步 `room-enrich` → `claimRoomEntities`（`knowledge/service.ts:3179` → `entity-registry.ts:456`）把描述中实体认领绑定，使新 Room 立即成为路由目标。**注意：名称式创建表单 + 查重审查弹窗的 UI 链路已是死代码（见 §3 P2-1），该端点当前无活跃 UI 消费方。**
- **实体晋升（现行主路径）**：证据分双阈值（standard: score≥2.4 且 ≥3 有效证据组；strong: 2 份独立强证据，`recommendationPathOf` `entity-registry.ts:331`）→ ready 进推荐池 → 用户在 KnowledgePendingPanel"确认创建"→ `promoteEntity`（`service.ts:2572` 附近，existingRoomMatch 高置信拦截/中置信 forceNew）→ 同名碰撞 LLM 判定 → `rooms` 插行 origin=auto → backlog 展开历史资料沉淀 wiki。
- **推荐生成会话（活链）**：RoomCreationStudio 提交（意图描述+暂存文件路径）→ `ROOM_RECOMMENDATION_RUN_EVENT`（`RoomCreationStudio.tsx:7`）→ KnowledgePendingPanel 进度蒙层（导入→路由→证据累积，`KnowledgePendingPanel.tsx:475`）→ 推荐浮现 → 用户确认。
- **渲染器上报**：`upsertRoom`（`service.ts:3118`）——命中 origin=auto 行即用户**认领**（auto→user），当前唯一认领方式是"打开/交互"这一隐式触发。
- **on-demand 推荐**：`proposeRooms`（`service.ts:2288`）LLM 围绕锚点实体推荐，结果纯内存不落库；渲染层 preload 已暴露但**零调用**（孤儿 API，见 P2-1）。

### 2.4 合并机制现状

- **检测**：`rebuildCandidates`（`duplicate-service.ts:462`，250ms 防抖）全量两两 `assess`（`:364`）——名称 Dice+包含保底 / centroid 余弦 / 加权证据 Jaccard / 实体 Jaccard → 综合分；LLM 同一性终审结果按 `evidenceRevision` 缓存防抖动。
- **preserveDecision 语义（重要）**：用户 distinct/related 判定**在 evidenceRevision 不变时于 rebuild 中保留**（`:477-486`）；但证据一变即静默重置为 open，且 `assess()` 无判定历史参数、LLM judge prompt 不含"用户曾判非重复"事实。
- **入口**：首页"我的 Rooms"工具栏合并按钮（红点=待处理候选数）；RoomCard 菜单"合并到新 Room…"→ 伙伴搜索选择器 → 合并中心。红点计数靠 5s 补拉 workaround 对齐防抖窗口（`HomeView.tsx:228`）。
- **执行**：预览（影响计数/冲突/不迁移项/previewHash 乐观锁）→ 命名（机械 chips + `merge-name` agent 异步推荐，`routes.ts:260`）→ 两段链式 `executeMerge`（`:992`，commitReached 恢复+启动自愈）→ `finalizeMerge`（`:1101`）双源退役。合并产物 brief 为占位文案"合并自「X」与「Y」"；`refreshBrief` 端点（`context-rooms/service.ts:739`）存在但合并完成后**不自动触发**。

### 2.5 用户决策信号台账（M3 原料盘点）

| # | 信号 | 持久化位置 | 消费现状 |
|---|---|---|---|
| 1 | 重复候选判定（related/distinct/merged） | `room_duplicate_candidates.status/reasons` | 仅展示与合并闸；评分零消费（§2.4 preserveDecision 语义） |
| 2 | 路由决策与纠正（revert/attach/auto 决策审计） | `route_decisions`（status/decidedBy/reason/evidence/快照） | 流程性消费（撤销/回填/幂等判断），无学习 |
| 3 | 坚持创建（overrideToken） | duplicate-service 内存 Map，TTL 10 分钟 | **不持久化**；且其唯一 UI 链路已死（P2-1） |
| 4 | 手动链接（挂载实体） | `entity_doc_links` decidedBy=user, role=manual, 权重 1.5 | 直接影响路由与证据分，但不归纳模式 |
| 5 | 推荐搁置/恢复 | `entities.status=suppressed` | 状态机（退出/回池重算），无频率学习 |
| 6 | 规则命中 | `routing_rules.hitCount/lastHitAt`（origin 恒 manual） | 仅展示统计 |
| 7 | Room 关系手动标注 | `room_relations`（manual/pinned/hidden） | 保留语义（自动分归零不删），不反馈评分 |
| 8 | agent 会话 Room 归属 | `agentSessions/agentRuns.roomId`、`agentSessionLinks` | 流程性（合并影响预览/搬移） |
| 9 | 概览纠正（七操作五区） | `room_context_corrections`（双层投影重放，applied 为权威） | 权威覆盖语义，agent 再生不得矛盾；无学习 |
| 10 | **过滤误杀恢复** | `ingest_events.reinstatedAt` | ★唯一学习闭环：FilterInsightJob 每小时（`rules-insight.ts:60-66`）取 7 天误杀样本（`:172-173`）→ 偏好分析师 agent 修订式重写过滤 insight 段 |
| 11 | 文件聚类改名/手动归簇 | `file_clusters.titlePinned` 等 | 锁定语义（用户接管冻结自动改写） |
| 12 | 写作域行为信号 | `writing_style_signals` 四类 | 回溯消费先例：信号→统计 sketch→LLM 定性→画像（"系统生成+用户接管"，`writing-style/service.ts:289-297`）→注入 |

**结论**：原料已在库且 schema 完备；除 #10 外消费端为零。

---

## 3. 痛点清单

分级标准：**P0**=阻断核心价值/用户实际受损；**P1**=体验损耗；**P2**=卫生/死代码。

### P0

| 编号 | 痛点 | 理由 | 涉及 |
|---|---|---|---|
| P0-1 | 归错纠正出口极窄 | 归错是路由系统的必然高频事件，无就近出口=错误持续沉淀污染 agent 上下文。后端 revert/attach/manual 端点完备，UI 却只有首页面板「历史记录」折叠区（限最近 10 条 confirmed，`KnowledgePendingPanel.tsx:248`），Room 详情八面板零纠正入口 | detail-panels/*、`knowledge/routes.ts:1019/1128/1146` |
| P0-2 | awaiting/pending_review 资料无处置面 | 资料停在"未识别/pending"黑洞只可看不可处置；`docs/unmatched` 与 attach 端点已存在未暴露成操作面 | `routes.ts:1048`、KnowledgePendingPanel |
| P0-3 | 静默降级把"失败"渲染成"没有" | 空态组件根本无错误态概念（`PanelEmptyState.tsx` 纯展示），知识服务不可用时面板静默为空（`KnowledgePendingPanel.tsx:303`），用户把故障误读为"确实没资料"，错误不可见即不可自愈 | PanelEmptyState、各面板 catch 分支 |
| P0-4 | 合并候选用户判定零消费 | 证据修订后用户 distinct/related 判定被静默重置 open，重评不参考历史（assess 无历史参数、judge prompt 不含用户判定），高置信候选可反复弹出——显式表达被无视，直接侵蚀信任，违背"用户显式表达优先"哲学 | `duplicate-service.ts:364/477` |

### P1（12 条）

| 编号 | 痛点 | 理由 |
|---|---|---|
| P1-1 | 合并候选只靠首页红点被动发现 | 合并价值第一公里依赖"用户碰巧回首页"，该合并的长期滞留 |
| P1-2 | 合并预览无"合并后形态"预演 | 只有影响计数，无产物预览（brief/资料/实体会变成什么样），决策信息不足 |
| P1-3 | 合并后 brief 占位且 refresh-brief 不自动触发 | 合并产物质量打折，agent 上下文消费"合并自X与Y"占位文本 |
| P1-4 | 路由串行 LLM 15-20s/文件且进度感知失真 | 延迟是成本权衡，但感知失真放大为"卡死"体验（蒙层刻意不展示 x/y） |
| P1-5 | auto Room"等待认领"无显式认领动作 | 文案承诺动作（i18n `autoCreatedBriefStatus`="自动创建，等待认领。"）但只有隐式"打开即认领"，可发现性差 |
| P1-6 | 同一动作两套词汇（"暂不创建" vs "忽略所选"） | 纯文案不一致增加学习成本 |
| P1-7 | 弱实体老化归档未实现（entity-room-plan E3） | 弱实体池只增不减，稀释解析池与推荐池信噪比；`lastLinkedAt` 字段已备（`entity-registry.ts:223`）但无老化 job，archived 仅由合并/删房产生 |
| P1-8 | 规则回填 matcher 受限 | threadId/filenamePrefix/creatorId 不可重放，回填价值打折（规则层是可选逃生舱，非阻断） |
| P1-9 | 连接器域行覆盖不全 | 规则/洞察素材覆盖缺口，学习原料受限（三级兜底待覆盖率 100% 后退役） |
| P1-10 | 外部源正文快照不可再生 | `route_decisions.sourceMarkdown` 是外部源唯一正文，缺失=决策不可解释、M3 证据采样降级 |
| P1-11 | existingRoomMatch / claimEntitiesForRoom 全表扫描 | 进程内线性热点随实体量恶化，叠加进路由延迟（`knowledge/service.ts:2164`、`entity-registry.ts:456`） |
| P1-12 | 合并红点 5s 补拉 workaround | 定时器掩盖防抖不一致，窗口期红点与弹窗数字不符（`HomeView.tsx:228`） |

### P2（5 条）

| 编号 | 痛点 | 理由 |
|---|---|---|
| P2-1 | RoomRecommendations 孤儿链 | 空常量→RoomRecommendationDialog→`HomeView.submitRoom`（`HomeView.tsx:232`，checkDuplicates→overrideToken 查重弹窗 `:380`）全链死代码。**注意：Studio→RUN_EVENT→PendingPanel 是活链（§2.3），不得混淆**；同时意味着"创建时查重"能力当前整体无 UI 消费方 |
| P2-2 | 证据进度条恒满死 UI | `scoreRatio = 1`（`KnowledgePendingPanel.tsx:908`），无信息量 |
| P2-3 | uploaded_files 双轨遗留 | 判重仍工作，纯技术债 |
| P2-4 | 晋升任务重复提交靠启动清理 | 运行期重复仅浪费资源 |
| P2-5 | BACKLOG_MAX_PASSES=3 不收敛即 warn | 边界参数缺说明与重试策略（`service.ts:135`） |

---

## 4. 改进方案与里程碑

### 4.0 总原则

交付顺序论证：M1 是 M3 的**采样前提**（纠正/处置/忽略等最高价值信号当前采样率为零）而非仅优先级排序；M2-C 是 M2→M3 的桥（先在 pair 级验证判定信号质量，再谈模式级归纳）；M2-D 与 M3 可并行。

```
M1(补洞+清理) ──┬──> M2-A/B(合并体验)    ──┐
               ├──> M2-C(判定消费) ─────────┼──> M3(学习闭环)
               └──> M2-D(性能卫生,可并行) ──┘
```

### 4.1 M1 交互补洞 + 死代码清理（网关零 schema 变更）

| 条目 | 解决 | 内容 |
|---|---|---|
| M1-A Room 详情纠正入口 | P0-1 | 资料树/文档/邮件条目菜单加"改归其他 Room / 移出本 Room"：改归=既有 attach 或 route/manual；移出=既有 revertDecision。UI 必须区分两动作语义（revert=撤决策+重路由；manual=直接指定），并呈现 revert 后重路由结果 |
| M1-B awaiting/pending 处置面 | P0-2 | KnowledgePendingPanel 未识别区从只读升为可操作：挂载到实体（attach）、改挂、忽略；pending_review 文件给确认入口 |
| M1-C 错误态/空态分离 | P0-3 | PanelEmptyState 增加 error 变体；八面板+pending 面板的 catch 分支从"静默空"改为"连接失败+重试" |
| M1-D auto Room 显式认领 | P1-5 | RoomCard/详情头加"认领"按钮 → 既有 upsertRoom（auto→user），认领后清除"等待认领"briefStatus |
| M1-E 词汇统一 | P1-6 | i18n 键收敛单一词汇表（暂不创建/恢复推荐一族），agent 描述层对齐 |
| M1-F 孤儿链清理 | P2-1 | 删 RoomRecommendations 空常量组件+Dialog+submitRoom+查重审查弹窗及其 i18n；**网关 duplicate-check/overrideToken 端点暂保留**（去留并入 M2-B：若 Studio 链需要补创建时拦截则复用，否则随 M2 删） |
| M1-G 进度条真值化 | P2-2 | scoreRatio 改为 evidenceScore/阈值真值，或移除进度条只留证据计数 |

**验收**：端到端冒烟（归错→详情改归→证据回算→原 Room 计数下降）；空/错态截图清单；删除后构建+测试全绿、无 dangling i18n 键（i18n.test 有 parity 校验）。

### 4.2 M2 合并机制优化

**M2-A 候选发现时机**（P1-1、P1-12）：
1. 红点一致性：`rebuildCandidates` 完成时把"open 候选数+重建版本"写入快照可读字段，桌面端随 rooms snapshot 轮询顺带刷新（轮询架构下实现为版本号顺带，**非事件推送**），删 5s 补拉。
2. **晋升完成即时定向评估**：promotion 终态 → duplicate-service 新方法 `requestTargetedAssess(newRoomId)`（仅新 Room vs 全库活跃 Room，复用 assess+缓存，避免全量两两）→ 新候选入池 → KnowledgePendingPanel 完成提示附带"检测到 N 个疑似重复"直达链接。
3. Room 详情菜单"检查重复"→ 同定向评估，供用户主动排查。

**M2-B 预览与合并产物增强**（P1-2、P1-3）：
1. `previewMerge` 增设**确定性合并预演 sketch**（纯读零 LLM）：两 Room brief 拼接、stats 合计、materials/files 计数、top 实体、时间线首尾；预览页加"合并后预览"区块，标注"预演非最终"。
2. 可选 LLM 增强：merge-name 同款 dispatch 追加 merge-preview 任务异步生成合并 background 草稿（chips 补位模式同构），失败保确定性拼接。
3. **合并完成自动 brief-refresh**：startMerge completed 分支 dispatch 既有 `refreshBrief`（幂等键 `merge-brief:${newRoomId}`），失败保占位不阻塞终态。**触发守卫**：startMerge 写入占位 brief 时携带专用标志位（data 字段或 hash），自动刷新仅当标志位仍在时触发——**禁止用"合并自"前缀匹配**（防误判用户手写）；用户已编辑（标志位被覆盖）则提示手动刷新，遵循"编辑即接管"。
4. 决策点：创建时查重是否在 Studio 链复用（existingRoomMatch 拦截之外补名称级提示），定论后处理 M1-F 暂留端点。

**M2-C 用户判定消费**（P0-4，M2→M3 之桥）：
1. LLM 层：`judgeEntityIdentity` prompt 注入 pair 历史（"用户于 X 日判非重复"），与 FilterInsightJob 注入误杀样本同构。
2. 确定性层：证据修订后重入 open 时 confidence 降为 pending、reason 标注"用户曾判非重复（日期），证据已变化"——不再高置信静默重现；unchanged-evidence 的 preserveDecision 行为**保持不变**。
3. 统计 overlay：跨对聚合"名称模式被反复判 distinct" → 内存/台账层调低该模式 nameScore 权重，不自动回写任何规则。
落点：`duplicate-service.assess/updateCandidate/rebuildCandidates` + `room_duplicate_candidates` 增判定台账列（decidedStatus/decidedAt，一次 drizzle 迁移）。

**M2-D 网关性能与卫生**（P1-7/8/9/10/11、P2-3/4/5，可与 M3 并行）：existingRoomMatch/claimEntitiesForRoom 按归一化名索引化或 name→id 缓存；E3 老化 job（FilterInsightJob 定时器模式，连续 N 天无新链且 weak → archived，阈值入 config，跳过正被合并/晋升引用的实体）；晋升提交时查 promoting 拒绝重复；uploaded_files 读路径统一后只读兼容一版再删；外部源快照保留策略+connectorMarkdownArtifacts 再生通道；BACKLOG 参数补文档。

**验收**：distinct 后证据不变同对不再高置信重现（API 冒烟断言）；晋升完成 ≤1 分钟新候选可见且无红点窗口；有 runtime 时合并后台 brief 非占位、无 runtime 保占位；索引化前后耗时对比。

### 4.3 M3 用户习惯学习闭环

架构 = writing-style 闭环组件 + FilterInsightJob 模式在知识整理域的重组。

- **学什么**（首期三类，按消费价值排序）：① 路由纠正类（revert/attach/M1 新增详情改归与移出、user 链接挂摘）；② 合并判定类（M2-C 已做 pair 级，M3 做模式级归纳）；③ 晋升意愿类（promote/suppress/忽略=弱负信号）。关系类、抑制类、坚持创建列二期（后者依赖 M1-F/M2-B 端点决策）。
- **怎么聚合**：新模块 `gateway modules/knowledge/preferences`——per-event sketch 纯函数（signals.ts 同款）；新表 `knowledge_preferences` 三段式（统计 sketch 段【确定性可复现】+ LLM 洞察段【修订式重写 ≤600 字】+ 用户偏好段【编辑即接管，永不自动覆盖】）；小时级洞察 job（隔离 runtime、只读工具、失败保旧、素材不可信声明——全沿 rules-insight.ts 防线）。
- **怎么呈现**：记忆页新增"整理偏好"区（writing-style tab 同款交互）：系统洞察只读+统计明细+"一键生成 routing_rules 草稿"（**用户显式确认才启用**——"建议优先、用户确认"的落点）。
- **怎么注入**（全部建议性、失败保旧）：① 路由 LLM extract/judge prompt 注入偏好摘要（LLM 失败瀑布不变）；② 合并 judge prompt 注入历史判定摘要；③ 推荐池排序偏好权重（确定性、可逆）。
- **禁入清单（契约）**：入口确定性、手动规则、`decidedBy=user` 链接——学习不可覆盖，需负向断言测试（§6）。
- **开关/冷启动**：学习总开关+注入开关分离（writing_style_settings 同款）；同型事件 <3 不入洞察；注入为空=现状行为。

---

## 5. 用户习惯学习可行性结论

### 5.1 判词：**有条件可行**

条件：① **M1 先行**——三类最高价值信号（详情改归、忽略、坚持创建）当前采样率为零，可行性依赖入口补全而非纯技术；② 学习只以建议形态注入（prompt 措辞/排序权重/需确认的规则草稿），永不自动回写、永不覆盖确定性与用户显式表达；③ 首期限三类信号+最小样本门槛（同型 ≥3）；④ 冷启动空注入=现状行为，验收按"可复现+可接管"而非准确率指标。

### 5.2 五维论证

1. **数据原料充分性**：12 类信号已持久化且字段完整（§2.5 台账），覆盖路由/合并/晋升/关系/纠正五域——缺的不是原料是消费端。缺口在 UI：三类高价值信号采样率为零（条件①），overrideToken 不持久化且链路已死（"坚持创建"信号当前事实上不存在，是 M1-F/M2-B 的权衡点而非终局）。
2. **架构先例可复用性**：强。writing-style 提供全套组件（信号采集纯函数、可合并 sketch、LLM 定性门槛与降级、画像"系统生成+用户接管"、开关分离、注入预算）；FilterInsightJob 提供小时级修订式洞察+最强信号注入+素材不可信声明。M3 是**换信号域重组**而非新架构，主要新增风险仅在多注入点的 prompt 预算。
3. **样本量与冷启动**：单人本地产品的纠正类事件天然低频（日均或 <5），模式归纳需按周窗聚合+最小样本门槛。冷启动期洞察空、注入空、行为与现状完全一致——可行性不因样本少破灭，只是价值爬坡慢，故按"增强层"而非"依赖层"定位（条件④）。
4. **误学习风险与回路延迟**：最大风险是一次性纠正被泛化。三层对策：确定性层只做计数与频次门槛（可复现）；LLM 层产出建议性洞察并注明样本数与时间窗；注入层永不写硬规则、永不覆盖 entry/rule/user 决策，最重影响=LLM prompt 措辞与候选排序——单次误学习最坏后果限于"一次次优推荐"，接管即时生效。回路延迟小时级、纠错成本一次编辑，风险收益比可接受。
5. **隐私与用户控制**：全本地 SQLite，无新增出域；洞察进 prompt 与 FilterInsightJob 同通道，沿用"素材不可信、只归纳不执行"声明；控制三件套=可见（记忆页洞察+统计明细）/可改（偏好段编辑即接管）/可关（学习与注入开关分离）。字面满足"建议优先、用户确认、可接管、失败保旧"。

### 5.3 条件不满足时的降级路径

M1 延后 → M3 降为仅消费存量信号（revert/attach/promote 历史），样本爬坡期拉长；LLM 不可用 → 统计 sketch 层照常积累，洞察段保旧/为空；用户关闭学习 → 全链路行为与 M2 末态逐字节一致。

**明确不可行（不在范围）**：自动回写 routing_rules；无人确认的自动合并/自动晋升阈值调整；跨设备画像同步。

---

## 6. 测试计划

1. **确定性单测**：M2-C preserveDecision 语义回归（证据不变保留/证据变降级 pending）；M2-A requestTargetedAssess 只评估新 Room；M2-B 占位标志位守卫（含用户编辑后不自动刷新）；M3 sketch 纯函数与最小样本门槛。
2. **LLM 金样本回归**：judge prompt 注入历史判定后的判定稳定性；洞察 job 复现性（同输入同输出，失败保旧）。
3. **端到端冒烟**：归错→详情改归→重路由；晋升完成→候选直达；合并完成→自动 brief-refresh→agent 上下文非占位。
4. **失败注入**：无 LLM/LLM 超时/知识服务不可用 → M1-C 错误态可见、M2-B 保占位、M3 注入空=现状。**禁入清单负向断言**：学习注入开启时，入口确定性/手动规则/decidedBy=user 链接的决策结果与关闭时逐字节一致。

---

## 7. 风险与边界

| 风险 | 处置 |
|---|---|
| 孤儿链清理误删活链（Studio→RUN_EVENT→PendingPanel） | M1-F 删除范围逐一列引用核验；保留网关端点 |
| 自动 brief-refresh 与用户编辑冲突 | 占位标志位守卫 + 编辑即接管 + 失败保占位 |
| distinct 信号压制真重复（用户判错） | 证据修订豁免（降级 pending 而非消失）+ 保留手动"检查重复"入口 |
| E3 老化与晋升/合并竞态 | 老化 job 跳过正被任务引用的实体 |
| M3 误学习泛化 | §5.2-4 三层对策 + 最小样本门槛 |
| M2-C 迁移与 onConflictDoUpdate 兼容 | 迁移先行 + 保留旧列一版 |
| 文档事实漂移 | 本稿所有 file:line 基于 2392c4b 核验；实施时以当时代码为准 |

**明确不在本方案范围**：合并执行事务语义改造；路由 LLM 并行化（吞吐属成本权衡，仅改善感知）；runtime 契约变更；跨设备同步；自动回写规则（永久禁区）。

---

## 8. 实施顺序与验收标准映射表

| 里程碑 | 条目 | 验收条目 | 关联测试 |
|---|---|---|---|
| M1 | A 详情纠正入口 | 归错→改归→原 Room 计数下降、证据回算 | e2e 冒烟 |
| M1 | B 处置面 | unmatched/pending 可挂载/改挂/忽略 | 单测+冒烟 |
| M1 | C 错误态 | 服务不可用显示"失败+重试"非空态 | 组件测试 |
| M1 | D 认领 | 认领后 briefStatus 清除、origin=user | 单测 |
| M1 | E/F/G | i18n parity 绿、构建全绿、无死引用 | i18n.test、build |
| M2 | A 发现时机 | 晋升完成 ≤1min 候选可见；红点无 5s 窗口 | API 冒烟 |
| M2 | B 产物增强 | 预览含预演区块；合并后 brief 非占位（runtime 可用时） | 单测+金样本 |
| M2 | C 判定消费 | distinct 同证据不再高置信重现；证据变降级 pending | 确定性单测 |
| M2 | D 性能 | 热点查询耗时对比基线；老化 job 幂等 | 单测 |
| M3 | 学习闭环 | 同输入洞察可复现；接管即时生效；禁入清单负向断言 | 四层全测 |

---

## 附A 关键文件清单

| 文件 | 动作 | 里程碑 |
|---|---|---|
| apps/desktop/.../KnowledgePendingPanel.tsx | 修改（处置面/认领/进度真值/完成提示） | M1/M2-A |
| apps/desktop/.../detail-panels/*（含 PanelEmptyState） | 修改（纠正入口/错误态） | M1 |
| apps/desktop/.../RoomDuplicateCenter.tsx | 修改（预演区块） | M2-B |
| apps/desktop/.../HomeView.tsx | 修改（删 5s 补拉/孤儿链） | M1-F/M2-A |
| apps/desktop/.../RoomRecommendations.tsx + RoomDialogs 查重弹窗 | 删除（活链 Studio 保留） | M1-F |
| apps/gateway/.../context-rooms/duplicate-service.ts | 修改（定向评估/判定消费/预演 sketch/自动 refresh 触发） | M2 |
| apps/gateway/.../context-rooms/service.ts | 修改（refreshBrief 守卫） | M2-B |
| apps/gateway/.../knowledge/service.ts | 修改（热点索引化/晋升去重/E3 触发） | M2-D |
| apps/gateway/.../knowledge/entity-registry.ts | 修改（老化 job/索引） | M2-D |
| apps/gateway/.../knowledge/preferences/（新模块） | 新建（sketch/洞察 job/表/路由） | M3 |
| apps/gateway/.../writing-style/* 与 ingest/rules-insight.ts | 只读参照（复用模式，不改） | M3 |
| i18n locales（contextRoom.json 等） | 修改（词汇统一/新文案/删死键） | M1-E/F |

## 附B 评审关注点（建议重点核对项）

1. **孤儿链定性**：RoomRecommendations 空常量组件注释原话是"推荐引擎未接入前留空"——是临时占位还是永久弃用？M1-F 直接删除是否需产品确认。
2. **duplicate-check/overrideToken 端点引用面**：除 submitRoom 死链外是否还有调用方（含测试），"暂保留"是否成立。
3. **P0-2 现状**：KnowledgePendingPanel 对 awaiting_review/unmatched 的交互覆盖是否如本文所述为只读（建议实机确认）。
4. **revert vs manual 双动作语义**：§4.1 M1-A 的交互定义是否符合直觉（撤决策重路由 vs 直接指定）。
5. **M2-A 推送措辞**：桌面↔网关是轮询 snapshot 架构，本文按"版本号顺带刷新"设计而非事件推送——是否接受。
6. **M2-B 占位守卫**：专用标志位方案 vs "合并自"前缀匹配，本文禁用后者——是否同意。
7. **M2-C 降级语义**：证据修订后降为 pending（仍可见）而非消失——尺度是否合适。
8. **M3 首期信号范围**：三类（路由纠正/合并判定/晋升意愿）是否认同；"坚持创建"延后到二期是否可接受。
9. **M3 禁入清单**：入口确定性/手动规则/user 链接三禁区是否完备（是否还需加入概览纠正）。
10. **里程碑排期**：M1→M2→M3 串行依赖是否与你的交付节奏匹配（M2-D 可与 M3 并行）。
