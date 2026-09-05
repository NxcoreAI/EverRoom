import { spawn } from "node:child_process";

/**
 * 网关侧 ntn（Notion 官方 CLI）执行器。与 lark-cli 不同：ntn 不是
 * {ok:true} 契约——成功输出 JSON（--json）或文本，失败走 stderr + 非零退出。
 * 大正文（markdown）经 `ntn api -d @-` 走 stdin，不进 argv。
 */
export interface NtnCliConfig {
  executable: string;
}

export class NtnCliError extends Error {
  readonly kind: "environment" | "auth_required" | "timeout" | "cli";
  readonly detail: string;

  constructor(kind: NtnCliError["kind"], detail: string) {
    super(`[ntn:${kind}] ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface NtnRunResult {
  data: unknown;
  raw: Record<string, unknown>;
}

export function runNtnCli(
  config: NtnCliConfig,
  arguments_: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<NtnRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, arguments_, {
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const finish = (error?: Error, data?: unknown, raw?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ data: data ?? null, raw: raw ?? {} });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new NtnCliError("timeout", `ntn 命令超时：${arguments_.slice(0, 3).join(" ")}`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin, "utf8");
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        child.kill("SIGTERM");
        finish(new NtnCliError("cli", "ntn 输出超过上限"));
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish(new NtnCliError("environment", `无法启动 ntn（${String(error.message)}）`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        const trimmed = stdout.trim();
        if (!trimmed) {
          finish(undefined, null, {});
        } else {
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            finish(undefined, parsed, parsed);
          } catch {
            finish(undefined, stdout, {});
          }
        }
        return;
      }
      const combined = `${stdout}\n${stderr}`;
      if (/ntn login first|No workspace selected|not logged in|unauthorized|HTTP 401/i.test(combined)) {
        finish(new NtnCliError("auth_required", combined.trim().split("\n")[0] ?? "ntn 未登录"));
        return;
      }
      finish(new NtnCliError("cli", stderr.trim().split("\n")[0] || `ntn 退出码 ${String(code)}`));
    });
  });
}

export async function ntnCliVersion(config: NtnCliConfig): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(config.executable, ["--version"], {
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk })
    child.once("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? stdout.trim() || "ok" : null)
    })
  })
}

export interface NtnAuthStatus {
  authenticated: boolean
  userName: string | null
}

/** `ntn whoami --json`：未登录时按 auth_required 处理。 */
export async function ntnWhoami(config: NtnCliConfig): Promise<NtnAuthStatus> {
  const { raw } = await runNtnCli(config, ["whoami", "--json"], { timeoutMs: 20_000 })
  const user = raw.user && typeof raw.user === "object" ? raw.user as Record<string, unknown> : {}
  const name = raw.name ?? user.name
  return { authenticated: true, userName: typeof name === "string" ? name : null }
}
