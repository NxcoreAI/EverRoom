import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { analyzeReferenceImages } from "./reference-style.js";

function page(draw: (ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void): Buffer {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext("2d");
  draw(ctx);
  return canvas.toBuffer("image/png");
}

describe("analyzeReferenceImages", () => {
  it("extracts a light dense deck with a dark cover and blue brand", async () => {
    const cover = page((ctx) => {
      const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
      gradient.addColorStop(0, "#102A8A");
      gradient.addColorStop(1, "#315BFF");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(90, 520, 900, 90);
    });
    const content = page((ctx) => {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#1E1E22";
      for (let i = 0; i < 8; i += 1) ctx.fillRect(80, 120 + i * 54, 420 + (i % 3) * 90, 24);
      ctx.fillStyle = "#315BFF";
      ctx.fillRect(80, 70, 300, 34);
      ctx.fillStyle = "#E6E9F5";
      ctx.fillRect(620, 130, 500, 420);
    });
    const style = await analyzeReferenceImages([cover, content]);
    expect(style.pageCount).toBe(2);
    expect(style.darkCover).toBe(true);
    expect(style.palette.background).toMatch(/^#[0-9A-F]{6}$/);
    expect(style.palette.primary).toMatch(/^#[0-9A-F]{6}$/);
    const primary = style.palette.primary;
    const blue = parseInt(primary.slice(5, 7), 16) > parseInt(primary.slice(1, 3), 16);
    expect(blue).toBe(true);
    expect(style.density).not.toBe("sparse");
    expect(style.pageBudget).toBe(2);
  });
});
