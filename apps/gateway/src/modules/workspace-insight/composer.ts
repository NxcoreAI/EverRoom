import type { AgentSession } from "@nxcore/agent-contract";

/**
 * 工作空间洞察的「提炼」：把空间状态证据写成总结 + 建议（LLM 优先，模板兜底）。
 *
 * 与 journal/composer.ts 同一套硬规矩：
 * 1. **不编造**：模型只能引用证据里出现的工作标题与数字；`sourceSessionId`
 *    必须能在输入集合里查到，查不到整条建议丢弃。
 * 2. **是总结不是复述**：输出必须是对空间状态与变化的归纳 + 可执行建议，
 *    禁止照抄某条正文原句充当洞察（引用限一句话且要带归纳）。
 * 3. **有兜底**：模型档位未就绪/调用失败/解析失败时，用确定性模板产出
 *    （状态分布 + 条件触发的建议），并标 `model: null`，UI 不宣称 AI 生成。
 */

export interface WorkspaceInsightEvidenceSession {
  id: string;
  title: string;
  status: AgentSession["status"];
  /** 相对时间描述（「12 分钟前」），由调用方格式化。 */
  updatedLabel: string;
  /** 最后一条 assistant 正文的截断（≤160 字）；没有为 null。 */
  lastText: string | null;
}

export interface WorkspaceInsightEvidence {
  workspaceId: string;
  workspaceName: string;
  sessions: readonly WorkspaceInsightEvidenceSession[];
  /** 资料库规模；未就绪为 null（prompt 与模板都不提文件）。 */
  inventory: { library: number; artifacts: number; total: number } | null;
}

export interface WorkspaceInsightAdvice {
  text: string;
  /** 建议指向的工作（证据校验用 + UI 可跳转）；无指向为 null。 */
  sessionId: string | null;
}

export interface WorkspaceInsightComposition {
  /** 2–3 句状态总结（分布 + 变化）。 */
  summary: string;
  /** 0–2 条建议（可执行、指向真实工作）。 */
  advice: WorkspaceInsightAdvice[];
  /** 产出该稿的模型名；null = 模板兜底。 */
  model: string | null;
}

const SUMMARY_LIMIT = 180;
const ADVICE_TEXT_LIMIT = 48;
const MAX_ADVICE = 2;
/** prompt 里证据正文的预算。 */
const PROMPT_BODY_LIMIT = 1200;
const LAST_TEXT_EXCERPT = 160;

export interface ComposeWorkspaceInsightOptions {
  generate: (prompt: string) => Promise<string>;
  isModelUnavailable?: (error: unknown) => boolean;
  modelName?: string;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

function clampText(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function statusLabel(status: AgentSession["status"]): string {
  if (status === "running") return "在跑";
  if (status === "interrupted") return "待续";
  if (status === "closed") return "已完成";
  return "有新结果";
}

/** 状态分布行：「1 项在跑，2 项已完成」（与 renderer 确定性口径一致）。 */
export function evidenceStateLine(sessions: readonly WorkspaceInsightEvidenceSession[]): string {
  const order: Array<AgentSession["status"]> = ["running", "interrupted", "idle", "closed"];
  const parts = order
    .map((status) => {
      const count = sessions.filter((session) => session.status === status).length;
      return count > 0 ? `${count} 项${statusLabel(status)}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("，") : `${sessions.length} 项工作`;
}

export function buildWorkspaceInsightPrompt(evidence: WorkspaceInsightEvidence): string {
  const lines: string[] = [];
  let budget = PROMPT_BODY_LIMIT;
  for (const session of evidence.sessions.slice(0, 8)) {
    const excerpt = session.lastText
      ? session.lastText.length > LAST_TEXT_EXCERPT
        ? `${session.lastText.slice(0, LAST_TEXT_EXCERPT - 1)}…`
        : session.lastText
      : "";
    const body = excerpt.length > budget ? excerpt.slice(0, Math.max(0, budget - 1)) : excerpt;
    if (body.length > 0) budget -= body.length;
    lines.push(
      `- [id=${session.id}] 《${session.title}》(${statusLabel(session.status)}，${session.updatedLabel})${body ? ` 最近结果：${body}` : ""}`,
    );
    if (budget <= 0) break;
  }

  const inventoryLine = evidence.inventory
    ? `资料库 ${evidence.inventory.library} 份材料、${evidence.inventory.artifacts} 份产物。`
    : "";

  return `你是项目空间「${evidence.workspaceName}」的工作台助理。下面是这个空间当前的真实状态。

请写一段空间洞察：先总结状态与变化，再给建议。只用给出的信息，不要编造工作名、数字或结论。

要求：
1. summary：2–3 句。第一句概括工作分布与进展（可引用状态统计${inventoryLine ? "与资料库规模" : ""}），
   后面点名最值得注意的 1–2 件事（用《工作名》，不要罗列全部）。
   不要照抄任何「最近结果」的原句充当总结；引用限一句话且必须带你的归纳。
2. advice：0–${MAX_ADVICE} 条可执行的下一步建议，每条不超过 ${ADVICE_TEXT_LIMIT} 个字。
   每条建议在 sessionId 里回填它指向的工作 id（形如证据里的 [id=...]）；没有明确指向就填 null。
   建议必须从状态得出（在跑→等结果或中途补充要求、待续→继续跑、有新结果→去看一眼、
   全收尾→开新工作或归档）；不要空泛的「加油/继续保持」。
3. 不要评价用户、不要客套、不要免责声明。

只输出 JSON，不要代码块围栏、不要解释：
{"summary":"…","advice":[{"text":"…","sessionId":"…或null"}]}

空间状态（${evidence.sessions.length} 项工作：${evidenceStateLine(evidence.sessions)}。${inventoryLine}）：
${lines.join("\n")}`;
}

function extractJsonObject(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** 校验并清洗模型输出：建议指向的 sessionId 必须在证据集合里，编造的丢建议不丢整稿。 */
export function parseWorkspaceInsightComposition(
  raw: string,
  evidence: WorkspaceInsightEvidence,
): Omit<WorkspaceInsightComposition, "model"> | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const summary = clampText(record.summary, SUMMARY_LIMIT);
  if (!summary) return null;

  const allowed = new Set(evidence.sessions.map((session) => session.id));
  const advice: WorkspaceInsightAdvice[] = [];
  const rawAdvice = Array.isArray(record.advice) ? record.advice : [];
  for (const item of rawAdvice) {
    if (advice.length >= MAX_ADVICE) break;
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const text = clampText(entry.text, ADVICE_TEXT_LIMIT);
    if (!text) continue;
    const sessionId = typeof entry.sessionId === "string" && allowed.has(entry.sessionId)
      ? entry.sessionId
      : null;
    advice.push({ text, sessionId });
  }

  return { summary, advice };
}

/** 工作名截断：模板建议行保持可读。 */
function shortTitle(title: string): string {
  return title.length > 16 ? `${title.slice(0, 15)}…` : title;
}

/**
 * 模板兜底：模型不可用时的确定性产物（与 renderer 旧版聚合口径一致）。
 *
 * 只陈述真实分布，建议由状态条件触发；不串联、不推断。
 */
export function templateWorkspaceInsightComposition(
  evidence: WorkspaceInsightEvidence,
): Omit<WorkspaceInsightComposition, "model"> {
  const { sessions } = evidence;
  const latest = sessions[0] ?? null;
  const running = sessions.filter((session) => session.status === "running");
  const interrupted = sessions.filter((session) => session.status === "interrupted");
  const closed = sessions.filter((session) => session.status === "closed");
  const idleCount = sessions.length - running.length - interrupted.length - closed.length;

  // 空间没有工作：洞察没有可总结的状态，交给渲染层显示空态文案。
  if (sessions.length === 0) return { summary: "", advice: [] };

  const summaryParts = [
    `${sessions.length} 项工作：${evidenceStateLine(sessions)}。`,
    evidence.inventory ? `资料库 ${evidence.inventory.total} 个文件。` : "",
  ].filter(Boolean);

  const advice: WorkspaceInsightAdvice[] = [];
  if (running.length > 0) {
    const target = running[0]!;
    advice.push({ text: `《${shortTitle(target.title)}》正在跑，完成后结果会汇总在这里。`, sessionId: target.id });
  }
  if (interrupted.length > 0) {
    advice.push({ text: `《${shortTitle(interrupted[0]!.title)}》被中断过，要不要让它接着跑？`, sessionId: interrupted[0]!.id });
  }
  if (advice.length === 0 && idleCount > 0 && latest && latest.lastText) {
    advice.push({ text: `《${shortTitle(latest.title)}》有你没细看的结果，值得过一眼。`, sessionId: latest.id });
  }
  if (advice.length === 0 && sessions.length >= 2 && sessions.length === closed.length) {
    advice.push({ text: "这一轮工作都收尾了，适合开下一项或整理归档。", sessionId: null });
  }
  if (advice.length === 0 && latest?.lastText) {
    const firstSentence = latest.lastText.split(/(?<=[。？！?])/)[0]?.trim() ?? latest.lastText;
    advice.push({
      text: `最近进展：${firstSentence.length > 40 ? `${firstSentence.slice(0, 39)}…` : firstSentence}`,
      sessionId: latest.id,
    });
  }

  return { summary: summaryParts.join(""), advice: advice.slice(0, MAX_ADVICE) };
}

/**
 * 提炼入口：先试模型，失败/不可用/解析不出一律回退模板。
 * 返回的 `model` 是「这稿谁写的」的唯一依据。
 */
export async function composeWorkspaceInsight(
  evidence: WorkspaceInsightEvidence,
  options: ComposeWorkspaceInsightOptions,
): Promise<WorkspaceInsightComposition> {
  const logger = options.logger ?? (() => {});
  const fallback = (): WorkspaceInsightComposition => ({
    ...templateWorkspaceInsightComposition(evidence),
    model: null,
  });

  if (evidence.sessions.length === 0) return fallback();

  try {
    const raw = await options.generate(buildWorkspaceInsightPrompt(evidence));
    const composition = parseWorkspaceInsightComposition(raw, evidence);
    if (!composition) {
      logger("warn", "workspace-insight.compose.unparsable", {
        workspaceId: evidence.workspaceId,
        sessions: evidence.sessions.length,
        chars: raw.length,
      });
      return fallback();
    }
    return { ...composition, model: options.modelName ?? "memory-slot" };
  } catch (error) {
    const unavailable = options.isModelUnavailable?.(error) ?? false;
    logger(unavailable ? "warn" : "error", "workspace-insight.compose.failed", {
      workspaceId: evidence.workspaceId,
      unavailable,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
}
