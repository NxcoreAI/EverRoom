/**
 * 正文页配图缺口回填：slides-planner 在 arrange 里对素材检索零命中但值得配图的页
 * 输出 imagePrompt，本模块在 generate 步骤（builder 派发前）串行逐张生图，把
 * everroom-material:// 引用注回该页 materials（直接变异 raw plan，builder 原样接收）。
 * 单页失败跳过、该页照旧退化图形版式；无中转会话整批跳过（等同现状）。
 * 数量由 planner 判断，这里只做熔断：MAX_PAGE_IMAGES 张上限 + 总时长 deadline。
 */

import type { SlidesStyleImageGenerator } from "../slides-style/image-gen.js";
import { inspectSlideImage } from "./slides-image-qc.js";
import type { SlideImageVlmVerdict } from "./slides-image-vlm-qc.js";
import { IMAGE_MODEL_UNCONFIGURED_MARKER } from "../slides-style/image-gen.js";

export const MAX_PAGE_IMAGES = 8;
export const PAGE_IMAGES_DEADLINE_MS = 15 * 60_000;
/** 页图限流重试收紧为 2 试（0s/20s），把最坏单张耗时压在 ~380s 内。 */
export const PAGE_IMAGE_RETRY_DELAYS_MS = [0, 20_000];
/** 并发窗口与首批 stagger（平滑中转 429）。 */
const V1_CONCURRENCY = 4;
const V1_FIRST_BURST_STAGGER_MS = 3000;
const MAX_COMPOSED_PROMPT_CHARS = 600;
const NO_RELAY_SESSION_MARKER = "生图中转会话不可用";

export interface SlidesPageImagesPalette {
  primary?: string;
  accent?: string;
  background?: string;
}

export interface SlidesPageImagesDeps {
  images: Pick<SlidesStyleImageGenerator, "generateImage">;
  stylePalette?: SlidesPageImagesPalette | null;
  signal?: AbortSignal;
  onUpdate?: (update: { content: string; details: Record<string, unknown> }) => void;
  now?: () => number;
  /** 按内容哈希读素材字节；提供时生成图先过确定性 QC（空白/纯色/过曝/低分辨率）。 */
  readMaterialBytes?: (hash: string) => Promise<{ buffer: Buffer; mime: string } | null>;
  /** 可选的 VLM 切题性质检；未配置时跳过。 */
  reviewImage?: (image: { buffer: Buffer; mime: string }, pagePrompt: string, styleContext?: string) => Promise<SlideImageVlmVerdict>;
}

export interface SlidesPageImagesSummary {
  requested: number;
  generated: number;
  failed: number;
  skipped?: string;
  /** 逐页结果：pageIndex 指向 plan.pages 下标；失败页只有 error。 */
  results: Array<{ pageIndex: number; contentHash?: string; error?: string; warning?: string }>;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isDarkHex(hex: string): boolean {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
}

/** 给 VLM 审阅用的 deck 风格摘要；没有 palette 时返回 undefined。 */
export function imageStyleContext(palette: SlidesPageImagesPalette | null | undefined): string | undefined {
  if (!palette) return undefined;
  const parts: string[] = [];
  if (isHexColor(palette.primary)) parts.push(`主色 ${palette.primary}`);
  if (isHexColor(palette.accent)) parts.push(`强调色 ${palette.accent}`);
  if (isHexColor(palette.background)) {
    parts.push(`底色 ${palette.background}`);
    parts.push(isDarkHex(palette.background) ? "整体暗调" : "整体明亮");
  }
  return parts.length > 0 ? parts.join("；") : undefined;
}

/** 生图提示词 + 风格卡调色板确定性后缀（色调统一，无额外 LLM 调用），整体不超过 600 字。 */
export function composePageImagePrompt(
  imagePrompt: string,
  palette: SlidesPageImagesPalette | null | undefined,
): string {
  const prompt = imagePrompt.trim();
  const parts: string[] = [];
  if (isHexColor(palette?.primary)) parts.push(`主色 ${palette.primary}`);
  if (isHexColor(palette?.accent)) parts.push(`强调 ${palette.accent}`);
  if (isHexColor(palette?.background)) parts.push(`底色 ${palette.background}`);
  if (parts.length === 0) return prompt.slice(0, MAX_COMPOSED_PROMPT_CHARS);
  const background = palette?.background;
  if (isHexColor(background)) parts.push(`基调 ${isDarkHex(background) ? "暗调" : "明亮"}`);
  const suffix = `色调参考：${parts.join("、")}；画面统一在此色调内。`;
  return `${prompt.slice(0, MAX_COMPOSED_PROMPT_CHARS - suffix.length)}${suffix}`;
}

interface PendingPageImage {
  pageIndex: number;
  page: Record<string, unknown>;
  title: string;
  imagePrompt: string;
}

/** 收集待配图页：materials 为空且带非空 imagePrompt 的页，按页序最多 MAX_PAGE_IMAGES 个。 */
export function collectPendingImagePages(plan: Record<string, unknown>): PendingPageImage[] {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const pending: PendingPageImage[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    if (pending.length >= MAX_PAGE_IMAGES) break;
    const page = pages[pageIndex];
    if (!page || typeof page !== "object" || Array.isArray(page)) continue;
    const record = page as Record<string, unknown>;
    if (Array.isArray(record.materials) && record.materials.length > 0) continue;
    const imagePrompt = typeof record.imagePrompt === "string" ? record.imagePrompt.trim() : "";
    if (!imagePrompt) continue;
    pending.push({
      pageIndex,
      page: record,
      title: typeof record.title === "string" ? record.title : "",
      imagePrompt,
    });
  }
  return pending;
}

export async function generateSlidesPageImages(
  plan: Record<string, unknown>,
  deps: SlidesPageImagesDeps,
): Promise<SlidesPageImagesSummary> {
  const pending = collectPendingImagePages(plan);

  const summary: SlidesPageImagesSummary = { requested: pending.length, generated: 0, failed: 0, results: [] };
  if (pending.length === 0) return summary;

  const title = typeof plan.title === "string" ? plan.title : "";
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const emit = (doneCount: number) => {
    if (!deps.onUpdate) return;
    const payload: Record<string, unknown> = {
      stage: "page_images",
      ...(title ? { title } : {}),
      totalPages: pending.length,
      doneCount,
      pages: pending.map((item) => ({ pageIndex: item.pageIndex, title: item.title })),
      updatedAt: Date.now(),
    };
    deps.onUpdate({ content: JSON.stringify(payload), details: payload });
  };

  let skipped: string | undefined;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal?.aborted) {
        skipped ??= "已中止，剩余页未生成配图";
        return;
      }
      if (skipped) return;
      if (now() - startedAt > PAGE_IMAGES_DEADLINE_MS) {
        skipped ??= "配图生成超过时限，剩余页退化为图形版式";
        return;
      }
      const index = cursor++;
      if (index >= pending.length) return;
      const item = pending[index]!;
      if (index < V1_CONCURRENCY && index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * V1_FIRST_BURST_STAGGER_MS));
        if (deps.signal?.aborted) {
          skipped ??= "已中止，剩余页未生成配图";
          return;
        }
        // stagger 等待期间其他 worker 可能已判定整批放弃（无中转会话等），复查后再生图。
        if (skipped) return;
      }
      try {
        const result = await deps.images.generateImage({
          prompt: composePageImagePrompt(item.imagePrompt, deps.stylePalette),
          retryDelaysMs: PAGE_IMAGE_RETRY_DELAYS_MS,
        });
        let bytes: { buffer: Buffer; mime: string } | null = null;
        if (deps.readMaterialBytes) {
          bytes = await deps.readMaterialBytes(result.contentHash).catch(() => null);
          if (bytes) {
            const qc = await inspectSlideImage(bytes.buffer).catch(() => null);
            if (qc && !qc.ok) {
              summary.failed += 1;
              summary.results.push({ pageIndex: item.pageIndex, error: `配图质检未通过：${qc.reason ?? "unknown"}` });
              emit(summary.generated);
              continue;
            }
          }
        }
        let warning: string | undefined;
        if (bytes && deps.reviewImage) {
          const verdict = await deps.reviewImage(bytes, item.imagePrompt, imageStyleContext(deps.stylePalette)).catch(() => null);
          if (verdict && verdict.ok === false) {
            if (verdict.score <= 2) {
              summary.failed += 1;
              summary.results.push({
                pageIndex: item.pageIndex,
                error: `配图切题质检未通过：${verdict.reason ?? `score ${verdict.score}`}`,
              });
              emit(summary.generated);
              continue;
            }
            warning = `配图弱相关（${verdict.score}/5）：${verdict.reason ?? "建议人工复核"}`;
          }
          if (verdict && verdict.styleScore !== undefined && verdict.styleScore <= 2) {
            const styleWarning = `配图风格弱适配（${verdict.styleScore}/5）：${verdict.styleReason ?? "建议检查明暗/色调"}${warning ? `；${warning}` : ""}`;
            warning = styleWarning;
          }
        }
        item.page.materials = [{
          url: `everroom-material://${result.contentHash}`,
          desc: `AI 生成配图：${item.imagePrompt.slice(0, 180)}`,
        }];
        summary.generated += 1;
        summary.results.push({ pageIndex: item.pageIndex, contentHash: result.contentHash, ...(warning ? { warning } : {}) });
      } catch (error) {
        // 无中转会话/套餐未配生图模型都是环境性失败：后续页同样生不出，整批放弃（该次 generate 照常落页）。
        if (error instanceof Error && error.message.includes(NO_RELAY_SESSION_MARKER)) {
          skipped = "生图中转会话不可用，正文配图全部跳过";
          return;
        }
        if (error instanceof Error && error.message.includes(IMAGE_MODEL_UNCONFIGURED_MARKER)) {
          skipped = `${IMAGE_MODEL_UNCONFIGURED_MARKER}，正文配图全部跳过`;
          return;
        }
        summary.failed += 1;
        summary.results.push({
          pageIndex: item.pageIndex,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      emit(summary.generated);
    }
  };
  await Promise.all(Array.from({ length: Math.min(V1_CONCURRENCY, pending.length) }, () => worker()));
  if (skipped !== undefined) summary.skipped = skipped;
  return summary;
}
