/**
 * 正文配图两等待阶段的编排（镜像 slides-style-stage.ts 的三件套模式）：
 * confirm（等用户决定是否生图）→ 生成 → review（等用户过目/逐张重生成）→ 落页。
 * 每个等待点 = onUpdate 广播卡片快照 + 工具返回 status/message + 会话落库可重入
 * （无参重调只重广播，不烧配图额度）。会话以 draftDocumentId 寻址，跨网关重启存续。
 */

import type { SlidesStyleImageGenerator } from "../slides-style/image-gen.js";
import {
  collectPendingImagePages,
  composePageImagePrompt,
  generateSlidesPageImages,
  PAGE_IMAGE_RETRY_DELAYS_MS,
} from "./slides-page-images.js";
import type {
  SlidesPageImageSessionData,
  SlidesPageImageSessionStore,
  SlidesPageImagePage,
} from "./slides-page-images-store.js";
import type { SlidesPageImageRunner } from "./slides-page-images-runner.js";

export interface SlidesPageImagesStageDeps {
  sessions: SlidesPageImageSessionStore;
  images: Pick<SlidesStyleImageGenerator, "generateImage">;
  /** 后台逐张生成循环；提供时 generate 决策立即返回、生成后台推进。 */
  runner?: SlidesPageImageRunner | null;
  onUpdate?: (update: { content: string; details: Record<string, unknown> }) => void;
  signal?: AbortSignal;
}

export interface SlidesPageImagesStageResult {
  content: string;
  details: Record<string, unknown>;
}

/** 阶段编排结果：waiting=返回等待用户；build=调用方带 plan 继续落页；failed=返回失败。 */
export type PageImagesStageOutcome =
  | { kind: "waiting"; result: SlidesPageImagesStageResult }
  | { kind: "build"; plan: Record<string, unknown>; pageImagesSessionId: string }
  | { kind: "failed"; result: SlidesPageImagesStageResult };

type Update = { content: string; details: Record<string, unknown> };

function failed(errorCode: string, message: string, retryable = false): SlidesPageImagesStageResult {
  return { content: JSON.stringify({ status: "failed", errorCode, retryable, message }), details: { errorCode } };
}

function planTitle(session: SlidesPageImageSessionData): string {
  return typeof session.plan.title === "string" ? session.plan.title : "";
}

/** confirm 卡快照：待配图页清单（title + 生图提示词原文）。 */
export function pageImagesConfirmPayload(session: SlidesPageImageSessionData): Record<string, unknown> {
  return {
    stage: "page_images_confirm",
    title: planTitle(session),
    totalPages: session.pages.length,
    doneCount: 0,
    documentId: session.draftDocumentId,
    pageImagesSessionId: session.id,
    generation: session.generation,
    pages: session.pages.map((page) => ({ title: page.title, imagePrompt: page.imagePrompt })),
  };
}

/** review 卡快照：已生成的图（everroom-material:// 寻址）+ 每张的生图提示词。 */
export function pageImagesReviewPayload(session: SlidesPageImageSessionData): Record<string, unknown> {
  return {
    stage: "page_images_review",
    title: planTitle(session),
    totalPages: session.pages.length,
    doneCount: session.pages.filter((page) => page.contentHash !== null).length,
    documentId: session.draftDocumentId,
    pageImagesSessionId: session.id,
    generation: session.generation,
    pages: session.pages.map((page) => ({
      title: page.title,
      imagePrompt: page.imagePrompt,
      ...(page.contentHash ? { url: `everroom-material://${page.contentHash}` } : {}),
      ...(page.rejected ? { rejected: true } : {}),
      ...(page.failed && !page.contentHash ? { failed: true } : {}),
    })),
    updatedAt: session.updatedAt,
  };
}

function broadcast(deps: SlidesPageImagesStageDeps, payload: Record<string, unknown>): void {
  deps.onUpdate?.({ content: JSON.stringify(payload), details: payload });
}

function waitingResult(payload: SlidesPageImagesStageResult["content"]): SlidesPageImagesStageResult {
  return { content: payload, details: JSON.parse(payload) as Record<string, unknown> };
}

/** 新会话：arrange 后发现配图缺口即落库。有后台 runner 时生图立即并发开跑，过目卡实时亮出；无 runner 走确认卡（用户确认后同步生成）。 */
export function openPageImagesConfirm(
  input: {
    roomId: string;
    draftDocumentId: string;
    styleSessionId: string | null;
    plan: Record<string, unknown>;
    stylePalette: { primary?: string; accent?: string; background?: string } | null;
  },
  deps: SlidesPageImagesStageDeps,
): PageImagesStageOutcome {
  const pending = collectPendingImagePages(input.plan);
  if (pending.length === 0) {
    return {
      kind: "failed",
      result: failed("slides_page_images_empty", "方案里没有待配图页，无需确认配图。"),
    };
  }
  const pages: SlidesPageImagePage[] = pending.map((item) => ({
    pageIndex: item.pageIndex,
    title: item.title,
    imagePrompt: item.imagePrompt,
    contentHash: null,
  }));
  const session = deps.sessions.upsertForDraft({ ...input, pages });
  if (deps.runner) {
    deps.sessions.patch(session.id, { stage: "review" });
    const live: SlidesPageImageSessionData = { ...session, stage: "review" };
    void deps.runner.start(
      { roomId: input.roomId, draftDocumentId: input.draftDocumentId },
      { ...deps, sessionId: session.id },
    ).catch(() => {});
    broadcast(deps, pageImagesReviewPayload(live));
    return {
      kind: "waiting",
      result: waitingResult(JSON.stringify({
        status: "page_images_review",
        documentId: session.draftDocumentId,
        pages: session.pages.length,
        message: `配图已在后台开始生成（共 ${String(session.pages.length)} 张，并发进行），过目卡逐张亮出。告诉用户：可打回/重生成单张；确认落页传 pageImagesDecision="accept"（未完成的张数自动放弃）；全部不要传 pageImagesDecision="skip"。`,
      })),
    };
  }
  broadcast(deps, pageImagesConfirmPayload(session));
  return {
    kind: "waiting",
    result: waitingResult(JSON.stringify({
      status: "page_images_confirm",
      documentId: session.draftDocumentId,
      pages: session.pages.length,
      message: `正文配图缺口已列出（${String(session.pages.length)} 页待配图）。告诉用户：可生成 AI 配图，或跳过配图（跳过则这些页退化为图形版式）；用户确认前不要落页。`,
    })),
  };
}

function findSession(
  deps: SlidesPageImagesStageDeps,
  roomId: string,
  draftDocumentId: string,
): SlidesPageImageSessionData | null {
  return deps.sessions.byDraftId(roomId, draftDocumentId);
}

function stageConflict(session: SlidesPageImageSessionData): SlidesPageImagesStageResult {
  return failed(
    "slides_page_images_stage_conflict",
    `配图会话当前阶段是 ${session.stage}，与本次操作不匹配；请按当前确认卡上的动作继续。`,
  );
}

/** 重入：无参重调只重广播当前等待卡，不烧配图额度。 */
export function reshowPageImages(
  input: { roomId: string; draftDocumentId: string },
  deps: SlidesPageImagesStageDeps,
): PageImagesStageOutcome {
  const session = findSession(deps, input.roomId, input.draftDocumentId);
  if (!session) return {
    kind: "failed",
    result: failed("slides_page_images_session_invalid", "配图会话不存在；请重新发起 generate。"),
  };
  if (session.stage === "resolved") return {
    kind: "failed",
    result: failed("slides_page_images_stage_conflict", "配图会话已完结，无需重展示。"),
  };
  if (session.stage === "confirm") {
    broadcast(deps, pageImagesConfirmPayload(session));
    return {
      kind: "waiting",
      result: waitingResult(JSON.stringify({
        status: "page_images_confirm",
        documentId: session.draftDocumentId,
        pages: session.pages.length,
        message: "配图确认卡已重新展示。告诉用户：选「生成配图」或「跳过配图」后继续。",
      })),
    };
  }
  broadcast(deps, pageImagesReviewPayload(session));
  return {
    kind: "waiting",
    result: waitingResult(JSON.stringify({
      status: "page_images_review",
      documentId: session.draftDocumentId,
      message: `配图过目卡已重新展示（已生成 ${String(session.pages.filter((page) => page.contentHash).length)} / ${String(session.pages.length)} 张）。告诉用户：继续审核，可打回/重生成/确认落页。`,
    })),
  };
}

/** 用户决定：generate=生图转 review；skip=跳过配图待落页；accept=按当前配图落页。 */
export async function decidePageImages(
  input: { roomId: string; draftDocumentId: string; decision: "generate" | "skip" | "accept" },
  deps: SlidesPageImagesStageDeps,
): Promise<PageImagesStageOutcome> {
  const session = findSession(deps, input.roomId, input.draftDocumentId);
  if (!session) return {
    kind: "failed",
    result: failed("slides_page_images_session_invalid", "配图会话不存在；请重新发起 generate 排版方案。"),
  };

  if (input.decision === "skip") {
    if (session.stage !== "confirm" && session.stage !== "review") return { kind: "failed", result: stageConflict(session) };
    deps.runner?.abort(session.id);
    // 跳过 = 一张都不用：后台循环取消，已生成的图也全部剥掉。
    const plan = structuredClone(session.plan);
    const planPages = Array.isArray(plan.pages) ? plan.pages : [];
    for (const page of session.pages) {
      const target = planPages[page.pageIndex];
      if (target && typeof target === "object" && !Array.isArray(target)) {
        delete (target as Record<string, unknown>).materials;
      }
    }
    return { kind: "build", plan, pageImagesSessionId: session.id };
  }

  if (input.decision === "accept") {
    if (session.stage !== "review") return { kind: "failed", result: stageConflict(session) };
    // 确认落页：未生成的张数自动放弃（相应页退化图形版式）。
    deps.runner?.abort(session.id);
    // 打回页剥掉注入的 AI 配图（缺口页的 materials 只会来自注入），落页即退化图形版式。
    const plan = structuredClone(session.plan);
    const planPages = Array.isArray(plan.pages) ? plan.pages : [];
    for (const page of session.pages) {
      if (!page.rejected) continue;
      const target = planPages[page.pageIndex];
      if (target && typeof target === "object" && !Array.isArray(target)) {
        delete (target as Record<string, unknown>).materials;
      }
    }
    return { kind: "build", plan, pageImagesSessionId: session.id };
  }

  if (session.stage !== "confirm" && session.stage !== "review") return { kind: "failed", result: stageConflict(session) };
  if (deps.runner) {
    // 后台流水：确认即转 review，循环逐张生成（网关重启后重调 generate 续跑剩余）。
    if (session.stage === "confirm") {
      deps.sessions.patch(session.id, { stage: "review" });
      session.stage = "review";
    }
    const pending = session.pages.filter((page) => !page.contentHash && !page.failed).length;
    void deps.runner.start(
      { roomId: input.roomId, draftDocumentId: input.draftDocumentId },
      { ...deps, sessionId: session.id },
    ).catch(() => {});
    broadcast(deps, pageImagesReviewPayload(session));
    return {
      kind: "waiting",
      result: waitingResult(JSON.stringify({
        status: "page_images_review",
        documentId: session.draftDocumentId,
        pending: session.pages.length,
        message: `配图已在后台开始逐张生成（共 ${String(session.pages.length)} 张，待生成 ${String(pending)} 张）。每生成一张确认卡即亮出一张，期间用户随时可审核已生成的图（打回/重生成）；用户确认落页时未完成的张数自动放弃。`,
      })),
    };
  }
  const summary = await generateSlidesPageImages(session.plan, {
    images: deps.images,
    ...(session.stylePalette ? { stylePalette: session.stylePalette } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onUpdate ? { onUpdate: deps.onUpdate } : {}),
  });
  const byIndex = new Map(summary.results.map((result) => [result.pageIndex, result]));
  const pages: SlidesPageImagePage[] = session.pages.map((page) => {
    const result = byIndex.get(page.pageIndex);
    return result?.contentHash ? { ...page, contentHash: result.contentHash } : page;
  });
  if (summary.generated === 0) {
    const noRelay = summary.skipped?.includes("中转会话不可用") ?? false;
    return {
      kind: "failed",
      result: failed(
        "slides_page_images_generation_failed",
        noRelay
          ? "生图中转会话不可用（需要已订阅账号且网关在线）。告诉用户：可稍后重试生成，或用 pageImagesDecision=\"skip\" 跳过配图直接落页。"
          : "配图生成全部失败（多为限流/瞬时错误）。告诉用户：可重试生成，或用 pageImagesDecision=\"skip\" 跳过配图直接落页。",
        !noRelay,
      ),
    };
  }
  const updated = { ...session, pages, stage: "review" as const };
  deps.sessions.patch(session.id, { stage: "review", pages, plan: session.plan });
  broadcast(deps, pageImagesReviewPayload(updated));
  return {
    kind: "waiting",
    result: waitingResult(JSON.stringify({
      status: "page_images_review",
      documentId: session.draftDocumentId,
      generated: summary.generated,
      ...(summary.failed > 0 ? { warnings: [`${String(summary.failed)} 页配图生成失败，将退化为图形版式`] } : {}),
      message: "正文配图已生成并展示在确认卡上。告诉用户：不满意的单张可重新生成（说明第几张）；确认后继续落页。",
    })),
  };
}

/** 过目打回/恢复（1 起按会话页序）：打回页落页时退化图形版式；恢复即撤销打回。 */
export function reviewPageImageReject(
  input: { roomId: string; draftDocumentId: string; index: number; rejected: boolean },
  deps: SlidesPageImagesStageDeps,
): PageImagesStageOutcome {
  const session = findSession(deps, input.roomId, input.draftDocumentId);
  if (!session) return {
    kind: "failed",
    result: failed("slides_page_images_session_invalid", "配图会话不存在；请重新发起 generate。"),
  };
  if (session.stage !== "review") return { kind: "failed", result: stageConflict(session) };
  const page = session.pages[input.index - 1];
  if (!page || (!page.contentHash && !page.failed)) return {
    kind: "failed",
    result: failed("slides_page_image_invalid", `第 ${String(input.index)} 张配图不存在或尚未生成（共 ${String(session.pages.length)} 张）。`),
  };

  const pages = session.pages.map((item, position) =>
    position === input.index - 1 ? { ...item, rejected: input.rejected } : item);
  deps.sessions.patch(session.id, { pages });
  const updated: SlidesPageImageSessionData = { ...session, pages };
  broadcast(deps, pageImagesReviewPayload(updated));
  return {
    kind: "waiting",
    result: waitingResult(JSON.stringify({
      status: "page_images_review",
      documentId: session.draftDocumentId,
      rejected: input.index,
      message: input.rejected
        ? `第 ${String(input.index)} 张配图已打回，落页时该页将退化为图形版式（恢复用 restorePageImage 或过目卡按钮）。继续审核其余配图，确认后落页。`
        : `第 ${String(input.index)} 张配图已恢复使用。继续审核其余配图，确认后落页。`,
    })),
  };
}

/** 单张重生成（1 起按会话页序）：同提示词重掷，可选反馈拼进提示词尾部；重生成即撤销打回。 */
export async function regeneratePageImage(
  input: { roomId: string; draftDocumentId: string; index: number; feedback?: string },
  deps: SlidesPageImagesStageDeps,
): Promise<PageImagesStageOutcome> {
  const session = findSession(deps, input.roomId, input.draftDocumentId);
  if (!session) return {
    kind: "failed",
    result: failed("slides_page_images_session_invalid", "配图会话不存在；请重新发起 generate。"),
  };
  if (session.stage !== "review") return { kind: "failed", result: stageConflict(session) };
  const page = session.pages[input.index - 1];
  if (!page) return {
    kind: "failed",
    result: failed("slides_page_image_invalid", `第 ${String(input.index)} 张配图不存在（共 ${String(session.pages.length)} 张）。`),
  };

  const prompt = composePageImagePrompt(page.imagePrompt, session.stylePalette)
    + (input.feedback ? `；用户反馈：${input.feedback.slice(0, 300)}` : "");
  let hash: string;
  try {
    const result = await deps.images.generateImage({ prompt, retryDelaysMs: PAGE_IMAGE_RETRY_DELAYS_MS });
    hash = result.contentHash;
  } catch (error) {
    return {
      kind: "failed",
      result: failed(
        "slides_page_image_regeneration_failed",
        `第 ${String(input.index)} 张配图重新生成失败（${error instanceof Error ? error.message : String(error)}）；原配图保留，可重试。`,
        true,
      ),
    };
  }

  const pages = session.pages.map((item, position) =>
    position === input.index - 1 ? { ...item, contentHash: hash, rejected: false, failed: false } : item);
  const plan = structuredClone(session.plan);
  const planPages = Array.isArray(plan.pages) ? plan.pages : [];
  const target = planPages[page.pageIndex];
  if (target && typeof target === "object" && !Array.isArray(target)) {
    (target as Record<string, unknown>).materials = [{
      url: `everroom-material://${hash}`,
      desc: `AI 生成配图：${page.imagePrompt.slice(0, 180)}`,
    }];
  }
  const generation = session.generation + 1;
  deps.sessions.patch(session.id, { pages, plan, generation });
  const updated: SlidesPageImageSessionData = { ...session, pages, plan, generation };
  broadcast(deps, pageImagesReviewPayload(updated));
  return {
    kind: "waiting",
    result: waitingResult(JSON.stringify({
      status: "page_images_review",
      documentId: session.draftDocumentId,
      regenerated: input.index,
      generation,
      message: `第 ${String(input.index)} 张配图已重新生成并展示。告诉用户：继续过目，可再重生成其他张，或确认落页。`,
    })),
  };
}
