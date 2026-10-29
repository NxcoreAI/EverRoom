import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { SubagentResultValidator } from "./runtime-manager.js";

import { SLIDES_TOOL_NAMES } from "../documents/capabilities/office-plugin.js";
import { getDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { takeReviewManual } from "../slides-layout/review-context.js";
import { normalizeTree } from "../slides-layout/tree/schema.js";
import { getPagePreview, markPagePreviewed } from "../slides-layout/page-preview-context.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { measureDefects, type LayoutDefect } from "../slides-layout/tree/measure.js";
import { createSlidesImagePrewarmTools } from "./slides-page-images-prewarm.js";

/**
 * slides 两段式子代理的工具面：
 * - slides-planner（方案）：素材自取只读面——**拒绝** slides 四件套（不落页）、
 *   写入类（write/patch）、调度类（agent_dispatch/agent_catalog——防子 Agent 自递归）、通知类。
 * - slides-builder（落页）：PPT 四件套独占——方案已带全部内容，检索类一律拒绝，
 *   杜绝落页阶段重新检索挤占逐页生成预算。策略集中在 allowlist，装配方传什么都先过滤再合并。
 */
const SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST = new Set([
  "document_list",
  "document_read",
]);

const SLIDES_PLANNER_WORKSPACE_TOOL_ALLOWLIST = new Set(["workspace_files_list"]);

const SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);


const SLIDES_PLANNER_PREWARM_TOOL_ALLOWLIST = new Set(["slides_image_prewarm"]);

const SLIDES_BUILDER_TOOL_ALLOWLIST = new Set<string>(SLIDES_TOOL_NAMES);

/** planner 取数预算：draft 阶段需要背景，但单篇正文不该整篇进上下文。 */
const PLANNER_DOCUMENT_READ_LIMIT = 8_000;

export interface WorkspaceFileText {
  text: string;
  filename: string;
}

function filterTools(
  tools: PiAgentRuntimeTool[],
  allowlist: Set<string>,
): PiAgentRuntimeTool[] {
  return tools.filter((tool) => allowlist.has(tool.name));
}

function subagentPhase(input: StartRuntimeRunInput): string | null {
  const structured = input.runtimeMetadata?.subagentInput;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return null;
  const phase = (structured as Record<string, unknown>).phase;
  return typeof phase === "string" ? phase : null;
}

/**
 * planner 的 document_read：draft 阶段单次最多 8k 字符（分页用
 * offset/limit）；arrange 阶段内容已在输入里，直接拒读，避免重复吃整篇。
 */
function createPlannerDocumentReadTool(tool: PiAgentRuntimeTool): PiAgentRuntimeTool {
  return {
    ...tool,
    description: `${tool.description}（PPT 方案代理：单次最多 ${PLANNER_DOCUMENT_READ_LIMIT} 字符，超出用 offset/limit 分页；编排阶段内容已由输入给出，不需要再读。）`,
    execute: async (input, params, signal, onUpdate) => {
      const phase = subagentPhase(input);
      if (phase === "arrange") {
        return {
          content: JSON.stringify({
            skipped: true,
            reason: "编排阶段的结构化输入 draftPages 已包含全部页内容，禁止重复读取文档；直接基于输入产出方案。",
          }),
          details: { skipped: true, phase },
        };
      }
      const requestedLimit = typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : PLANNER_DOCUMENT_READ_LIMIT;
      const limit = Math.max(1, Math.min(requestedLimit, PLANNER_DOCUMENT_READ_LIMIT));
      const offset = typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0
        ? Math.floor(params.offset)
        : 0;
      return tool.execute(input, { ...params, offset, limit }, signal, onUpdate);
    },
  };
}

/**
 * 工作区文件正文读取：用户上传的资料（md/docx 等）在文件库而不在文稿表，
 * document_list 够不到。planner 与主 Agent 共用；mainAgent 变体不带编排阶段
 * 拒读（那是 slides 编排的专属语义）。
 */
export function createWorkspaceFileReadTool(
  readText: (fileEntryId: string) => Promise<WorkspaceFileText | null>,
  options?: { mainAgent?: boolean },
): PiAgentRuntimeTool {
  const mainAgent = options?.mainAgent === true;
  return {
    name: "workspace_file_read",
    label: "读取工作区文件",
    description:
      `按 fileEntryId 读工作区上传文件的文本正文（文档解析出的 Markdown 优先，文本类原文件兜底）。`
      + `单次最多 ${PLANNER_DOCUMENT_READ_LIMIT} 字符，超出用 offset/limit 分页；fileEntryId 先用 workspace_files_list 查。`
      + (mainAgent
        ? "文本类文件（md/txt/csv 等）的内容问题用本工具读正文回答；Office/PDF 附件仍走 document_analysis。"
        : "编排阶段素材已定型，不需要再读。"),
    parameters: {
      type: "object",
      properties: {
        fileEntryId: { type: "string", minLength: 1, maxLength: 128, description: "workspace_files_list 返回的 fileEntryId" },
        offset: { type: "integer", minimum: 0, description: "正文字符偏移（分页时传上一页返回的 nextOffset）" },
        limit: { type: "integer", minimum: 1, description: `本次返回字符数上限（缺省 ${PLANNER_DOCUMENT_READ_LIMIT}）` },
      },
      required: ["fileEntryId"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(input, params) {
      if (!mainAgent && subagentPhase(input) === "arrange") {
        return {
          content: JSON.stringify({
            skipped: true,
            reason: "编排阶段的结构化输入 draftPages 已包含全部页内容，禁止再读工作区文件；直接基于输入产出方案。",
          }),
          details: { skipped: true },
        };
      }
      const fileEntryId = typeof params.fileEntryId === "string" ? params.fileEntryId.trim() : "";
      if (!fileEntryId) {
        return { content: JSON.stringify({ error: "缺少 fileEntryId；先调用 workspace_files_list 按文件名查清单。" }) };
      }
      const file = await readText(fileEntryId);
      if (!file) {
        return {
          content: JSON.stringify({
            error: "文件不存在或没有可读的文本内容（图片与未解析的二进制不可读）；用 workspace_files_list 核对 fileEntryId。",
          }),
        };
      }
      const total = file.text.length;
      const requestedLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : PLANNER_DOCUMENT_READ_LIMIT;
      const limit = Math.max(1, Math.min(requestedLimit, PLANNER_DOCUMENT_READ_LIMIT));
      const offset = typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset >= 0 ? Math.floor(params.offset) : 0;
      const start = Math.min(offset, total);
      const end = Math.min(start + limit, total);
      const text = file.text.slice(start, end);
      return {
        content: JSON.stringify({
          fileEntryId,
          filename: file.filename,
          text,
          offset: start,
          totalCharacters: total,
          truncated: start > 0 || end < total,
          ...(end < total ? { nextOffset: end } : {}),
        }),
      };
    },
  };
}

export function createSlidesPlannerAgentTools(deps: {
  /** createDocumentPiTools 的产物（取文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
  /** createWorkspaceFilesPiTools 的产物；planner 用于定位用户上传的资料文件。 */
  workspaceFileTools?: PiAgentRuntimeTool[];
  /** 读工作区上传文件的文本正文（createWorkspaceFileTextReader 装配注入）。 */
  readWorkspaceFileText?: (fileEntryId: string) => Promise<WorkspaceFileText | null>;
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.documentTools, SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST)
      .map((tool) => (tool.name === "document_read" ? createPlannerDocumentReadTool(tool) : tool)),
    ...filterTools(deps.webSearchTools, SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST),
    ...filterTools(deps.workspaceFileTools ?? [], SLIDES_PLANNER_WORKSPACE_TOOL_ALLOWLIST),
    ...(deps.readWorkspaceFileText ? [createWorkspaceFileReadTool(deps.readWorkspaceFileText)] : []),
    // 配图预热：编排中生图入池（模块内 token 注册表寻址，装配无额外依赖）。
    ...filterTools(createSlidesImagePrewarmTools(), SLIDES_PLANNER_PREWARM_TOOL_ALLOWLIST),
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

/** 同一 run 连续校验上限：超过后网关收下当前树并要求提交（落页侧仍会重新量测并记录缺陷）。 */
const LAYOUT_VALIDATE_MAX_ROUNDS = 5;
/** runId → 已执行的 validate 轮次（工具实例跨 run 共享，需按 run 隔离并清理）。 */
const validateRoundByRun = new Map<string, number>();

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
    + "ok=true 才可用 subagent_submit_result 提交；有缺陷按 hint 修正后重交整棵树，按系统提示词的修复预算执行。",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "输入里的 deckToken，原样传入（网关据此取本 deck 的布局契约）" },
      tree: { type: "object", description: "布局树（v1：role/title?/dark?/bg?/direction(row|column|overlay)/weights?/gapScale?/pad?/children；v2：version:2 + composition + grid? + nodes（slot/bleed/text token/runs/stats/chart/table/component；component 可带 style 语义枚举，surface/separator/align/density/numeral/accent/motif））" },
    },
    required: ["token", "tree"],
    additionalProperties: false,
  },
  executionMode: "sequential",
  async execute(input, params) {
    const round = (validateRoundByRun.get(input.runId) ?? 0) + 1;
    const outcome = validateLayoutTree(params.token, params.tree);
    if (outcome.ok) {
      validateRoundByRun.delete(input.runId);
      return { content: JSON.stringify(outcome) };
    }
    // 网关收口：同一 run 连续多轮 validate 不收敛时不再让模型空转（实测一页
    // 连调 17 次 validate 打穿工具预算、480s 超时）。收下当前树并提示提交——
    // forcedSubmission 只代表网关收树，不证明缺陷已修复；落页侧 finalizeTree 会
    // 重新量测并记录剩余缺陷（v2 不做字号降档），由模型在 notes 里如实上报。
    if (round >= LAYOUT_VALIDATE_MAX_ROUNDS) {
      validateRoundByRun.delete(input.runId);
      return {
        content: JSON.stringify({
          ...outcome,
          ok: true,
          forcedSubmission: true,
          warning: `已连续 ${round} 轮校验未完全收敛；网关收下当前树。请立即调用 subagent_submit_result 提交，并在结果 notes 中如实记录未解决的缺陷，不要再校验。`,
        }),
      };
    }
    validateRoundByRun.set(input.runId, round);
    if (validateRoundByRun.size > 1_000) {
      const oldest = validateRoundByRun.keys().next().value;
      if (typeof oldest === "string") validateRoundByRun.delete(oldest);
    }
    return { content: JSON.stringify({ ...outcome, round }) };
  },
};

/** layouter 的单页只读预览：编译 + 临时渲染 + VLM 设计审阅；不写当前 deck。 */
const PAGE_PREVIEW_TOOL: PiAgentRuntimeTool = {
  name: "slides_page_preview",
  label: "单页预览审阅",
  description:
    "把当前页的布局树编译成临时单页渲染图，返回确定性缺陷与设计审阅（层级/底色/视觉锚点/文字墙/对齐/拥挤/空白）。"
    + "只读，不写当前 deck；发现 major 问题时改树后最多再预览一次，再提交。",
  parameters: {
    type: "object",
    properties: {
      deckToken: { type: "string", description: "输入里的 deckToken，原样传入" },
      pageIndex: { type: "integer", minimum: 0, maximum: 23, description: "输入里的 pageIndex（0 基），原样传入" },
      tree: { type: "object", description: "当前页 v2 布局树" },
    },
    required: ["deckToken", "pageIndex", "tree"],
    additionalProperties: false,
  },
  executionMode: "sequential",
  async execute(_input, params) {
    const token = typeof params.deckToken === "string" ? params.deckToken : "";
    const context = getPagePreview(token);
    if (!context) {
      return { content: JSON.stringify({ skipped: true, reason: "预览渲染未配置；按 validate 结果直接提交" }) };
    }
    const pageIndex = typeof params.pageIndex === "number" ? params.pageIndex : -1;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= context.pageCount) {
      return { content: JSON.stringify({ ok: false, error: "pageIndex 不在本 deck 范围" }) };
    }
    const result = await context.render(params.tree, pageIndex);
    if (result.png) markPagePreviewed(token, pageIndex);
    const visual = result.visual;
    const visualIssues = visual && visual.status === "issues" ? visual.issues : [];
    return {
      content: JSON.stringify({
        ok: result.defects.length === 0 && visualIssues.every((issue) => issue.severity !== "major"),
        pageIndex,
        defects: result.defects.slice(0, 10).map((defect) => ({
          type: defect.type,
          detail: defect.detail,
          ...(defect.hint ? { hint: defect.hint } : {}),
        })),
        visual: visual
          ? visual.status === "issues"
            ? { status: "issues", issues: visualIssues.slice(0, 8) }
            : { status: visual.status, ...(visual.status === "skipped" || visual.status === "error" ? { reason: visual.reason } : {}) }
          : { status: "skipped", reason: "预览渲染未启用视觉审阅" },
        ...(result.error ? { renderError: result.error } : {}),
      }),
    };
  },
};

/** slides-layouter 的工具面：布局树校验 + 单页只读预览（一次 invocation 内设计+审页）。 */
export function createSlidesLayouterAgentTools(): PiAgentRuntimeTool[] {
  return [LAYOUTER_VALIDATE_TOOL, PAGE_PREVIEW_TOOL];
}

/**
 * slides 布局树类子代理（layouter/reviewer）的提交期校验：树必须过归一，否则拒收。
 * 真机 2026-10-17 深圳 deck 第 6 页：validate 三轮通过的是好树，提交时模型重抄 JSON
 * 抄丢了根节点 direction——坏树静默兜底成要点竖排。在 submit 处拒收（classifyFailure
 * 给一次可恢复重试），模型手里还是刚校验过的那棵树，重交即中。
 */
export function createSlidesTreeResultValidator(): SubagentResultValidator {
  return (_invocationInput, result) => {
    const tree = result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).tree
      : undefined;
    if (tree === undefined || tree === null) return;
    try {
      normalizeTree(tree);
    } catch (error) {
      throw new Error(`subagent_result_tree_invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
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
