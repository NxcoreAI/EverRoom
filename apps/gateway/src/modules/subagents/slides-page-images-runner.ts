/**
 * 正文配图后台生成：过目卡亮出即并发开跑（窗口 4，首批 stagger 平滑限流）。
 * 每张结算只写会话库（单一事实来源），前端过目卡靠 HTTP 轮询刷新——工具调用
 * 结束后其 onUpdate 通道在渲染层会被终态丢弃，不能借用。
 *
 * 并发不变式：worker 只给「尚无图」的页写 hash/materials（认领制，一页一 worker）；
 * 用户的打回/恢复/重生成只作用于「已有图」的页。两边写入前都重读会话合并
 * （单线程异步下安全），skip 通过 abort 取消循环，accept 先转 settling 等图就绪、
 * 超时才 abort；会话被覆盖重建（id 变化）时循环自行退出；无中转会话整轮停止。
 */

import {
  composePageImagePrompt,
  PAGE_IMAGES_DEADLINE_MS,
  PAGE_IMAGE_RETRY_DELAYS_MS,
} from "./slides-page-images.js";
import type {
  SlidesPageImagePage,
  SlidesPageImageSessionData,
} from "./slides-page-images-store.js";
import type { SlidesPageImagesStageDeps } from "./slides-page-images-stage.js";
import { pageImagesReviewPayload } from "./slides-page-images-stage.js";
import { imageStyleContext } from "./slides-page-images.js";
import { inspectSlideImage } from "./slides-image-qc.js";

interface RunningEntry {
  controller: AbortController;
  /** 用户主动取消（accept/skip/覆盖）：未完成页由落页路径处理，循环不再补标失败。 */
  userAborted: boolean;
  done: Promise<void>;
}

const CONCURRENCY = 4;
const FIRST_BURST_STAGGER_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlidesPageImageRunner {
  private readonly active = new Map<string, RunningEntry>();

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** 取消某会话的后台生成（accept/skip 落页、会话覆盖时调用）；进行中的那张作废。 */
  abort(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    entry.userAborted = true;
    entry.controller.abort();
  }

  /** 测试与诊断用：等待某会话的后台循环结束。 */
  settle(sessionId: string): Promise<void> {
    return this.active.get(sessionId)?.done ?? Promise.resolve();
  }

  /** 启动（或续跑）某会话的生成。返回循环结束的 Promise；生产侧 fire-and-forget。 */
  start(
    input: { draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
  ): Promise<void> {
    const existing = this.active.get(deps.sessionId);
    if (existing) return existing.done;
    const entry: RunningEntry = {
      controller: new AbortController(),
      userAborted: false,
      done: Promise.resolve(),
    };
    entry.done = this.loop(input, deps, entry).finally(() => {
      this.active.delete(deps.sessionId);
    });
    this.active.set(deps.sessionId, entry);
    return entry.done;
  }

  private async loop(
    input: { draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
    entry: RunningEntry,
  ): Promise<void> {
    const controller = entry.controller;
    const startedAt = Date.now();
    const claimed = new Set<number>();
    let launched = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted) return;
        if (Date.now() - startedAt > PAGE_IMAGES_DEADLINE_MS) return;
        const session = this.readSession(input, deps);
        if (!session) return;
        const next = session.pages.find((page) => !page.contentHash && !page.failed && !claimed.has(page.pageIndex));
        if (!next) return;

        claimed.add(next.pageIndex);
        const burstIndex = launched++;
        if (burstIndex < CONCURRENCY && burstIndex > 0) {
          await sleep(burstIndex * FIRST_BURST_STAGGER_MS);
          if (controller.signal.aborted) return;
        }
        // 编排预热的在途图：等同一张的结果，不重新生图（防重复烧额度）。
        const prewarmed = deps.preseed?.inflight.get(next.pageIndex) ?? null;
        try {
          let contentHash: string;
          if (prewarmed) {
            deps.preseed!.inflight.delete(next.pageIndex);
            const hash = await prewarmed;
            if (controller.signal.aborted) return;
            if (typeof hash !== "string" || hash.length === 0) throw new Error("预热生图失败");
            contentHash = hash;
          } else {
            const result = await deps.images.generateImage({
              prompt: composePageImagePrompt(next.imagePrompt, session.stylePalette),
              retryDelaysMs: PAGE_IMAGE_RETRY_DELAYS_MS,
            });
            if (controller.signal.aborted) return;
            contentHash = result.contentHash;
          }
          if (deps.readMaterialBytes) {
            const bytes = await deps.readMaterialBytes(contentHash).catch(() => null);
            if (bytes) {
              const qc = await inspectSlideImage(bytes.buffer).catch(() => null);
              if (qc && !qc.ok) throw new Error(`配图质检未通过：${qc.reason ?? "unknown"}`);
              if (deps.reviewImage) {
                const verdict = await deps.reviewImage(bytes, next.imagePrompt, imageStyleContext(session.stylePalette)).catch(() => null);
                if (verdict && verdict.ok === false && verdict.score <= 2) {
                  throw new Error(`配图切题质检未通过：${verdict.reason ?? `score ${verdict.score}`}`);
                }
              }
            }
          }
          this.patchPage(input, deps, next.pageIndex, {
            contentHash,
            failed: false,
            rejected: false,
          });
        } catch (error) {
          // 无中转会话是环境性失败：整轮停止（用户可稍后重试或跳过）。
          if (error instanceof Error && error.message.includes("中转会话不可用")) {
            controller.abort();
            return;
          }
          this.patchPage(input, deps, next.pageIndex, { failed: true });
        } finally {
          claimed.delete(next.pageIndex);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (entry.userAborted) return;
    // deadline 到点/循环异常退出（含中转会话不可用）：未完成页标 failed 并广播 review 载荷，
    // 前端显示「生成失败/可重生成」，不再永远停在「生成中…」。
    this.failUnfinishedPages(input, deps);
  }

  /** 兜底落账：未完成页 failed:true + patch + 广播（广播失败不影响循环退出）。 */
  private failUnfinishedPages(
    input: { draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
  ): void {
    try {
      const session = this.readSession(input, deps);
      if (!session) return;
      const unfinished = session.pages.filter((page) => !page.contentHash && !page.failed);
      if (unfinished.length === 0) return;
      const unfinishedIndexes = new Set(unfinished.map((page) => page.pageIndex));
      const pages = session.pages.map((page) =>
        unfinishedIndexes.has(page.pageIndex) ? { ...page, failed: true } : page);
      deps.sessions.patch(deps.sessionId, { pages });
      const payload = {
        ...pageImagesReviewPayload({ ...session, pages }),
        warnings: [`${String(unfinished.length)} 张配图未完成（超时或中断），已标记失败；可重新生成或直接落页`],
      };
      deps.onUpdate?.({ content: JSON.stringify(payload), details: payload });
    } catch {
      // 兜底标失败失败不阻塞循环退出。
    }
  }

  /** 会话有效性：存在、id 未变、仍在 review/settling（accept 等图期不中断；skip 落定或覆盖重建即停）。 */
  private readSession(
    input: { draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
  ): SlidesPageImageSessionData | null {
    const session = deps.sessions.byDraftId(input.draftDocumentId);
    if (!session || session.id !== deps.sessionId) return null;
    if (session.stage !== "review" && session.stage !== "settling") return null;
    return session;
  }

  /** 写前重读合并：只动目标页，保留期间用户对其他页的打回/重生成结果。 */
  private patchPage(
    input: { draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
    pageIndex: number,
    fields: Partial<Pick<SlidesPageImagePage, "contentHash" | "failed" | "rejected">>,
  ): void {
    const session = this.readSession(input, deps);
    if (!session) return;
    const pages = session.pages.map((page) =>
      page.pageIndex === pageIndex ? { ...page, ...fields } : page);
    const plan = structuredClone(session.plan);
    const planPages = Array.isArray(plan.pages) ? plan.pages : [];
    const target = planPages[pageIndex];
    if (target && typeof target === "object" && !Array.isArray(target)) {
      if (fields.contentHash) {
        const page = session.pages.find((item) => item.pageIndex === pageIndex);
        (target as Record<string, unknown>).materials = [{
          url: `everroom-material://${fields.contentHash}`,
          desc: `AI 生成配图：${(page?.imagePrompt ?? "").slice(0, 180)}`,
        }];
      } else {
        delete (target as Record<string, unknown>).materials;
      }
    }
    deps.sessions.patch(deps.sessionId, { pages, plan });
  }
}
