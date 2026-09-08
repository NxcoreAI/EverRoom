import { rmSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RuntimeManifest {
  pid: number;
  baseUrl: string;
  token: string;
  startedAt: string;
  version: string;
}

export async function writeRuntimeManifest(path: string, manifest: RuntimeManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, path);
  } catch {
    // Windows 上杀软/同步过滤驱动可能对刚写入的文件短暂加锁，同目录 rename
    // 报 EXDEV/EPERM——supervisor 等着读 manifest，绝不能在这里把网关拖崩。
    // 降级 copy+delete：copy 不需要源文件独占删除权限，成功率高得多。
    await copyFile(temporaryPath, path);
    await rm(temporaryPath, { force: true });
  }
}

export async function removeRuntimeManifest(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function removeRuntimeManifestSync(path: string): void {
  rmSync(path, { force: true });
}
