import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PAGE_IMAGES,
  composePageImagePrompt,
  generateSlidesPageImages,
  type SlidesPageImagesDeps,
} from "../src/modules/subagents/slides-page-images.js";

type Update = { content: string; details: Record<string, unknown> };

function fakeImages(
  outcomes: Array<{ ok: true; hash: string } | { ok: false; error: Error }>,
): SlidesPageImagesDeps["images"] {
  let call = 0;
  return {
    generateImage: vi.fn(async () => {
      const outcome = outcomes[call] ?? { ok: true, hash: `hash-${String(call + 1)}` };
      call += 1;
      if (!outcome.ok) throw outcome.error;
      return { contentHash: outcome.hash };
    }),
  };
}

function planWith(pages: Array<Record<string, unknown>>): Record<string, unknown> {
  return { title: "季度汇报", pages };
}

describe("composePageImagePrompt", () => {
  it("拼调色板后缀，非 hex 色值忽略", () => {
    const prompt = composePageImagePrompt("车间实拍", { primary: "#1E3A5F", accent: "blue", background: "#F5F2EC" });
    expect(prompt).toContain("车间实拍");
    expect(prompt).toContain("主色 #1E3A5F");
    expect(prompt).toContain("底色 #F5F2EC");
    expect(prompt).not.toContain("强调");
    expect(prompt.endsWith("画面统一在此色调内。")).toBe(true);
  });

  it("无调色板原样返回；整体截 600 字且后缀不被截掉", () => {
    expect(composePageImagePrompt("  车间实拍 ", null)).toBe("车间实拍");
    expect(composePageImagePrompt("车间实拍", undefined)).toBe("车间实拍");
    const long = "景".repeat(800);
    const composed = composePageImagePrompt(long, { primary: "#1E3A5F" });
    expect(composed.length).toBe(600);
    expect(composed.endsWith("画面统一在此色调内。")).toBe(true);
  });
});

describe("generateSlidesPageImages", () => {
  it("无图页按 imagePrompt 回填 everroom-material:// 引用与 desc", async () => {
    const plan = planWith([
      { title: "封面", imagePrompt: "深蓝科技感城市天际线，横幅构图" },
      { title: "业绩", materials: [{ url: "https://img.example.com/a.png", desc: "已有图" }] },
      { title: "计划", imagePrompt: "团队协作白板特写，暖光" },
      { title: "数据", notes: "退化图形版式" },
    ]);
    const images = fakeImages([{ ok: true, hash: "a".repeat(64) }, { ok: true, hash: "b".repeat(64) }]);

    const summary = await generateSlidesPageImages(plan, { images });

    expect(summary).toMatchObject({ requested: 2, generated: 2, failed: 0 });
    expect(summary.results).toEqual([
      { pageIndex: 0, contentHash: "a".repeat(64) },
      { pageIndex: 2, contentHash: "b".repeat(64) },
    ]);
    const pages = plan.pages as Array<Record<string, unknown>>;
    expect(pages[0]?.materials).toEqual([
      { url: `everroom-material://${"a".repeat(64)}`, desc: "AI 生成配图：深蓝科技感城市天际线，横幅构图" },
    ]);
    expect(pages[1]?.materials).toEqual([{ url: "https://img.example.com/a.png", desc: "已有图" }]);
    expect(pages[2]?.materials).toEqual([
      { url: `everroom-material://${"b".repeat(64)}`, desc: "AI 生成配图：团队协作白板特写，暖光" },
    ]);
    expect(pages[3]?.materials).toBeUndefined();
  });

  it("生成图确定性 QC 未通过时该页不落图并计入 failed", async () => {
    const canvas = createCanvas(800, 450);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(0, 0, 800, 450);
    const buffer = canvas.toBuffer("image/png");
    const solid = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const plan = planWith([{ title: "封面", imagePrompt: "纯色占位图" }]);
    const summary = await generateSlidesPageImages(plan, {
      images: fakeImages([{ ok: true, hash: "d".repeat(64) }]),
      readMaterialBytes: async () => ({ buffer, mime: "image/png" }),
    });
    expect(summary.failed).toBe(1);
    expect(summary.generated).toBe(0);
    expect(summary.results[0]?.error).toContain("配图质检未通过");
    expect((plan.pages as Array<Record<string, unknown>>)[0]?.materials).toBeUndefined();
    expect(solid.byteLength).toBeGreaterThan(0);
  });

  it("已命中素材的页忽略 imagePrompt；无 imagePrompt 的页不动", async () => {
    const plan = planWith([
      { title: "命中页", materials: [{ url: "everroom-material://" + "c".repeat(64) }], imagePrompt: "不该生成" },
      { title: "普通页", points: ["要点"] },
    ]);
    const images = fakeImages([]);

    const summary = await generateSlidesPageImages(plan, { images });

    expect(summary.requested).toBe(0);
    expect(images.generateImage).not.toHaveBeenCalled();
  });

  it("超过上限只取前 MAX_PAGE_IMAGES 页", async () => {
    const plan = planWith(
      Array.from({ length: MAX_PAGE_IMAGES + 3 }, (_, index) => ({ title: `页${index}`, imagePrompt: `提示${index}` })),
    );
    const images = fakeImages([]);

    const summary = await generateSlidesPageImages(plan, { images });

    expect(summary.requested).toBe(MAX_PAGE_IMAGES);
    expect(images.generateImage).toHaveBeenCalledTimes(MAX_PAGE_IMAGES);
  });

  it("单页失败跳过不阻断，该页保持无素材", async () => {
    const plan = planWith([
      { title: "页1", imagePrompt: "提示1" },
      { title: "页2", imagePrompt: "提示2" },
      { title: "页3", imagePrompt: "提示3" },
    ]);
    const images = fakeImages([
      { ok: true, hash: "a".repeat(64) },
      { ok: false, error: new Error("生图请求失败（HTTP 500）") },
      { ok: true, hash: "c".repeat(64) },
    ]);

    const summary = await generateSlidesPageImages(plan, { images });

    expect(summary).toMatchObject({ requested: 3, generated: 2, failed: 1 });
    expect(summary.results.filter((result) => result.error)).toHaveLength(1);
    expect(summary.results.find((result) => result.pageIndex === 2)).toMatchObject({ contentHash: "c".repeat(64) });
    const pages = plan.pages as Array<Record<string, unknown>>;
    expect((pages[1]?.materials as unknown[] | undefined)).toBeUndefined();
    expect(pages[2]?.materials).toHaveLength(1);
  });

  it("无中转会话错误整批放弃，不再逐页调用", async () => {
    const plan = planWith([
      { title: "页1", imagePrompt: "提示1" },
      { title: "页2", imagePrompt: "提示2" },
    ]);
    const images = fakeImages([{ ok: false, error: new Error("生图中转会话不可用：需要已订阅账号且网关在线") }]);

    const summary = await generateSlidesPageImages(plan, { images });

    expect(summary).toMatchObject({ requested: 2, generated: 0, failed: 0 });
    expect(summary.skipped).toContain("中转会话不可用");
    expect(images.generateImage).toHaveBeenCalledTimes(1);
  });

  it("signal 已中止直接返回；deadline 到放弃剩余页", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedPlan = planWith([{ title: "页1", imagePrompt: "提示1" }]);
    const aborted = await generateSlidesPageImages(abortedPlan, {
      images: fakeImages([]),
      signal: controller.signal,
    });
    expect(aborted).toMatchObject({ requested: 1, generated: 0 });
    expect(aborted.skipped).toContain("中止");

    // now 注入：第一次取起点、第一次查表在时限内、第二次查表已超时，第二张被放弃。
    const plan = planWith([
      { title: "页1", imagePrompt: "提示1" },
      { title: "页2", imagePrompt: "提示2" },
    ]);
    let call = 0;
    const summary = await generateSlidesPageImages(plan, {
      images: fakeImages([{ ok: true, hash: "a".repeat(64) }]),
      now: () => {
        call += 1;
        return call === 1 ? 0 : call === 2 ? 1 : 16 * 60_000;
      },
    });
    expect(summary).toMatchObject({ requested: 2, generated: 1 });
    expect(summary.skipped).toContain("时限");
  });

  it("每张结算后广播 page_images 进度，doneCount 递增、pages 是待生图子集", async () => {
    const plan = planWith([
      { title: "封面", imagePrompt: "提示1" },
      { title: "业绩", points: ["x"] },
      { title: "计划", imagePrompt: "提示2" },
    ]);
    const updates: Update[] = [];
    const summary = await generateSlidesPageImages(plan, {
      images: fakeImages([{ ok: true, hash: "a".repeat(64) }, { ok: true, hash: "b".repeat(64) }]),
      onUpdate: (update) => updates.push(update),
    });

    expect(summary.generated).toBe(2);
    expect(updates).toHaveLength(2);
    const first = updates[0]!.details;
    expect(first.stage).toBe("page_images");
    expect(first.title).toBe("季度汇报");
    expect(first.totalPages).toBe(2);
    expect(first.doneCount).toBe(1);
    expect(first.pages).toEqual([{ pageIndex: 0, title: "封面" }, { pageIndex: 2, title: "计划" }]);
    expect(typeof first.updatedAt).toBe("number");
    expect(updates[1]!.details.doneCount).toBe(2);
  });
});
