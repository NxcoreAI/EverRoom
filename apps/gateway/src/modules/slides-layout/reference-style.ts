/**
 * 参考 deck 视觉抽取：从渲染页图里统计品牌色、底色、信息密度、深色封面与构图倾向。
 * 不调用模型；给 planner/styler 一个确定性的参考 token 快照，避免“参考 PDF 没进链路”。
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";

export interface ReferenceStyle {
  schemaVersion: "reference-style/v1";
  pageCount: number;
  palette: {
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    primary: string;
    accent: string;
    onDarkText: string;
    chartSeries: string[];
  };
  density: "sparse" | "standard" | "dense";
  darkCover: boolean;
  composition: "swiss" | "editorial" | "poster" | "immersive";
  imageTreatment: "fullBleed" | "sideBleed" | "inline";
  tableHeaderColor: string;
  pageBudget: number;
  /** 逐页视觉摘要，供 planner 理解参考节奏。 */
  pages: Array<{
    index: number;
    luminance: number;
    inkRatio: number;
    dark: boolean;
    composition: "swiss" | "editorial" | "poster" | "immersive";
  }>;
  confidence: number;
}

interface Sample {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const SAMPLE_WIDTH = 128;

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function rgb(value: string): [number, number, number] {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

async function sampleImage(buffer: Buffer): Promise<Sample> {
  const image = await loadImage(buffer);
  const scale = Math.min(1, SAMPLE_WIDTH / Math.max(1, image.width));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

interface PageStats {
  index: number;
  mean: number;
  inkRatio: number;
  dark: boolean;
  colors: Map<string, { count: number; r: number; g: number; b: number; sat: number; lum: number }>;
  composition: ReferenceStyle["pages"][number]["composition"];
}

function analyzePage(sample: Sample, index: number): PageStats {
  const colors = new Map<string, { count: number; r: number; g: number; b: number; sat: number; lum: number }>();
  let sum = 0;
  let darkCount = 0;
  let saturatedCount = 0;
  const count = sample.width * sample.height;
  for (let offset = 0; offset < sample.pixels.length; offset += 4) {
    const r = sample.pixels[offset]!;
    const g = sample.pixels[offset + 1]!;
    const b = sample.pixels[offset + 2]!;
    const lum = luminance(r, g, b);
    const sat = saturation(r, g, b);
    sum += lum;
    if (lum < 80) darkCount += 1;
    if (sat > 0.25 && lum > 25 && lum < 235) saturatedCount += 1;
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const entry = colors.get(key) ?? { count: 0, r: 0, g: 0, b: 0, sat: 0, lum: 0 };
    entry.count += 1;
    entry.r += r;
    entry.g += g;
    entry.b += b;
    entry.sat += sat;
    entry.lum += lum;
    colors.set(key, entry);
  }
  const mean = sum / Math.max(1, count);
  // 墨量近似：明显偏离页面均值的像素占比（文字/图形/照片主体）。
  let ink = 0;
  for (let offset = 0; offset < sample.pixels.length; offset += 4) {
    const lum = luminance(sample.pixels[offset]!, sample.pixels[offset + 1]!, sample.pixels[offset + 2]!);
    if (Math.abs(lum - mean) > 38) ink += 1;
  }
  const inkRatio = ink / Math.max(1, count);
  const dark = darkCount / Math.max(1, count) > 0.35 || mean < 100;
  const composition: PageStats["composition"] = dark
    ? saturatedCount / Math.max(1, count) > 0.06 ? "immersive" : "poster"
    : inkRatio > 0.16 ? "editorial" : "swiss";
  return { index, mean, inkRatio, dark, colors, composition };
}

function dominantLight(colors: Map<string, { count: number; r: number; g: number; b: number }>): [number, number, number] {
  let best: [number, number, number] = [250, 250, 248];
  let bestCount = 0;
  for (const entry of colors.values()) {
    const r = entry.r / entry.count;
    const g = entry.g / entry.count;
    const b = entry.b / entry.count;
    if (luminance(r, g, b) < 225) continue;
    if (entry.count > bestCount) {
      best = [r, g, b];
      bestCount = entry.count;
    }
  }
  return best;
}

function dominantBrand(colors: PageStats["colors"], dark: boolean): [number, number, number] {
  let best: [number, number, number] = dark ? [255, 255, 255] : [30, 30, 30];
  let bestScore = 0;
  for (const entry of colors.values()) {
    const r = entry.r / entry.count;
    const g = entry.g / entry.count;
    const b = entry.b / entry.count;
    const lum = luminance(r, g, b);
    const sat = saturation(r, g, b);
    if (sat < 0.28 || lum < 20 || lum > 245) continue;
    const score = sat * Math.sqrt(entry.count);
    if (score > bestScore) {
      best = [r, g, b];
      bestScore = score;
    }
  }
  return best;
}

export async function analyzeReferenceImages(images: Buffer[]): Promise<ReferenceStyle> {
  if (images.length === 0) throw new Error("reference_style_no_pages");
  const stats: PageStats[] = [];
  for (const [index, buffer] of images.entries()) {
    stats.push(analyzePage(await sampleImage(buffer), index));
  }
  const darkCover = stats[0]!.dark;
  // 从全篇统计品牌色更稳：取饱和色出现次数总和加权。
  const allColors = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (const page of stats) {
    for (const [key, entry] of page.colors) {
      const current = allColors.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      current.count += entry.count;
      current.r += entry.r;
      current.g += entry.g;
      current.b += entry.b;
      allColors.set(key, current);
    }
  }
  const lightBackground = dominantLight(allColors);
  const background: [number, number, number] = luminance(...lightBackground) > 180
    ? lightBackground
    : [22, 24, 32];
  const brand = dominantBrand(stats[0]!.colors, darkCover);
  let primary: [number, number, number] = brand;
  let primaryScore = 0;
  let accent: [number, number, number] = primary;
  let accentScore = 0;
  for (const entry of allColors.values()) {
    const r = entry.r / entry.count;
    const g = entry.g / entry.count;
    const b = entry.b / entry.count;
    const lum = luminance(r, g, b);
    const sat = saturation(r, g, b);
    if (sat < 0.28 || lum < 25 || lum > 235) continue;
    const score = sat * Math.sqrt(entry.count);
    if (score > primaryScore) {
      accent = primary;
      accentScore = primaryScore;
      primary = [r, g, b];
      primaryScore = score;
    } else if (score > accentScore) {
      accent = [r, g, b];
      accentScore = score;
    }
  }
  if (accentScore === 0) accent = [Math.min(255, primary[0] + 30), Math.min(255, primary[1] + 30), Math.min(255, primary[2] + 30)];
  const inkAverage = stats.reduce((sum, page) => sum + page.inkRatio, 0) / stats.length;
  const density: ReferenceStyle["density"] = inkAverage > 0.15 ? "dense" : inkAverage > 0.08 ? "standard" : "sparse";
  // 封面可以是深色，但整册内容页是白底高密度：构图按内容页的密度定，darkCover 单独标记。
  const composition: ReferenceStyle["composition"] = density === "dense" ? "editorial" : "swiss";
  const imageTreatment: ReferenceStyle["imageTreatment"] = darkCover
    ? "fullBleed"
    : stats.some((page) => page.inkRatio > 0.12) ? "sideBleed" : "inline";
  const lightPage = luminance(...background) > 180;
  const text: [number, number, number] = lightPage ? [30, 30, 34] : [245, 245, 245];
  const textMuted: [number, number, number] = lightPage ? [110, 110, 116] : [150, 150, 150];
  const chartStops: [number, number, number][] = [
    primary,
    accent,
    [
      Math.round((primary[0] + background[0]) / 2),
      Math.round((primary[1] + background[1]) / 2),
      Math.round((primary[2] + background[2]) / 2),
    ],
  ];
  const chartSeries = chartStops.map(([r, g, b]) => hex(r, g, b));
  return {
    schemaVersion: "reference-style/v1",
    pageCount: stats.length,
    palette: {
      background: hex(...background),
      surface: hex(...background.map((value) => Math.max(0, Math.min(255, value - 10))) as [number, number, number]),
      text: hex(...text),
      textMuted: hex(...textMuted),
      primary: hex(...primary),
      accent: hex(...accent),
      onDarkText: "#F5F5F5",
      chartSeries,
    },
    density,
    darkCover,
    composition,
    imageTreatment,
    tableHeaderColor: hex(...primary),
    pageBudget: stats.length,
    pages: stats.map((page) => ({
      index: page.index,
      luminance: Math.round(page.mean),
      inkRatio: Math.round(page.inkRatio * 1000) / 1000,
      dark: page.dark,
      composition: page.composition,
    })),
    confidence: Math.min(0.95, 0.55 + stats.length * 0.02),
  };
}
