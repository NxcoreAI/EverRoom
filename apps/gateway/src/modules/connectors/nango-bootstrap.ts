import axios, { type AxiosInstance } from "axios";

import type { ConnectorConfig } from "./types.js";

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

async function ensureIntegration(
  dashboard: AxiosInstance,
  providerConfigKey: string,
  provider: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  try {
    const existing = await dashboard.get(`/api/v1/integrations/${encodeURIComponent(providerConfigKey)}`, { params: { env: "dev" }, validateStatus: () => true });
    if (existing.status === 200) return;
    if (existing.status !== 404) {
      console.warn(`[nango-bootstrap] 查询 integration ${providerConfigKey} 失败(HTTP ${existing.status})`);
      return;
    }
    await dashboard.post("/api/v1/integrations", {
      provider,
      integrationId: providerConfigKey,
      useSharedCredentials: false,
      auth: { authType: "OAUTH2", clientId, clientSecret },
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
  if (!(await secretWorks(baseUrl, secret))) {
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
  if (config.googleClientId && config.googleClientSecret) {
    for (const key of [config.gmailConfigKey, config.googleCalendarConfigKey, config.googleDocsConfigKey]) {
      if (key) await ensureIntegration(dashboard, key, key, config.googleClientId, config.googleClientSecret);
    }
  }
  if (config.notionClientId && config.notionClientSecret) {
    await ensureIntegration(dashboard, config.notionConfigKey, "notion", config.notionClientId, config.notionClientSecret);
  }
  // Outlook 走 Microsoft Graph 的 `microsoft` provider(scopes 用 .default,实际权限由 Azure 应用注册决定)。
  if (config.outlookClientId && config.outlookClientSecret) {
    await ensureIntegration(dashboard, config.outlookConfigKey, "microsoft", config.outlookClientId, config.outlookClientSecret);
  }
  return secret;
}
