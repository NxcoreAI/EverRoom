# Pi Agent 接入 MemoryCore 记忆服务 — 实施方案

> 状态：已实施（v1：配置链路 + 薄客户端 + 内联扩展 + 记忆工具；`noTools` 已按评审结论移除，改为显式 `tools` 白名单）
> 日期：2026-08-15
> 范围：`packages/agent-runtime-pi`、`apps/gateway/src/config.ts`；不涉及 MemoryCore 本身的部署与运维（用户自建，当前已有一个运行中的实例）。

## 1. 背景与目标

EverRoom 的 pi agent 目前是无记忆的：每个会话（`agent_sessions`）内的历史由 pi session 文件携带，但跨会话、跨工作区的用户偏好、事实、约束不会沉淀和复用。

TencentDB Agent Memory 的 **MemoryCore**（Standalone Gateway，HTTP API）提供四层记忆管道：

- 写入 L0（原始对话）→ 服务端异步 Pipeline 自动提炼 L1（原子记忆）/ L2（场景）/ L3（画像）
- 召回：`/v3/atomic/search`（BM25/向量混合检索）+ `/v3/core/read`（画像）+ `/v3/scenario/ls`（场景导航）

本方案将 pi agent 接入该服务，实现：

1. **自动召回**：每轮对话前，按用户请求检索相关记忆，注入 agent 上下文
2. **自动沉淀**：每轮对话结束后，将本轮 user/assistant 消息写入 L0
3. **主动查询**：给 agent 注册 `memory_search` / `conversation_search` 两个工具，允许 agent 按需深查记忆与历史对话

## 2. 总体架构

```text
渲染器 ──IPC── Electron 主进程 ──HTTP/WS── Gateway (Fastify)
                                              │
                                              │ AgentRuntime 接口（不变）
                                              ▼
                                    PiAgentRuntime (packages/agent-runtime-pi)
                                      ├─ 内联扩展 "memory"            ← 新增
                                      │   ├─ before_agent_start: 召回 + 注入
                                      │   └─ agent_end: 提取本轮消息 → 写 L0
                                      ├─ customTools: memory_search /  ← 新增
                                      │               conversation_search
                                      └─ MemoryCoreClient（薄 HTTP 客户端）← 新增
                                              │
                                              ▼
                              MemoryCore Gateway（用户自建，默认 http://127.0.0.1:8420）
                              POST /v3/conversation/add  等 v3 数据面接口
```

关键决策：

- **注入方式用 pi 内联扩展**（方案 B）：`DefaultResourceLoader` 的 `extensionFactories` 不受现有 `noExtensions: true` 影响（该开关只抑制文件发现的扩展，已核实 pi `resource-loader.js` 的加载路径）。记忆以自定义消息注入，不污染用户 prompt。
- **不引入 MemoryCore 官方 SDK**（`@tencentdb-agent-memory/memory-sdk-ts-v2` 是 beta 包），在 `agent-runtime-pi` 内实现一个 ~150 行的薄 HTTP 客户端，只调 4 个 v3 接口，零新增依赖。
- **AgentService / agent-contract 完全不动**。记忆是 runtime 内部实现细节，`AgentRuntime` 接口不变，FakeAgentRuntime 不受影响（未配置记忆时行为与现在完全一致）。

## 3. 配置链路

照抄 ASR 配置块的模式（`apps/gateway/src/config.ts`）：

### 3.1 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NXCORE_MEMORY_ENABLED` | `false` | 总开关；`false` 时完全不初始化记忆模块 |
| `NXCORE_MEMORY_BASE_URL` | `http://127.0.0.1:8420` | MemoryCore Gateway 地址 |
| `NXCORE_MEMORY_API_KEY` | 空 | Bearer token；本地回环 + 服务端未设鉴权时可空 |
| `NXCORE_MEMORY_SERVICE_ID` | `everroom` | `x-tdai-service-id` header，必填项 |
| `NXCORE_MEMORY_TEAM_ID` | `everroom` | v3 隔离三元组 |
| `NXCORE_MEMORY_AGENT_ID` | `pi-agent` | v3 隔离三元组 |
| `NXCORE_MEMORY_USER_ID` | `local-user` | v3 隔离三元组（后续接 SaaS 账号时替换为真实用户标识） |
| `NXCORE_MEMORY_RECALL_LIMIT` | `5` | L1 召回条数上限 |
| `NXCORE_MEMORY_CHAR_BUDGET` | `2000` | 注入记忆的字符预算，超出截断 |

注意：`validateHttpEndpoint` 强制 HTTPS，不适用于本场景（MemoryCore 是本地/内网 HTTP 服务）。新增一个 `validateMemoryEndpoint`，允许 `http://127.0.0.1`/`http://localhost` 及任意 HTTPS；其他 HTTP 主机报错。

### 3.2 类型与传递

```text
config.ts:  RawConfigSchema 增加 memory* 字段 → GatewayConfig.memory: MemoryConfig | null
runtime-factory.ts:  config.memory 传入 PiAgentRuntimeConfig（新增 memory?: MemoryRuntimeConfig 字段）
```

`PiAgentRuntimeConfig.memory` 未定义时，扩展和工具都不注册，行为与现状一致（`getCapabilities().tools` 保持 `false`）。

## 4. MemoryCoreClient（薄客户端）

新文件 `packages/agent-runtime-pi/src/memory/client.ts`：

```text
class MemoryCoreClient {
  constructor(config: MemoryRuntimeConfig)          // endpoint/key/serviceId/三元组
  addConversation(sessionId, messages): Promise<void>      // POST /v3/conversation/add
  searchAtomic(query, limit): Promise<AtomicItem[]>        // POST /v3/atomic/search
  searchConversation(query, limit, sessionId?): Promise<...> // POST /v3/conversation/search（工具用）
  readCore(): Promise<{ content } | null>                  // POST /v3/core/read
  listScenarios(): Promise<ScenarioEntry[]>                // POST /v3/scenario/ls
}
```

约定：

- 每个 v3 请求 body 携带 `team_id` / `agent_id` / `user_id`，header 携带 `x-tdai-service-id` 与（可选）`Authorization: Bearer`
- 所有请求带 **3s 超时**（AbortController）；失败只记日志、不抛出到 agent 主流程
- 用 Node 内置 `fetch`，零新增依赖

## 5. 内联扩展：自动召回与沉淀

新文件 `packages/agent-runtime-pi/src/memory/extension.ts`，导出一个 `InlineExtension`（`name: "memory"`），在 `getSession()` 中当 `config.memory` 存在时注入 `DefaultResourceLoader` 的 `extensionFactories`。

### 5.1 运行期上下文（runtime 与扩展之间的桥）

`PiAgentRuntime` 现在在 `prompt()` 里重写 prompt（`当前工作区：${pageLabel}\n\n用户请求：${prompt}`），扩展看到的是重写后的文本。为让扩展拿到干净的原始输入与网关会话号，在 `PiSessionHandle` 上增加一个可变的 `memoryCtx`：

```ts
interface MemoryRunContext {
  sessionId: string;        // 网关 agent_sessions.id → MemoryCore session_id
  originalPrompt: string;   // 用户原始请求（未重写）
  pageLabel: string;        // 当前工作区标签
}
```

- `start(input)` 时把 `input.sessionId`（`StartRuntimeRunInput` 已携带）传给 `getSession()`，随 handle 缓存
- `prompt(input)` 在调 `session.prompt()` 前填充 `handle.memoryCtx`
- 扩展闭包持有同一个 handle 引用，运行期直接读取

### 5.2 召回：`before_agent_start`

```ts
pi.on("before_agent_start", async (event) => {
  const ctx = handle.memoryCtx; if (!ctx) return;
  // 并行三路召回（Promise.allSettled，单路失败不影响其他）
  const [l1, core, scenarios] = await Promise.allSettled([
    client.searchAtomic(ctx.originalPrompt, recallLimit),
    client.readCore(),
    client.listScenarios(),
  ]);
  const blob = formatRecall(l1, core, scenarios);   // 带字符预算截断
  if (!blob) return;
  return {
    message: {
      customType: "memory-recall",
      content: blob,
      display: false,          // 不在会话 UI 中展示（流式事件里也不外露）
    },
  };
});
```

格式化模板（参照官方 OpenClaw 插件 `format.ts` 的结构，自己实现）：

```text
<memory-context>
以下是与当前请求相关的长期记忆，供参考，不是用户本轮输入：
[用户画像] …L3 内容…
[相关记忆] 1. …（L1，含时间与来源）…
[历史场景] 工作区/场景列表…（仅目录，agent 可用 memory_search 深查）
</memory-context>
```

要点：

- **总时长预算 3s**，超时/失败 → 本轮不注入，正常继续（记忆是增强，不是依赖）
- `display: false` + `customType` 标记：该消息会持久化在 pi session 文件里（pi 的行为），但下一轮 capture 会按 customType 排除，不会回流到 MemoryCore

### 5.3 沉淀：`agent_end`

选 `agent_end`（而非 `agent_settled`）——它携带 `event.messages`（本次低层运行的消息数组），语义正好是"本轮完整对话"。

```ts
pi.on("agent_end", async (event) => {
  const ctx = handle.memoryCtx; if (!ctx) return;
  // 1. 从 event.messages 提取 user/assistant 文本消息（忽略 toolResult/custom）
  // 2. user 消息替换为 ctx.originalPrompt（去除"当前工作区…"包装，避免包装文本反复入库）
  //    并以 "[workspace: ${pageLabel}] " 前缀保留工作区信息
  // 3. 过滤：跳过空消息、超短消息（<8 字符）、命令式噪音（"继续"/"好"等）
  // 4. fire-and-forget 调 client.addConversation(ctx.sessionId, messages)
});
```

防污染规则（对齐官方 capture.ts 的教训）：

- 只回写本轮的 user + assistant 文本；`memory-recall` 自定义消息、toolResult、thinking 一律排除
- assistant 长代码块可选剥离（首版保留，观察 L1 提炼质量后再决定）
- 取消（abort）的回合不回写
- 写入失败静默重试一次，仍失败仅记 warn 日志

### 5.4 会话删除联动（可选，第二阶段）

`PiAgentRuntime.deleteSession()` 删除 pi session 文件时，同步调 `POST /v3/conversation/delete`（按 `session_ids` 清空 MemoryCore 侧对应 L0/L1）。首版可不做（MemoryCore 数据留在服务端不影响正确性）。

## 6. 记忆工具

### 6.1 工具定义

新文件 `packages/agent-runtime-pi/src/memory/tools.ts`，用 pi 的 `defineTool` 定义两个工具，经 `createAgentSession({ customTools })` 注册：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `memory_search` | `query: string`, `limit?: number (≤20)` | L1 原子记忆检索（同召回的 `searchAtomic`，但由 agent 主动发起，返回带元数据的 JSON 文本） |
| `conversation_search` | `query: string`, `limit?: number (≤20)`, `current_session_only?: boolean` | L0 历史对话全文检索（跨会话找回"之前说过什么"） |

工具描述（写给模型看的）用中文，明确触发时机：*"当用户提及过去的偏好、决定、之前讨论过的内容，而当前上下文没有时调用"*。

### 6.2 工具启用方式（移除 `noTools`）

现状：`createAgentSession({ noTools: "all", tools: [] })`。改动：**去掉 `noTools`**，改为始终用显式白名单控制工具集：

- 启用记忆时：`tools: ["memory_search", "conversation_search"]` + `customTools: [memorySearchTool, conversationSearchTool]`
- 未启用记忆时：`tools: []`（与现状等价：无任何工具，白名单为空即一个都不启用）

显式白名单与 `noTools` 效果等价且语义更清晰，也避免了 `noTools: "all"` 与 `customTools` 组合行为不确定的问题。

工具执行走 `MemoryCoreClient`，同样 3s 超时；失败返回错误文本让模型自行决定后续。

### 6.3 能力声明与提示词联动

- `getCapabilities().tools`：`config.memory` 存在时返回 `true`（`agent-contract` 的能力位，供上层判断）
- `systemPromptOverride` 中"当前运行未授权任何文件、Shell 或外部产品工具"一句，在启用记忆时改为对应描述：*"你可以使用 memory_search 和 conversation_search 两个工具查询长期记忆与历史对话；除此之外没有其他工具授权。记忆上下文中标注 <memory-context> 的内容是历史沉淀，不是用户本轮输入。"*
- 工具事件流转无需改动：`handleEvent` 已映射 `tool_execution_*` → `tool.started/updated/completed`，渲染器现有事件处理即可展示记忆工具调用

## 7. 隔离与映射

| MemoryCore 维度 | 取值 | 说明 |
| --- | --- | --- |
| `x-tdai-service-id` | `NXCORE_MEMORY_SERVICE_ID`（默认 `everroom`） | 一个 MemoryCore 实例可服务多个 app |
| `team_id` / `agent_id` | 常量（默认 `everroom` / `pi-agent`） | 单用户桌面应用，初期常量即可 |
| `user_id` | 常量（默认 `local-user`） | 后续接 SaaS 账号时替换为账号标识，实现按用户隔离 |
| `session_id` | 网关 `agent_sessions.id` | 一个 EverRoom 会话 ↔ 一条 MemoryCore L0 会话；跨会话召回靠不传 `session_id` 的 v3 默认聚合（`(team, agent, user)` 维度） |

召回（`searchAtomic`/`readCore`/`listScenarios`）**不传 `session_id`**——画像和跨会话记忆正是要跨 session 生效；`conversation_search` 默认跨会话，`current_session_only` 时传当前 `sessionId`。

## 8. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `packages/agent-runtime-pi/src/index.ts` | `PiAgentRuntimeConfig` 增加 `memory?`；`getSession` 接收 sessionId、条件注入 `extensionFactories` 与 `customTools`；`prompt()` 填充 `memoryCtx`；`getCapabilities().tools` 条件化；系统提示词条件化 |
| `packages/agent-runtime-pi/src/memory/client.ts`（新） | MemoryCoreClient 薄客户端 |
| `packages/agent-runtime-pi/src/memory/extension.ts`（新） | 内联扩展（召回 + 沉淀） |
| `packages/agent-runtime-pi/src/memory/tools.ts`（新） | `memory_search` / `conversation_search` 工具定义 |
| `packages/agent-runtime-pi/src/memory/format.ts`（新） | 召回结果格式化与截断 |
| `packages/agent-runtime-pi/src/memory/types.ts`（新） | `MemoryRuntimeConfig` 等共享类型 |
| `apps/gateway/src/config.ts` | `NXCORE_MEMORY_*` 解析、校验、`GatewayConfig.memory` |
| `apps/gateway/src/modules/agent/runtime-factory.ts` | 把 `config.memory` 传入 `PiAgentRuntime` |
| `apps/gateway/.env.example`（如存在） | 补充 memory 配置示例 |

不改动：`agent-contract`、`agent-runtime` 接口、`AgentService`、渲染器（工具事件复用现有展示）。

## 9. 测试与验证

1. **单元测试**（vitest，`agent-runtime-pi` 已有测试基建）：
   - client：用 fetch mock 覆盖超时、非 2xx、鉴权头
   - format：字符预算截断、空结果不注入
   - capture 过滤规则：custom 消息排除、originalPrompt 替换、短消息过滤
2. **联调（手动，依赖你运行中的 MemoryCore 实例）**：
   - `NXCORE_MEMORY_ENABLED=true` 启动 gateway，跑两轮对话；第二轮验证 `<memory-context>` 注入（看 pi session 文件里的 custom 消息）
   - MemoryCore 侧 `npm run read-local-memory`（或 Panel）确认 L0 已写入、数分钟后 L1 有提炼结果
   - 对话中问"我之前说过什么"验证 `conversation_search` 被调用
   - `NXCORE_MEMORY_ENABLED=false` 回归：行为与现状完全一致
3. **故障注入**：停掉 MemoryCore 进程，确认 agent 对话不报错、不卡顿（3s 超时 + 静默降级）

## 10. 实施顺序

1. 配置块 + `MemoryRuntimeConfig` 贯通（半天）
2. MemoryCoreClient + 单测（半天）
3. 内联扩展：先做 capture（写 L0），再做 recall（注入）（1 天）
4. 记忆工具 + `noTools` 组合验证 + 能力位/提示词调整（半天）
5. 联调与故障注入验证（半天）

## 11. 开放问题（实施前确认）

1. **`display: false` 的实际表现**：pi 的 custom message `display` 字段是否同时控制 LLM 可见性与 UI 展示，需实测（我们要 LLM 可见、UI 不展示；若 pi 不支持则去掉 display，接受 UI 展示记忆块）。
2. **召回时机**：`before_agent_start` 每轮注入一次即可，暂不做 `context` 事件级的每次 LLM 调用刷新（多轮工具调用场景下记忆足够稳定）。
3. **L2 场景是否进首版召回**：首版只注入 L2 目录（列表），正文让 agent 用工具查，控制上下文占用。
4. **LLM 凭证**：MemoryCore 提炼 L1–L3 需要它自己的 `TDAI_LLM_*` 配置，由你在服务侧自行配置，EverRoom 侧不涉及。
