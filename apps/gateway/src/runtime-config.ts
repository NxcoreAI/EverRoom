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
  cursorCompletion?: RuntimeAiConfig;
  asr?: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    oss?: Record<string, unknown>;
    [key: string]: unknown;
  };
  vlm?: RuntimeAiConfig;
  webSearch?: RuntimeAiConfig;
  memory?: Record<string, unknown>;
  knowledge?: Record<string, unknown>;
  updatedAt?: string;
  configVersion?: number;
  [key: string]: unknown;
}

export type RuntimeConfigSource = "user" | "saas" | "default";

export interface RuntimeConfigSnapshot {
  config: RuntimeConfig;
  source: RuntimeConfigSource;
  selectedSource: RuntimeConfigSource;
  availableSources: RuntimeConfigSource[];
  configVersion: number;
  updatedAt: string;
  webSearchCredential: {
    configured: boolean;
    source: "user" | "saas" | "env" | "none";
  };
}

const SECRET_KEYS = new Set([
  "apiKey",
  "accessKeySecret",
  "stsToken",
  "nangoSecret",
  "clientSecret",
]);

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

function merge(base: RuntimeConfig, override: Partial<RuntimeConfig>): RuntimeConfig {
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = { ...(result[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      result[key] = value;
    }
  }
  return result;
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
    "schemaVersion", "primary", "background", "cursorCompletion", "asr", "vlm",
    "webSearch", "memory", "knowledge", "updatedAt", "configVersion",
  ]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`runtime_config_unknown_field:${key}`);
  for (const key of ["primary", "background", "cursorCompletion", "vlm", "webSearch"]) {
    const item = config[key];
    if (item === undefined) continue;
    validateAiConfig(item, key);
  }
  if (config.asr !== undefined) {
    if (!config.asr || typeof config.asr !== "object" || Array.isArray(config.asr)) throw new Error("runtime_config_invalid:asr");
    const asr = config.asr as Record<string, unknown>;
    for (const key of Object.keys(asr)) if (!["provider", "baseUrl", "model", "apiKey", "oss"].includes(key)) throw new Error(`runtime_config_unknown_field:asr.${key}`);
    for (const key of ["provider", "baseUrl", "model", "apiKey"]) if (asr[key] !== undefined && typeof asr[key] !== "string") throw new Error(`runtime_config_invalid:asr.${key}`);
    if (asr.baseUrl) { try { const url = new URL(asr.baseUrl as string); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); } catch { throw new Error("runtime_config_invalid_url:asr.baseUrl"); } }
    if (asr.oss !== undefined) {
      if (!asr.oss || typeof asr.oss !== "object" || Array.isArray(asr.oss)) throw new Error("runtime_config_invalid:asr.oss");
      for (const key of Object.keys(asr.oss as Record<string, unknown>)) if (!["region", "bucket", "accessKeyId", "accessKeySecret", "stsToken", "prefix"].includes(key)) throw new Error(`runtime_config_unknown_field:asr.oss.${key}`);
    }
  }
  if (config.memory !== undefined) {
    if (!config.memory || typeof config.memory !== "object" || Array.isArray(config.memory)) throw new Error("runtime_config_invalid:memory");
    const memory = config.memory as Record<string, unknown>;
    for (const key of Object.keys(memory)) if (!["enabled", "baseUrl", "apiKey", "serviceId", "teamId", "agentId", "userId", "recallLimit", "charBudget", "timeoutMs"].includes(key)) throw new Error(`runtime_config_unknown_field:memory.${key}`);
    if (memory.enabled !== undefined && typeof memory.enabled !== "boolean") throw new Error("runtime_config_invalid:memory.enabled");
    for (const key of ["baseUrl", "apiKey", "serviceId", "teamId", "agentId", "userId"]) {
      if (memory[key] !== undefined && typeof memory[key] !== "string") throw new Error(`runtime_config_invalid:memory.${key}`);
    }
    for (const [key, minimum, maximum] of [["recallLimit", 1, 50], ["charBudget", 200, 2_000_000], ["timeoutMs", 100, 120_000]] as const) {
      if (memory[key] !== undefined && (!Number.isInteger(memory[key]) || (memory[key] as number) < minimum || (memory[key] as number) > maximum)) {
        throw new Error(`runtime_config_invalid:memory.${key}`);
      }
    }
  }
  if (config.knowledge !== undefined) {
    if (!config.knowledge || typeof config.knowledge !== "object" || Array.isArray(config.knowledge)) throw new Error("runtime_config_invalid:knowledge");
    const knowledge = config.knowledge as Record<string, unknown>;
    for (const key of Object.keys(knowledge)) if (!["enabled", "baseUrl", "serviceId", "teamId", "wikiId", "llm", "embedding"].includes(key)) throw new Error(`runtime_config_unknown_field:knowledge.${key}`);
    if (knowledge.llm !== undefined) validateAiConfig(knowledge.llm, "knowledge.llm");
    if (knowledge.embedding !== undefined) validateAiConfig(knowledge.embedding, "knowledge.embedding");
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

export class RuntimeConfigManager {
  private current: RuntimeConfigSnapshot;
  private readonly listeners = new Set<(snapshot: RuntimeConfigSnapshot) => void>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly secrets: SecretStore,
    defaultPath = defaultConfigPath(),
    private readonly environmentSearch: RuntimeAiConfig | null = null,
  ) {
    if (environmentSearch?.apiKey) registerSecret(environmentSearch.apiKey);
    this.migrateSearchSecrets();
    const parsed = validateConfig(JSON.parse(readFileSync(defaultPath, "utf8")));
    this.current = this.resolve(parsed);
  }

  snapshot(redacted = false): RuntimeConfigSnapshot {
    const result = clone(this.current);
    if (redacted) result.config = stripWebSearchApiKey(redact(result.config) as RuntimeConfig);
    return result;
  }

  onChange(listener: (snapshot: RuntimeConfigSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(source: Exclude<RuntimeConfigSource, "default">, input: unknown): RuntimeConfigSnapshot {
    const previous = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).get();
    const candidate = clone(input) as Record<string, unknown>;
    const searchSecret = this.extractSearchSecret(source, candidate);
    const config = validateConfig(preserveMasked(candidate, previous?.payload));
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
    if (this.secrets.isAvailable()) this.secrets.update({ "search:user": undefined, "search:saas": undefined });
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
    const saas = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, "saas")).get();
    const availableSources: RuntimeConfigSource[] = ["default", ...(saas ? ["saas" as const] : []), ...(user ? ["user" as const] : [])];
    const storedSelection = this.selectedSource();
    const selectedSource = storedSelection === "user" && user ? "user" : storedSelection === "saas" && saas ? "saas" : storedSelection === "default" ? "default" : user ? "user" : saas ? "saas" : "default";
    const selected = selectedSource === "user" ? user : selectedSource === "saas" ? saas : undefined;
    let config = defaults;
    if (selectedSource === "user") {
      if (saas) config = merge(config, saas.payload as RuntimeConfig);
      if (user) config = merge(config, user.payload as RuntimeConfig);
    } else if (selectedSource === "saas" && saas) {
      config = merge(config, saas.payload as RuntimeConfig);
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
    return {
      config: { ...config, configVersion: version, updatedAt },
      source: selectedSource,
      selectedSource,
      availableSources,
      configVersion: version,
      updatedAt,
      webSearchCredential: { configured: Boolean(credential.value), source: credential.source },
    };
  }

  private searchCredential(selectedSource: RuntimeConfigSource): {
    value: string;
    source: RuntimeConfigSnapshot["webSearchCredential"]["source"];
  } {
    const candidates = selectedSource === "user"
      ? [["user", this.secrets.get("search:user")], ["saas", this.secrets.get("search:saas")]] as const
      : selectedSource === "saas"
        ? [["saas", this.secrets.get("search:saas")]] as const
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
    for (const source of ["user", "saas"] as const) {
      const row = this.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, source)).get();
      if (!row) continue;
      const payload = clone(row.payload) as RuntimeConfig;
      const current = payload.webSearch;
      const value = current?.apiKey;
      if (typeof value !== "string" || !value || value === "********") continue;
      if (this.secrets.isAvailable()) this.secrets.set(`search:${source}`, value);
      const { apiKey: _apiKey, ...webSearch } = current;
      payload.webSearch = webSearch as RuntimeAiConfig;
      this.db.update(runtimeConfigStore).set({ payload }).where(eq(runtimeConfigStore.source, source)).run();
    }
  }

  private selectedSource(): RuntimeConfigSource | null {
    const value = this.db.select().from(gatewayMetadata).where(eq(gatewayMetadata.key, "runtime_config_source")).get()?.value;
    return value === "user" || value === "saas" || value === "default" ? value : null;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
