# 外部 Agent 访问（MCP + Skills）设计与影响评估

- 对应 PRD：《EverRoom 0.2.0 大版本更新 PRD》第 7 章（L2.5 外部 Agent 接入）+ 附录 A.3 外部读取与回写协议 + 10.2「Skills」发布门槛。
- 前置调研：`docs/notes/everroom-agent-access-research.md`（2026-10-16，四路调查合成）。
- 状态：**阶段 1（网关后端核心）与阶段 2（桌面端固定端口 + Agent 连接页 + 安装落盘）均已实施并通过测试**（2026-10-17）。阶段 1：3 张表 + 迁移 0081、agent-access 模块（连接/提交/事件服务、9 工具面、MCP host、连接页 REST、安装代写生成）、`/v1/mcp/agents` 端点与 auth 豁免；`tests/agent-access.test.ts` 7 用例全绿。阶段 2：`GatewaySupervisor.portProvider` 固定端口（`dataDir/agent-access-settings.json`）、`AgentAccessGatewayBridge` + IPC 通道组 + preload `agentAccess` API + shared DTO、AgentConnectionsPage（列表/新建含 Room 多选与能力勾选/暂停恢复/换 token/自检/示例查询/安装/调试面板/固定端口设置卡）、`AgentAccessInstaller` 落盘（Claude Code/Cursor 自动合并配置、Codex 手动片段、先备份、损坏不写）；desktop typecheck + electron-vite build + 11 项相关测试通过。剩余：真机端到端验证（见 §8）。
- 本文档是大任务门禁（开发规范 §6）的影响评估 + 接口设计，开工已获用户确认（2026-10-17「开工」）。

## 1. 目标与非目标

**目标（阶段 1，本轮）**：网关侧 P0——连接凭证 + 范围模型 + 对外 MCP 端点 + 五种读取能力 + 幂等回写提交 + 连接页所需 REST（含自检/示例查询/安装代写内容生成）+ 测试。

**非目标（后续阶段）**：
- 桌面「Agent 连接页」UI 与配置文件代写落盘（阶段 2；REST 已就绪）。
- 网关固定端口 / 桌面 supervisor 改造（阶段 2；当前 URL 取 listen 后实际绑定地址，重启端口变化需重装配置，见 §7 风险）。
- 云端 OAuth 2.1 资源服务器（P1）。
- 候选回写接入第 6 章三路治理管线（记忆团队交付问题卡/治理引擎后的集成点，见 §5.4）。
- 会话增量并入 external_agent_threads 同步链（两链合并，阶段 2；当前先落幂等提交存储，见 §5.4）。
- `resources/read`、resource_link 块、MCP Tasks 扩展、Skills-over-MCP（P1+）。

## 2. 架构红线自查（开发规范 §9）

- 本次新增端点：`/v1/mcp/agents`（对外 MCP，连接 token 鉴权，`server/auth.ts` 豁免全局 bearer——与既有 `/v1/mcp/everroom/` 同款豁免模式）+ `/v1/agent-access/*`（REST，走既有全局 bearer，仅桌面调用）。**不新增监听端口、不新增进程**；挂在现有 Fastify 网关上。
- 存储：复用现有 SQLite（gateway.sqlite）+ drizzle，新增 3 张表（§4）。不引入新依赖（MCP SDK 复用仓库既有 `@modelcontextprotocol/sdk ^1.30`，传输复用 channel-mcp-host 的 `ExchangeTransport`，仅将其导出共享——不复制代码）。
- 结论：对照红线无违规；无破坏性变更（全部为增量端点/增量表）。

## 3. 涉及模块清单

| 文件 | 变更 |
|---|---|
| `apps/gateway/src/infrastructure/database/schema.ts` | 新增 agent_connections / agent_submissions / agent_access_events 三表 |
| `apps/gateway/drizzle/0081_agent_access.sql` | drizzle-kit 生成迁移 |
| `apps/gateway/src/modules/agent-access/`（新模块） | types.ts / service.ts / tools.ts / install.ts / mcp-host.ts / routes.ts / mcp-routes.ts |
| `apps/gateway/src/server/auth.ts` | `/v1/mcp/agents` 豁免全局 bearer（连接 token 自鉴权） |
| `apps/gateway/src/modules/agent/channel-mcp-host.ts` | `ExchangeTransport` 加 export（复用不复制） |
| `apps/gateway/src/server/create-server.ts` | 组装 + 注册（channelMcpRoutes 注册点之后） |
| `apps/gateway/tests/agent-access.test.ts` | 新增测试 |
| `docs/notes/everroom-agent-access-research.md` | 调研报告从仓库根迁入（规范 §4） |

回滚：纯增量，revert 工作区文件即可；迁移为 CREATE TABLE 幂等 additive（client.ts 的 runAdditiveMigrationIdempotently 语义）。

## 4. 数据模型（新表）

```
agent_connections
  id, name, tool(claude-code|cursor|codex|cherry-studio|openclaw|hermes|generic),
  tokenHash(sha256, unique), tokenPrefix(展示用前 8 位),
  scopes JSON { roomIds: string[]|"all",
                capabilities: AgentAccessCapability[],
                writebackRoomId: string|null },
  status(active|paused|revoked), lastSeenAt, createdAt/updatedAt, revokedAt

agent_submissions
  id(uuid), connectionId(FK cascade), clientSubmissionId(客户端提交键),
  items JSON(原始载荷), status(received|completed|partial_failed|rejected),
  results JSON(逐项结果), duplicateCount,
  UNIQUE(connectionId, clientSubmissionId)   ← 幂等键（PRD A.3「提交键」）

agent_access_events（7.5 调试页数据源；每连接保留最近 200 条，插入时裁剪）
  id, connectionId(FK cascade), kind(call|connect|submit), tool, status,
  durationMs, detail JSON, createdAt
```

能力集 `AgentAccessCapability`（PRD 7.1「允许读取的类型和回写位置」）：
`read_metadata / search / read_documents / read_conversations / read_files / read_rules / write_session / write_candidates / register_files`。

token 形态：`evr_` + 32B base64url；**仅创建/轮换时返回一次**，库存 sha256。

## 5. 对外接口

### 5.1 MCP 端点 `POST /v1/mcp/agents`

- 传输：与 `/v1/mcp/everroom/:token` 同款单请求 JSON-RPC 交换（SDK `Server` + 共享 `ExchangeTransport`），兼容现役 Claude Code / Codex 客户端（channel MCP 已实证）。
- 鉴权：`Authorization: Bearer <连接token>`；无效/暂停/吊销 → 404 + JSON-RPC `-32001`（与渠道 MCP 同错误形状）。
- 会话自愈：网关重启后首个非 initialize 请求自动重建会话（渠道版会报错；连接是持久的，这里必须自愈）。
- `tools/list` 按连接 capabilities 过滤；每个工具带 `title` + `readOnlyHint/destructiveHint/idempotentHint`（Anthropic 评审硬要求）。

### 5.2 工具面（A.3 六组能力 → 9 个工具）

| 工具 | 能力 | 说明 |
|---|---|---|
| `everroom_list_rooms` | read_metadata | Room 元信息 + revision + deepLink |
| `everroom_search` | search | FTS5（room/conversation/document/file/export）+ MemoryCore 原子记忆；每命中带稳定对象 ID、版本、`everroom://` URI、会话命中带 conversationId+messageId（A.3 硬要求） |
| `everroom_fetch` | 按目标分（read_conversations/read_documents/read_files/read_metadata/search） | 按 `everroom://` URI 精读；支持 `basedOnVersion` → `stale` 状态（R8：未刷新副本可见，内容照给 + 标记过期） |
| `everroom_read_file` | read_files | 源文件正文/markdown + sha256 |
| `everroom_get_rules` | read_rules | P0 返回写作风格/整理偏好底料；6.7 统一技能库上线后换全量（PRD 7.2 语义） |
| `everroom_get_status` | 常驻 | 连接信息 + 各服务可用性（自描述降级，防 Agent 盲重试） |
| `everroom_register_file` | register_files | 字节提交（类型白名单 + sha256 完整性）；本机路径登记待阶段 2 可控入口 |
| `everroom_submit` | write_session / write_candidates | 统一提交，`submissionId` 客户端生成，服务端 `(connectionId, submissionId)` 幂等；逐项返回 status/objectId/deepLink |
| `everroom_submit_status` | 常驻 | 按 submissionId 查处理结果 |

状态语义（`structuredContent.status`）：`ok / empty / no_permission / source_lost / parse_failed / stale / duplicate / pending_review / invalid_input`（PRD R4 + R8；`pending_refresh` 待 DeliveryReceipt 集成）。

URI 空间：`everroom://rooms/{id}(/overview)`、`everroom://conversations/{sessionId}`、`everroom://documents/{id}`、`everroom://files/{id}`、`everroom://memory/{id}`；人类可打开位置 `everroom://open/{kind}/{id}`（桌面协议注册随阶段 2 连接页落地）。

### 5.3 提交项类型（PRD 7.4 五类）

| kind | 阶段 1 处理 | 返回 |
|---|---|---|
| session_increment | 幂等落 `agent_submissions`（含 平台+线程+消息 ID+内容 去重键）；并入 external_agent_threads 同步链是阶段 2 集成点（两链合并） | recorded |
| result_text | 经 files 管线存为 markdown 产物（sourceKind=agent-generated，CAS sha256 去重）→ writebackRoomId | saved + fileId |
| artifact_file | 类型白名单校验 + files 管线入库 | saved / rejected(unsupported_file_type) |
| citation | 记录于提交存储（引用链证据） | recorded |
| candidate(memory/wiki/preference) | `pending_review`；三路治理（6.3.6 自动完成/按规则/问题卡）接入前的暂存态 | pending_review |

### 5.4 与两链合并（PRD 7.3/9.3）的衔接

外部回写链（Skill 调用 → `everroom_submit`）与后台同步链（Codex sessions 解析等 data-migrations）必须按「平台+原会话/消息 ID+版本」合并到同一对象。阶段 1 的提交存储已带全部合并键；阶段 2 在同步链读取侧做合并（external_agent_threads 需要 dataMigrationSources + memorySessionId 语义，属导入管线领地，不在本阶段擅写）。

### 5.5 连接页 REST（全局 bearer，桌面专用）

```
POST   /v1/agent-access/connections            创建（返回 token 一次）
GET    /v1/agent-access/connections            列表（脱敏）
PATCH  /v1/agent-access/connections/:id        改名/改范围/暂停/恢复
DELETE /v1/agent-access/connections/:id        吊销
POST   /v1/agent-access/connections/:id/token  轮换 token
GET    /v1/agent-access/connections/:id/submissions   提交记录（调试页）
GET    /v1/agent-access/connections/:id/events        最近调用（调试页）
POST   /v1/agent-access/connections/:id/selftest      搜索/精读/回写三项自检（PRD 7.1.3）
POST   /v1/agent-access/connections/:id/example-query 示例查询+出处（PRD 7.1.4）
GET    /v1/agent-access/connections/:id/install/:target  安装代写内容（mcp 配置片段 + skill 文件内容；target=claude-code|cursor|codex|cherry-studio|generic）
```

Skill 遵循 agentskills.io 六字段规范（name=everroom-agent），由网关生成内容、桌面阶段 2 负责写入各工具目录（`.claude/skills`、`.cursor/skills`、`.codex/skills` 等）与配置文件。

## 6. 测试计划

- `tests/agent-access.test.ts`：连接生命周期（签发/暂停/恢复/轮换/吊销/脱敏）、范围过滤（list_rooms/search/fetch 的 no_permission）、MCP 交换（initialize/list 按能力过滤/结构化状态/无效 token/重启自愈）、提交幂等（重放返回 duplicate、逐项状态）。
- 只跑本模块测试 + typecheck（开发规范 §5 相关性质则）。
- 已知预存失败不触碰（gateway 基线见记忆：bundled-agent 等）。

## 7. 风险与待拍板

1. **端口随机**（阶段 2 解决前）：安装片段写 listen 后实际地址；网关重启端口变化 → 外部工具配置失效需重装。阶段 2 方案：桌面持久化固定端口设置并以 `--port` 传入。
2. **候选治理**：三路治理引擎（6.3.6）交付前，候选停留在 pending_review，不自动写记忆——宁可保守不可重复污染（PRD G3）。
3. **SDK 1.x**：沿用仓库既有 `@modelcontextprotocol/sdk ^1.30`（channel MCP 已实证兼容现役 CLI），v2 双时代升级独立成项再做，不在本阶段混入（开发规范 §8 功能/重构分离）。
4. **无 CORS**：CLI 场景无碍；浏览器宿主（Cherry Studio 桌面版为 Electron 非浏览器）待验证。

## 8. 真机端到端验证清单（待做）

1. 桌面启动 → Agent 连接页 → 设置固定端口（如 8790）→ 重启网关 → 端口生效。
2. 新建 claude-code 连接（全部 Room + 读能力 + 回写）→ 复制 token → 安装 → 检查 `~/.claude/skills/everroom-agent/` 与 `~/.claude.json` 的 `mcpServers.everroom`。
3. 终端起 Claude Code（项目目录）→ `/mcp` 查看 everroom 服务器 → 让它 `everroom_search` 一次 → 命中带 URI/版本 → `everroom_fetch` 精读 → `everroom_submit` 提交一条候选 → 连接页调试面板看到提交（pending_review）。
4. 重启 EverRoom（网关随固定端口重生）→ Claude Code 直接再调一次工具（连接持久 + 会话自愈验证）。
5. PRD 10.2 门槛用例：G1 搜索→精读原会话与源文件；G2 双连接范围隔离；G3 同 submissionId 重放 duplicate。
