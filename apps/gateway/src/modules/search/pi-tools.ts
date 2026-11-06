import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { SearchService } from "./service.js";

const CONTENT_SEARCH_DEFAULT_LIMIT = 10;
const CONTENT_SEARCH_MAX_LIMIT = 50;

/**
 * 主 Agent 的内容检索工具：按**解析正文**（含图片导入时 image-vlm 产出的视觉描述）
 * 全文检索文件库，返回命中片段。与只搜文件名的 file_search 互补——「找一张产品特写」
 * 命中的是图片描述，「找提到竞对的分析」命中的是文档正文。
 * ponytail: SearchService 的 filters 无工作区维度，检索是全库口径；按工作区收敛
 * 需要索引层加维度，命中语义需要时再补。
 */
export function createContentSearchPiTool(getSearch: () => SearchService | null): PiAgentRuntimeTool {
  return {
    name: "content_search",
    label: "按内容检索文件库",
    description: "按文件内容全文检索文件库（FTS 关键词），返回命中的 fileEntryId、文件名与命中片段。"
      + "索引覆盖文档解析正文与图片的视觉描述：找内容相关的文档、按画面内容找图（如「产品特写」「团队合影」）都能命中。"
      + "文件多时先用它定位相关文件，再决定要不要读取全文；与只匹配文件名的 file_search 互补。"
      + "查询词用具体的关键词（中文按词组、英文按单词），不要整句。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "检索关键词（词组/单词，非整句）" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: CONTENT_SEARCH_MAX_LIMIT,
          description: `返回条数上限，缺省 ${String(CONTENT_SEARCH_DEFAULT_LIMIT)}`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    promptSnippet: "按内容检索文件库",
    promptGuidelines: [
      "按内容找资料/找图用 content_search（命中片段直接可判断相关性）；只按文件名找文件才用 file_search。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("content_search 已取消");
      const service = getSearch();
      if (!service) throw new Error("content_search 暂不可用：搜索服务尚未就绪，请稍后重试。");
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("query 不能为空");
      const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(CONTENT_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(params.limit)))
        : CONTENT_SEARCH_DEFAULT_LIMIT;
      const page = service.search(query, { types: ["file"] }, limit, 0);
      const items = page.items.map((hit) => ({
        fileEntryId: hit.refId,
        name: hit.title,
        snippet: hit.snippet,
        updatedAt: hit.ingestedAt,
        status: hit.status,
      }));
      const payload = {
        query,
        total: page.total,
        returned: items.length,
        items,
        ...(items.length === 0
          ? { hint: `没有内容命中「${query}」；换个关键词，或用 file_search 按文件名找。` }
          : { hint: "看 snippet 判断相关性；要更多内容用 workspace_files_preview 批量预览。" }),
      };
      return { content: JSON.stringify(payload), details: payload };
    },
  };
}
