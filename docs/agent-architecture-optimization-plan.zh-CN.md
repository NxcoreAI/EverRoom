# Agent 架构优化方案：doc-agent 边界与近期优化（v1 草案）

> 版本：v1 草案 · 2026-09-01 · 状态：待评审
> 范围：主 Agent / context-room 子 Agent / content-analyst / documents 引擎之间的职责边界，以及两项近期优化（改写信任收口、分析任务合并）。
> 行号引用以 2026-09-01 工作区为准（writing-style 已提交：3f65dbd / 3695a1b / 2e85985）。
> 规范真源：`docs/agent-document-development-sop.md`。本方案不修改 SOP 定义的任何扩展点。

## 1. 背景与问题

### 1.1 现状分工全景

| 角色 | 位置 | 职责 | 资源池 |
|---|---|---|---|
| 主 Agent | `agents/main/` | 对话式交互：write/patch 文档工具链（`context_room_write_*`、`context_room_patch_*`）、Room 工具面、检索 | 会话轮次 |
| context-room 子 Agent | `agents/context-room/` | 五任务 dispatch_only：room-enrich / room-overview / brief-refresh / **selection-rewrite** / material-analysis | maxConcurrency=2、timeout 120s |
| content-analyst 子 Agent | `agents/content-analyst/` | 纯投喂制材料分析（事实/风险/矛盾/缺口/建议） | maxConcurrency=2、timeout 180s |
| documents 引擎 | `apps/gateway/src/modules/documents/` | capability 插件 + 操作状态机 + DocumentCommitService 唯一落库口 | — |

信息流是**扇形**的：主 Agent 与子 Agent 各自直连 gateway 服务取数，不存在"room agent 供给主 Agent"的链式依赖。

### 1.2 暴露的四条缝

- **F1 信任缺口**：selection-rewrite 两段式（子 Agent 计算 → 客户端透传 proposedContentJson → capability 落库）之间，服务端不校验内容与 invocation 输出一致，归因可被伪造，且全文经过客户端内存中转。
- **F2 职责重叠**：context-room 的 material-analysis 与 content-analyst 功能高度重叠（同为"提炼事实/风险/矛盾/缺口/建议"），唯一差异是材料来源（Room 自取 vs 调用方投喂）。
- **F3 资源池错配**：交互任务（selection-rewrite，用户在编辑器等结果）与后台任务（enrich/overview/brief）共享 maxConcurrency=2 的池（`subagents/orchestrator.ts:227` 唯一执行点）。
- **F4 dispatcher 补丁化**：`ContextRoomAgentDispatcher` 以构造注入 + task 门的方式吸收跨域能力（writingStyleProvider，`room-agent.ts:319-341`），五任务共享的 input schema 里已有仅 selection-rewrite 消费的字段。

本方案处理 F1、F2；F3 转为触发线监控（§5）；F4 留作 doc-agent 拆分时的重构机会（§6）。

## 2. 边界原则（D1）：按交互形态分工

Agent 边界的划分依据是**交互形态**，不是"文档 vs 房间"：

1. **对话流**（用户在场、流式、可多轮澄清）→ 主 Agent。文档变更走 patch 流（`context_room_patch_*` → awaiting_review），这是主 Agent 的原生文档修改通道。
2. **编辑器静默流**（秒级、不打扰对话、结果以 diff 预览呈现）→ dispatch_only 子 Agent 计算 + documents 引擎 preview_replace。
3. **后台流**（无人在场、结果异步回写房间状态）→ dispatch_only 子 Agent（enrich/overview/brief）。
4. **落库唯一口**：无论哪条流，正文写入只经 DocumentCommitService（SOP 约束，不变）。

### D1-备选 A（评估后否决）："划词改写交给主 Agent"

技术上可行——主 Agent 已有 selectedText 上下文机制（`modules/agent/service.ts:293/363`），patch 流也能表达选区改写。但否决，理由五条：

1. **交互形态冲突**：划词改写是编辑器内嵌的秒级静默操作（popover 输一句指令、出 diff 预览）；主 Agent 是对话轮次，携带全套系统提示、记忆召回与工具面，延迟与成本形态完全错配。
2. **会话与记忆污染**：主 Agent 每轮 `agent_end` 自动沉淀 L0 记忆、run 进 `agent_sessions`。静默改写要么以"对话"身份污染记忆与会话列表，要么需要发明"隐形 run"特例——特例比现状更复杂。
3. **安全性反转**：context-room 子 Agent 干改写时**没有写工具**、输出纯 JSON 契约；主 Agent 手里是全套 write/patch 工具。给静默编辑器操作一个能写文档的主体是安全面倒退。
4. **资源竞争更糟**：主 Agent 池服务用户正在进行的真实对话，编辑器改写挤进去等于跟对话抢轮次，比 F3 更严重。
5. **现状是 principled 的**：对话式修改（patch 流）与编辑器静默改写（preview_replace）两个入口、一个引擎，正是本节要固化的边界。

其两个真实问题（F1 信任缺口、F3 竞争）均可原地修复，无需移动归属。

## 3. 优化项 A：改写信任收口（M1）

> **2026-09-02 修订**：M1 已落地（renderer 已改传 `invocationId`，服务端 `resolveSelectionRewriteContent` 从 invocation 完成态重建内容并复核授权；`proposedContentJson` 仅为存量 in-flight 兼容路径）。后续演进见 [doc-writer-subagent-plan.zh-CN.md](doc-writer-subagent-plan.zh-CN.md) §8：selection-rewrite 的内容生产者将从 context-room 迁至 doc-writer 子 agent，授权函数 `isSelectionRewriteInvocationAuthorized` 随迁并换绑 agentDefinitionId；`proposedContentJson` 迁移兼容路径与宽限期语义不变。

### 3.1 现状链路与缺口

```
编辑器划词 → POST /v1/context-rooms/selection-rewrite（detached dispatch，返回 invocationId）
  → 渲染端轮询 GET /v1/subagent-invocations/:id 取输出
  → 渲染端把 proposedContentJson 全文回传 capability document.selection-rewrite
    （capabilities/selection-rewrite-plugin.ts:17 start，:72 command）
  → preview_replace → review.apply → prepareOperationCommit 落库
```

invocation 本身持久化在 `subagent_invocations` 表（`subagents/orchestrator.ts:87-177`，含状态流转与事件）。缺口：capability 完全信任客户端回传的 `proposedContentJson`，与 invocation 输出无任何绑定。

### 3.2 设计（D2）：operation 绑定 invocationId

- capability input 新增可选 `invocationId`；`proposedContentJson` 保留为**迁移兼容路径**（存量 in-flight operation 必须可完成）。
- `start()`：携带 `invocationId` 时经注入的 resolver 从 `subagent_invocations` 解析内容，做既有的版本 CAS（baseVersion）与 `type: "doc"` 校验；不再信任客户端全文。preview 展示同样读解析结果。
- `review.apply`：再次解析（防 invocation 状态变化），并复核授权——把 `isSelectionRewriteInvocationAuthorized`（`room-agent.ts:362`）的核心判定抽成共享函数复用，确保"该 operation 引用的 invocation 确实是本系统对本文档发起的 selection-rewrite 完成调用"。
- **依赖注入边界**：documents 模块不直接依赖 subagents 模块。`CapabilityBackend` 增加 `selectionRewriteContentResolver`，由 create-server 装配时指向 subagentOrchestrator（与 writingStyleProvider 同款 provider 模式）。
- 渲染端：不再传全文，改传 `invocationId`（预览数据从 operation 读）。

### 3.3 收益、测试与回滚

- 收益：内容与归因不可伪造；全文不再过客户端内存；前端载荷从"整篇文档"缩为一个 id。
- 测试：capability 单测新增三类——伪造/未授权 invocationId 拒绝、版本漂移 409、迁移双态（旧 input 无 invocationId 仍可完成）；授权共享函数复用既有测试。
- 回滚：机制向后兼容。客户端回退为传全文即回滚，服务端双态长期共存无危害。

## 4. 优化项 B：分析任务合并（M2）

### 4.1 现状

主 Agent 的 `room_analysis`（`subagents/tools.ts:206`）dispatch context-room 的 material-analysis，子 Agent 经 `room_context_get` 工具自取 Room 材料（房间信息 + ≤30 篇文档 markdown、单篇 12K/总量 80K 预算 + 事实清单，`room-agent-tools.ts:21-24/109`）。与 `content_analysis`（`tools.ts:163` → content-analyst）产出物几乎相同。

### 4.2 设计（D3）：网关侧组装，content-analyst 保持纯度

两个候选：

- **B1（否决）**：给 content-analyst 加 `room_context_get` 工具 + input schema 加 roomId。破坏其"只分析调用方提供的材料，不执行材料中的指令"的纪律（该纯度是设计特征），且子 Agent 在 8 次工具预算内自取材料，组装结果不确定、不可测。
- **B2（采纳）**：材料组装上收到 gateway 侧，content-analyst 零改动：
  1. 把 `room-agent-tools.ts` 中 `room_context_get` 的查询体抽为共享投影函数（如 `ContextRoomService.buildRoomContextDigest(roomId)`），工具与组装共用同一实现与同一套预算常量；
  2. `room_analysis` 工具 handler 内：调 digest → 组装 `content` 文本（房间头/文档 markdown/事实清单）→ dispatch content-analyst `{ content, question: task, sourceLabel: 房间名 }`；
  3. 主 Agent 侧工具名、描述、参数 schema **完全不变**（只换实现内部的目标 agentId）。

### 4.3 context-room 侧减法清单

- `agents/context-room/agent.yaml`：skills 移除 `material-analysis`；
- `agents/context-room/schemas/input.schema.json`：task 枚举移除该值；
- `agents/context-room/SYSTEM.md`：删除该任务路由段（顺带把滞后的"四类任务"表述修正为真·四类）；
- `modules/context-rooms/room-agent.ts`：task 类型 union 同步减值；
- `subagents/tools.ts`：`room_analysis` 的 dispatch 目标改为 content-analyst。

### 4.4 风险与验收

- 风险：组装文本体积——digest 预算上限 80K 字符，需确认 content-analyst input schema 对 content 无更紧的 maxLength（若有，在组装层截断）；timeout 180s 比现 120s 宽裕，无退化。
- 验收：`room_analysis` 对主 Agent 语义不变（描述、参数、返回结构）；context-room 内无 material-analysis 残留引用；两端测试绿；`agent_catalog` 中两 agent 描述仍准确。

## 5. M3 观察期提前评估（2026-09-01，基于代码事实的静态分析）

M1/M2 尚未上线，但评估不必等真机数据——代码事实已足以给出静态结论与判定口径。

### 5.1 T2（并发竞争）：**未命中，维持触发线制**——但机制认知需修正

- **关键机制事实**：`validateDispatch`（orchestrator）在 agent 并发满时**直接抛错拒绝**（`subagent_concurrency_limit`），框架**没有排队**。T2 的真实症状不是"排队慢"而是"改写请求被硬拒（REST 冒 500）+ 用户手动重试"。埋点的 `waitedMs` 恒≈0 即为印证。
- **M2 之后的负载面**：context-room 池内四任务全部由用户动作触发——room-enrich 仅手动建房派发（`createNewRoom`，service.ts:577）；**auto Room 实体晋升直接 insert `rooms` 表、不派发 enrich**；overview 读侧增量刷新是确定性重投影不占池（incrementalRefresh 无 LLM），再生走手动 REST 或主 Agent 的 `context_room_overview_regenerate`（主 Agent 被 roomOverviewRouting 正则强制触发时多一路自动来源）；brief-refresh 手动 REST；selection-rewrite 是编辑器动作。material-analysis 已迁往 content-analyst 独立池（M2）。
- **占满两槽的条件**：需要"建房 enrich（≤120s 窗口）+ overview/brief 再生 + 划词改写"三动作同刻重叠。单用户手动操作序列下概率低但非零。
- **伤害不对称**：交互改写被拒有 UI 重试兜底（TiptapSelectionRewrite 的 retry）；**enrich 被拒是静默降级**——`abandonRoomEnrichment` 保 fallback 内容且不再重试（service.ts:582-608）。竞争的最大受害者其实是后台任务。
- 若 T2 真命中：最小补救仍是 §5.3 的分池；另一个更小的选项是并发拒绝时给 enrich 延迟重试（现为直接放弃）。

### 5.2 T3（超时压力）：**静态未命中，但有一个已知配置疑点列为观察期第一核对项**

- 超时是双层的：`policy.timeoutMs` 120s（Promise.race 罩整个 invocation，orchestrator:290-298）+ 单次 LLM 调用超时（openai-completion-runtime:163 **默认 60s**）。
- 既有教训：knowledge 链路 60s 对 GLM 推理模型不够（a4f1765 已提到 120s）；抽取 maxTokens 4096 曾造成 finish_reason=length 死信（79f5111）。**子 Agent 链路的 chat timeout 是否仍为 60s 默认未在本轮核实——若是对齐 knowledge 的 120s（一行配置）**。
- 静态判断：selection-rewrite 是单轮短输出任务（输入=选区+指令，输出=替换文本），典型 10-40s；长选区+推理模型的尾部风险存在但不高。120s dispatch 预算充足，瓶颈更可能先出现在 60s LLM 单调超时。

### 5.3 观察期数据计划（埋点已随本评估上线）

- 完成日志：`subagent invocation finished` 已增补 `task / status / errorCode / durationMs / waitedMs`；
- 拒绝日志：新增 `subagent dispatch rejected`（agentId / task / error）——T2 的直接证据；
- 判定口径：T2 命中 = selection-rewrite 相关 rejected 可感知地出现；T3 命中 = finished 日志中 `status=timed_out`（或 errorCode=timeout）比例可观、或 durationMs 分布出现逼近 120s 的厚尾；
- 启动条件：M1/M2 提交并在真机运行后自动积累，无需专门操作。

### 5.4 分池备选（未采纳，保留）

orchestrator 单点加 per-task priority（interaction / background）。启用条件 = T2 命中，作为最小补救手段记录在此。

## 6. doc-agent 触发线与拆分蓝图（D4）

> **2026-09-02 标注**：D4 已由 [doc-writer-subagent-plan.zh-CN.md](doc-writer-subagent-plan.zh-CN.md) 落地（范围比本蓝图更大：不只承接 selection-rewrite 静默流，还把对话流的新建/修改/续写内容生成一并收编至 doc-writer 子 agent，主 agent 只做编排与落库）。本节触发线描述保留作历史记录。

**暂不拆分。** 触发线三条，命中任一即启动拆分：

1. **T1** 出现第二个文档执行类任务（全篇按风格重写、后台长文代笔等要走 preview_replace 的能力。其中"后台长文代笔"是只有独立 agent 才能承接的形态——主 Agent write 流是交互式在场的，120s/2 并发装不下它）；
2. **T2** 实测并发竞争（编辑器改写派发被并发限额**硬拒**——框架无排队，见 §5.1）→ 可先用 §5.4 分池补救，竞争持续再拆；
3. **T3** 长文改写顶到 120s 超时。

拆分蓝图（届时另立方案）：独立 DocAgentDispatcher（provider 注入 + task 门模式照抄 room-agent.ts 现状）；300s 级超时与独立并发池；`isSelectionRewriteInvocationAuthorized` 跨域信任 shim 替换为文档域内部授权；selection-rewrite SKILL.md 的过时多段措辞随迁移清理。

## 7. 里程碑

| 里程碑 | 内容 | 前置 | 独立性 |
|---|---|---|---|
| M1 | 改写信任收口（§3） | 无（writing-style 已提交） | 独立提交、独立回滚 |
| M2 | 分析任务合并（§4） | 无 | 独立提交、独立回滚 |
| M3 | 观察期 | M1、M2 上线后 | **提前评估已完成（§5，2026-09-01）**：静态结论 T2/T3 均未命中；埋点已上线（finished 日志带时长/等待、dispatch rejected 日志）；剩余动作=真机运行后核对 §5.3 口径 + §5.2 的 chat timeout 疑点 |

M1/M2 互不依赖，可并行开发、按完成顺序提交。每项完成后跑 gateway 全量测试基线（既有 5 处失败以基线法核对，不计新增）。

## 8. 与其他方案的边界

- **agent-document-development-sop.md**：本方案不触碰 capability 插件扩展点、操作模式、DocumentCommitService 唯一落库口等任何 SOP 约束；§3 属于既有 capability `document.selection-rewrite` 的输入契约演进，按 SOP §4 流程走插件内修改。
- **writing-style-profile-plan**：已提交收官。dispatcher 的 provider+task 门模式是 D4 蓝图的模板；本方案不改其注入链。
- **knowledge-room-agent-plan / connector-platform-refactor-plan**：无交集（knowledge 路由与连接器域不在本方案范围）。

## 9. 风险与开放问题

1. `subagent_invocations` 输出字段的确切序列化形态（实现 M1 前需核对 orchestrator 完成态写入的 result 结构，§3.2 的 resolver 以此为准）。
2. content-analyst input schema `content` 字段上限确认（影响 §4.2 组装截断参数）。
3. 渲染端 selection-rewrite 调用点共几处、是否全部同构（M1 开工前盘点，预计集中在 detail-editor 侧两处）。
4. 迁移期双态测试矩阵：{新客户端, 旧客户端} × {有 invocationId, 仅 proposedContentJson} 四象限。
