# Hippo Memory 接入方案

> 状态：P1–P4 已落地并验证（2026-11-02）
> 决策背景：网关侧旧记忆模块已于 Phase 2d-2（`30501111`）删除；本方案以 [kitfunso/hippo-memory](https://github.com/kitfunso/hippo-memory)（MIT，零 npm 依赖，`node:sqlite`）作为**进程内嵌库**重建长期记忆，不引入独立服务。
> 选型结论：五条标准（完全开源 / 轻量 / 无附加服务 / 质量 / 市场认可）中四条达标；唯一硬伤是上游 BM25 分词器对中文完全失效（`\w` 不匹配 CJK），已由本仓库的转写适配层解决。

---

## 0. 已验证事实（2026-10-31 实测）

| # | 事实 | 验证方式 |
| --- | --- | --- |
| V1 | `node:sqlite` + FTS5 在 **Electron 40 内嵌 Node 24.15**（`ELECTRON_RUN_AS_NODE=1`）与开发态 Node 22.23 均可用 | 双运行时实测建表/插入/查询 |
| V2 | 上游 `tokenize()` 对纯中文返回 `[]`：`[^\w\s]` 将汉字整体删除，中文记忆与中文 query 在 BM25 全部 0 命中 | npm 2.2.0 拆包实测 |
| V3 | 修复路径实测可行：写入时把 jieba 分词结果做 codepoint 转写（`用户`→`zh7528_6237`）追加为检索键，query 同样转写后检索，中文命中恢复 | 见 §3 与 `tests/memory-*.test.ts` |
| V4 | 上游 `postinstall` 为 repair-only（修复已 opt-in 的 Codex shim + 打印提示），不改宿主配置、不外呼 | 源码审计 `src/postinstall.ts` |
| V5 | 打包态 gateway 由 `gateway-supervisor.ts` 以 `process.execPath + ELECTRON_RUN_AS_NODE=1` 启动，等价 Node 24 运行时 | 源码阅读 |
| V6 | 上游库 API 无 `types` 字段，需本仓库类型垫片 | `apps/gateway/src/types/hippo-memory.d.ts` |
| V7 | 唯一默认外呼：设 `ANTHROPIC_API_KEY` 时 `hippo sleep` 会调 Anthropic 做事实提取；本方案不启用该路径 | README Receipts 节 |

---

## 1. 架构

```text
apps/gateway（单进程，常驻）
  modules/agent/runtime-factory.ts
    └─ integrations.memory ? createMemoryPiTools(memoryService) → memory_search / memory_remember
  modules/memory/
    ├─ cjk.ts            jieba 分词 + codepoint 转写（中文检索键）
    ├─ hippo-adapter.ts  hippo-memory 库薄封装（remember/recall/feedback/forget/list/stats）
    ├─ service.ts        生命周期 + 开关（enabled/start/isStarted）
    ├─ routes.ts         /v1/memory/{status,entries,search} + DELETE entries/:id
    └─ pi-tools.ts       注入给 agent 的两个工具
  存储：<dataDir>/memory/hippo/（hippo.db + markdown 镜像）
```

**关键决策**

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 进程内嵌库，不起 sidecar | gateway 本身常驻 Node 进程；`node:sqlite` 同步 API，进程内最简、无端口与 IPC |
| D2 | 只接 `integration.tools`，不改 agent-runtime-pi | 复用既有 `lite-delegate-tools` 模式，避免与并行分支在 runtime 包上冲突 |
| D3 | 中文适配层是硬前提 | V2 实测中文全灭，不做即等于中文产品没有记忆检索 |
| D4 | 不用上游 hooks / `hippo init` | 那是开发者本机集成；产品内嵌只需库 API |
| D5 | agent 主动检索（工具）而非每轮注入 | token 成本可控，与 knowledge/document 工具同构 |
| D6 | 不启用 embedding / reranker / LLM 提取 | 保持零网络零模型；`extraction.enabled=false` |

---

## 2. 中文适配层（cjk.ts）

上游语料链：`entryText = content + tags.join(' ')` → `tokenize()` → `replace(/[^\w\s]/g,' ').split(/\s+/)`。JS 的 `\w` 等价 `[A-Za-z0-9_]`，**汉字被整段丢弃**。

方案（已实测）：写入时 `jieba.cut` → 非 ASCII token 转写成 `zh` + 逐字 codepoint 十六进制（`用户` → `zh7528_6237`）→ 追加进 tags（参与 BM25 语料）；检索时对 query 做同样转写。原句原样存 content 并原样返回给 agent；检索键在输出层统一剔除。

- ASCII 词原样保留 → 英文与中英混合记忆的英文部分不退化
- 单字 token 丢弃，与上游 `t.length > 1` 规则对齐
- 转写键以 `zh` 前缀 + 正则可识别，`isSearchKey()` 用于过滤

---

## 3. 已落地改动

| 文件 | 内容 |
| --- | --- |
| `apps/gateway/src/modules/memory/cjk.ts` | jieba 单例、`segment`/`searchKeys`/`toHippoQuery`/`isSearchKey` |
| `apps/gateway/src/modules/memory/hippo-adapter.ts` | 库封装：remember / recall / feedback / forget / list / stats，失败降级不抛错 |
| `apps/gateway/src/modules/memory/service.ts` | 开关与生命周期（失败不阻断 gateway 启动） |
| `apps/gateway/src/modules/memory/pi-tools.ts` | `memory_search` / `memory_remember` 两个 agent 工具 |
| `apps/gateway/src/modules/memory/routes.ts` | `/v1/memory/status`、`/entries`、`/search`、`DELETE /entries/:id` |
| `apps/gateway/src/types/hippo-memory.d.ts` | 上游缺 types 的类型垫片 |
| `apps/gateway/src/config.ts` | `GatewayConfig.memory`（`<dataDir>/memory/hippo`）；**默认开启，不设环境变量** |
| `apps/gateway/src/server/create-server.ts` | 实例化 MemoryService、注册路由、启动 |
| `apps/gateway/src/modules/agent/runtime-factory.ts` | `integrations.memory` → 注入记忆工具（仅用户档） |
| `apps/gateway/package.json` | `hippo-memory@2.2.0`、`@node-rs/jieba@^2.0.4` |
| `apps/gateway/tests/memory-*.test.ts` | 29 个用例：分词/转写、适配层中文端到端、工具、路由 |
| `apps/gateway/tsup.config.ts` | `@node-rs/jieba` 加入 external/noExternal 排除（原生模块不可内联） |
| `apps/gateway/scripts/copy-migrations.mjs` | 复制 `@node-rs/jieba` 与当前平台二进制到 `dist/node_modules` |
| `apps/desktop/package.json` | extraResources 增加 `@node-rs` 目录（随 gateway 一起进包） |
| `apps/gateway/package.json` | `engines.node` 收紧到 `>=22.16`（上游要求） |

**验收状态**：29 个测试全绿；`tsc --noEmit` 对新文件零错误。

---

## 4. 待办

| 阶段 | 内容 |
| --- | --- |
| P4 | 会话结束自动蒸馏（已落地，见 §7） |
| P4 | `pnpm install` 更新 lockfile（当前 `hippo-memory` / `@node-rs/jieba` 尚未写入 `pnpm-lock.yaml`，CI 的 `--frozen-lockfile` 会失败） |
| P3 遗留 | Windows 构建需在 Windows 上执行（`copy-migrations.mjs` 按 `process.platform` 选平台包，非目标平台会显式报错） |
| 后续 | 桌面管理面板 UI；画像/经验标签治理 |

## 5. 验收清单

- [x] 中文记忆写入后中文 query 命中
- [x] 英文与中英混合检索不回归
- [x] 检索键不泄漏到用户可见 tags
- [x] 记忆关闭时工具不注册、端点为空
- [x] Electron 运行时读写（Electron 40 / Node 24.15，`ELECTRON_RUN_AS_NODE=1`，从 `dist` 布局加载）
- [x] tsup 外置 `@node-rs/jieba`、内联 `hippo-memory`，产物 `require("node:sqlite")` 正常运行
- [x] `copy-migrations.mjs` 复制 `jieba` + 平台包（含 5MB `dict.txt`）到 `dist/node_modules/@node-rs`
- [ ] Windows 平台包（需在 Windows 上构建）
- [ ] 全程零出站网络（未启用 LLM 提取）

## 6. 放弃的选项

| 选项 | 原因 |
| --- | --- |
| claude-mem | npm 包只是云 SDK，插件体系绑定开发者本机，不可产品内嵌 |
| mem0 | npm 包是纯云 API 客户端（实测 dist 无本地引擎）；Python 核心依赖 qdrant/openai/posthog |
| agentmemory | 529 open issues，维护信号差，依赖 8 个外部包 |
| memorix | 依赖拖 react/ink 进 gateway |
| fork 上游改 tokenize | 转写镜像层等效且不动上游，升级无合并负担 |

---

## 7. 会话结束自动蒸馏（P4）

**触发**：`AgentService` 在 run 终态落到 `completed` 时回调 `memoryDistiller.distill(sessionId)`（`service.ts` 终态块）。失败/取消/中断不触发。

**管线**（`modules/memory/distill.ts`）：

```
会话消息（agentMessages 全量，role: content）
   │ 门槛：文本 ≥600 字 且 user 轮次 ≥2；同一会话 5 分钟内只跑一次
   ▼
main-lite（零工具、轻量模型）一次性调用
   │ 提示词要求：只输出 JSON 数组，≤3 条，每条 ≤60 字，标签限于 偏好/决策/经验/约束
   ▼
容错解析（剥代码块围栏 / 校验长度与标签 / 批内去重）
   │ 近似去重：与已有记忆互相包含则跳过
   ▼
MemoryService.remember（带 sourceSessionId 溯源）
```

**保护**：60s 超时；单会话最多 3 条；蒸馏器全程 try/catch，任何失败只写日志；记忆服务关闭时直接返回。

**配置**：无环境变量。阈值是 `MemoryDistiller` 构造参数默认值（`maxFacts/cooldownMs/minChars/minUserTurns`），需要调整时改默认值或接设置页。

**依赖**：需要配置 lite 档模型（`config.litePi`）。未配置时 `invokeAgent` 抛错 → 蒸馏降级为跳过，不影响对话。

**测试**：`tests/memory-distill.test.ts` 13 条（解析容错 5 条 + 管线行为 8 条）。

---

## 8. 定时整理回合（hippo `sleep`）

**调度**：`MemoryService.start()` 后延迟 5 分钟首跑，此后每 6 小时一次；定时器 `unref` 不阻塞退出；`stop()`（gateway `onClose`）清理。

**做什么**：衰减过期记忆（转 dormant 而非删除）、批量去重、相关情景合并成语义记忆、刷新冲突清单。由库内 `sleep()` 完成，本仓库只做调度与日志。

**零外呼保证**：hippo 的 `extraction.enabled` 默认是 `'auto'`——一旦环境有 `ANTHROPIC_API_KEY`，整理时会把记忆正文发给 Anthropic 做事实提取。`MemoryService.disableExtraction()` 在每次启动时把 `<root>/config.json` 的该键固化为 `false`（保留用户其它配置键），测试里用 fetch 探针锁定「整理全程零出站」。

**单租户设置**：调用 `sleep(ctx, { noShare: true })`，不向 `HIPPO_HOME` 全局库复制高分记忆。

**并发保护**：一轮未结束时再次触发直接丢弃（一次整理可能持续数秒）。

**阈值**：`maintenanceIntervalMs` / `maintenanceInitialDelayMs` 为构造参数默认值，无环境变量。

**测试**：`tests/memory-maintenance.test.ts` 7 条（配置固化、保留用户键、空库、dryRun、零外呼、关闭态、stop 后不再跑）。

**实测观察**：新库（3 条记忆）跑一轮整理返回 `active:3 removed:0 mergedEpisodic:0`——默认半衰期 365 天、且无跨会话情景簇，所以整理在早期本就是空转；它的价值在数周后衰减与冲突检测才显现。

---

## 9. 四项能力对照（2026-11-02）

| # | 要求 | 实现 | 触发/位置 |
| --- | --- | --- | --- |
| 1 | 会话结束 + 长会话空隙提炼（含坑→方案） | ✅ | run 终态 `completed` 即提炼（冷却 5 分钟）；空闲 10 分钟再补一次（`MemoryDistiller.noteActivity`）。提示词强制 `lesson` 类型输出「问题 → 解法」单句 |
| 2 | 定时整理用户画像 | ✅ | `MemoryProfileAggregator`：每日一次 + 新增偏好类事实达 8 条额外触发；产出覆盖式写入（`tags: [画像, 分组]`） |
| 3 | 长期记忆与经验分离 | ✅ | 同库分层：`fact` → hippo `semantic`，`lesson` → `episodic`；工具与接口均支持按 `category` 过滤 |
| 4 | 工作空间 vs 全局记忆 | ✅ | 工具/蒸馏从 `input.workspaceId` 取当前空间 → 写 `workspace:<id>`；检索默认「本空间 + 全局」，不传 workspaceId 时不过滤 |

**「会话结束」的落地口径**：本仓库没有独立的 session-close 事件，`run.completed` 就是一轮对话结束的等价信号；长会话中途的空隙由空闲计时器覆盖。若将来引入会话关闭语义，只需把回调挂到那个事件上。

**新增阈值（全部为构造参数，无环境变量）**：`idleMs=10min`、`cooldownMs=5min`、`maxFacts=3`、`growthThreshold=8`、画像 `intervalMs=24h`/`initialDelayMs=10min`/`maxGroups=5`。

**测试**：记忆相关 7 个套件 61 条（新增 `memory-scope-profile.test.ts` 覆盖作用域语义、分层过滤、画像聚合与阈值触发）。

---

## 10. 提炼单元：段 + 游标（2026-11-02 修正）

早先实现是「每次 run 结束都尝试提炼 + 5 分钟冷却」，有两个真问题：
①同一段早期对话被反复重新提炼（烧 token、结论不稳定）；
②冷却窗口内被挡掉的轮次，若在空闲计时器触发前关闭应用就**永久丢失**。

**修正为「话题段」模型**：

- **提炼单元 = 段**：从游标（上次提炼点）到当前的连续消息。
- **段关闭条件**（任一）：空闲 10 分钟 / 段内用户轮次 ≥8 / 段内字符 ≥12000 / 会话关闭或应用退出。
- **run 结束只登记**：不立刻调模型；段满即提炼，否则仅重置空闲计时器。
  两轮间隔很短 → 合并进同一段，只提炼一次（不再"忽略后一轮"）。
- **游标增量**：游标存 `gateway_metadata`（key `memory_distill_cursor:<sessionId>`），
  重启后继续；已提炼过的消息不会再次送模型。
- **失败不推进游标**：模型失败保留游标并累加 attempts（上限 3 次），下次重试；
  并发冲突（inflight）会挂回空闲计时器兜底，不丢内容。
- **退出 flush**：gateway `onClose` 调 `flushAll()`（总超时 15s），冲刷未提炼的会话段。

阈值全部是 `MemoryDistiller` 构造参数：`idleMs/maxTurnsPerSegment/maxCharsPerSegment/maxAttempts/maxFacts/minChars`，无环境变量。

---

## 11. 三个护栏 + 作用域归属（2026-11-02 补丁）

§9 的四项能力里，第 1 点有「删会话丢数据」、第 4 点有「全局层实际为空」的真问题；
本节是这一轮补的，全部落在 `modules/memory/`，无新增依赖、无新增服务。

### 11.1 作用域由模型判断（需求 4 真正可用）

- 提炼提示词新增 `scope` 字段：`global`=换个工作空间仍成立（用户本人的语言、沟通习惯、通用偏好），
  `workspace`=只在这个项目的资料与约定里成立；**拿不准一律选 workspace**（宁可局部，不污染全局）。
- 解析层只认字符串 `"global"`；缺失、拼错、其它值全部回落 `workspace`（`parseFacts`）。
- 写入：`scope=global` 不传 `workspaceId` → 落全局；`scope=workspace` 落 `workspace:<当前空间>`。
  由于 `AgentService` 的 run 上下文**恒有** workspaceId（缺省 `default`），此前所有提炼产物都被钉在空间里，
  全局层只剩画像条目——这是「全局记忆形同虚设」的根因，现在由模型显式判断解决。
- `memory_remember` 工具同步开放 `scope` 参数（默认 `workspace`），规则与提炼提示词一致。
- 去重范围跟着写入范围走：写空间时只看「本空间 + 全局」；写全局时只看全局条目，
  避免别的空间里已有的同义句把「提升为全局」挡掉。
- `MemoryHit` / `/v1/memory/entries` 增加 `scope`（`workspace:<id>` 或 `null`=全局），面板可区分两档。

### 11.2 经验格式硬校验（需求 3 的下限保障）

提示词要求 lesson 写成「问题/现象 → 解法」单句，但那是软约束。解析层加 `isLessonShaped`：
必须有箭头（`→` 或 `->`）、箭头两侧各有内容、解的部分不含句末标点；不满足**直接丢弃**。
（经验本来只是 0–3 条里的可选项，宁缺毋滥。）

### 11.3 删会话前抢救（需求 1 的断崖）

`agent_messages` 对 session 是 `onDelete: cascade`，此前 `deleteSession` 直接删，
未提炼的那一段跟着消息一起没了（只有退出应用时 `flushAll` 兜底）。现在：

1. `AgentService.deleteSession` 在**忙碌检查之后、删除之前**回调 `setMemorySessionCloser`；
2. `MemoryDistiller.captureBeforeDelete` 同步读出游标之后的段落（够 `minChars` 才抓），
   写到 `gateway_metadata`（key `memory_distill_captured:<sessionId>`），耗时微秒级，不阻塞删除；
3. 随后异步 `distillCaptured` 提炼，**成功才清掉**落盘记录；失败保留；
4. 启动时 `resumeCaptured()` 扫一遍残留记录重新提炼（删除后进程退出、模型失败都能补上）。

没有引入队列：单机单进程 + 本地 SQLite，落盘一条 `gateway_metadata` 就是等价物。

### 11.4 硬切段落带上文（避免坑/解法被切成两段）

只有**按轮数/字符硬切**时才带 `overlapTurns`（默认 2）轮上文，提示词用 `【上文（已提炼过，仅供理解上下文，不要重复提炼）】`
显式标注，游标仍只推进到本段真实末尾；空闲切段本来落在话题间隙，不带上文。

### 11.5 测试与遗留

- 记忆 7 个套件 **69 条**全绿（新增 7 条：作用域回落、lesson 格式、全局/空间落点、上文注入、抢救落盘、无内容不落盘、失败保留 + 启动恢复）。
- 仍未做：画像是纯展示、未注入系统提示词。
- `docs/memory-pipeline.html` 描述的是旧实现（5 分钟冷却 / 全量转写 / ≥600 字），以本文与源码为准。
  （本条已被 §12 优化：检索回流与经验分层已在那一轮补上。）

---

## 12. 检索回流 + 经验分层的收口（2026-11-02 第二轮）

### 12.1 检索回流（把「接进来但没接线」的那段接上）

hippo 本来就有强化通道，只是产品侧没调用：

| 通道 | 上游行为 | 现在谁调 |
| --- | --- | --- |
| `markRetrieved` | `retrieval_count+1`、刷新衰减锚点 `last_retrieved`、半衰期 `+RETRIEVAL_HALF_LIFE_GAIN_DAYS` | `memory_search` 每次命中（`HippoMemoryAdapter.markUsed`） |
| `applyOutcome(good=true)` | `outcome_positive+1`，`rewardFactor = 1 + REWARD_SLOPE*ratio`（温和加成） | 新增工具 `memory_feedback` |
| `applyOutcome(good=false)` | `outcome_negative+1`，强度按 `DECAY_BASE^min(netWrong, 3)` 逐级减半 | 同上（记忆与用户纠正冲突时） |

- 回流放在**工具层**而不是 `recall` 里：内部去重、画像聚合、UI 检索都不算「被用上」，否则会把无关条目一起强化。
- `memory_feedback` 单次 run 上限 6 条（计数表超 500 个 run 整表清空），防止模型刷分；
  未知 id 返回「没有找到这条记忆」而不是抛错。
- 提示词指引（`MEMORY_PROMPT_GUIDELINES` 第三条）：用上了标 `useful=true`；
  与用户当场纠正的事实冲突标 `useful=false` 并且不再按它办事；没用到不要标。

### 12.2 经验跨「整理合并」仍是经验（需求 3 收口）

实测确认这个坑是真的：库内两条相似经验跑一轮 `sleep()` 就输出
`mergedEpisodic: 2 / newSemantic: 1`，合并产物 `layer=semantic`、内容变成
`[Consolidated from N related memories…]` 摘要、**标签取 cluster 并集**。

修法（不跟引擎对着干，改成「身份靠标签」）：

- 写入：`category=lesson`（或标签里已含「经验」）时强制带上 `经验` 标签，层写 `episodic`；
  反过来只要标签含「经验」就按经验落层，保证标签与层一致。
- 读取：`categoryOf(entry)` = **标签优先、layer 兜底**；`recall/list` 的 `category` 过滤改用它，
  因此合并后的 semantic 条目仍然是 `lesson`。
- 接口与前端：`/v1/memory/entries` 新增 `category`（`fact|lesson`）与 `scope`；
  桌面「经验」栏改为按 `category` 过滤（此前按 `layer==='episodic'`，合并后的条目会在界面上凭空消失）。
- 可观测：`maintain()` 每轮记录 `lessonTaggedNotEpisodic`（被合并的经验条数），
  `HippoMemoryAdapter.categoryDrift()` 提供同一指标。

**已知残余**：合并后的经验是「多条摘要」而不是单句「问题 → 解法」；它仍可被检索、仍归类为经验，
但句式已不满足提炼时的形态要求。要保句式，只能让经验不参与合并（与上游策略冲突），暂不处理。

**测试**：记忆 8 套件 **82 条**全绿（新增 7 条：检索回流、反馈正负与未知 id、每 run 限额、
经验标签归一、合并产物归类、整理后分类不变、drift 统计）；gateway 与 desktop `tsc --noEmit` 均干净。

---

## 13. 经验的「无人工」闭环（2026-11-02 第三轮）

目标：经验从「自动挤出来的正确废话」变成「带出处的草稿 → 被复用验证 → 转正」，
**全程不需要用户点任何东西、也不需要用户开口要求记录**。

### 13.1 信任三档，先纠正一个默认值事故

上游 `createMemory` 的 `confidence` 默认是 `verified`，而 `verified` **豁免**「30 天没被检索就变 stale」的老化规则。
也就是说，此前所有自动提炼的一行摘要，一出生就被盖了「已核实、永不过期」的章——这是「快餐摘要污染长期记忆」的机制根源。

现在的落法：

| 来源 | confidence | 含义 |
| --- | --- | --- |
| 用户明确让记的（`memory_remember`） | `verified`（默认） | 可信 |
| 自动提炼的事实（偏好/决策/约束） | `observed` | 机器观察，会老化 |
| 自动提炼的经验（坑→解法） | `inferred` | 草稿，需被复用验证后转正 |

`MemoryHit` / `/v1/memory/entries` 均透出 `confidence`。

### 13.2 坑信号：来自 `agent_events`，不问人

`create-server` 在 run 结束时扫该 run 的 `agent_events`，统计两个数：

- `toolFailures`：`tool.failed` 事件数；
- `retriedAfterFailure`：同一工具失败后**又成功**的次数——这是「踩了坑并绕过去」最硬的证据。

两个数累加进当前段（`MemoryDistiller.noteRun(sessionId, workspaceId, signals)`），提炼时作为
「【本段客观信号】」块塞进提示词，模型据此优先把绕法写成 lesson；没有信号就不塞。
提示词同时加了反「正确废话」的硬要求：对话里出现过的人名/文件名/版本号/口径来源必须写进句子里，
判据是「另一个没参与过这次对话的助手读到它能不能直接照做」。

### 13.3 结算与转正：只在 run 跑完之后，按客观结果记分

`MemoryOutcomeTracker`（`modules/memory/outcomes.ts`）：

1. `memory_search` 命中时只**登记**「这次 run 读到了哪些条目」（不记分）；
2. run 结束时 `settle(runId, { failed })`：
   - 这轮**没有**工具失败 → 判定「用上了且没出事」→ 记一次隐性确认（`outcome_positive+1`）；
   - 这轮出过事 → **跳过**，既不确认也不否定（否定必须有归属，见下）；
3. 草稿（`inferred`）攒够 **2 次**确认 → 自动晋升 `verified`（此后不再 30 天老化）；
4. 追踪表有上限（每次 run 最多 20 条、最多 200 个 run），超了整表清空。

否定的归属问题：只有当事 agent 知道「是哪条记忆把我带偏的」，所以 `useful=false`
仍走 `memory_feedback` 工具（模型自己标，用户依然无感、无需操作）；代码只做「顺利即确认」这种无归属歧义的判定。

### 13.4 残余与已知缺口

- 合并后的经验仍是「多条摘要」，不是单句「问题 → 解法」（§12.2）；它保持经验身份但句式已变。
- 「顺利即确认」是保守近似：一次任务顺利不代表那条记忆真起了作用（可能只是没用上也没坏事）。
  门槛 2 次 + 老化的组合把它限制在「不被反复用上就掉档」的范围内。
- **中文检索缺口（本轮发现，未修）**：`cjk.ts` 的检索键依赖 jieba 分词结果，缺词表里的 2 字词
  （如「排期」「李明」）会被切成单字后按 `length > 1` 规则丢弃，导致这类查询 **0 命中且无任何提示**。
  这直接影响「经验能不能被后来的会话搜到」，建议下一轮补「连续单字合并成 bigram」的兜底键。

**测试**：记忆 9 个套件 **93 条**全绿（新增 11 条：信号进提示词、无信号不塞、同段累加、
草稿/观察两档置信度、结算确认、失败跳过、两次转正、未检索不结算、discard、已核实不重复晋升、检索登记）。


---

## 14. 「智能体页看不到用户画像」的根因与修复（2026-11-02）

现象：用户在对话里明确交代过自己的信息，记忆库里也有条目（`memory.remember` 日志可见），
但主页「智能体 → 用户画像」始终显示「还没有沉淀用户画像」。

四个断点，缺一不可：

1. **列表请求被网关判 400**：渲染层请求 `limit=100`，`/v1/memory/entries` 的 schema 上限是 50
   （适配层硬上限更低，只有 20）。前端 `.catch(() => null)` 把 400 吞成空数组，
   画像与经验两栏同时变空。→ 上限与适配层对齐到 200，前端降到 50。
2. **画像聚合从未成功过**：`memoryRuntime` 在启动时定型。桌面端要先过运行时配置 gate、
   SaaS 激活后才把档位 patch 进同一个 config 对象，启动那一刻档位为空 → `memoryRuntime = null`
   永久定型，日志 `memory.profile.failed: no model slot configured for memory`。
   → `createMemoryRuntimeResolver` 惰性解析：没解析到时每次调用重试（`runtime-factory.ts`）。
3. **标签口径三处不一致**：提炼白名单 `{偏好,决策,经验,约束}`、聚合来源 `{偏好,约束,决策}`、
   页面白名单 `{画像,偏好,约束,习惯,preference,profile,identity,constraint}`。
   `memory_remember` 不限制标签，模型实际写出 `身份/称呼`、`背景`、`职业/角色`、`生活`、
   `沟通偏好`、`简历/职业` —— 三处都不认，条目**既不在画像也不是经验，彻底隐形**。
   → 词表收敛到 `modules/memory/tags.ts`；展示侧用 `profileGroupOf` 归一，
   认不出的标签进「其他」，**任何一条 fact 都不会消失**。
4. **聚合产物不该是唯一来源**：模型档位未就绪时聚合永远为空。
   → 新增 `GET /v1/memory/profile`：聚合优先（`source: aggregate`），没有聚合产物时
   按标签把原始事实分组兜底（`source: fallback`），桌面端只负责渲染。

另外两处连带修正：

- `MAX_LIMIT 20 → 200`：`replaceStoredProfile` 清理旧画像时被 20 截断，记忆一多就删不掉旧版、
  攒出重复画像；聚合扫来源同理。
- 渲染层区分「读取失败」与「真的没有」：接口失败时显示「用户画像读取失败 + 重试」，
  不再伪装成空态（这正是最初被误判为「agent 没记住」的原因）。

**测试**：新增 `tests/memory-profile-view.test.ts`（7 条）+ `memory-routes.test.ts` 两条
（画像视图 / `limit=100` 不再 400）+ `memory-model-slot.test.ts` 两条（惰性解析）；
桌面 `workbench-home.test.tsx` 增加「画像接口失败 ≠ 空态」与 fact/lesson 分层 fixture。

---

## 15. 档位未就绪不再烧掉重试次数（2026-11-03）

**现象**：用户在一个会话里交代了大量个人信息（「我是李展萍」会话，12 轮），并且明确要求
「构建一下以我为核心的记忆，还有画像」。agent 当场用 `memory_remember` 写了 14 条全局事实，
但**会话提炼一次都没成功、画像一次都没生成**。

**现场证据**：

- `gateway_metadata` 的游标 `memory_distill_cursor:<session>` 是
  `{afterCreatedAt:null, afterId:null, attempts:3}` —— 一条都没提炼成功，重试次数已耗尽；
- 日志三连：`memory.distill.failed`（attempts 1→3，`error: no model slot configured for memory`）
  → 之后每次触发都是 `memory.distill.attempts-exceeded`；
- 画像聚合在事实写入后确实被 growth 阈值触发了，但同样以
  `memory.profile.failed: no model slot configured for memory` 收场，库里 0 条 `画像` 条目
  （页面只能走 `source: fallback` 的标签兜底）。

**根因不是「没触发」，而是「失败分类错了」**：档位未就绪（启动窗口期 / SaaS 未激活 /
中转令牌未下发）属于**环境没准备好**，却被记成了一次提炼失败，3 次机会就此烧光，
会话内容从此永久不再提炼。第 14 节的惰性解析只解决了「实例不用重启就能重建」，
没解决「失败要不要计数」。

**三处修正**：

1. **档位未就绪与调用失败分开**（`modules/memory/model-errors.ts` 新增
   `MemoryModelUnavailableError` + `isMemoryModelUnavailable`，`create-server` 抛这个类型）：
   提炼侧遇到它**不推进 attempts**、不推进游标，跳过原因记为 `model-unavailable`；
   抢救段（`distillCaptured`）遇到它**不清持久层**，下次 `resumeCaptured()` / 下轮继续；
   硬切段落后顺带挂回空闲计时器，档位就绪后自动补提炼，无需再发一条消息。
2. **画像聚合不再「失败即认账」**：`lastAggregatedCount` 只在真正写出一版画像之后推进
   （原来在调模型之前就推进了，失败后必须再攒满一整个 `growthThreshold` 才重试）。
   档位未就绪时返回 `skipped: "model-unavailable"` 并打 `memory.profile.model-unavailable`。
3. **档位签名变化即重建 runtime**：`createMemoryRuntimeResolver` 每次调用比对
   `provider/model/baseUrl/api/apiKey` 签名，换模型、换端点、SaaS 令牌轮换都会重建实例
   （旧实例 `dispose()`），档位被撤掉时返回 null，不再拿旧连接一直打失效端点
   （对应 2026-11-02 11:30 那条 `upstream error: do request failed` 的隐患）。

**仍存在的边界**（已知、未做）：已经被烧到 `attempts >= maxAttempts` 的历史游标不会自愈，
需要手工删 `gateway_metadata` 里对应 `memory_distill_cursor:<sessionId>` 行（2026-11-02
「我是李展萍」会话已按此处理）；若要更彻底，可给 `attempts-exceeded` 加低频退避重置。

**测试**：`memory-distill.test.ts` +2（档位未就绪不计数、抢救段保留重试）、
`memory-scope-profile.test.ts` +1（失败不推进阈值基准）、`memory-model-slot.test.ts` +2
（签名变化重建、档位撤掉回 null）；记忆相关 11 个套件 113 条全绿。

---

## 16. 画像的两种消费方式：标签卡片 + system prompt 注入（2026-11-03）

到这里画像才真正「有用」：之前它只是页面上一段可读的文字，模型本身并不知道。

**⓪ 页面外壳 = 原型代码直接搬过来**（`workbench/home/AgentPage.tsx`）

不再手写样式：`AgentView.tsx` 的页头（`PageHead` → `op-page-head`）、Hero（`op-agent-hero`
+ `op-agent-avatar` + `op-pill` + `op-ghost-btn`）、页内分段（`Seg` → `op-seg`/`op-seg-btn`）
和 `.op-info-card` 卡面**原样复制**，样式全部走已在 `main.tsx` 全局引入的 `office-proto.css`。
只做了两件事：

1. **接真实数据**：原型里的 mock（`persona` / `userProfile` / …）换成 `useAgentPersona()`
   的网关数据——人格（名称/简介/技能/提示词摘要）、用户画像（分组 + 条目）、经验（lesson 条目）；
2. **保留原型的 tab 语言**：原型的六个 tab 里，这页有数据源的是「人格 / 用户画像 / 经验」，
   知识卡片 / 会话记录 / MCP 工具 / Skills 各有自己的页面，不在这里重复造。
   另补两处工作台必需但原型没有的东西：读取失败态（`op-empty` + 就地重试，**失败 ≠ 空**）
   与 `op-seg` 的宽度复位（主页宿主把直接子元素拉成 100% 并居中，原型是 fit-content 左对齐）。

`PageHead` / `Seg` 的 JSX 是从 `office-proto/pages/parts.tsx` 复制的（parts 里 import 了原型
的 mock 文件数据，整包引入会把 mock 打进工作台 bundle）。宿主容器只剩 3 条声明：
`.wb-home-agent-host { padding-top: 30px; gap: 0 }`（原型靠组件 margin 控节奏）、
子元素 `max-width: 1120px`（原型版心）、`.op-seg` 的宽度/对齐复位。

**① 展示：原来的大卡片，卡片里放标签**（`workbench/home/AgentPage.tsx` + `home.css`）

- 布局是 `.wb-home-profile-grid` + `.wb-home-profile-card`：**每组一张大卡片**（分组名即卡片标题），
  卡片**内**每条画像是一个 chip 标签（`.wb-home-profile-tag`）。
- 卡片与标签的视觉**对齐原型**（`office-proto` 的「用户画像」页）：卡片照 `.op-info-card`
  （`--ui-radius-xl`、18px 内距、1px `--ui-border`、`--ui-surface` 底、标题 13.5px/620 + 10px 距），
  网格基线照 `.op-profile-grid`（`minmax(260px, 1fr)` + `--ui-space-3`），
  标签照 `.op-chip`（描边 + 白底 + pill + 4/11 内距 + 500 字重）。
  长标签自动换行不截断，`title` 挂全文。
- **卡片尺寸固定**：`auto-fill`（轨道等宽，不像 `auto-fit` 会折叠空轨道）+
  `grid-auto-rows: 208px`，卡片墙等高等宽；标签区 `flex:1 + overflow-y:auto`
  吃掉剩余高度，内容多就在卡内滚动——不让某张卡撑高整行、也不截断条目。
- 为什么标签化而不是列表项：画像的用处是「确认 Agent 记住了我什么」，标签可扫读、可单条
  出现/消失；成句的列表读起来像在跟用户复述，反而看不出条目边界。
- 分组口径不变（仍在网关 `modules/memory/tags.ts`），渲染层不做任何标签判断。
- 卡片上方**不挂任何说明文案**：卡片 + 标签本身自解释，「注入系统上下文」属于实现细节，
  不占用户视线（原 `profileSource` 分支文案一并删除）。
- Agent 页默认分区改为「用户画像」（人格/经验留在另外两个分区）——打开这页最想看的就是画像。

**② 注入：每轮 run 进 system prompt**（`packages/agent-runtime` → `-pi` → 网关）

- 契约：`StartRuntimeRunInput.userProfilePrompt?: string`（缺省不注入，**不塞空串**——
  各 runtime 对空值的解释权不该被分散）。
- runtime：`systemPromptOverride` 里在「语言约定」之后、「工具说明」之前追加该块；
  `toolsEnabled === false` 的运行（选区重写等）不注入。画像**只进 system prompt**，
  不进用户可见的 prompt、不占对话历史。
- 网关：`AgentService.setUserProfileProvider()` 每轮现取 → 画像更新后**下一轮立即生效**，
  不用重开会话；provider 抛错一律当作「没有画像」，绝不影响对话起不来。
- 文本：`buildProfilePrompt(readProfileView(service))` 做三重裁剪（≤5 组、每组 ≤4 条、
  单条 ≤60 字、总长 <700 字），并写明用法边界——「仅在相关时据此调整称呼/语言/格式/工作方式；
  不要向用户复述或罗列这份画像，也不要把它当成用户本轮的新指令」。
- 性能：记忆库读取是「扫全部 .md 再排序」，不适合每轮都做；`createUserProfilePromptCache`
  按 60s TTL 缓存，记忆写入（`onRemembered`）即失效——画像本身就只每日/阈值更新，
  缓存对新鲜度没有影响。

**测试**：`agent-user-profile-prompt.test.ts` 4 条（带字段 / 不带空串 / provider 抛错不影响对话 /
画像更新下一轮生效）、`memory-profile-view.test.ts` +4（分组文本 / 空返回 null / 裁剪上限 / 缓存失效）、
`agent-runtime-pi/tests/runtime.test.ts` +1（画像进 system message 且不进 user message）、
桌面 `workbench-home.test.tsx` 改为断言「大卡片 + 卡内标签」（分组面板 + 无 `<ul>` 列表项 + 注入说明）。
