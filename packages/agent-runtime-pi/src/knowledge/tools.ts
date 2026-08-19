import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { KnowledgeServiceClient } from "./client.js";

export const KNOWLEDGE_TOOL_NAMES = ["wiki_search", "wiki_read"] as const;

/** 会话级 wiki 作用域：通常为当前 Room 的 wiki（网关按 roomId 解析），可能为空。 */
export interface KnowledgeToolScope {
  wikiIds: string[];
}

/**
 * 注册给 pi agent 的两个 wiki 知识工具。
 * 均为只读按需检索，3s 超时，失败返回错误文本由模型自行决定后续；
 * 不做 extension/format 自动注入——与记忆的被动沉淀不同，wiki 是
 * agent 主动查的知识库，何时查、读哪页交给模型判断。
 *
 * wiki 作用域按会话解析（Room 级 wiki 模式），工具执行时经 getScope 读取；
 * wiki_search 跨作用域内全部 wiki 检索并标注命中来源，wiki_read 的 ref
 * 与来源 wiki 对应（默认第一个 wiki，跨 wiki 时显式传 wiki 参数）。
 */
export function createKnowledgeTools(
  client: KnowledgeServiceClient,
  getScope: () => KnowledgeToolScope,
): ToolDefinition[] {
  const searchOneWiki = async (
    wikiId: string,
    query: string,
    limit: number,
  ): Promise<string[]> => {
    const results = await client.searchWiki(query, limit, wikiId);
    return results.map((item) => {
      const via = item.hop > 0 && item.via ? `（经 ${item.via} 关联）` : "";
      return `- [${item.path}] ${item.title} (score ${item.score.toFixed(2)})${via} — ${item.snippet}`;
    });
  };

  const wikiSearch = defineTool({
    name: "wiki_search",
    label: "知识库检索",
    description:
      "检索当前 Room 知识库（wiki）中的页面：本 Room 沉淀的文档、技术概念、设备/服务档案、流程对比等结构化知识。" +
      "当问题涉及知识库中沉淀的领域知识、或用户明确要求查知识库/wiki 时调用；" +
      "返回页面列表，用 wiki_read 读取命中的页面全文。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或问题" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 5" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const wikiIds = getScope().wikiIds;
        if (wikiIds.length === 0) {
          return {
            content: [{ type: "text", text: "当前会话未关联知识库（Room 尚无沉淀文档）。" }],
            details: { count: 0, wikis: [] as string[] },
          };
        }
        const perWiki = await Promise.allSettled(
          wikiIds.map((wikiId) => searchOneWiki(wikiId, params.query, params.limit ?? 5)),
        );
        const sections: string[] = [];
        let count = 0;
        perWiki.forEach((outcome, index) => {
          if (outcome.status === "rejected") {
            sections.push(`### ${wikiIds[index]}\n\n（该 wiki 检索失败：${String(outcome.reason)}）`);
            return;
          }
          count += outcome.value.length;
          if (outcome.value.length === 0) return;
          sections.push(
            (wikiIds.length > 1 ? `### ${wikiIds[index]}\n\n` : "") + outcome.value.join("\n"),
          );
        });
        const text = count === 0
          ? "知识库中没有匹配的页面。"
          : sections.join("\n\n") + "\n\n用 wiki_read 读取需要的页面全文（ref 即上方 [path]）。";
        return { content: [{ type: "text", text }], details: { count, wikis: wikiIds } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `知识库检索失败：${String(error)}` }],
          details: { count: 0, wikis: [] as string[] },
          isError: true,
        };
      }
    },
  });

  const wikiRead = defineTool({
    name: "wiki_read",
    label: "知识库页面读取",
    description:
      "读取 wiki 页面的 Markdown 全文（含 frontmatter）。ref 来自 wiki_search 返回的 [path] 或 wiki/page/ls 的目录；" +
      "命中多个 wiki 时用 wiki 参数指定来源（缺省为会话默认 wiki）。",
    parameters: Type.Object({
      refs: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description: "页面引用路径列表（如 sources/oidc-设备授权流程.md）",
      }),
      wiki: Type.Optional(Type.String({ description: "来源 wiki id（多 wiki 命中时指定，缺省为默认 wiki）" })),
    }),
    execute: async (_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: { count: number; wiki?: string }; isError?: boolean }> => {
      try {
        const scope = getScope().wikiIds;
        const wikiId = params.wiki ?? scope[0];
        if (!wikiId) {
          return {
            content: [{ type: "text", text: "当前会话未关联知识库，无页面可读。" }],
            details: { count: 0 },
            isError: true,
          };
        }
        const items = await client.readPages(params.refs, wikiId);
        const text = items.length === 0
          ? "没有读取到任何页面。"
          : items
              .map((item) =>
                item.not_found || item.content == null
                  ? `## ${item.ref}\n\n（页面不存在）`
                  : `## ${item.ref}\n\n${item.content}`,
              )
              .join("\n\n---\n\n");
        return { content: [{ type: "text", text }], details: { count: items.length, wiki: wikiId } };
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
