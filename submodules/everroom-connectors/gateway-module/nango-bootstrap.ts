import axios, { type AxiosInstance } from "axios";

import type { ConnectorConfig } from "./types.js";
import { SYNC_PROVIDERS } from "./sync-providers/index.js";

// 桌面端 Nango 托管启动包含首次依赖安装 + server 构建(各 300s 超时),
// Gateway 先于 Nango ready;此窗口需覆盖冷启动全程,取 10 分钟。
const READY_TIMEOUT_MS = 600_000;

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function waitForNango(
  baseUrl: string,
  timeoutMs = READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const response = await axios.get(healthUrl, { timeout: 1_000, validateStatus: () => true });
      if (response.status >= 200 && response.status < 400) return;
    } catch {
      // Nango is an optional background dependency; keep the Gateway startup path clear.
    }
    await delay(500, signal);
  }
  if (signal?.aborted) throw new Error("Nango bootstrap cancelled");
  throw new Error(`Nango did not become ready within ${timeoutMs}ms`);
}

/**
 * 启动时对 Nango 实例做自举:
 * 1. 校验/获取可用的 API key(NXCORE_NANGO_CONNECTOR_SECRET 缺失或失效时,通过无鉴权
 *    dashboard API —— 即 FLAG_AUTH_ENABLED=false 的自托管实例 —— 创建或复用
 *    名为 everroom-gateway 的 key)。
 * 2. 按 .env 提供的 OAuth client 凭据,确保 Google/Notion 的 integration 存在
 *    (已存在则跳过,不更新凭据)。
 *
 * 所有失败仅记日志不抛出,连接器功能按原状降级(授权/同步时自然报错)。
 */
const API_KEY_NAME = "everroom-gateway";

function authedHttp(baseUrl: string, secret: string): AxiosInstance {
  return axios.create({ baseURL: baseUrl.replace(/\/$/, ""), timeout: 15_000, headers: { Authorization: `Bearer ${secret}` } });
}

async function secretWorks(baseUrl: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  try {
    const response = await authedHttp(baseUrl, secret).get("/integrations", { params: { limit: 1 } });
    return response.status < 400;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) return false;
    // 网络错误等不代表 secret 无效,交由上层日志。
    console.warn("[nango-bootstrap] 无法验证 Nango secret:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** 通过无鉴权 dashboard API(自托管 FLAG_AUTH_ENABLED=false)创建/复用 API key。 */
async function bootstrapApiKey(baseUrl: string): Promise<string | null> {
  // ponytail: 固定用 dev 环境(账号 0);需要多环境时再引入 NXCORE_NANGO_CONNECTOR_ENV。
  const listUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/environment/api-keys`;
  try {
    const list = await axios.get(listUrl, { params: { env: "dev" }, timeout: 10_000 });
    const existing = (list.data?.data ?? []).find((key: { display_name?: string; secret?: string }) => key.display_name === API_KEY_NAME);
    if (existing && typeof existing.secret === "string" && !existing.secret.startsWith("****")) return existing.secret;
    if (existing) {
      console.warn("[nango-bootstrap] 现有 API key 的 secret 被掩码,无法复用;请检查环境配置");
      return null;
    }
    const created = await axios.post(listUrl, { display_name: API_KEY_NAME, scopes: ["environment:*"] }, { params: { env: "dev" }, timeout: 10_000 });
    const secret = created.data?.data?.secret;
    if (typeof secret === "string" && secret) {
      console.info(`[nango-bootstrap] 已创建 Nango API key "${API_KEY_NAME}"`);
      return secret;
    }
    return null;
  } catch (error) {
    console.warn("[nango-bootstrap] 创建/复用 Nango API key 失败(外部 Nango 未开无鉴权模式时属预期):", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function ensureIntegration(
  dashboard: AxiosInstance,
  providerConfigKey: string,
  provider: string,
  clientId: string,
  clientSecret: string,
  scopes?: string,
): Promise<void> {
  try {
    const existing = await dashboard.get(`/api/v1/integrations/${encodeURIComponent(providerConfigKey)}`, { params: { env: "dev" }, validateStatus: () => true });
    if (existing.status === 200) {
      if (scopes && existing.data?.data?.integration?.oauth_scopes !== scopes) {
        await dashboard.patch(
          `/api/v1/integrations/${encodeURIComponent(providerConfigKey)}`,
          { authType: "OAUTH2", scopes },
          { params: { env: "dev" } },
        );
        console.info(`[nango-bootstrap] Updated scopes for integration ${providerConfigKey}`);
      }
      return;
    }
    if (existing.status !== 404) {
      console.warn(`[nango-bootstrap] 查询 integration ${providerConfigKey} 失败(HTTP ${existing.status})`);
      return;
    }
    await dashboard.post("/api/v1/integrations", {
      provider,
      integrationId: providerConfigKey,
      useSharedCredentials: false,
      auth: { authType: "OAUTH2", clientId, clientSecret, ...(scopes ? { scopes } : {}) },
    }, { params: { env: "dev" } });
    console.info(`[nango-bootstrap] 已创建 integration ${providerConfigKey} (provider=${provider})`);
  } catch (error) {
    console.warn(`[nango-bootstrap] 创建 integration ${providerConfigKey} 失败:`, error instanceof Error ? error.message : error);
  }
}

/** 返回实际可用的 secret(可能新建了 API key),供后续 executor/授权服务使用。 */
export async function bootstrapNango(config: ConnectorConfig): Promise<string> {
  const baseUrl = config.nangoUrl;
  let secret = config.nangoSecret;
  // A desktop-managed instance starts with a temporary UUID solely to satisfy
  // Gateway config validation. It cannot authenticate against Nango, so skip
  // the probe and go straight to the local dashboard API-key bootstrap.
  const bootstrapPending = process.env.NXCORE_NANGO_BOOTSTRAP_PENDING === "1";
  if (bootstrapPending || !(await secretWorks(baseUrl, secret))) {
    const bootstrapped = await bootstrapApiKey(baseUrl);
    if (bootstrapped) {
      secret = bootstrapped;
      console.info("[nango-bootstrap] 使用自举的 Nango API key 替代配置中的 secret");
    } else if (config.nangoSecret) {
      console.warn("[nango-bootstrap] 配置的 NXCORE_NANGO_CONNECTOR_SECRET 未通过校验且无法自举,授权请求可能失败");
    }
  }

  if (!secret) return config.nangoSecret;

  // 无鉴权 dashboard API(创建 integration 需要);外部带鉴权的 Nango 会 401,仅记录。
  const dashboard = axios.create({ baseURL: baseUrl.replace(/\/$/, ""), timeout: 15_000 });
  // 阶段二：integration 模板由 SyncProvider 注册表驱动（credential 决定用哪组
  // OAuth client；scopes 由 provider 声明，Outlook 走 microsoft .default 不传）。
  for (const definition of SYNC_PROVIDERS) {
    const meta = definition.auth.nango;
    if (!meta) continue;
    if (meta.credential === "none") continue;
    const clientId = config[`${meta.credential}ClientId` as keyof ConnectorConfig] as string | undefined;
    const clientSecret = config[`${meta.credential}ClientSecret` as keyof ConnectorConfig] as string | undefined;
    if (!clientId || !clientSecret) continue;
    const configKey = config.providerConfigKeys?.[definition.provider] ?? meta.configKeyDefault;
    const scopes = meta.oauthScopes?.join(",");
    await ensureIntegration(dashboard, configKey, meta.integrationProvider, clientId, clientSecret, scopes);
  }
  return secret;
}

export async function bootstrapNangoWhenReady(
  config: ConnectorConfig,
  signal?: AbortSignal,
): Promise<string> {
  await waitForNango(config.nangoUrl, READY_TIMEOUT_MS, signal);
  return bootstrapNango(config);
}
