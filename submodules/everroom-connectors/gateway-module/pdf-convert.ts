/**
 * pdfjs 装载缝（submodule 自包含化：converters.ts 不再借用宿主
 * document-understanding/pdf.ts 的 open/destroy）。
 *
 * CJK 处理逻辑与宿主 pdf.ts 同源（unpdf 默认 cMapUrl 在 Node 下两条路径都
 * 走不通）。宿主 pdf.ts 反向从这里 import 并 re-export（单一事实来源），
 * 宿主的 parsePdfNative/renderPdfPage/extractPdfAssets 继续留在宿主。
 */

import { getDocumentProxy } from "unpdf";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
