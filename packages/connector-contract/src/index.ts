export const CONNECTOR_PROTOCOL_VERSION = 1 as const;
export type ConnectorProvider = "gmail" | "outlook" | "google-docs" | "notion" | "google-calendar";
export type SyncMode = "full" | "incremental" | "rebuild";
export type SyncState = "idle" | "running" | "resync_required" | "disabled" | "error";
export interface ConnectorConnection { id:string; provider:ConnectorProvider; nangoConfigKey:string; nangoConnectionId:string; accountIdentityHash:string|null; status:"active"|"disabled"|"error"; filters:Record<string,unknown>; createdAt:string; updatedAt:string; }
export interface SyncScope { id:string; connectionId:string; providerScopeId:string; displayName:string; state:SyncState; sourceCursor:string|null; deliveryCursor:number; checkpointRevision:number; leaseOwner:string|null; leaseExpiresAt:string|null; fenceToken:number; updatedAt:string; }
export interface SyncRun { id:string; scopeId:string; mode:SyncMode; status:"queued"|"running"|"completed"|"failed"|"interrupted"; processed:number; failed:number; error:string|null; startedAt:string; finishedAt:string|null; }
export interface MailMessage { id:string; connectionId:string; providerMessageId:string; providerThreadId:string|null; subject:string|null; snippet:string|null; textBody:string|null; htmlBody:string|null; receivedAt:string|null; sentAt:string|null; isRead:boolean; isStarred:boolean; isDraft:boolean; isTombstone:boolean; updatedAt:string; }
export interface ConnectorStatus { enabled:boolean; connections:ConnectorConnection[]; scopes:SyncScope[]; runs:SyncRun[]; }
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
export interface NormalizedCalendarEvent { providerEventId:string; title:string; description?:string; startsAt:string; endsAt:string; timeZone?:string; location?:string; status?:string; organizer?:NormalizedAddress; attendees?:NormalizedAddress[]; recurrence?:Record<string,unknown>; providerRevision?:string; }
export interface ConnectorJsonRecord<T = unknown> { schemaVersion:1; type:"mail"|"calendar"; provider:ConnectorProvider; connectionId:string; data:T; }
export function isConnectorProvider(value: unknown): value is ConnectorProvider { return value === "gmail" || value === "outlook" || value === "google-docs" || value === "notion" || value === "google-calendar"; }
export function isSyncMode(value: unknown): value is SyncMode { return value === "full" || value === "incremental" || value === "rebuild"; }
