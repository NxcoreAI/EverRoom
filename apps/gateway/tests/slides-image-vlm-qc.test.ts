import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { createSlideImageVlmReviewer } from "../src/modules/subagents/slides-image-vlm-qc.js";
import { generateSlidesPageImages } from "../src/modules/subagents/slides-page-images.js";

function imageBytes(): { buffer: Buffer; mime: string } {
  const canvas = createCanvas(800, 450);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 800, 450);
  gradient.addColorStop(0, "#1f3a5f");
  gradient.addColorStop(1, "#d9c7a3");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 800, 450);
  return { buffer: canvas.toBuffer("image/png"), mime: "image/png" };
}

describe("createSlideImageVlmReviewer", () => {
  it("parses a JSON verdict and returns the reviewer score", async () => {
    const vlm = {
      model: "fake",
      analyze: vi.fn(async (_image: { buffer: Buffer; mime: string }, _prompt: string) => ({ ok: false, score: 2, reason: "与页面无关" })),
    };
    const review = createSlideImageVlmReviewer(vlm)!;
    const verdict = await review(imageBytes(), "城市夜景");
    expect(verdict).toMatchObject({ ok: false, score: 2, reason: "与页面无关" });
    expect(vlm.analyze.mock.calls[0]![1]).toContain("城市夜景");
  });

  it("parses fenced JSON text and defaults malformed output to pass", async () => {
    const fenced = createSlideImageVlmReviewer({
      model: "fake",
      analyze: async () => "```json\n{\"ok\":true,\"score\":5,\"reason\":\"切题\"}\n```",
    })!;
    expect(await fenced(imageBytes(), "团队")).toMatchObject({ ok: true, score: 5 });
    const malformed = createSlideImageVlmReviewer({ model: "fake", analyze: async () => "not json" })!;
    expect(await malformed(imageBytes(), "团队")).toEqual({ ok: true, score: 3 });
  });

  it("returns undefined without a VLM", () => {
    expect(createSlideImageVlmReviewer(null)).toBeUndefined();
  });
});

describe("generateSlidesPageImages VLM gate", () => {
  it("rejects a score<=2 image and accepts a score-3 weak match with warning", async () => {
    const bytes = imageBytes();
    const plan = {
      pages: [
        { title: "无关", imagePrompt: "城市夜景" },
        { title: "弱相关", imagePrompt: "城市夜景" },
      ],
    };
    const images = {
      generateImage: vi.fn()
        .mockResolvedValueOnce({ contentHash: "a".repeat(64) })
        .mockResolvedValueOnce({ contentHash: "b".repeat(64) }),
    };
    let call = 0;
    const summary = await generateSlidesPageImages(plan, {
      images,
      readMaterialBytes: async () => bytes,
      reviewImage: async () => {
        call += 1;
        return call === 1 ? { ok: false, score: 2, reason: "无关" } : { ok: false, score: 3, reason: "弱相关" };
      },
    });
    expect(summary.failed).toBe(1);
    expect(summary.generated).toBe(1);
    expect(summary.results[0]?.error).toContain("切题质检");
    expect(summary.results[1]?.warning).toContain("弱相关");
  });
});
