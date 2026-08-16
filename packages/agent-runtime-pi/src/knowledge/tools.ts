import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { KnowledgeServiceClient } from "./client.js";

export const KNOWLEDGE_TOOL_NAMES = ["wiki_search", "wiki_read"] as const;

/**
 * 注册给 pi agent 的两个 wiki 知识工具。
 * 均为只读按需检索，3s 超时，失败返回错误文本由模型自行决定后续；
 * 不做 extension/format 自动注入——与记忆的被动沉淀不同，wiki 是
 * agent 主动查的知识库，何时查、读哪页交给模型判断。
 */
export function createKnowledgeTools(client: KnowledgeServiceClient): ToolDefinition[] {
  const wikiSearch = defineTool({
    name: "wiki_search",
    label: "知识库检索",
    description:
      "检索团队知识库（wiki）中的页面：技术概念、设备/服务档案、流程对比等结构化知识。" +
      "当问题涉及知识库中沉淀的领域知识、或用户明确要求查知识库/wiki 时调用；" +
      "返回页面列表，用 wiki_read 读取命中的页面全文。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或问题" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 5" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const results = await client.searchWiki(params.query, params.limit ?? 5);
        const text = results.length === 0
          ? "知识库中没有匹配的页面。"
          : results
              .map((item) => {
                const via = item.hop > 0 && item.via ? `（经 ${item.via} 关联）` : "";
                return `- [${item.path}] ${item.title} (score ${item.score.toFixed(2)})${via} — ${item.snippet}`;
              })
              .join("\n") + "\n\n用 wiki_read 读取需要的页面全文（ref 即上方 [path]）。";
        return { content: [{ type: "text", text }], details: { count: results.length } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `知识库检索失败：${String(error)}` }],
          details: { count: 0 },
          isError: true,
        };
      }
    },
  });

  const wikiRead = defineTool({
    name: "wiki_read",
    label: "知识库页面读取",
    description:
      "读取 wiki 页面的 Markdown 全文（含 frontmatter）。ref 来自 wiki_search 返回的 [path] 或 wiki/page/ls 的目录。",
    parameters: Type.Object({
      refs: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description: "页面引用路径列表（如 sources/oidc-设备授权流程.md）",
      }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const items = await client.readPages(params.refs);
        const text = items.length === 0
          ? "没有读取到任何页面。"
          : items
              .map((item) =>
                item.not_found || item.content == null
                  ? `## ${item.ref}\n\n（页面不存在）`
                  : `## ${item.ref}\n\n${item.content}`,
              )
              .join("\n\n---\n\n");
        return { content: [{ type: "text", text }], details: { count: items.length } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `知识库页面读取失败：${String(error)}` }],
          details: { count: 0 },
          isError: true,
        };
      }
    },
  });

  return [wikiSearch, wikiRead];
}
