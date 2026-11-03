import type {
  JournalAction,
  JournalBullet,
  JournalComposition,
  JournalSignal,
} from "./types.js";

/**
 * 每日洞察的「提炼」：把当天信号写成一段给人看的日记。
 *
 * 三条硬规矩（对应 docs/daily-journal-plan.zh-CN.md §4.3）：
 * 1. **不编造**：模型只能引用给它的证据；`sourceIds`/`targetId` 必须能在输入集合里查到，
 *    查不到直接丢——这是「洞察」与「幻觉」的分界线，不能靠模型自觉。
 * 2. **不评价**：日记是记录与提醒，不是夸人。提示词禁止「做得好/加油」这类话。
 * 3. **有兜底**：模型档位没就绪或解析失败时，用确定性模板产出可读文案，
 *    并且标记 `model = null`，让 UI 不要把这行字说成"AI 生成"。
 */

const HEADLINE_LIMIT = 16;
const SUMMARY_LIMIT = 220;
const BULLET_TEXT_LIMIT = 36;
const MAX_BULLETS = 3;
const MAX_ACTIONS = 2;
const ACTION_LABEL_LIMIT = 10;
/** prompt 里证据正文的总预算。 */
const PROMPT_BODY_LIMIT = 2400;

export interface ComposeJournalResult {
  composition: JournalComposition;
  /** 产出该稿的模型名；null = 模板兜底。 */
  model: string | null;
}

export interface ComposeJournalOptions {
  /** 记忆提炼同款模型调用（`generateMemoryText`）。 */
  generate: (prompt: string) => Promise<string>;
  /** 档位未就绪时抛它（不计入重试、直接走模板兜底）。 */
  isModelUnavailable?: (error: unknown) => boolean;
  /** 模型名（写进条目，便于排查"这版是谁写的"）。 */
  modelName?: string;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

function clampText(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 提示词：证据逐条列清（id 显式给出，模型才知道该回填什么）。 */
export function buildJournalPrompt(date: string, signals: readonly JournalSignal[]): string {
  let budget = PROMPT_BODY_LIMIT;
  const lines: string[] = [];
  for (const signal of signals) {
    const meta = [
      signal.category === "lesson" ? "经验" : signal.category === "fact" ? "事实" : "记忆",
      signal.confidence ?? "observed",
      `权重${signal.weight.toFixed(2)}`,
      signal.merged > 0 ? `合并了${signal.merged + 1}条` : "",
    ].filter(Boolean).join("·");
    const body = signal.excerpt.length > budget
      ? `${signal.excerpt.slice(0, Math.max(0, budget - 1))}…`
      : signal.excerpt;
    if (body.length === 0) continue;
    budget -= body.length;
    lines.push(`- [id=${signal.id}] (${meta}) ${body}`);
    if (budget <= 0) break;
  }

  return `你是用户工作台里的日记助理。下面是「${date}」这天记下的长期记忆条目，全部是真实发生过的。

请写一段今日日记摘要，只用下面给出的内容，不要补充任何未出现的事实、不要推测动机。

要求：
1. headline：不超过 ${HEADLINE_LIMIT} 个字，概括今天记下的重点；不要写「今日总结」「值得记录」这类空话。
2. summary：2–4 句，助理口吻（「你今天…」「我记下了…」），点名具体内容；不要评价、不要夸奖、不要建议式说教。
3. bullets：1–${MAX_BULLETS} 条，每条不超过 ${BULLET_TEXT_LIMIT} 个字，必须能在下面条目里找到依据，
   并在 sourceIds 里回填对应条目的 id（形如 memory:xxxx）。
4. actions：0–${MAX_ACTIONS} 条，kind 只能是 "ask-agent"，targetId 必须是下面出现过的 id。
5. 如果下面的条目彼此无关，宁可只说最重的那 1–2 条，不要硬拗成一段故事。

只输出 JSON，不要代码块围栏、不要解释：
{"headline":"…","summary":"…","bullets":[{"text":"…","sourceIds":["memory:xxx"]}],"actions":[{"label":"…","kind":"ask-agent","targetId":"memory:xxx"}]}

今天的记忆条目（共 ${signals.length} 条）：
${lines.join("\n")}`;
}

/** 从模型输出里抠出 JSON 对象（容忍围栏与前后废话）。 */
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

/**
 * 校验并清洗模型输出。
 *
 * 逐字段丢弃而不是整条失败：模型经常"大体对、个别 id 编了"，
 * 为一个坏 id 丢掉整段文案不值当；但**只剩空壳**时返回 null，交给模板兜底。
 */
export function parseJournalComposition(
  raw: string,
  signals: readonly JournalSignal[],
): JournalComposition | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const allowed = new Set(signals.map((signal) => signal.id));
  const headline = clampText(record.headline, HEADLINE_LIMIT);
  const summary = clampText(record.summary, SUMMARY_LIMIT);
  if (!headline || !summary) return null;

  const bullets: JournalBullet[] = [];
  const rawBullets = Array.isArray(record.bullets) ? record.bullets : [];
  for (const item of rawBullets) {
    if (bullets.length >= MAX_BULLETS) break;
    if (!item || typeof item !== "object") continue;
    const bullet = item as Record<string, unknown>;
    const text = clampText(bullet.text, BULLET_TEXT_LIMIT);
    if (!text) continue;
    const sourceIds = (Array.isArray(bullet.sourceIds) ? bullet.sourceIds : [])
      .filter((id): id is string => typeof id === "string" && allowed.has(id));
    // 没有任何可追溯来源的要点直接丢：这是防编造的最后一道闸。
    if (sourceIds.length === 0) continue;
    bullets.push({ text, sourceIds: [...new Set(sourceIds)] });
  }

  const actions: JournalAction[] = [];
  const rawActions = Array.isArray(record.actions) ? record.actions : [];
  for (const item of rawActions) {
    if (actions.length >= MAX_ACTIONS) break;
    if (!item || typeof item !== "object") continue;
    const action = item as Record<string, unknown>;
    const label = clampText(action.label, ACTION_LABEL_LIMIT);
    const targetId = typeof action.targetId === "string" ? action.targetId : "";
    if (!label || action.kind !== "ask-agent" || !allowed.has(targetId)) continue;
    actions.push({ label, kind: "ask-agent", targetId });
  }

  // 一条要点都没有的"洞察"没有价值（模型只给了标题和空话），让模板兜底。
  if (bullets.length === 0) return null;
  return { headline, summary, bullets, actions };
}

/**
 * 模板兜底：模型不可用时仍然给用户一条真实、可读的记录。
 *
 * 刻意不写得像模型：只说「记下了什么」，不做串联与推断；
 * 调用方会把 `model` 落成 null，UI 据此不宣称是 AI 生成。
 */
export function templateComposition(
  date: string,
  signals: readonly JournalSignal[],
): JournalComposition {
  const lessons = signals.filter((signal) => signal.category === "lesson").length;
  const facts = signals.length - lessons;
  const count = signals.reduce((total, signal) => total + 1 + signal.merged, 0);

  const headline = clampText(
    facts > 0 && lessons > 0
      ? `今天记下 ${count} 条`
      : lessons > 0
        ? `今天记下 ${count} 条经验`
        : `今天记下 ${count} 条事实`,
    HEADLINE_LIMIT,
  );

  const bodies = signals.slice(0, 2).map((signal) => signal.excerpt.replace(/[。；;]\s*$/, ""));
  const summary = clampText(
    bodies.length > 0
      ? `今天是 ${date}。${bodies.join("；")}。这些都已经写进记忆库，下次起草时会自动用上。`
      : `今天是 ${date}，还没有新的记忆条目。`,
    SUMMARY_LIMIT,
  );

  const bullets: JournalBullet[] = signals.slice(0, MAX_BULLETS).map((signal) => ({
    text: clampText(signal.title, BULLET_TEXT_LIMIT),
    sourceIds: [signal.id],
  }));

  return { headline, summary, bullets, actions: [] };
}

/**
 * 提炼入口：先试模型，失败/不可用/解析不出一律回退模板。
 *
 * 返回的 `model` 是"这稿到底谁写的"的唯一依据，不允许调用方猜。
 */
export async function composeJournal(
  input: { date: string; signals: readonly JournalSignal[] },
  options: ComposeJournalOptions,
): Promise<ComposeJournalResult> {
  const logger = options.logger ?? (() => {});
  const fallback = (): ComposeJournalResult => ({
    composition: templateComposition(input.date, input.signals),
    model: null,
  });

  if (input.signals.length === 0) return fallback();

  try {
    const raw = await options.generate(buildJournalPrompt(input.date, input.signals));
    const composition = parseJournalComposition(raw, input.signals);
    if (!composition) {
      logger("warn", "journal.compose.unparsable", {
        date: input.date,
        signals: input.signals.length,
        chars: raw.length,
      });
      return fallback();
    }
    return { composition, model: options.modelName ?? "memory-slot" };
  } catch (error) {
    const unavailable = options.isModelUnavailable?.(error) ?? false;
    logger(unavailable ? "warn" : "error", "journal.compose.failed", {
      date: input.date,
      signals: input.signals.length,
      unavailable,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
}
