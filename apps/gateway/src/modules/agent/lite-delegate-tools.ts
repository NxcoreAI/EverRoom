import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import { invokeAgent } from "./invoke.js";
import { BUILTIN_AGENT_IDS, type AgentResolver } from "./resolver.js";

/**
 * Smart 档委派工具：主会话（强模型）把可独立完成的子任务单轮委派给
 * 轻量模型（main-lite）。走 invokeAgent 的隔离会话（即用即删），不携带
 * 主会话上下文——输入必须在 task/input 里自包含。
 */
export function createLiteDelegatePiTools(resolver: AgentResolver): PiAgentRuntimeTool[] {
  const tool: PiAgentRuntimeTool = {
    name: "lite_assist",
    label: "轻量模型委派",
    description: "把可独立完成的文本子任务委派给更快的轻量模型并取回结果。适合批量大但单件简单的机械工作：逐段摘要、分类打标、信息抽取、格式改写。任务描述与材料必须在 task/input 里自包含（轻量模型看不到当前对话）。需要连贯推理、多步决策或高质量写作的任务不要委派，自己完成。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "对轻量模型的工作指派：做什么、输出什么格式。用祈使句写清边界，例如「逐段总结，每段一行，不超过 20 字」。",
        },
        input: {
          type: "string",
          description: "待处理的完整材料文本（自包含，不含本对话其他内容）。",
        },
      },
      required: ["task", "input"],
      additionalProperties: false,
    },
    promptSnippet: "轻量模型委派",
    promptGuidelines: [
      "遇到多个独立且机械的文本子任务（批量摘要/分类/抽取/改写）时，优先把每个子任务用 lite_assist 委派给轻量模型，自己汇总结果；单件简单任务不值得委派，直接自己完成。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      const input = typeof params.input === "string" ? params.input : "";
      if (!task) throw new Error("lite_assist 参数 task 不能为空");
      if (!input.trim()) throw new Error("lite_assist 参数 input 不能为空");
      if (signal?.aborted) throw new Error("lite_assist 已取消");
      const prompt = [
        `任务：${task}`,
        "",
        "材料：",
        input,
      ].join("\n");
      const content = await invokeAgent(resolver, BUILTIN_AGENT_IDS.lite, prompt, {
        pageLabel: "轻量模型委派",
        timeoutMs: 120_000,
      });
      return {
        content,
        details: { task, agentId: BUILTIN_AGENT_IDS.lite },
      };
    },
  };
  return [tool];
}
