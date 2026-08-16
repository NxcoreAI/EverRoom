# 实体先行的 Room 晋升制 — Room × Wiki 路由层重构方案（v2 草案）

> 状态：**草案，待评审**（未开工）
> 日期：2026-08-17
> 范围：`apps/gateway/src/modules/knowledge/`（主体重构）、`apps/gateway/src/infrastructure/database/`、渲染器资料归类面板
> 与现行方案的关系：**取代 `docs/room-wiki-plan.md` 的 §5（路由瀑布）与 §4.2（create_new 自动建 Room）**；该方案的其余部分（wiki 生命周期 §4.1、上传资料模型 §3.3、agent 消费 §6、KS 硬约束）原样沿用，本文不再重复
> 前置阅读：`docs/room-wiki-plan.md`（现行架构与术语）

## 1. 背景与动机

### 1.1 现行模型的缺陷是结构性的

现行路由：文档 → ③④ 产候选 → ⑤ LLM 从候选菜单里**选一个现有 Room**，或高置信判 create_new。实测暴露三个问题，提示词调参（2026-08-17 方案一）只能缓解、无法根治：

1. **单份证据即可立 Room**：create_new 由一份文档直接催生 Room，防碎片化全靠置信度门槛 + 事后 Dice 去重 + 提示词纪律——都是软约束；
2. **菜单呈现偏差**：给 LLM 一份非空候选菜单，它天然倾向"从菜单里挑"而不是"菜单外新建"——大杂烩（异构资料塞进先到的 Room）与菜单外新建不可得是同一枚硬币的两面；
3. **两套逻辑**：路由到现有 Room（⑤ 选 existing）与创建新 Room（⑤ 判 create_new + Dice 去重 + AUTO_CREATE 开关）是两条代码路径、两套阈值，长期双维护。

### 1.2 核心转向：Room 是实体证据累积的晋升产物

Room 必然围绕六类实体之一建立：**人物 / 项目 / 主题 / 长期目标 / 议题 / 事件**。流水线倒转：

```text
资料 → 先抽取实体（开放式，无候选菜单）
     → 实体进注册表，以"弱实体"（弱 Room）形态存在——证据不强，只是候选
     → 后续资料持续命中该实体，证据累积
     → 关联证据超过阈值 → 晋升为真 Room（此刻才建 wiki、才 ingest）
```

结构性收益：

- **单份资料永远无法直接造出 Room**——碎片化在构造上被消除，不靠阈值硬压；
- **菜单偏差消失**——LLM 的任务从"闭集单选"变为"开集抽取"，是它擅长的形态；
- **一套机制**——路由到现有 Room = 实体解析命中已晋升实体；创建新 Room = 弱实体累积转正。两条路径合一；
- **错误更便宜**——解析错/抽取偏的纠正成本是链接级（改 entity_id、合并实体），远低于错误 ingest（正反馈污染 wiki）。

## 2. 总体架构

### 2.1 新流水线

```text
资料（上传文件 / 外部信封）
  │
  ① 入口确定性（不变，decidedBy=entry）
  │    everroom-doc 自带 roomId → 直连 Room，零 LLM 成本，不抽取
  ② 链接与规则（不变，decidedBy=link/rule）
  │    a. 版本更新：同内容闸 1/闸 4 拦截；新内容 → 重新抽取解析（语义变更，见 4.6）
  │    b. 手动规则：默认空，逃生舱
  ▼
  ③′ LLM 实体抽取（唯一非确定性环节，取代原 summarize + arbitrate 两次调用）
  │    输出：{ summary, entities: [{ name, kind, salience, evidence }] }
  ▼
  ③″ 实体解析（确定性，零 LLM）
  │    name/alias 归一化精确匹配 → bigram Dice 模糊匹配（弱-弱高置信自动合并）
  │    → embedding 质心辅助消歧（可选，未配置则跳过）
  │    命中注册表 → 链接累积；未命中 → 新建弱实体
  ▼
  ④ 链接落库 entity_doc_links
  │    primary 角色 = salience 最高者（网关侧决定，不依赖 LLM 纪律）
  │    证据分随链接累积（4.3）
  ▼
  ⑤′ 晋升检查（每次链接落库后，确定性）
  │    弱实体证据分达阈值 → enqueue 晋升 job：
  │      0. 晋升前同名扫描：与全注册表 Dice ≥ 阈值 → 阻断自动晋升，出归并卡片（4.5）
  │      1. rooms 插行（origin=auto，title/kind/summary 来自实体）+ entities.status=room
  │      2. ensureWikiForRoom（现行 §4.1 原样复用）
  │      3. 批量 ingest：该实体 primary 链接的资料（每源最新版本）→ per-wiki 串行（D6 不变）
  │      4. 渲染器 syncAutoRooms（现行链路）拉到新 Room
  ▼
  已晋升实体的新资料：解析命中即归属 → 直接增量 ingest 进 Room wiki
  （= 原 ⑤ 判 existing 的执行路径，但判决者从 LLM 换成确定性解析）
```

### 2.2 关键决策

| # | 决策 | 理由 |
| --- | --- | --- |
| ED1 | **弱实体期不 ingest**：只存链接与元数据（资料标题、摘要、依据句），转正时才批量进 KS | 大多数弱实体永远不会转正，每弱实体一 wiki 是 KS 资源爆炸（沿 D1 懒创建初衷）；全局"暂存 wiki"混装所有未转正资料 = 把全局垃圾抽屉请回来。代价见 10（弱期不可语义检索） |
| ED2 | **LLM 只做抽取，不做归属判决**；解析、晋升、合并全部确定性 | 闭集单选是 LLM 的偏差重灾区；开集抽取是其强项。非确定性面收窄为单一 prompt |
| ED3 | **primary 由网关侧从 salience 推导**，不信任 LLM 的角色标注纪律 | 每份资料恰一个 primary（并列取二），多归属一致性由网关保证 |
| ED4 | **现有 Room 一律种子化为已晋升实体**（含 origin=user） | "路由到现有 Room"与"命中弱实体"共用同一套解析机制，消灭双路径 |
| ED5 | **① 命中的内部文档不跑抽取** | 保持 EverRoom 原生文档零 LLM 成本；user Room 的实体 alias 积累靠外部资料命中与手动改名（残缺点见 12.4） |
| ED6 | **晋升是软实时后台动作**，非同步返回 | 批量 ingest（阈值 3 → 3~6 分钟）不能阻塞上传链路；UI 出"正在沉淀"状态 |
| ED7 | **弱实体不维护合成式概述**：依据句日志（entity_doc_links.evidence）即事实源，UI 派生显示；**晋升时一次"转正登记" LLM 调用**综合产出规范 name、Room 概述、补 aliases | 每次链接跑 LLM 更新概述 = 花钱养弱期没人读的字段，且增量合并累积漂移；折进抽取调用需把注册表上下文带回抽取任务（菜单偏差复活）。晋升后概述的更新通道本就存在：KS wiki 实体页随 ingest merge 持续重写 |
| ED8 | **系统自主判定，不向用户索要确认**：模糊决策（弱-弱疑似同义、晋升撞名）由 LLM 同一性判定自动收敛；用户只做主动治理（自己想合并/转正/拆分时出手），系统从不弹确认卡片 | 确认疲劳会让队列形同虚设；此类错误可由审计 + E3 拆分纠正，代价远低于打扰成本。人审集中在"未识别资料"（抽取彻底失败）的尾部 |

## 3. 数据模型

### 3.1 新表（schema.ts，迁移 0007）

```ts
// 实体注册表：弱 Room 的本体，也是 Room 的"户口"。
// 一个实体两种状态：weak（候选，无 wiki 无 ingest）/ room（已晋升，roomId 回填）。
export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 曾用名/同义词（JSON string[]）：解析命中不同叫法时累积；合并时并集 */
  aliases: text("aliases"),
  kind: text("kind").notNull(),                    // 人物|项目|主题|长期目标|议题|事件
  /** 晋升时"转正登记"一次性综合产出（弱期为 NULL——依据句日志即事实源，ED7） */
  summary: text("summary"),
  status: text("status").notNull().default("weak"), // weak | room | archived
  roomId: text("room_id"),                          // 晋升后回填 rooms.id
  evidenceScore: real("evidence_score").notNull().default(0), // 见 4.3
  sourceCount: integer("source_count").notNull().default(0),  // 关联资料数（按 sourceId 去重）
  /** ④ 质心：弱实体从第一份资料就开始累积——冷启动问题随模型消失 */
  centroid: text("centroid"),
  centroidDocs: integer("centroid_docs").notNull().default(0),
  centroidModel: text("centroid_model"),
  createdAt / updatedAt / lastLinkedAt,             // lastLinkedAt 供老化归档（4.8）
});

// 资料 → 实体链接：归属的单一事实源（原 route_decisions 的归属语义迁到这里）
export const entityDocLinks = sqliteTable("entity_doc_links", {
  entityId: text("entity_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  role: text("role").notNull(),            // primary | mention | manual
  salience: real("salience").notNull().default(0), // 抽取时的分量快照
  /** 抽取依据句（原文短句）——"这个实体为什么存在"的可解释性来源 */
  evidence: text("evidence"),
  decidedBy: text("decided_by").notNull(), // resolution | user
  createdAt / updatedAt,
}, (t) => [uniqueIndex("entity_doc_link_uq").on(t.entityId, t.sourceKind, t.sourceId)]);
// 一份资料对同一实体只一行（新版本覆盖更新 role/salience/version）
```

### 3.2 既有表的变化

| 表 | 变化 |
| --- | --- |
| `rooms` | +`entityId`（反查户口）；其余不动。origin 语义不变（user/auto） |
| `route_decisions` | **降级为抽取审计日志**：记录每次抽取的原始输出与解析结果（source 快照、evidence、reason 照旧），不再承载归属语义；`decidedBy` 枚举改为 `entry \| link \| rule \| resolution \| user`。闸 ③（版本回原处）改查 entity_doc_links |
| `routing_rules` / `uploaded_files` / `parsed_contents` / `room_doc_links` | 不动。room_doc_links 成为晋升实体的派生视图（资料 primary 实体已晋升 → 即 Room 归属），见 4.4 |

### 3.3 存量映射（零数据窗口）

2026-08-17 已全量清库，无数据迁移负担。仅需代码级种子化：启动时（或迁移内）把 rooms 每行补一个实体——`{ name: title, kind, status: room, roomId, aliases }`。user Room 的资料归属仍走 documents.roomId（① 直连），不回填 entity_doc_links。

## 4. 机制

### 4.1 实体抽取（LLM）

一次调用取代原 summarize + arbitrate，成本不升反降。输出严格 JSON（复用现行剥围栏 + 失败带错误反馈重试一次的机制）：

```json
{
  "summary": "≤300 字资料概括",
  "entities": [
    { "name": "EverRoom", "kind": "项目", "salience": 0.9,
      "evidence": "通篇围绕 EverRoom 的记忆托管方案展开" }
  ]
}
```

提示词要点（草案，落地时细化）：

- name 用资料中的**规范叫法**（首次全称，后文简称可辨）；同一实体只出一个；
- kind 六选一；**通用词不是实体**（用户/API/系统/文档/数据……任何资料都会出现的词不成实体）；
- salience = 该实体在此资料中的分量 0~1：资料核心主题 ≈0.9，重要参与者 ≈0.5，顺带提及 <0.3；
- 单份资料实体数 ≤10；无实体时输出空数组（合法结果）；
- 只输出 JSON。

失败降级（对齐 D5 保守取向）：抽取失败/不可解析 → 资料进"未识别实体"栏人工挂载，不硬塞、不自动建实体，job 退避重试照旧。

### 4.2 实体解析（确定性）

```text
对抽出的每个实体（先做批内去重：同 kind + Dice ≥0.75 视为同一）：
  1. 精确：name/alias 归一化（NFC/去空白/小写）后与注册表比对
       ├─ 唯一命中 → 链接该实体
       ├─ 多个命中（同名异实体，如两个"张三"）→ embedding 质心最近者；
       │    未配置 embedding → 链接证据分高者（既定实体优先累积）
       └─ 未命中 → 2
  2. 模糊：bigram Dice（比对 name+aliases 全量）
       ├─ ≥0.75 且双方皆 weak → 确定性自动合并（低风险：都无 wiki）
       ├─ [0.6, 0.75) → LLM 同一性判定（见下）：同一 → 合并；不同 → 分立累积
       └─ <0.6 → 建新实体
  3. 新建 weak 实体：{ name, kind, evidenceScore 初始化 }
     （不写合成式 summary：依据句进 entity_doc_links.evidence，弱期概述由 UI 派生显示——ED7）
```

bigram/IDF/Dice 复用现行 `entity-index.ts` 的纯函数（比对目标从 wiki 页标题换成注册表）。质心复用 `embedding.ts` 的 EMA 更新（目标从 room_wikis 换到 entities，从第一份资料就累积）。

**LLM 同一性判定（judgeEntityIdentity，ED8）**：模糊带里唯一的不确定环节。一次廉价调用，输入 = 双方 name + aliases + kind + 各自依据句样本（各 ≤5 条），输出 = `{ same: bool, reason }`。确定性层处理清楚的，LLM 处理剩下模糊的，用户不被打扰。判"不同"的双方各自独立累积，若证据后来显示确实同义，用户可在实体面板手动合并（主动治理，非系统索要确认）。

### 4.3 链接与证据分

```text
链接落库（upsert entity_doc_links，同 source 新版本覆盖 role/salience）：
  role 推导（网关侧，ED3）：salience 最高者 = primary（绝对并列允许 2 个），其余 mention
                            用户手动挂载 = manual
证据分（按 sourceId 去重，新版本调整差额而非重复累加）：
  Δ evidenceScore = primary: +1.0 | mention: +0.4 | manual: +1.5
晋升条件：evidenceScore ≥ PROMOTE_SCORE(默认 2.0) 且 sourceCount ≥ PROMOTE_SOURCES(默认 2)
  → 3 份 primary；或 1 primary + 3 mention；或用户手动挂 2 次；组合皆可
```

典型画像：3 份核心资料转正；只被 mention 的配角实体（某人物在 5 个项目资料里被提及）约 5 份资料转正——符合"人物 Room 靠出场频次立起来"的直觉。

### 4.4 晋升

```text
触发：链接落库的事务内检查受影响实体，达标即 enqueue jobs { type:"knowledge.entity-promote", entityId }
worker（复用现行 job 队列与 per-wiki 串行约束）：
  1. 原子抢占：UPDATE entities SET status='promoting' WHERE id=? AND status='weak'
     （防并发重复晋升；抢占失败 = 已有并行 job 在处理，静默退出）
  2. 同名扫描（4.5）：与全注册表 Dice ≥0.6 命中已晋升实体
     → LLM 同一性判定：同一 → 弱实体整体并入该实体（链接迁移、证据分累加、aliases 并集，
       不建新 Room）；不同（含 kind 语义冲突）→ 正常走 3 起步晋升
  3. 转正登记（LLM 一次，ED7）：输入 = 该实体全部 evidence 依据句 + 关联资料摘要
     （route_decisions 快照）→ 输出规范 name（Room title 底稿）、Room 概述、可补 aliases；
     失败降级：现有 name + 首条依据拼底稿
  4. rooms 插行 { id: nanoid, title: 登记name, kind, origin:"auto", summary: 登记概述, entityId }
     entities: status='room', roomId 回填，summary 落登记概述
  5. ensureWikiForRoom(roomId)（现行 registry 原样）
  6. 批量 ingest：该实体 role∈{primary, manual} 的链接资料（每源最新版本）
     → 逐份 raw/write（闸 4 同名覆盖语义不变）→ /ingest → 轮询（现行 worker 全套）
     ※ mention 链接不 ingest（沿 D3：资料只进 primary 的 wiki，mention 留链接）
  7. 渲染器 syncAutoRooms 拉到新 Room（现行单向同步复用）；UI 徽标"由实体晋升"
失败语义：rooms 行已对外可见，ingest 失败不回滚 Room——走现行 job 重试/failed 语义，
     wiki 面板出"沉淀未完成"状态
```

晋升后的增量：新资料解析命中 status=room 实体 → 直接走现行 ingest 路径进该 Room wiki（等价于原 ⑤ existing 的执行，判决者换成了解析层）。

**概述的生命周期（ED7）**：弱期不维护合成式概述，依据句日志即事实源（UI 卡片派生显示"首条依据 + 共 N 条"）；晋升时一次"转正登记"综合出 Room 概述；晋升后的活概述 = **KS wiki 实体页**（ingest merge 随每份新资料持续重写）——概述的更新通道天然存在，无需实体层再做。rooms.summary 只是登记时的静态 blurb，用户可手改，E3 可选提供"从 wiki 重述简介"。

### 4.5 合并与同名

| 场景 | 处理 |
| --- | --- |
| 弱-弱，Dice ≥0.75 | 确定性自动合并（4.2）：链接迁移并集、aliases 并集、质心加权融合、证据分相加 |
| 弱-弱，Dice [0.6, 0.75) | LLM 同一性判定裁决：同一 → 自动合并（同上语义）；不同 → 分立累积 |
| 晋升时撞已晋升实体（Dice ≥0.6） | LLM 同一性判定：同一 → 弱实体并入既有实体（不建新 Room）；不同 → 正常晋升 |
| 已晋升-已晋升（Room 级合并） | 即原 M3c 的 Room 合并流（链接迁移 + wiki raw/rm 级联 + 目标 re-ingest），本方案不改其设计，实体层只需把两个 entity 行合一并指向目标 Room |
| 用户改名 / Room 认领改名 | 旧 name 追加 aliases（现行 rooms.aliases 语义平移到实体） |

所有自动合并均留审计（mergedFrom + 判定 reason），E3 提供拆分；用户在实体面板可随时**主动**合并/拆分——系统自主判定，不向用户索要确认（ED8）。

### 4.6 版本更新与删除

| 场景 | 处理 |
| --- | --- |
| 同名同内容重传 | 闸 1 全跳过（不变） |
| 同名新内容（版本更新） | **重新抽取解析**，链接跟随实体走：内容换了主题 → 链接迁移到新实体（若原实体已晋升且新 primary 仍是它 → raw/write 覆盖 + re-ingest，现行 ②a 语义）。与现行差异：不再"永久锁死第一个 Room"，闸 3 改查 entity_doc_links |
| 实体晋升前资料的旧版本 | 只 ingest 最新版（每源取最新，与现行 listRoomFiles 语义一致） |
| 资料删除 | 链接删除 + 证据分回扣；Room/wiki 清理走现行 document.deleted 流程 |
| 弱实体老化 | lastLinkedAt 距今 > STALE_DAYS(默认 90) 且 status=weak → archived（不可见、不参与解析；复活 = 新链接触发 status 回 weak） |

### 4.7 用户操作面

| 操作 | 入口 | 语义 |
| --- | --- | --- |
| 手动转正 | 弱实体卡片"转正为 Room" | 跳过阈值直接走 4.4 的 1-5 步（含同名扫描） |
| 手动建 Room | 现行创建流 | 实体直接以 status=room 落库（不经弱期），evidence 视为已满足 |
| 手动挂实体 | "未识别实体"资料栏 | 建/选实体 + role=manual 链接，+1.5 证据分 |
| 合并 / 拆分 | 实体详情（用户主动发起） | 4.5 语义；系统不索要确认 |
| 查看依据 | 实体详情 | entity_doc_links.evidence 依据句列表 + 关联资料清单 |

渲染器改造集中在"资料归类"面板（现 KnowledgePendingPanel 的演化）：**候选实体列表**（kind 图标、name、进度 `1.7 / 2.0`、材料数、转正/合并按钮）+ **未识别实体资料栏**。WikiPane、Room 详情、上报/认领闭环均不动。

## 5. 与现行实现的映射

| 现行模块 | 去留 |
| --- | --- |
| ① 入口 / ②b 规则 | 不变 |
| ②a 版本回原处 | 语义微调（4.6）：判重查 entity_doc_links，新内容允许重解析漂移 |
| 上传模型（uploaded_files/parsed_contents + 四道闸门） | 不变 |
| KS raw/write + ingest + per-wiki 串行 + 409 退避 | 不变（新增"批量转正 ingest"一种触发） |
| ensureWikiForRoom / room_wikis / agent 消费 / Room 上报认领 | 不变（建 Room 触发点从 create_new 换成晋升） |
| `entity-index.ts`（bigram/IDF/Dice） | 复用纯函数，比对目标 wiki 页标题 → 实体注册表 |
| `embedding.ts`（质心 EMA） | 复用，载体 room_wikis → entities，冷启动 <5 限制随模型消失 |
| `llm.ts` summarize + arbitrate | **重写为单次 extract**（4.1）；CandidateCard/dossier/parseArbitrationResponse 删除 |
| `router.ts` 瀑布 | **重构**：③′③″④ 取代 ③④⑤；create_new 出口与 Dice 去重删除 |
| `service.ts` job 队列 | 复用骨架；job 类型 route → extract，+entity-promote |
| 待归类队列（GET /knowledge/pending、确认/撤销） | **演化**为候选实体面板 + 未识别栏（API 见 7） |
| 置信度阈值 0.6/0.8、AUTO_CREATE_ROOM_ENABLED | **删除**，被证据分阈值取代 |

## 6. 配置（config.ts）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NXCORE_KNOWLEDGE_ROUTER_ENABLED` | `false` | 总开关（沿用） |
| `NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SCORE` | `2.0` | 晋升证据分阈值 |
| `NXCORE_KNOWLEDGE_ENTITY_PROMOTE_SOURCES` | `2` | 晋升最小资料数（防单份资料多角色刷分） |
| `NXCORE_KNOWLEDGE_AUTO_PROMOTE_ENABLED` | `false` | 自动晋升灰度开关（先手动转正观察抽取质量，再放开——对齐当年 AUTO_CREATE 的分阶段策略） |
| `NXCORE_KNOWLEDGE_ENTITY_MERGE_AUTO_DICE` | `0.75` | 弱-弱确定性自动合并线（免 LLM） |
| `NXCORE_KNOWLEDGE_ENTITY_MERGE_JUDGE_DICE` | `0.6` | LLM 同一性判定带下限（[judge, auto) 走判定） |
| `NXCORE_KNOWLEDGE_ENTITY_STALE_DAYS` | `90` | 弱实体老化归档天数 |
| `NXCORE_KNOWLEDGE_LLM_* / _EMBEDDING_MODEL` | 空 | 沿用 |
| ~~`ROUTE_THRESHOLD_AUTO` / `ROUTE_THRESHOLD_REVIEW` / `AUTO_CREATE_ROOM_ENABLED`~~ | — | 废弃 |

## 7. REST（routes.ts 增改）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/knowledge/entities?status=weak` | 候选实体列表（进度、材料数、pendingMerge 建议） |
| GET | `/knowledge/entities/:id` | 详情：链接资料 + evidence 依据句 |
| POST | `/knowledge/entities/:id/promote` | 手动转正（走 4.4 全流程） |
| POST | `/knowledge/entities/:id/merge` | body `{ targetId }`，4.5 各场景 |
| POST | `/knowledge/docs/:sourceKind/:sourceId/attach` | 未识别资料手动挂实体（body `{ entityId? \| createEntity: {name,kind} }`） |
| GET | `/knowledge/docs/unmatched` | 未识别实体的资料栏 |
| 现行 `/knowledge/pending` | 废弃 | 语义拆分为 entities + unmatched |
| 现行 confirm/revert | 演化 | confirm → attach；revert（撤销某资料的实体链接 → 重抽取）保留 |

## 8. 代码改动清单

| 位置 | 改动 | 量级 |
| --- | --- | --- |
| `infrastructure/database/schema.ts` + 迁移 0007 | +entities、+entity_doc_links、rooms.+entityId、rooms 种子化 | 小 |
| `modules/knowledge/llm.ts` | 重写为 extract（prompt + parseExtractionResponse） | 中 |
| `modules/knowledge/entity-index.ts` | 比对目标切到注册表（大部分复用） | 小 |
| `modules/knowledge/embedding.ts` | 质心载体切到 entities | 小 |
| `modules/knowledge/router.ts` | 瀑布重构（③′③″④）、create_new/Dice 删除 | **主体** |
| `modules/knowledge/service.ts` | job 类型改造 + 晋升 job + 批量 ingest 编排 | **主体** |
| `modules/knowledge/routes.ts` | 7 的新端点 | 中 |
| 渲染器 资料归类面板 | 候选实体 + 未识别栏 + 转正/合并/挂载 | 中 |
| 测试 | `tests/knowledge-routing.test.ts` 重写为解析/证据分/晋升纯函数测试 + 实体链路集成测试 | 中 |

## 9. 里程碑

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| **E1 抽取+注册表** | ③′ 抽取、entities/entity_doc_links、③″ 解析（含 LLM 同一性判定）、候选实体 UI（进度/材料/手动转正）；⑤ 仲裁下线，路由改为"解析命中已晋升实体即归属" | 上传文件不再直接出 Room，进候选实体并正确累积；EverRoom 原生文档行为不变 |
| **E2 自动晋升** | 阈值 + 晋升 job + 批量 ingest + 同名扫描（LLM 同一性判定）+ 渲染器同步 + 弱-弱自动合并 | 同主题连传 3 份 → 自动出现 Room 且 wiki 含全部资料；孤立单份永不产生 Room |
| **E3 治理** | 实体合并 UI（含已晋升）、改名级联、evidence 依据句视图、老化归档、Room 简介"从 wiki 重述"（可选） | 两个相近实体一键合并，链接与 wiki 正确迁移 |

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 抽取 name 归一化差 → 同实体裂成多个弱实体，各自到不了阈值 | 批内去重 + Dice ≥0.75 自动合并 + 建议卡片 + **手动转正兜底**；链接级纠错远便宜于错误 ingest |
| 弱期不可语义检索 | 接受（列表可看、md 可预览、转正即全量）；后续可加轻量 FTS |
| 转正批量 ingest 时延（3 份 ≈ 3-6 分钟） | 后台异步 + "正在沉淀"状态；per-wiki 串行本来如此 |
| 弱实体数量膨胀（每份资料抽 ≤10 实体，多数一次性的 mention） | 行级很轻（无 wiki 无内容）；UI 只展示 evidenceScore 达建议线的；STALE_DAYS 老化归档 |
| 同名异实体误合并（两个"张三"） | 确定性自动合并要求 Dice ≥0.75 且同 kind；模糊带与撞名场景经 LLM 同一性判定（输入含 kind 与依据句）；错合并可拆分（E3），链接级纠正 |
| LLM 同一性判定错判（该并没并 / 不该并并了） | 只发生在模糊带与晋升撞名两处，量小；reason 落审计可查；手动合并/拆分兜底（E3） |
| user Room 与外部实体分裂（ED5 的代价：内部文档不抽取，alias 不积累） | 晋升前同名扫描覆盖全注册表（含已晋升），撞名即阻断出卡片 |
| 抽取 LLM 单点故障 | 降级"未识别"栏人工挂载，不硬塞（D5 取向）；job 退避重试 |

## 11. 验收标准

1. **不立孤证**：单份异构资料上传后只出现候选实体（进度 <阈值），永不直接产生 Room。
2. **累积转正**：同一主题连续上传 3 份 → 第 3 份处理完毕后自动出现 auto Room，wiki 含 3 份资料的页面（AUTO_PROMOTE 开启时）；关闭开关时需手动转正，结果一致。
3. **命中即归属**：已晋升（含 user）实体的新资料，解析命中后直接进对应 Room wiki，无 LLM 仲裁环节。
4. **同名不重建**：晋升扫描撞现有 Room/实体且判定同一 → 链接并入既有实体，不建新 Room，全程无用户介入。
5. **零成本路径不变**：EverRoom 原生文档 ① 直连，无 LLM 调用；同名同内容重传闸 1 全跳过。
6. **可解释**：每个候选实体的详情页能列出全部依据句与关联资料；证据分可复算。
7. **可收敛**：弱-弱一键合并后链接/证据分/质心正确合一；手动转正即时生效。

## 12. 开放问题（待拍板）

1. **ED1 弱期不 ingest**——弱期语义检索缺失是否可接受？（推荐：接受，换来 KS 资源经济与无污染）
2. **阈值数字**——证据分 2.0 / 资料数 2、权重 1.0/0.4/1.5 这组默认值（结构对不对 + 数字合不合直觉；均可 env 调）
3. **版本更新重解析**（4.6）——放弃"文件永久锁第一个 Room"换主题漂移自由，是否认可？
4. **ED5 内部文档不抽取**——user Room 实体的 alias 积累受限，靠晋升前同名扫描兜底，是否足够？
5. route_decisions 是改造保留（审计日志）还是干脆换新表 extraction_log？（推荐保留改造，迁移面小）
6. 弱实体在渲染器的呈现位置：首页"资料归类"面板 vs 独立一级入口？
