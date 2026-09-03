import { spawn } from "node:child_process";

/**
 * 网关侧 lark-cli 执行器（飞书导出通道）。遵循 CLI 的 JSON 输出契约：
 * 成功 {ok:true, identity, data, meta} 走 stdout + exit 0；失败
 * {ok:false, error:{type, code, message, hint}} 走 stderr + 非零 exit。
 * 正文经 stdin 传递（--content -），不进 argv；不采集任何 token/secret。
 */
export interface LarkCliConfig {
  executable: string;
}

export class LarkCliError extends Error {
  readonly kind: "environment" | "app_setup_required" | "auth_required" | "scope_missing" | "timeout" | "cli";
  readonly detail: string;

  constructor(kind: LarkCliError["kind"], detail: string) {
    super(`[lark:${kind}] ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface LarkRunResult {
  data: unknown;
  raw: Record<string, unknown>;
}

export function runLarkCli(
  config: LarkCliConfig,
  arguments_: string[],
  options: { stdin?: string; timeoutMs?: number; plainJson?: boolean } = {},
): Promise<LarkRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, [...arguments_, "--json"], {
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let stdinError = false;

    const finish = (error?: Error, data?: unknown, raw?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ data: data ?? null, raw: raw ?? {} });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new LarkCliError("timeout", `lark-cli 命令超时：${arguments_.slice(0, 3).join(" ")}`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        stdinError = true;
      });
      child.stdin.end(options.stdin, "utf8");
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        child.kill("SIGTERM");
        finish(new LarkCliError("cli", "lark-cli 输出超过上限"));
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (stdinError) return;
      finish(new LarkCliError("environment", `无法启动 lark-cli（${String(error.message)}）`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout.trim() || "null") as Record<string, unknown>;
          if (parsed.ok === true) finish(undefined, parsed.data ?? parsed, parsed);
          // auth status 等命令输出裸 JSON（无 ok 外壳），按 plainJson 放行。
          else if (options.plainJson && parsed && typeof parsed === "object") {
            finish(undefined, parsed, parsed);
          }
          else finish(larkErrorFromEnvelope(parsed) ?? new LarkCliError("cli", "lark-cli 返回未知结构"));
        } catch {
          finish(new LarkCliError("cli", "lark-cli stdout 不是有效 JSON"));
        }
        return;
      }
      // 失败契约：stderr 上的 {ok:false,error:{...}}
      try {
        const parsed = JSON.parse(stderr.trim() || "null") as Record<string, unknown>;
        const mapped = larkErrorFromEnvelope(parsed);
        if (mapped) {
          finish(mapped);
          return;
        }
      } catch {
        // 落到普通错误
      }
      finish(new LarkCliError("cli", stderr.trim().split("\n")[0] || `lark-cli 退出码 ${String(code)}`));
    });
  });
}

function larkErrorFromEnvelope(parsed: Record<string, unknown>): LarkCliError | null {
  const error = parsed && typeof parsed.error === "object"
    ? (parsed.error as Record<string, unknown>)
    : null;
  if (!error) return null;
  const type = typeof error.type === "string" ? error.type : "";
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  if (/auth|token|login|unauthori[sz]ed/i.test(type) || /not.*login|token.*expired|no.*credential/i.test(message)) {
    return new LarkCliError("auth_required", message);
  }
  if (/scope|permission/i.test(type)) {
    return new LarkCliError("scope_missing", message);
  }
  if (/config|app/i.test(type) && /no app|not.*config/i.test(message)) {
    return new LarkCliError("app_setup_required", message);
  }
  return new LarkCliError("cli", message);
}

export interface LarkAuthStatus {
  appConfigured: boolean;
  userAvailable: boolean;
  tokenStatus: string | null;
  scope: string | null;
  userName: string | null;
  expiresAt: string | null;
}

/** `lark-cli auth status --json` 的防御性解析；失败按环境错误处理。 */
export async function larkAuthStatus(config: LarkCliConfig): Promise<LarkAuthStatus> {
  const { raw } = await runLarkCli(config, ["auth", "status"], { timeoutMs: 15_000, plainJson: true });
  const appId = typeof raw.appId === "string" && raw.appId.trim() ? raw.appId.trim() : null;
  const identities = raw.identities && typeof raw.identities === "object"
    ? (raw.identities as Record<string, unknown>)
    : {};
  const user = identities.user && typeof identities.user === "object"
    ? (identities.user as Record<string, unknown>)
    : {};
  return {
    appConfigured: appId !== null,
    userAvailable: user.available === true,
    tokenStatus: typeof user.tokenStatus === "string" ? user.tokenStatus : null,
    scope: typeof user.scope === "string" ? user.scope : null,
    userName: typeof user.userName === "string" ? user.userName : null,
    expiresAt: typeof user.expiresAt === "string" ? user.expiresAt : null,
  };
}

export async function larkCliVersion(config: LarkCliConfig): Promise<string | null> {
  // --version 不走 JSON 契约，直接探测可执行文件存在。
  return new Promise((resolve) => {
    const child = spawn(config.executable, ["--version"], {
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "ok" : null);
    });
  });
}
