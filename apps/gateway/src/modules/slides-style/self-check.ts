/**
 * 渲染自校闭环：渲一页 → 用同一套尺子量渲染页、对参数基准 → 修参 →
 * 再渲（封顶两轮，每轮总偏差必须小于上一轮）。
 *
 * 尺子四层（只拦翻车级，阈值宁松勿紧）：
 * - 底色：边缘采样均值 vs palette.background（LibreOffice 色彩管理有
 *   漂移，容忍每通道 ~28 的均值差；超限且更接近 surface 时交换两个色）；
 * - 墨量覆盖：非底色像素占比须在 4%~75%（0%=整页空白、>75%=糊死）；
 * - 文字带：行投影至少 3 条独立墨带（标题/正文/卡片文各一）；
 * - 强调色在场：接近 accent 的像素 ≥ 0.05%（KPI/色条真的画出来了）。
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { StyleParams } from "./types.js";
import { buildDemoPageSpec, type DemoPageSpec } from "./demo-page.js";
import { renderDemoPage, type DemoPptxRenderer } from "./render.js";
import { hexToRgb } from "./extract.js";

export interface SelfCheckDeviation {
  layer: "background" | "inkCoverage" | "textBands" | "accentPresence";
  detail: string;
  /** 0（达标）~1（翻车），总分=sum。 */
  severity: number;
}

export interface SelfCheckReport {
  deviations: SelfCheckDeviation[];
  score: number;
  passed: boolean;
  measurements: {
    backgroundHex: string;
    inkCoverage: number;
    textBands: number;
    accentRatio: number;
  };
}

const BG_TOLERANCE_PER_CHANNEL = 28;
const MIN_INK_COVERAGE = 0.04;
const MAX_INK_COVERAGE = 0.75;
const MIN_TEXT_BANDS = 3;
const MIN_ACCENT_RATIO = 0.0005;

/** 色距：逐通道差的均值（0~255 刻度）。 */
function channelDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
}

async function measure(png: Buffer, params: StyleParams): Promise<SelfCheckReport["measurements"]> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;
  const pixel = (x: number, y: number) => ({
    r: data[(y * width + x) * 4]!,
    g: data[(y * width + x) * 4 + 1]!,
    b: data[(y * width + x) * 4 + 2]!,
  });

  // 底色：四角 + 四边中点共 8 个采样点的均值。
  const samples = [
    [4, 4], [width - 5, 4], [4, height - 5], [width - 5, height - 5],
    [Math.floor(width / 2), 4], [Math.floor(width / 2), height - 5],
    [4, Math.floor(height / 2)], [width - 5, Math.floor(height / 2)],
  ].map(([x, y]) => pixel(x!, y!));
  const background = samples.reduce((acc, sample) => ({
    r: acc.r + sample.r / samples.length,
    g: acc.g + sample.g / samples.length,
    b: acc.b + sample.b / samples.length,
  }), { r: 0, g: 0, b: 0 });

  const backgroundTarget = hexToRgb(params.palette.background);
  const accentTarget = hexToRgb(params.palette.accent);
  const accentDistanceTolerance = 40;

  let inkPixels = 0;
  let accentPixels = 0;
  // 行投影墨量（每行非底色像素数）。
  const rowInk = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = pixel(x, y);
      const isBackground = channelDistance(current, backgroundTarget) <= BG_TOLERANCE_PER_CHANNEL;
      if (!isBackground) {
        inkPixels += 1;
        rowInk[y] = rowInk[y]! + 1;
      }
      if (channelDistance(current, accentTarget) <= accentDistanceTolerance) accentPixels += 1;
    }
  }
  const total = width * height;

  // 文字带：行墨量超过行宽 2% 的连续行段。
  let bands = 0;
  let inBand = false;
  for (let y = 0; y < height; y += 1) {
    const hasInk = rowInk[y]! > width * 0.02;
    if (hasInk && !inBand) {
      bands += 1;
      inBand = true;
    } else if (!hasInk) {
      inBand = false;
    }
  }

  return {
    backgroundHex: `#${[background.r, background.g, background.b]
      .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
      .join("")}`,
    inkCoverage: inkPixels / total,
    textBands: bands,
    accentRatio: accentPixels / total,
  };
}

export async function checkDemoPage(png: Buffer, params: StyleParams): Promise<SelfCheckReport> {
  const measurements = await measure(png, params);
  const deviations: SelfCheckDeviation[] = [];

  const backgroundTarget = hexToRgb(params.palette.background);
  const backgroundMeasured = hexToRgb(measurements.backgroundHex);
  const backgroundDistance = channelDistance(backgroundMeasured, backgroundTarget);
  if (backgroundDistance > BG_TOLERANCE_PER_CHANNEL) {
    deviations.push({
      layer: "background",
      detail: `底色偏差 ${backgroundDistance.toFixed(1)}/255（目标 ${params.palette.background}，实测 ${measurements.backgroundHex}）`,
      severity: Math.min(1, backgroundDistance / 120),
    });
  }
  if (measurements.inkCoverage < MIN_INK_COVERAGE || measurements.inkCoverage > MAX_INK_COVERAGE) {
    deviations.push({
      layer: "inkCoverage",
      detail: `墨量覆盖 ${(measurements.inkCoverage * 100).toFixed(1)}%（允许 4%~75%）`,
      severity: measurements.inkCoverage < MIN_INK_COVERAGE
        ? Math.min(1, (MIN_INK_COVERAGE - measurements.inkCoverage) / MIN_INK_COVERAGE)
        : Math.min(1, (measurements.inkCoverage - MAX_INK_COVERAGE) / MAX_INK_COVERAGE),
    });
  }
  if (measurements.textBands < MIN_TEXT_BANDS) {
    deviations.push({
      layer: "textBands",
      detail: `文字带 ${String(measurements.textBands)} 条（至少 ${String(MIN_TEXT_BANDS)}）`,
      severity: Math.min(1, (MIN_TEXT_BANDS - measurements.textBands) / MIN_TEXT_BANDS),
    });
  }
  if (measurements.accentRatio < MIN_ACCENT_RATIO) {
    deviations.push({
      layer: "accentPresence",
      detail: `强调色占比 ${(measurements.accentRatio * 100).toFixed(3)}%（低于 ${(MIN_ACCENT_RATIO * 100).toFixed(2)}%）`,
      severity: Math.min(1, (MIN_ACCENT_RATIO - measurements.accentRatio) / MIN_ACCENT_RATIO),
    });
  }

  const score = deviations.reduce((sum, deviation) => sum + deviation.severity, 0);
  return { deviations, score, passed: deviations.length === 0, measurements };
}

/** 唯一的自动修参规则：渲染底色明显不是 background 而更像 surface → 交换。 */
function maybeSwapBackgroundSurface(params: StyleParams, report: SelfCheckReport): StyleParams | null {
  const backgroundDeviation = report.deviations.find((deviation) => deviation.layer === "background");
  if (!backgroundDeviation) return null;
  const measured = hexToRgb(report.measurements.backgroundHex);
  const surface = hexToRgb(params.palette.surface);
  const background = hexToRgb(params.palette.background);
  const closerToSurface = channelDistance(measured, surface) + 8 < channelDistance(measured, background);
  if (!closerToSurface) return null;
  return {
    ...params,
    palette: { ...params.palette, background: params.palette.surface, surface: params.palette.background },
  };
}

export interface SelfCheckOutcome {
  params: StyleParams;
  report: SelfCheckReport;
  rounds: number;
  /** 修参后仍未收敛的残留偏差（可为空）。 */
  residual: SelfCheckDeviation[];
  /** 自校收敛后的演示页 PNG（最后一轮渲染结果）。 */
  demoPng: Buffer;
}

/** 闭环主流程：渲一页→量→修参→再渲，封顶两轮、每轮总分必须下降。 */
export async function runSelfCheck(
  initial: StyleParams,
  renderer: DemoPptxRenderer,
  options: { renderPng?: (pages: DemoPageSpec[], renderer: DemoPptxRenderer) => Promise<Buffer> } = {},
): Promise<SelfCheckOutcome> {
  const renderPng = options.renderPng ?? ((pages, dep) => renderDemoPage(pages, dep));
  let params = initial;
  let png = await renderPng([buildDemoPageSpec(params)], renderer);
  let report = await checkDemoPage(png, params);
  let rounds = 1;

  while (!report.passed && rounds < 2) {
    const fixed = maybeSwapBackgroundSurface(params, report);
    if (!fixed) break;
    const nextPng = await renderPng([buildDemoPageSpec(fixed)], renderer);
    const nextReport = await checkDemoPage(nextPng, fixed);
    rounds += 1;
    // 每轮必须下降，否则回退到上一轮结果停机（防震荡）。
    if (nextReport.score >= report.score) break;
    params = fixed;
    png = nextPng;
    report = nextReport;
  }

  return {
    params,
    report,
    rounds,
    residual: report.deviations,
    demoPng: png,
  };
}
