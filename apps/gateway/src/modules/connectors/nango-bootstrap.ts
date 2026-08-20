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
    // ponytail: /integrations 不认 limit 参数(400),只做鉴权探测,别带查询参数。
    const response = await authedHttp(baseUrl, secret).get("/integrations");
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
  const SECRET_MASK_PREFIX = "****";
  try {
    const list = await axios.get(listUrl, { params: { env: "dev" }, timeout: 10_000 });
    const existing = (list.data?.data ?? []).find((key: { display_name?: string; secret?: string }) => key.display_name === API_KEY_NAME);
    if (existing && typeof existing.secret === "string" && !existing.secret.startsWith(SECRET_MASK_PREFIX)) return existing.secret;
    if (existing) {
      // dev 环境列表接口不掩码 secret;掩码说明实例不是无鉴权模式或环境不对,删除旧 key 重建。
      const keyId = existing.id;
      await axios.delete(`${listUrl}/${String(keyId)}`, { params: { env: "dev" }, timeout: 10_000 }).catch(() => undefined);
      const recreated = await axios.post(listUrl, { display_name: API_KEY_NAME, scopes: ["environment:*"] }, { params: { env: "dev" }, timeout: 10_000 });
      const secret = recreated.data?.data?.secret;
      if (typeof secret === "string" && secret) {
        console.info(`[nango-bootstrap] 已重建被掩码的 Nango API key "${API_KEY_NAME}"`);
        return secret;
      }
      console.warn("[nango-bootstrap] 重建被掩码的 API key 失败");
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

/**
 * 各 provider 创建 integration 时显式声明的 OAuth scopes。
 * ponytail: Google 系 provider 在 Nango providers.yaml 里故意不设 default_scopes(按 scope
 * 划分产品让用户自选),缺省时授权 URL 的 scope 为空,Google 直接 400 invalid_request。
 * scope 集合按 nango-executor 实际调用的 API 裁剪(gmail history/messages、calendar
 * events 读写、drive files list/export)。
 */
const PROVIDER_SCOPES: Record<string, string> = {
  "google-mail": "https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/userinfo.email",
  "google-calendar": "https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/userinfo.email",
  "google-drive": "https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/userinfo.email",
  // microsoft 的 default_scopes(offline_access,.default)由 provider 兜底,无需显式传。
};

export async function ensureIntegration(
  dashboard: AxiosInstance,
  providerConfigKey: string,
  provider: string,
  clientId: string,
  clientSecret: string,
  scopes?: string,
): Promise<void> {
  const effectiveScopes = scopes ?? PROVIDER_SCOPES[provider];
  try {
    const existing = await dashboard.get(`/api/v1/integrations/${encodeURIComponent(providerConfigKey)}`, { params: { env: "dev" }, validateStatus: () => true });
    if (existing.status === 200) {
      if (effectiveScopes && existing.data?.data?.integration?.oauth_scopes !== effectiveScopes) {
        await dashboard.patch(
          `/api/v1/integrations/${encodeURIComponent(providerConfigKey)}`,
          { authType: "OAUTH2", scopes: effectiveScopes },
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
      auth: { authType: "OAUTH2", clientId, clientSecret, ...(effectiveScopes ? { scopes: effectiveScopes } : {}) },
    }, { params: { env: "dev" } });
    console.info(`[nango-bootstrap] 已创建 integration ${providerConfigKey} (provider=${provider}${effectiveScopes ? `, scopes=${effectiveScopes}` : ""})`);
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
    const integrations = [
      [config.gmailConfigKey, "google-mail", "openid,email,profile,https://www.googleapis.com/auth/gmail.readonly"],
      [config.googleCalendarConfigKey, "google-calendar", "openid,email,profile,https://www.googleapis.com/auth/calendar.readonly"],
      [config.googleDocsConfigKey, "google-drive", "openid,email,profile,https://www.googleapis.com/auth/drive.readonly"],
    ] as const;
    for (const [key, provider, scopes] of integrations) {
      if (key) await ensureIntegration(dashboard, key, provider, config.googleClientId, config.googleClientSecret, scopes);
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
