/**
 * 正文配图确定性质检：生成图落页前先看「是不是一张能用的图」。
 *
 * 只拦翻车级（空白/纯色/过暗/过曝/分辨率过低），不做主体相关性——
 * 主体是否切题需要多模态判断，留给后续 VLM 环节。这里用像素统计，零额外模型调用。
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";

export interface SlideImageQcResult {
  ok: boolean;
  width: number;
  height: number;
  /** 亮度标准差（0~255）：接近 0 说明纯色/空白。 */
  luminanceStd: number;
  /** 4bit 量化后的不同颜色数。 */
  uniqueColors: number;
  reason?: string;
}

const SAMPLE_WIDTH = 96;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 360;
const MIN_STD = 8;
const MIN_UNIQUE_COLORS = 6;
const MIN_MEAN = 8;
const MAX_MEAN = 247;

export async function inspectSlideImage(bytes: Uint8Array): Promise<SlideImageQcResult> {
  const image = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const width = image.width || 0;
  const height = image.height || 0;
  const base: SlideImageQcResult = {
    ok: false,
    width,
    height,
    luminanceStd: 0,
    uniqueColors: 0,
  };
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { ...base, reason: `分辨率过低（${width}×${height}）` };
  }
  const scale = Math.min(1, SAMPLE_WIDTH / Math.max(1, width));
  const sampleW = Math.max(1, Math.round(width * scale));
  const sampleH = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(sampleW, sampleH);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, sampleW, sampleH);
  const data = context.getImageData(0, 0, sampleW, sampleH).data;
  let sum = 0;
  let sumSq = 0;
  const colors = new Set<number>();
  const count = sampleW * sampleH;
  for (let offset = 0; offset < data.length; offset += 4) {
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luminance;
    sumSq += luminance * luminance;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / Math.max(1, count);
  const variance = Math.max(0, sumSq / Math.max(1, count) - mean * mean);
  const std = Math.sqrt(variance);
  const result: SlideImageQcResult = {
    ok: true,
    width,
    height,
    luminanceStd: Math.round(std * 10) / 10,
    uniqueColors: colors.size,
  };
  if (mean < MIN_MEAN) return { ...result, ok: false, reason: "画面接近全黑" };
  if (mean > MAX_MEAN) return { ...result, ok: false, reason: "画面接近全白/过曝" };
  if (std < MIN_STD) return { ...result, ok: false, reason: "画面接近纯色/空白" };
  if (colors.size < MIN_UNIQUE_COLORS) return { ...result, ok: false, reason: "颜色过少，疑似占位图" };
  return result;
}
