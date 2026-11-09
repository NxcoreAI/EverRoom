# 计划工具提示词的注入链路改造与文案方案

目标：让主 Agent 在「计划」能力上具备 DSH 式的自主规划行为——先拆解、按证据判完成、不轻易放回、跨轮续接时锚定现实。本方案分两部分：先修通注入链路（少量代码改动，不动架构），再给文案（与 [prompt-plan-autonomy.zh-CN.md](./prompt-plan-autonomy.zh-CN.md) 的 SYSTEM.md 替换稿配套）。

## 一、链路现状核实（读 pi-coding-agent@0.84.2 源码得出）

把政策写进 pi-tools.ts 各工具的 `promptGuidelines` 字段，**在你们当前链路上是死通道**：

1. 网关对每个用户档 runtime 都传 `systemPromptOverride`（[runtime-factory.ts:160](../apps/gateway/src/modules/agent/runtime-factory.ts#L160) 的 `systemPrompt: bundle.systemPrompt`）。
2. pi SDK 的 `buildSystemPrompt`（dist/core/system-prompt.js）里，`if (customPrompt)` 分支**提前 return**，只拼 customPrompt + append + contextFiles + skills，**工具级 promptSnippet / promptGuidelines 全部丢弃**。
3. 只有 integration 级 `promptGuidelines`（[runtime-factory.ts:181](../apps/gateway/src/modules/agent/runtime-factory.ts#L181)）会经 [agent-runtime-pi/index.ts:1036](../../packages/agent-runtime-pi/src/index.ts#L1036) 拼进系统提示，这条才是活通道。

仓库里其实已有正确先例：[memory/pi-tools.ts:11-15](../apps/gateway/src/modules/memory/pi-tools.ts#L11) 的注释明确写了这个坑，并把记忆工具的行为指引做成模块级常量 `MEMORY_PROMPT_GUIDELINES` 注入 integration 级。plan 工具现在写在各工具的 `promptGuidelines` 字段上（[plan/pi-tools.ts](../apps/gateway/src/modules/plan/pi-tools.ts) 六个工具都有），全部没有生效——属于已踩中、未修复的坑。

另一个核实结果：main-direct / main-lite 与 main **共用 primary bundle 的 SYSTEM.md**（[runtime-factory.ts:145](../apps/gateway/src/modules/agent/runtime-factory.ts#L145) `builtin(BUILTIN_AGENT_IDS.primary)`），它们自己目录下的 SYSTEM.md 并未参与运行时装配。所以「三份 SYSTEM.md 人肉同步」的问题实际不存在，真正的分叉面是「SYSTEM.md 政策 ↔ 工具是否挂载」的一致性。

## 二、注入链路改动（三处小改，代码总量约 20 行）

### 改动 1：plan 政策常量化，进 integration 级通道（必做）

仿照 memory 的做法，在 `plan/pi-tools.ts` 顶部导出一个模块级常量：

```ts
/**
 * 计划工具的行为指引（注入系统提示词，integration 级通道）。
 *
 * 与 memory/pi-tools.ts 同理：工具级 promptGuidelines 在本仓库不生效
 * （自定义 systemPrompt 分支不渲染 pi 的 Guidelines 段），必须走
 * integration.promptGuidelines。
 */
export const PLAN_PROMPT_GUIDELINES: readonly string[] = [
  "计划是待办池不是进度条：认领后先把任务拆成步骤清单（plan_update 的 checklist），一步一条、做完即勾；单步小事不拆。",
  "只有验收标准逐条满足且交付物可复查才标 done；「工具调用成功返回」不等于「任务完成」，resultSummary 写清交付了什么、怎么验证的、还缺什么。",
  "只有缺用户输入、权限或外部资源且无替代路线才 plan_release；检索没命中、步骤多、有难度都不是放回的理由——先换关键词、换工具路线再试。",
];
```

在 [runtime-factory.ts:181](../apps/gateway/src/modules/agent/runtime-factory.ts#L181) 的 `promptGuidelines` 数组里，把常量与 `MEMORY_PROMPT_GUIDELINES` 并列接入（工具本身仍在 create-server.ts 挂载，但指引注入在 runtime 装配处）。

各工具上现有的 `promptGuidelines` 字段不删——它们出现在 agent-debug 面板（[agent-debug/service.ts:256](../apps/gateway/src/modules/agent-debug/service.ts#L256)）里有观测价值，且若未来 pi 修通工具级通道可自动激活。

### 改动 2：给 plan_update 的 status 参数补描述（必做）

现在 `status` 是裸 enum，模型在使用点看不到政策。补上：

```ts
status: {
  type: "string",
  enum: ["todo", "doing", "done", "dropped"],
  description:
    "done=验收标准逐条满足且交付物可复查才能标；标 done 必须同时写 resultSummary。" +
    "dropped=任务取消或方向作废（需在 note 里写原因）。doing=正在做。todo=放回待开始。",
},
```

工具 description 同步收紧一句（现在 description 是“更新任务状态、勾选检查项……”，政策性弱）：

```ts
description:
  "更新任务状态、检查项与完成结论。status=done 前先逐条核对任务的 acceptance；" +
  "checklist 是整份替换不是追加，执行中保持与实际进度同步。",
```

### 改动 3：结果侧注入收尾提醒（可选，性价比高）

DSH 在 goal 标记 complete 后立即注入「现在写收尾报告：结果、怎么验证的、待办」。你们可以在 `plan_update` 的 execute 里，当 `status === "done"` 时在返回的 `content` 末尾追加一段：

```ts
if (params.status === "done") {
  content += "\n\n【收尾】请在给用户的答复里写清：交付了什么、怎么验证的、还剩什么没做。resultSummary 与答复口径一致。";
}
```

这不是新机制，只是把工具结果的文本写丰富——但时机正好在模型写最终答复之前，纠偏效果与 DSH 的 deferContext 同型。

## 三、SYSTEM.md 侧的配套精简

注入链路修通后，SYSTEM.md「计划与认领」的职责从「承载全部政策」收窄为「承载流程编排」（什么时候查、什么时候认领、什么时候建任务组），纪律性条款（证据标准、放回准入、checklist 用法）由工具侧通道注入，SYSTEM.md 里对应句子可删。具体替换文案用 [prompt-plan-autonomy.zh-CN.md](./prompt-plan-autonomy.zh-CN.md) 第二节的整节替换稿，其中第 3、5、6 条的纪律内容与上面的 PLAN_PROMPT_GUIDELINES 重复，替换稿里保留编排句、删除纪律句即可。

这样两个通道各司其职：SYSTEM.md 管「编排」（跟人设走，所有档位一致），工具通道管「纪律」（跟工具挂载走，哪个 runtime 挂了 plan 工具哪个就有），正是 DSH「政策跟工具走」的结构。

## 四、验证

1. 单测：现有 [plan-routes.test.ts](../apps/gateway/tests/plan-routes.test.ts) 不受影响（改动只在提示词字段与结果文案）。
2. 行为验证：用 [prompt-plan-autonomy.zh-CN.md](./prompt-plan-autonomy.zh-CN.md) 第五节的 4 条测试提示跑对照，重点看：
   - 「帮我把这份调研报告拆成任务」→ 是否自主建任务组 + blockedBy 排序；
   - acceptance 含「需含图表」但材料没有图表 → 是否拒绝直接标 done；
   - 检索不到材料 → 是否先换关键词再试而不是直接 release。
3. agent-debug 面板核对注入结果：装配后的 systemPrompt 里应能看到 PLAN_PROMPT_GUIDELINES 的三条文本。

## 五、改动清单

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| [plan/pi-tools.ts](../apps/gateway/src/modules/plan/pi-tools.ts) | 新增 `PLAN_PROMPT_GUIDELINES` 常量；plan_update 的 status 参数补描述；description 收紧；done 时结果追加收尾提醒 | 文案 + 约 20 行代码 |
| [runtime-factory.ts](../apps/gateway/src/modules/agent/runtime-factory.ts) | `promptGuidelines` 数组接入 PLAN_PROMPT_GUIDELINES（import + 展开，2 行） | 2 行 |
| [agents/main/SYSTEM.md](../agents/main/SYSTEM.md) | 「计划与认领」按配套精简后的替换稿更新 | 纯文案 |
| [prompt-plan-autonomy.zh-CN.md](./prompt-plan-autonomy.zh-CN.md) | 上一轮方案的替换稿按「精简版」微调 | 纯文案 |

## 六、实施记录（2026-11-06）

以上改动已全部落地：

1. `PLAN_PROMPT_GUIDELINES` 三条（拆解 / 证据标准 / 放回准入）已加进 [plan/pi-tools.ts](../apps/gateway/src/modules/plan/pi-tools.ts) 并在 [runtime-factory.ts](../apps/gateway/src/modules/agent/runtime-factory.ts) 接入 integration 级通道，三个用户档（main / main-direct / main-lite）共用同一装配，全部生效。
2. `plan_update` 的 `status` 参数已补描述，工具 description 已收紧。
3. 标 done 时结果末尾追加【收尾】提醒已实现。
4. SYSTEM.md「计划与认领」已按「编排归 SYSTEM、纪律归工具通道」重写为 7 条：编排类（找活儿/读包/认领/建任务/续接/边界）留在文件里，纪律类（checklist 拆解、done 证据标准、release 准入）下沉到工具通道，两边不重复。
