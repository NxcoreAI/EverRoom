import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import { invokeAgent } from "./invoke.js";
import { BUILTIN_AGENT_IDS, type AgentResolver } from "./resolver.js";
import {
  ExternalCallBudgetExceededError,
  type ExternalCallBudgetService,
} from "../external-calls/service.js";

/**
 * 百炼（DashScope）联网搜索工具：走 compatible-mode chat completions，
 * 开启 enable_search 让模型基于实时检索结果回答。
 */
export function createWebSearchPiTools(
  resolver: AgentResolver,
  budget?: ExternalCallBudgetService,
): PiAgentRuntimeTool[] {
  const tool: PiAgentRuntimeTool = {
    name: "web_search",
    label: "联网搜索",
    description: "联网搜索最新信息并用中文总结要点，适合时效性问题、事实核查或本地知识不足的场景。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索问题或关键词；用与目标信息一致的语言描述。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    promptSnippet: "联网搜索",
    promptGuidelines: [
      "涉及最新动态、实时数据或本地知识覆盖不到的事实时，先调用 web_search 再回答，并注明信息来自联网搜索。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("web_search 参数 query 不能为空");
      if (signal?.aborted) throw new Error("web_search 已取消");
      const invoke = () => invokeAgent(resolver, BUILTIN_AGENT_IDS.webSearch, query, {
        pageLabel: "联网搜索",
        timeoutMs: 60_000,
      });
      const content = budget
        ? await budget.execute("WEB_SEARCH", "web_search", {
            source: "agent",
            runId: _input.runId,
            correlationId: _input.sessionId,
          }, async (markDispatched) => {
            markDispatched();
            return invoke();
          })
        : await invoke();
      return {
        content,
        details: { query, agentId: BUILTIN_AGENT_IDS.webSearch },
      };
    },
    classifyFailure: (error) => error instanceof ExternalCallBudgetExceededError ? {
      category: "external_call_budget_exceeded",
      recoverable: true,
      instruction: "Skip web_search and continue with another available path.",
    } : null,
  };
  return [tool];
}
