import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { inspectSlideImage } from "../src/modules/subagents/slides-image-qc.js";

function png(draw: (ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void, width = 800, height = 450): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  draw(ctx);
  const buffer = canvas.toBuffer("image/png");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

describe("inspectSlideImage", () => {
  it("accepts a normal image with varied colors", async () => {
    const bytes = png((ctx) => {
      const gradient = ctx.createLinearGradient(0, 0, 800, 450);
      gradient.addColorStop(0, "#1f3a5f");
      gradient.addColorStop(1, "#d9c7a3");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 800, 450);
      ctx.fillStyle = "#c25b3a";
      ctx.fillRect(340, 180, 120, 90);
    });
    const result = await inspectSlideImage(bytes);
    expect(result.ok).toBe(true);
    expect(result.width).toBe(800);
    expect(result.uniqueColors).toBeGreaterThan(6);
  });

  it("rejects a solid color image", async () => {
    const result = await inspectSlideImage(png((ctx) => {
      ctx.fillStyle = "#f2f2f2";
      ctx.fillRect(0, 0, 800, 450);
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("纯色");
  });

  it("rejects a low-resolution image", async () => {
    const result = await inspectSlideImage(png((ctx) => {
      ctx.fillStyle = "#123456";
      ctx.fillRect(0, 0, 320, 200);
    }, 320, 200));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("分辨率");
  });
});
