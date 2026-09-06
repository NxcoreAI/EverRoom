import type { SyncProviderDefinition } from "./types.js";
import { gmailSyncProvider } from "./gmail.js";
import { outlookSyncProvider } from "./outlook.js";
import { googleCalendarSyncProvider } from "./google-calendar.js";
import { googleDocsSyncProvider } from "./google-docs.js";
import { notionSyncProvider } from "./notion.js";
import { icsCalendarSyncProvider } from "./ics-calendar.js";
import { feishuWikiSyncProvider } from "./feishu-wiki.js";

/**
 * SyncProvider 注册表（connector-platform-refactor-plan 阶段二）。
 * 新增数据源 = 一个 provider 文件 + 此处一行；executor / config / bootstrap /
 * 装配 / 元数据端点全部由注册表驱动，不再出现 provider 字面量分发。
 *
 * 启动自检（assertSyncProvidersValid）补偿 union 放宽后丢失的编译期穷尽性：
 * 注册不完整即 fail-fast，而非运行期静默 unknown provider。
 */
export const SYNC_PROVIDERS: readonly SyncProviderDefinition[] = [
  gmailSyncProvider,
  outlookSyncProvider,
  googleCalendarSyncProvider,
  googleDocsSyncProvider,
  notionSyncProvider,
  // 阶段三首试点：非 OAuth 直连源（webcal-url 通道 + direct 引擎）。
  icsCalendarSyncProvider,
  // 阶段三第二试点：飞书自建应用（api-token 通道 + direct 引擎）。
  feishuWikiSyncProvider,
];

export function syncProviderOf(provider: string): SyncProviderDefinition | null {
  return SYNC_PROVIDERS.find((definition) => definition.provider === provider) ?? null;
}

export function syncProviderNames(): string[] {
  return SYNC_PROVIDERS.map((definition) => definition.provider);
}

/** 注册表健康自检：命名规范、唯一、必填字段齐全。网关启动时调用，违例抛错拒启。 */
export function assertSyncProvidersValid(): void {
  const seen = new Set<string>();
  for (const definition of SYNC_PROVIDERS) {
    const { provider, engine, dataTypes, auth, defaultScopes, ui } = definition;
    if (!/^[a-z][a-z0-9-]*$/.test(provider))
      throw new Error(`sync_provider_invalid_name: ${provider}`);
    if (seen.has(provider)) throw new Error(`sync_provider_duplicate: ${provider}`);
    seen.add(provider);
    if (dataTypes.length === 0 || dataTypes.some((type) => !["mail", "calendar", "document"].includes(type)))
      throw new Error(`sync_provider_invalid_data_types: ${provider}`);
    if (!["nango", "direct"].includes(engine)) throw new Error(`sync_provider_invalid_engine: ${provider}`);
    if (engine === "nango" && (auth.channel !== "nango-oauth" || !auth.nango?.integrationProvider || !auth.nango.configKeyDefault))
      throw new Error(`sync_provider_invalid_auth: ${provider}`);
    if (engine === "direct" && auth.channel === "nango-oauth")
      throw new Error(`sync_provider_invalid_auth: ${provider}`);
    if (engine === "nango" && typeof definition.pull !== "function")
      throw new Error(`sync_provider_missing_pull: ${provider}`);
    if (engine === "direct" && typeof definition.pullDirect !== "function")
      throw new Error(`sync_provider_missing_pull_direct: ${provider}`);
    if (defaultScopes.length === 0 || defaultScopes.some((scope) => !scope.providerScopeId || !scope.displayName))
      throw new Error(`sync_provider_invalid_default_scopes: ${provider}`);
    if (!ui.label || !["mail", "calendar", "docs"].includes(ui.category) || !ui.iconKey)
      throw new Error(`sync_provider_invalid_ui: ${provider}`);
  }
}
