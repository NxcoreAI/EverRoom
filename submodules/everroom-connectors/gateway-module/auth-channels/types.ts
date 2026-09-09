/**
 * AuthChannel（connector-platform-refactor-plan 阶段三）：授权通道抽象。
 * SyncProvider 声明自己需要哪种通道（auth.channel），授权流程按通道分发——
 * 授权方式不再与 Nango OAuth 焊死，IMAP 密码流/api-token 等后续按此接口接入。
 *
 * 密钥红线（方案 D6）：凭据密文只存 connectors.sqlite（credentials_ref 列），
 * 明文不进主库、不进 REST 响应、不进日志。
 */
export type AuthChannelKind =
  | "nango-oauth"
  | "api-token"
  | "webcal-url"
  | "password"
  | "manual-import";

export interface AuthChannelStartInput {
  provider: string;
  ownerId: string;
  /** webcal-url：订阅地址；api-token/password：凭据本体（只在此进入，落库前转存）。 */
  secret?: string;
}

export interface AuthChannelStartResult {
  /** OAuth 类：打开授权页；凭据类：无（同步完成）。 */
  authorizationUrl?: string;
  /** 异步授权轮询句柄（OAuth 类）；凭据类直接 connected。 */
  handle?: string;
  status: "pending" | "connected";
}

export interface AuthChannel {
  kind: AuthChannelKind;
  /** 发起/完成授权。凭据类通道在此完成校验并返回 connected。 */
  start(input: AuthChannelStartInput): Promise<AuthChannelStartResult>;
  /** 异步通道轮询（OAuth）；同步通道无此阶段。 */
  poll?(handle: string): Promise<{
    status: "pending" | "connected" | "failed" | "expired";
    error?: string;
  }>;
  /** 连接健康检查。 */
  test?(credentialsRef: string): Promise<boolean>;
}

/** webcal:// → https:// 归一；一律要求 https（引擎直连同样强制），非 https 拒绝。 */
export function normalizeWebcalUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("webcal_url_required");
  const normalized = trimmed.replace(/^webcal:\/\//i, "https://");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("webcal_url_invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("webcal_url_invalid_scheme");
  if (parsed.username || parsed.password) throw new Error("webcal_url_credentials_forbidden");
  return parsed;
}

/** webcal-url 通道：无 OAuth、无轮询——URL 即凭据，start 即 connected。 */
export const webcalUrlAuthChannel: AuthChannel = {
  kind: "webcal-url",
  async start({ secret }) {
    const url = normalizeWebcalUrl(secret ?? "");
    return { status: "connected" };
  },
};

/** api-token 通道：appId:appSecret 即凭据（首个冒号分割），start 即 connected。 */
export const apiTokenAuthChannel: AuthChannel = {
  kind: "api-token",
  async start({ secret }) {
    const value = (secret ?? "").trim();
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1)
      throw new Error("api_token_credentials_invalid");
    return { status: "connected" };
  },
};
