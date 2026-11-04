# Agent 调试面板（恢复 + 上下文检查器）设计

- 状态：**已实施**（2026-10-29）。网关 `/v1/agent-debug/*` + 运行时 `describe()`、桌面 IPC 桥、极简覆盖层 UI 均已完成；网关单测 6 例、桌面单测（含面板 3 例）与既有回归全绿（`bundled-agent.test.ts` 为工作树既有失败，已在 pristine HEAD 上复现确认与本改动无关）。
- 背景：旧桌面端的「Agent 连接页」里有一个调试面板（外部连接的回写提交 + 最近调用）。everoffice UI 迁移（`a8a7a498`）把旧页面整体删除，调试面板只剩网关 REST / preload API / i18n 文案。本次恢复该面板，并升级为「按 Agent 查看上下文」的检查器。
- 关联：`docs/design/agent-access-mcp-skills.zh-CN.md`（旧调试面板的原始设计）。

## 1. 目标与非目标

**目标**

1. 恢复外部 Agent 连接（MCP / Claude Code / Cursor / Codex）的「回写提交 + 最近调用」调试视图。
2. 新增按 Agent 的上下文检查器：点击某个 Agent，查看
   - 系统上下文：系统提示词（SYSTEM.md）、模型/运行时参数、能力集；
   - 各种上下文：内联 Skill、MCP 服务器、活动文件/打开页签/界面语言等运行期注入说明；
   - 工具上下文：该 Agent 声明的全部工具（按来源分组）。
3. 风格极简：单色、发丝线、无阴影/无渐变、无装饰图标；提示词与 JSON 用等宽字体。

**非目标**

- 不恢复旧「Agent 连接页」的连接新建/暂停/换 token/安装落盘等管理动作（连接仍由旧 API 支持，但本次 UI 只读）。
- 不持久化运行期系统提示词快照（pi 每次运行现拼）；面板展示的是「拼装输入」（bundle + 配置），运行期动态段落只做说明。
- 不新增数据库表、不改已有 REST 契约。

## 2. 数据来源

| 数据 | 来源 | 现状 |
| --- | --- | --- |
| 内置 Agent 定义（systemPrompt / tools / skills / capabilities / runtime） | `agents/*/agent.yaml` + `SYSTEM.md`，经 `loadBuiltinAgentBundle()` | 网关已加载，无 REST 出口 |
| 子 Agent 定义（systemPrompt / manifest / mcp / policy / skills） | `SubagentRegistry.listAll()`（`LoadedSubagentDefinition.revision`） | `GET /v1/subagents` 只返回脱敏定义，不含 prompt/工具 |
| Agent 状态（running/idle、当前/最近运行） | `AgentStatusService.snapshot()` | 已有 `/v1/agent/status` |
| 子 Agent 最近调用 | `SubagentOrchestrator.listInvocations()` | 已有 `/v1/subagent-invocations` |
| 模型档位/参数 | `GatewayConfig.pi / litePi / backgroundPi / cursorCompletionPi / webSearch` + 子 Agent `policy.model` | 无 REST 出口 |
| 外部连接及其提交/调用 | `agent-access` 模块 | 已有 REST + preload |
| 本地 Agent（Claude Code / Codex / OpenClaw） | `window.nxcore.agent.discoverLocalAgents()` | 已有 IPC |

结论：需要新增一个只读网关模块 `agent-debug`，其余全部复用。

## 3. 网关接口

新增模块 `apps/gateway/src/modules/agent-debug/{service.ts,routes.ts}`，在 `create-server.ts` 注册（走全局 bearer）。

```
GET /v1/agent-debug/agents
  -> { agents: AgentDebugAgentSummary[], generatedAt }        # 含 currentRun（运行中）
GET /v1/agent-debug/agents/:agentId
  -> { agent: AgentDebugAgentDetail, generatedAt } | 404
GET /v1/agent-debug/agents/:agentId/usage?limit=20
  -> { agentId, records: AgentDebugUsageRecord[], totals, generatedAt }
```

使用记录（usage）的数据源：内置 Agent 读 `agent_runs`（join `agent_sessions` 取标题/页面），
子 Agent 读 `subagent_invocations`；每次记录的 token 与工具调用次数从 `agent_events` /
`subagent_invocation_events` 的 `message.completed.payload.usage` 与 `tool.started` 聚合。
运行中的记录 `completedAt` 为空，`durationMs` 按「现在 - startedAt」实时计算。

- `agents` = `AgentResolver.list()`（已注册的 builtin）+ `SubagentOrchestrator.listDefinitions()`（developer）按 id 排序。
- 摘要带 `state / activeRunCount / toolCount / skillCount / model / revisionId / enabled / updatedAt`。
- 详情在摘要基础上补 `systemPrompt / capabilities / tools / skills(含 SKILL.md 全文) / mcpServers / modelInfo / limits / policy / recentActivity`。
- 安全：不返回 `apiKey`、MCP headers、token；`baseUrl` 可以返回（用户本机配置）。

模型档位映射：

| Agent | 档位 |
| --- | --- |
| `main` / `main-direct` | `config.pi` |
| `main-lite` | `config.litePi` |
| `cursor-completion` | `config.cursorCompletionPi` |
| `web-search` | `config.webSearch`（OpenAI 兼容，无 pi 参数） |
| 子 Agent | `config.backgroundPi` + revision `policy.model` 覆盖 |

## 4. 桌面 IPC

- 共享 DTO：`apps/desktop/src/shared/agent-debug.ts`（与网关响应同形）。
- 主进程桥：`apps/desktop/src/main/gateway/agent-debug-gateway-bridge.ts`，模式同 `AgentAccessGatewayBridge`（`gatewaySupervisor.ensureConnection()` + bearer + 连接可恢复重试）。
- IPC：`agent-debug:list-agents`、`agent-debug:get-agent`、`agent-debug:open-window`。
- preload / API 类型：`window.nxcore.agentDebug = { listAgents(), getAgent(id), openWindow() }`，补进 `shared/sources.ts` 的 `NxcoreDesktopApi`。
- 独立窗口由主进程 `openAgentDebugWindow()` 持有（单例：已开则聚焦/还原，关闭后置 null）；窗口大小 1180×820（最小 900×600），macOS 用 `hiddenInset`（与主窗口同款红绿灯位置），Windows 用 `hidden` + 渲染层 `WindowControls` 自绘；复用同一 preload，故面板可直接用 `window.nxcore`。调试窗口不参与 GenOffice 脏关闭守卫，关它不影响主窗口。

## 5. 渲染层

面板是**独立窗口 + 独立渲染入口**，不再是应用内的覆盖层：

- `apps/desktop/src/renderer/debug.html` → `debugEntry.tsx`：与主窗口相同的全局样式顺序（tokens → legacy → office-proto → desktop-frame），`LocaleProvider` + `.op-root` 包裹后挂载 `AgentDebugView`；`document.documentElement.dataset.desktop` 按 `window.desktop.platform` 设置（窗口拖拽区/红绿灯让位依赖它）。
- `AgentDebugView` 仍是面板本体（两栏 + 四个分段），「返回」/Esc 改为关闭当前窗口（`window.nxcore.window.close()`，浏览器预览回退 `window.close()`）。
- 入口：Agent 页头部的「调试」文字按钮 → `window.nxcore.agentDebug.openWindow()`，由主进程开窗（单例）。
- **实时运行态**：列表每 2s 轮询一次（窗口不可见时暂停），`state/activeRunCount/currentRun` 实时更新；
  运行中的 Agent 单列「运行中」分组置顶（显示已运行时长），详情头部展示当前任务与已运行时长。
- **使用记录**：选中 Agent 后拉 `listUsage(id, 20)` 并每 2.5s 刷新；记录行展示任务、状态、时间/耗时、
  工具调用次数、输入/输出 token、来源（子 Agent）、错误信息；顶部给这批记录的 token 汇总。
- Vite 构建新增 `agent-debug` 入口（`electron.vite.config.ts` 的 renderer input），产物为 `out/renderer/debug.html`。

布局（两栏，极简）：

```
┌────────────────────────────────────────────────┐
│ ← 返回   Agent 调试                        ▢ ▢ ▢│  44-48px，发丝线
├──────────────┬─────────────────────────────────┤
│ 内置 Agent    │  名称  描述                      │
│  main      ● │  内置 · pi · provider/model      │
│  main-lite   │ 系统上下文 | 上下文 | 工具 | 使用记录 │  文字分段，选中下划线
│ 子 Agent      │                                 │
│  doc-writer  │  [系统提示词]                    │
│ 外部连接      │  等宽 12px，pre-wrap，细边框       │
│  Claude Code │                                 │
│ 本地 Agent    │                                 │
└──────────────┴─────────────────────────────────┘
```

- 左栏 232px，分组标题 11px 弱化色；选中项浅灰底 + 1px 左侧强调线。
- 右栏最大宽度 860px，内边距 24px；标题 16/600，描述 12.5px muted，元信息 12px。
- 分段标签：纯文字，13px，选中加 1.5px 下划线；不使用胶囊/图标。
- 「系统上下文」：模型参数表（键值对，发丝线分隔）+ 系统提示词 `<pre>`。
- 「上下文」：上下文块列表，每块标题 + `静态/运行期` 标记 + 说明；静态内容可折叠展开。
- 「工具」：按来源分组的工具 chip（描边、11px）、Skill 折叠看 SKILL.md、MCP 服务器与工具白名单。
- 「使用记录」：该 Agent 最近 20 次运行/子 Agent 调用（任务、状态、开始时间与耗时、工具调用次数、token、错误），顶部汇总 token；外部连接用「调试」分段展示回写提交 + 最近调用（恢复旧面板内容，各取前 10 条）。
- 加载态为细线占位，空态与错误为一行弱化文字；Esc / 左上「返回」关闭窗口；无 toast。

样式 token 复用 `office-proto.css` 的 `.op-root` 变量（`--bg/--muted/--border/--hover/--accent`），新样式放独立 `agent-debug-view.css` 并全部限定在 `.op-agent-debug-*` 下；顶部栏同时是窗口拖拽区（`drag-region` / `no-drag`）。

## 6. 验证

1. `pnpm --filter @nxcore/gateway typecheck && pnpm --filter @nxcore/gateway exec vitest run tests/agent-debug.test.ts`
2. `pnpm --filter @nxcore/desktop typecheck && pnpm --filter @nxcore/desktop test`
2.1 调试面板用例：`vitest run tests/agent-debug-view.test.tsx`（含运行中置顶、使用记录、开窗入口）
3. 独立入口截图：`vite.browser.config.mts` 起预览服务，Electron 直接打开 `/debug.html`（preload 注入 mock 数据）核对系统上下文/上下文/工具/外部连接与 900×600 窄窗。
4. 构建：`electron-vite build` 确认 `out/renderer/debug.html` 与 `assets/agent-debug-*` 产物生成。
5. 实机（可选）：`pnpm dev` → Agent 页 → 调试，确认独立窗口打开/单例聚焦与真实数据；`EVERROOM_CDP` 可直连截图。