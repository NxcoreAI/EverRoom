import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { SubagentResultValidator } from "./runtime-manager.js";

import { SLIDES_TOOL_NAMES } from "../documents/capabilities/office-plugin.js";
import { getDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { normalizeTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { measureDefects, type LayoutDefect } from "../slides-layout/tree/measure.js";
import { createSlidesImagePrewarmTools } from "./slides-page-images-prewarm.js";
import { checkSemanticBindings, checkSemanticRendered } from "./slides-semantic-bindings.js";
import type { SemanticPage } from "./slides-semantic-contract.js";

/**
 * slides 两段式子代理的工具面：
 * - slides-planner（方案）：只读取数面——**拒绝** slides 四件套（不落页）、
 *   写入类（write/patch）、调度类（agent_dispatch/agent_catalog——防子 Agent 自递归）、通知类。
 *   素材检索/配图预热都不在工具面：素材命中由网关按页预取（materialHits），
 *   配图预热由网关在批结果回来后统一入池，避免把编排预算耗在工具往返上。
 * - slides-builder（落页）：PPT 四件套独占——方案已带全部内容，检索类一律拒绝，
 *   杜绝落页阶段重新检索挤占逐页生成预算。策略集中在 allowlist，装配方传什么都先过滤再合并。
 */
const SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST = new Set([
  "document_list",
  "document_read",
]);

const SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);


const SLIDES_PLANNER_PREWARM_TOOL_ALLOWLIST = new Set(["slides_image_prewarm"]);

const SLIDES_BUILDER_TOOL_ALLOWLIST = new Set<string>(SLIDES_TOOL_NAMES);

/** planner 取数预算：draft 阶段需要背景，但单篇正文不该整篇进上下文。 */
const PLANNER_DOCUMENT_READ_LIMIT = 8_000;

/**
 * arrange 阶段会话检索硬上限（2026-10-23 实测：一批 7 页连查 66 次历史、
 * 始终不提交，最后 300s 超时）。超过上限直接返回 skip 指令，把模型推回提交。
 */
const PLANNER_ARRANGE_CONVERSATION_SEARCH_LIMIT = 2;
const PLANNER_CONVERSATION_SEARCH_TTL_MS = 10 * 60_000;
const plannerConversationSearchByRun = new Map<string, { count: number; expiresAt: number }>();

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
function compactPlannerDocumentRead(content: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return content;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return content;
  const record = payload as Record<string, unknown>;
  if (typeof record.markdown !== "string") return content;
  const compact: Record<string, unknown> = {
    documentId: record.documentId,
    title: record.title,
    version: record.version,
    markdown: record.markdown,
    markdownOffset: record.markdownOffset,
    markdownTotalCharacters: record.markdownTotalCharacters,
    markdownTruncated: record.markdownTruncated,
    ...(record.nextOffset !== undefined ? { nextOffset: record.nextOffset } : {}),
    note: "只读正文返回：不含编辑用 block 索引与补丁契约。继续读取时用 nextOffset 向下翻页，不要重复读取已覆盖的区间。",
  };
  return JSON.stringify(compact);
}

/**
 * 输入里已由网关预取**完整**正文的文档 ID（sourceDocuments，且未被预算截断）：
 * 再调 document_read 只会把同一篇正文重复塞回上下文，直接回 skipped 提示模型
 * 使用输入。被截断的文档不拦——planner 还需要用 offset/limit 读剩余部分。
 */
function prefetchedSourceDocumentIds(input: StartRuntimeRunInput): Set<string> {
  const structured = input.runtimeMetadata?.subagentInput;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return new Set();
  const documents = (structured as Record<string, unknown>).sourceDocuments;
  if (!Array.isArray(documents)) return new Set();
  const ids = documents
    .filter((document) => document !== null && typeof document === "object"
      && (document as Record<string, unknown>).truncated !== true)
    .map((document) => (document as Record<string, unknown>).documentId)
    .filter((documentId): documentId is string => typeof documentId === "string" && documentId.length > 0)
    .map((documentId) => documentId.toLowerCase());
  return new Set(ids);
}

function createPlannerDocumentReadTool(tool: PiAgentRuntimeTool): PiAgentRuntimeTool {
  return {
    ...tool,
    description: `${tool.description}（PPT 方案代理：只返回正文与分页元数据，不含 block 索引/编辑契约；单次最多 ${PLANNER_DOCUMENT_READ_LIMIT} 字符，用返回的 nextOffset 连续读取，不要重复读已覆盖区间；编排阶段内容已由输入给出，不需要再读；正文已在输入 sourceDocuments 里的文档不要重复读取。）`,
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
      const documentId = typeof params.documentId === "string" ? params.documentId.trim() : "";
      if (documentId && prefetchedSourceDocumentIds(input).has(documentId.toLowerCase())) {
        return {
          content: JSON.stringify({
            skipped: true,
            reason: "该文档正文已由网关预取在输入的 sourceDocuments 里，直接使用，不要重复读取；需要更多内容时从输入读取。",
          }),
          details: { skipped: true, documentId },
        };
      }
      const result = await tool.execute(input, { ...params, offset, limit }, signal, onUpdate);
      return { ...result, content: compactPlannerDocumentRead(result.content) };
    },
  };
}

/** 分批编排的配图预热由网关统一入池；模型若仍调用预热工具，直接跳过而不是报错耗轮次。 */
function createPlannerPrewarmTool(tool: PiAgentRuntimeTool): PiAgentRuntimeTool {
  return {
    ...tool,
    execute: async (input, params, signal, onUpdate) => {
      const structured = input.runtimeMetadata?.subagentInput;
      const batch = structured !== null && typeof structured === "object" && !Array.isArray(structured)
        ? (structured as Record<string, unknown>).arrangeBatch
        : undefined;
      if (batch !== undefined) {
        return {
          content: JSON.stringify({
            skipped: true,
            reason: "分批编排的配图预热由网关在批结果回来后统一处理；本批不需要调用预热工具，请直接产出并提交方案。",
          }),
          details: { skipped: true, phase: "arrange" },
        };
      }
      return tool.execute(input, params, signal, onUpdate);
    },
  };
}

/** arrange 阶段 conversation_search 限额：模型反复查历史而不提交时，明确推回产出。 */
function createPlannerConversationSearchTool(tool: PiAgentRuntimeTool): PiAgentRuntimeTool {
  return {
    ...tool,
    execute: async (input, params, signal, onUpdate) => {
      if (subagentPhase(input) !== "arrange") return tool.execute(input, params, signal, onUpdate);
      const now = Date.now();
      for (const [runId, entry] of plannerConversationSearchByRun) {
        if (entry.expiresAt <= now) plannerConversationSearchByRun.delete(runId);
      }
      const entry = plannerConversationSearchByRun.get(input.runId)
        ?? { count: 0, expiresAt: now + PLANNER_CONVERSATION_SEARCH_TTL_MS };
      entry.count += 1;
      entry.expiresAt = now + PLANNER_CONVERSATION_SEARCH_TTL_MS;
      plannerConversationSearchByRun.set(input.runId, entry);
      if (entry.count > PLANNER_ARRANGE_CONVERSATION_SEARCH_LIMIT) {
        return {
          content: JSON.stringify({
            skipped: true,
            reason: "编排阶段的会话检索预算已用尽（最多 2 次）。draftPages/sources/materialHits 已是全部输入；不要继续检索历史，也不要等待用户确认配图或落页，直接产出本批方案并调用 subagent_submit_result。",
          }),
          details: { skipped: true, phase: "arrange" },
        };
      }
      return tool.execute(input, params, signal, onUpdate);
    },
  };
}

export function createSlidesPlannerAgentTools(deps: {
  /** createDocumentPiTools 的产物（取文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.documentTools, SLIDES_PLANNER_DOCUMENT_TOOL_ALLOWLIST)
      .map((tool) => (tool.name === "document_read" ? createPlannerDocumentReadTool(tool) : tool)),
    ...filterTools(deps.webSearchTools, SLIDES_PLANNER_WEB_SEARCH_TOOL_ALLOWLIST),
    // 配图预热：编排中生图入池（模块内 token 注册表寻址，装配无额外依赖）。
    // 分批编排的预热由网关统一处理：模型在批内调用预热工具时直接跳过，不耗轮次。
    ...filterTools(createSlidesImagePrewarmTools(), SLIDES_PLANNER_PREWARM_TOOL_ALLOWLIST)
      .map(createPlannerPrewarmTool),
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

/** 同一 run 连续校验上限：超过后网关收下当前树（落页时引擎 shrinkToFit 再收敛一次）。 */
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
  if (tree.version !== 2) {
    // 单一产出路径：v1 树没有写入路径，校验阶段就拦下，别让模型在 v1 上耗轮次后发现提交被拒。
    return {
      ok: false,
      defects: [{
        path: "root",
        type: "schema",
        detail: "提交的是 v1 树（direction/weights/children）；布局只有 v2 一种格式",
        hint: "改写成 v2 页面：version:2 + role + composition + grid? + nodes（slot 定位、37 个组件见技能文档）",
      }],
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
    + "单页最多调用 4 次，只用于提交前确认：第一次 ok=true 立即用 subagent_submit_result 提交，禁止再校验、再改树或再试其他构图变体。有缺陷按 hint 做最小修正；同一缺陷修 2 次仍在就简化结构后校验一次并提交，或交 blocked。",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "输入里的 deckToken，原样传入（网关据此取本 deck 的布局契约）" },
      tree: { type: "object", description: "v2 页面（唯一产出格式）：version:2 + role + composition + grid? + nodes（slot/bleed/text token/runs/image/icon/path/shape/stats/chart/table/component/group/connector；component 与 group 的 style/panel 语义枚举见技能文档）" },
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
    // 落页前 finalizeTree 仍会确定性 shrinkToFit + 引擎硬闸兜底，不会把坏树画上去。
    if (round >= LAYOUT_VALIDATE_MAX_ROUNDS) {
      validateRoundByRun.delete(input.runId);
      return {
        content: JSON.stringify({
          ...outcome,
          ok: true,
          forcedSubmission: true,
          warning: `已连续 ${round} 轮校验未完全收敛。不要再试新构图或继续微调——立即调用 subagent_submit_result 提交当前树（未解决缺陷如实写进结果 notes），提交后结束本页；不要再调用校验。`,
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
/** slides-layouter 的工具面：布局树校验 + 单页只读预览（一次 invocation 内设计+审页）。 */
export function createSlidesLayouterAgentTools(): PiAgentRuntimeTool[] {
  return [LAYOUTER_VALIDATE_TOOL];
}

/** 同一 invocation 连续提交失败的收口上限：超限后改走 blocked，避免 validate↔submit 空转撞墙钟。 */
const LAYOUT_SUBMIT_MAX_ATTEMPTS = 3;

/**
 * slides 布局树类子代理（layouter/reviewer）的提交期校验：树必须过归一，否则拒收。
 * 真机 2026-10-17 深圳 deck 第 6 页：validate 三轮通过的是好树，提交时模型重抄 JSON
 * 抄丢了根节点 direction——坏树静默兜底成要点竖排。在 submit 处拒收（classifyFailure
 * 给一次可恢复重试），模型手里还是刚校验过的那棵树，重交即中。
 */
export function createSlidesTreeResultValidator(): SubagentResultValidator {
  /** invocationInput 对象在整条 invocation 生命周期内复用，用它做提交失败计数器的 key。 */
  const rejections = new WeakMap<object, number>();
  return (invocationInput, result) => {
    if (result.status === "blocked") return;
    const input = invocationInput as { content?: SemanticPage; materials?: Array<{ url: string }>; deckToken?: string } | null;
    const counterKey = typeof invocationInput === "object" && invocationInput !== null ? invocationInput : null;
    const tree = result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).tree
      : undefined;
    if (tree === undefined || tree === null) {
      if (input?.content) throw new Error("subagent_result_tree_invalid: 缺少布局树");
      return;
    }
    if (input?.content?.notes?.trim() && typeof tree === "object" && tree !== null && !Array.isArray(tree)) {
      // 讲稿的唯一权威是内容契约 content.notes：模型改写/追加（「标注为」、编排提示）不该让提交
      // 永远失败。落页编译用的是同一棵树，这里改写的正是最终写进 PPTX notesSlide 的文本。
      (tree as Record<string, unknown>).notes = input.content.notes;
    }
    let normalized;
    try {
      normalized = normalizeTree(tree);
    } catch (error) {
      throw new Error(`subagent_result_tree_invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (normalized.version !== 2) {
      throw new Error("subagent_result_tree_invalid: 提交的树不是 v2 页面（缺少 version: 2）——布局只有 v2 一种格式");
    }
    if (input?.content) {
      const errors = checkSemanticBindings(input.content, normalized.v2, result, (input.materials ?? []).map(m => m.url));
      const context = getDeckLayoutContext(input.deckToken);
      if (context) errors.push(...checkSemanticRendered(input.content, compileTree(normalized, context.contract).spec));
      if (errors.length) {
        const attempts = counterKey ? (rejections.get(counterKey) ?? 0) + 1 : 1;
        if (counterKey) rejections.set(counterKey, attempts);
        if (attempts >= LAYOUT_SUBMIT_MAX_ATTEMPTS) {
          throw new Error(`subagent_result_content_unrecoverable: 连续 ${attempts} 次提交未通过内容契约（${errors.slice(0, 3).join("; ")}）。不要再用 done 重交；如需上游补内容，改用 status:"blocked" 并给出 reason/attempts/requestedAction。`);
        }
        throw new Error(`subagent_result_content_invalid: ${errors.join("; ")}`);
      }
      if (counterKey) rejections.delete(counterKey);
    }
  };
}

