/**
 * PPT 落页视觉复检（多样性三步走·第一步「装眼睛」）：
 * set_page 落页成功后，向桌面端要该页的 1x 渲染 PNG（渲染层离屏栅格化，
 * 与用户所见一致），按封闭清单请 VLM 判定——只查客观可判项（裁切/重叠/
 * 压字/错位/对比度/失衡/变形），不做主观审美点评（VLM 的审美平庸且嘈杂）。
 * 复检是增强不是闸门：未配置 VLM / 截图失败 / 解析失败一律放行并记原因；
 * 同页最多触发一次重落，超限后仍不通过则放行并在结果中标记。
 */

import type { VlmPromptAnalyzer } from "../vision/vlm-client.js";

export interface VisualReviewIssue {
  item: string;
  where: string;
  severity: "major" | "minor";
}

export type VisualReviewOutcome =
  | { status: "pass" }
  | { status: "fail"; issues: VisualReviewIssue[]; retriesExhausted: boolean }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

/** 封闭清单：item 只允许这些值（提示词与解析共用同一词表）。 */
const REVIEW_ITEMS = [
  "text_clipped",
  "text_overlap",
  "text_on_image",
  "misalignment",
  "low_contrast",
  "imbalance",
  "image_distortion",
] as const;

const ITEM_LABELS: Record<(typeof REVIEW_ITEMS)[number], string> = {
  text_clipped: "文字被裁或超出画布",
  text_overlap: "文字互相重叠",
  text_on_image: "文字压在图片上难以阅读",
  misalignment: "元素明显错位不齐",
  low_contrast: "文字与底色对比度过低",
  imbalance: "版面严重失衡（大片空白、内容挤在一角）",
  image_distortion: "图片严重变形或裁切错误",
};

const REVIEW_PROMPT = `你检查一张演示文稿页面的渲染截图，只判定以下客观缺陷，不评价审美或风格：

1. text_clipped：文字被裁断、贴出画布边缘、或超出所在容器。
2. text_overlap：两段文字互相重叠，无法正常阅读。
3. text_on_image：文字直接压在图片上且难以阅读（有深色遮罩的不算）。
4. misalignment：同组元素明显没对齐（左右边缘参差、行列歪斜）。
5. low_contrast：文字颜色与它所在底色太接近，读不清。
6. imbalance：版面严重失衡——大片空白同时内容挤在一角。
7. image_distortion：图片明显拉伸变形，或裁切掉了主体。

判定纪律：
- 每一项都要在截图里指认得出具体位置才允许报告；找不到具体位置就不报。
- 轻微的留白、居中与否、配色口味、字体风格一律不算缺陷。
- 不确定时判通过。

只输出一个 JSON 对象，不要输出任何其他文字：
{"pass": true}
或
{"pass": false, "issues": [{"item": "<上面七个英文键之一>", "where": "<一句话指出位置，如：左下角第二张卡片>", "severity": "major|minor"}]}
severity：major = 明显影响阅读或观感；minor = 轻微、可容忍。`;

export interface DesignReviewIssue {
  item: "weak_hierarchy" | "flat_background" | "no_visual_anchor" | "text_wall" | "misalignment" | "low_contrast" | "cramped" | "empty_space";
  where: string;
  severity: "major" | "minor";
}

export type DesignReviewOutcome =
  | { status: "pass" }
  | { status: "issues"; issues: DesignReviewIssue[] }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

const DESIGN_PROMPT = `你检查一张演示文稿页面的渲染截图，只判客观可指的版面问题，不做口味评价。

只允许以下问题：
1. weak_hierarchy：主标题、辅助信息、正文之间没有明显主次，阅读顺序混乱。
2. flat_background：整页纯白/纯色底，没有任何色块、线条、图形或图片承载信息。
3. no_visual_anchor：除了文字和表格，画面没有任何图标、图形、图片或数字视觉锚点。
4. text_wall：大段连续文字占满页面，缺少分段/表格/图形。
5. misalignment：同组元素的左右边缘或行列明显不齐。
6. low_contrast：文字与底色对比度不足，读不清。
7. cramped：表格/文字贴边或互相挤压，没有呼吸空间。
8. empty_space：内容挤在一角，同时出现大片无意义空白。

判定纪律：
- 每项必须在截图中指认具体位置；找不到具体位置就不报。
- 轻微的留白、居中、配色口味不算问题。
- 不确定时判通过。

只输出 JSON：{"pass":true} 或 {"pass":false,"issues":[{"item":"...","where":"一句话位置","severity":"major|minor"}]}`;

const MAX_VISUAL_RETRIES = 1;
const REVIEW_TIMEOUT_MS = 90_000;

function jsonText(content: string): string {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function parseVerdict(value: unknown): { pass: boolean; issues: VisualReviewIssue[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as { pass?: unknown; issues?: unknown };
  if (typeof input.pass !== "boolean") return null;
  if (input.pass) return { pass: true, issues: [] };
  if (!Array.isArray(input.issues) || input.issues.length === 0) return null;
  const issues: VisualReviewIssue[] = [];
  for (const raw of input.issues) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { item?: unknown; where?: unknown; severity?: unknown };
    if (typeof entry.item !== "string" || !REVIEW_ITEMS.includes(entry.item as (typeof REVIEW_ITEMS)[number])) continue;
    issues.push({
      item: entry.item,
      where: typeof entry.where === "string" ? entry.where.slice(0, 120) : "",
      severity: entry.severity === "major" ? "major" : "minor",
    });
  }
  if (issues.length === 0) return null;
  return { pass: false, issues };
}

export interface SlidesVisualReviewerDeps {
  /** VLM 分析器；null = 未配置，全部跳过。给函数则每次复检时惰性解析——
   *  设置页保存 vlm 段后 runtime config 热替换，无需重启网关。 */
  vlm: VlmPromptAnalyzer | null | (() => VlmPromptAnalyzer | null);
}

export class SlidesVisualReviewer {
  private readonly vlm: VlmPromptAnalyzer | null | (() => VlmPromptAnalyzer | null);
  /** 每 (fileId:slideIndex) 已复检次数——超限后放行。 */
  private readonly reviewCounts = new Map<string, number>();

  constructor(deps: SlidesVisualReviewerDeps) {
    this.vlm = deps.vlm;
  }

  private resolveVlm(): VlmPromptAnalyzer | null {
    return typeof this.vlm === "function" ? this.vlm() : this.vlm;
  }

  /** 新 deck 建文件时清掉旧计数（fileId 是产物库条目，正常不复用）。 */
  forgetDeck(fileId: string): void {
    for (const key of this.reviewCounts.keys()) {
      if (key.startsWith(`${fileId}:`)) this.reviewCounts.delete(key);
    }
  }

  /** 单页预览的设计审阅：只看客观版面问题，供 layouter 在一次 invocation 内自查。 */
  async reviewDesign(png: Buffer): Promise<DesignReviewOutcome> {
    const vlm = this.resolveVlm();
    if (!vlm) return { status: "skipped", reason: "vlm 未配置" };
    try {
      const raw = await vlm.analyze({ buffer: png, mime: "image/png" }, DESIGN_PROMPT, AbortSignal.timeout(REVIEW_TIMEOUT_MS));
      const value = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
      if (!value || typeof value.pass !== "boolean") return { status: "error", reason: "VLM 返回格式非法" };
      if (value.pass) return { status: "pass" };
      const issues: DesignReviewIssue[] = [];
      if (Array.isArray(value.issues)) {
        for (const rawIssue of value.issues) {
          if (!rawIssue || typeof rawIssue !== "object" || Array.isArray(rawIssue)) continue;
          const entry = rawIssue as Record<string, unknown>;
          const item = entry.item;
          if (typeof item !== "string" || !["weak_hierarchy", "flat_background", "no_visual_anchor", "text_wall", "misalignment", "low_contrast", "cramped", "empty_space"].includes(item)) continue;
          issues.push({
            item: item as DesignReviewIssue["item"],
            where: typeof entry.where === "string" ? entry.where.slice(0, 120) : "",
            severity: entry.severity === "major" ? "major" : "minor",
          });
        }
      }
      if (issues.length === 0) return { status: "pass" };
      return { status: "issues", issues };
    } catch (error) {
      return { status: "error", reason: `设计审阅失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async reviewPage(params: {
    fileId: string;
    slideIndex: number;
    fetchPng: () => Promise<Buffer>;
    /** 降档兜底等引擎侧已知的薄弱点，转成「重点核查」提示拼进复检 prompt。 */
    focusHints?: string[];
  }): Promise<VisualReviewOutcome> {
    const vlm = this.resolveVlm();
    if (!vlm) return { status: "skipped", reason: "vlm 未配置" };
    const key = `${params.fileId}:${params.slideIndex}`;
    const seen = this.reviewCounts.get(key) ?? 0;
    this.reviewCounts.set(key, seen + 1);
    let png: Buffer;
    try {
      png = await params.fetchPng();
    } catch (error) {
      return { status: "error", reason: `截图失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (png.byteLength === 0) return { status: "error", reason: "截图为空" };
    const prompt = params.focusHints?.length
      ? `${REVIEW_PROMPT}\n\n本页已知薄弱点（重点核查）：${params.focusHints.slice(0, 6).join("；")}`
      : REVIEW_PROMPT;
    try {
      const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
      const raw = await vlm.analyze({ buffer: png, mime: "image/png" }, prompt, signal);
      const verdict = parseVerdict(raw);
      if (!verdict) return { status: "error", reason: "复检结果解析失败（按通过处理）" };
      if (verdict.pass) return { status: "pass" };
      const retriesExhausted = seen >= MAX_VISUAL_RETRIES;
      return { status: "fail", issues: verdict.issues, retriesExhausted };
    } catch (error) {
      return { status: "error", reason: `VLM 调用失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** 给工具返回值/最终 warnings 用的扁平文案。 */
export function describeVisualReview(outcome: VisualReviewOutcome): string | null {
  if (outcome.status === "pass") return null;
  if (outcome.status === "skipped") return `视觉复检未启用（${outcome.reason}）`;
  if (outcome.status === "error") return `视觉复检未完成（${outcome.reason}）`;
  const detail = outcome.issues
    .map((issue) => `${ITEM_LABELS[issue.item as (typeof REVIEW_ITEMS)[number]] ?? issue.item}（${issue.where}）`)
    .join("；");
  return outcome.retriesExhausted
    ? `视觉复检仍不通过（已达重试上限，放行）：${detail}`
    : `视觉复检不通过：${detail}`;
}

/** set_page 工具返回里的 visualReview 字段（给落页模型看的精简形态）。 */
export function visualReviewToolPayload(outcome: VisualReviewOutcome): Record<string, unknown> {
  if (outcome.status === "fail") {
    return {
      status: "fail",
      issues: outcome.issues.map((issue) => ({
        问题: ITEM_LABELS[issue.item as (typeof REVIEW_ITEMS)[number]] ?? issue.item,
        位置: issue.where,
      })),
      retriesExhausted: outcome.retriesExhausted,
    };
  }
  if (outcome.status === "pass") return { status: "pass" };
  return { status: outcome.status, reason: outcome.reason };
}
