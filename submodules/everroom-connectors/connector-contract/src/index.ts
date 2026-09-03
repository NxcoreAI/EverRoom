export const CONNECTOR_PROTOCOL_VERSION = 1 as const;
/**
 * 阶段二（connector-platform-refactor-plan）放宽：provider 是开放注册名
 * （SyncProvider 注册表），不再是闭集 union。编译期穷尽性由网关侧
 * assertSyncProvidersValid() 启动自检补偿；本包只约束形状。
 */
export type ConnectorProvider = string;
/** 放宽前的内置五源：isConnectorProvider 默认校验集与迁移提示用。 */
export const BUILTIN_PROVIDERS = ["gmail", "outlook", "google-docs", "notion", "google-calendar"] as const;
export type BuiltinConnectorProvider = (typeof BUILTIN_PROVIDERS)[number];
export type SyncMode = "full" | "incremental" | "rebuild";
export type SyncState = "idle" | "running" | "resync_required" | "disabled" | "error";
export interface ConnectorConnection { id:string; provider:ConnectorProvider; nangoConfigKey:string; nangoConnectionId:string; accountIdentityHash:string|null; status:"active"|"disabled"|"error"; filters:Record<string,unknown>; createdAt:string; updatedAt:string; /** 阶段三：授权通道（缺省 nango-oauth，存量连接即此值）。 */ authMethod?:"nango-oauth"|"api-token"|"webcal-url"|"password"|"manual-import"; /** 阶段三：凭据引用（密文/URL；只在 connectors.sqlite，REST 响应不回显）。 */ credentialsRef?:string|null; }
export interface SyncScope { id:string; connectionId:string; providerScopeId:string; displayName:string; state:SyncState; sourceCursor:string|null; deliveryCursor:number; checkpointRevision:number; leaseOwner:string|null; leaseExpiresAt:string|null; fenceToken:number; updatedAt:string; }
export interface SyncRun { id:string; scopeId:string; mode:SyncMode; status:"queued"|"running"|"completed"|"failed"|"interrupted"; processed:number; failed:number; error:string|null; startedAt:string; finishedAt:string|null; }
export interface MailMessage { id:string; connectionId:string; providerMessageId:string; providerThreadId:string|null; subject:string|null; snippet:string|null; textBody:string|null; htmlBody:string|null; receivedAt:string|null; sentAt:string|null; isRead:boolean; isStarred:boolean; isDraft:boolean; isTombstone:boolean; updatedAt:string; }
export interface ConnectorStatus { enabled:boolean; connections:ConnectorConnection[]; scopes:SyncScope[]; runs:SyncRun[]; }
/** SyncProvider 注册表元数据（网关 /v1/nango-connectors/providers 端点）——桌面连接菜单/图标/分类的数据源。 */
export type ConnectorAuthChannel = "nango-oauth" | "api-token" | "webcal-url" | "password" | "manual-import";
export interface ConnectorProviderSummary { provider:ConnectorProvider; label:string; category:"mail"|"calendar"|"docs"; iconKey:string; dataTypes:string[]; authChannel:ConnectorAuthChannel; connected:boolean; comingSoon:boolean; }
export interface ConnectorProvidersResponse { enabled:boolean; providers:ConnectorProviderSummary[]; }
export type ConnectorAuthorizationState = "pending" | "connected" | "failed" | "expired";
export interface ConnectorAuthorizationAttempt { id:string; provider:ConnectorProvider; status:ConnectorAuthorizationState; expiresAt:string; connection:ConnectorConnection|null; error:string|null; }
export interface NormalizedAddress { role:string; displayName?:string; address:string; }
export interface NormalizedAttachment { providerId?:string; filename?:string; mimeType?:string; size?:number; inline?:boolean; }
export interface NormalizedMail { providerMessageId:string; providerThreadId?:string; subject?:string; snippet?:string; textBody?:string; htmlBody?:string; receivedAt?:string; sentAt?:string; isRead?:boolean; isStarred?:boolean; isDraft?:boolean; providerRevision?:string; addresses?:NormalizedAddress[]; memberships?:string[]; attachments?:NormalizedAttachment[]; }
export type NormalizedMailChange = { kind:"upsert"; message:NormalizedMail } | { kind:"tombstone"; providerMessageId:string; providerThreadId?:string };
export type NormalizedCalendarChange = { kind:"upsert"; event:NormalizedCalendarEvent } | { kind:"tombstone"; providerEventId:string };
export interface NormalizedDocument { providerDocumentId:string; title:string; markdown:string; providerRevision?:string; sourceUrl?:string; }
export interface WikiDocumentSummary { id:string; fileName:string; title:string; size:number; modifiedAt:string; }
export interface WikiDocumentPreview extends WikiDocumentSummary { content:string; }
export interface NormalizedCalendarEvent { providerEventId:string; title:string; description?:string; startsAt:string; endsAt:string; /** 全天事件标记（ICS VALUE=DATE 等；缺省视为 false）。 */ allDay?:boolean; timeZone?:string; location?:string; status?:string; organizer?:NormalizedAddress; attendees?:NormalizedAddress[]; recurrence?:Record<string,unknown>; providerRevision?:string; }
export interface ConnectorJsonRecord<T = unknown> { schemaVersion:1; type:"mail"|"calendar"; provider:ConnectorProvider; connectionId:string; data:T; }
export function isConnectorProvider(value: unknown, known: readonly string[] = BUILTIN_PROVIDERS): value is ConnectorProvider { return typeof value === "string" && known.includes(value); }
export function isSyncMode(value: unknown): value is SyncMode { return value === "full" || value === "incremental" || value === "rebuild"; }
