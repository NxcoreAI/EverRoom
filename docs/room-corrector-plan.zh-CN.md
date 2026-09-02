# Room 总览纠正子 agent（room-corrector）与 context_get 瘦身

> 状态：已实现（2026-09-02，随 doc-writer 方案收官后的同域延伸，待真机验证）
> 关联：[doc-writer-subagent-plan.zh-CN.md](doc-writer-subagent-plan.zh-CN.md)（同款"编排与计算分离"模式）、[agent-architecture-optimization-plan.zh-CN.md](agent-architecture-optimization-plan.zh-CN.md)（§2 D1 交互形态分工）
> 决策：用户拍板两步都做——①context_get 瘦身（立即）②纠正计算外移 room-corrector 子 agent。

## 1. 背景与拆解

"选区纠正澄清的 agent"实为三件事：**澄清**（pendingIntent picker，无内容计算，不外移）、**引用纠正**（选区+评论→逐 claim edits）、**模糊纠正**（"把简介改成…"→单条 proposal）。后两者的"核心执行"（读 claims 快照 + 计算 edits/proposal，其中 replacementText 是内容生成）原先全部由主 agent 承担，痛点与 doc-writer 解决的同形：`context_room_context_get` 返回总览全量 + **全部已应用纠正历史（只增不减）**进主 agent 上下文，纠正前后还要核对两遍；SYSTEM.md 第 6 条 ~700 字的密集纠正规则每轮对话都背着。

## 2. 第一步：context_get 瘦身（context-rooms/overview-agent-tools.ts）

`appliedCorrections` 由全量改为**最近 20 条 + `appliedCorrectionCount` 历史总数**（service.list 按 createdAt 升序，`slice(-20)` 取最新）；纠错溯源全量仍可经 REST 查询。此步独立于第 2 步生效。

## 3. 第二步：room-corrector 子 agent

### Bundle（`agents/room-corrector/`，目录即注册）

- dispatch_only、allowedCallers `[primary-agent]`（纠正只发生在对话流）、**独立池** 2 并发/120s（短结构化任务；不与 context-room 的 enrich/overview/brief 后台池、doc-writer 的 600s 长文池混用——规避架构方案 F3/T2 的交互-后台竞争）。
- input：task（citation-correction / general-correction）+ instruction + selectedText + **claims 快照（网关组装，≤400 条，含 claimId/section/text≤1000/origin/corrected/evidence≤3）**；无 writingStyle（总览语音是系统合成声，非用户写作风格）。
- output（anyOf 按 kind）：edits[]（逐字段镜像 `context_room_correction_apply_citation` 的 CitationEdit 契约）/ proposal（镜像 propose 契约）+ summary。
- SKILL 迁入原 SYSTEM.md 第 6 条的全部纠正纪律（originalText 逐字、每 claim 独立 edit、跨 claim 合并 suppress、不摊平字段等）。

### 主 agent 工具 `room_correction_draft`（subagents/tools.ts，document_draft 先例）

参数 {task, instruction, roomId?, selectedText?}；网关侧经注入的 `resolveRoomCorrectionContext` 读总览投影组装 claims（section 映射 nextSteps→next_steps）；dispatch 同步等终态；返回 {edits | proposal, summary}——主 agent **逐字转发**给 `correction_apply_citation`（引用流，同轮原子应用）或 `correction_propose`（模糊流，用户明确请求的同轮 apply）。失败语义与 document_draft 一致（并发拒绝→retryable 结构化错误）。配套 `registerAgentResultValidator("room-corrector")`：edits 的 targetClaimId 必须 ∈ 组装的 claims 快照（服务端 applyCitations 另有 targetClaimId 唯一命中 + originalText 包含于 claim 文本的强校验，伪造不可达）。

### 提示词改写

- main SYSTEM.md 第 6 条：大段编辑规则替换为"room_correction_draft → 逐字转发 apply"的编排纪律；context_get 明确定位为"回答 Room 问题与查 pending 提案，纠正计算不需要先调用"。
- agent/service.ts runtimePrompt 的 `roomCitationRouting` 注入段同步改写（选区含引用标记时的当轮指引）。
- main agent.yaml tools += room_correction_draft。

## 4. 边界与不做的事

- 澄清流（pendingIntent）不动；`context_room_correction_propose/apply/apply_citation/revoke` 工具契约不动（主 agent 仍是落库执行者，服务端校验链原样）。
- 不做 M3 式 invocationId 引用透传：edits/proposal 是小体量结构化数据，直接回传即终态。
- 总览**重新生成**（regenerate）不在此列——那是后台重投影流（context-room 的 room-overview task），交互形态不同。

## 5. 验证

- 测试：room_correction_draft 组装/透传/失败语义（subagent-tools.test.ts）、context_get 瘦身断言（context-room-overview-agent-tools.test.ts，含 bundle 工具清单与新 SYSTEM 文案断言）；gateway 全量对基线零新增。
- 真机验证项：重启网关后走一遍引用纠正（总览选区+评论）与模糊纠正，确认主 agent 不再调 context_get 核对、一次 draft 后逐字 apply。
