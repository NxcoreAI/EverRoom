# Agent 调试台历史归档（设计 + 实现契约）

> 状态：进行中（2026-10-24）
> 关联：`docs/agent-debug-page.zh-CN.md`（调试台总览）
> 目标：桌面应用（Gateway 进程）停止后，调试台里的历史 run（含工具调用、思考、消息、
> 输出）仍能在重启后按「会话 / 时间」找回；运行中的 run 仍只存在于内存。

## 1. 用户问题

现有实现（`apps/gateway/src/modules/agent-debug/trace-store.ts`）是纯内存环形缓冲：
Gateway 退出即清空。调试台重启后只有一个空列表，无法回看上一次桌面会话里各 Agent 的
执行过程。此外现有 run 列表只有 `task` / `pageLabel`，无法区分「同一个会话的多轮 run」与
「不同会话」，历史找回时缺乏可辨认的锚点。

本次改动解决两件事：

1. **持久化**：run 结束后把 run 元数据 + 全部事件写入磁盘归档；Gateway 启动时读取索引，
   调试台把归档 run 作为「历史」与本次进程的 run 合并展示（`origin: live | archive`）。
2. **可辨认**：run 关联会话标题（`sessionTitle`）与绝对时间；调试台可按会话筛选、
   区分「本次 / 历史」，从而找回某一次对话对应的 Agent 执行记录。

非目标：不做跨机器同步；不进入产品 UI；不改变 Agent 业务行为；不做全文检索 / 分页
（历史浏览上限见 §7）。

## 2. 数据契约（`packages/agent-contract/src/index.ts`，Lead 已提交草稿）

```ts
export type AgentDebugRunOrigin = "live" | "archive";

export interface AgentDebugRun {
  // …原有字段不变…
  /** 数据来源；缺省按 live（兼容旧 Gateway）。归档 run 固定 archive。 */
  origin?: AgentDebugRunOrigin;
  /** 会话标题（agent_sessions.title）；子 Agent / 会话已删除为 null。查询时补全。 */
  sessionTitle?: string | null;
}

export interface AgentDebugArchiveInfo {
  enabled: boolean;
  retentionDays: number;
  runCount: number;
  bytes: number;
  oldestStartedAt: string | null;
}

export interface AgentDebugSnapshot {
  // …原有字段…
  /** 磁盘归档概况；归档关闭时 enabled=false。 */
  archive?: AgentDebugArchiveInfo;
}
```

HTTP API 变更（`/v1/agent-debug/*`，仍只读、仍走 Bearer）：

| 接口 | 变更 |
| --- | --- |
| `GET /v1/agent-debug/snapshot` | 新增 `archived=include|only|exclude`（默认 `include`）；`runs` 上限保持 300、默认 150；响应新增 `archive`。`runs` 中的历史 run 带 `origin:"archive"`。 |
| `GET /v1/agent-debug/runs/:runId/events` | 内存里没有时回落到磁盘归档读取；归档 run 返回 `origin:"archive"`，`latestSeq` 为归档内最大 seq。 |
| 其它 | 参数越界仍 400、未知 run 仍 404、无 token 仍 401。 |

`archived=include` 的合并规则：运行中 run 永远最前；其余按 `startedAt` 倒序混合；
同一 `runId` 同时存在于内存与归档时以内存为准（不重复出现）。

## 3. 归档存储（文件型，不改数据库、不加迁移）

位置：`<dataDir>/agent-debug/<source>/`，`source` ∈ `main`（主网关）、
`cursor-completion`（补全专用网关）。两个 Gateway 进程各写各的目录，索引不会互相覆盖。

```text
agent-debug/main/
  index.json                                  # { version: 1, runs: ArchiveIndexEntry[] }
  runs/<YYYYMMDD>/<safeRunId>.ndjson          # 第 1 行 run meta，其后每行一个事件
```

- ndjson 行格式：
  - `{"kind":"run","run":<AgentDebugRun>}`（第一行；写入时 run 已是终态）
  - `{"kind":"event","event":<AgentDebugEvent>}`
- `ArchiveIndexEntry = { run: AgentDebugRun; file: string; bytes: number }`，
  `file` 相对 `<source>` 目录；`run.eventCount` = 归档事件数。
- 写入：先写 `<file>.tmp` 再 `rename` 覆盖（原子）；`index.json` 同样 tmp+rename。
  `safeRunId` 只保留 `[A-Za-z0-9._-]`，其它字符替换为 `_`，避免路径穿越。
- 读取：`readEvents(runId, afterSeq, limit)` 解析 ndjson → 过滤 `seq > afterSeq` →
  截断 `limit`；`latestSeq` = 文件内最大 seq。解析失败的坏行跳过（不抛错）。
- 自愈：`index.json` 缺失/损坏时扫描 `runs/**/*.ndjson` 的第一行重建索引；单个文件坏掉
  只跳过该文件。
- 保留策略（写入后即时裁剪）：默认最久 7 天、最多 2000 条 run、最多 1 GiB；
  超限从最旧开始删除 `run` 文件并更新索引。`NXCORE_AGENT_DEBUG_ARCHIVE=0` 可整体关闭。
- 所有归档异常（磁盘满 / 权限）都必须被吞掉并 warn，不影响 Agent 行为与 Gateway 启动。

## 4. 模块与接线

### 4.1 `apps/gateway/src/modules/agent-debug/archive.ts`（新增）

```ts
export interface AgentDebugArchiveOptions {
  dir: string;
  retentionDays?: number;  // 默认 7
  maxRuns?: number;        // 默认 2000
  maxBytes?: number;       // 默认 1 GiB
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
}

export class AgentDebugArchive {
  info(): AgentDebugArchiveInfo;
  /** 写入一条终态 run（幂等：同 runId 重复写入直接忽略）。 */
  archiveRun(run: AgentDebugRun, events: readonly AgentDebugEvent[]): Promise<void>;
  listRuns(limit: number, excludeRunIds?: ReadonlySet<string>): AgentDebugRun[];
  getRun(runId: string): AgentDebugRun | null;
  readEvents(runId: string, afterSeq?: number, limit?: number):
    { events: AgentDebugEvent[]; latestSeq: number } | null;
  /** 等待所有排队写入完成（dispose 用）。 */
  flush(): Promise<void>;
}
```

- `archiveRun` 串行排队写盘，永不 reject（内部 catch + warn）；`flush()` 等待队列。
- 构造时同步加载索引；**不加载事件正文**（只在选中历史 run 时读文件）。

### 4.2 `trace-store.ts`

- 构造函数改为 `constructor(private readonly archive?: AgentDebugArchive)`（可选，兼容现有
  测试与无归档场景）。
- `finishRun` 成功后（终态只写一次）把 `toDebugRun(run)` + `materialize` 全部事件交给
  `archive.archiveRun(...)`，**不 await**（fire-and-forget + 吞异常），不阻塞事件流。
- `listRuns(limit, archived?: "include"|"only"|"exclude")`：`include` 时与
  `archive.listRuns(limit, liveRunIds)` 合并、排序后截断；live run 补 `origin:"live"`。
- `getRun` / `listEvents`：内存没有时回落 `archive`。
- `archiveInfo()`：归档关闭时返回 `{ enabled:false, retentionDays:0, runCount:0, bytes:0, oldestStartedAt:null }`。
- `dispose()` 改为 `async dispose(): Promise<void>`：把仍是 `running` 的 run 按
  `interrupted` 收尾（归档为中断态），然后 `await archive.flush()`，再清空内存。
  调用方（`create-server.ts` / `create-cursor-completion-server.ts` 的 onClose）改成 await。

### 4.3 `routes.ts`

- 新增可选第三参：`{ sessionTitles?: (sessionIds: readonly string[]) => ReadonlyMap<string, string | null> }`。
  每次 snapshot / events 返回前对 run 批量补 `sessionTitle`（collect 唯一 sessionId 一次查询）。
- snapshot 支持 `archived` 查询参数（见 §2），响应带 `archive: store.archiveInfo()`。
- events 路由回落到归档，同时补 `sessionTitle`。

### 4.4 配置（`apps/gateway/src/config.ts`）

```ts
export interface AgentDebugArchiveConfig {
  enabled: boolean;
  retentionDays: number;
  maxRuns: number;
  maxBytes: number;
}
// GatewayConfig 新增可选字段（可选，避免破坏既有测试构造的对象）：
agentDebugArchive?: AgentDebugArchiveConfig;
```

env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `NXCORE_AGENT_DEBUG_ARCHIVE` | `true` | `0`/`false`/`off` 关闭归档 |
| `NXCORE_AGENT_DEBUG_ARCHIVE_DAYS` | `7` | 保留天数（1–3650） |
| `NXCORE_AGENT_DEBUG_ARCHIVE_RUNS` | `2000` | 最多 run 条数（1–100000） |
| `NXCORE_AGENT_DEBUG_ARCHIVE_MAX_MB` | `1024` | 归档总字节上限（MB，64–65536） |

### 4.5 服务端接线（`create-server.ts` / `create-cursor-completion-server.ts`）

- 主网关：`new AgentDebugArchive({ dir: resolve(config.dataDir, "agent-debug", "main"), ... })`；
  补全网关：`.../cursor-completion`。归档关闭时不创建实例，store 收到 `undefined`。
- `agentDebugRoutes(store, catalog, { sessionTitles })`：主网关用 drizzle 批量查
  `agent_sessions.id/title`（`inArray`）；补全网关同样可用（表结构一致），查不到返回空 Map。
- 诊断日志用 `app.log.warn` 传入 archive 的 `warn` 回调（可选）。

## 5. 调试页 UI（`apps/desktop/src/renderer/src/agent-debug/**`）

- `api.ts`：`loadSnapshot(sourceId, { runs?: number; archived?: 'include'|'only'|'exclude' })`。
- 顶栏新增「范围」三态文字按钮：`全部`（include，默认）/ `本次`（exclude）/ `历史`（only）。
  切到「历史」时 snapshot 请求 `runs=300` 以覆盖更多历史；归档关闭时按钮置灰并提示。
- 顶栏展示归档概况（muted 文本，例：`历史 128 条 · 保留 7 天`，title 里给 bytes/最旧时间）。
- run 列表：
  - 每行增加来源标记：`origin === 'archive'` 显示「历史」文字标签；日期时间显示为
    `MM-DD HH:mm`（替代/补充现有耗时）；
  - 列表头「会话」筛选下拉；选项标签 =「主名 · 首次时间 · #短id」，主名优先 `sessionTitle`，
    缺失时用该会话首条 run 的任务摘要，再回退 `pageLabel` / 短 id；hover title 带完整
    sessionId、时间范围与 run 数。筛选在客户端进行；「无会话」归为独立选项并永远最后。
  - 「全部会话」视图下按会话分组（`groupRunsBySession`）：组头显示同样的「主名 · 首次时间 ·
    #短id」+ run 数，点击组头直接筛选到该会话；筛选后顶部出现「筛选：… / 全部会话」提示条。
  - run 行会话标签始终附 `#短id`，标题相同的会话也能在行内区分。
  - 历史 run 不参与「跟随最新运行中 run」的自动选中（现状：跟随只挑 running，天然满足）；
    历史模式下默认选中最新一条历史 run。
- Run 详情：归档 run 显示「历史归档 · 只读」提示；不再显示「实时更新」；事件只拉一次
  （run 终态后现有轮询自然停止）。meta 行补充会话标题 + `#短id`（完整 sessionId 也在 meta 里）。
- 纯函数抽到 `agent-debug/history.ts`（`originOf`、`sessionKeyOf`、`sessionShortId`、
  `sessionLabelOf`、`sessionPrimaryOf`、`buildSessionOptions`、`groupRunsBySession`、
  `sortRunsByActivity`、`filterRunsBySession`、`snapshotQueryFor(mode)`），配单测；
  reducer 不动。
- 视觉沿用现有浅色极简规范（10 个 hex、无渐变/阴影/动画/圆角新增，lucide 仅 ChevronRight）。
  历史标签只用 muted 文字 + 现有边框色，不引入新颜色。

## 6. 验收 / 测试

Gateway：

1. 新增 `tests/agent-debug-archive.test.ts`：临时目录下写入→新实例（模拟重启）可列出；
   事件可读、`afterSeq/limit` 生效；保留策略（天数/条数/字节）裁剪；索引损坏重建；
   坏行跳过；`dispose` 把 running 归档为 interrupted；归档关闭时不写盘。
2. `tests/agent-debug.test.ts` 增补：snapshot `archived` 三态、`origin`、`archive` 字段、
   历史 run events 200 / 未知 run 仍 404、`sessionTitle` 注入。
3. `tests/config.test.ts`：env 解析与默认值（若该文件已有类似结构则按同风格补）。
4. `cd apps/gateway && node node_modules/typescript/bin/tsc --noEmit` 通过；
   `node node_modules/vitest/vitest.mjs run tests/agent-debug.test.ts tests/agent-debug-archive.test.ts tests/config.test.ts` 全绿。

Desktop：

5. `apps/desktop/tests/agent-debug-history.test.ts`：会话推导/分组/标签去重、来源判断、查询参数映射。
6. `cd apps/desktop && node node_modules/vitest/vitest.mjs run tests/agent-debug-reducer.test.ts tests/agent-debug-history.test.ts` 全绿；
   `node node_modules/vite/bin/vite.js build --config vite.agent-debug.config.mts` 通过。
7. typecheck：`node node_modules/typescript/bin/tsc --noEmit`，既有 ThoughtsPane 基线错误之外 0 新增。

端到端（Lead）：`scripts/agent-debug-archive-e2e.mjs` —— fake runtime 起网关→建会话跑
run→停止网关→同 dataDir 重启→`snapshot?archived=only` 能看到该 run（origin archive）
且 events 可读；文件系统里存在对应 ndjson。

## 7. 已知限制（需要写进总览文档）

- 只有终态 run 会落盘：进程被 SIGKILL（非正常退出）时，运行中的 run 不保证保留；
  正常退出（SIGTERM，桌面端 shutdown 会等 5s）会把 running 归档为 interrupted。
- 历史浏览上限：`snapshot` 最多返回 300 条（历史模式 `runs=300`），更早的 run 需直接查看
  `<dataDir>/agent-debug/<source>/runs/` 下的 ndjson（文档给出路径）。
- 归档是调试数据：不加密、只在本机、按天/条数/容量自动清理。
- `sessionTitle` 查询时补全：会话被删除后历史 run 仍可按任务文本与时间找回。

## 8. 文件清单与写作用域

```text
packages/agent-contract/src/index.ts                    # 契约（Lead）
apps/gateway/src/modules/agent-debug/archive.ts         # 新增归档实现（gateway）
apps/gateway/src/modules/agent-debug/trace-store.ts     # 接入归档 / origin / dispose（gateway）
apps/gateway/src/modules/agent-debug/routes.ts          # archived 参数 / sessionTitle / archive（gateway）
apps/gateway/src/config.ts                              # env 解析（gateway）
apps/gateway/src/server/create-server.ts                # 创建归档 + sessionTitle 查询 + await dispose（gateway）
apps/gateway/src/server/create-cursor-completion-server.ts # 同上（gateway）
apps/gateway/tests/agent-debug-archive.test.ts          # 新增（gateway）
apps/gateway/tests/agent-debug.test.ts                  # 增补（gateway）
apps/gateway/tests/config.test.ts                       # 增补（gateway）
.env.example                                            # 新增 env 说明（gateway）
scripts/agent-debug-smoke.mjs                           # 增补 archive 断言（gateway，可选）
apps/desktop/src/renderer/src/agent-debug/**            # 历史 UI（desktop）
apps/desktop/tests/agent-debug-history.test.ts          # 新增（desktop）
scripts/agent-debug-archive-e2e.mjs                     # 重启找回 e2e（Lead）
docs/agent-debug-page.zh-CN.md                          # 总览更新（Lead）
docs/agent-debug-persistence.zh-CN.md                   # 本文（Lead）
```
