# 业界 Coding Agent / Agent 框架「单次会话工具调用次数上限」调研

> 调研日期：2026-11-06。所有结论均附一手来源（官方文档、官方源码）。未能从一手来源证实的信息标注「未证实」。
> 注：本次调研环境的 web_search 工具不可用（缺 API key），全部改为直接抓取官方文档与源码（web_fetch / GitHub raw），来源可靠性不受影响。

## TL;DR（结论速览）

| 对象 | 是否有「工具调用次数」硬上限 | 默认值 | 达到上限时的行为 | 主要替代/配套护栏 |
| :- | :- | :- | :- | :- |
| Claude Code（CLI） | 无 per-session 工具调用上限；`--max-turns` 仅 print 模式可选 | 默认无限制 | print 模式命中 `--max-turns` 返回 `error_max_turns` 结果 | auto-compact（上下文自动压缩）、`--max-budget-usd`（成本上限）、订阅 plan 用量窗口 |
| Claude Agent SDK | `max_turns` / `max_budget_usd`，均默认**不限制** | 无限制 | 返回 `ResultMessage`，subtype 为 `error_max_turns` / `error_max_budget_usd`，无最终回答文本 | 同上（auto-compaction、subagent 隔离） |
| OpenAI Codex CLI | 无「每会话工具调用次数」上限；治理以 token 预算 + 上下文压缩为主 | — | 超出 rollout budget 时抛 `SessionBudgetExceeded` 错误（可配置是否 enforce） | `RolloutBudgetConfig`（加权 token 预算、软提醒+硬限制）、turn-end compaction（阈值百分比）、context window 超限报 `ContextWindowExceeded` |
| OpenAI Agents SDK | `max_turns`（按「模型调用轮次」计，非单个工具调用） | **10**（`DEFAULT_MAX_TURNS = 10`） | 抛 `MaxTurnsExceeded` 异常；可注册 error handler 把它转为正常 final_output（允许收尾）；传 `None` 关闭 | guardrails、`max_function_tool_concurrency`（并发限制，非次数） |
| LangGraph | `recursion_limit`（按 superstep 计，非工具调用） | **25** | 抛 `GraphRecursionError`，图执行中止（报错，非静默停止） | step_timeout（每步时间上限）、RetryPolicy、checkpointer 断点恢复 |
| Gemini CLI | 无工具调用次数上限；有可选的 `model.maxSessionTurns`（默认 -1 不限制） | `-1`（无限制） | 文档未明说达到 `maxSessionTurns` 时的行为（未证实；一般做法是停止接收新 turn） | `model.disableLoopDetection` 默认 false，即**默认开启无限循环检测/阻止**；`model.compressionThreshold`（默认 0.5，上下文压缩）；`general.maxAttempts`（API 请求重试上限 10） |
| Anthropic API（手写 agent loop 惯例） | API 本身无循环上限；官方示例代码用 `while` + 手动计数防爆 | cookbook 示例 `max_turns: int = 5` | 示例中达到上限直接退出循环、返回最后的 response（无专门「总结收尾」） | 官方推荐方向是 context compaction（`compact-2026-09-04` beta，服务端/runner 端压缩）而非次数上限 |
| Cursor Agent | **官方明确：任务期间工具调用次数无限制** | 无 | 不适用 | checkpoints 回滚、plan mode、（成本护栏未在文档中说明——未证实） |
| Windsurf | 未查到官方一手文档说明 | 未证实 | 未证实 | 未证实 |

## 逐项详述

### 1. Claude Code（CLI 与 Agent SDK）

**结论：Claude Code 没有每会话工具调用次数上限；限制方式是 turn 数（可选、默认无）、成本上限（可选、默认无）、上下文自动压缩（默认开启）、订阅用量窗口。**

- `--max-turns`：仅 print 模式（`-p`）可用，"Limit the number of agentic turns (print mode only). **No limit by default**"。turn 的定义是一次完整的 agentic 循环（模型输出+工具执行），不是单个工具调用。
- `--max-budget-usd`：同样仅 print 模式，达到预算即停止。行为细节：预算在模型响应返回后才结算，所以「花费可以超过 cap」，官方建议留 headroom；达到 cap 后再 spawn subagent 会失败（`Budget limit reached`），后台 subagent 会被停掉（需 v2.1.217+）。
- Agent SDK 侧（同一执行循环）：`max_turns` / `max_budget_usd` 默认均为 "No limit"。命中上限时 SDK 返回 `ResultMessage`，`subtype = error_max_turns` 或 `error_max_budget_usd`，此时**没有** `result` 最终文本字段（即不允许模型总结收尾，是「带错误码的停止」）。官方文档原话："Without limits, the loop runs until Claude finishes on its own … **Setting a budget is a good default for production agents.**"
- 上下文护栏：接近 context window 时 auto-compact 自动总结旧历史（`compact_boundary` 事件）；`/usage` 展示会话成本；订阅用户受 5 小时/每周滚动用量窗口约束（"You've hit your session limit"）。
- turn 计数口径：官方例子说明 `max_turns` 需把「带工具调用的 turn 数 + 1（最后一次纯文本回复）」都计入，否则会以 `error_max_turns` 结束且无最终回复。

来源：
- https://code.claude.com/docs/en/cli-reference.md（`--max-turns`、`--max-budget-usd` 条目）
- https://code.claude.com/docs/en/agent-sdk/agent-loop.md（Turns and budget、Result subtype 表、Budget headroom）
- https://code.claude.com/docs/en/costs.md（用量窗口、auto-compaction、错误释义）

### 2. OpenAI Codex CLI

**结论：Codex CLI 没有「每会话/每 run 工具调用次数」上限（源码与配置中均无该概念）；它的治理手段是 token 预算（rollout budget，加权计数、软提醒+可选硬限制）、turn-end 自动压缩、context window 硬错误。**

源码证据（openai/codex，main 分支，2026-11）：
- `codex-rs/core/src/rollout_budget.rs`：`RolloutBudget` 按 `output_tokens * sampling_token_weight + non_cached_input * prefill_token_weight` 加权累计；`record_usage()` 返回是否超限，**只有 `config.enforce_limit == true` 时才硬停**；另有 `pending_reminder` / `mark_budget_reminder_delivered` 机制（软提醒先注入对话，超阈值再提醒）。
- `codex-rs/core/src/agent/control/budget.rs`：超限时返回 `Err(CodexErr::SessionBudgetExceeded)`。
- `codex-rs/protocol/src/error.rs`：错误枚举含 `SessionBudgetExceeded`、`ContextWindowExceeded`、`UsageLimitExceeded`（账号级）、`RateLimitExceeded`——没有「tool call count exceeded」类错误。
- `codex-rs/core/src/config/mod.rs`：`model_post_turn_compact_threshold_percent`（可用上下文窗口的百分比阈值触发 turn-end compaction，0 表示禁用）——即用「压缩」而非「截断次数」续命。
- 配置文档（docs/config.md）只链接到 developers.openai.com 的 config reference（该站对本环境返回 403，未能直接核对全部键名——其中 `features.RolloutBudgetConfigToml` / `TokenBudgetConfigToml` 已由 `codex-rs/config/src/schema.rs` 证实存在）。
- 结论中「无工具调用次数上限」是**阴性证据**（在 11k+ 文件树中检索 turn/loop/limit 相关文件后未发现相关实现），置信度高但属推断。

来源：
- https://github.com/openai/codex（仓库）
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/rollout_budget.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control/budget.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/error.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs
- https://raw.githubusercontent.com/openai/codex/main/docs/config.md

### 3. OpenAI Agents SDK（原 Swarm）

**结论：`max_turns` 语义是「最大模型调用轮次」，默认 10；一个 turn = 一次 AI invocation（含该轮并发的若干工具调用），因此不是「工具调用次数」。达到上限抛 `MaxTurnsExceeded`；新版支持 error handler 拦截后给出正常 final_output（即允许收尾总结）；传 `None` 完全关闭。**

- 文档（Running agents → The agent loop）：
  - "If we exceed the `max_turns` passed, we raise a `MaxTurnsExceeded` exception. Pass `max_turns=None` to disable this turn limit."
  - turn 定义："A turn is defined as one AI invocation (including any tool calls that might occur)."
- 默认值（源码）：`src/agents/run_config.py` 中 `DEFAULT_MAX_TURNS = 10`；`Runner.run/run_sync/run_streamed` 签名均为 `max_turns: int | None = DEFAULT_MAX_TURNS`。
- 收尾行为（源码 `run.py`）：`current_turn > max_turns` 时构造 `MaxTurnsExceeded(f"Max turns ({max_turns}) exceeded")`；若配置了 `error_handlers` 的 `max_turns` 处理器且返回 handler_result，则用 `finalize_max_turns_handler_output(...)` 验证并合成 final output，返回**正常** `RunResult`（`result._current_turn = max_turns`），不再抛异常。无 handler 时直接 raise。
- 其它护栏：input/output guardrails（tripwire 抛异常）、`ToolExecutionConfig.max_function_tool_concurrency`（并发上限，非次数）。

来源：
- https://openai.github.io/openai-agents-python/running_agents/
- https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/run_config.py
- https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/run.py

### 4. LangGraph `recursion_limit`

**结论：默认 25；语义是图执行的 superstep（迭代步）上限，不是工具调用次数；达到上限抛 `GraphRecursionError`（报错中止，非静默停止，不给模型收尾机会）。**

- 语义（官方文档概念 + 源码）：LangGraph 是 Pregel/BSP 模型，每个 superstep 执行一批被触发的节点；`recursion_limit` 限制本次 invoke 的最大 superstep 数，用于防止图无限循环。计数对整个（子）图运行生效。
- 源码证据（`langgraph/pregel/_loop.py`，Sync/Async `__enter__` 均有）：`self.stop = self.step + self.config["recursion_limit"] + 1`——即从当前 step 起最多再走 `recursion_limit` 个 superstep；超限时 loop 状态置 `out_of_steps` 并抛 `GraphRecursionError`（`langgraph.errors`，pregel/main.py 导入）。
- 默认值 25：LangGraph 文档与错误信息长期标注 `recursion_limit` 默认 25（"Recursion limit of 25 reached…"）。本次直抓的 docs.langchain.com 页面 404/迁移，未能从当前文档页直接引用该数字的原文——**默认值 25 本身属公开常识但本次未拿到一手引用，标注：默认值一手引用未证实（源码中该默认由 langchain-core config 提供，不在本次抓取范围）**；语义与 `+1` 边界已由源码证实。
- 配套护栏：`step_timeout`（Pregel 构造参数，每步时间上限）、`RetryPolicy`、`interrupt_before/after`、checkpointer 支持 resume。

来源：
- https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/pregel/_loop.py
- https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/pregel/main.py
- （文档站已迁移：https://docs.langchain.com/oss/python/langgraph/overview ）

### 5. Gemini CLI

**结论：无工具调用次数上限；有可配置的 `model.maxSessionTurns`（默认 -1 无限制）；默认开启「无限循环检测」；上下文压缩阈值默认 0.5。**

官方配置文档（docs/reference/configuration.md，设置项逐条列出）：
- `model.maxSessionTurns`：默认 `-1`（unlimited）。描述为 "Maximum number of user/model/tool turns to keep in a session"——注意其措辞更像「保留多少 turn（历史管理）」而非硬停（达到上限时具体行为文档未写明——**未证实**）。
- `model.disableLoopDetection`：默认 `false`，即默认启用 automatic detection and prevention of infinite loops（重复/no-op 检测这一护栏是默认开启的）。
- `model.compressionThreshold`：默认 `0.5`，上下文使用率达到该比例触发压缩。
- `general.maxAttempts`：默认 10（对主模型的请求重试上限，上限不得超过 10）。
- `model.summarizeToolOutput`：工具输出摘要预算（如 `run_shell_command` 的 tokenBudget）——控上下文而非次数。
- CLI 参数中没有 `--max-turns` 类旗标。

来源：
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/index.md

### 6. Anthropic API 的 agent loop 惯例

**结论：Messages API 本身不提供循环/次数限制（循环完全由调用方实现）；官方 cookbook 示例用 `while` + 手动 max_turns 防爆（示例默认 5），超限即退出循环返回最后一帧，不做总结收尾；官方当前主推的「长任务护栏」是 context compaction（服务端 beta / runner 端手动阈值）而非次数上限。**

- 官方 cookbook `tool_use/customer_service_agent.ipynb`：`while response.stop_reason == "tool_use":` 纯条件循环，无次数上限（教学示例）。
- 官方 cookbook `tool_use/memory_demo/demo_helpers.py` 的 `run_conversation_loop(..., max_turns: int = 5)`：注释明确 "max_turns: Maximum number of turns to prevent infinite loops"；实现 `while turn <= max_turns:`，无工具调用则 break，达到上限自然退出并返回最后 response（无总结步骤）。
- 官方 cookbook `tool_use/automatic-context-compaction.ipynb`（2026 新）：演示 runner 驱动的 compaction——每 turn 比较 `usage.input_tokens` 与阈值（demo 用 5000），超过就 `runner.compact_before_next_turn()`；并指出服务端 compaction（`betas=["compact-2026-09-04"]`，`context_management` 配置，触发点 ≥50k tokens）"with no loop logic at all"。这代表 Anthropic 官方叙事：**用上下文工程延长 agent 寿命，而不是给 loop 设次数硬顶**。
- 平台文档页（agentic tool use / building agents）在当前网络环境被区域屏蔽（重定向到 app-unavailable-in-region），文档中 `max_iterations` 具体示例本次未能直接引用——标注「未证实（页面不可达）」；cookbook 证据可替代。
- Claude Agent SDK（同公司官方实现）的 `error_max_turns` 语义见第 1 节。

来源：
- https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/customer_service_agent.ipynb
- https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/memory_demo/demo_helpers.py
- https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/automatic-context-compaction.ipynb

### 7. Cursor / Windsurf

- **Cursor**：官方文档 Agent Overview 明确写道："**There is no limit on the number of tool calls Agent can make during a task.**" 这是少见的把「无工具调用上限」写成显式承诺的官方声明。配套护栏是 checkpoints（代码快照回滚）、plan mode 等；是否内部有成本熔断官方文档未说明（未证实）。
- **Windsurf**：本次未找到可引用的一手官方文档（docs.windsurf.com 相关页面未被本次调研覆盖），其 Cascade 是否有 step/tool 上限——**未证实**。

来源：
- https://cursor.com/docs/agent/overview

## 业界共识分析

### 上限是「必设的硬约束」还是「可选护栏」？

综合以上证据，业界**没有**把「单会话工具调用次数硬上限」当作必设约束，而是分层处理：

1. **终端用户产品（Claude Code、Codex CLI、Gemini CLI、Cursor）**：默认**不设**工具调用/turn 次数上限。它们面对的是交互式场景，用户随时可 Esc/Ctrl-C 中断，产品更倾向不误伤长任务。Claude Code 明确 `--max-turns`/`--max-budget-usd` 只在无人值守的 print 模式提供；Cursor 干脆声明无限制。
2. **SDK / 框架层（OpenAI Agents SDK、LangGraph）**：默认**设**一个宽松的次数护栏（10 / 25），且行为是「抛异常」的硬停。理由是框架无法预知业务，宁可误停可重试（LangGraph 有 checkpoint 可恢复），也不允许无限循环烧钱。Anthropic 的 Claude Agent SDK 反其道默认不限，但官方文档建议「生产环境设 budget 是好默认」——说明共识是**无人值守必须至少有一道护栏**（turn 或 budget 二选一）。
3. **计数口径**：几乎所有实现都以「模型调用轮次（turn/step）」为单位而不是「单个工具调用」——因为一轮可并发多个工具调用，按调用计数会误伤并行工具（OpenAI Agents SDK 文档明确 turn 含当轮全部工具调用；LangGraph 按 superstep；Claude 按 turn；Codex 干脆按 token 加权）。
4. **达到上限的行为光谱**：
   - 报错硬停（主流）：LangGraph `GraphRecursionError`、Agents SDK `MaxTurnsExceeded`（默认）、Claude `error_max_turns`（带结构化错误码，调用方可判断并 resume/加额重跑）。
   - 允许收尾（新趋势）：Agents SDK 的 max_turns error handler 可把超限转成正常 final_output；Anthropic cookbook 的做法是直接返回最后一帧。让模型「总结收尾」正在从反模式变成可配置选项。
   - 静默停止：未在任何主流框架中发现（无人采用）。
5. **更受青睐的替代护栏**（按出场频率）：
   - **上下文自动压缩**：Claude Code auto-compact（默认开）、Codex turn-end compaction（阈值百分比）、Gemini CLI compressionThreshold 0.5、Anthropic 服务端 compaction beta。这是2025-2026 的绝对主流方向——限制「内存寿命」而不是「步数」。
   - **成本/预算上限**：Claude `--max-budget-usd`、Codex rollout budget（加权 token，软提醒+硬 enforce）、订阅用量窗口。
   - **时间上限**：LangGraph `step_timeout`（每步）、Claude Code ultrareview `--timeout`（任务级 45 分钟默认）。整体 run 级 wall-clock 上限少见。
   - **no-op/重复检测**：Gemini CLI 默认开启 loop detection；Agents SDK 的 guardrails；Claude hooks 可拦截重复调用。
   - **token 加权预算**（Codex 独有视角）：把 prefill/sampling 分权计费，比次数更能逼近真实成本。

### 对本仓库（EverRoom agent）的可借鉴建议

- 若要加「单 run 工具调用上限」：以 **turn/轮次**（一次模型调用+本轮工具批次）为计数单位，而不是单个 tool call；默认值参考业界 10-25 区间；上限行为建议学 Agents SDK——默认结构化报错，同时提供 handler 钩子允许上层决定「收尾总结」还是「硬停」。
- 与其只设次数，不如同时上三件套：**上下文自动压缩阈值 + 成本预算（可软提醒可硬停，参考 Codex 的两段式）+ 重复/no-op 检测**。这是 Claude Code/Codex/Gemini CLI 共同演进出的形态。
- 交互式场景可以默认宽松（甚至不设），但**无人值守/headless 模式必须默认带护栏**（Claude Code 的做法：limit 旗标只存在于 print 模式）。

## 来源 URL 总表

1. Claude Code CLI Reference：https://code.claude.com/docs/en/cli-reference.md
2. Claude Agent SDK Agent Loop：https://code.claude.com/docs/en/agent-sdk/agent-loop.md
3. Claude Code 成本管理：https://code.claude.com/docs/en/costs.md
4. OpenAI Agents SDK Running Agents：https://openai.github.io/openai-agents-python/running_agents/
5. Agents SDK run_config.py（DEFAULT_MAX_TURNS=10）：https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/run_config.py
6. Agents SDK run.py（MaxTurnsExceeded 处理）：https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/run.py
7. Codex rollout_budget.rs：https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/rollout_budget.rs
8. Codex agent/control/budget.rs：https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control/budget.rs
9. Codex protocol error.rs：https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/error.rs
10. Codex config mod.rs（compaction 阈值）：https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs
11. Codex docs/config.md：https://raw.githubusercontent.com/openai/codex/main/docs/config.md
12. LangGraph pregel/_loop.py（stop = step + recursion_limit + 1）：https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/pregel/_loop.py
13. LangGraph pregel/main.py（GraphRecursionError）：https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/pregel/main.py
14. Gemini CLI 配置参考：https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md
15. Anthropic cookbook 客服 agent（while stop_reason == tool_use）：https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/customer_service_agent.ipynb
16. Anthropic cookbook memory demo（max_turns=5 防爆）：https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/memory_demo/demo_helpers.py
17. Anthropic cookbook 自动上下文压缩：https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/tool_use/automatic-context-compaction.ipynb
18. Cursor Agent Overview（无工具调用限制声明）：https://cursor.com/docs/agent/overview
