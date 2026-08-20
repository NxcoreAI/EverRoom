# EverRoom PC 与手机 Agent 双向同步方案

## 目标

让手机端能够可靠地感知电脑 Agent，并在后续阶段远程创建、观察、取消和审批 Agent 任务。

首阶段只交付状态链路：

- PC 登录后持续上报在线心跳。
- PC 上报 Agent 的空闲、执行中和异常状态。
- App 展示同一账号下所有 PC 的连接状态、Agent 状态与当前任务。
- PC 异常退出或断网后，App 能在租约超时后显示离线。

## 总体架构

```text
EverRoom App
  ├─ REST：设备与 Agent 状态快照
  └─ WSS：命令和实时事件（阶段二）
             │
             ▼
EverRoom SaaS Control Plane
  ├─ PostgreSQL：设备、状态投影、命令、事件、审计
  ├─ Redis Streams / NATS：多实例实时路由（阶段二）
  └─ APNs / FCM：后台通知（阶段三）
             ▲
             │ PC 主动出站连接
EverRoom Desktop
  └─ Local Gateway → Agent Runtime
```

手机不连接 PC 的本地 Gateway，也不暴露本地端口。所有跨设备请求必须经过 SaaS 的身份校验、设备归属校验和能力授权。

## 数据平面

### 控制平面

- 设备在线状态、版本和最后心跳。
- Agent 当前状态、任务标题、会话和 Run 标识。
- 远程命令：创建任务、取消任务、审批、暂停和恢复。
- 命令确认、执行事件和最终状态。

### 产物平面

- 最终回答、摘要和结构化结果。
- 用户明确请求同步的截图、文件和音频。
- 大文件使用对象存储预签名 URL，不通过 WebSocket 传输。

不复制 PC SQLite，不默认上传全盘文档。云端只保存远程协作所需的投影、命令、事件和授权产物。

## 阶段一：Presence 与状态投影

### 接口

```http
PUT /api/v1/app/agent/status
GET /api/v1/app/agent/devices
```

PC 每 15 秒上报一次：

```json
{
  "state": "running",
  "sessionId": "local-session-id",
  "runId": "local-run-id",
  "taskTitle": "整理今天的会议记录",
  "activeSince": "2026-08-20T10:00:00.000Z"
}
```

状态由本地 Agent bridge 的真实 Run 生命周期驱动：

```text
startRun accepted/running  → running
run.completed/cancelled   → idle
run.failed                → error
```

SaaS 使用服务端接收时间作为心跳时间。最后一次上报超过 45 秒时，即使数据库中的设备状态仍为 `online`，读取接口也必须返回 `offline`。

### 数据模型

`agent_device_status` 是每台 PC 一行的最新状态投影：

| 字段 | 说明 |
| --- | --- |
| `device_id` | 已认证、已注册的 PC 设备 |
| `state` | `idle`、`running`、`error` |
| `session_id` / `run_id` | 本地 Agent 标识 |
| `task_title` | App 可展示的当前任务摘要 |
| `active_since` | 当前任务开始时间 |
| `reported_at` | SaaS 收到心跳的时间 |

该表只保存最新投影，不承担历史审计。阶段二的命令和事件使用独立的追加式表。

## 阶段二：远程命令与实时事件

PC 主动连接 SaaS WSS，避免 NAT、企业网络和端口映射问题。手机通过 REST 创建持久化命令，通过 WSS 订阅实时事件。

命令状态机：

```text
queued → delivered → accepted → running
                             └→ completed | failed | cancelled | expired
```

每条命令至少包含：

```ts
interface AgentCommand {
  commandId: string
  idempotencyKey: string
  userId: string
  targetDeviceId: string
  type: 'agent.run' | 'agent.cancel'
  payload: unknown
  createdAt: string
  expiresAt: string
}
```

可靠性约束：

- PostgreSQL 中的命令记录是权威状态，WebSocket 只负责低延迟投递。
- 至少一次投递；PC 使用 `commandId` 和 `idempotencyKey` 去重。
- PC 将命令可靠写入本地待执行队列后才返回 `accepted`。
- 命令有过期时间，离线多日后不能突然执行旧任务。
- 每个设备或 Run 的事件序号单调递增，重连携带最后确认游标。
- Agent 事件复用现有 `AgentEvent`，外层只增加设备、命令和协议版本信息。

## 阶段三：审批、通知与产物

- 手机处理 Agent 的审批请求。
- APNs/FCM 提醒用户任务完成或等待审批。
- 最终结果和任务摘要持久化。
- 截图、文件等大产物按需上传对象存储。

## 权限边界

首版远程能力只开放：

```text
observe
agent.run
agent.cancel
```

后续能力独立授权：

```text
agent.approve
files.read
desktop.control
```

所有请求必须满足：Logto 用户有效、设备属于同一用户和租户、目标设备未撤销、命令能力已授权。远程命令和结果需要审计、限流，Token 不进入 URL，本地 Gateway 端口和 Token 永不暴露到公网。

## 可观测性

跨端日志统一携带以下关联字段：

```text
requestId deviceId commandId sessionId runId eventSeq
```

监控至少覆盖在线 PC 数、心跳延迟、命令排队时间、投递重试、执行成功率、断线重放数量和过期命令数量。

## 交付顺序

1. Presence、Agent 状态上报、SaaS 投影、App 状态页。
2. 持久化命令、PC WSS、手机创建和取消任务。
3. AgentEvent 实时转发、断线补发和最终结果。
4. 审批、移动推送和文件产物。
5. 同一会话跨端续聊；局域网直连仅作为后续加速路径。

## 非目标

- 不做 SQLite 全库同步。
- 不使用 CRDT 表达有序命令和事件。
- 不允许手机直接访问 PC 本地 HTTP 服务。
- 首版不开放任意 Shell、任意文件读取或完整桌面控制。
