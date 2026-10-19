/**
 * generate 尾部（布局树链路）：契约注册 → 建骨架 deck → 每页并发 dispatch
 * slides-layouter（窗口 8）→ 按页序编译落页（进度广播）→ 页间树相似度审计
 * （超标页重排 ≤1 次）→ slides-reviewer 并发审页（截图直投多模态；revised 的
 * 页网关机械套用修正树重落一次）→ 汇总回收。
 * agent 只出树与判断；编译、落页、套用全部网关确定性执行。
 */

import { createHash, randomUUID } from "node:crypto";
import type { RuntimeAttachment } from "@nxcore/agent-runtime";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { SlidesProgressEvent, SlidesProgressPlan, SlidesProgressTracker } from "./slides-progress-tracker.js";
import type { OfficeBridgeClient } from "../documents/capabilities/office-bridge-client.js";
import type { SlidesVisualReviewer, VisualReviewOutcome } from "../slides-visual-review/review.js";
import { MAX_PAGE_SPEC_LENGTH, skeletonPageSpec } from "../documents/capabilities/office-plugin.js";
import { contractFromStyleParams, type LayoutContract } from "../slides-layout/tree/layout-contract.js";
import { dropDeckLayoutContext, registerDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { normalizeTree, type LayoutTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { measureDefects, shrinkToFit, type LayoutDefect } from "../slides-layout/tree/measure.js";
import { auditSimilarity, treeSignature } from "../slides-layout/tree/similarity.js";
import { resolveImageArs } from "../slides-layout/tree/aspect-ratio.js";
import { dropReviewManuals, registerReviewManual } from "../slides-layout/review-context.js";
import { pngBase64ToJpegBase64 } from "./screenshot-jpeg.js";

const COMPOSITION_TENDENCY: Record<string, string> = {
  swiss: "强网格、克制留白、对齐严谨",
  editorial: "编辑杂志感、不对称分区、大图与文字块错落",
  poster: "海报感、大字主导、视觉冲击",
  immersive: "沉浸式、大图满版、文字叠于图上",
};

export interface LayouterTailDeps {
  progress: SlidesProgressTracker | null;
  bridge: OfficeBridgeClient | null;
  visualReviewer: SlidesVisualReviewer | null;
  readMaterialBlob(hash: string): Promise<Uint8Array | null>;
  fetchImageHead(url: string): Promise<Uint8Array | null>;
  /** 幂等键（tools.ts 的 dispatchKey 单一出处）。 */
  makeKey(runId: string, agentId: string, task: string, input: unknown): string;
  /** 带并发限额退避的 dispatch（tools.ts 的 dispatchWithConcurrencyRetry 单一出处）。 */
  dispatchPage(input: Record<string, unknown>, idempotencyKey: string, parentRunId: string | null): Promise<SubagentInvocation>;
  /** 审页 dispatch（截图走 attachments 直投多模态）；缺省＝无审页代理，视觉复检走旧 VLM 链。 */
  dispatchReview?(
    input: Record<string, unknown>,
    idempotencyKey: string,
    parentRunId: string | null,
    attachments: RuntimeAttachment[],
  ): Promise<SubagentInvocation>;
}

export interface LayouterTailArgs {
  roomId: string;
  sessionId: string;
  runId: string;
  parentRunId: string | null;
  instruction: string;
  plan: Record<string, unknown>;
  armPlan: SlidesProgressPlan;
  styleParams: Record<string, unknown> | null;
  draftDocumentId: string;
  settle: { pageImagesSessionId?: string; styleSessionIdToSettle?: string | null };
  styleSessions: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  pageImagesStore: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  trashDraft: (documentId: string) => Promise<void>;
  signal?: AbortSignal;
  onUpdate?: (update: { content: string; details: unknown }) => void;
}

interface PageInput {
  title?: string;
  role?: string;
  density?: string;
  points?: unknown;
  data?: unknown;
  materials?: unknown;
  notes?: unknown;
}

/** 进度事件 → 渲染层进度卡载荷（tools.ts 的 relay 共用；单一出处在本模块）。 */
export function slidesProgressUpdatePayload(event: SlidesProgressEvent): Record<string, unknown> {
  const snapshot = event.snapshot;
  return {
    stage: "page_applied",
    slideIndex: event.slideIndex,
    title: snapshot.title,
    totalPages: snapshot.totalPages,
    pages: snapshot.pages,
    doneCount: snapshot.doneCount,
    ...(snapshot.narrative ? { narrative: snapshot.narrative } : {}),
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
  };
}

function styleBriefFrom(styleParams: Record<string, unknown> | null): string {
  if (!styleParams) return "";
  const parts: string[] = [];
  const composition = styleParams.composition;
  if (typeof composition === "string" && COMPOSITION_TENDENCY[composition]) {
    parts.push(COMPOSITION_TENDENCY[composition]!);
  }
  const effectLines = styleParams.effectLines;
  if (Array.isArray(effectLines)) {
    for (const line of effectLines) {
      if (typeof line === "string" && line.trim() && !/^构图[:：]/.test(line.trim())) {
        parts.push(line.trim());
      }
    }
  }
  return parts.join("；").slice(0, 400);
}

/** 布局代理失败/未交树时的确定性兜底：标题 + 要点竖排。 */
function fallbackTree(page: PageInput): LayoutTree {
  const points = Array.isArray(page.points)
    ? page.points.filter((p): p is string => typeof p === "string" && Boolean(p.trim())).slice(0, 5)
    : [];
  return normalizeTree({
    role: typeof page.role === "string" ? page.role : "content",
    ...(typeof page.title === "string" && page.title.trim() ? { title: page.title.slice(0, 80) } : {}),
    direction: "column",
    gapScale: 1.5,
    children: [
      ...(points.length > 0
        ? points.map((point) => ({ type: "text", variant: "body", text: point.slice(0, 200), bullet: true }))
        : [{ type: "text", variant: "subtitle", text: "内容生成中断，本页为兜底版式" }]),
    ],
  });
}

const PAGE_DISPATCH_RETRY_DELAYS_MS = [2000, 6000];

/** 页级 dispatch 长退避：并发限额是常态（窗口 4 对全局 4），拒绝即退避重试，耗尽才落兜底。 */
async function dispatchWithPageRetry(
  fn: () => Promise<SubagentInvocation>,
): Promise<SubagentInvocation> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const delay = PAGE_DISPATCH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function treeFromInvocation(invocation: SubagentInvocation, page: PageInput): { tree: LayoutTree; fellBack: boolean } {
  if (invocation.status === "completed") {
    const structured = invocation.result?.structuredOutput;
    if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
      const raw = (structured as Record<string, unknown>).tree;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        try {
          return { tree: normalizeTree(raw), fellBack: false };
        } catch {
          // 落到兜底
        }
      }
    }
  }
  return { tree: fallbackTree(page), fellBack: true };
}

interface PageMaterial { url?: unknown; desc?: unknown; aspectRatio?: unknown }

function materialUrls(pages: PageInput[]): string[] {
  const urls = new Set<string>();
  for (const page of pages) {
    if (!Array.isArray(page.materials)) continue;
    for (const material of page.materials as PageMaterial[]) {
      if (material !== null && typeof material === "object" && typeof material.url === "string"
        && /^(https?:\/\/|everroom-material:\/\/)/i.test(material.url)) {
        urls.add(material.url);
      }
    }
  }
  return [...urls];
}

/** 页内容 → layouter 输入（白名单拷贝，schema 对齐 agents/slides-layouter/schemas/input.schema.json）。 */
function layouterInputFor(
  base: { token: string; totalPages: number; styleBrief: string },
  page: PageInput,
  index: number,
  neighborSignatures?: string[],
): Record<string, unknown> {
  const materials = Array.isArray(page.materials)
    ? (page.materials as PageMaterial[])
        .filter((m) => m !== null && typeof m === "object" && typeof m.url === "string")
        .slice(0, 4)
        .map((m) => ({
          url: (m.url as string).slice(0, 500),
          ...(typeof m.desc === "string" ? { desc: m.desc.slice(0, 200) } : {}),
          ...(typeof m.aspectRatio === "number" && Number.isFinite(m.aspectRatio) && m.aspectRatio > 0
            ? { aspectRatio: m.aspectRatio }
            : {}),
        }))
    : [];
  return {
    task: "layout",
    deckToken: base.token,
    pageIndex: index,
    totalPages: base.totalPages,
    role: typeof page.role === "string" ? page.role : "content",
    density: typeof page.density === "string" ? page.density : "standard",
    ...(typeof page.title === "string" && page.title.trim() ? { title: page.title.slice(0, 80) } : {}),
    ...(Array.isArray(page.points)
      ? { points: (page.points as unknown[]).filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 400)).slice(0, 8) }
      : {}),
    ...(typeof page.data === "string" && page.data.trim() ? { data: page.data.slice(0, 2000) } : {}),
    ...(materials.length > 0 ? { materials } : {}),
    ...(typeof page.notes === "string" && page.notes.trim() ? { notes: page.notes.slice(0, 1000) } : {}),
    ...(base.styleBrief ? { styleBrief: base.styleBrief } : {}),
    ...(neighborSignatures && neighborSignatures.length > 0 ? { neighborSignatures: neighborSignatures.slice(0, 4) } : {}),
  };
}

interface FinalPage {
  spec: Record<string, unknown>;
  degraded: boolean;
  focusHints: string[];
  defects: LayoutDefect[];
}

function finalizeTree(
  tree: LayoutTree,
  contract: LayoutContract,
  imageArs: Map<string, number>,
  options?: { pageIndex?: number; pageCount?: number },
): FinalPage {
  const result = compileTree(tree, contract, undefined, options);
  const defects = measureDefects(result, contract, { imageArs });
  if (defects.length === 0) {
    return { spec: result.spec as unknown as Record<string, unknown>, degraded: false, focusHints: [], defects };
  }
  const shrunk = shrinkToFit(tree, contract, { imageArs });
  return {
    spec: shrunk.result.spec as unknown as Record<string, unknown>,
    degraded: shrunk.degraded,
    focusHints: shrunk.defects.map((d) => `${d.path}：${d.detail}`),
    defects: shrunk.defects,
  };
}

export async function runLayouterTail(
  deps: LayouterTailDeps,
  args: LayouterTailArgs,
): Promise<{ content: string; details: unknown }> {
  const { plan, armPlan } = args;
  const pages = (Array.isArray(plan.pages) ? plan.pages : []).filter(
    (p): p is PageInput => p !== null && typeof p === "object" && !Array.isArray(p),
  );
  const fail = (errorCode: string, message: string, retryable = false, extra: Record<string, unknown> = {}) => ({
    content: JSON.stringify({
      ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
      status: "failed",
      errorCode,
      retryable,
      message,
      ...extra,
    }),
    details: { errorCode },
  });

  if (pages.length < 1 || pages.length > 24) return fail("slides_layout_pages_invalid", "方案页数无效（1~24 页）", true);
  if (!deps.bridge) return fail("slides_office_bridge_unavailable", "桌面 Office 桥未配置，无法落页");

  const contract = contractFromStyleParams(args.styleParams as never);
  const imageArs = await resolveImageArs(materialUrls(pages), {
    readMaterialBlob: deps.readMaterialBlob,
    fetchHead: deps.fetchImageHead,
  });
  const token = `${args.runId}:layout`;
  registerDeckLayoutContext(token, { contract, imageArs });
  const bridge = deps.bridge;

  const progressKey = `slides-generate:${args.runId}`;
  const progress = deps.progress;
  if (progress) {
    progress.arm(progressKey, armPlan);
    if (args.onUpdate) {
      progress.setRelay(progressKey, (event) => {
        const payload = slidesProgressUpdatePayload(event);
        args.onUpdate?.({ content: JSON.stringify(payload), details: payload });
      });
    }
  }

  const warnings: string[] = [];
  let fileEntryId = "";
  let originalName: string | null = null;
  try {
    const deckTitle = (typeof plan.title === "string" && plan.title.trim() ? plan.title : armPlan.title).slice(0, 120);
    const outline = pages.map((p) => (typeof p.title === "string" && p.title.trim() ? p.title : "未命名页").slice(0, 80));
    const deckIdempotency = `agent-slides:${createHash("sha256").update(JSON.stringify([args.runId, deckTitle]), "utf8").digest("hex")}`;
    const created = await bridge.generate({
      title: deckTitle,
      format: "pptx",
      pages: [skeletonPageSpec(deckTitle, outline[0]!, 0, outline.length)],
      roomId: args.roomId,
      fileName: null,
      idempotencyKey: deckIdempotency,
    });
    if (!created.fileEntryId) return fail("slides_office_generation_failed", "桌面端未返回文件条目");
    fileEntryId = created.fileEntryId;
    originalName = created.originalName ?? null;
    deps.visualReviewer?.forgetDeck(fileEntryId);

    const styleBrief = styleBriefFrom(args.styleParams);
    const base = { token, totalPages: pages.length, styleBrief };

    // 每页并发取树（页序占位）。窗口=网关全局子代理并发默认值（NXCORE_SUBAGENT_MAX_CONCURRENT，
    // 缺省 8；环境改小时 dispatch 被拒会走页级退避重试，安全）。失败页确定性兜底，不中断整册。
    const trees: { tree: LayoutTree; fellBack: boolean }[] = new Array(pages.length);
    let cursor = 0;
    const workerCount = Math.min(8, pages.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= pages.length) return;
        const input = layouterInputFor(base, pages[index]!, index);
        try {
          const invocation = await dispatchWithPageRetry(() =>
            deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `page:${index}`, input), args.parentRunId));
          trees[index] = treeFromInvocation(invocation, pages[index]!);
        } catch {
          trees[index] = { tree: fallbackTree(pages[index]!), fellBack: true };
        }
        if (trees[index]!.fellBack) {
          warnings.push(`第 ${index + 1} 页布局代理未收敛，已用兜底版式`);
        }
      }
    });
    await Promise.all(workers);

    // 按页序编译落页：fill → 进度广播。
    // 两条防线：① 降档后仍有引擎硬闸类缺陷（重叠/emoji/溢出）的页落确定性兜底版式，
    // 不把会被引擎拒绝的 spec 送下去；② slideIndex 跟踪 deck 活页数（某页失败后
    // 后续页按「追加」语义落，不会越界级联失败）。重排重落不重复计数：按页号集合统计。
    const BLOCKING_DEFECTS = new Set(["overlap", "emoji", "overflow", "font_floor", "canvas", "element_cap"]);
    const appliedPages = new Set<number>();
    /** 页号 → 实际落进的 slideIndex（追加语义下可能与页号不同）。 */
    const appliedSlideIndex = new Map<number, number>();
    /** 页号 → 落页时的降档提示（审页降级复检时拼 focusHints）。 */
    const appliedFocusHints = new Map<number, string[]>();
    let livePageCount = 1;
    const applyPage = async (index: number, tree: LayoutTree): Promise<boolean> => {
      // 页脚页码用逻辑页号（1 基）；总页数按计划页数（落页失败的页不占页码）。
      const footerOpts = { pageIndex: index + 1, pageCount: pages.length };
      let final = finalizeTree(tree, contract, imageArs, footerOpts);
      if (final.degraded) warnings.push(`第 ${index + 1} 页经引擎降档兜底装下内容`);
      if (final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
        warnings.push(`第 ${index + 1} 页布局树未收敛（${final.defects[0]!.type}），已用兜底版式`);
        final = finalizeTree(fallbackTree(pages[index]!), contract, imageArs, footerOpts);
      }
      const specJson = JSON.stringify(final.spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        warnings.push(`第 ${index + 1} 页 PageSpec 超长，跳过`);
        return false;
      }
      const slideIndex = Math.min(index, livePageCount);
      const result = await bridge.fillPage({ fileId: fileEntryId, slideIndex, specJson });
      if (!result.ok || result.applied !== true) {
        warnings.push(`第 ${index + 1} 页落页失败（${result.error ?? "桌面端拒绝"}）`);
        return false;
      }
      livePageCount = Math.max(livePageCount, slideIndex + 1);
      progress?.notify(progressKey, slideIndex);
      appliedPages.add(index);
      appliedSlideIndex.set(index, slideIndex);
      if (final.focusHints.length > 0) appliedFocusHints.set(index, final.focusHints);
      // 无审页代理时退回旧 VLM 封闭清单复检（有 dispatchReview 时审页统一在收尾阶段做）。
      if (!deps.dispatchReview && deps.visualReviewer) {
        let review: VisualReviewOutcome | null = null;
        try {
          review = await deps.visualReviewer.reviewPage({
            fileId: fileEntryId,
            slideIndex,
            fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId: fileEntryId, slideIndex }), "base64"),
            ...(final.focusHints.length > 0 ? { focusHints: final.focusHints } : {}),
          });
        } catch {
          review = null;
        }
        if (review?.status === "fail") {
          warnings.push(`第 ${index + 1} 页视觉复检不通过${review.retriesExhausted ? "（重试上限，放行）" : ""}`);
        }
      }
      return true;
    };

    for (let index = 0; index < pages.length; index++) {
      await applyPage(index, trees[index]!.tree);
    }

    // 页间相似度审计：相邻同签名页重排一次（带邻页签名提示），重排结果替换重落。
    const rerollTargets = auditSimilarity(trees.map((t) => t.tree));
    for (const index of rerollTargets.slice(0, 2)) {
      const signatures = [
        ...(index > 0 ? [treeSignature(trees[index - 1]!.tree)] : []),
        ...(index + 1 < trees.length ? [treeSignature(trees[index + 1]!.tree)] : []),
      ];
      const input = layouterInputFor(base, pages[index]!, index, signatures);
      try {
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `reroll:${index}`, input), args.parentRunId));
        const rerolled = treeFromInvocation(invocation, pages[index]!);
        if (!rerolled.fellBack && treeSignature(rerolled.tree) !== treeSignature(trees[index]!.tree)) {
          trees[index] = rerolled;
          warnings.push(`第 ${index + 1} 页与邻页结构雷同，已重排`);
          await applyPage(index, rerolled.tree);
        }
      } catch {
        // 重排失败保留原页
      }
    }

    // 审页阶段：slides-reviewer 并发看最终页态（窗口 4）。截图经 attachments 直投
    // 多模态模型；revised 的页网关机械套用修正树重落一次（每页至多一次修正）。
    // 审页代理失败/超时的页降级跑旧 VLM 封闭清单（warning 保底）。
    if (deps.dispatchReview) {
      const reviewIndexes = [...appliedPages].sort((a, b) => a - b);
      let reviewCursor = 0;
      const reviewWorker = async (): Promise<void> => {
        for (;;) {
          const index = reviewCursor++;
          if (index >= reviewIndexes.length) return;
          const pageIndex = reviewIndexes[index]!;
          const slideIndex = appliedSlideIndex.get(pageIndex) ?? pageIndex;
          const manualToken = `${token}#${String(pageIndex)}`;
          registerReviewManual(manualToken, {
            deckToken: token,
            page: pages[pageIndex] as Record<string, unknown>,
            currentTree: trees[pageIndex]!.tree,
          });
          try {
            // 压缩后再投：PNG 无损在背景图页可达 1.5MB+，直投会 413；失败回退原图。
            const rawPng = await bridge.renderPage({ fileId: fileEntryId, slideIndex });
            let shotBase64 = rawPng;
            let shotMime = "image/png";
            try {
              shotBase64 = await pngBase64ToJpegBase64(rawPng);
              shotMime = "image/jpeg";
            } catch {
              // sips 不可用时保持原 PNG 行为
            }
            const invocation = await dispatchWithPageRetry(() => deps.dispatchReview!(
              {
                task: "review",
                manualToken,
                pageIndex,
                totalPages: pages.length,
                ...(typeof (pages[pageIndex] as { title?: unknown }).title === "string"
                  ? { title: (pages[pageIndex] as { title: string }).title.slice(0, 80) }
                  : {}),
                ...(typeof (pages[pageIndex] as { role?: unknown }).role === "string"
                  ? { role: (pages[pageIndex] as { role: string }).role }
                  : {}),
                ...(typeof (pages[pageIndex] as { density?: unknown }).density === "string"
                  ? { density: (pages[pageIndex] as { density: string }).density }
                  : {}),
              },
              deps.makeKey(args.runId, "slides-reviewer", `review:${pageIndex}`, { pageIndex }),
              args.parentRunId,
              [{ filename: `page-${String(pageIndex + 1)}.${shotMime === "image/jpeg" ? "jpg" : "png"}`, mimeType: shotMime, kind: "image", dataUrl: `data:${shotMime};base64,${shotBase64}` }],
            ));;
            if (invocation.status !== "completed") {
              throw new Error(invocation.errorCode ?? invocation.status);
            }
            const structured = invocation.result?.structuredOutput;
            const revisedTree = structured !== null && typeof structured === "object" && !Array.isArray(structured)
              ? (structured as Record<string, unknown>).tree
              : null;
            if (revisedTree !== null && typeof revisedTree === "object" && !Array.isArray(revisedTree)) {
              let tree: LayoutTree;
              try {
                tree = normalizeTree(revisedTree);
              } catch {
                warnings.push(`第 ${pageIndex + 1} 页审页修正树非法，保留原页`);
                continue;
              }
              const final = finalizeTree(tree, contract, imageArs);
              if (final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
                warnings.push(`第 ${pageIndex + 1} 页审页修正未收敛，保留原页`);
                continue;
              }
              const reapplied = await bridge.fillPage({
                fileId: fileEntryId,
                slideIndex,
                specJson: JSON.stringify(final.spec),
              });
              if (reapplied.ok && reapplied.applied === true) {
                trees[pageIndex] = { tree, fellBack: false };
                warnings.push(`第 ${pageIndex + 1} 页经审页代理重排`);
              } else {
                warnings.push(`第 ${pageIndex + 1} 页审页重落失败，保留原页`);
              }
            }
          } catch {
            // 审页代理不可用/失败：该页降级跑旧 VLM 封闭清单。
            if (deps.visualReviewer) {
              try {
                const review = await deps.visualReviewer.reviewPage({
                  fileId: fileEntryId,
                  slideIndex,
                  fetchPng: async () => Buffer.from(await bridge.renderPage({ fileId: fileEntryId, slideIndex }), "base64"),
                  ...(appliedFocusHints.get(pageIndex)?.length ? { focusHints: appliedFocusHints.get(pageIndex)! } : {}),
                });
                if (review.status === "fail") {
                  warnings.push(`第 ${pageIndex + 1} 页视觉复检不通过${review.retriesExhausted ? "（重试上限，放行）" : ""}`);
                }
              } catch {
                // 复检也失败：放行（warning 已有审页失败信息时不再叠加）
              }
            } else {
              warnings.push(`第 ${pageIndex + 1} 页审页代理失败，跳过审页`);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, reviewIndexes.length) }, () => reviewWorker()));
    }

    if (appliedPages.size === 0) {
      return fail("slides_layout_apply_failed", "全部页面落页失败；方案已就绪，可重试 generate。", true, { fileEntryId });
    }
    const completed = appliedPages.size === pages.length;
    if (completed && args.draftDocumentId) {
      void args.trashDraft(args.draftDocumentId).catch(() => {});
    }
    const settleStyleSessionId = args.settle.styleSessionIdToSettle ?? null;
    if (completed && settleStyleSessionId && args.styleSessions) {
      args.styleSessions.patch(settleStyleSessionId, { stage: "confirmed" });
    }
    if (completed && args.settle.pageImagesSessionId && args.pageImagesStore) {
      args.pageImagesStore.patch(args.settle.pageImagesSessionId, { stage: "resolved" });
    }
    return {
      content: JSON.stringify({
        ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
        status: completed ? "completed" : "partial",
        fileEntryId,
        fileName: originalName,
        pages: appliedPages.size,
        outline,
        warnings,
        summary: completed
          ? `已生成 ${appliedPages.size} 页演示文稿`
          : `已生成 ${appliedPages.size}/${pages.length} 页，未完成页可重试`,
      }),
      details: { fileEntryId, pages: appliedPages.size, warnings },
    };
  } catch (error) {
    return fail(
      "slides_layout_tail_failed",
      `布局树落页失败：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    dropDeckLayoutContext(token);
    dropReviewManuals(`${token}#`);
    progress?.disarm(progressKey);
  }
}
