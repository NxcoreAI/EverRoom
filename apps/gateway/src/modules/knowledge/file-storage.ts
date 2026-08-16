/**
 * 上传文件的对象库与确定性身份（room-wiki 方案 §资料模型修订，B 案）。
 *
 * 身份：file-<规范化文件名 sha256 前 12 位>。同名重传 = 同 ID（版本更新，
 * ②a 链接层回原 Room + KS 同名覆盖）；改名 = 新文件（符合直觉）。
 * 字节：内容寻址对象库 files/sha256/<前2字符>/<hash>（与 evidence 的
 * objects/sha256 同款约定），同内容天然只存一份。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 当前 md 解析器版本：升级版本号 = 唯一合法的重解析场景（判重闸 2）。 */
export const MARKDOWN_PARSER_VERSION = "md-v1";

/** 规范化文件名：basename + NFC + 去首尾空白/点 + 折叠连续空白 + 小写。 */
export function normalizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  return basename
    .normalize("NFC")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** 确定性文件 ID：规范化文件名的 sha256 前 12 位。 */
export function fileIdOf(filename: string): string {
  return `file-${createHash("sha256").update(normalizeFilename(filename), "utf8").digest("hex").slice(0, 12)}`;
}

/** 内容指纹（判重闸 1 的内容键）：原始字节的 sha256。 */
export function contentHashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 对象库相对路径（相对 gateway dataDir）。 */
export function storageRelPath(contentHash: string): string {
  return join("files", "sha256", contentHash.slice(0, 2), contentHash);
}

/** 写入对象库（已存在则跳过——内容寻址，同 hash 必同字节）；返回绝对路径。 */
export async function storeFileBlob(dataDir: string, contentHash: string, buffer: Buffer): Promise<string> {
  const absolute = join(dataDir, storageRelPath(contentHash));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    // 已存在：内容寻址下同 hash 即同字节，跳过即可
    if (error.code !== "EEXIST") throw error;
  });
  return absolute;
}
