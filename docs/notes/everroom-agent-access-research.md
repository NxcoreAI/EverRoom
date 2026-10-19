# EverRoom 外部 Agent 访问调研：MCP + Skills 方案

> 调研日期：2026-10-16。四路并行调查合成：网关代码现状 / 领域数据模型 / MCP+Skills 官方规范与生态 / 竞品架构。
>
> PRD 目标（1.1）：「在原来的 AI 工具中继续工作，通过 Skills 按需获取 EverRoom 的积累；修正后的新读取校验有效版本，未刷新的副本可见。」
> 发布门槛（10.2）：「搜索能精读原对话和源文件；范围控制有效；主动回写与后台同步无重复。」

## 0. 结论速览

1. **不用从零做。** 网关里已有成型 MCP 基建：`documents/mcp-host.ts`（MCP 服务器 `everroom-context-room`，25 个 `context_room_*` 读写工具）和对外通道 `POST /v1/mcp/everroom/:token`（token 在路径、24h TTL、绑 Room 范围，含 `memory_search / conversation_search / wiki_search / wiki_read / room_context_get`）。它今天只被注入 EverRoom 自己经 ACP 拉起的 CLI；外部 Agent 访问 = 把这套工具面改造成**可对第三方签发、可范围控制、可持久化**的正式端点。
2. **形态：远程 Streamable HTTP MCP 挂在网关上，不做 stdio 代理。** 本地 127.0.0.1 与云端多租户同一形态。用官方 TS SDK v2 的 `createMcpHandler`——一个端点同时兼容 2025 握手时代与 2026-07-28 无状态时代（客户端舰队混编是现实，SDK 自动协商）。
3. **鉴权分两档：** 本地桌面 = 持久化连接 token（连接页签发/暂停/吊销，HTTP header 携带）；云端 SaaS = OAuth 2.1 资源服务器全套（RFC 9728 + DCR/CIMD + PKCE，scopes 映射 Room 与读写能力）。
4. **Skill 是方法层，MCP 是能力层，Plugin 是分发层**（Anthropic 官方三件套提法）。Skill 遵循 agentskills.io 开放标准（六字段 frontmatter），同一份 SKILL.md 在 Claude Code / Cursor / Codex / Gemini CLI / Windsurf / Copilot 等 46 个客户端可用；Claude 生态再用 plugin 把 skill + `.mcp.json` 打包成一次安装。连接页可为各工具**代写配置文件**完成安装。
5. **可领先竞品的长板：** ① 客户端幂等提交（`submission_id`）——Linear/Notion/Slack/GitHub 都没做，PRD 明确要求，且我们已有 `agent_runs.idempotencyKey` 先例；② 读结果统一携带版本/时间戳/内容哈希，让 Agent 识别「未刷新的副本」（Notion 是唯一做得好的，`page_last_edited_at` 模式）。
6. **主要工程缺口：** 网关端口每次启动随机（第三方拿不到稳定地址）、无第三方凭证持久化与吊销、无范围模型、无通用外部提交幂等存储、会话消息无稳定锚点、文档读权限票据不落盘。

---

## 1. PRD 需求拆解（后文逐条映射核对）

| # | PRD 要求 | 类别 |
|---|---|---|
| R1 | Agent 连接页：选目标工具、安装 Skill/适配、选 Room/来源/读取类型/回写位置、自检（搜索/精读/候选回写）、示例查询+出处、暂停/更新/卸载 | 入口 |
| R2 | 五种读取：发现元信息、搜索、精读聊天、读取源文件、获取本次规则 | 读 |
| R3 | 任何搜索命中 → 能走到原会话或源文件 | 读 |
| R4 | 空结果 / 无权限 / 来源丢失 / 解析失败 → 不同状态 | 读 |
| R5 | 回写：会话增量、结果文本、产物文件、来源引用、记忆/Wiki/偏好候选；返回保存状态+对象 ID+可打开位置；重试复用同一提交标识 | 写 |
| R6 | 原会话记录按授权范围收录；长期内容按第 6 章三路处理 | 写 |
| R7 | 本机文件通过可控文件入口登记；远端 Agent 提交附件；校验类型、完整性、来源后提供预览 | 文件 |
| R8 | 修正后的新读取校验有效版本，未刷新的副本可见 | 版本 |
| G1–G3 | 发布门槛：搜索能精读原对话和源文件 / 范围控制有效 / 主动回写与后台同步无重复 | 验收 |

> ✅ **2026-10-16 已拿到总表 PRD（《EverRoom 0.2.0 大版本更新 PRD》），本调研对应其第 7 章「外部 Agent 接入」（L2.5，Skills／MCP）**，L3 单元 L3.5.1–L3.5.5；交付在 M2（各工具取用）+ M5（适配增量/回写），契约依赖 M1（附录 A 公共对象）；发布门槛 = 10.2「Skills」验收包。据此澄清三处此前的不确定：
> - **「三路处理」= 6.3.6 治理分流的「自动完成 / 按启用规则保存 / 生成问题卡」**，不是记忆/Wiki/偏好三个去向（提交载荷仍是 7.4 的记忆/Wiki/偏好候选，处理进治理三路）。
> - **「获取本次规则」= 任务适用的技能、偏好、模板**（6.7 统一库；返回规则版本、作用范围、参考资源、优先级），不是 ingest 策略。
> - 附录 A.3 定死六组能力（发现对象/搜索内容/读取对象与消息范围/读出处与文件/取规则/提交结果与候选）、**聊天搜索必须携带 conversation_id+message_id**、提交键幂等、以及 DeliveryReceipt（A.6）承载外部副本「待刷新/回执」。B.1 基线 E19 与本文 §2 的起点判断一致：「内部记忆/对话检索、源文档与出处、文档 MCP 读取已有；扩展外部统一发现→精读→源文件→回写；补搜索的会话 ID」。

---

## 2. 代码现状

### 2.1 已有资产（外部 Agent 访问可直接踩的）

| 资产 | 位置 | 说明 |
|---|---|---|
| 通道 MCP 端点 | `apps/gateway/src/modules/agent/channel-mcp-routes.ts:19`（`POST /v1/mcp/everroom/:token`）、`channel-mcp-host.ts:154` | JSON-RPC 单次交换；token 每会话签发、24h、Room 范围 `ChannelMcpScope{agentSessionId, roomId}`；**只存内存，重启即失** |
| 文档能力 MCP 服务器 | `modules/documents/mcp-host.ts:348`（`everroom-context-room` v2.0.0）；工具在 `capabilities/{query,create,review,office,comment,task}-plugin.ts` | `context_room_list/create`、`document_list/read`（返回 version+markdown+blocks+readReceipt）、`write_begin/append/commit/abort`、`patch_*`、`task_*` 共 25 个 |
| 检索工具 | `context-rooms/room-agent-tools.ts:35,73,101`、`packages/agent-runtime-pi/src/{memory,knowledge}/tools.ts` | `memory_search`、`conversation_search`、`room_context_get`、`wiki_search`、`wiki_read`——外部工具面的直接蓝本 |
| 全文搜索 | `modules/search/service.ts`（SQLite FTS5 + CJK bigram 分词，type/room/时间过滤），`POST /v1/search` | itemTypes: file/message/room/document/export |
| 会话读取 | `AgentService.getSnapshot`（`modules/agent/service.ts:1027`）、`buildSessionReferenceContext`（:994，32K 预算序列化器）、`GET /v1/agent/sessions/:id/events` | 全量导出需自行分页拼装（缺口⑨） |
| 文档读取 | `GET /v1/documents/:id/markdown|blocks|versions|diff`；`document_blocks` 稳定块锚点；`blockIndexMark`（`everroom://` 徵标往返，`documents/block-index-mark.ts:8`） | 版本链：`documents.version` + `doc_versions` + Yjs 检查点 |
| 文件入口与 CAS | `POST /v1/files`（multipart/base64，扩展名白名单 `files/service.ts:40`）、`POST /v1/file-imports`（sourceKind 含 **agent-generated**，pipelines `{room,wiki,memory}`）、`POST /v1/local-file-references`（登记本机路径不拷字节）、`GET /v1/files/:id/markdown|content`；存储 sha256 CAS（`files/storage.ts:34`） | R7 的「可控文件入口」基本齐：本机登记、远端附件、类型校验都有；完整性校验 = sha256 |
| 规则/技能底料 | `GET /v1/ingest/policies`、`GET /v1/ingest/filter/rules`、`GET /v1/knowledge/rules`、`GET /v1/knowledge/preferences`；写作风格/过滤规则/整理偏好三服务 | ⚠️ PRD 7.2 的「获取本次规则」指 **6.7 统一技能/偏好/模板库**（版本/范围/优先级）——统一库本身是 6.7.1 新增项（现仅三块底料），外部读取依赖它成型，或 P0 先暴露底料 |
| 幂等先例 | `agent_runs.idempotencyKey`（`(sessionId, idempotencyKey)` 唯一，`schema.ts:610`）、`room_merge_operations.idempotencyKey` | 回写幂等的表设计先例 |
| 候选先例 | `document_room_imports.relation=primary/candidate`（`schema.ts:1310`）、`writing_style_insights`（pending/snoozed/confirmed）、room-memory 晋升链 `room-memory:{roomId}:{itemId}`（`context-rooms/service.ts:762`） | 三路候选的状态机雏形 |
| 外部会话表 | `external_agent_threads / external_agent_messages`（`schema.ts:691,719`，contentHash+ordinal） | 「原会话记录按授权范围收录」的天然落点，导入 Codex/Claude/OpenClaw 线程已有先例（`data-migrations/service.ts:283`） |
| 网关发现 | `dataDir/runtime/gateway.json` 清单（pid/baseUrl/token），桌面轮询对接 | 第三方进程理论上也能读，但非设计用途 |
| MCP SDK 依赖 | `@modelcontextprotocol/sdk ^1.30.0` 已在依赖树 | 升级 v2 即可（见 §3.1） |

### 2.2 缺口清单（合并两路代码调查）

1. **无稳定地址**：端口默认 `0`（随机），token 每次启动随机；只有 manifest 文件这一种发现方式。
2. **无第三方凭证体系**：没有面向第三方的 token 签发/持久化/吊销 UI 或接口；channel token 是内存 Map，重启蒸发。
3. **无范围模型**：全局 bearer 一把梭（`server/auth.ts:4`，仅 `/v1/health*`、`/docs`、`/v1/mcp/everroom/` 豁免）；没有按 Room、按读写能力、按回写位置的授权；无按调用方审计。
4. **无通用外部提交幂等存储**：幂等只存在于个别内部实体，没有「客户端提交标识 → 去重 → 返回原结果」的通用 inbox。
5. **会话消息无稳定锚点**：只有 createdAt 排序，引用会话内容没有类似 `document_blocks` 的锚（引用只能「指到会话+时间」）。
6. **文档读权限票据内存态**：readReceipt TTL 10 分钟且不落盘（`capabilities/read-authority.ts:13`），长跑外部 Agent 持票会失效。
7. **Room 范围记忆检索纯词法**：`MemoryService.searchRoomMemories:733` 是 ≤20 行快照上的 AND 子串；混合检索只在 MemoryCore 全局搜索里有。
8. **room_memory_attributions 快照漂移**：内容是写入时快照，MemoryCore 侧编辑后不同步。
9. **无整会话导出端点**：只有 32K 预算的内部序列化器，全保真导出要自己分页 `agent_messages`+`agent_events`。
10. **Wiki 写直连 KS**：无网关侧 journal/provenance（文档有 operation/event 表，Wiki 没有）。
11. **无 CORS**：浏览器工具跨域打不进网关（CLI 无碍）。
12. ~~PRD 第 6 章缺位~~ → **已对齐**：三路处理 = 6.3.6 自动完成/按启用规则/生成问题卡（见 §1）。
13. **审计无调用方维度**：`audit_logs` 表存在但没按 caller 切分。

### 2.3 顺带：未跟踪的 `apps/gateway/src/modules/connector/`

是整仓 vendored 的 **NxcoreAI fork 的 Nango**（`@nangohq/nango` 0.71.4，自带 .git/node_modules），入站连接器方向的调研遗留物，`create-server.ts` 零引用、tsup 不打包，纯属占着工作区。与出站 Agent 访问无关（Nango 的 MCP 内容是「连到别人家 MCP」的 provider 目录，不是服务端框架）。建议移出 `src/modules/`（避免 glob 进构建）或加 ignore；按你的规则我不动它。

---

## 3. 规范与生态现状（2026-10）

### 3.1 MCP：两个协议时代，SDK v2 一次覆盖

- 最新规范 **2026-07-28**（断代重构）：无协议级会话、无 `initialize` 握手（改 `server/discover` + 每请求 `_meta`）、SSE 会被 `subscriptions/listen` 单流取代、elicitation/sampling 改 MRTR（`input_required` 结果+重试）、新增缓存提示与必带 `Mcp-Method/Mcp-Name` 头。**客户端舰队混编**：Claude Code 自 v2.1.274 起默认双运行时按服务器协商；claude.ai 托管端仍在 2025 时代。
- **TypeScript SDK v2**（`@modelcontextprotocol/server` + fastify/express/hono 适配器）的 `createMcpHandler` 默认同时服务两个时代（`legacy: 'stateless'`），每 HTTP 请求跑一次工厂 `{era, authInfo, requestInfo}`——**按连接动态注册工具集**正好是我们 scope 过滤需要的形态。
- 传输：Streamable HTTP 单端点 POST；stdio 仅本地子进程场景；HTTP+SSE 已废弃。
- **OAuth（云端用）**：MCP 服务器 = OAuth 2.1 资源服务器。RFC 9728 受保护资源元数据、RFC 8414 发现、RFC 8707 `resource` 参数、PKCE S256；2026 版将 DCR 换成 CIMD（客户端 ID 即 HTTPS 元数据文档 URL），实践上两者都暴露；`401` 带 `scope`、`403 insufficient_scope` 驱动升权。Claude 系回调要求接受 `https://claude.ai/api/mcp/auth_callback` + 端口无关的 localhost 回调；OAuth 端点 10s 预算。
- **工具标注是硬要求**：Anthropic 连接器评审要求读工具 `title` + `readOnlyHint: true`、写工具 `destructiveHint: true`（驱动 Claude 自动批准策略）；工具名 ≤64 字符；禁止 prompt-injection 式描述。
- **搜索→精读的官方姿势**：工具结果返回 `resource_link`（`everroom://…` 自定义 scheme，URI 指不可直连时用自定义 scheme 而非 https）→ 客户端 `resources/read` 深读；资源模板用 RFC 6570（`everroom://rooms/{roomId}/docs/{docId}`）；`outputSchema`+`structuredContent` 结构化输出；分页 cursor。
- **长任务**：Tasks 扩展（`io.modelcontextprotocol/tasks`）客户端支持尚稀疏，规范推荐先做「句柄 + 轮询工具」模式（创建工具返回 jobId + get_job），全客户端可用。
- MCP Registry 仍是 preview、不做私有服务器发现；云端上市走 claude.ai Connectors 目录。

### 3.2 Skills：已是跨客户端开放标准

- **agentskills.io 标准**：`SKILL.md` + 六个规范字段（`name/description/license/compatibility/metadata/allowed-tools`），渐进披露三级（元数据 ~100 token → 正文 <5K token → 按需文件）。**46 个客户端支持**：Claude 全家、ChatGPT/Codex、Cursor、Copilot、VS Code、Gemini CLI、OpenCode、Windsurf 等。可移植的产品 skill 应只用规范六字段（Claude 私有扩展如 shell 注入在其他端不跑）。
- **Claude 插件可同时打包 skill + MCP 配置**：plugin 根 `.claude-plugin/plugin.json` + `skills/<skill>/SKILL.md` + `.mcp.json`（`{"type":"http","url":…}`，工具名 `mcp__plugin_…`），`/plugin marketplace add` + `/plugin install` 一次装齐。官方定位原话：「连接器 = 触达产品能力；技能 = 教工作流；大多数产品插件两者都带」。
- **Skills-over-MCP 扩展**（`io.modelcontextprotocol/skills`，Final）：MCP 服务器可直接下发 skill（`skills/list/get` + `skill://` URI）——未来可让网关直接serve EverRoom 工作流技能，ChatGPT 已部分支持。
- 分发渠道对照：Claude Code `~/.claude/skills`、`.claude/skills`、plugin；Cursor `.cursor/skills`（兼容读 `.claude/skills`）；Codex `.codex/skills`；Gemini `.gemini/skills`；Windsurf `.windsurf/skills`。

### 3.3 客户端远程 MCP + OAuth 支持矩阵（2026-10）

| 客户端 | 远程 Streamable HTTP + OAuth | Skills |
|---|---|---|
| Claude Code | ✅（`claude mcp add --transport http`、DCR/CIMD、headersHelper、`/mcp auth --scope`） | ✅（含 plugin） |
| claude.ai / Desktop | ✅ Connectors（全量计划开放） | ✅ |
| Cursor | ✅（DCR + 静态 client-id；免费版不能加自定义 MCP） | ✅ |
| Codex CLI / ChatGPT | ✅（`streamable_http`、`auth:"oauth"`、`http_headers_helper`） | ✅ |
| Windsurf | ✅ | ✅ |
| Gemini CLI | ✅（`httpUrl` + DCR、includeTools/excludeTools） | ✅ |

结论：**「远程 HTTP MCP + 一份标准 SKILL.md」即可覆盖全部目标工具**，无需 per-tool 适配器；per-tool 差异只体现在「配置文件写到哪、token 怎么带」（连接页代写解决）。

---

## 4. 竞品架构

| 产品 | 部署 | 鉴权/范围 | 值得抄 |
|---|---|---|---|
| **Linear** | 远程托管 `mcp.linear.app/mcp`，另有独立 `/mcp/readonly` 端点 | OAuth 2.1+DCR；`read` scope 或 readonly 端点双路只读 | ①独立只读端点；②prompt library 按工作流教行为（「先展示再改」「不猜匹配」） |
| **Notion** | 远程托管 `mcp.notion.com/mcp`（自托管版引导弃用） | 用户 OAuth（继承页面权限）+ 管理员 workspace 连接（精确选工具集） | ①`page_last_edited_at`/`verification.state` 版本字段全链路；②`notion://` 稳定内部 URI + 人类 URL 并列；③删除要 `user_confirmed:true`；④`notion-get-tool-access` 自描述工具；⑤`notion://docs/*` 文档资源按需教 Agent |
| **Slack** | 远程托管 `mcp.slack.com/mcp` | **拒绝 DCR**：每个 MCP 连接都挂在注册 App 身份上，企业管理员审批/审计/IP 白名单原样生效；scope 直接映射经典 Web API scope，逐工具对照表 | ①两段式文件上传（拿 URL→传→确认）；②scope=产品既有权限模型而非 MCP 新造 |
| **GitHub** | 双轨：远程托管（GA）+ 本地 Docker/二进制（隔离网） | OAuth 2.1+PKCE；**逐工具 OAuth challenge scope**（调写工具触发增量授权）；org 级工具集开关 | ①动词合并（`issue_read` 带 `method:get|list|add_labels`）；②`--read-only` 全局开关；③`fields` 投影参数缩响应；④`get_rate_limit` 自省 |
| **Obsidian 生态**（最近邻） | 无官方，社区三分（Local REST 桥 / URI 命令 / 裸文件） | 本地 API key | `obsidian://` URI 转换工具（link-back 产品）；教训：本地优先产品要给 **app 级语义搜索**，不能让 Agent 裸 grep |
| **Mem0/OpenMemory**（记忆层最近邻） | 托管 `mcp.mem0.ai`（API key bearer）+ 自托管 OpenMemory（本地 Docker、per-project 命名空间、跨 Agent 共享） | API key | 「本地记忆中枢」形态与 EverRoom 槽位相同；我们的差异点 = 记忆锚在真实 Room/会话/文档上，且可回到原会话 |

**跨竞品结论**：没有一家做客户端幂等提交键（Notion 靠异步任务 id + 分段上传近似达成）；版本字段只有 Notion 认真做。这两点都是 PRD 明确要求 → 直接做成长板。

---

## 5. 方案建议

### 5.1 总体架构

```
外部 Agent（Claude Code / Cursor / Codex / …）
   │  Streamable HTTP, Bearer 连接 token（本地） / OAuth 2.1（云端）
   ▼
网关新端点 POST /v1/mcp/agents            ← TS SDK v2 createMcpHandler，按连接 scope 过滤工具
   ├─ 读工具（五件套）→ 复用现有 service：search / memory / agent / documents / files / knowledge
   ├─ 回写工具 → agent_submissions（幂等 inbox）→ 三路候选（既有 promotion/candidate 机制）
   ├─ 资源 everroom://… → resources/read 深读
   └─ agent_connections（凭证/范围/状态） ← 桌面「Agent 连接页」管理（签发/暂停/更新/卸载）
Skill（agentskills 标准）+ 各工具配置文件 ← 连接页代写；Claude 生态另出 plugin 打包
```

- **本地优先**：桌面网关常驻 + **固定可配端口**（新配置项，默认仍随机的现状保留给不想开的人）；连接 token 持久化落库、可吊销。
- **云端同构**：同一 handler，前面换 OAuth 资源服务器中间件（SDK 自带 `requireBearerAuth` + RFC 9728 元数据路由 + 逐工具 `scopeChallenge` 升权）。TS SDK v2 有 fastify 适配器，可直接挂进现有 Fastify 网关。
- 2026 规范无会话 → 跨调用状态全部显式句柄化（readReceipt/jobId/submissionId），对多租户云端反而更省事。

### 5.2 凭证与范围模型（R1 的核心）

新表 `agent_connections`：

```
id, name, tool(claude-code/cursor/codex/generic), tokenHash,
scopes JSON {
  roomIds: [] | "all",            // 可访问的 Room/来源
  capabilities: [read_metadata, search, read_conversations,
                 read_files, read_rules, write_session,
                 write_candidates, register_files],   // 允许读取的类型+写能力
  writebackRoomId,                // 回写位置（候选/会话增量的归属 Room）
},
status(active/paused/revoked), createdAt, lastSeenAt, exampleQueryAt, revokedAt
```

- 本地 token：随机 32B base64url，仅存 hash；HTTP `Authorization: Bearer`（各客户端 http 型配置均支持 headers；Claude Code 另有 headersHelper、Codex 有 `http_headers_helper` 可动态读 `runtime/gateway.json` 兜底随机端口场景）。
- 云端 scopes 映射 OAuth scope 字符串（`rooms:read rooms:write candidates:write …`），401 challenge 带 scope、403 step-up。
- 每个 MCP 请求过中间件 → 取连接 → 工厂按 `scopes.capabilities` 注册可用工具子集 → 工具内部再按 `roomIds` 过滤数据（双层：工具可见性 + 数据行过滤，R4 的 no_permission 与 G2 都靠这层）。

### 5.3 工具面草案（对外 MCP，前缀 `everroom_`）

| 工具 | 对应 PRD | 形态 | 复用 |
|---|---|---|---|
| `everroom_list_rooms` | R2 发现 | 只读；返回 title/kind/summary/`revision`/updatedAt/deepLink | context-rooms snapshot + rooms 注册表 |
| `everroom_search` | R2 搜索 | 只读；kinds=room/conversation/document/file/memory/wiki，FTS5 + MemoryCore + KS 分发；每命中带 `resource_link`（everroom:// URI）+ snippet + version + updatedAt + **稳定对象 ID（会话命中必须含 conversation_id+message_id，A.3 硬要求）** | search/memory/knowledge service |
| `everroom_fetch` | R2 精读 + R3 + R8 | 只读；按 everroom:// URI 深读；会话分页、文档 markdown/blocks、记忆条目；可选 `basedOnVersion` → 不匹配返回 `stale` + 最新版本号 | AgentService.getSnapshot、documents markdown/blocks |
| `everroom_read_file` | R2 源文件 + R7 预览 | 只读；CAS 内容/markdown + contentHash + 预览 deepLink | files/ingest routes |
| `everroom_get_rules` | R2 规则 | 只读；**任务适用的技能/偏好/模板（6.7 统一库：规则版本、作用范围、参考资源、优先级）** + 本连接授权范围 | 6.7 统一技能服务（新）+ 现有写作风格/过滤/整理偏好底料 |
| `everroom_get_status` | R4 | 只读自描述；启用模块（ASR/memory/wiki）、限流状态、能力可用性（竞品 Notion/GITHUB 同款，防 Agent 瞎重试烧任务——见 ASR 烧死教训） | external-calls/usage |
| `everroom_register_file` | R7 | 写；本机路径登记（local-file-references）或字节提交（files，sha256 完整性+类型白名单） | 已有入口 |
| `everroom_submit` | R5+R6+G3 | 写；**统一提交**：`submission_id`（客户端生成）+ payload[]{session_increment | result_text | artifact_file(ref) | citations | candidate(memory/wiki/preference)}；服务端 `(connectionId, submissionId)` 唯一去重，重复返回原结果；每项返回 status/objectId/deepLink | 新表 agent_submissions + 既有候选/晋升链 + external_agent_threads |
| `everroom_submit_status` | R5 | 只读；按 submission_id 查处理状态（后台三路处理异步化后的轮询句柄） | 同上 |

状态语义（R4，全部进 `structuredContent`，带 `outputSchema`）：`ok` / `empty`（0 命中）/ `no_permission`（连接 scope 不足，附所需 scope）/ `source_lost`（对象已删/不存在，附删除前最后版本）/ `parse_failed`（附原因与建议替代来源）/ `stale`（R8：`basedOnVersion` 过期，附最新 version，旧副本内容仍可带 `superseded:true` 返回——「未刷新的副本可见」）/ `duplicate`（submission 重放，返回原结果）、`pending_refresh`（PRD 7.5 治理结果同步：旧缓存访问时给最新引用或待刷新提示；支持推送的工具记 DeliveryReceipt 回执，离线/文件交接目标显示最后已知版本——A.6 契约）。

版本字段约定（R8）：Room=`room_overviews.revision`；文档=`documents.version`+contentHash；文件=sha256；记忆=updatedAt；全部进读结果，deepLink 用桌面协议打开原对象（R3「走到原会话或源文件」的服务端一半，客户端一半靠 skill 教）。

### 5.4 资源 URI 空间（RFC 6570 模板）

```
everroom://rooms                      everroom://rooms/{roomId}/overview
everroom://conversations/{sessionId}  everroom://conversations/{sessionId}/messages?before=
everroom://documents/{docId}          everroom://documents/{docId}/blocks/{blockId}
everroom://files/{fileId}             everroom://memory/{memoryId}
everroom://wikis/{roomId}/{path}      everroom://rules
```

人类可打开位置 = 桌面 deep link（如 `everroom://open/room/{id}`），搜索命中同时给资源 URI（Agent 用）+ deep link（用户用）——Notion/GitHub 同款双轨。

### 5.5 Skill 与分发

- 一份 `everroom-agent` skill（agentskills 六字段），正文教：何时搜什么类型 → fetch 精读 → 引用规范（带 version）→ 何时提候选（memory vs wiki vs preference 的判据）→ 提交规则（先展示再写、submission_id 复用）。`references/` 放工具清单与 URI 空间说明。
- 连接页按所选工具**代写配置**（解决「装 Skill + 连 MCP」的最后一步）：

| 工具 | MCP 配置 | Skill 位置 |
|---|---|---|
| Claude Code | `~/.claude.json`（user scope）或项目 `.mcp.json`，headers 带 token | `~/.claude/skills/everroom-agent/`（或 plugin） |
| Cursor | `~/.cursor/mcp.json`（headers） | `~/.cursor/skills/` |
| Codex | `~/.codex/config.toml` `[mcp_servers.everroom]` + `http_headers` | `~/.codex/skills/` |
| Gemini CLI | `settings.json` `httpUrl` | `.gemini/skills/` |
| Cherry Studio | 设置 → MCP 服务器（按目标版本验证，7.3 适配矩阵） | —（宿主无统一 skill 机制，靠工具描述教工作流） |
| OpenClaw / Hermes | 按已验证版本的技能/工具/CLI 通道（7.3） | 各自技能目录，待适配验证 |
| 通用 | 打印 URL+token 让用户手配 | — |

PRD 7.3 的验收目标工具为 **Cherry Studio / Codex / OpenClaw / Hermes 四家 + Claude Code（既有）**；Cursor/Gemini/Windsurf 不在验收清单，但走开放协议天然兼容、零额外成本。

- Claude 生态可选再出 plugin（`.mcp.json` + skills 打包，`/plugin install everroom@<marketplace>` 一次装齐）——P1。
- 云端上市再走 claude.ai Connectors 目录 + MCP Registry（均 P2，非必需）。

### 5.6 连接页功能（对 R1 逐条）

1. 选择目标工具 → 2. 勾选 Room/来源 + 读取类型 + 回写位置 → 3. 签发连接（落 `agent_connections`，代写配置+skill）→ 4. **自检**：三项 smoke test（一次搜索、一次精读、一次候选回写提交后撤销）实跑 MCP 端点 → 5. **示例查询展示**：跑一条真实查询，展示命中+出处+deepLink（即 PRD「展示一次示例查询及出处」；参考 Linear 的 in-browser playground）→ 6. 管理：暂停（token 拒绝但保留）/更新（改 scope，token 可选轮换）/卸载（吊销 + 删代写文件 + 归档连接记录）。
7. **调试页**（7.5）：最近调用、状态、数据量、已返回来源和回写结果；敏感凭据独立管理（token 不进调试日志）。连接状态按 7.3 分项展示：历史导入 / 持续同步 / 按需读取 / 成果回写 / 导出交接。

### 5.7 发布门槛验收设计（G1–G3）

- **G1 搜索能精读原对话和源文件**：端到端用例——`everroom_search` 命中会话 → `everroom_fetch` 拿到全量转录分页；命中文件 → `everroom_read_file` 拿到 markdown/内容，contentHash 对得上 CAS。
- **G2 范围控制有效**：双连接用例——连接 A 只授权 Room1，搜索/精读/回写对 Room2 全部返回 `no_permission`；`writebackRoomId` 之外的候选提交被拒；工具列表本身不含未授权能力。
- **G3 主动回写与后台同步无重复**：同一 `submission_id` 重放 N 次落 1 条（返回 `duplicate`+原 objectId）；Agent 提交的产物文件经 CAS contentHash 与后台 ingest 的同内容文件天然合一（CAS 已按内容寻址）；候选三路各有去重键（contentHash / 快照内容）。PRD 7.3/9.3 进一步要求**两条回写链共用来源身份**：同步服务按完成轮次/空闲窗口收录原会话增量（如 Codex sessions 解析），Skill 调用提交结构化产物/决定/候选，两链按「平台+原会话/消息/文件 ID+版本」合并到同一对象。
- PRD 7.5 验收链（G1–G3 用例骨架）：外部搜索 → 原对话前后文 → 记忆源文件 → 生成结果 → 候选回写 → 下一次读取。

### 5.8 需要新建/改造的 schema 与模块

- 新表：`agent_connections`、`agent_submissions`（幂等 inbox，含三路候选分发状态）。
- 改造：网关固定端口选项；MCP 端点中间件（连接解析+scope 过滤工厂）；readReceipt 落盘或对外通道豁免（外部 Agent 长跑场景）；`external_agent_threads` 增加 submission 来源关联。
- 升级 `@modelcontextprotocol/sdk` 1.x → 2.x（网关内既有 host 一并评估迁移，channel-mcp 保持不动风险可控）。
- 会话锚点（缺口⑤）P0 可先用「会话+序号」引用，P1 再上 message anchor 表。

---

## 6. 风险与开放问题

1. ~~PRD 第 6 章不在仓库~~ → 已对齐：三路处理 = 6.3.6 自动完成/按启用规则/生成问题卡；`agent_submissions` 分发语义按此锁（候选进治理管线分流，不直接落库）。
2. **固定端口 vs 动态发现**：固定端口有占用冲突与本地攻击面问题（token 在 header，仍建议默认仅 127.0.0.1 + 可选关闭）；兜底方案是 helper 脚本读 `runtime/gateway.json` 动态注入 URL/header。需要拍板。
3. **readReceipt 内存态**与外部长跑 Agent 冲突，需落盘或对外通道改签发逻辑。
4. **SDK 1.x→2.x 迁移**牵动既有三个内部 MCP host（documents/notifications/channel），需回归。
5. **会话消息锚点**：A.3 要求搜索命中带 message_id——内部 `agent_messages.id` 可直接暴露，导入线程用 `external_agent_messages.ordinal`；块级锚（对标 document_blocks）P1 再上。
6. Room 范围记忆检索纯词法（缺口⑦）：外部 Agent 高频搜索 Room 记忆时体验一般，P1 接 MemoryCore 混合检索的 room 过滤。
7. 云端 OAuth 全家桶（CIMD/DCR 双暴露、回调白名单、10s 预算）工作量不小，且 claude.ai Desktop OAuth 曾有社区报告的回归——本地 token 优先、云端 P1 再上有道理。
8. 工作区的 vendored Nango 目录建议移出 `src/modules/`（见 §2.3），避免构建误扫。

---

## 7. 分阶段落地建议

**P0（对齐发布门槛 10.2；对应 PRD M1 契约 + M2 各工具取用）**——M1 需先落 A.1/A.3 公共对象：SourceRef/EvidenceRef、ExecutionRecord/ResultEnvelope（attempt/幂等键）、Skill/Preference/Template、DeliveryReceipt
1. `agent_connections` + `agent_submissions` 表 + 连接页（签发/scope/自检/示例查询/暂停/卸载）。
2. 网关固定端口选项 + `POST /v1/mcp/agents` 端点（SDK v2，Bearer 连接 token，按 scope 工厂注册工具）。
3. 五件套读工具 + `everroom_get_status` + 状态语义（empty/no_permission/source_lost/parse_failed/stale）+ 版本字段。
4. `everroom_register_file` + `everroom_submit`/`submit_status`（幂等、三路候选、deepLink 返回）。
5. `everroom-agent` skill（标准六字段）+ 各工具配置代写。
6. G1–G3 验收用例。

**P1**
- 云端 OAuth 2.1 资源服务器 + claude.ai Connectors；Claude plugin 打包分发；独立 `/mcp/readonly` 端点；message anchor 表；Room 记忆混合检索；readReceipt 落盘；审计按调用方维度。
- 四家适配增量与回写收尾（PRD M5）；**开放交付件**：Skill/连接协议说明、适配样例、安装说明（10.3 开放交付要求，发布清单项）。

**P2**
- `subscriptions/listen` 变更通知；Tasks 扩展长任务；Skills-over-MCP（网关直接下发 skill）；MCP Registry / 目录上市。

---

## 8. 主要参考

- MCP 规范 2026-07-28（transports/authorization/tools/resources/pagination/elicitation）: modelcontextprotocol.io/specification/2026-07-28
- TS SDK v2（packages/serving-http/authorization/legacy-clients）: ts.sdk.modelcontextprotocol.io/v2
- Anthropic 连接器构建与评审标准: claude.com/docs/connectors/building（review-criteria：读写分离+annotations 硬要求）
- Agent Skills 开放标准与客户端矩阵: agentskills.io（specification / clients）
- Claude Code MCP / Skills / Plugins: code.claude.com/docs/en/{mcp,skills,plugins}
- Skills-over-MCP / Tasks 扩展: modelcontextprotocol.io/extensions
- 竞品：linear.app/docs/mcp；developers.notion.com/guides/mcp；docs.slack.dev/ai/slack-mcp-server；github.com/github/github-mcp-server；mem0.ai/openmemory
