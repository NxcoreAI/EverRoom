import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { RuntimeConfigManager } from "../../runtime-config.js";
import { AiRelaySessionStore } from "./session.js";

const SessionBody = Type.Object({
  baseUrl: Type.String({ minLength: 1 }),
  token: Type.String({ minLength: 1 }),
  expiresAt: Type.String({ minLength: 1 }),
  proxyOrigin: Type.String({ minLength: 1 }),
});

function assertHttpUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("not http(s)");
}

/** 返回第一个校验失败的标签；全部通过返回 null。 */
function validateSessionInput(body: { baseUrl: string; expiresAt: string; proxyOrigin: string }): string | null {
  try {
    assertHttpUrl(body.baseUrl);
  } catch {
    return "baseurl";
  }
  if (!Number.isFinite(Date.parse(body.expiresAt))) return "expiresat";
  try {
    assertHttpUrl(body.proxyOrigin);
  } catch {
    return "proxyorigin";
  }
  return null;
}

const HOP_BY_HOP_HEADERS = new Set([
  "host", "connection", "content-length", "authorization", "accept-encoding",
  "transfer-encoding", "keep-alive", "upgrade",
]);

/**
 * new-api 中转链路的 gateway 侧端点：
 * - 会话端点（仅桌面主进程调用）：接收 SaaS 签发的短期令牌，进程内存持有；
 *   变更后 refresh() 重发 runtime config onChange，让槽位重写即时生效。
 * - /ai-relay/* 透明代理：所有 LLM 消费方（agent runtime / VLM / 边车）经
 *   槽位重写指向这里，代理注入当前令牌转发给中转站。401/402 等上游状态码
 *   原样透传，额度耗尽对客户端可见。
 */
export function aiRelayRoutes(options: {
  sessions: AiRelaySessionStore;
  runtimeConfigManager: RuntimeConfigManager;
}): FastifyPluginAsyncTypebox {
  const { sessions, runtimeConfigManager } = options;
  return async (app) => {
    app.put("/v1/ai-relay/session", { schema: { tags: ["ai-relay"], body: SessionBody } }, async (request, reply) => {
      const invalid = validateSessionInput(request.body);
      if (invalid) {
        return reply.code(400).send({
          error: { message: `ai_relay_invalid_${invalid}`, type: "ai_relay_invalid_request", code: "ai_relay_invalid_request" },
        });
      }
      sessions.set({ ...request.body });
      runtimeConfigManager.refresh();
      return { ok: true, active: sessions.active() };
    });

    app.delete("/v1/ai-relay/session", { schema: { tags: ["ai-relay"] } }, async () => {
      sessions.clear();
      runtimeConfigManager.refresh();
      return { ok: true };
    });

    app.all("/ai-relay/*", async (request, reply) => {
      const session = sessions.current();
      if (!session) {
        return reply.code(503).send({
          error: { message: "AI relay session is not active", type: "ai_relay_not_ready", code: "ai_relay_not_ready" },
        });
      }
      const incoming = new URL(request.url, "http://relay.invalid");
      const suffix = `${incoming.pathname.slice("/ai-relay".length) || "/"}${incoming.search}`;
      let target: URL;
      try {
        target = new URL(suffix, session.baseUrl);
      } catch {
        return reply.code(502).send({
          error: { message: "AI relay target URL is invalid", type: "ai_relay_upstream_error", code: "ai_relay_upstream_error" },
        });
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value !== "string" || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      headers.authorization = `Bearer ${session.token}`;
      const method = request.method.toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";
      const controller = new AbortController();
      // 客户端断开时中断上游请求；正常完成后触发是空操作。
      request.raw.on("close", () => {
        if (request.raw.aborted || request.raw.destroyed) controller.abort(new Error("client aborted"));
      });
      try {
        const upstream = await fetch(target, {
          method,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body ?? null) } : {}),
          signal: controller.signal,
        });
        reply.code(upstream.status);
        const contentType = upstream.headers.get("content-type");
        if (contentType) reply.header("content-type", contentType);
        const requestId = upstream.headers.get("x-request-id");
        if (requestId) reply.header("x-request-id", requestId);
        if (!upstream.body) return reply.send(await upstream.text());
        return reply.send(Readable.fromWeb(upstream.body as NodeWebReadableStream));
      } catch (error) {
        if (controller.signal.aborted) return reply;
        request.log.warn({
          event: "ai_relay.forward_failed",
          target: `${target.protocol}//${target.host}`,
          errorMessage: error instanceof Error ? error.message : String(error),
        }, "ai relay forward failed");
        return reply.code(502).send({
          error: {
            message: `AI relay request failed: ${error instanceof Error ? error.message : String(error)}`,
            type: "ai_relay_upstream_error",
            code: "ai_relay_upstream_error",
          },
        });
      }
    });
  };
}
