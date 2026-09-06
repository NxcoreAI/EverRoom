import type { SyncMode, NormalizedMailChange, NormalizedCalendarChange } from "@nxcore/connector-contract";
import type { PullPage } from "../types.js";

/**
 * SyncProvider（connector-platform-refactor-plan 阶段二）：数据源拉取适配器的
 * 注册表契约。每个 provider 一个文件、注册表一行装配——新增数据源不再触碰
 * executor / config / bootstrap / UI 的既有代码。
 *
 * 命名注意（方案 D8）：本接口是"拉取归一化适配器"，与
 * connector-orchestration-design 的 Provider Adapter（OpenConnector 动作编排）
 * 是两套正交概念，刻意不同名。
 */

/** scope 发现产出的种子（manager.ensureScope 的入参形状）。 */
export interface SyncScopeSeed {
  providerScopeId: string;
  displayName: string;
}

/** 连接级上下文：绑定单条 Nango 连接的只读代理（engine 注入，provider 不接触 axios）。 */
export interface PullContext {
  connectionId: string;
  configKey: string;
  proxyGet<T = any>(url: string, headers?: Record<string, string>): Promise<T>;
  proxyPost<T = any>(url: string, body: unknown): Promise<T>;
  /** 归一化映射（格式映射体系）：provider 原始记录 → canonical 契约。 */
  /** 映射未就绪时抛 FormatMappingPendingError（run 失败码 format_mapping_pending）。 */
  normalizeMail(raw: unknown): Promise<NormalizedMailChange>;
  normalizeCalendar(raw: unknown): Promise<NormalizedCalendarChange>;
}

/** 拉取上下文：scope 级（游标与 provider scope id）。 */
export interface SyncPullContext extends PullContext {
  providerScopeId: string;
  sourceCursor: string | null;
}

/** 直连引擎的 HTTP 响应（带缓存协商头，供 ETag/Last-Modified 增量）。 */
export interface DirectHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 直连引擎上下文：非 OAuth 源（WebCal 订阅、飞书自建应用等）不经过 Nango 代理。 */
export interface DirectPullContext {
  /** 连接凭据解析结果（webcal-url 通道 = 订阅 URL；api-token = "appId:appSecret"）。 */
  credentials: string;
  providerScopeId: string;
  sourceCursor: string | null;
  /** 只读 GET（https-only、禁内网、超时与大小上限由引擎强制）。 */
  httpGet(url: string, headers?: Record<string, string>): Promise<DirectHttpResponse>;
  /** JSON POST（获取访问令牌等；同等安全约束）。 */
  httpPostJson<T = any>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}

export type SyncDataType = "mail" | "calendar" | "document";

/** 拉取执行引擎：nango = Nango 代理（OAuth 源）；direct = 引擎直连 HTTP。 */
export type SyncEngineKind = "nango" | "direct";

/** Nango OAuth 通道元数据（阶段三将泛化为多通道 union）。 */
export interface SyncProviderNangoMeta {
  /** configKey 环境变量（按优先级；末位回落 default）。 */
  configKeyEnv: readonly string[];
  configKeyDefault: string;
  /** Nango integration 的 provider 名（nango-bootstrap ensureIntegration 用）。 */
  integrationProvider: string;
  /** OAuth client 凭据归属（config 的 {credential}ClientId/Secret 三选一；none = 不自举）。 */
  credential: "google" | "notion" | "outlook" | "none";
  /** OAuth scopes（逗号拼接传 Nango；不传则由 Nango integration 默认）。 */
  oauthScopes?: readonly string[];
}

export interface SyncProviderDefinition {
  /** 注册名，约束 ^[a-z][a-z0-9-]*$（启动自检）。 */
  provider: string;
  /** 拉取引擎：OAuth 源走 nango，直连源（WebCal 等）走 direct。 */
  engine: SyncEngineKind;
  dataTypes: readonly SyncDataType[];
  auth: { channel: "nango-oauth" | "webcal-url" | "api-token" | "password" | "manual-import"; nango?: SyncProviderNangoMeta };
  /** executor 缺席（引擎不可用）或发现失败时的 scope 兜底种子。 */
  defaultScopes: SyncScopeSeed[];
  /** 在线 scope 发现（gmail 的 me、calendar 的 calendarList、outlook 的文件夹递归…）。 */
  discoverScopes?(ctx: PullContext): Promise<SyncScopeSeed[]>;
  /** nango 引擎拉取（OAuth 源实现此者）。 */
  pull?(ctx: SyncPullContext, mode: SyncMode): AsyncGenerator<PullPage>;
  /** direct 引擎拉取（直连源实现此者）。 */
  pullDirect?(ctx: DirectPullContext, mode: SyncMode): AsyncGenerator<PullPage>;
  ui: { label: string; category: "mail" | "calendar" | "docs"; iconKey: string; comingSoon?: boolean };
}
