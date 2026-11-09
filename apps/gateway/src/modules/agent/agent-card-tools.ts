import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { PiAgentCardDecision, PiAgentCardRequest } from "@nxcore/agent-runtime-pi";

/**
 * 通用交互卡工具面：agent_confirm（计划确认卡）与 agent_ask_user（提问卡）。
 *
 * 卡片经 AgentService.requestAgentCard → PiAgentRuntime.requestAgentCard 推进
 * 当前 run 的事件流（approval.requested kind="card"），阻塞等待用户在 UI 上
 * 作答；桌面端 POST /v1/agent/approvals/:id/resolve 带 choice/text 回填。
 * 超时按「confirm=denied / question=空答」收口，工具拿到正常返回而非异常。
 */
export function createAgentCardTools(
  requestCard: (runId: string, card: PiAgentCardRequest["card"]) => Promise<PiAgentCardDecision>,
): PiAgentRuntimeTool[] {
  const confirm: PiAgentRuntimeTool = {
    name: "agent_confirm",
    label: "计划确认卡",
    description: "向用户展示计划确认卡，等用户点确认或取消后继续。用于动手前对齐："
      + "生成整册 PPT、批量改写、删除类操作等长任务先出卡（标题 + plan 步骤列表）；"
      + "PPT 整册生成必须带 palette（2~5 个 hex 色板，按 主色/次色/强调 顺序）与 "
      + "fonts（标题/正文字体），选定深浅结构再带 notes（如「深色封面 + 浅色内容页」），"
      + "用户在卡片上直接看到色块与字体再决定。"
      + "用户确认返回 choice=approved；取消返回 denied，text 带用户反馈——按反馈调整后重新出卡，"
      + "不要在取消后擅自继续原计划。10 分钟无应答自动取消。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "卡片标题，一句话说清将做什么（如「将生成 8 页产品介绍演示文稿」）" },
        plan: {
          type: "array",
          items: { type: "string" },
          description: "计划/步骤列表，按执行顺序每步一行",
        },
        palette: {
          type: "array",
          items: { type: "string" },
          description: "设计决策色板：2~5 个 hex 色值，按 主色/次色/强调 顺序（PPT 生成必带）",
        },
        fonts: {
          type: "object",
          properties: {
            heading: { type: "string", description: "标题字体名" },
            body: { type: "string", description: "正文字体名" },
          },
          description: "标题/正文字体（PPT 生成必带）",
        },
        notes: {
          type: "array",
          items: { type: "string" },
          description: "其他风格要点（如「深色封面 + 浅色内容页」）",
        },
        body: { type: "string", description: "补充说明（可选）：背景、取舍原因、影响范围" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    promptSnippet: "计划确认卡",
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const title = typeof params.title === "string" ? params.title.trim() : "";
      if (!title) throw new Error("agent_confirm 参数 title 不能为空");
      const card: PiAgentCardRequest["card"] = {
        kind: "confirm",
        title: title.slice(0, 200),
        ...(typeof params.body === "string" && params.body.trim()
          ? { body: params.body.trim().slice(0, 2_000) }
          : {}),
        ...(Array.isArray(params.plan)
          ? { plan: params.plan.flatMap((step) => (typeof step === "string" && step.trim() ? [step.trim().slice(0, 500)] : [])).slice(0, 30) }
          : {}),
        ...(Array.isArray(params.palette)
          ? {
            palette: params.palette.flatMap((color) => {
              if (typeof color !== "string") return [];
              const value = color.trim();
              return /^#[0-9a-fA-F]{6}$/.test(value) ? [value.toLowerCase()] : [];
            }).slice(0, 5),
          }
          : {}),
        ...(params.fonts !== null && typeof params.fonts === "object" && !Array.isArray(params.fonts)
          ? (() => {
            const fonts = params.fonts as { heading?: unknown; body?: unknown };
            return {
              fonts: {
                ...(typeof fonts.heading === "string" && fonts.heading.trim()
                  ? { heading: fonts.heading.trim().slice(0, 100) }
                  : {}),
                ...(typeof fonts.body === "string" && fonts.body.trim()
                  ? { body: fonts.body.trim().slice(0, 100) }
                  : {}),
              },
            };
          })()
          : {}),
        ...(Array.isArray(params.notes)
          ? { notes: params.notes.flatMap((note) => (typeof note === "string" && note.trim() ? [note.trim().slice(0, 300)] : [])).slice(0, 10) }
          : {}),
      };
      const decision = await requestCard(input.runId, card);
      return {
        content: JSON.stringify({
          choice: decision.choice,
          ...(decision.text ? { text: decision.text } : {}),
          hint: decision.choice === "approved"
            ? "用户已确认，按计划继续执行。"
            : "用户未确认。text 是用户反馈（可能为空/timeout）：有反馈就按反馈调整后重新出卡；无反馈且任务可缩减就缩小范围重新出卡，不要原样重发。",
        }),
      };
    },
  };

  const askUser: PiAgentRuntimeTool = {
    name: "agent_ask_user",
    label: "提问卡",
    description: "向用户提一个问题并等待回答。只用于无法从上下文与工具推断的关键分歧："
      + "方向二选一、关键参数缺失、素材歧义。能给选项就给 options（按钮），"
      + "allowText=true 时用户也可自由输入。返回 choice=所选选项或用户输入文本（text）。"
      + "能推断的不要问；一次只问一个问题；连续提问不超过 2 次，仍不够就按最合理假设继续并说明。"
      + "10 分钟无应答自动取消（choice 为空）。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "问题本身，一句话只问一个关键分歧点" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "候选答案（按钮）；不传则用户只能自由输入",
        },
        allowText: { type: "boolean", description: "允许自由输入补充（默认 true）" },
        context: { type: "string", description: "补充上下文（可选）：为什么问、两个选项分别意味着什么" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    promptSnippet: "提问卡",
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      if (!question) throw new Error("agent_ask_user 参数 question 不能为空");
      const card: PiAgentCardRequest["card"] = {
        kind: "question",
        title: question.slice(0, 500),
        ...(typeof params.context === "string" && params.context.trim()
          ? { body: params.context.trim().slice(0, 2_000) }
          : {}),
        ...(Array.isArray(params.options)
          ? {
            options: params.options.flatMap((option) =>
              typeof option === "string" && option.trim() ? [option.trim().slice(0, 200)] : [],
            ).slice(0, 6),
          }
          : {}),
        ...(typeof params.allowText === "boolean" ? { allowText: params.allowText } : {}),
      };
      const decision = await requestCard(input.runId, card);
      return {
        content: JSON.stringify({
          choice: decision.choice,
          ...(decision.text ? { text: decision.text } : {}),
          hint: decision.choice.trim()
            ? "已收到用户作答，按答案继续。"
            : "用户未作答（超时或取消）：不要重复追问同一问题，按最合理假设继续并向用户说明该假设。",
        }),
      };
    },
  };

  return [confirm, askUser];
}
