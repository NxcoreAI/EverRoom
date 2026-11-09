/**
 * 参考 deck PDF 抽取：pdftoppm 渲染 → 像素统计 → reference-style/v1 + 页标题。
 * 只在用户显式给参考路径时调用；失败返回可读错误，不阻塞普通生成。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeReferenceImages, type ReferenceStyle } from "../slides-layout/reference-style.js";

export interface ReferenceDeck {
  style: ReferenceStyle;
  titles: string[];
  pageCount: number;
}

function requireCommand(command: string): void {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    throw new Error(`参考 deck 解析需要 ${command}（poppler）`);
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function sofficeCommand(): string | null {
  const candidates = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function renderPdfPages(pdfPath: string, dir: string, prefix = "page"): string[] {
  requireCommand("pdftoppm");
  execFileSync("pdftoppm", ["-png", "-r", "72", pdfPath, join(dir, prefix)], { stdio: "ignore" });
  return readdirSync(dir).filter((file) => file.startsWith(prefix) && file.endsWith(".png")).sort();
}

function pdfTitles(pdfPath: string, pageCount: number): string[] {
  const titles: string[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    let text = "";
    try {
      text = execFileSync("pdftotext", ["-layout", "-f", String(page), "-l", String(page), pdfPath, "-"], { encoding: "utf8" });
    } catch {
      text = "";
    }
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const title = lines.find((line) => line.length >= 2 && line.length <= 48 && !/^\d+$/.test(line)) ?? `第 ${page} 页`;
    titles.push(title.slice(0, 80));
  }
  return titles;
}

/** 无扩展名路径（工作区上传件是 sha256 hash 路径）按文件头嗅探真实格式。 */
export function sniffExt(path: string): string {
  const head = readFileSync(path).subarray(0, 12);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return ".pdf";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return ".png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head[0] === 0x50 && head[1] === 0x4b) return ".pptx"; // zip 容器：pptx 或改后缀的旧 ppt 都交 soffice
  return "";
}

async function imagesForPath(path: string, dir: string, index: number): Promise<{ images: Buffer[]; titles: string[]; pageCount: number }> {
  const dotIndex = path.lastIndexOf(".");
  let ext = dotIndex === -1 ? "" : path.slice(dotIndex).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) && ext !== ".pdf" && ext !== ".pptx" && ext !== ".ppt") {
    ext = sniffExt(path);
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { images: [readFileSync(path)], titles: [`参考图 ${index + 1}`], pageCount: 1 };
  }
  if (ext === ".pdf") {
    requireCommand("pdftoppm");
    const prefix = `pdf-${index}-`;
    const files = renderPdfPages(path, dir, prefix);
    if (files.length === 0) throw new Error(`参考 PDF 没有可渲染页面：${path}`);
    return {
      images: files.map((file) => readFileSync(join(dir, file))),
      titles: pdfTitles(path, files.length),
      pageCount: files.length,
    };
  }
  if (ext === ".pptx" || ext === ".ppt") {
    const soffice = sofficeCommand();
    if (!soffice) throw new Error("参考 PPTX 需要安装 LibreOffice（soffice）");
    execFileSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, path], { stdio: "ignore" });
    const pdfPath = join(dir, `${path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("."))}.pdf`);
    if (!existsSync(pdfPath)) throw new Error(`参考 PPTX 转 PDF 失败：${path}`);
    const prefix = `ppt-${index}-`;
    const files = renderPdfPages(pdfPath, dir, prefix);
    return {
      images: files.map((file) => readFileSync(join(dir, file))),
      titles: pdfTitles(pdfPath, files.length),
      pageCount: files.length,
    };
  }
  throw new Error(`参考文件格式不支持：${ext || path}（支持 PDF/PPTX/PNG/JPG/WebP）`);
}

/** 兼容旧调用：单 PDF。 */
export async function analyzeReferencePdf(pdfPath: string): Promise<ReferenceDeck> {
  return analyzeReferenceFiles([pdfPath]);
}

/** 任意参考输入：PDF/PPTX/图片可混传，逐页渲染后统一抽取。 */
export async function analyzeReferenceFiles(paths: string[]): Promise<ReferenceDeck> {
  const files = paths.map((path) => path.trim()).filter(Boolean).slice(0, 12);
  if (files.length === 0) throw new Error("没有参考文件");
  for (const path of files) {
    if (!existsSync(path)) throw new Error(`参考文件不存在：${path}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "slides-ref-"));
  try {
    const images: Buffer[] = [];
    const titles: string[] = [];
    for (const [index, path] of files.entries()) {
      const one = await imagesForPath(path, dir, index);
      images.push(...one.images);
      if (one.pageCount > 1) titles.push(...one.titles);
      else if (files.length > 1) titles.push(one.titles[0]!);
    }
    const style = await analyzeReferenceImages(images);
    return { style, titles, pageCount: style.pageCount };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
