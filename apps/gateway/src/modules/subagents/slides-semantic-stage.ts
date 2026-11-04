import type { SubagentInvocation } from "@nxcore/agent-contract";
import { checkSemanticStoryboard, numbersInText, semanticHash, type ContentSource, type SemanticPage, type SemanticReport, type SemanticStoryboard } from "./slides-semantic-contract.js";

export const SEMANTIC_MODE = "semantic-v3";
export interface SemanticContext { mode: typeof SEMANTIC_MODE; revision: 1; sources: ContentSource[]; sourceHash: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * planner 输出确定性归位：模型常把 role/message 写在 page 级、并省略空数组/
 * 默认约束，严格 Schema 会在 submit 处反复拒收（2026-10-23 实测 5 次
 * subagent_submit_result 失败）。这里把可推导的字段补到 content，schema 只保留
 * 真正的内容字段必填；语义校验仍在归位后执行，不会放过错误内容。
 */
function normalizePlannerPages(pages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return pages.map((raw) => {
    const page: Record<string, unknown> = { ...raw };
    const content = asRecord(page.content);
    if (!content) return page;
    const pageRole = typeof page.role === "string" && page.role.trim() ? page.role.trim() : null;
    const pageMessage = typeof page.message === "string" && page.message.trim() ? page.message : null;
    if (typeof content.role !== "string" && pageRole) content.role = pageRole;
    if (typeof content.message !== "string" && pageMessage) content.message = pageMessage;
    if (typeof page.role !== "string" && typeof content.role === "string") page.role = content.role;
    if (!Array.isArray(content.relations)) content.relations = [];
    if (!Array.isArray(content.omissions)) content.omissions = [];
    const constraints = asRecord(content.constraints);
    if (!constraints || !Array.isArray(constraints.verbatimRefs)) content.constraints = { verbatimRefs: [] };
    if (typeof content.notes !== "string") content.notes = "";
    if (!Array.isArray(content.focusRefs) || content.focusRefs.length === 0) {
      const blocks = Array.isArray(content.blocks) ? content.blocks : [];
      const first = blocks.map(asRecord).find((block) => typeof block?.id === "string");
      content.focusRefs = first ? [String(first.id)] : [];
    }
    page.content = content;
    return page;
  });
}

/**
 * 语义校验前的确定性修复（不调模型）：
 * - 可选来源以 omissions disposition="notes" 转讲稿时，若 notes 未包含来源原文，直接补回；
 * - 单来源 text block 的数值不在来源里（典型是模型"顺手改错字"引入 1-00→1-100），
 *   用来源原文替换该 block，保证数字保真且必留内容完整。
 * 修复后仍走严格 checkSemanticStoryboard；这里只处理可确定还原的情况。
 */
function repairDeterministicSemanticDefects(
  pages: Array<Record<string, unknown>>,
  sources: ContentSource[],
): string[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const warnings: string[] = [];
  for (const [index, page] of pages.entries()) {
    const content = asRecord(page.content);
    if (!content) continue;
    let notes = typeof content.notes === "string" ? content.notes : "";
    const omissions = Array.isArray(content.omissions) ? content.omissions : [];
    for (const raw of omissions) {
      const omission = asRecord(raw);
      if (!omission || omission.disposition !== "notes") continue;
      const source = byId.get(String(omission.sourceRef ?? ""));
      if (!source || notes.includes(source.value)) continue;
      notes = `${notes}${notes ? "\n\n" : ""}${source.value}`.slice(0, 16_000);
      warnings.push(`第 ${index + 1} 页: 讲稿已补回来源原文`);
    }
    content.notes = notes;
    const blocks = Array.isArray(content.blocks) ? content.blocks : [];
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (!block || block.type !== "text") continue;
      const refs = Array.isArray(block.sourceRefs)
        ? block.sourceRefs.filter((ref): ref is string => typeof ref === "string")
        : [];
      if (refs.length !== 1) continue;
      const source = byId.get(refs[0]!);
      if (!source) continue;
      const text = typeof block.text === "string" ? block.text : "";
      const sourceNumbers = new Set(numbersInText(source.value));
      if (!numbersInText(text).some((number) => !sourceNumbers.has(number))) continue;
      block.text = source.value;
      warnings.push(`第 ${index + 1} 页: block ${String(block.id ?? "")} 数值与来源不符，已按来源原文恢复`);
    }
  }
  return warnings;
}

export async function assembleSemanticPlan(args: {
  plan: Record<string, unknown>;
  instruction: string;
  roomId: string;
  repair(input: Record<string, unknown>, round: number): Promise<SubagentInvocation>;
}): Promise<{ plan: Record<string, unknown>; storyboard: SemanticStoryboard; report: SemanticReport; draftHash: string }> {
  const context = args.plan.contentContext as SemanticContext;
  if (!context || context.mode !== SEMANTIC_MODE || context.revision !== 1 || !Array.isArray(context.sources)
    || context.sourceHash !== semanticHash(context.sources)) throw new Error("semantic_source_context_invalid");
  const planPages = normalizePlannerPages(args.plan.pages as Array<Record<string, unknown>>);
  const deterministicWarnings = repairDeterministicSemanticDefects(planPages, context.sources);
  const sourcePageIds = [...new Set(context.sources.map(s => s.pageId))];
  const sourceOwners = new Map(context.sources.map(s => [s.id, s.pageId]));
  const identityWarnings: string[] = [];
  let pages = planPages.map((p, index) => {
    const page = p.content as SemanticPage | undefined;
    const expected = sourcePageIds[index];
    if (!page || !expected || page.id === expected || sourcePageIds.includes(page.id)) return page;
    const refs = [page.sourceRefs, ...(Array.isArray(page.blocks) ? page.blocks.map(b => b.sourceRefs) : []),
      page.constraints?.verbatimRefs, ...(Array.isArray(page.omissions) ? page.omissions.map(o => [o.sourceRef]) : [])];
    // Canonicalize only an invented identity whose complete provenance confirms the original position.
    if (!Array.isArray(page.sourceRefs) || !page.sourceRefs.length || refs.some(r => !Array.isArray(r)
      || r.some(ref => sourceOwners.get(ref) !== expected))) return page;
    identityWarnings.push(`第 ${index + 1} 页: 已按确认来源规范页面 ID`);
    return { ...page, id: expected };
  });
  let report = checkSemanticStoryboard(pages, context.sources);
  for (let round = 0; round < 2 && !report.passed; round++) {
    const errorsForPage = (i: number) => report.errors.filter(e => e.startsWith(`第 ${i + 1} 页:`)
      || (sourcePageIds[i] && e.includes(sourcePageIds[i]))
      || (!e.startsWith("第 ") && !sourcePageIds.some(id => e.includes(id))));
    const indexes = pages.map((page, i) => ({ page, i })).filter(({ i }) => errorsForPage(i).length).slice(0, 4);
    const repairPageIds = indexes.map(({ i }) => sourcePageIds[i]!);
    const pageErrors = indexes.map(({ i }) => errorsForPage(i));
    const defects: string[] = [];
    // Give every selected page a defect before filling the remaining bounded feedback budget.
    for (let depth = 0; defects.length < 12 && pageErrors.some(e => e.length > depth); depth++) {
      for (const [index, errors] of pageErrors.entries()) {
        if (errors[depth] && defects.length < 12) defects.push(`[${repairPageIds[index]}] ${errors[depth]}`.slice(0, 300));
      }
    }
    const invocation = await args.repair({
      contentMode: SEMANTIC_MODE, instruction: args.instruction, roomId: args.roomId,
      title: args.plan.title, draftPages: [], sources: context.sources.filter(s => repairPageIds.includes(s.pageId)),
      priorStoryboard: { schemaVersion: "storyboard/v3", pages: indexes.map(({ page }) => page) },
      repairPageIds, defects,
    }, round);
    const result = invocation.result?.structuredOutput as Record<string, unknown> | undefined;
    if (invocation.status !== "completed" || result?.schemaVersion !== "storyboard/v3" || !Array.isArray(result.pages)) break;
    pages = pages.map((page, i) => {
      const allowed = indexes.findIndex(item => item.i === i);
      return allowed < 0 ? page : (result.pages as SemanticPage[]).find(p => p.id === repairPageIds[allowed]) ?? page;
    });
    report = checkSemanticStoryboard(pages, context.sources);
  }
  if (!report.passed) throw new Error(`semantic_content_invalid: ${report.errors.slice(0, 4).join("; ")}`);
  report.warnings.push(...identityWarnings, ...deterministicWarnings);
  const valid = pages as SemanticPage[];
  const storyboard: SemanticStoryboard = { schemaVersion: "storyboard/v3", title: String(args.plan.title ?? ""), pages: valid, sources: context.sources };
  const plan = { ...args.plan, pages: planPages.map((page, i) => ({
    ...page, layoutVersion: 2, content: valid[i], role: valid[i]!.role,
    neighbors: valid.slice(Math.max(0, i - 1), i + 2).filter(p => p.id !== valid[i]!.id).map(p => ({ role: p.role, message: p.message })),
  })) };
  // A separate namespace prevents legacy saves and differing styles/assets/configurations overwriting experiments.
  return { plan, storyboard, report, draftHash: `semantic-v3:${semanticHash({ context, plan, instruction: args.instruction })}` };
}
