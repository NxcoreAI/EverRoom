import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { WebSearchConfig } from "../../config.js";

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
}

/**
 * 百炼（DashScope）联网搜索工具：走 compatible-mode chat completions，
 * 开启 enable_search 让模型基于实时检索结果回答。
 */
export function createWebSearchPiTools(config: WebSearchConfig): PiAgentRuntimeTool[] {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
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
      const response = await fetch(endpoint, {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "你是联网搜索助手。基于搜索结果回答问题，给出要点式总结并标注关键来源站点；搜索结果不足时如实说明。使用与提问一致的语言。",
            },
            { role: "user", content: query },
          ],
          enable_search: true,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`百炼联网搜索失败（HTTP ${response.status}）：${detail.slice(0, 400)}`);
      }
      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("百炼联网搜索未返回内容");
      return { content, details: { query, model: config.model } };
    },
  };
  return [tool];
}
