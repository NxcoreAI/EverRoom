import { describe, expect, it, vi } from "vitest";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import {
  applyPrewarmReadyToPlan,
  createSlidesImagePrewarmTools,
  enqueuePrewarmImage,
  newPrewarmToken,
  reconcilePrewarm,
  registerPrewarm,
} from "../src/modules/subagents/slides-page-images-prewarm.js";
import { MAX_PAGE_IMAGES } from "../src/modules/subagents/slides-page-images.js";
import { SlidesPageImageRunner } from "../src/modules/subagents/slides-page-images-runner.js";
import { openPageImagesConfirm } from "../src/modules/subagents/slides-page-images-stage.js";
import type {
  SlidesPageImagePage,
  SlidesPageImageSessionData,
  SlidesPageImageSessionStore,
} from "../src/modules/subagents/slides-page-images-store.js";

const PROMPT = "深蓝科技感城市天际线，横幅构图，写实摄影";

function imagesReturning(hash: string) {
  return { generateImage: vi.fn(async () => ({ contentHash: hash })) };
}

function register(images: { generateImage: ReturnType<typeof vi.fn> } = imagesReturning("a".repeat(64))) {
  const token = newPrewarmToken();
  registerPrewarm(token, {
    draftDocumentId: "draft-1",
    stylePalette: null,
    images: images as never,
  });
  return { token, images };
}

describe("预热池", () => {
  it("未注册 token 拒绝；参数越界拒绝", () => {
    const outcome = enqueuePrewarmImage("prewarm:not-registered", 1, PROMPT);
    expect(outcome).toMatchObject({ ok: false });
    const { token } = register();
    expect(enqueuePrewarmImage(token, 0, PROMPT)).toMatchObject({ ok: false });
    expect(enqueuePrewarmImage(token, 1, "短")).toMatchObject({ ok: false });
  });

  it("同页同提示词幂等；上限 MAX_PAGE_IMAGES 后拒绝新页", () => {
    const { token } = register();
    for (let page = 1; page <= MAX_PAGE_IMAGES; page += 1) {
      expect(enqueuePrewarmImage(token, page, `${PROMPT}${String(page)}`)).toMatchObject({ ok: true });
    }
    expect(enqueuePrewarmImage(token, 1, `${PROMPT}1`)).toMatchObject({ ok: true, pageIndex: 1 });
    expect(enqueuePrewarmImage(token, MAX_PAGE_IMAGES + 1, PROMPT)).toMatchObject({ ok: false });
  });

  it("reconcile：就绪进 ready、在途进 inflight、提示词漂移不认、token 一次性", async () => {
    const { token, images } = register();
    const slowToken = newPrewarmToken();
    registerPrewarm(slowToken, {
      draftDocumentId: "draft-1",
      stylePalette: null,
      images: { generateImage: () => new Promise(() => {}) } as never,
    });
    enqueuePrewarmImage(slowToken, 1, PROMPT);
    enqueuePrewarmImage(slowToken, 2, "另一页提示词，完全不同的画面内容描述");
    const plan = {
      title: "t",
      pages: [
        { title: "页1", imagePrompt: PROMPT },
        { title: "页2", imagePrompt: "另一页提示词，完全不同的画面内容描述" },
        { title: "页3", imagePrompt: `${PROMPT}改写了` },
      ],
    };
    const rec = reconcilePrewarm(slowToken, plan);
    expect(rec).not.toBeNull();
    expect(rec!.inflight.size).toBe(2); // 页1、页2 命中在途；页3 提示词漂移不认
    expect(rec!.inflight.has(2)).toBe(false);
    expect(rec!.ready.size).toBe(0);
    expect(reconcilePrewarm(slowToken, plan)).toBeNull(); // token 已取出注销
    expect(images.generateImage).not.toHaveBeenCalled();
  });

  it("生图走 composePageImagePrompt 同款合成；失败落 null 不抛", async () => {
    const hash = "b".repeat(64);
    const images = { generateImage: vi.fn(async () => ({ contentHash: hash })) };
    const { token } = register(images);
    enqueuePrewarmImage(token, 1, PROMPT);
    const rec = reconcilePrewarm(token, { pages: [{ title: "页1", imagePrompt: PROMPT }] });
    expect(rec).not.toBeNull();
    const settled = await rec!.settle(1000);
    expect(settled.get(0)).toMatchObject({ contentHash: hash });
    expect(images.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(PROMPT),
    }));
  });

  it("applyPrewarmReadyToPlan 注入 everroom-material 引用", () => {
    const hash = "c".repeat(64);
    const plan = { title: "t", pages: [{ title: "页1", imagePrompt: PROMPT }, { title: "页2" }] };
    applyPrewarmReadyToPlan(plan, new Map([[0, { contentHash: hash, imagePrompt: PROMPT }]]));
    const pages = plan.pages as Array<Record<string, unknown>>;
    expect(pages[0]?.materials).toEqual([
      { url: `everroom-material://${hash}`, desc: `AI 生成配图：${PROMPT.slice(0, 180)}` },
    ]);
    expect(pages[1]?.materials).toBeUndefined();
  });

  it("工具：参数透传 enqueue，返回 JSON ack", async () => {
    const tools = createSlidesImagePrewarmTools() as PiAgentRuntimeTool[];
    const tool = tools[0]!;
    expect(tool.name).toBe("slides_image_prewarm");
    const bad = await tool.execute({} as never, { prewarmToken: "prewarm:none", pageIndex: 1, imagePrompt: PROMPT } as never);
    expect(JSON.parse((bad as { content: string }).content)).toMatchObject({ ok: false });
    const { token } = register();
    const ok = await tool.execute({} as never, { prewarmToken: token, pageIndex: 1, imagePrompt: PROMPT } as never);
    expect(JSON.parse((ok as { content: string }).content)).toMatchObject({ ok: true, pageIndex: 1 });
  });
});

function fakeSessions(plan: Record<string, unknown>, pages: SlidesPageImagePage[]) {
  let session: SlidesPageImageSessionData = {
    id: "session-1",
    draftDocumentId: "draft-1",
    styleSessionId: null,
    stage: "confirm",
    generation: 1,
    plan,
    pages,
    stylePalette: null,
    updatedAt: Date.now(),
  };
  return {
    byDraftId: () => session,
    patch: (_id: string, fields: Partial<SlidesPageImageSessionData>) => {
      session = { ...session, ...fields };
    },
    upsertForDraft: (input: { plan: Record<string, unknown>; pages: SlidesPageImagePage[] }) => {
      session = { ...session, plan: input.plan, pages: input.pages, stage: "confirm", updatedAt: Date.now() };
      return session;
    },
    read: () => session,
  };
}

describe("预热交接", () => {
  it("openPageImagesConfirm：就绪项带 hash 进会话并注入 plan.materials（过目卡亮真图）", () => {
    const plan = { title: "t", pages: [{ title: "页1", imagePrompt: PROMPT }, { title: "页2", imagePrompt: "另一页提示词，完全不同的画面内容描述" }] };
    const sessions = fakeSessions(plan, []);
    const hash = "d".repeat(64);
    const runner = { isRunning: () => false, start: vi.fn(async () => {}), abort: vi.fn(), settle: vi.fn(async () => {}) };
    const ready = new Map([[0, { contentHash: hash, imagePrompt: PROMPT }]]);
    const outcome = openPageImagesConfirm(
      { draftDocumentId: "draft-1", styleSessionId: null, plan, stylePalette: null },
      {
        sessions: sessions as unknown as SlidesPageImageSessionStore,
        images: imagesReturning(hash) as never,
        runner: runner as unknown as SlidesPageImageRunner,
        preseed: { ready, inflight: new Map(), settle: async () => new Map() },
      },
    );
    expect(outcome.kind).toBe("waiting");
    const session = sessions.read();
    expect(session.pages[0]?.contentHash).toBe(hash);
    expect(session.pages[1]?.contentHash).toBeNull();
    const planPages = session.plan.pages as Array<Record<string, unknown>>;
    expect((planPages[0]?.materials as Array<{ url: string }>)[0]?.url).toBe(`everroom-material://${hash}`);
    expect(runner.start).toHaveBeenCalled();
  });

  it("runner：在途预热页等同一张结果，不重新生图", async () => {
    const plan = { title: "t", pages: [{ title: "页1", imagePrompt: PROMPT }] };
    const pages: SlidesPageImagePage[] = [{ pageIndex: 0, title: "页1", imagePrompt: PROMPT, contentHash: null }];
    const sessions = fakeSessions(plan, pages);
    sessions.patch("session-1", { stage: "review" });
    const images = imagesReturning("e".repeat(64));
    const hash = "f".repeat(64);
    const inflight = new Map([[0, Promise.resolve(hash)]]);
    const runner = new SlidesPageImageRunner();
    await runner.start(
      { draftDocumentId: "draft-1" },
      {
        sessions: sessions as unknown as SlidesPageImageSessionStore,
        images: images as never,
        sessionId: "session-1",
        preseed: { ready: new Map(), inflight, settle: async () => new Map() },
      },
    );
    const session = sessions.read();
    expect(session.pages[0]?.contentHash).toBe(hash);
    const planPages = session.plan.pages as Array<Record<string, unknown>>;
    expect((planPages[0]?.materials as Array<{ url: string }>)[0]?.url).toBe(`everroom-material://${hash}`);
    expect(images.generateImage).not.toHaveBeenCalled();
  });

  it("runner：预热失败（null）标记 failed 不再重试", async () => {
    const plan = { title: "t", pages: [{ title: "页1", imagePrompt: PROMPT }] };
    const pages: SlidesPageImagePage[] = [{ pageIndex: 0, title: "页1", imagePrompt: PROMPT, contentHash: null }];
    const sessions = fakeSessions(plan, pages);
    sessions.patch("session-1", { stage: "review" });
    const images = imagesReturning("e".repeat(64));
    const runner = new SlidesPageImageRunner();
    await runner.start(
      { draftDocumentId: "draft-1" },
      {
        sessions: sessions as unknown as SlidesPageImageSessionStore,
        images: images as never,
        sessionId: "session-1",
        preseed: { ready: new Map(), inflight: new Map([[0, Promise.resolve(null)]]), settle: async () => new Map() },
      },
    );
    const session = sessions.read();
    expect(session.pages[0]?.contentHash).toBeNull();
    expect(session.pages[0]?.failed).toBe(true);
    expect(images.generateImage).not.toHaveBeenCalled();
  });
});
