import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadEnvironment(): void {
  const explicitPath = process.env.NXCORE_ENV_FILE?.trim();
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const gatewayDirectory = resolve(moduleDirectory, "..");
  const repositoryDirectory = resolve(gatewayDirectory, "..", "..");
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        resolve(".env"),
        resolve(repositoryDirectory, ".env"),
        resolve(gatewayDirectory, ".env"),
      ];

  for (const path of new Set(candidates)) {
    if (existsSync(path)) loadEnvFile(path);
  }
}
