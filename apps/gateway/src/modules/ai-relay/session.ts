/**
 * new-api 中转会话（进程内存，不落盘）。桌面主进程用 SaaS 签发的短期令牌
 * （TTL 25min，每 20min 续期）驱动本状态；/ai-relay/* 代理出口与
 * runtime-config 槽位重写共用。token 注册进 secret-redaction，避免日志泄露。
 */

import { registerSecret } from "../../security/secret-redaction.js";
import type { RelayModels } from "../../runtime-config.js";

export interface AiRelaySession {
  /** 中转站推理根地址（如 https://ai.example.com，无 /v1 ——路径由请求方拼接）。 */
  baseUrl: string;
  /** new-api 短期令牌。 */
  token: string;
  /** ISO 时间戳。 */
  expiresAt: string;
  /** gateway 自身 origin（如 http://127.0.0.1:49152），槽位重写目标。 */
  proxyOrigin: string;
  /** SaaS 套餐场景模型；未下发为 null（各槽位模型沿用本地内置值）。 */
  models?: RelayModels | null;
}

export class AiRelaySessionStore {
  private session: AiRelaySession | null = null;

  set(session: AiRelaySession): void {
    registerSecret(session.token);
    this.session = session;
  }
  clear(): void {
    this.session = null;
  }

  /** 过期视为不存在（桌面端续期是唯一延续方式）。 */
  current(): AiRelaySession | null {
    if (!this.session) return null;
    const expiresAt = Date.parse(this.session.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return this.session;
  }

  active(): boolean {
    return this.current() !== null;
  }
}

/** 会话 baseUrl → 槽位重写目标的 API 前缀：根部署 /v1；已带 /v1 结尾不重复；
 *  子路径部署 /<sub>/v1。非法 baseUrl 按根处理。create-server 的 relayOverride
 *  与会话续期短路共用同一推导，两边不得各自实现。 */
export function relayPathPrefix(baseUrl: string): string {
  let base = "";
  try {
    base = new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    // 非法 baseUrl 按根处理
  }
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

/**
 * 槽位重写相关特征：只有这些字段变化才需要重发 runtime config（refresh →
 * agent 运行时热重载）。token/expiresAt 不在其中——短期令牌由 /ai-relay 代理
 * 转发时逐请求注入，不进槽位配置；每 20min 续期换 token 据此跳过 refresh，
 * 避免热重载 abort 进行中的 agent run（如 PPT 编排/落页）。
 */
export function relaySlotSignature(session: AiRelaySession): string {
  return JSON.stringify({
    pathPrefix: relayPathPrefix(session.baseUrl),
    proxyOrigin: session.proxyOrigin,
    models: session.models ?? null,
  });
}
