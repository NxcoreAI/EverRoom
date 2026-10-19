/**
 * 审页截图压缩：渲染层出的 1x PNG 无损图在背景图页可达 1.5MB+，
 * base64 后直投多模态会撞中转请求体上限（413）。
 * 经 sips（macOS 自带）转 JPEG 有损压缩，1.5MB 级页面预计压到 100~250KB。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SIPS_TIMEOUT_MS = 15_000;

/** PNG base64 → JPEG base64（quality 1~100）。失败抛错，由调用方决定是否回退原图。 */
export async function pngBase64ToJpegBase64(pngBase64: string, quality = 82): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slide-shot-"));
  try {
    const pngPath = join(dir, "page.png");
    const jpgPath = join(dir, "page.jpg");
    await writeFile(pngPath, Buffer.from(pngBase64, "base64"));
    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), pngPath, "--out", jpgPath], {
      timeout: SIPS_TIMEOUT_MS,
    });
    return (await readFile(jpgPath)).toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
