# Pi Agent 集成计划

状态：Phase 0 已完成，Phase 1 进行中
目标项目：NxCore CE / Everroom 桌面端
首选运行时：`@earendil-works/pi-coding-agent`
架构原则：Pi 是可替换的 Agent 执行引擎，不是产品后端。

## 1. 项目目标

在桌面端右侧工作区接入一个可实际使用的本地 Agent。Agent 需要具备以下能力：

- 以流式方式展示回答和推理过程。
- 只能使用本次运行明确授权的 Room、来源、证据和文档。
- 所有工具调用都经过 NxCore Gateway，并在需要时暂停等待用户审批。
- 支持停止、继续，以及 UI 重连或 Agent Host 重启后的恢复。
- 通过可审计的文档变更事务修改内容，不能直接写入产品数据。
- 在不开放任意宿主机权限的前提下，加载经过筛选的 Pi Skill 和 Extension。

第一个端到端切片的完成标准：用户可以要求 Nex 总结当前 Room，查看流式回答和工具活动，审批一项文档变更，并且刷新或重连后不会丢失对话记录。

## 2. 已确定的架构决策

### 2.1 模块所有权

| 关注点 | 所有者 |
| --- | --- |
| Room、来源、证据、记忆和文档数据 | NxCore Gateway |
| 面向用户的会话、消息、运行、审批和审计 | NxCore Gateway |
| 上下文选择和 Context Lease 强制校验 | NxCore Gateway |
| 模型循环、模型消息、上下文压缩和运行时续接 | Pi Runtime |
| Agent 进程生命周期 | Agent Host，由 Gateway 监督 |
| 桌面端展示与交互 | NxCore Agent UI |
| 文件、Shell、剪贴板和操作系统能力 | NxCore Capability Provider |

Pi 的 Session 文件只作为运行时检查点使用。它不是面向用户的数据权威来源，Renderer 不能直接读取。

### 2.2 进程边界

```text
Electron Renderer
  -> NxCore Gateway（HTTP + WebSocket）
      -> Agent 领域服务（会话、运行、事件、审批、Context Lease）
      -> Agent Host 子进程（内部 RPC）
          -> agent-runtime-pi
              -> Pi SDK
              -> 仅使用 NxCore 代理工具
```

Agent Host 使用独立 Node.js 进程。Pi 升级、Extension 故障、内存泄漏或模型循环崩溃，都不能导致 Gateway 或桌面应用退出。

### 2.3 默认安全策略

- 不启用 Pi 默认的 `read`、`write`、`edit` 和 `bash` 工具。
- 不扫描 `~/.pi/agent/extensions`、`.pi/extensions` 或项目中的 Pi Package。
- 产品 UI 不提供任意 `pi install` 能力。
- 只加载 NxCore 白名单内且锁定版本的 Extension 和 Skill。
- 所有产品数据和宿主机高权限操作都通过 Gateway 代理工具执行。
- Pi 的审批 Hook 只能作为补充，Gateway 是最终策略裁决者。
- 模型供应商凭据不能进入 Renderer，并且必须从日志和事件中脱敏。

## 3. 目标目录结构

```text
apps/
  desktop/
  gateway/
  agent-host/

packages/
  agent-contract/
  agent-runtime/
  agent-runtime-pi/
  gateway-client/
  context-policy/
```

各模块职责：

- `agent-contract`：稳定的数据协议，包括会话、运行、消息、事件、工具、审批、错误和运行时能力。
- `agent-runtime`：与具体运行时无关的接口和一致性测试。
- `agent-runtime-pi`：Pi SDK 适配器，以及 Pi 事件到 NxCore 事件的转换。任何 Pi 类型都不能越过该包边界。
- `gateway-client`：桌面 Renderer 使用的已认证 HTTP/WebSocket 客户端。
- `context-policy`：Context Lease 解析、工具策略和审批风险分类。
- `apps/agent-host`：运行时注册、内部 RPC、健康状态、取消和恢复。

未来 DSH 或其他 Agent Runtime 可以实现同一套 `agent-runtime` 接口，无需修改 Gateway API 和 Agent UI。

## 4. 核心协议

### 4.1 Runtime 接口

```ts
export interface AgentRuntime {
  readonly id: string
  getCapabilities(): Promise<RuntimeCapabilities>
  start(input: StartRunInput): Promise<RuntimeRun>
  resume(input: ResumeRunInput): Promise<RuntimeRun>
  sendInput(input: SendRuntimeInput): Promise<void>
  cancel(runId: string): Promise<void>
  dispose(): Promise<void>
}

export interface RuntimeRun {
  runId: string
  runtimeSessionRef: string
  events: AsyncIterable<RuntimeEvent>
}
```

Pi 的消息、Session Entry、Extension 和 SDK 对象全部保留在 `agent-runtime-pi` 内部。

### 4.2 稳定的 Agent 事件信封

```ts
export interface AgentEvent<T = unknown> {
  id: string
  sessionId: string
  runId: string
  seq: number
  type: AgentEventType
  occurredAt: string
  payload: T
}
```

第一版事件类型：

```text
session.created
run.accepted
run.started
message.started
message.delta
reasoning.delta
message.completed
tool.requested
tool.started
tool.updated
tool.completed
tool.failed
approval.requested
approval.resolved
context.updated
run.interrupted
run.failed
run.cancelled
run.completed
```

`seq` 在单个 Run 内单调递增。WebSocket 事件只是实时投影；发生重连后，以 SQLite 记录和 History API 返回的数据为准。

### 4.3 Context Lease

每次 Run 都获取一份不可变的上下文授权快照：

```ts
export interface ContextLease {
  id: string
  roomId: string
  sourceIds: string[]
  evidenceIds: string[]
  documentIds: string[]
  permissions: Array<"read" | "propose_write" | "execute">
  issuedAt: string
  expiresAt: string | null
  revision: number
}
```

每个工具都必须在真正执行时再次校验 Lease。Prompt 中出现某个资源名称，不代表 Agent 自动获得该资源权限。

### 4.4 工具代理

第一批工具保持产品化和最小化：

```text
context.describe
evidence.search
evidence.read
document.read
document.propose_patch
document.apply_patch
memory.search
ask_user
```

`document.propose_patch` 只生成一项可审阅的变更事务。`document.apply_patch` 必须满足以下条件：

- Proposal 有效且尚未应用。
- 文档基础版本仍然匹配。
- Context Lease 允许该操作。
- 风险策略要求审批时，用户已经批准。

Pi 不能直接写文档数据库。

## 5. 持久化模型

Gateway 增加以下数据表或等价 Repository。

### 5.1 `agent_sessions`

- `id`
- `room_id`
- `runtime_id`
- `runtime_session_ref`
- `title`
- `status`
- `created_at`
- `updated_at`

### 5.2 `agent_runs`

- `id`
- `session_id`
- `context_lease_id`
- `status`
- `last_event_seq`
- `interruption_reason`
- `started_at`
- `completed_at`

### 5.3 `agent_messages`

- `id`
- `session_id`
- `run_id`
- `role`
- `content`
- `reasoning_summary`
- `runtime_message_ref`
- `created_at`

### 5.4 `agent_events`

- `id`
- `session_id`
- `run_id`
- `seq`
- `type`
- `payload`
- `created_at`

为 `(run_id, seq)` 建立唯一约束。

### 5.5 `agent_approvals`

- `id`
- `session_id`
- `run_id`
- `tool_call_id`
- `risk`
- `request`
- `canonical_execution_plan`
- `status`
- `resolved_by`
- `resolved_at`
- `expires_at`

现有 `jobs` 表可以继续承载后台任务，但不能把 Agent Run 的核心状态塞进通用 Job Payload。现有 `audit_logs` 应记录：

- 工具调用和结果。
- 审批请求和审批结果。
- 文档变更事务。
- Runtime 崩溃和恢复。
- 策略拒绝。

## 6. Gateway API

第一版 HTTP 接口：

```text
POST   /v1/agent/sessions
GET    /v1/agent/sessions/:sessionId
GET    /v1/agent/sessions/:sessionId/messages
POST   /v1/agent/sessions/:sessionId/runs
POST   /v1/agent/runs/:runId/input
POST   /v1/agent/runs/:runId/cancel
GET    /v1/agent/runs/:runId
GET    /v1/agent/approvals
POST   /v1/agent/approvals/:approvalId/resolve
```

WebSocket 负责：

- 建立订阅前完成认证。
- 按 Session 订阅，也可以进一步限定到当前 Run。
- 推送统一的 `AgentEvent` 信封。
- 向客户端返回当前已知的最新序号。
- 出现序号缺口时，要求客户端重新加载 History 和当前 Run 状态。
- 每次重连后，通过 HTTP 补拉尚未处理的 Approval。

所有会产生副作用的 HTTP 请求都必须携带幂等键。

## 7. Agent Host 与 Pi 适配器

### 7.1 Agent Host 生命周期

Gateway 负责 Agent Host 的启动和停止：

1. 使用内部随机 Token 和 NxCore 数据目录启动子进程。
2. 等待 Ready 握手，其中包含协议版本和 Runtime 版本。
3. 协议版本不兼容时拒绝启动。
4. 采集结构化日志，普通日志不能混入完整模型内容。
5. Agent Host 异常退出时，将正在运行的 Run 标记为 `interrupted`。
6. 使用有上限的指数退避重启。
7. Agent Host 恢复 Ready 后，对中断的 Run 进行协调和恢复。

内部通信可以使用 Loopback 或标准输入输出上的分帧协议。Pi 对外提供的 RPC 数据结构不能直接成为 NxCore 的内部协议。

### 7.2 Pi SDK 配置

适配器直接使用 Pi SDK，不解析 TUI 或 CLI 文本：

```ts
const { session } = await createAgentSession({
  cwd: managedWorkspace,
  tools: [],
  customTools: nxcoreProxyTools,
  resourceLoader: nxcoreResourceLoader,
  sessionManager: nxcorePiSessionManager,
})
```

Pi 事件转换规则：

| Pi 事件 | NxCore 事件 |
| --- | --- |
| `agent_start` | `run.started` |
| `message_update/text_delta` | `message.delta` |
| `message_update/thinking_delta` | `reasoning.delta` |
| `tool_execution_start` | `tool.started` |
| `tool_execution_update` | `tool.updated` |
| `tool_execution_end` | `tool.completed` 或 `tool.failed` |
| `queue_update` | `context.updated`，后续可增加独立 Queue 事件 |
| `agent_settled` | `run.completed` |

适配器必须明确处理：

- 用户取消。
- 模型供应商错误。
- 自动重试。
- 上下文压缩。
- 非法工具参数。
- Agent Host 进程终止。

### 7.3 Pi 资源白名单

第一版只加载 NxCore 自己维护的资源：

- Room 总结 Skill。
- 基于证据的写作 Skill。
- 文档修订 Skill。
- Ask User 工具。
- UI 确实需要时再加入 Todo 状态。

每个第三方 Pi Package 都必须单独评审，检查项包括：

- 源码审核结果。
- 固定版本和完整性信息。
- License 记录。
- 网络访问行为。
- 文件系统访问行为。
- Runtime 一致性测试。

仅适用于 TUI 的 Extension 不加载到产品 Runtime。

## 8. 桌面端 Agent 工作区

逐步将当前静态 `AgentPanel` 替换为以下完整状态：

- 空会话。
- 正在加载历史消息。
- 可输入状态。
- 正在流式回答。
- 推理过程展开和收起。
- 工具调用树，包括等待、运行、成功和失败状态。
- Approval 请求临时接管输入区。
- 等待发送的 Steering 和 Follow-up 消息。
- Run 活跃时显示停止操作。
- 正在重连以及恢复成功。
- Run 中断或失败，并提供重试操作。
- Context Lease 查看器。

UI 只能依赖 `agent-contract` 和 `gateway-client`，不能导入任何 Pi Package，也不能直接渲染 Pi Extension 的 UI 组件。

## 9. 交付阶段

### Phase 0：协议验证

交付内容：

- 创建各 Package 的基础结构。
- 定义 Runtime 和 Gateway 协议。
- 实现一个行为确定的 Fake Runtime。
- 使用 Fake Runtime 验证事件流、取消、重连和 Approval 补拉。

退出条件：

- Renderer 可以通过 Gateway 完成一次 Fake 流式 Run。
- Run 进行过程中刷新页面，可以恢复 Transcript 和活跃状态。
- 协议测试可以正确拒绝乱序事件，并忽略重复事件。

### Phase 1：接入 Pi 文本循环

交付内容：

- 新增 `apps/agent-host`。
- 使用 Pi SDK 新增 `agent-runtime-pi`。
- 支持模型配置、Prompt、流式文本、推理、停止、重试和 Runtime Session 映射。
- 在 Gateway 持久化 Session、Message、Run 和标准化 Event。

退出条件：

- AgentPanel 可以完成真实的 Pi 对话。
- 模型看不到 Pi 默认的文件系统和 Shell 工具。
- Agent Host 重启不会导致 Gateway 或 Electron 崩溃。

### Phase 2：上下文和只读工具

交付内容：

- 实现 Context Lease 创建与校验。
- 将 Source/Evidence 的读取能力迁移或暴露到 Gateway 边界内。
- 增加 `context.describe`、`evidence.search`、`evidence.read` 和 `document.read` 代理工具。
- 增加工具活动 UI 和审计记录。

退出条件：

- 模型只能引用 Lease 中授权的证据。
- 越权访问默认拒绝，并写入审计日志。

### Phase 3：审批和文档事务

交付内容：

- 增加 Approval Policy 和审批 UI。
- 增加带版本校验的文档 Proposal/Apply 操作。
- 在开放 Agent 写入前，将文档编辑器升级到稳定的 Block 或 Transaction 模型。

退出条件：

- Agent 无法绕过 Proposal、版本校验和 Policy 直接写文档。
- 重放或重试已经批准的操作，不会重复应用变更。

### Phase 4：恢复和精选 Extension

交付内容：

- Agent Host 重启后协调中断的 Run。
- 为重启和恢复增加有限重试预算。
- 接入经过审核的 Skill/Extension，并记录 Package 来源。
- 增加上下文用量、Token 用量、Queue 和 Todo 展示。

退出条件：

- 崩溃和重连场景通过自动化测试。
- 第二个 Fake Runtime 通过相同的一致性测试，证明 Pi 仍然可替换。

## 10. 测试策略

### 10.1 协议测试

- Runtime 能力协商。
- 事件转换和单调序号分配。
- 重复命令的幂等处理。
- 未知事件和不兼容协议版本处理。
- `agent-runtime-pi` 的公开 Export 不泄漏 Pi 类型。

### 10.2 集成测试

- Gateway 到 Agent Host 的启动、Ready、停止和崩溃重启。
- 从 Prompt 到流式完成的完整过程。
- 在推理阶段和工具执行阶段分别取消。
- 客户端连接前已经产生 Approval，连接后能够补拉。
- Context Lease 过期和越权访问。
- 文档基础版本冲突。

### 10.3 恢复测试

- 流式回答过程中 Renderer 重连。
- 请求已经完成但未确认时 Gateway 重启。
- 工具执行前和工具执行后 Agent Host 分别崩溃。
- 已产生部分 Assistant 输出后继续运行。
- 多次恢复失败后进入终态，不能无限循环。

### 10.4 安全测试

- Pi 默认工具没有注册。
- 不会发现用户级和项目级 Pi Extension。
- 符号链接和路径穿越无法突破 Capability 边界。
- Approval 完成后，工具参数不能被替换。
- 普通日志不包含密钥和完整 Chain-of-Thought。

## 11. 可观测性

每次运行需要关联以下标识：

```text
requestId
sessionId
runId
runtimeId
runtimeSessionRef
toolCallId
approvalId
contextLeaseId
documentTransactionId
```

需要记录：

- 生命周期耗时。
- 模型和 Provider。
- Token 用量。
- 重试次数。
- 工具执行时长。
- Approval 等待时长。
- 中断原因。
- 最终状态。

禁止记录：

- Bearer Token。
- 模型供应商凭据。
- 附件原始字节。
- 不受限制的完整 Chain-of-Thought。

## 12. 已知风险

| 风险 | 缓解措施 |
| --- | --- |
| Pi SDK 发生变化 | 锁定版本，并将所有 Pi Import 限制在一个适配器包中。 |
| 社区 Extension 可以执行任意代码 | 禁用自动发现，只使用经过审核和锁定版本的白名单。 |
| Pi 和 Gateway 产生双份状态 | 明确 Pi 是运行时检查点，Gateway 是产品和 UI 的数据权威。 |
| 外部副作用执行后进程崩溃 | 使用幂等键、持久化执行计划和明确的 `ambiguous` 结果。 |
| 当前 Evidence 数据仍位于 Electron | 开放 Evidence 工具前，先完成 Gateway 管理的读取边界。 |
| 当前文档编辑器没有稳定的 Block Revision | 在版本化文档事务完成前，不开放 Agent 写入。 |
| Agent Host 增加新的打包产物 | Phase 1 完成前加入生产打包验证。 |

## 13. 立即实施顺序

1. 创建 `packages/agent-contract`，定义 DTO Schema 和 Validator。
2. 创建 `packages/agent-runtime`，定义 Runtime 接口和一致性测试。
3. 实现 Fake Runtime 和 Gateway Agent 模块。
4. 增加 Agent WebSocket 订阅、History 和恢复接口。
5. 将当前 `AgentPanel` 连接到 Fake Runtime。
6. 创建 `apps/agent-host` 及其带版本的内部协议。
7. 创建 `packages/agent-runtime-pi`，并将 Pi 锁定到经过评审的版本。
8. 通过配置将 Fake Runtime 替换为 Pi。
9. 增加 Context Lease 和只读 Evidence/Document 代理工具。
10. 增加 Approval 和版本化文档事务。

这份计划之后的第一项代码工作，应当是运行时无关的协议和 Fake Runtime 端到端切片。边界尚未通过实际代码验证前直接接入 Pi，会让 Gateway 和 UI 过早依赖 Pi 的具体行为。
