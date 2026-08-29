import {
  extractImages,
  extractTextItems,
  getDocumentProxy,
  renderPageAsImage,
  type StructuredTextItem,
} from "unpdf";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { storeDocumentAsset } from "./assets.js";
import type {
  CanonicalDocumentAsset,
  CanonicalDocumentBlock,
  CanonicalDocumentPage,
} from "./types.js";

// unpdf 默认把 cMapUrl 解析成 file:// URL，但它在 Node 里两条路径都走不通：
// 内置 serverless 构建用 fetch（不支持 file://），官方 Node 构建又把 file://
// 字符串直接交给 fs.readFile（只认 URL 对象）——结果是 CJK 非嵌入字体解析
// 报 “Ensure that the cMapUrl API parameter is provided” 且文本抽取为空。
// 这里指向本地 pdfjs-dist 静态目录的普通磁盘路径（fs 直读），解析/抽取/渲染共用。
const requirePdfjs = createRequire(import.meta.url);
const pdfjsRoot = dirname(requirePdfjs.resolve("pdfjs-dist/package.json"));
export const PDFJS_STATIC_FILES = {
  cMapUrl: `${join(pdfjsRoot, "cmaps")}/`,
  cMapPacked: true,
  standardFontDataUrl: `${join(pdfjsRoot, "standard_fonts")}/`,
} as const;

export type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** 打开文档并挂上 CJK 字体静态资源；调用方负责 destroy。 */
export async function openPdfDocument(bytes: Uint8Array): Promise<PdfDocument> {
  return getDocumentProxy(bytes, PDFJS_STATIC_FILES);
}

export async function destroyPdfDocument(pdf: PdfDocument): Promise<void> {
  const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy;
  if (destroy) await destroy.call(pdf);
}

interface PositionedTextItem extends StructuredTextItem {
  bbox: [number, number, number, number];
}

export interface NativePdfResult {
  pages: CanonicalDocumentPage[];
  blocks: CanonicalDocumentBlock[];
  markdown: string;
}
const MAX_ASSETS_PER_DOCUMENT = 200;
const MAX_IMAGE_PIXELS = 40_000_000;

function lineBlocks(
  items: StructuredTextItem[],
  pageNo: number,
  pageHeight: number,
  readingOrderStart: number,
): CanonicalDocumentBlock[] {
  const positioned: PositionedTextItem[] = items
    .filter((item) => item.str.trim().length > 0)
    .map((item) => {
      const top = pageHeight - item.y - item.height;
      const bbox: [number, number, number, number] = [
        item.x,
        top,
        item.x + item.width,
        top + item.height,
      ];
      return {
        ...item,
        bbox,
      };
    })
    .sort((left, right) => {
      const [, leftTop, leftRight] = left.bbox;
      const [leftX] = left.bbox;
      const [, rightTop] = right.bbox;
      const [rightX] = right.bbox;
      return leftTop - rightTop || leftX - rightX || leftRight - right.bbox[2];
    });

  const lines: PositionedTextItem[][] = [];
  for (const item of positioned) {
    const line = lines.at(-1);
    const anchor = line?.[0];
    const tolerance = Math.max(2, Math.min(item.height, anchor?.height ?? item.height) * 0.5);
    if (!line || !anchor || Math.abs(item.bbox[1] - anchor.bbox[1]) > tolerance) {
      lines.push([item]);
    } else {
      line.push(item);
    }
  }

  const fontSizes = positioned.map((item) => item.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] ?? 0;
  return lines.map((line, index) => {
    line.sort((left, right) => left.bbox[0] - right.bbox[0]);
    const bbox: [number, number, number, number] = [
      Math.min(...line.map((item) => item.bbox[0])),
      Math.min(...line.map((item) => item.bbox[1])),
      Math.max(...line.map((item) => item.bbox[2])),
      Math.max(...line.map((item) => item.bbox[3])),
    ];
    const fontSize = Math.max(...line.map((item) => item.fontSize));
    const readingOrder = readingOrderStart + index + 1;
    return {
      id: `block-${readingOrder}`,
      type: medianFontSize > 0 && fontSize >= medianFontSize * 1.35 ? "heading" : "paragraph",
      pageNo,
      bbox,
      readingOrder,
      content: line.map((item) => item.str.trim()).join(" ").trim(),
      confidence: 1,
      source: { method: "text-layer", nativeRef: `pdf:page:${pageNo}:line:${index + 1}` },
    };
  });
}

export async function parsePdfNative(buffer: Buffer): Promise<NativePdfResult> {
  const bytes = new Uint8Array(buffer);
  const pdf = await openPdfDocument(bytes);
  try {
    const extracted = await extractTextItems(pdf);
    const pages: CanonicalDocumentPage[] = [];
    const blocks: CanonicalDocumentBlock[] = [];
    const markdownPages: string[] = [];
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      const pageNo = pageIndex + 1;
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const pageBlocks = lineBlocks(extracted.items[pageIndex] ?? [], pageNo, viewport.height, blocks.length);
      blocks.push(...pageBlocks);
      const characterCount = pageBlocks.reduce((total, block) => total + block.content.replace(/\s/g, "").length, 0);
      pages.push({
        pageNo,
        width: viewport.width,
        height: viewport.height,
        imageAssetId: null,
        renderStatus: "not-run",
        textLayerStatus: pageBlocks.length === 0 ? "absent" : characterCount < 16 ? "low-confidence" : "present",
        ocrStatus: pageBlocks.length > 0 && characterCount >= 16 ? "not-needed" : "not-run",
      });
      markdownPages.push(`## 第 ${pageNo} 页${pageBlocks.length > 0
        ? `\n\n${pageBlocks.map((block) => block.content).join("\n\n")}`
        : ""}`);
    }
    return { pages, blocks, markdown: markdownPages.join("\n\n") };
  } finally {
    await destroyPdfDocument(pdf);
  }
}

export async function renderPdfPage(buffer: Buffer, pageNo: number, width = 1_800): Promise<Buffer> {
  // 先用静态资源参数开文档再传 proxy，绕开 renderPageAsImage(bytes) 内部
  // 走 unpdf 默认（坏掉的 file:// cMapUrl）的问题。
  const pdf = await openPdfDocument(new Uint8Array(buffer));
  try {
    const rendered = await renderPageAsImage(pdf, pageNo, {
      width,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    return Buffer.from(rendered);
  } finally {
    await destroyPdfDocument(pdf);
  }
}

export async function storePageAsset(
  dataDir: string,
  buffer: Buffer,
  pageNo: number,
): Promise<CanonicalDocumentAsset> {
  const asset = await storeDocumentAsset(dataDir, buffer, {
    kind: "page-image",
    pageNo,
    mime: "image/png",
    sourceRef: `pdf-page-${pageNo}.png`,
  });
  return { ...asset, id: `asset-page-${pageNo}-${asset.contentHash!.slice(0, 12)}` };
}

function rgbaOf(data: Uint8ClampedArray, channels: 1 | 3 | 4): Uint8ClampedArray {
  if (channels === 4) return data;
  const rgba = new Uint8ClampedArray((data.length / channels) * 4);
  for (let source = 0, target = 0; source < data.length; source += channels, target += 4) {
    const first = data[source] ?? 0;
    rgba[target] = first;
    rgba[target + 1] = channels === 1 ? first : data[source + 1] ?? 0;
    rgba[target + 2] = channels === 1 ? first : data[source + 2] ?? 0;
    rgba[target + 3] = 255;
  }
  return rgba;
}

export async function extractPdfAssets(buffer: Buffer, dataDir: string): Promise<CanonicalDocumentAsset[]> {
  const pdf = await openPdfDocument(new Uint8Array(buffer));
  const assets: CanonicalDocumentAsset[] = [];
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const images = await extractImages(pdf, pageNo);
      for (const [index, image] of images.entries()) {
        if (assets.length >= MAX_ASSETS_PER_DOCUMENT) return assets;
        if (image.width * image.height > MAX_IMAGE_PIXELS) continue;
        const canvas = createCanvas(image.width, image.height);
        canvas.getContext("2d").putImageData(
          new ImageData(rgbaOf(image.data, image.channels), image.width, image.height),
          0,
          0,
        );
        const png = await canvas.encode("png");
        const asset = await storeDocumentAsset(dataDir, png, {
          kind: "embedded-image",
          pageNo,
          mime: "image/png",
          sourceRef: `pdf:page:${pageNo}:image:${image.key || index + 1}.png`,
        });
        assets.push({ ...asset, id: `${asset.id}-page-${pageNo}-${index + 1}` });
      }
    }
    return assets;
  } finally {
    await destroyPdfDocument(pdf);
  }
}
