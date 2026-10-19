import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

import { SLIDES_TOOL_NAMES } from "../documents/capabilities/office-plugin.js";
import { getDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { takeReviewManual } from "../slides-layout/review-context.js";
import { normalizeTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { measureDefects, type LayoutDefect } from "../slides-layout/tree/measure.js";

/**
 * slides 两段式子代理的工具面：
 * - slides-planner（方案）：素材自取只读面——**拒绝** slides 四件套（不落页）、
 *   写入类（write/patch）、调度类（agent_dispatch/agent_catalog——防子 Agent 自递归）、通知类。
 * - slides-builder（落页）：PPT 四件套独占——方案已带全部内容，检索类一律拒绝，
 *   杜绝落页阶段重新检索挤占逐页生成预算。策略集中在 allowlist，装配方传什么都先过滤再合并。
 */
const SLIDES_PLANNER_ROOM_TOOL_ALLOWLIST = new Set([
  "memory_search",
  "conversation_search",
  "room_context_get",
]);

const SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST = new Set([
  "context_room_list",
  "context_room_document_list",
  "context_room_document_read",
]);

const SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);

const SLIDES_PLANNER_MATERIAL_TOOL_ALLOWLIST = new Set(["material_search"]);

const SLIDES_BUILDER_TOOL_ALLOWLIST = new Set<string>(SLIDES_TOOL_NAMES);

function filterTools(
  tools: PiAgentRuntimeTool[],
  allowlist: Set<string>,
): PiAgentRuntimeTool[] {
  return tools.filter((tool) => allowlist.has(tool.name));
}

export function createSlidesPlannerAgentTools(deps: {
  /** createContextRoomAgentTools 的产物（记忆/会话/Room 上下文）。 */
  roomTools: PiAgentRuntimeTool[];
  /** createDocumentPiTools 的产物（取文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
  /** createMaterialSearchPiTools 的产物（本地素材检索，PPT 配图主通道）。 */
  materialSearchTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.roomTools, SLIDES_PLANNER_ROOM_TOOL_ALLOWLIST),
    ...filterTools(deps.documentTools, SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST),
    ...filterTools(deps.webSearchTools, SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST),
    ...filterTools(deps.materialSearchTools, SLIDES_PLANNER_MATERIAL_TOOL_ALLOWLIST),
  ];
}

export function createSlidesBuilderAgentTools(deps: {
  /** createDocumentPiTools 的产物（PPT 四件套 + 文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.documentTools, SLIDES_BUILDER_TOOL_ALLOWLIST),
  ];
}

interface ValidateOutcome {
  ok: boolean;
  defects: LayoutDefect[];
  stats: { elements: number; leaves: number; depth: number; images: number; paths: number };
}

/** 归一 → 编译 → 量测（契约经 token 从进程内上下文取，模型不回传防漂移）。 */
export function validateLayoutTree(token: unknown, rawTree: unknown): ValidateOutcome {
  const context = getDeckLayoutContext(token);
  if (!context) {
    return {
      ok: false,
      defects: [{ path: "root", type: "schema", detail: `token 未注册或已失效（${String(token).slice(0, 40)}）`, hint: "检查输入里的 token 字段原样传入" }],
      stats: { elements: 0, leaves: 0, depth: 0, images: 0, paths: 0 },
    };
  }
  let tree;
  try {
    tree = normalizeTree(rawTree);
  } catch (error) {
    return {
      ok: false,
      defects: [{ path: "root", type: "schema", detail: error instanceof Error ? error.message : String(error), hint: "按报错修正后重交整棵树" }],
      stats: { elements: 0, leaves: 0, depth: 0, images: 0, paths: 0 },
    };
  }
  const result = compileTree(tree, context.contract);
  const defects = measureDefects(result, context.contract, { imageArs: context.imageArs });
  return { ok: defects.length === 0, defects, stats: result.stats };
}

export const LAYOUTER_VALIDATE_TOOL: PiAgentRuntimeTool = {
  name: "slides_layout_validate",
  label: "布局树校验",
  description:
    "校验你设计的布局树：结构归一 → 确定性编译 → 量测。返回结构化缺陷清单（节点路径+缺陷类型+改法）。"
    + "ok=true 才可用 subagent_submit_result 提交；有缺陷按 hint 修正后重交整棵树，最多 3 轮。",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "输入里的 deckToken，原样传入（网关据此取本 deck 的布局契约）" },
      tree: { type: "object", description: "布局树（root：role/title?/dark?/bg?/direction(row|column|overlay)/weights?/gapScale?/pad?/children；overlay 直接子节点须带 place 百分比定位）" },
    },
    required: ["token", "tree"],
    additionalProperties: false,
  },
  executionMode: "sequential",
  async execute(_input, params) {
    const outcome = validateLayoutTree(params.token, params.tree);
    return { content: JSON.stringify(outcome) };
  },
};

/** slides-layouter 的工具面：只有布局树校验（技能读取与结果提交由运行时自带）。 */
export function createSlidesLayouterAgentTools(): PiAgentRuntimeTool[] {
  return [LAYOUTER_VALIDATE_TOOL];
}

/** slides-reviewer 的审页说明书：决定修改时按需取该页内容与当前树（含校验用 deckToken）。 */
const REVIEWER_MANUAL_TOOL: PiAgentRuntimeTool = {
  name: "slides_review_manual",
  label: "审页说明书",
  description:
    "取本页的修改说明书：该页的内容（title/points/data/materials）、当前布局树、以及 slides_layout_validate 校验要用的 deckToken。"
    + "只在你看完截图决定要修改这一页时调用。",
  parameters: {
    type: "object",
    properties: {
      manualToken: { type: "string", description: "输入里的 manualToken，原样传入" },
    },
    required: ["manualToken"],
    additionalProperties: false,
  },
  executionMode: "sequential",
  async execute(_input, params) {
    const manual = takeReviewManual(params.manualToken);
    if (!manual) {
      return { content: JSON.stringify({ ok: false, error: "说明书未注册（manualToken 不对或本次生成已结束）；核对输入原样重试一次，仍失败就提交 ok" }) };
    }
    return {
      content: JSON.stringify({
        ok: true,
        deckToken: manual.deckToken,
        page: manual.page,
        currentTree: manual.currentTree,
      }),
    };
  },
};

/** slides-reviewer 的工具面：说明书（按需）+ 布局树校验（复用 layouter 的确定性环）。 */
export function createSlidesReviewerAgentTools(): PiAgentRuntimeTool[] {
  return [REVIEWER_MANUAL_TOOL, LAYOUTER_VALIDATE_TOOL];
}
