/**
 * 演示页渲染：PageSpec → pptx（经注入的渲染器）→ PNG（soffice 转 pdf
 * + sips 转图）。渲染器接口由编排层注入（真机=桌面 office-bridge，
 * 测试=内存实现），本模块只负责格式转换与临时目录管理。
 *
 * 渲染纪律（实测教训）：soffice 转换一律用默认 profile（隔离 profile
 * 丢 CJK 字体配置）；pdf→图用 macOS sips（Quartz 渲染，中文完美），
 * 不用 pdftoppm（LO 内嵌 CFF 子集画成豆腐块）。
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DemoPageSpec } from "./demo-page.js";

const execFileAsync = promisify(execFile);
const SOFFICE_TIMEOUT_MS = 90_000;

/** 注入的 pptx 渲染器：真机实现走桌面 /v1/office-generate。 */
export interface DemoPptxRenderer {
  renderPptx(title: string, pages: DemoPageSpec[]): Promise<Buffer>;
}

function sofficeCandidates(): string[] {
  return [
    ...(process.env.EVERROOM_SOFFICE_PATH ? [process.env.EVERROOM_SOFFICE_PATH] : []),
    "soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
  ];
}

async function runFirstCandidate(
  candidates: string[],
  args: string[],
  label: string,
): Promise<void> {
  const errors: string[] = [];
  for (const executable of [...new Set(candidates)]) {
    try {
      await execFileAsync(executable, args, { timeout: SOFFICE_TIMEOUT_MS });
      return;
    } catch (error) {
      errors.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label} 失败：${errors.join("；")}`);
}

/** pptx 字节 → 首页 PNG 字节。 */
export async function pptxToPng(pptx: Buffer): Promise<Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "slides-style-demo-"));
  try {
    const pptxPath = join(directory, "demo.pptx");
    writeFileSync(pptxPath, pptx);
    await runFirstCandidate(
      sofficeCandidates(),
      ["--headless", "--convert-to", "pdf", "--outdir", directory, pptxPath],
      "soffice 转 pdf",
    );
    // sips 只出首页——演示页恰好单页。
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", join(directory, "demo.pdf"), "--out", join(directory, "demo.png")], { timeout: 30_000 });
    return readFileSync(join(directory, "demo.png"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 风格参数 → 演示页 PNG。 */
export async function renderDemoPage(
  pages: DemoPageSpec[],
  renderer: DemoPptxRenderer,
): Promise<Buffer> {
  const pptx = await renderer.renderPptx("风格演示页", pages);
  return pptxToPng(pptx);
}
