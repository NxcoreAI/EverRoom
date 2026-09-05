import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 导入/导出 artifact 的内容寻址存储：内容放在
 * <dataDir>/document-imports/artifacts/<hash[0:2]>/<hash>，write-once、不可变。
 * 不复用 files 模块的 CAS 目录，避免被其 GC 误回收，也不污染文件目录。
 */
export function artifactHashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function artifactPath(dataDir: string, hash: string): string {
  return join(dataDir, "document-imports", "artifacts", hash.slice(0, 2), hash);
}

export async function storeArtifact(dataDir: string, value: unknown): Promise<string> {
  const buffer = Buffer.from(JSON.stringify(value), "utf8");
  const hash = artifactHashOf(buffer);
  const path = artifactPath(dataDir, hash);
  await mkdir(join(path, ".."), { recursive: true });
  try {
    await writeFile(path, buffer, { flag: "wx" });
  } catch (error) {
    // 已存在视为去重成功；其余错误（权限等）正常抛出。
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return hash;
}

export async function readArtifact(dataDir: string, hash: string): Promise<unknown> {
  const raw = await readFile(artifactPath(dataDir, hash), "utf8");
  return JSON.parse(raw) as unknown;
}
