/**
 * 编排阶段配图预热：slides-planner 在 arrange 过程中对决定写 imagePrompt 的页调
 * slides_image_prewarm 立即入池并发生成（生图与编排重叠，编排完素材基本就绪）。
 * plan_ready 后 reconcilePrewarm 对账：同页同提示词——已就绪的带 hash 进过目卡会话，
 * 在途的把 hashPromise 交 runner 等待（禁止重生成，防重复烧额度）；提示词漂移或
 * 未预热的页走原路径。planner 不调工具时对账为空，行为与现状完全一致。
 * 预热不可中止（run 取消也跑完），浪费上界 = MAX_PAGE_IMAGES 张。
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { SlidesStyleImageGenerator } from "../slides-style/image-gen.js";
import {
  collectPendingImagePages,
  composePageImagePrompt,
  MAX_PAGE_IMAGES,
  PAGE_IMAGE_RETRY_DELAYS_MS,
} from "./slides-page-images.js";

interface PrewarmEntry {
  /** 1 基页序（与 planner 工具参数一致）。 */
  pageIndex: number;
  imagePrompt: string;
  settled: boolean;
  hash: string | null;
  hashPromise: Promise<string | null>;
}

interface PrewarmContext {
  entries: Map<number, PrewarmEntry>;
  scheduler: Scheduler;
  style: SlidesPrewarmRegisterInput;
}

/** 简单槽位信号量：并发 4 + 首批 stagger（与页图 runner 同配方，平滑中转 429）。 */
interface Scheduler {
  acquire(seq: number): Promise<void>;
  release(): void;
}

const PREWARM_CONCURRENCY = 4;
const PREWARM_FIRST_BURST_STAGGER_MS = 3000;
const PREWARM_TTL_MS = 10 * 60_000;

const registry = new Map<string, { ctx: PrewarmContext; expiresAt: number }>();

function createScheduler(): Scheduler {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(seq: number): Promise<void> {
      if (seq > 0 && seq < PREWARM_CONCURRENCY) {
        await new Promise((resolve) => setTimeout(resolve, seq * PREWARM_FIRST_BURST_STAGGER_MS));
      }
      if (active >= PREWARM_CONCURRENCY) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
        return;
      }
      active += 1;
    },
    release(): void {
      active = Math.max(0, active - 1);
      while (active < PREWARM_CONCURRENCY && waiters.length > 0) {
        const wake = waiters.shift()!;
        active += 1;
        wake();
      }
    },
  };
}

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of registry) {
    if (entry.expiresAt <= now) registry.delete(token);
  }
}

export interface SlidesPrewarmRegisterInput {
  roomId: string;
  draftDocumentId: string;
  stylePalette: { primary?: string; accent?: string; background?: string } | null;
  images: Pick<SlidesStyleImageGenerator, "generateImage">;
}

export function newPrewarmToken(): string {
  return `prewarm:${randomUUID()}`;
}

export function registerPrewarm(token: string, input: SlidesPrewarmRegisterInput): void {
  sweep();
  registry.set(token, {
    ctx: { entries: new Map(), scheduler: createScheduler(), style: input },
    expiresAt: Date.now() + PREWARM_TTL_MS,
  });
}

function dropPrewarm(token: string): void {
  registry.delete(token);
}

export function takePrewarm(token: string): PrewarmContext | null {
  const hit = registry.get(token);
  if (!hit) return null;
  dropPrewarm(token);
  return hit.ctx;
}

export type PrewarmEnqueueOutcome =
  | { ok: true; pageIndex: number }
  | { ok: false; reason: string };

/** planner 工具入口：校验并入池，立即返回 ack（生图后台推进，不阻塞编排）。 */
export function enqueuePrewarmImage(token: string, pageIndex: number, imagePrompt: string): PrewarmEnqueueOutcome {
  const hit = registry.get(token);
  if (!hit) return { ok: false, reason: "prewarmToken 未注册或已失效；继续完成方案即可，生图按原路径进行" };
  const prompt = imagePrompt.trim();
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 32) {
    return { ok: false, reason: "pageIndex 须为该页在 pages 中的序号（1~32 的整数）" };
  }
  if (prompt.length < 8 || prompt.length > 600) {
    return { ok: false, reason: "imagePrompt 须为 8~600 字的生图提示词定稿" };
  }
  const { entries, scheduler, style } = hit.ctx;
  const existing = entries.get(pageIndex);
  if (existing && existing.imagePrompt === prompt) return { ok: true, pageIndex };
  if (!existing && entries.size >= MAX_PAGE_IMAGES) {
    return { ok: false, reason: `预热上限 ${MAX_PAGE_IMAGES} 张已满；其余页的生图按原路径在方案确认后进行` };
  }
  const seq = entries.size;
  const entry: PrewarmEntry = {
    pageIndex,
    imagePrompt: prompt,
    settled: false,
    hash: null,
    hashPromise: Promise.resolve(null),
  };
  entry.hashPromise = (async () => {
    await scheduler.acquire(seq);
    try {
      const result = await style.images.generateImage({
        prompt: composePageImagePrompt(prompt, style.stylePalette),
        retryDelaysMs: PAGE_IMAGE_RETRY_DELAYS_MS,
      });
      entry.hash = result.contentHash;
      return result.contentHash;
    } catch {
      entry.hash = null;
      return null;
    } finally {
      entry.settled = true;
      scheduler.release();
    }
  })();
  entries.set(pageIndex, entry);
  hit.expiresAt = Date.now() + PREWARM_TTL_MS;
  return { ok: true, pageIndex };
}

export interface PrewarmReadyHit {
  contentHash: string;
  imagePrompt: string;
}

export interface PrewarmReconciliation {
  /** 已就绪：pageIndex0（plan.pages 下标）→ 产物。 */
  ready: Map<number, PrewarmReadyHit>;
  /** 在途：pageIndex0 → hash promise（交 runner 等待）。 */
  inflight: Map<number, Promise<string | null>>;
  /** V1（无会话存储）路径用：有界等待在途项，返回等待后新就绪的（同时并入 ready）。 */
  settle(timeoutMs: number): Promise<Map<number, PrewarmReadyHit>>;
}

/** plan_ready 后对账（取出并注销 token）：同页且 imagePrompt 严格相等才认预热产物。 */
export function reconcilePrewarm(token: string, plan: Record<string, unknown>): PrewarmReconciliation | null {
  const ctx = takePrewarm(token);
  if (!ctx) return null;
  const ready = new Map<number, PrewarmReadyHit>();
  const inflight = new Map<number, Promise<string | null>>();
  const entryRefs = new Map<number, PrewarmEntry>();
  for (const item of collectPendingImagePages(plan)) {
    const entry = ctx.entries.get(item.pageIndex + 1);
    if (!entry || entry.imagePrompt !== item.imagePrompt) continue;
    if (entry.settled) {
      if (entry.hash) ready.set(item.pageIndex, { contentHash: entry.hash, imagePrompt: entry.imagePrompt });
    } else {
      inflight.set(item.pageIndex, entry.hashPromise);
      entryRefs.set(item.pageIndex, entry);
    }
  }
  return {
    ready,
    inflight,
    async settle(timeoutMs: number): Promise<Map<number, PrewarmReadyHit>> {
      if (entryRefs.size === 0) return new Map();
      await Promise.race([
        Promise.allSettled([...entryRefs.values()].map((entry) => entry.hashPromise)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      const newlyReady = new Map<number, PrewarmReadyHit>();
      for (const [pageIndex, entry] of entryRefs) {
        if (entry.settled && entry.hash && !ready.has(pageIndex)) {
          const hit = { contentHash: entry.hash, imagePrompt: entry.imagePrompt };
          ready.set(pageIndex, hit);
          newlyReady.set(pageIndex, hit);
        }
      }
      return newlyReady;
    },
  };
}

/** 就绪产物注入 plan.materials（镜像 runner.patchPage 格式）。 */
export function applyPrewarmReadyToPlan(
  plan: Record<string, unknown>,
  ready: Map<number, PrewarmReadyHit>,
): void {
  if (ready.size === 0) return;
  const planPages = Array.isArray(plan.pages) ? plan.pages : [];
  for (const [pageIndex, hit] of ready) {
    const target = planPages[pageIndex];
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    (target as Record<string, unknown>).materials = [{
      url: `everroom-material://${hit.contentHash}`,
      desc: `AI 生成配图：${hit.imagePrompt.slice(0, 180)}`,
    }];
  }
}

export function createSlidesImagePrewarmTools(): PiAgentRuntimeTool[] {
  const tool: PiAgentRuntimeTool = {
    name: "slides_image_prewarm",
    label: "配图预热",
    description: [
      "为决定写 imagePrompt 的页预热 AI 生图：入队即后台并发生成，与编排同时进行。",
      "决定为某页写 imagePrompt 时立即调用一次；同页同提示词重复调用幂等。",
      "最终方案里该页 imagePrompt 与预热时保持一字不差，网关据此对账，产物直接进过目卡。",
    ].join(""),
    parameters: Type.Object({
      prewarmToken: Type.String({
        minLength: 8,
        maxLength: 200,
        description: "输入里的 prewarmToken，原样传入",
      }),
      pageIndex: Type.Number({
        minimum: 1,
        maximum: 32,
        description: "该页在方案 pages 中的序号（1 起）",
      }),
      imagePrompt: Type.String({
        minLength: 8,
        maxLength: 600,
        description: "该页的生图提示词定稿（与最终方案里的 imagePrompt 一字不差）",
      }),
    }, { additionalProperties: false }),
    promptSnippet: "配图预热",
    executionMode: "sequential",
    execute: async (_run, params) => {
      const outcome = enqueuePrewarmImage(
        String(params.prewarmToken ?? ""),
        Number(params.pageIndex),
        String(params.imagePrompt ?? ""),
      );
      return { content: JSON.stringify(outcome), details: outcome };
    },
  };
  return [tool];
}
