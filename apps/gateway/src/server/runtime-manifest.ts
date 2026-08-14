import { rmSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  await rename(temporaryPath, path);
}

export async function removeRuntimeManifest(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function removeRuntimeManifestSync(path: string): void {
  rmSync(path, { force: true });
}
