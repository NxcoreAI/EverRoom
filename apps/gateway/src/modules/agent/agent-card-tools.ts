import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";

/** 卡片请求回调：service.requestAgentCard 的注入形态（runId 从工具入参取）。 */
export type AgentCardRequester = (
  runId: string,
  card: {
    kind: "confirm" | "question";
    title: string;
    body?: string;
    plan?: string[];
    options?: string[];
    allowText?: boolean;
    palette?: string[];
    fonts?: { heading?: string; body?: string };
    notes?: string[];
  },
) => Promise<{ choice: string; text?: string }>;

/**
 * 通用交互卡工具对：
 * - agent_confirm：计划/操作确认卡（用户点「确认/取消」，阻塞等待）
 * - agent_ask_user：提问卡（选项按钮或自由输入，阻塞等用户回答）
 * 走 approval 事件通道（kind:"card"），桌面端渲染 AgentDecisionCard。
 */
export function createAgentCardTools(requestCard: AgentCardRequester): PiAgentRuntimeTool[] {
  const confirm: PiAgentRuntimeTool = {
    name: "agent_confirm",
    label: "计划确认卡",
    description: "向用户展示计划/即将执行的操作并等待确认（阻塞到用户点击）。"
      + "用途：长任务动手前（生成整册 PPT、批量改写文档、删除类操作）出计划让用户确认；用户取消就按反馈调整。"
      + "不要滥用：单步读写、信息查询不需要确认卡。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "卡片标题，如「将生成 8 页 BP 演示文稿」" },
        body: { type: "string", maxLength: 600, description: "补充说明（可选）：范围、取舍或风险" },
        plan: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 160 },
          minItems: 1,
          // 12 页 deck 逐页列计划（材料 2 条 + 每页 1 条）就会到 14——上限 16 覆盖
          // 「逐页计划」形态（2026-11-06 实测 14 条被拒后模型重试才过）。
          maxItems: 16,
          description: "计划步骤列表（按执行顺序，每步一句话；逐页 deck 可一页一条）",
        },
        palette: {
          type: "array",
          items: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$", minLength: 7, maxLength: 7 },
          minItems: 2,
          maxItems: 5,
          description: "配色方案色板（hex 带 #，按 主色/次色/强调色 顺序）——用户确认前可视判断配色",
        },
        fonts: {
          type: "object",
          properties: {
            heading: { type: "string", maxLength: 60, description: "标题字体（如 Microsoft YaHei）" },
            body: { type: "string", maxLength: 60, description: "正文字体" },
          },
          additionalProperties: false,
          description: "字体方案（可选）",
        },
        notes: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 80 },
          minItems: 1,
          maxItems: 5,
          description: "其他风格要点（如「深色封面 + 浅色内容页」「衬线标题 + 无衬线正文」）",
        },
      },
      required: ["title", "plan"],
      additionalProperties: false,
    },
    promptSnippet: "计划确认卡",
    executionMode: "sequential",
    execute: async (input: StartRuntimeRunInput, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("agent_confirm 已取消");
      const title = typeof params.title === "string" ? params.title.trim() : "";
      const plan = (Array.isArray(params.plan) ? params.plan : [])
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 16);
      if (!title || plan.length === 0) throw new Error("title 与 plan 不能为空");
      const palette = (Array.isArray(params.palette) ? params.palette : [])
        .filter((item): item is string => typeof item === "string" && /^#?[0-9A-Fa-f]{6}$/.test(item))
        .map((item) => (item.startsWith("#") ? item : `#${item}`))
        .slice(0, 5);
      const fontsParam = params.fonts as { heading?: unknown; body?: unknown } | undefined;
      const fonts = fontsParam
        ? {
          ...(typeof fontsParam.heading === "string" && fontsParam.heading.trim() ? { heading: fontsParam.heading.trim().slice(0, 60) } : {}),
          ...(typeof fontsParam.body === "string" && fontsParam.body.trim() ? { body: fontsParam.body.trim().slice(0, 60) } : {}),
        }
        : undefined;
      const notes = (Array.isArray(params.notes) ? params.notes : [])
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 80))
        .slice(0, 5);
      const decision = await requestCard(input.runId, {
        kind: "confirm",
        title,
        ...(typeof params.body === "string" && params.body.trim() ? { body: params.body.trim().slice(0, 600) } : {}),
        plan,
        ...(palette.length >= 2 ? { palette } : {}),
        ...(fonts && (fonts.heading || fonts.body) ? { fonts } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
      const approved = decision.choice === "approved";
      return {
        content: JSON.stringify({
          confirmed: approved,
          ...(approved ? {} : { feedback: decision.text ?? "" }),
          note: approved ? "用户已确认计划" : "用户取消了本次操作",
        }),
        details: { confirmed: approved },
      };
    },
  };

  const askUser: PiAgentRuntimeTool = {
    name: "agent_ask_user",
    label: "向用户提问",
    description: "向用户提出一个需要回答的问题并等待作答（阻塞；用户可点选项或自由输入）。"
      + "用途：缺少必要信息且无法推断时（二选一的方向、缺失的关键参数、素材歧义）；一次只问一个问题。"
      + "能从上下文/工具返回推断的不要问；连续提问不超过 2 次，仍不够就按最合理假设继续并说明。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 300, description: "问题（一句话，具体到可直接回答）" },
        context: { type: "string", maxLength: 600, description: "背景说明（可选）：为什么问、答了会怎样" },
        options: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 120 },
          minItems: 2,
          maxItems: 6,
          description: "候选答案按钮（可选，2~6 个）；不传则用户自由输入",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    promptSnippet: "向用户提问",
    executionMode: "sequential",
    execute: async (input: StartRuntimeRunInput, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("agent_ask_user 已取消");
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) throw new Error("question 不能为空");
      const options = (Array.isArray(params.options) ? params.options : [])
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 6);
      const decision = await requestCard(input.runId, {
        kind: "question",
        title: question,
        ...(typeof params.context === "string" && params.context.trim() ? { body: params.context.trim().slice(0, 600) } : {}),
        ...(options.length >= 2 ? { options } : { allowText: true }),
      });
      const answer = decision.text?.trim()
        ? (decision.choice ? `${decision.choice}：${decision.text.trim()}` : decision.text.trim())
        : decision.choice;
      return {
        content: JSON.stringify({ answer, answered: answer !== "" }),
        details: { answer },
      };
    },
  };

  return [confirm, askUser];
}
