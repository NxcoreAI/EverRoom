# 主 Agent「自主规划任务」提示词优化方案

参考 DeepSeek Harness（DSH）的系统提示词，优化 `agents/main/SYSTEM.md` 中与任务规划相关的文案。本方案只动提示词，不改代码；所有新增指令都只引用现有的 `plan_*` 工具能力。

## 一、DSH 里值得借鉴的机制

从 DSH 安装包（`@deepseek-ai/*` 内部包）提取的提示词原文，按与「自主规划任务」的相关度归纳：

| DSH 机制 | 出处 | 核心语义 |
| --- | --- | --- |
| todo_write 工具 | `dsh-tool-todo` | "Add one todo per concrete step before you start. While work remains, keep the todos being worked on `in_progress`... Mark each todo `completed` as soon as it is done. skip it for trivial single-step tasks"——动手前每个具体步骤一条，完成即勾，琐事跳过 |
| create_goal 工具 | `dsh-tool-goal` | "Use it when the direct human request is a long-running objective, **even if the user did not say 'goal'**"——自主性关键句：目标意图由你推断，不要求用户说出口 |
| goal 政策段 | `dsh-tool-goal` guidance | "Mark complete **only when the objective is actually achieved**. Mark blocked only after the same blocking condition persists for at least 3 consecutive rounds... **difficulty, uncertainty, or useful remaining work is not blocked**"——完成与阻塞的严格定义 |
| goal round 续跑提示 | `dsh-goal-round-driver` | "Treat the current workspace, tool results, and durable session state as authoritative; **inspect them instead of assuming earlier narration is still current**. Make concrete progress and **verify the result**. Before claiming completion, **gather evidence** that the whole objective is achieved"——多轮执行时的现实锚定与证据标准 |
| 完成收尾提示 | `dsh-tool-goal` wrapup | "state the outcome, summarize **what was done and how it was verified**, and point to the concrete results... **Report only what earlier rounds and tool results actually establish**"——收尾报告只陈述会话里真实建立的事实 |
| ralph 工人提示 | `dsh-tool-ralph` | "complete only with **concrete evidence**; blocked only when **no meaningful progress is possible without human input or an external-state change**"——结构化完成/阻塞判据 |
| plan-mode / exit_plan_mode | `dsh-plan-mode` | 大计划先呈报用户审批，批准后才执行；被驳回就改了再报 |

现有 SYSTEM.md「计划与认领」一节是**被动找活儿**视角（用户提到任务 → 查 → 认领 → 干 → 收尾），缺四样东西：

1. 认领后的**步骤拆解**习惯（DSH todo_write 语义）；
2. **自主建任务**的许可（现在只允许用户明说「记到计划里」，DSH 允许从请求推断）；
3. **完成/阻塞的证据标准**（现在只说"做完改 done"，没说什么算做完、什么算做不下去）；
4. **续接工作时的现实锚定**（别把自己或前人上一轮的叙述当事实）。

## 二、替换文案：SYSTEM.md「计划与认领」章节

以下整节替换现有的 `## 计划与认领`（含其下 6 条编号），风格与现有文件保持一致：

```markdown
## 计划与认领

工作空间「计划」是用户和你的共同待办池：一条任务有标题、背景、验收标准、硬约束、材料引用、优先级和截止时间。任务不等于会话——会话是执行载体，任务可以没有会话，会话也可以不属于任何任务。

### 认领与执行

1. 找活儿：用户提到计划里的某件事，先 `plan_list`（可带 status/owner/q），拿到 id 再 `plan_get`。不要凭对话记忆复述任务内容。
2. 读包：`plan_get` / `plan_claim` 返回的认领包就是全部必要上下文。三个字段最要紧——`detail`（背景）、`acceptance`（怎么算完成）、`constraints`（不能违反什么）；材料只给引用，正文用 `file_read` / `document_read` 自己取，不要假设已经读过。history 里有前人 release 的原因时，先弄清上次卡在哪，别原样再卡一次。
3. 拆解：认领后、动手前，把任务拆成具体步骤，用 `plan_update` 的 checklist 写整份清单：一步写一条、每条独立可勾。一步能做完的小事不用拆。执行中保持清单同步——开始一步标记，做完一步勾掉；发现拆错了就改清单，不要将错就错。
4. 认领：`plan_claim` 拿 10 分钟租约并进入「进行中」，之后本会话的读写会自动续租。一次运行最多认领 3 条；串行做，做完一条再认下一条，不要并行摊薄质量。
5. 完成：验收标准全部满足、且交付物可复查，才把状态改成 done。标 done 前逐条对照 `acceptance` 核对，确认结果真实存在——文件确实生成、内容确实改到位；「工具调用成功返回」不等于「任务完成」。`resultSummary` 写三件事：交付了什么、怎么验证的、还剩哪些已知缺口。
6. 放回：只有缺用户输入、权限或外部资源、且没有替代路线时才 `plan_release`。困难、检索没命中、步骤多，都不是放回的理由——先换关键词、换工具路线、把能做的做掉。真放回时写清楚：卡在哪个具体条件、已经试过什么、接下来需要什么。
7. 边界：不能改别人租约内的任务（会返回 plan_claimed_elsewhere），不能跨空间认领，不能让任务依赖成环。

### 自主建任务

8. 用户明确说「记到计划里」时建任务。用户交代的是明显跨多步、多轮或要跟踪结果的目标——即使没提「计划」两个字——也主动拆成任务组：每条独立可验收，写清 detail / acceptance / refs，用依赖（blockedBy）排好先后，从无依赖的那条开始做。一次运行最多 10 条。拆解影响面大或方向拿不准时，先把任务组和先后顺序摆给用户确认，再认领开工；方向明确的就直接开始。
9. 一次性问答、单文档的即时修改，不要建任务。
10. 续接自己或别人之前的工作，先查现状再动手：`plan_get` 看 history 与验收标准，`file_read` 看材料当前内容。任务记录和上一轮的叙述只是线索，工具此刻返回的状态才是事实——上一轮说「已改好」不等于现在还是改好的。
```

## 三、逐条改动对照

| 新条款 | DSH 出处 | 解决的问题 |
| --- | --- | --- |
| 3 拆解 | todo_write："Add one todo per concrete step before you start... skip it for trivial single-step tasks... Mark each todo completed as soon as it is done" | 认领后直接开干、无显式规划动作；checklist 落到 plan_update 已有能力上 |
| 5 完成 | create_goal："Mark complete only when the objective is actually achieved"；goal round："Before claiming completion, gather evidence"；ralph："complete only with concrete evidence" | 把「做完」从"工具调用成功"提升为"验收逐条满足 + 交付物可复查"；resultSummary 从两件事扩为三件事（含"怎么验证的"），出自 goal wrapup 的 "how it was verified" |
| 6 放回 | goal 政策："Mark blocked only after the same blocking condition persists... difficulty, uncertainty, or useful remaining work is not blocked"；ralph："blocked only when no meaningful progress is possible without human input or an external-state change" | 防止一遇困难就 release；给出放回的准入条件与 reason 的最低内容（卡在哪/试过什么/需要什么） |
| 8 自主建任务 | create_goal："even if the user did not say 'goal'"；plan-mode 的审批思想（大计划先呈报） | 从"用户明说才建"放开为"从请求推断也可建"，这是「自主规划」的核心一步；影响面大时先确认，避免自主变冒进 |
| 10 现实锚定 | goal round："Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current" | 多会话/续接场景下防止把历史叙述当现状 |
| 2 末句（history） | （DSH 无对应，认领包 history 是本项目特有） | release reason 进认领包的机制已在代码里，但旧文案没让下一位认领者利用它 |

## 四、暂缓项：需要运行机制配合、提示词单独做不到的

以下 DSH 能力依赖运行时机制，等机制落地后再补提示词，现在写进 SYSTEM.md 只会产生引用不存在工具的空指令：

1. **跨轮自动续跑**（DSH goal round driver）：goal 处于 active 时由驱动器自动注入下一轮提示，提示词固定为「继续朝目标推进；工作区与工具结果是权威；宣称完成前先收集证据」。EverRoom 的 plan 租约只覆盖单会话，需要先有"任务驱动的新会话/续轮"机制。
2. **完成/阻塞的收尾注入**（DSH wrapup context）：标记 complete/blocked 后由工具注入一段"现在写给用户的收尾信息：结果、验证方式、待办"上下文。EverRoom 可以在 plan_update(status=done) 的返回内容里做轻量版，不必改 SYSTEM.md。
3. **轮次上限与解除武装**（maxGoalRounds / disarm）：防自主循环失控的硬闸门，属于服务端策略，提示词只能复述不能执行。
4. **阻塞 N 轮准入**（blockedAfterConsecutiveRounds）：DSH 在工具层拒绝过早的 blocked。EverRoom 的 plan_release 可以加同款服务端校验（同一任务连续 N 次 release 才允许带"外部阻塞"类原因），提示词第 6 条已经按这个语义写，机制跟上后刚好对齐。

## 五、验证建议

文案合入后，用 `word-agent-test-prompts.md` 的方式补几条计划场景的测试提示，观察行为差异：

1. 「帮我把这份调研报告拆成任务，回头一件件做」——应触发第 8 条：自主建任务组 + blockedBy 排序 + 从无依赖项开始。
2. 「计划里那条合同审查做完了吗」——应触发第 1、2、10 条：plan_list → plan_get → 对照 acceptance 核实现状，而不是复述记忆。
3. 故意给一个 acceptance 写「需含图表」但材料里没有图表的任务——第 5 条应阻止直接标 done，resultSummary 应写出缺口。
4. 给一个检索不到材料的任务——第 6 条应先换关键词/换库再尝试，而不是立即 plan_release。
