import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { MaterialsService } from "./service.js";

/**
 * slides-planner 专用素材检索工具：查用户本机图库（截图/照片、网页剪藏图、文档内嵌图），
 * 返回可直接填进 PageSpec materials 的 everroom-material:// 引用。检索不到就明确说没有，
 * 让规划代理按纪律退化为图形版式，不放假图。
 */
export function createMaterialSearchPiTools(materials: MaterialsService | null): PiAgentRuntimeTool[] {
  const tool: PiAgentRuntimeTool = {
    name: "material_search",
    label: "素材检索",
    description: [
      "检索用户本机图库（截图、照片、网页剪藏图、文档内嵌图）。",
      "返回 everroom-material:// 素材引用、画面描述与来源尺寸，ref 可直接放进 materials.url。",
      "配图优先用它；检索不到合适素材就省略 materials 退化为图形版式，绝不放假图。",
    ].join(""),
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "画面关键词（空格分隔，命中任一词即返回、命中越多排越前），如「城市 夜景」「茶具 盖碗」。",
      }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    promptSnippet: "素材检索",
    executionMode: "sequential",
    execute: async (_run, params): Promise<PiAgentRuntimeToolResult> => {
      if (!materials) {
        return { content: "素材检索不可用（素材库为空）。", details: { count: 0 } };
      }
      const hits = materials.search(String(params.query ?? ""), Number(params.limit ?? 8));
      if (hits.length === 0) {
        return { content: "没有匹配的素材；请换关键词重试或省略配图。", details: { count: 0 } };
      }
      const lines = hits.map((hit) => `- ${hit.ref}｜${hit.kind}｜${hit.desc}｜${hit.meta}`);
      const header = "命中素材（ref 放进 materials.url，desc 照抄进 materials.desc）：";
      return { content: [header, ...lines].join("\n"), details: { count: hits.length } };
    },
  };
  return [tool];
}
