/**
 * 纵览图提取（确定性部分）：像素主色聚类 + 色板角色分配。
 *
 * 原则（方案定稿）：颜色这半边全是程序计算，零视觉判断——聚类给
 * 「有哪些色、各占多少」，启发式给「谁扮演什么角色」；styler 子代理
 * 只做复核与微调。像素读数是唯一事实源，提示词里写的色号不作数。
 *
 * 实现：@napi-rs/canvas 缩采样读像素（1792×1024 → 240 宽，颜色统计
 * 不需要原始分辨率），RGB 直方图量化（每通道 4bit）+ 近色合并，
 * 全程确定性，同图必得同结果（测试可断言）。
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { StyleColorCluster } from "./types.js";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const SAMPLE_MAX_WIDTH = 240;
/** 量化步长：每通道 16 级。 */
const QUANT_SHIFT = 4;
/** 合并阈值：加权 RGB 距离平方（≈47/255 每通道）。 */
const MERGE_DISTANCE_SQ = 2_200;
/** 输出簇数上限。 */
const MAX_CLUSTERS = 6;
/** 占比低于此值的簇并入最近邻（避免碎色噪点）。 */
const MIN_CLUSTER_RATIO = 0.015;

export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

/** 相对亮度（WCAG）。 */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度（1~21，WCAG）。 */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

export function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

/** 色相（度，0~360）。 */
export function hue({ r, g, b }: Rgb): number {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;
  if (delta === 0) return 0;
  if (max === rr) return ((gg - bb) / delta % 6 + 6) % 6 * 60;
  if (max === gg) return ((bb - rr) / delta + 2) * 60;
  return ((rr - gg) / delta + 4) * 60;
}

export function hueDistance(a: Rgb, b: Rgb): number {
  const diff = Math.abs(hue(a) - hue(b));
  return Math.min(diff, 360 - diff);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function distanceSq(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  // 蓝-绿通道降权近似感知：人眼对绿最敏、蓝最钝。
  return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
}

/** 缩采样读像素。 */
async function samplePixels(image: { buffer: Buffer; mime: string }): Promise<Rgb[]> {
  const loaded = await loadImage(image.buffer);
  const scale = Math.min(1, SAMPLE_MAX_WIDTH / (loaded.width || SAMPLE_MAX_WIDTH));
  const width = Math.max(1, Math.round(loaded.width * scale));
  const height = Math.max(1, Math.round(loaded.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(loaded, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const pixels: Rgb[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    // 透明像素合成到白底（fillRect 已铺底，直接取即可）。
    pixels.push({ r: data[offset]!, g: data[offset + 1]!, b: data[offset + 2]! });
  }
  return pixels;
}

/** 主色聚类：直方图量化 → 均值色 → 近色合并 → 占比过滤。确定性输出。 */
export function clusterPixels(pixels: Rgb[]): StyleColorCluster[] {
  if (pixels.length === 0) return [];
  interface Bin {
    count: number;
    sumR: number;
    sumG: number;
    sumB: number;
  }
  const bins = new Map<number, Bin>();
  for (const pixel of pixels) {
    const key = ((pixel.r >> QUANT_SHIFT) << 8) | ((pixel.g >> QUANT_SHIFT) << 4) | (pixel.b >> QUANT_SHIFT);
    const bin = bins.get(key) ?? { count: 0, sumR: 0, sumG: 0, sumB: 0 };
    bin.count += 1;
    bin.sumR += pixel.r;
    bin.sumG += pixel.g;
    bin.sumB += pixel.b;
    bins.set(key, bin);
  }
  const seeds = Array.from(bins.values())
    .map((bin) => ({
      rgb: { r: bin.sumR / bin.count, g: bin.sumG / bin.count, b: bin.sumB / bin.count },
      count: bin.count,
    }))
    .sort((a, b) => b.count - a.count);

  // 近色合并：按占比从大到小吞并近邻。
  const merged: Array<{ rgb: Rgb; count: number }> = [];
  for (const seed of seeds) {
    const target = merged.find((cluster) => distanceSq(cluster.rgb, seed.rgb) < MERGE_DISTANCE_SQ);
    if (target) {
      const total = target.count + seed.count;
      target.rgb = {
        r: (target.rgb.r * target.count + seed.rgb.r * seed.count) / total,
        g: (target.rgb.g * target.count + seed.rgb.g * seed.count) / total,
        b: (target.rgb.b * target.count + seed.rgb.b * seed.count) / total,
      };
      target.count = total;
    } else {
      merged.push({ rgb: { ...seed.rgb }, count: seed.count });
    }
  }

  // 碎簇（<MIN_CLUSTER_RATIO）并入最近邻，防止噪点占坑。
  const significant = merged.filter((cluster) => cluster.count / pixels.length >= MIN_CLUSTER_RATIO);
  for (const small of merged.filter((cluster) => cluster.count / pixels.length < MIN_CLUSTER_RATIO)) {
    if (significant.length === 0) {
      significant.push(small);
      continue;
    }
    const nearest = significant.reduce((best, candidate) =>
      distanceSq(candidate.rgb, small.rgb) < distanceSq(best.rgb, small.rgb) ? candidate : best);
    const total = nearest.count + small.count;
    nearest.rgb = {
      r: (nearest.rgb.r * nearest.count + small.rgb.r * small.count) / total,
      g: (nearest.rgb.g * nearest.count + small.rgb.g * small.count) / total,
      b: (nearest.rgb.b * nearest.count + small.rgb.b * small.count) / total,
    };
    nearest.count = total;
  }

  return significant
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CLUSTERS)
    .map((cluster) => ({
      hex: rgbToHex(cluster.rgb),
      ratio: cluster.count / pixels.length,
    }));
}

export async function extractColorClusters(image: { buffer: Buffer; mime: string }): Promise<StyleColorCluster[]> {
  return clusterPixels(await samplePixels(image));
}

/** 色板角色分配的启发式结果；styler 复核时可整体沿用或逐项覆盖。 */
export interface PaletteRoles {
  background: string;
  surface: string;
  primary: string;
  accent: string;
  text: string;
  textMuted: string;
  onDarkText: string;
  darkCover: boolean;
}

export function assignPaletteRoles(clusters: StyleColorCluster[]): PaletteRoles {
  if (clusters.length === 0) {
    // 空输入给一套中性兜底（调用方几乎不会走到；保函数完备）。
    const background = "#ffffff";
    const primary = "#2f3e4e";
    return {
      background,
      surface: "#ffffff",
      primary,
      accent: primary,
      text: "#2b2b2b",
      textMuted: "#7a7a76",
      onDarkText: "#f5f5f2",
      darkCover: false,
    };
  }
  const byRatio = [...clusters].sort((a, b) => b.ratio - a.ratio);
  const background = byRatio[0]!;
  const bg = hexToRgb(background.hex);
  const dark = luminance(bg) < 0.35;

  // 主色：非底色簇里按「饱和度为主、覆盖与对比为辅」打分。
  const primaryCandidate = byRatio
    .slice(1)
    .filter((cluster) => cluster.ratio >= 0.02)
    .map((cluster) => {
      const rgb = hexToRgb(cluster.hex);
      const score = saturation(rgb) * 0.6
        + Math.min(cluster.ratio, 0.4) * 0.6
        + Math.min(contrast(rgb, bg) / 7, 1) * 0.3;
      return { hex: cluster.hex, rgb, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  const primary = primaryCandidate?.rgb ?? mix(bg, dark ? { r: 255, g: 255, b: 255 } : { r: 20, g: 24, b: 32 }, 0.55);

  // Keep observed accents; normalization handles readability without inventing a hue.
  const accentCandidate = byRatio
    .slice(1)
    .filter((cluster) => cluster.ratio >= 0.02)
    .map((cluster) => hexToRgb(cluster.hex))
    .find((rgb) => saturation(rgb) >= 0.35 && contrast(rgb, bg) >= 1.5 && hueDistance(rgb, primary) >= 40);
  const accent = accentCandidate ?? primary;

  // 文字色：与底色对比达标的最深（浅底）/最浅（深底）簇；不够就推导加深/提亮。
  const readable = byRatio
    .map((cluster) => hexToRgb(cluster.hex))
    .filter((rgb) => contrast(rgb, bg) >= 4.5);
  const text = dark
    ? (readable.at(-1) ?? mix(bg, { r: 255, g: 255, b: 255 }, 0.85))
    : (readable[0] ?? mix(bg, { r: 17, g: 17, b: 17 }, 0.85));

  return {
    background: background.hex,
    surface: rgbToHex(mix(bg, { r: 255, g: 255, b: 255 }, dark ? 0.07 : 0.55)),
    primary: rgbToHex(primary),
    accent: rgbToHex(accent),
    text: rgbToHex(text),
    textMuted: rgbToHex(mix(text, bg, 0.45)),
    onDarkText: rgbToHex(mix({ r: 255, g: 255, b: 255 }, primary, 0.1)),
    darkCover: dark,
  };
}

/** 保持饱和度/亮度、旋转色相（强调色推导用）。 */
export function rotateHue(source: Rgb, degrees: number, base: Rgb): Rgb {
  const max = Math.max(source.r, source.g, source.b) / 255;
  const min = Math.min(source.r, source.g, source.b) / 255;
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) {
    // 无彩色：从中性推导一个暖强调。
    return mix(base, { r: 214, g: 138, b: 61 }, 0.8);
  }
  const targetHue = (hue(source) + degrees) % 360;
  const sector = targetHue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
    : sector < 3 ? [0, chroma, secondary]
    : sector < 4 ? [0, secondary, chroma]
    : sector < 5 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  // 把纯 HSL 色度扇区平移到目标亮度。
  const lift = lightness - (r1 + g1 + b1) / 3;
  return {
    r: (r1 + lift) * 255,
    g: (g1 + lift) * 255,
    b: (b1 + lift) * 255,
  };
}
