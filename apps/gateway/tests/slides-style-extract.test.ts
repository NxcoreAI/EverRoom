import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  assignPaletteRoles,
  clusterPixels,
  contrast,
  extractColorClusters,
  hexToRgb,
  hue,
  luminance,
  rgbToHex,
  saturation,
} from "../src/modules/slides-style/extract.js";

/** 合成一张「纵览图」：米白底 + 深藏青主块 + 琥珀强调块 + 深灰字条。 */
function syntheticOverview(): Buffer {
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f5f2ec";
  context.fillRect(0, 0, 320, 180);
  context.fillStyle = "#1e3a5f";
  context.fillRect(0, 0, 320, 52);
  context.fillStyle = "#e0a03c";
  context.fillRect(248, 70, 56, 100);
  context.fillStyle = "#2f2b28";
  context.fillRect(16, 70, 190, 8);
  context.fillRect(16, 88, 160, 8);
  context.fillRect(16, 106, 175, 8);
  return canvas.toBuffer("image/png");
}

const OVERVIEW_FIXTURE = resolve("../../materials/ppt-style-experiments/qwen-image-overview-001.png");

describe("color math", () => {
  it("round-trips hex", () => {
    expect(rgbToHex(hexToRgb("#1e3a5f"))).toBe("#1e3a5f");
  });

  it("measures contrast monotonically", () => {
    const white = { r: 255, g: 255, b: 255 };
    expect(contrast(white, hexToRgb("#111111"))).toBeGreaterThan(contrast(white, hexToRgb("#666666")));
  });
});

describe("clusterPixels", () => {
  it("finds the dominant colors of a two-tone canvas", () => {
    const canvas = createCanvas(64, 64);
    const context = canvas.getContext("2d");
    context.fillStyle = "#101010";
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = "#e8e8e8";
    context.fillRect(0, 0, 30, 64);
    const data = context.getImageData(0, 0, 64, 64).data;
    const pixels: Array<{ r: number; g: number; b: number }> = [];
    for (let offset = 0; offset < data.length; offset += 4) {
      pixels.push({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! });
    }
    const clusters = clusterPixels(pixels);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters[0]!.ratio).toBeGreaterThan(0.4);
    // 量化均值允许 1~2 个色阶漂移，按明度段断言而不是精确色值。
    const luminances = clusters.map((cluster) => luminance(hexToRgb(cluster.hex)));
    expect(Math.max(...luminances)).toBeGreaterThan(0.8);
    expect(Math.min(...luminances)).toBeLessThan(0.03);
  });

  it("is deterministic across runs", async () => {
    const buffer = syntheticOverview();
    const first = await extractColorClusters({ buffer, mime: "image/png" });
    const second = await extractColorClusters({ buffer, mime: "image/png" });
    expect(second).toEqual(first);
  });
});

describe("extractColorClusters + assignPaletteRoles", () => {
  it("assigns roles on a synthetic overview (light bg, navy primary, amber accent)", async () => {
    const clusters = await extractColorClusters({ buffer: syntheticOverview(), mime: "image/png" });
    expect(clusters.length).toBeGreaterThanOrEqual(3);

    const roles = assignPaletteRoles(clusters);
    expect(roles.background).toMatch(/^#f[0-9a-f]/);
    expect(roles.darkCover).toBe(false);
    // 主色应是深藏青块：深、蓝相（量化均值允许小幅漂移，按明度+色相断言）。
    const primary = hexToRgb(roles.primary);
    expect(luminance(primary)).toBeLessThan(0.15);
    expect(hue(primary)).toBeGreaterThan(195);
    expect(hue(primary)).toBeLessThan(250);
    // 强调色应是琥珀块：暖相、饱和。
    const accent = hexToRgb(roles.accent);
    expect(saturation(accent)).toBeGreaterThan(0.5);
    expect(hue(accent)).toBeGreaterThan(15);
    expect(hue(accent)).toBeLessThan(55);
    // 文字与底色对比达标。
    expect(contrast(hexToRgb(roles.text), hexToRgb(roles.background))).toBeGreaterThanOrEqual(4.5);
    // 全部是合法 hex。
    for (const hex of [roles.background, roles.surface, roles.primary, roles.accent, roles.text, roles.textMuted, roles.onDarkText]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("handles a dark-background palette", async () => {
    const canvas = createCanvas(320, 180);
    const context = canvas.getContext("2d");
    context.fillStyle = "#0d1520";
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = "#f2f5f9";
    context.fillRect(20, 20, 120, 10);
    context.fillStyle = "#3aa0ff";
    context.fillRect(200, 60, 90, 90);
    const clusters = await extractColorClusters({ buffer: canvas.toBuffer("image/png"), mime: "image/png" });

    const roles = assignPaletteRoles(clusters);
    expect(roles.background).toBe("#0d1520");
    expect(roles.darkCover).toBe(true);
    expect(contrast(hexToRgb(roles.text), hexToRgb(roles.background))).toBeGreaterThanOrEqual(4.5);
  });

  it("returns a neutral fallback for empty clusters", () => {
    const roles = assignPaletteRoles([]);
    expect(roles.background).toBe("#ffffff");
    expect(roles.darkCover).toBe(false);
    expect(roles.accent).toBe(roles.primary);
    expect(roles.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(roles.accent).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps a single-brand palette instead of inventing a complementary accent", () => {
    const roles = assignPaletteRoles([
      { hex: "#ffffff", ratio: 0.8 },
      { hex: "#315b83", ratio: 0.12 },
      { hex: "#222222", ratio: 0.08 },
    ]);
    expect(roles.primary).toBe("#315b83");
    expect(roles.accent).toBe(roles.primary);
    expect(roles.darkCover).toBe(false);
  });

  it("smoke-runs on the real qwen overview sample", async () => {
    if (!existsSync(OVERVIEW_FIXTURE)) return;
    const buffer = await readFile(OVERVIEW_FIXTURE);
    const clusters = await extractColorClusters({ buffer, mime: "image/png" });
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    expect(clusters.reduce((sum, cluster) => sum + cluster.ratio, 0)).toBeGreaterThan(0.5);
    const roles = assignPaletteRoles(clusters);
    expect(roles.background).toMatch(/^#[0-9a-f]{6}$/);
  }, 30_000);
});
