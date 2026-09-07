/**
 * new-api 中转会话（进程内存，不落盘）。桌面主进程用 SaaS 签发的短期令牌
 * （TTL 25min，每 20min 续期）驱动本状态；/ai-relay/* 代理出口与
 * runtime-config 槽位重写共用。token 注册进 secret-redaction，避免日志泄露。
 */

import { registerSecret } from "../../security/secret-redaction.js";

export interface AiRelaySession {
  /** 中转站推理根地址（如 https://ai.example.com，无 /v1 ——路径由请求方拼接）。 */
  baseUrl: string;
  /** new-api 短期令牌。 */
  token: string;
  /** ISO 时间戳。 */
  expiresAt: string;
  /** gateway 自身 origin（如 http://127.0.0.1:49152），槽位重写目标。 */
  proxyOrigin: string;
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
