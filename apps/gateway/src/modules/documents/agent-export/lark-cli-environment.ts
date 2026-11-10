/**
 * 网关侧 lark-cli 子进程环境（与桌面主进程 `runtime/lark-cli-runtime.ts` 同策略）。
 *
 * 桌面把内置 lark-cli 路径与**应用私有 HOME** 通过 `NXCORE_LARK_CLI_PATH` /
 * `NXCORE_LARK_CLI_HOME` 注入网关；网关执行导出/导入命令时必须：
 * 1. 只继承白名单环境（身份、语言、代理、证书、终端），剥离 LARK_* / FEISHU_* /
 *    OPENCLAW_* / HERMES_* / NODE_OPTIONS / ELECTRON_* 等外部 Agent 上下文；
 * 2. 把 HOME / USERPROFILE / APPDATA / LOCALAPPDATA 指到应用私有目录，保证读写的
 *    配置与凭据和用户终端里的 lark-cli 完全隔离（内置与自带 CLI 互不干扰）；
 * 3. 统一 `NO_COLOR=1`，避免 ANSI 颜色污染 JSON 输出契约。
 *
 * 未配置私有 HOME 时（独立网关/单测）保持历史行为：继承父进程环境 + NO_COLOR，
 * 避免改变既有部署的语义。
 */

import { delimiter } from "node:path";

const INHERITED_ENVIRONMENT_KEYS = [
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const WINDOWS_INHERITED_ENVIRONMENT_KEYS = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
] as const;

export interface LarkCliEnvironmentOptions {
  /** 桌面注入的应用私有 HOME；空串/undefined 时回退历史全量继承。 */
  homeDirectory?: string | null;
  platform?: NodeJS.Platform;
}

/** 构造 lark-cli 子进程环境（白名单继承 + 私有 HOME 隔离）。 */
export function larkCliSpawnEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  options: LarkCliEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const homeDirectory = options.homeDirectory?.trim();
  if (!homeDirectory) return { ...baseEnvironment, NO_COLOR: "1" };
  const platform = options.platform ?? process.platform;
  const keys: readonly string[] = platform === "win32"
    ? [...INHERITED_ENVIRONMENT_KEYS, ...WINDOWS_INHERITED_ENVIRONMENT_KEYS]
    : INHERITED_ENVIRONMENT_KEYS;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  const pathValue = baseEnvironment.PATH ?? baseEnvironment.Path;
  if (typeof pathValue === "string" && pathValue.length > 0) {
    const entries = pathValue
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) environment.PATH = [...new Set(entries)].join(delimiter);
  }
  environment.HOME = homeDirectory;
  environment.USERPROFILE = homeDirectory;
  environment.APPDATA = `${homeDirectory}/AppData/Roaming`;
  environment.LOCALAPPDATA = `${homeDirectory}/AppData/Local`;
  environment.NO_COLOR = "1";
  if (baseEnvironment.LARK_CLI_NO_PROXY === "1") environment.LARK_CLI_NO_PROXY = "1";
  return environment;
}
