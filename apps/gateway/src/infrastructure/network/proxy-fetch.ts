import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/**
 * 外网 fetch 统一入口：Node 内置 fetch 不读系统代理——本机外网 TLS 必须走
 * 本地代理（如 127.0.0.1:1271）的环境下，gateway 直连外网端点（LLM 连通
 * 测试、ai-relay 上游、embedding/VLM）会全部表现为 unreachable。桌面侧已
 * 由 http-client.ts 走 Electron net.fetch 解决；gateway 侧外网请求必须走
 * 这里，由 supervisor 在 spawn 时注入 HTTPS_PROXY/NO_PROXY 环境变量。
 *
 * 未配置代理环境变量时与全局 fetch 行为完全一致（直接透传）。
 */

let dispatcher: EnvHttpProxyAgent | null | undefined;

function proxyDispatcher(): EnvHttpProxyAgent | null {
  if (dispatcher !== undefined) return dispatcher;
  const proxyConfigured = Boolean(
    process.env.HTTPS_PROXY
      ?? process.env.https_proxy
      ?? process.env.HTTP_PROXY
      ?? process.env.http_proxy
      ?? process.env.ALL_PROXY
      ?? process.env.all_proxy,
  );
  // EnvHttpProxyAgent 同时识别 HTTP(S)_PROXY 与 NO_PROXY（loopback 桥接由
  // supervisor 注入的 NO_PROXY 排除，不会绕行代理）。
  dispatcher = proxyConfigured ? new EnvHttpProxyAgent() : null;
  return dispatcher;
}

export async function proxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const agent = proxyDispatcher();
  if (!agent) return fetch(input, init);
  return undiciFetch(input, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}
