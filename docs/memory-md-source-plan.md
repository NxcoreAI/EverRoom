# MemoryCore md 文档链路 + 记忆溯源 — 实施方案（v2）

> 状态：草案待评审（未动工）
> 日期：2026-08-17；v2 修订：文档子系统整体下沉 MemoryCore 实现，gateway 退为薄代理（用户拍板）
> 前置：`docs/pi-agent-memory-plan.md`（已实施，pi agent 接入 MemoryCore）、`docs/memory-app-plan.md`（已实施，MemoryPage 查看链路）
> 范围：`TencentDB-Agent-Memory/MemoryCore`（fork，新增文档子系统）、`apps/gateway`（薄代理路由）、`apps/desktop`（MemoryPage 改造）

## 1. 背景与问题

### 1.1 现状三条事实（2026-08-17 探索结论）

1. **输入面只有会话记录**。进入 L0→L1→L2→L3 提炼管道的所有入口（`/v3/conversation/add`、auto-capture、`/seed`、skill conversation-add、Opik 导入）都只收 `{role: user|assistant, content}` 消息数组——角色枚举硬编码（`generated/schemas.ts:31`）、单条 ≤8192 字符、每批 ≤100 条。唯一直接吃任意 md 的口子 `/v3/core/write` 只覆写 L3 persona 单文件，绕过 L1 提炼与向量化（存了但不可召回）。文档本属兄弟服务 MemoryKnowledge（wiki），但 wiki 是全文检索，不是"把文档里的事实提炼成可召回记忆"。
2. **溯源是半成品，且 HTTP 上不可见**。L1 原子提炼时 LLM 被强制输出 `source_message_ids`，但只落 JSONL 文件；SQLite `l1_records` / TCVDB 均无此列（`core/record/l1-reader.ts:80` 注释直言 "not stored in SQLite"）；v3 API 的 `AtomicDetail` 响应（`v2-router.ts:1132-1141`）连 `session_id` 都不返回。
3. **存在现成溯源后门**。memory-generation-log 每次提炼跑批记 `input_refs`（L0 消息 id）→ `output_refs`（L1 id）+ session + prompt + model；`/v3/memory-generation-log/get` 支持按 memory_id 反查（`memory-generation-log-handlers.ts:57-65`）；`/v3/conversation/add` 返回 `accepted_ids`（`v2-router.ts:806`）。已知坑：`/atomic/update` 会清空重建记录丢 source ids（`v2-router.ts:1079`）；generation log 是 best-effort 写入。

### 1.2 已否决的备选（勿回退）

- **"md 伪装成会话"**（gateway 合成 role=user 消息，零 fork 改动）：提炼 prompt 对话语用错误（文档被抽成"用户表示……"）；污染 L0 空间与 conversation_search；文档专属抽取行为被堵死。
- **"gateway 来源登记层"**（v1 方案：memory_sources/memory_chunks 两表 + 分块器 + 三态收割 job 放 gateway）：文档是**记忆域**的关注点——原文、分块锚点、派生记忆分居两库造成跨库一致性负担；收割 job 只是在补偿"L1 没有可查询的 source_ref"；能力被锁死在 EverRoom gateway 后面，其他客户端无法使用。v2 全部下沉 MemoryCore。

## 2. 目标与非目标

**目标**

1. md 文档成为 MemoryCore **一等记忆来源**，以**文档子系统**形式实现（`/v3/document/*` API + 内部分块/版本/登记，原文不落盘只存引用）：文档分块入 L0（带 source 标记）→ 文档模式提炼 L1 → 进入正常召回（pi agent 自动召回 / memory_search 天然生效）。
2. **记忆溯源**：任意 L1 原子可回溯来源——会话（到消息级原话）或文档（到文件 + 标题路径 + 行区间）；反向：任一文档可列出派生记忆（`queryL1({sourceRef})` 直查，无需收割）。
3. 会话记忆溯源补完：`source_message_ids` 持久化进 SQLite/TCVDB 并经 API 暴露。
4. 文档导入能力对**任何 HTTP 客户端**开放，不依赖 EverRoom gateway。

**非目标（本期不做）**

- 不做 docx/txt 解析（对齐 knowledge file-convert 的拍板，仅收 md/markdown）
- 不替代 wiki(KS)：文档全文结构化检索仍是 wiki 职责，本链路只提炼"值得长期记住的事实/约束/做法"
- 不做文档→L2/L3 专属组织方式（文档原子照常参与场景聚合与 persona 综合，不排除——用户已拍板）
- 不做文档模式的 memory-prompt 自定义（v1 内置模板）
- 上游 PR 不作为交付条件（见 §12 风险）

## 3. 总体架构

```text
任意 md（粘贴文本 / 选 .md 文件 / [M4] wiki 已上传文件）
   │ desktop → IPC → gateway
   │   ① 原文落 EverRoom 知识资产层（uploaded_files/parsed_contents，
   │      file-storage 原语，不触发 wiki 路由瀑布）→ 得 file_id
   │   ② 携内容调 MemoryCore（file_id 作 caller_ref；补隔离参数）
   ▼
MemoryCore 文档子系统（fork 新增，/v3/document/*；只存引用，不存原文）
   ├─ documents / document_chunks 登记（版本、sha、caller_ref）
   ├─ 标题感知分块（≤6000 字符/块，块首带标题路径前缀）
   ├─ 复用 conversation-add 内部写路径写 L0（会话级 source 盖章，
   │    session_id = memdoc:<documentId>:v<n>，role=user 触发管道）
   ▼
MemoryCore 提炼管道（文档模式）
   L0（source_kind/ref）→ L1 文档模式提炼（新引言，type 限定，
   scene_name=文档标题，source_message_ids 落列）
   → L2 场景聚合照常；L3 persona 照常纳入文档原子（用户拍板：不排除，§5.4）
   ✅ 召回零改动：L1 召回是 agent 维度跨 session（v2-router.ts:1199），
      文档原子自动进入 pi agent 的 <memory-context> 与 memory_search

溯源：
   正向  L1.source_message_ids → L0 原话 / document_chunks 锚点（标题路径+行区间）
   反向  queryL1({ sourceRef: documentId })   ← 直查，无收割 job
   存量  /v3/memory-generation-log/get by memory_id 兜底
```

分工原则：**MemoryCore 拥有全部记忆域逻辑**（来源标记、分块、提炼模式、版本、溯源）；**gateway 只做代理**（鉴权、隔离映射、透传）；desktop 只做 UI。

## 4. MemoryCore 数据模型与存储

### 4.1 既有表加列（try/catch ALTER 在线迁移，`sqlite.ts:650-654、763-772` 惯例）

| 表/集合 | 新列 | 说明 |
| --- | --- | --- |
| `l0_conversations`（SQLite + TCVDB） | `source_kind TEXT DEFAULT 'conversation'`、`source_ref TEXT DEFAULT ''` | 会话级来源冗余盖章（MemoryCore 无 session 实体，按记录冗余是现状惯例）；JSONL `L0Record` 同步加字段 |
| `l1_records`（SQLite + TCVDB `l1_memories`） | `source_kind`、`source_ref`、`source_message_ids_json TEXT DEFAULT '[]'` | 提炼时从 L0 批次继承 source；source_message_ids 由"仅 JSONL"升级为持久化（反向溯源/正向锚点都靠它） |
| `l0_fts` / `l1_fts` | 对应列 | FTS5 不支持 ADD COLUMN，按 `sqlite.ts:1080` 先例重建镜像表 |

存量数据无需回填：默认值 `conversation`/`[]` 即正确语义。

### 4.2 新表：文档登记（IMemoryStore 增接口，SQLite/TCVDB 双后端实现）

```text
documents
  document_id     TEXT PK   -- doc-<uuid前12位>
  title           TEXT
  caller_ref      TEXT      -- 内容链接（如 EverRoom 的 uploaded_files.id），溯源跳转用，可空
  content_sha256  TEXT      -- 导入时对请求体计算，仅用于判重（不存原文）
  version         INTEGER   -- 从 1 起
  session_id      TEXT      -- memdoc:<documentId>:v<n>
  chunk_count     INTEGER
  team_id / user_id / agent_id   -- 隔离维度，同 L0/L1
  created_at / updated_at

document_chunks
  document_id     TEXT FK
  chunk_index     INTEGER
  message_id      TEXT      -- L0 record_id（溯源锚点）
  heading_path    TEXT      -- "部署手册 > 环境准备 > 依赖"
  line_start / line_end INTEGER
  （联合唯一 (document_id, chunk_index)；message_id 建索引）
```

### 4.3 原文不落盘（用户拍板：MemoryCore 只接收引用）

md 原文是**文档资产**，归调用方所有——EverRoom 侧即知识资产层 `uploaded_files`/`parsed_contents`（内容寻址、判重、版本已由 room-wiki-plan 建好）；MemoryCore 是记忆服务，不复制资产（与上游边界声明一致：README"存知识元数据，不存知识内容"）。导入请求**内容随体过境**（分块/提炼/sha 判重要用），但只持久化登记行的 `caller_ref`（内容链接）与 `content_sha256`；块文本进 L0 `message_text`（这本就是记忆数据）。推论：无 `/v3/document/markdown` 端点，原文预览与文件生命周期管理都在调用方；prompt 升级要重解析时，调用方携新内容重导入（升版）即可。

## 5. MemoryCore 文档子系统（core/document/）

### 5.1 chunker.ts（纯函数）

- 按 ATX 标题（`##` 起）切分；单块 ≤6000 字符（硬上限 8192，留前缀余量）；超长小节内部按段落二切。
- 块首带标题路径前缀：`【{title} > {heading_path}】\n\n{content}`——每块自含位置语境（§14 待拍板）。
- 上限：原文 >2MB 拒绝；>2000 块拒绝。

### 5.2 document-service.ts（导入/重导/删除）

1. **身份与幂等**：显式传 `document_id` = 重导；否则按 `(title, caller_ref)` 命中已有文档 = 重导。同 `content_sha256` 且同版本基线 → 跳过返回 deduped。
2. **重导**：`version+1` → 先删旧 session 的 L0/L1（复用 `/conversation/delete` 的级联删除 store 方法）→ 分块 → 写 L0 → 更新登记。
3. **写 L0**：复用 `handleConversationAdd` 的内部写路径（upsertL0 + embedding + JSONL mirror + pipeline notify；重构出共享函数供 conversation/document 两处调用），整批盖 `source={kind:'document', ref:documentId, title}`，块用 `role=user`（user 消息计 rounds 才触发提炼，`v2-router.ts:753`）。
4. **删除**：级联删 session L0/L1 + chunks + 登记行（原文归调用方，不动）。

### 5.3 提炼：文档模式（`core/record/l1-extractor.ts` + `core/prompts/l1-extraction.ts`）

批次 `source_kind='document'` 时切换：

1. **引言换文档框架**（与既有 chat/work 双模式并列的第三态）：

   > 以下是一份文档《{title}》的分块内容，每块开头标注了它在文档中的标题路径。请从中提取值得长期记住的**事实、约束、做法、决策**——即未来对话中可直接复用、能减少重复工作的信息。不要把文档内容当作用户说过的话；不复述文档结构本身；每条记忆的 source_message_ids 指向其依据的分块消息 id。

2. **type 限定**：只产 `work_fact / work_task / work_method / work_artifact / instruction`，不产 `persona / episodic`（文档不是用户人格与经历）。
3. **scene 处理**：不做 `previousSceneName` 连续性；`scene_name` = 文档标题（L2 场景聚合时同文档记忆自然成块）。
4. **溯源落列**：`source_kind/source_ref/source_message_ids` 随 MemoryRecord 落新列（`l1-writer.ts`/`l1-reader.ts` 增字段）。
5. **修 `/atomic/update` 清空行为**（`v2-router.ts:1073-1091`）：人工编辑内容时保留既有 source 三字段，只更新 content/version。

### 5.4 L2 / L3

- L2 场景聚合照常消费文档原子（scene_name=文档标题，同文档记忆倾向聚为同块）。
- L3 persona **照常纳入**文档原子（用户拍板：不排除——个人笔记类文档与"始终生效"型约束本就属画像，且这是"无条件生效"知识进入每轮上下文的唯一通道）。
- 配套小改动：persona 综合 prompt（`persona-generator.ts`）加一句文档场景的表述框架——以文档标题命名的场景代表"用户掌握的知识/资料域"，综合时表述为用户所掌握的领域与约束，不当作用户的对话行为陈述。避免产出"用户正在阅读《部署手册》"这类错位描述。
- 已知代价（接受，不另建机制）：场景块 `maxScenes=15` + heat 是零和，批量导入文档可能挤占交互场景；persona 是有损综合，文档重导后旧说法不会自动从 persona.md 消失（随下次综合自然更替）。缓解手段仅参数级：maxScenes/heat 阈值可调，观察后再动。

## 6. API（MemoryCore 新增 + 既有端点扩展）

### 6.1 新增 `/v3/document/*`（隔离同 v3 规则：team+agent+user）

| 端点 | 作用 |
| --- | --- |
| `POST /v3/document/import` | `{title, markdown, document_id?, caller_ref?}` → `{document_id, version, session_id, chunk_count, deduped}`（内容随体过境不落盘，同步写 L0，提炼照常异步） |
| `GET /v3/document/list` | 按时间/标题列文档（含派生记忆数） |
| `GET /v3/document/get` | `{document_id}` → 登记信息 + chunks（含 message_id/标题路径/行区间）+ 派生 L1 列表 |
| `POST /v3/document/delete` | `{document_id}` 级联删除 |
| `GET /v3/atomic/provenance` | `{memory_id}` → `{kind, session?, document?, anchors[]}`（正向溯源一站式） |

### 6.2 既有端点扩展

| 位置 | 改动 |
| --- | --- |
| `AtomicDetail`（`v2-router.ts:1132`） | + `session_id`、`source_kind`、`source_ref`、`source_message_ids` |
| conversation query/search 响应 | + `source_kind`、`source_ref` |
| atomic/conversation 的 query/search | 请求加可选 `source_kind` 过滤（conversation_search 默认排除文档块） |
| `queryL1` store 接口 | + `sourceRef` 过滤（反向溯源的查询基础） |
| memory-generation-log 类型 | + `source_kind` |

## 7. gateway（资产化 + 代理）

- 新增 `POST /v1/memory/import/markdown`：先把原文落**知识资产层**——直接复用 `modules/knowledge` 的 file-storage 原语（`storeFileBlob` + `uploaded_files` + `parsed_contents`），**不走 submitFileUpload 的路由 job（不触发 wiki 路由瀑布）**——得 `file_id` 后携内容调 `POST /v3/document/import`，`caller_ref=file_id`。粘贴与选文件两种 origin 走同一条资产化路径（粘贴本无 URL，资产化后统一有引用）。
- 其余透传：`/v1/memory/documents`（list/get/delete）→ `/v3/document/*`；`/v1/memory/atomic/:id/provenance` → `/v3/atomic/provenance`。
- 职责：持有 MemoryCore API key、隔离映射（默认传 pi agent 同款 `team=everroom/agent=pi-agent/user=local-user`，**保证文档原子能被 pi agent 召回**）、错误降级（`memory_disabled/unreachable` 惯例）。
- 原文预览复用知识侧既有链路 `GET /v1/knowledge/files/:id/markdown`（WikiPane"来源文件"同款 UI），记忆页经 `caller_ref` 即 file_id 直取，不新造预览端点。
- （M4）Room 关联：如需"文档↔Room"，gateway 侧另建轻量映射表，不进 MemoryCore。

## 8. 桌面端（apps/desktop）

- 链路照 memory-app-plan 模式：`shared/memory.ts` DTO + bridge（选文件复用 KnowledgeGatewayBridge.pickAndUploadFiles 的主进程文件选择框模式，读取后以 markdown 文本上行）+ preload channel + IPC handler。
- **MemoryPage**：
  - 顶部"导入文档"入口：粘贴 md / 选 .md 文件（内容限 2MB）
  - 新分区/Tab"文档来源"：来源卡片（标题、版本、派生数）→ 详情：md 全文预览（经 `caller_ref`→`GET /v1/knowledge/files/:id/markdown`，复用 WikiPane 零依赖轻量渲染）+ chunk 锚点高亮 + 派生记忆列表
  - L1 原子详情加**"溯源"区**：document → 文档名 + 标题路径，点击跳预览定位；conversation → 会话标题 + 原话消息，点击跳 L0 Tab 按会话过滤
  - L0 Tab：文档会话标"文档"角标 + "仅对话"过滤开关
- 降级沿用既有模式。

## 9. 代码改动清单

**fork（大头；commit → push NxcoreAI → 升 `apps/desktop/package.json` 两条 pin 至同 commit → FORK.md 登记）**：
- 新增 `core/document/`（chunker.ts、document-service.ts、types.ts）
- `core/store/sqlite.ts` + `tcvdb.ts` + `types.ts`：加列 + documents/document_chunks 表 + `queryL1` sourceRef 过滤 + FTS 重建
- `core/conversation/l0-recorder.ts`（L0Record 字段）、`core/record/l1-extractor.ts` + `l1-writer.ts` + `l1-reader.ts`、`core/prompts/l1-extraction.ts`（文档模式段）
- `gateway/generated/schemas.ts` + `v2-schemas.ts` + `v2-router.ts`：document 路由表、conversation/add 内部写路径重构共享、AtomicDetail 字段、source_kind 过滤、`/atomic/update` 保留 source 修复
- `core/persona/persona-generator.ts`（prompt 增文档场景表述框架，见 §5.4）
- `core/memory-generation-log/types.ts`

**gateway**：`modules/memory` 增 import 编排（复用 knowledge 的 file-storage 原语资产化原文，不触发路由）+ 代理路由（无新表、无迁移——uploaded_files/parsed_contents 已有）。

**desktop**：`shared/memory.ts`、main bridge/channels、preload、`MemoryPage` 系列组件。

**测试**：fork 侧 chunker 纯函数 + document-service 身份/级联（跟随 fork 内测试基建，若无则补最小 node:test）；EverRoom 侧 `tests/memory-doc-pipeline.test.ts`（走 gateway 代理的导入→派生→溯源→重导→删除全链路，参考 chat-memory-e2e-helpers.ts 起 MemoryCore 实例；Windows fs.rm maxRetries 兜底）。

## 10. 里程碑

- **M1 MemoryCore 子系统**：§4 列/表迁移 + §5 文档子系统 + §6 API + 提炼文档模式 + `/atomic/update` 修复 + pin 升级
- **M2 gateway**：§7 代理路由
- **M3 desktop**：§8 UI
- **M4 扩展（不承诺）**：Room 联动（wiki 资料沉淀为记忆）；memory_search 加 source_kind 过滤；上游 PR；会话溯源 UI 打磨

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| **fork 性质升级**：从补丁集变子系统，该区域上游同步基本放弃 | FORK.md 策略改写为"MemoryCore 承载文档子系统特性分支"；改动收敛在 `core/document/` + 触点文件清单内，重放边界清晰；仍可尝试拆 PR 上 upstream |
| FTS5 镜像表重建 | 跟随 `sqlite.ts:1080` 先例；迁移幂等 |
| 文档模式提炼质量未知 | 引言模板独立可迭代；验收含人工抽查；type 限定收窄出错面 |
| 批量导入文档挤占场景/persona 槽位（maxScenes=15 零和） | 用户已拍板纳入 L3；缓解仅参数级（maxScenes/heat 可调），上线后观察再动 |
| generation-log best-effort 丢日志 | 正向溯源主路径读 AtomicDetail 直存字段，不依赖 log；log 仅存量数据兜底 |
| 大文档多批写 L0 中途失败 | import 返回明确错误；重导整份重来（删 session 级联），不产生半截 L1 |
| 2MB/6000 字符等参数不当 | 全部集中为常量/配置，跑过即调 |

## 12. 验收标准

1. 直接对 MemoryCore（不经 gateway）`POST /v3/document/import` 一份多级标题 md，L1 出现文档派生原子；pi agent 新对话能自动召回其中事实（`<memory-context>` 可见）。
2. 任意 L1 原子溯源可见：document → 文档名 + 标题路径 + 行区间，UI 点击跳预览定位；conversation → 会话标题 + 原话消息，点击跳 L0 过滤。
3. `queryL1({sourceRef})` / `GET /v3/document/get` 列出派生记忆；同内容重导 deduped；改内容重导升版且旧 L1 级联清理；删除文档后 L0/L1/chunks/原文无残留。
4. MemoryPage L0 中文档会话带标注可过滤；conversation_search 不混入文档块。
5. 存量数据不回归：旧 L0/L1 默认 `conversation`/`[]`，既有会话浏览、召回、编辑行为不变。

## 13. 开放问题（待拍板）

1. **文档 type 限定集**：建议 `work_fact/work_task/work_method/work_artifact/instruction`，排除 `persona/episodic`。
2. **重导身份判定**：建议 `(title, caller_ref)` 命中即同源升版；还是要求 sha 相似度？
3. **chunk 带标题路径前缀**：建议带（自含语境）；代价是原子 content 可能沾标题词。
4. **文档隔离维度**：v1 挂 (team, agent, user) 与召回对齐（pi agent 可召回）；但"文档属用户、多 agent 共享"是否更对（涉及上游 asset/ACL 体系）？建议 v1 从简，M4 再议。
5. **L0 浏览默认是否隐藏文档会话**：建议默认显示 + 角标 + 可过滤。
6. **参数**：6000 字符/块、2MB 上限、2000 块上限——首版按此，跑过再调。

已拍板记录：
- **L3 persona 不排除 document 记忆**（2026-08-17，本文档 §5.4）。
- **原文不落 MemoryCore**（2026-08-17，本文档 §4.3）：原文属调用方资产，EverRoom 走知识资产层（uploaded_files/parsed_contents）持原文，MemoryCore 只存 caller_ref + sha，导入内容随体过境不落盘。
