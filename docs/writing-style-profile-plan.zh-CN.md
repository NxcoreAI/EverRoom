# 写作风格沉淀与应用（Writing Style Profile）

> 状态：**M1–M3 全部实现（2026-08-31）；2026-09-01 增补行为信号（§4.1：改写指令/修改原话/手改 diff 三类回溯）与漏洞修复（生成开关文案、清空语义、死代码清理、旧表迁移）。M1 管道+存储+REST+记忆页 tab（含用户风格编辑）；M2 补全/生成注入 + §7.4 合成；M3 LLM 定性层 + 语料列表/排除 + 定性展示。实现备注：生成侧经 runtimePrompt 每 run 组装注入（语义等同 §7.2 的 executionContexts 方案，且不改 runtime 契约）；补全侧注入块由 gateway 统一合成（§7.4 单一实现），renderer 只取用；LLM 定性层用隔离内部 Pi runtime 直调（runtime-factory `createWritingStyleRuntime`，ingest-filter 同款），不建 agent bundle
> 关联文档：[agent-document-development-sop.md](agent-document-development-sop.md)（规范真源，本方案不触碰其约束）、[knowledge-room-agent-plan.md](knowledge-room-agent-plan.md)（增量刷新管线参照）

## 1. 背景与目标

通用生成结果难以稳定贴合用户习惯：补全（cursor-completion）与内容生成（main agent 建档/改稿、划词改写）目前只依赖"当次上下文"，没有可复用的用户写作偏好。本方案：

1. 从用户已有文档提炼常用词、句式和结构偏好；
2. 将风格结果保存为可复用的用户写作偏好（用户全局一份）；
3. 在补全与内容生成时提供各自独立的应用开关；
4. 文档量较大时采用增量提炼，避免每次全量分析。

### 1.1 已确认的方向决策

- **交付节奏**：方案先行，评审后分期实现。
- **提炼引擎**：统计 + LLM 混合。确定性统计层负责可计算特征（词频、句长、结构占比），保证增量合并便宜、结果可复现；LLM 定性层低频归纳语气、口头禅等无法用规则稳定刻画的习惯。
- **作用域**：用户全局一份风格，不按 Room 拆分（样本量更容易积累；per-Room 覆盖见 §12 后续范围）。
- **首期 UI**：集成到记忆页（新增"写作风格"tab）。**单一画像文本**：系统从语料自动生成画像初稿，用户直接在其上编辑（对齐 CoreProfile 体验）；编辑即接管——refresh 永不自动覆盖用户版本，语料有新沉淀时提示可"从系统重新生成"。底部保留只读的系统统计明细（三维度 + 定性依据）。

### 1.2 核心思路：两层分离 + 单向数据流

```
确定性统计层（每文档，可增量合并）      LLM 定性层（全语料，低频归纳）
per-doc sketch ──merge──> 聚合统计 ──┬──> 定性结论 + 生成用摘要
                                     └────────> 补全用摘要（纯统计派生）

风格画像正文（单一文本：系统生成初稿 → 用户直接编辑其上；编辑即接管）
   └─ 注入的就是当前这份画像文本（无多段合成）
```

统计层是权威：LLM 只消费聚合统计与采样证据，不直接读全文；LLM 失败时统计层照常可用，注入链路不中断。这沿用了 knowledge 管线"agent → 单发 LLM → 非 LLM 兜底，任何一层失败不阻塞主流程"的降级哲学。接管语义保证用户的显式表达永不被自动覆盖；未接管时画像随语料增量自动演进。

## 2. 架构总览

```
documents 正文提交（既有路径，零改动）
   │  （同事务 outbox，参照 enqueueDocumentIngest）
   ▼
jobs: writing-style.extract（新 job 类型，每文档去抖 + 版本淘汰 + contentHash 去重）
   ▼
WritingStyleWorker ──> StyleAnalyzer（确定性统计：用词/句式/结构）
   ▼
writing_style_document_sketches（每文档快照，origin 判定 + 排除标记）
   │  （新增 ≥2 篇或 ≥5000 字时触发）
   ▼
jobs: writing-style.refresh
   ├─ 聚合：merge(sketches) → writing_style_profiles.statsJson（纯本地）
   ├─ 定性：LLM 归纳（样本门槛 + JSON Schema 校验 + 失败保留旧版）→ qualitativeJson + digestGeneration
   └─ 派生：digestCompletion（≤200 字符，仅统计信号）
   ▼
注入（各自独立开关，存 writing_style_settings）
   ├─ 补全：renderer 读 profile → prompt 动态段新增 <WRITING_STYLE> 标签（cursor-completion 子进程零改动）
   └─ 生成：AgentService run 上下文 → system prompt 追加风格段；划词改写 dispatch 输入同样附加
```

模块落点：`apps/gateway/src/modules/writing-style/`（新），渲染器 `pages/memory/WritingStylePane.tsx`（新）+ `detail-editor/documentCursorCompletionAgent.ts`（小改）。

### 2.1 与既有约束的关系（SOP 对齐）

- **不新增文档写 capability、不动 Operation Kernel、不改 Commit 路径**。风格提炼只读 `documents`/`doc_versions`，产出独立表；提炼 job 失败不影响任何文档链路。
- 注入只影响 prompt / 运行上下文，不赋予 agent 新工具或新写权限。
- 复用 `jobs` 表与 outbox worker 调度模式（去抖、版本淘汰、指数退避重试），与 `DocumentOutboxWorker` 同构但独立消费，不与 knowledge ingest 抢占同一 handler。

## 3. 数据库设计

四张新表 + 复用 `jobs` 表。迁移走 drizzle-kit（遵守 SOP §6），全部为新增表，无存量数据回填风险。

```ts
// 对齐 perception_settings 的单行设置模式（schema.ts:2048）
export const writingStyleSettings = sqliteTable("writing_style_settings", {
  ownerId: text("owner_id").primaryKey().default("local-user"),
  completionEnabled: integer("completion_enabled", { mode: "boolean" }).notNull().default(false),
  generationEnabled: integer("generation_enabled", { mode: "boolean" }).notNull().default(false),
  configVersion: integer("config_version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const writingStyleDocumentSketches = sqliteTable("writing_style_document_sketches", {
  documentId: text("document_id").primaryKey(),
  roomId: text("room_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  contentHash: text("content_hash").notNull(),          // 与 doc_versions 对齐的 sha256
  origin: text("origin", { enum: ["user", "agent"] }).notNull().default("user"),
  excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
  charCount: integer("char_count").notNull().default(0),
  status: text("status", { enum: ["pending", "extracted", "failed", "skipped"] }).notNull().default("pending"),
  statsJson: text("stats_json", { mode: "json" }),
  attempts: integer("attempts").notNull().default(0),
  extractedAt: integer("extracted_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const writingStyleProfiles = sqliteTable("writing_style_profiles", {
  ownerId: text("owner_id").primaryKey().default("local-user"),
  profileVersion: integer("profile_version").notNull().default(0),
  statsJson: text("stats_json", { mode: "json" }),        // 聚合统计（权威）
  qualitativeJson: text("qualitative_json", { mode: "json" }), // LLM 定性层（可空，可回退）
  digestCompletion: text("digest_completion"),            // （已废弃：单一画像后注入不再消费，列保留兼容）
  digestGeneration: text("digest_generation"),            // （已废弃：同上）
  sampleDocumentCount: integer("sample_document_count").notNull().default(0),
  sampleCharCount: integer("sample_char_count").notNull().default(0),
  confidenceTier: text("confidence_tier", { enum: ["empty", "sparse", "established", "mature"] }).notNull().default("empty"),
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }),
  lastLlmAt: integer("last_llm_at", { mode: "timestamp_ms" }),
  llmMaterialCursor: text("llm_material_cursor"),         // 上次 LLM 消费到的 sketch 集合指纹
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// 风格画像正文：系统生成初稿 + 用户直接编辑。userEdited=true 后 refresh 永不自动
// 覆盖（编辑即接管）；generatedFromCursor 记录生成时语料指纹（"有新沉淀"提示用）。
export const writingStyleUserContent = sqliteTable("writing_style_user_content", {
  ownerId: text("owner_id").primaryKey().default("local-user"),
  content: text("content").notNull().default(""),          // ≤2000 字符
  userEdited: integer("user_edited", { mode: "boolean" }).notNull().default(false),
  generatedFromCursor: text("generated_from_cursor"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
```

旧库兼容（client.ts 修复）：① `repairWritingStyleUserContentColumns` 按 PRAGMA 补 `user_edited`/`generated_from_cursor` 两列；② `migrateLegacyWritingStyleDirectives` 把 M1 指令表（`writing_style_user_directives`）的 enabled 指令迁入画像文本（接管态）后 DROP——须在 drizzle migrate 之后执行（老库的 user_content 由 migrate 创建）。

job 类型常量加入 `modules/documents/integration-outbox.ts` 同文件或新 `modules/writing-style/jobs.ts`：

```ts
export const WRITING_STYLE_EXTRACT_JOB_TYPE = "writing-style.extract";
export const WRITING_STYLE_REFRESH_JOB_TYPE = "writing-style.refresh";
```

## 4. 提炼语料的资格判定

风格应该学"用户写的"，而不是"用户收藏的"。判定规则（`StyleAnalyzer.resolveEligibility`）：

1. **文档状态**：`status = 'active'` 且 `deletedAt IS NULL`。
2. **长度门槛**：正文字符数 ≥ 500（过短的片段风格信号弱，会稀释统计）。
3. **origin 判定**：取该文档 `doc_versions` 最近 10 个版本：
   - 版本 1 的 `sourceTransactionId` 非空、且对应 operation 的 capability 为 `document.create` → `origin = 'agent'`（agent 流式生成的文档，**不计入**）；
   - 其余（编辑器保存的 `sourceTransactionId IS NULL`、markdown 导入、会议纪要写回后用户深度改写）→ `origin = 'user'`，**计入**。
   - v1 不做"用户对 agent 初稿的改写量"细粒度归因——导入与深度改写文档计入是可接受的近似，记忆页语料列表提供逐文档排除开关兜底（`excluded` 标记）。
4. **手工排除**：记忆页语料列表可将任意文档标记 `excluded`，聚合时跳过，并触发一次 refresh。

首次开启功能（任一开关从 off → on，或首次进入记忆页写作风格 tab 发现 profile 为空）时做**存量回填**：为所有合格文档各入队一个 extract job，复用同一条增量管线，不写独立的全量批处理路径。

### 4.1 行为信号（2026-09-01 扩展：从"用户怎么写/怎么改"提炼）

静态文档只是结果，行为才是最强的风格信号。新增 `writing_style_signals` 表（迁移 0045）与三类信号，全部在 refresh/启动兜底时**只读回溯**（不动文档提交链路）：

1. **rewrite_instruction**：划词改写的 `input.instruction`（selection-rewrite operation，completed）——用户对改写的显式要求原话。
2. **edit_instruction**：document.edit/continue 的 operation（completed）经 runId 反查 `agent_runs.prompt`——用户让 agent 改文档时说的原话。
3. **revision_delta**：`doc_versions` 中 agent 版本（sourceTransactionId 非空）→ 下一个用户版本（null）的手改对；连续 agent 版本取最后一个配对；做方向性轻统计（lenBefore/After、句长中位数、感叹号净变化）+ before/after 摘录（快照被 Yjs 淘汰的版本跳过；配对文本 <24 字过滤噪音）。

**消费方式**（归类统计 + LLM 证据）：
- `signals.ts` 表驱动归类（concise/formal/casual/structured/detail/tone_soft/tone_direct/punctuation 等，未命中仍采样）；
- 归类计数直接进画像文本的"行为偏好"段（无需 LLM 即可见，如"修改指令「更简洁」8 次；你常把 Agent 输出改短（平均 -15%）"）与记忆页摘要；
- 指令原话采样 + revision 样例（≤3 对）作为定性 LLM 的"用户行为证据"区，并标注**最强信号优先于统计**；
- 语料指纹（cursor）= sketch 集 + 信号集：新行为信号会触发画像重生成与"有新沉淀"提示；仅行为信号、无文档语料时也生成画像文本。

## 5. 统计层设计（StyleAnalyzer，确定性）

输入为 `documents.contentJson`（Tiptap JSON，schemaVersion 3）。服务端直接遍历 JSON 而非转 markdown——结构信号（任务列表、表格、层级）在 JSON 上无损。遍历设节点预算（参照编辑器 `nearbyBlocks` 的 64 节点预算思路，服务端放宽至 20000 节点/2MB 文本，超限截断并标记 `truncated`）。

### 5.1 用词（vocabulary）

- **中文高频词**：无第三方分词依赖，v1 采用 2-gram 频次 + 停用词表（虚词/标点）过滤，取语料级 doc-frequency top 40；`tokenize()` 独立成接口，后续可替换分词器（如 jieba-wasm）而不动上下游。
- **英文词**：小写归并 + 简单词形折叠（去 s/es/ed/ing），doc-frequency top 20。
- **标点习惯**：顿号/逗号/分号/冒号使用比、中英标点混用率、感叹/问号频率、省略号与破折号频率。
- **中英混排率**：拉丁字符占比分布。

### 5.2 句式（sentence patterns）

- 按 `。！？；…` 切句（保留英文 `.!?`），统计句长分布（p25/p50/p75/p90）、长短句比（>40 字 / <15 字）。
- 连接词/转折词表命中率：`因此/所以/不过/然而/另外/首先/其次/最后/总之/综上`（表驱动，可扩充）。
- 疑问句率、感叹句率、列表内并行短句率。

### 5.3 结构（structure）

- heading 层级深度分布（H1–H4 使用率）、平均段落长度、段落数/千字。
- 列表（bullet/ordered/task）与表格、引用块、代码块的千字占比。
- 开篇模式：首块类型（heading / 纯段落 / 列表）+ 首段是否含总结性句式（"本文/以下是/结论"表驱动）。
- 结尾模式：末块是否为行动项（task list）或总结段（"综上/后续/下一步"表驱动）。

### 5.4 可合并性（增量更新的基础）

所有信号均为**计数或分布**，sketch 之间可加权合并，不需要重读旧文档：

```
merge(sketches) = Σ(count_i × w_i) / Σ(w_i)，w = 1（时间衰减为后续可选，见 §12）
```

**信号支持度**（防少量样本过度确定的第二道闸）：任一信号进入注入摘要的条件是 `出现的文档数 ≥ 2` **且** `出现率 ≥ 30%`。单篇文档的高频词只进 sketch，不进 profile 摘要。

## 6. LLM 定性层

- **触发条件**：`llmMaterialCursor` 之后新增 ≥ 2 个 extracted sketch 或 ≥ 5000 字，且总量 ≥ 3 篇 / ≥ 3000 字。不满足则只刷新统计层。
- **输入**：聚合统计 JSON + 采样证据（top 高频词各附 1 个原句、开篇/结尾示例各 3、典型长短句各 3）。**不送全文**——控制成本与隐私面。
- **输出**（JSON Schema 校验，`additionalProperties: false`）：

```jsonc
{
  "tone": ["冷静克制", "偏口语"],          // 语气特征
  "phrases": ["倾向于", "值得注意的是"],   // 口头禅/惯用语
  "preferences": { "do": ["短句收尾"], "dont": ["避免长定语从句"] },
  "summary": "一句话画像"
}
```

- **prompt 硬约束**：只陈述有语料支撑的结论，证据不足的字段返回空数组；禁止输出统计以外的推断（如猜测职业身份）。
- **失败策略**：schema 校验失败重试 1 次，仍失败则保留上次 qualitativeJson 并记 job 错误，统计层与注入不受影响。
- **调用方式**：对齐 knowledge 模块 `this.llm` 直接调用模式（`knowledge/service.ts:665` 同款），**不建 dispatch_only agent bundle**——这是内部后台任务，无用户对话、无工具需求，直接调用更简单且省一层编排。

## 7. 注入设计（两个独立开关）

### 7.1 补全注入（开关 completionEnabled）

- **读取**：renderer 通过新 IPC `writingStyle.get` 拿 profile（主进程 bridge → `GET /v1/writing-style`，10 分钟 TTL 缓存 + profileVersion 比对）。
- **注入点**：`documentCursorCompletionAgent.ts` 的 `buildDocumentCursorCompletionPrompt`（:257-300）动态段新增 `<WRITING_STYLE>` 标签，置于 `<EDITOR_CONTEXT>` 之后。
- **前缀缓存不受影响**：固定指令段保持全量固定（该文件 :266-269 注释明确的既有设计意图）；风格摘要属于动态段，且内容天级稳定。
- **预算**：`digestCompletion` ≤ 200 字符，只含用词/标点/句长倾向等统计信号（FIM 场景延迟敏感，定性层只保留 top 3 短语偏好）。
- **cursor-completion 子进程零改动**：风格随 prompt 上下文进入，独立子进程无需访问 documents（其 Fastify 裁剪版中文档注册表本就是 undefined，保持隔离）。
- **关闭语义**：开关读取在 renderer settings，关闭时完全不构造 `<WRITING_STYLE>` 标签。

### 7.2 生成注入（开关 generationEnabled，服务端强制）

- **读取与强制**：开关在 gateway 侧读取（`writing_style_settings`），不信任 renderer 传参——生成发生在 gateway，此处天然可服务端强制。
- **main agent**：经 `runtimePrompt` 把注入块并入每 run 的 prompt（`agent/service.ts`，provider 由 create-server 接线，开关 gateway 强制读取）。**作用范围是全部主 Agent 轮次（含纯对话问答）**——UI 开关文案如实标注；聊天里语气也会带画像，这是有意取舍（"文档相关轮次"无法精确判定）。
- **划词改写**：`room-agent.ts` `dispatchDetached`（:323）组装 task input 时，开关开启则把 `digestGeneration` 附加到 context-room 子 agent 的输入上下文。
- **关闭语义**：开关关闭时 executionContext 不携带该字段，system prompt 与 dispatch 输入中无任何风格内容（验收：关闭后不注入）。

### 7.3 开关与置信的交互

`sparse` 档（< 3 篇）时即使开关开启也注入降级内容：仅注入满足 §5.4 支持度门槛的少量统计信号，并在记忆页明示"文档样本较少，风格参考有限"。开关表达用户意图，置信门槛表达系统谨慎，两者独立生效。

### 7.4 注入合成与用户正文优先级

注入块 = 当前画像文本（系统生成或用户编辑后的版本，单一来源）：

```
<WRITING_STYLE>
语气：冷静克制、偏书面。惯用语：值得注意的是。
句式：句长偏短（≤15 字占 62%）；惯用顿号并列。结构：惯用 H2/H3 层级，结尾行动项收束。
（用户可直接编辑这份文本；编辑后的版本原样注入）
</WRITING_STYLE>
```

- **单一来源消解了优先级问题**：画像文本本身就是权威；用户编辑过的版本与系统统计不存在"同屏竞争"。
- **接管后的画像不受置信门槛约束**：显式意图无需样本支撑；`sparse` 档只影响系统自动生成的内容（§7.3）。
- **预算**：画像文本按档截断——补全 ≤ 350、生成 ≤ 700 字符，优先落在句末边界（不切半句），无句读则硬切加省略号；文本为空不注入。
- **服务端合成**：生成侧的合成在 gateway 完成（executionContext 携带合成后的块）；补全侧在 renderer prompt 构造时合成——两个开关是整块的闸门，关闭即 `<writing_style>` 不出现。

## 8. REST 与 IPC 面

Gateway（`modules/writing-style/routes.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/writing-style` | profile + sampleStats + confidenceTier（只读） |
| GET / PUT | `/v1/writing-style/settings` | 两开关读写（PUT 校验字段，bump configVersion） |
| POST | `/v1/writing-style/recompute` | 全量重算：清 sketches 重建 + 强制 refresh |
| POST | `/v1/writing-style/documents/:id/exclusion` | body `{excluded: boolean}`，切换后触发 refresh |
| GET | `/v1/writing-style/corpus` | 贡献文档列表（id/title/charCount/origin/excluded/extractedAt），记忆页语料列表用 |
| GET / PUT | `/v1/writing-style/user-content` | 用户风格正文读写。PUT 为**全量替换**（对齐 CoreProfile writeCore 语义）；校验：≤2000 字符、去空白 |

Desktop（preload + main bridge，模式对齐 `diary:settings`）：

```ts
writingStyle: {
  get: () => invoke('writing-style:get'),
  getSettings: () => invoke('writing-style:get-settings'),
  updateSettings: (input) => invoke('writing-style:update-settings', input),
  getUserContent: () => invoke('writing-style:get-user-content'),
  replaceUserContent: (content) => invoke('writing-style:replace-user-content', content),
  recompute: () => invoke('writing-style:recompute'),
  listCorpus: () => invoke('writing-style:list-corpus'),
  setExclusion: (documentId, excluded) => invoke('writing-style:set-exclusion', ...),
}
```

**事件**：不新增 WS 通道。记忆页 tab 打开时拉取 + 重算/开关操作后主动刷新；补全侧靠 TTL + profileVersion 比对。风格更新是天级低频事件，不值得为此扩事件面。

## 9. 记忆页集成（渲染器 UI）

风格画像不放设置页：它是"从用户文档自动沉淀的偏好"，与设置页的"配置"语义不符，而记忆页已有同构先例——`filter-rules` tab 就是"系统自动沉淀偏好（只读洞察）+ 用户侧操作"的形态。写作风格作为画像层（L3"核心画像"）的延伸，是"我怎么写"相对于核心画像"我是谁"的补充。

改动点：

- `pages/memory/useMemoryData.ts:72`：`MemoryTabId` 增加 `'writing-style'`；`TABS`（`MemoryPage.tsx:21`）在 `core` 之后、`ledger` 之前注册新条目（level 标 L3）。
- 新增 `pages/memory/WritingStylePane.tsx`，完整落地 FilterRulesPane 的双段布局（用户段可编辑 + 系统段只读，首期即含编辑）：
  - **风格画像段（单一文本，系统生成 + 直接编辑）**：对齐 CoreProfilePane 体验——系统 refresh 自动维护画像文本（未接管时随语料演进）；用户点"编辑"进入 textarea（12 行、≤2000 字符）直接在系统版本上改，保存即接管（`userEdited=true`，refresh 从此不覆盖）并立即失效补全注入缓存；**保存空文本 = 解除接管并立即回填系统版本**（编辑态的"清空并回到系统版"按钮同语义）；接管后显示"已由你接管"徽标，语料有新沉淀时黄字提示并可"从系统重新生成"（确认后覆盖、解除接管）；
  - **状态卡**：样本量（N 篇 / X 字符 / 覆盖 Room 数）、置信档位、最后更新时间；`sparse` 时黄字提示样本不足；
  - **系统沉淀摘要段（只读）**：用词 / 句式 / 结构各列 top 信号（statsJson + qualitativeJson），标注支持度（如"出现于 7/12 篇"）；定性层缺失时只展示统计摘要并标注"定性归纳待样本积累"；
  - **应用区**：补全应用 / 生成应用两个独立开关（读写 `writingStyle.updateSettings`），各自一句说明作用范围（两个开关对用户正文与系统摘要同时生效）；
  - **操作**：立即重算（二次确认 + 进度态）；语料列表（id/title/字数/origin/排除开关）。
- 沿用记忆页既有模式：`MemoryEmptyView` / `memoryFailureText` / `useAsyncData`（失败与空态展示不重造）；侧边栏经 `MEMORY_TAB_EVENT` 跳转 tab 的机制天然可用（风格重算完成的通知若需要，走同一事件打开本 tab）。
- **i18n**：挂 `memory:` 命名空间（`locales/*/memory.json`），不重蹈 detail-editor `saveState` 硬编码中文串当 key 的覆辙。

## 10. 增量与一致性

- **入队时机**：`enqueueWritingStyleExtract` 与 `enqueueDocumentIngest` 同事务（在 `core/commit-service.ts` `applyPrepared` 的 outbox 附近追加，只加一行入队，不改提交语义）。删除路径同理挂 `document.delete`。
- **调度**：`WritingStyleWorker` 参照 `DocumentOutboxWorker`（`modules/ingest/document-outbox-worker.ts`）实现：同文档旧版本 job 直接 `superseded` 完成；新 job 需过 debounce 窗口（v1 取 60s，比编辑保存的 300ms 防抖宽得多，风格不赶实时）；失败指数退避重试（5s 起，上限 5 分钟，attempts ≥ 5 转 `failed`）。
- **幂等**：extract 前比对 `doc_versions` 的 contentHash 与 sketch 已存 hash，相同则 `skipped`。
- **refresh 合并触发**：extract 成功后检查自 `llmMaterialCursor` 起的增量是否达到 §6 阈值，达到则入队 refresh（refresh job 本身以 `writing-style:refresh` 单例 ID 去重，进行中则跳过）。
- **重算**：`recompute` 清空 sketches + profileVersion 重置，为全部合格文档重新入队 extract（与存量回填同路径）。**用户正文表不在重算范围内**——物理隔离保证重算零触碰。
- **崩溃一致性**：全部状态在 SQLite，job 状态机与既有 worker 语义一致；启动时无需专门恢复逻辑（pending job 自然被 drain）。

## 11. 测试计划

- **StyleAnalyzer 单测**：固定 Tiptap JSON 输入 → 期望统计值（句长、标点比、结构占比、高频词）；截断预算行为。
- **merge 单测**：交换律 / 结合律（merge(a,b) === merge(b,a)，任意顺序结果一致）；支持度过滤（单篇高频词不进摘要）。
- **资格判定单测**：agent 流式创建文档排除、导入计入、短文档跳过、`excluded` 生效。
- **Worker 单测**：版本淘汰、contentHash 幂等、退避重试、refresh 单例去重（对齐 document-outbox-worker.test 模式）。
- **REST 合同测试**：settings 读写与校验、user-directives 全量替换与校验（长度/条数/空内容拒绝）、recompute、exclusion（参照 `documents.test.ts` 模式）。
- **注入断言**：`buildDocumentCursorCompletionPrompt` 在开关 on/off 下 `<WRITING_STYLE>` 标签的有无与内容截断；**合成顺序断言**（用户正文段在前 + 优先级措辞存在 + 超预算按句末边界截断）；runtime-factory system prompt 段落的有无；`dispatchDetached` 输入的有无。
- **隔离性测试**：recompute / refresh / LLM 失败路径执行后 `writing_style_user_directives` 行数与内容不变。
- **LLM 层**：schema 失败 → 重试一次 → 保留旧 qualitativeJson 的降级路径。
- 无新 operation/capability，不触发 SOP §7 的集成测试要求。

## 12. 风险与边界

| 风险 | 缓解 |
|---|---|
| 少量样本得出过度确定的结论 | 三道闸：置信分层（<3 篇 sparse）、信号支持度门槛（≥2 篇且 ≥30%）、LLM prompt 硬约束 + 输入只有统计与采样证据 |
| 补全前缀缓存失效 | 固定指令段不动；风格进动态段且天级稳定，缓存命中不受影响 |
| 隐私 | LLM 只送统计 + 采样句不送全文；全部计算在本地 gateway |
| 性能 | 统计层纯 CPU（毫秒级，有节点预算）；LLM 低频（增量阈值触发）；重算可后台进行不阻塞 UI |
| 风格漂移（用户文风变化） | v1 全量等权；时间衰减（近 90 天权重 1.0 / 更早 0.5）列为后续可选，只改 merge 公式 |
| 误学 agent 生成内容 | origin 判定 + 记忆页语料列表逐文档排除 |
| 用户接管后遗漏系统新统计 | "有新沉淀"提示 + 一键重新生成（整份覆盖，明示会丢弃修改） |
| 画像文本质量劣化生成（过长/自相矛盾） | 服务端校验（≤2000 字符）+ 注入预算按句截断 |

**明确不在本方案范围（后续另议）**：per-Room 风格覆盖、多 profile 切换、接管版本与系统新版本的逐字段 diff/合并（v1 只提供整份"重新生成"）、补全与生成之外的注入点（如导出模板）。

## 13. 实施顺序与验收映射

- **M1**：迁移 + `modules/writing-style/` 骨架 + StyleAnalyzer + Worker + settings/profile/user-content REST + 记忆页 tab（状态卡 + 开关 + 正文编辑）。
- **M2**：补全注入 + 生成注入（§7.4 合成：用户正文 + 系统摘要，runtimePrompt → run prompt 段 + dispatch 输入）+ 端到端联调。
- **M3**：LLM 定性层 + 记忆页三维度摘要/语料列表/排除 + 重算。

验收标准映射：

| 验收条目 | 对应实现 |
|---|---|
| 可从已有文档生成风格结果 | §4 回填 + §5 统计层 + §6 定性层 |
| 覆盖用词、句式、结构偏好 | §5.1–5.3 三维度 |
| 补全、生成分别可开关 | §7.1/§7.2 两独立开关 |
| 开启后使用已沉淀风格，关闭后不注入 | §7 注入点 + 关闭语义（renderer 不构造标签 / gateway 不携带字段） |
| 新增或更新文档后增量更新，无需全量 | §10 增量管线（去抖、幂等、merge） |
| 用户可编辑风格（单一画像文本，系统生成 + 直接编辑 + 接管语义） | §3 user_content 表（userEdited/generatedFromCursor）+ §8 REST（含 regenerate）+ §9 编辑段 + refresh 自动维护 |

## 附：关键文件清单

新增：
- `apps/gateway/src/modules/writing-style/{service,analyzer,worker,routes,jobs}.ts` 及测试
- `apps/desktop/src/renderer/src/components/pages/memory/WritingStylePane.tsx`（新）+ `MemoryPage.tsx`/`useMemoryData.ts` 注册 tab
- drizzle 迁移（四张表：settings / sketches / profiles / user-content）

修改（均为小改）：
- `apps/gateway/src/modules/documents/core/commit-service.ts`：applyPrepared 后同事务追加 extract/delete 入队（各一行）
- `apps/gateway/src/infrastructure/database/schema.ts`：三张新表
- `apps/gateway/src/server/create-server.ts`：注册 writing-style 路由与 worker
- `apps/desktop/src/main/gateway/`：新增 writing-style bridge；`main/index.ts` IPC handler
- `apps/desktop/src/preload/index.ts`：`writingStyle` API 面
- `apps/desktop/src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent.ts`：prompt 新增 `<WRITING_STYLE>` 标签（开关判断）
- `apps/gateway/src/modules/agent/service.ts` + `runtime-factory.ts`：run 上下文附带 style digest + system 段注入
- `apps/gateway/src/modules/context-rooms/room-agent.ts`：dispatchDetached 输入附加
- i18n locale 文件（`memory:` 命名空间，zh-CN / en-US）
