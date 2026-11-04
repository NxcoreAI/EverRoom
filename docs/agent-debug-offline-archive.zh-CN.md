# Agent 调试台离线归档来源（EverRoom 不启动也能看历史）

> 状态：已交付并独立验收（2026-10-26）
> 关联：`docs/agent-debug-page.zh-CN.md`（调试台总览）、`docs/agent-debug-persistence.zh-CN.md`（历史归档设计）
> 目标：EverRoom（Gateway）没有运行时，调试页仍然能打开并回看磁盘上的历史 run。

## 1. 问题

调试页的数据来源一直只有 Gateway HTTP API（Vite dev server 代理 + 注入 Bearer）。历史归档虽然已经落盘在
`<dataDir>/agent-debug/<source>/`，但只有 Gateway 进程在跑时才能通过 `archived=include|only` 读到：

- EverRoom 没启动时 `GET /@agent-debug/sources` 返回 `[]`（manifest 缺失）或 stale manifest 导致 `502`；
- 页面要么停在「未发现 Gateway」空态，要么「离线」且没有任何数据；
- 想复盘几天前的 run，必须先启动一次 EverRoom，成本与目的不匹配。

## 2. 方案（最小改动）

在调试页的 **Vite dev server（Node 侧）** 增加一种只读数据来源：`archive`。它不经过 Gateway，直接读
`<dataDir>/agent-debug/<source>/index.json + runs/*.ndjson`，用与 Gateway 相同的接口形状喂给页面。

```text
浏览器 ──/ @agent-debug/gateway/<archiveSourceId>/v1/agent-debug/*──▶ Vite host（只读归档读取器）
                                                                        │
                                    <dataDir>/agent-debug/main/index.json + runs/*.ndjson
```

- 不新增进程 / 数据库 / 迁移；不改 Gateway 业务代码与契约。
- 页面逻辑基本复用：数据形状不变（`AgentDebugSnapshot` / `AgentDebugRunEvents`），历史 run 带 `origin: "archive"`，
  `RunDetail` 已经会显示「历史归档 · 只读」。
- archive 来源始终可用（只要归档目录存在）；live 来源保留，二者在「来源」下拉里并列。

### 2.1 归档目录发现

对每个已发现的 manifest 候选路径（`<dataDir>/runtime/gateway.json`），取其 `dataDir` 并扫描
`<dataDir>/agent-debug/*` 子目录；子目录里有 `index.json` 或 `runs/` 即视为一个归档来源。
`source` 目录名（`main` / `cursor-completion` / …）只用于展示标签，不参与读取逻辑。

目录不存在时跳过。同一归档目录（resolve 后）只出现一次。

### 2.2 `GET /@agent-debug/sources` 响应扩展

在原有 `id/label/baseUrl/version` 之外新增字段（均为可选，页面按缺省值兼容）：

| 字段 | live | archive |
| --- | --- | --- |
| `backend` | `"live"` | `"archive"` |
| `available` | manifest 里 `pid` 是否还活着（`process.kill(pid, 0)`） | 恒 `true` |
| `archiveDir` | — | 归档目录绝对路径（仅 title 展示） |
| `runCount` | — | 索引里 run 条数 |
| `latestStartedAt` | — | 最新一条 run 的 `startedAt` |

顺序：live 来源（manifest 发现顺序）在前，archive 来源（最新 run 时间倒序）在后；页面自行决定默认选中项。
archive 来源的 `id` = `archive-` + `sha1(归档目录)` 前 12 位（目录不变则跨重启稳定）。
archive 来源的 `label` = `历史归档 · <中文语义名>`：`main` → `主网关`、`cursor-completion` → `补全服务`，
其它目录名原样（页面再追加「 · 只读」）。

### 2.3 archive 来源上的代理端点

`GET /@agent-debug/gateway/<archiveSourceId>/v1/agent-debug/snapshot?runs=&archived=`

- 参数校验与 Gateway 一致：`runs` 1–300（默认 150）、`archived` ∈ `include|only|exclude`（默认 `include`），
  非法值 `400`。
- `archived=include|only`：返回归档 run（`startedAt` 倒序、截断 `runs` 条）；`exclude`：run 列表为空（归档来源没有「本次」）。
- `agents`：由归档 run 聚合（`agentId` 去重，名称/类型取该 Agent 最新一条 run；最近一条终态为失败/中断/超时
  时 `state=error`，否则 `idle`；`activeRunCount=0`；`lastRunAt` 取最新 `completedAt ?? startedAt`）。
- `archive`：`{ enabled: true, retentionDays: 0, runCount, bytes, oldestStartedAt }`；
  `retentionDays: 0` 表示「离线读取时未知」（Gateway 在线时才有配置值）。
- `droppedRuns`：`0`（归档是完整文件，没有内存淘汰）。

`GET /@agent-debug/gateway/<archiveSourceId>/v1/agent-debug/runs/:runId/events?afterSeq=&limit=`

- `afterSeq` ≥ 0（默认 0）、`limit` 1–5000（默认 1000），非法 `400`；未知 run `404`。
- 返回 `{ run, events, latestSeq }`，`events` 为 `seq > afterSeq`、按 seq 升序、截断 `limit`；
  终态 run 静态数据，不需要尾部 delta 重放。
- 其它路径 `404`；非 GET `405`。

除此之外的所有路径行为不变：live 来源照旧代理到 Gateway。

### 2.4 页面行为

- 来源下拉：archive 来源显示「历史归档 · 主网关（· 只读）」这类标签；不可用的 live 来源追加「· 离线」。
- 默认选中：第一个 `available` 的 live 来源 → 第一个 archive 来源 → 第一个来源；
  当前来源仍在列表里则保持；若当前 live 来源变不可用且有可用来源，自动切换（EverRoom 退出后自动落到历史归档）。
- 选中 archive 来源时：
  - 顶栏连接态显示「历史归档 · 只读」（title 为归档目录），不再显示「在线」；
  - 「范围」的「本次」禁用（归档来源没有本次进程的 run），切到该来源时范围落到「历史」；
  - 归档概况文本在 `retentionDays <= 0` 时显示「历史 N 条 · 只读」而不是「保留 0 天」。
- 空态：既没有 Gateway 也没有本地归档时，提示「未发现 Gateway，也没有可读的本地历史归档」，并给出
  `EVERROOM_AGENT_DEBUG_MANIFEST` / `NXCORE_DATA_DIR` 的用法。

## 3. 文件与写作用域

```text
apps/desktop/debug/host/archive-source.ts                     # 新增：只读归档读取器（索引缓存 / run 列表 / 事件 / agents）
apps/desktop/vite.agent-debug.config.mts                      # sources 扩展 + archive 代理端点 + pid 存活探测
apps/desktop/tsconfig.json                                    # include 增加 debug（让 host 读取器进 typecheck）
apps/desktop/tests/agent-debug-archive-source.test.ts         # 新增：读取器单测（索引/重建/事件/agents/发现）
apps/desktop/src/renderer/src/agent-debug/api.ts              # DebugSource 解析新字段
apps/desktop/src/renderer/src/agent-debug/sources.ts          # 新增：来源排序 / 默认选中 / 标签纯函数
apps/desktop/src/renderer/src/agent-debug/App.tsx             # 来源选择 / 连接态 / 范围禁用 / 空态
apps/desktop/src/renderer/src/agent-debug/history.ts          # retentionDays<=0 的归档概况文案
apps/desktop/src/renderer/src/agent-debug/styles.css          # 仅在需要时补 conn 状态样式（尽量不加）
apps/desktop/tests/agent-debug-sources.test.ts                # 新增：来源纯函数单测
apps/desktop/tests/agent-debug-history.test.ts                # 增补：归档概况 retentionDays=0
scripts/agent-debug-offline-smoke.mjs                         # 新增：无 Gateway 的离线冒烟（临时 dataDir + vite + HTTP 断言）
docs/agent-debug-page.zh-CN.md                                # 总览补「离线归档来源」
```

## 4. 验收（2026-10-26，全部 PASS）

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | Host 读取器单测 `tests/agent-debug-archive-source.test.ts` | 25 passed（索引/损坏重建/事件/agents/发现/label 映射/400 语义） |
| 2 | 页面单测 `tests/agent-debug-sources.test.ts` + `tests/agent-debug-history.test.ts` | 46 passed（16 + 30） |
| 3 | agent-debug 全量单测（6 文件） | 120 passed |
| 4 | typecheck `cd apps/desktop && node node_modules/typescript/bin/tsc --noEmit` | 既有 ThoughtsPane `10` 条基线，0 新增 |
| 5 | 构建 `node node_modules/vite/bin/vite.js build --config vite.agent-debug.config.mts` | exit 0，1594 modules → css 17.05 kB / js 197.27 kB |
| 6 | 离线冒烟（合成 fixture）`node scripts/agent-debug-offline-smoke.mjs` | 13/13 PASS |
| 7 | 离线冒烟（真实归档）`… --archive "$HOME/Library/Application Support/EverRoom/agent-debug/main"` | 13/13 PASS（586 runs / 63 MB） |
| 8 | 浏览器 e2e（合成 / 真实归档）`.tmp-inspect/agent-debug-offline-e2e/run.mjs [--archive <dir>]` | 14/14 PASS ×2；自动选中「历史归档 · 主网关 · 只读」、时间线/工具/事件/输出回放、「本次」禁用、1280×720 无横向溢出、console error 0 |
| 9 | 在线回归（EverRoom 运行中） | live 来源 `available=true`、archive 来源并列、live snapshot/events 200、archive snapshot 200；浏览器默认选中 live「EverRoom 主网关」、连接态「在线」、无未捕获异常 |

截图：`screenshots/agent-debug/offline-archive-1680.png` / `offline-archive-1280.png`（本机，`screenshots/` 不入库）。

验收环境：macOS，系统 node v22.23.1；两名并行工程师（host 读取器 / 页面 UI）+ Lead 集成验收；命令均用
`node node_modules/...` 直跑（未 `pnpm install` / 未 `git commit`）。EverRoom 运行中（用户 dev 实例）未被打断。

## 5. 已知限制

- 离线读取不补 `sessionTitle`（不读业务数据库），会话辨识退化为「任务摘要 + #短 id + 首次时间」。
- 离线读取拿不到 Gateway 的归档配置，`retentionDays` 显示为未知（只显示条数）；实际裁剪仍由 Gateway 写入时执行。
- 沿用既有 300 条快照上限：更早的 run 需在 EverRoom 运行时或用 `snapshot?runs=300` 之外的直接读文件方式查看。
- 归档只包含终态 run；进程被 SIGKILL 时运行中的 run 不在归档里（与现有行为一致）。
- 读取器只读：索引缺失/损坏时在内存里从 ndjson 首行重建，**不会**改写磁盘上的 `index.json`。
