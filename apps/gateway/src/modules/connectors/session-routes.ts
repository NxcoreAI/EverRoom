import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { GatewayConfig } from "../../config.js";

const SessionBody = Type.Object({
  baseUrl: Type.String({ minLength: 1 }),
  runtimeToken: Type.Optional(Type.String()),
});

export interface ConnectorSessionPayload {
  baseUrl: string;
  runtimeToken?: string;
}

/**
 * 会话热应用：原地 patch config.cliConnector（HTTP client / 授权服务 /
 * SyncEngine 持同一引用、每次调用时读字段，改完即生效，无需重启 gateway）。
 * executor 永远在场，缺席语义 = baseUrl 置空（canServe 静默跳过轮询）。
 */
export function applyCliConnectorSession(
  config: GatewayConfig,
  session: ConnectorSessionPayload | null,
): void {
  const target = config.cliConnector;
  if (!target) return;
  if (!session) {
    target.baseUrl = "";
    delete target.runtimeToken;
    return;
  }
  target.baseUrl = session.baseUrl.trim().replace(/\/+$/, "");
  const runtimeToken = session.runtimeToken?.trim();
  if (runtimeToken) target.runtimeToken = runtimeToken;
  else delete target.runtimeToken;
}

/**
 * 桌面主进程登录/登出后的 oo 会话推送端点（替代旧版「重启 gateway 注入 env」：
 * 登录瞬间 refresh-saas 与重启窗口竞态会把已成功的登录报成失败）。
 * 冷启动路径仍走 env（spawn 时 extraEnvironment 求值），本端点只覆盖运行中变更。
 */
export function connectorSessionRoutes(options: {
  config: GatewayConfig;
  onSessionChanged: () => void;
}): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.put("/v1/connector-session", {
      schema: { tags: ["connectors"], body: SessionBody },
    }, async (request) => {
      const body = request.body;
      const session: ConnectorSessionPayload = {
        baseUrl: body.baseUrl,
        ...(body.runtimeToken ? { runtimeToken: body.runtimeToken } : {}),
      };
      applyCliConnectorSession(options.config, session);
      options.onSessionChanged();
      const applied = options.config.cliConnector;
      return { configured: true, baseUrl: applied?.baseUrl ?? "" };
    });
    app.delete("/v1/connector-session", {
      schema: { tags: ["connectors"] },
    }, async () => {
      applyCliConnectorSession(options.config, null);
      options.onSessionChanged();
      return { configured: false, baseUrl: "" };
    });
  };
}
