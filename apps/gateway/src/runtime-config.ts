import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "./infrastructure/database/client.js";
import { gatewayMetadata, runtimeConfigStore } from "./infrastructure/database/schema.js";
import { registerSecret } from "./security/secret-redaction.js";
import type { SecretStore } from "./security/secret-store.js";

export interface RuntimeAiConfig {
  provider: string;
  model: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  maxTokens?: number;
  contextWindow?: number;
  temperature?: number;
  reasoning?: string;
  [key: string]: unknown;
}

export interface RuntimeConfig {
  schemaVersion: number;
  primary?: RuntimeAiConfig;
  background?: RuntimeAiConfig;
  /** 轻量模型档（main-lite）；未配置时 lite 会话档不可用。 */
  lite?: RuntimeAiConfig;
  cursorCompletion?: RuntimeAiConfig;
  vlm?: RuntimeAiConfig;
  webSearch?: RuntimeAiConfig;
  updatedAt?: string;
  configVersion?: number;
  [key: string]: unknown;
}

export type RuntimeConfigSource = "user" | "default";

/** SaaS 下发的套餐场景模型（键与 SaaS 管理端套餐面板一致；全 optional 容错）。 */
export interface RelayModels {
  primary?: string;
  background?: string;
  lite?: string;
  cursorCompletion?: string;
  vlm?: string;
  /** 生图（/v1/images/generations）：不走 runtime-config 槽位，image-gen 直读会话；空串=未配置（禁用生图）。 */
  image?: string;
  webSearch?: string;
}

/** relay 激活时的槽位重写目标：proxyOrigin + gateway 自身 token + 中转站 API 前缀。 */
export interface RuntimeConfigRelayOverride {
  proxyOrigin: string;
  token: string;
  /** 中转站 OpenAI 兼容前缀（如 /v1）；缺省 /v1。 */
  pathPrefix?: string;
  /** 套餐场景模型；未下发时各槽位模型沿用本地内置值。 */
  models?: RelayModels | undefined;
}

export interface RuntimeConfigSnapshot {
  config: RuntimeConfig;
  /** user 源原始 payload（redacted 快照会打码并剥除 webSearch 密钥）；从未保存过自定义配置时为 null。 */
  userConfig: RuntimeConfig | null;
  source: RuntimeConfigSource;
  selectedSource: RuntimeConfigSource;
  availableSources: RuntimeConfigSource[];
  configVersion: number;
  updatedAt: string;
  webSearchCredential: {
    configured: boolean;
    source: "user" | "env" | "none";
  };
}

const SECRET_KEYS = new Set(["apiKey"]);

/** 已删子系统（ASR/记忆/知识）的历史槽位：旧 payload 读取与保存时静默忽略，不迁移数据。 */
const LEGACY_SLOT_KEYS = ["transcriptionSummary", "asr", "memory", "knowledge"] as const;

function withoutLegacySlots(value: Record<string, unknown>): Record<string, unknown> {
  const output = clone(value);
  for (const key of LEGACY_SLOT_KEYS) delete output[key];
  return output;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_KEYS.has(key) && typeof child === "string" && child ? "********" : redact(child),
  ]));
}

function stripWebSearchApiKey(config: RuntimeConfig): RuntimeConfig {
  const output = clone(config);
  if (output.webSearch) {
    const { apiKey: _apiKey, ...webSearch } = output.webSearch;
    output.webSearch = webSearch as RuntimeAiConfig;
  }
  return output;
}

function preserveMasked(value: unknown, existing: unknown): unknown {
  if (Array.isArray(value) || !value || typeof value !== "object") return value === "********" || value === "" ? existing : value;
  const old = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, preserveMasked(child, old[key])]));
  for (const [key, child] of Object.entries(old)) if (!(key in result) && SECRET_KEYS.has(key)) result[key] = child;
  return result;
}

const AI_FIELDS = new Set(["provider", "model", "baseUrl", "api", "apiKey", "maxTokens", "contextWindow", "temperature", "reasoning"]);
const AI_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

function validateAiConfig(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`runtime_config_invalid:${path}`);
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) if (!AI_FIELDS.has(key)) throw new Error(`runtime_config_unknown_field:${path}.${key}`);
  for (const key of ["provider", "model", "baseUrl", "api", "apiKey", "reasoning"]) {
    if (item[key] !== undefined && typeof item[key] !== "string") throw new Error(`runtime_config_invalid:${path}.${key}`);
  }
  if (item.api !== undefined && item.api !== "" && !AI_APIS.has(item.api as string)) throw new Error(`runtime_config_invalid:${path}.api`);
  if (item.baseUrl) {
    try { const url = new URL(item.baseUrl as string); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
    catch { throw new Error(`runtime_config_invalid_url:${path}.baseUrl`); }
  }
  for (const key of ["maxTokens", "contextWindow"]) if (item[key] !== undefined && (!Number.isInteger(item[key]) || (item[key] as number) < 1 || (item[key] as number) > 2_000_000)) throw new Error(`runtime_config_invalid:${path}.${key}`);
  if (item.temperature !== undefined && (typeof item.temperature !== "number" || item.temperature < 0 || item.temperature > 2)) throw new Error(`runtime_config_invalid:${path}.temperature`);
}

function validateConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime_config_must_be_object");
  }
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1) throw new Error("runtime_config_schema_version_unsupported");
  const allowed = new Set([
    "schemaVersion", "primary", "background", "lite", "cursorCompletion", "vlm",
    "webSearch", "updatedAt", "configVersion",
  ]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`runtime_config_unknown_field:${key}`);
  for (const key of ["primary", "background", "lite", "cursorCompletion", "vlm", "webSearch"]) {
    const item = config[key];
    if (item === undefined) continue;
    validateAiConfig(item, key);
  }
  return clone(config as RuntimeConfig);
}

function defaultConfigPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "runtime-config.default.json"),
    join(moduleDirectory, "..", "runtime-config.default.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("runtime_config_default_file_missing");
  return path;
}

/** 配置 payload 幂等比较：键序无关的稳定序列化（set 重复保存短路用）。 */
function stableConfigJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableConfigJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${stableConfigJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class RuntimeConfigManager {
  private current: RuntimeConfigSnapshot;
  private readonly listeners = new Set<(snapshot: RuntimeConfigSnapshot) => void>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly secrets: SecretStore,
    defaultPath = defaultConfigPath(),
    private readonly environmentSearch: RuntimeAiConfig | null = null,
    /**
     * AI 中转覆盖提供者（ai-relay 会话激活时返回重写目标）。在 resolve 出口
     * 统一重写官方 LLM 槽位，使探测端点、边车 env 派生、GatewayConfig 三条
     * 消费路径自动全部指向本地 /ai-relay 代理出口；user 源 payload 里出现
     * 的槽位（用户显式直连）不重写，未出现的槽位回落官方。
     */
    private readonly relayOverride: (() => RuntimeConfigRelayOverride | null) | null = null,
  ) {
    if (environmentSearch?.apiKey) registerSecret(environmentSearch.apiKey);
    this.migrateSearchSecrets();
    const parsed = validateConfig(JSON.parse(readFileSync(defaultPath, "utf8")));
    this.current = this.resolve(parsed);
  }

  snapshot(redacted = false): RuntimeConfigSnapshot {
    const result = clone(this.current);
    if (redacted) {
      result.config = stripWebSearchApiKey(redact(result.config) as RuntimeConfig);
      if (result.userConfig) result.userConfig = stripWebSearchApiKey(redact(result.userConfig) as RuntimeConfig);
    }
    return result;
  }

  onChange(listener: (snapshot: RuntimeConfigSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(source: Exclude<RuntimeConfigSource, "default">, input: unknown): RuntimeConfigSnapshot {
    const previous = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).get();
    const candidate = withoutLegacySlots(clone(input) as Record<string, unknown>);
    const searchSecret = this.extractSearchSecret(source, candidate);
    const config = validateConfig(preserveMasked(candidate, previous?.payload));
    // 同 payload 重复保存直接短路：不再递增版本、不再 emit。短路条件排除两种
    // 真实变更：搜索密钥单独轮换（apiKey 在比较前已被剥除、走 secrets 通道，
    // 密钥不同不能丢）；user 源重存（保存 BYOK 即切回 user 选中源的唯一机制）。
    const secretUnchanged = searchSecret === this.secrets.get(`search:${source}`);
    const userSourceSwitch = this.selectedSource() !== "user";
    if (
      previous
      && secretUnchanged
      && !userSourceSwitch
      && stableConfigJson(previous.payload) === stableConfigJson(config)
    ) {
      return this.snapshot();
    }
    this.secrets.update({ [`search:${source}`]: searchSecret });
    const version = Math.max(this.current.configVersion, previous?.configVersion ?? 0) + 1;
    const now = new Date();
    this.db.transaction((tx) => {
      tx.insert(runtimeConfigStore).values({
        source,
        payload: config,
        schemaVersion: config.schemaVersion,
        configVersion: version,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: runtimeConfigStore.source,
        set: { payload: config, schemaVersion: config.schemaVersion, configVersion: version, updatedAt: now },
      }).run();
      if (source === "user") tx.insert(gatewayMetadata).values({ key: "runtime_config_source", value: "user", updatedAt: now }).onConflictDoUpdate({ target: gatewayMetadata.key, set: { value: "user", updatedAt: now } }).run();
    });
    this.current = this.resolve(this.defaultConfig(), version);
    this.emit();
    return this.snapshot();
  }

  clear(source: Exclude<RuntimeConfigSource, "default">): RuntimeConfigSnapshot {
    this.secrets.delete(`search:${source}`);
    this.db.delete(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).run();
    const selected = this.selectedSource();
    if (selected === source) this.db.delete(gatewayMetadata).where(eq(gatewayMetadata.key, "runtime_config_source")).run();
    this.current = this.resolve(this.defaultConfig(), this.current.configVersion + 1);
    this.emit();
    return this.snapshot();
  }

  selectSource(source: RuntimeConfigSource): RuntimeConfigSnapshot {
    if (source !== "default" && !this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).get()) {
      throw new Error(`runtime_config_source_unavailable:${source}`);
    }
    this.db.insert(gatewayMetadata).values({ key: "runtime_config_source", value: source, updatedAt: new Date() }).onConflictDoUpdate({ target: gatewayMetadata.key, set: { value: source, updatedAt: new Date() } }).run();
    this.current = this.resolve(this.defaultConfig(), this.current.configVersion + 1);
    this.emit();
    return this.snapshot();
  }

  clearManagedSecrets(): RuntimeConfigSnapshot {
    if (this.secrets.isAvailable()) this.secrets.update({ "search:user": undefined });
    this.current = this.resolve(this.defaultConfig(), this.current.configVersion + 1);
    this.emit();
    return this.snapshot();
  }

  private defaultConfig(): RuntimeConfig {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const path = [join(moduleDirectory, "runtime-config.default.json"), join(moduleDirectory, "..", "runtime-config.default.json")]
      .find((candidate) => existsSync(candidate));
    if (!path) throw new Error("runtime_config_default_file_missing");
    return validateConfig(JSON.parse(readFileSync(path, "utf8")));
  }

  private resolve(defaults: RuntimeConfig, minimumVersion = 1): RuntimeConfigSnapshot {
    const user = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, "user")).get();
    const availableSources: RuntimeConfigSource[] = ["default", ...(user ? ["user" as const] : [])];
    const storedSelection = this.selectedSource();
    const selectedSource = storedSelection === "user" && user ? "user" : storedSelection === "default" ? "default" : user ? "user" : "default";
    const selected = selectedSource === "user" ? user : undefined;
    const config = clone(defaults);
    const userOwned = new Set<string>();
    if (selectedSource === "user" && user) {
      this.applyUserOverrides(config, user.payload as RuntimeConfig, userOwned);
    }
    const credential = this.searchCredential(selectedSource);
    const selectedSearch = config.webSearch ?? {} as RuntimeAiConfig;
    if (this.environmentSearch || config.webSearch) {
      config.webSearch = { ...selectedSearch } as RuntimeAiConfig;
      for (const key of ["provider", "model", "baseUrl", "api"] as const) {
        if (!config.webSearch[key] && this.environmentSearch?.[key]) config.webSearch[key] = this.environmentSearch[key];
      }
      config.webSearch.apiKey = credential.value;
    }
    const updatedAt = selected?.updatedAt?.toISOString() ?? new Date().toISOString();
    const version = Math.max(minimumVersion, selected?.configVersion ?? 1);
    this.rewriteSlotsForRelay(config, userOwned);
    return {
      config: { ...config, configVersion: version, updatedAt },
      userConfig: user ? withoutLegacySlots(clone(user.payload as Record<string, unknown>)) as RuntimeConfig : null,
      source: selectedSource,
      selectedSource,
      availableSources,
      configVersion: version,
      updatedAt,
      webSearchCredential: { configured: Boolean(credential.value), source: credential.source },
    };
  }

  /** user 源槽位级覆盖清单：payload 里出现的键整体替换默认段并记为 userOwned
   *  （中转重写与 SaaS 模型覆盖跳过）。 */
  private static readonly USER_SLOT_KEYS = ["primary", "background", "lite", "cursorCompletion", "vlm", "webSearch"] as const;

  /** user payload 槽位级覆盖默认配置：出现的 AI 槽位整体替换（不做字段级合并，
   *  防止默认段的模型名/参数与用户直连端点混搭）。 */
  private applyUserOverrides(config: RuntimeConfig, payload: RuntimeConfig, userOwned: Set<string>): void {
    const record = payload as Record<string, unknown>;
    for (const key of RuntimeConfigManager.USER_SLOT_KEYS) {
      if (record[key] !== undefined) {
        (config as Record<string, unknown>)[key] = clone(record[key]);
        userOwned.add(key);
      }
    }
    // 槽位连接留空（只存模型）时继承通用模型（primary）的连接：密钥只在
    // 通用模型存一份，轮换后所有跟随槽位自动同步；独立连接（baseUrl 非空）
    // 不动。官方槽位不参与继承（空连接走中转重写）。文本场景与特殊模型
    // （vlm）同规则；webSearch 不参与（密钥专存）。
    const genericSource = config.primary;
    if (genericSource) {
      const inheritConnection = (slot: unknown, owned: boolean): void => {
        if (!owned || !slot || typeof slot !== "object") return;
        const item = slot as Record<string, undefined | string>;
        if (item.baseUrl) return;
        for (const field of ["provider", "baseUrl", "api", "apiKey"] as const) {
          if (!item[field] && genericSource[field]) item[field] = genericSource[field];
        }
      };
      for (const key of ["background", "lite", "cursorCompletion", "vlm"] as const) {
        inheritConnection((config as Record<string, unknown>)[key], userOwned.has(key));
      }
    }
  }

  private searchCredential(selectedSource: RuntimeConfigSource): {
    value: string;
    source: RuntimeConfigSnapshot["webSearchCredential"]["source"];
  } {
    const candidates = selectedSource === "user"
      ? [["user", this.secrets.get("search:user")]] as const
      : [];
    for (const [source, value] of candidates) if (value) return { value, source };
    return this.environmentSearch?.apiKey
      ? { value: this.environmentSearch.apiKey, source: "env" }
      : { value: "", source: "none" };
  }

  private extractSearchSecret(
    source: Exclude<RuntimeConfigSource, "default">,
    input: Record<string, unknown>,
  ): string | undefined {
    const webSearch = input.webSearch;
    if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch)) {
      return this.secrets.get(`search:${source}`);
    }
    const section = webSearch as Record<string, unknown>;
    const raw = section.apiKey;
    delete section.apiKey;
    if (raw === undefined) return this.secrets.get(`search:${source}`);
    if (typeof raw === "string") {
      if (raw === "********" || raw === "[REDACTED]") return this.secrets.get(`search:${source}`);
      return raw.trim() || undefined;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("runtime_config_invalid:webSearch.apiKey");
    const mutation = raw as { operation?: unknown; value?: unknown };
    if (mutation.operation === "keep") return this.secrets.get(`search:${source}`);
    if (mutation.operation === "delete") return undefined;
    if (mutation.operation === "set" && typeof mutation.value === "string" && mutation.value.trim()) {
      return mutation.value.trim();
    }
    throw new Error("runtime_config_invalid:webSearch.apiKey");
  }

  private migrateSearchSecrets(): void {
    if (!this.secrets.isAvailable()) return;
    for (const source of ["user"] as const) {
      const row = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).get();
      if (!row) continue;
      const payload = clone(row.payload) as RuntimeConfig;
      const current = payload.webSearch;
      const value = current?.apiKey;
      if (typeof value !== "string" || !value || value === "********") continue;
      this.secrets.set(`search:${source}`, value);
      const { apiKey: _apiKey, ...webSearch } = current;
      payload.webSearch = webSearch as RuntimeAiConfig;
      this.db.update(runtimeConfigStore).set({ payload }).where(eq(runtimeConfigStore.source, source)).run();
    }
  }

  /**
   * 用当前 default + 存储 + relay 会话重算并重发 onChange（不写库）。
   * ai-relay 会话 PUT/DELETE 后调用，让槽位重写即时生效。
   */
  refresh(): RuntimeConfigSnapshot {
    this.current = this.resolve(this.defaultConfig(), this.current.configVersion);
    this.emit();
    return this.snapshot();
  }

  /**
   * relay 激活时把官方槽位重写到本地代理出口（幂等不必要——resolve 每次从
   * 内置默认 + user 存储重建）。user 源槽位级语义：payload 里出现的槽位由
   * 用户直连（跳过重写），未出现的槽位回落官方（内置默认 + 中转重写）。
   * 内置 JSON 只声明 model/api，baseUrl/apiKey 留空：重写判定看 model 非空
   * ——有模型即补齐代理出口与会话令牌。
   * host 与路径整体换成中转站出口（路径 = 会话 baseUrl 推导的规范前缀，缺省
   * /v1），不继承槽位旧 pathname。relay 失效时官方槽位回到未配置态。
   * SaaS 下发了场景模型时先覆盖 model 再进重写判定——覆盖后的 model 非空
   * 即接代理出口，内置无槽位的 lite 由 SaaS 模型补建。
   */
  private rewriteSlotsForRelay(config: RuntimeConfig, userOwned: ReadonlySet<string>): void {
    const override = this.relayOverride?.() ?? null;
    if (!override) return;
    const proxyBase = `${override.proxyOrigin.replace(/\/+$/, "")}/ai-relay${override.pathPrefix ?? "/v1"}`;
    this.applyRelayModels(config, override.models, userOwned);
    const rewrite = (slot: unknown): void => {
      if (!slot || typeof slot !== "object") return;
      const item = slot as Record<string, unknown>;
      if (typeof item.model !== "string" || !item.model.trim()) return;
      item.baseUrl = proxyBase;
      item.apiKey = override.token;
    };
    for (const key of ["primary", "background", "lite", "cursorCompletion", "vlm", "webSearch"] as const) {
      if (!userOwned.has(key)) rewrite((config as Record<string, unknown>)[key]);
    }
  }

  /** SaaS 套餐场景模型覆盖：只写 SaaS 明确下发的场景，且只作用于官方槽位
   *  （userOwned 的槽位模型是用户自选，不覆盖）；其余槽位模型保持本地内置值。
   *  lite 内置 JSON 无槽位，缺槽且非用户槽时克隆 primary（或 background）结构
   *  换 model——lite 档随 SaaS 下发自动可用。 */
  private applyRelayModels(config: RuntimeConfig, models: RelayModels | undefined, userOwned: ReadonlySet<string>): void {
    if (!models) return;
    const setModel = (slotKey: string, slot: RuntimeAiConfig | undefined, model: string | undefined): void => {
      if (!slot || userOwned.has(slotKey)) return;
      if (typeof model === "string" && model.trim()) slot.model = model.trim();
    };
    setModel("primary", config.primary, models.primary);
    setModel("background", config.background, models.background);
    setModel("lite", config.lite, models.lite);
    if (!config.lite && !userOwned.has("lite") && typeof models.lite === "string" && models.lite.trim()) {
      const source = config.primary ?? config.background
        ?? { provider: "openai", model: "", baseUrl: "", api: "openai-completions", apiKey: "" } as RuntimeAiConfig;
      config.lite = { ...clone(source), model: models.lite.trim() };
    }
    setModel("cursorCompletion", config.cursorCompletion, models.cursorCompletion);
    setModel("vlm", config.vlm, models.vlm);
    setModel("webSearch", config.webSearch, models.webSearch);
  }

  private selectedSource(): RuntimeConfigSource | null {
    const value = this.db.select().from(gatewayMetadata).where(eq(gatewayMetadata.key, "runtime_config_source")).get()?.value;
    return value === "user" || value === "default" ? value : null;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
