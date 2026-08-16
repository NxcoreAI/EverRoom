import type { ConnectorProvider, NormalizedMailChange, SyncMode } from "@nxcore/connector-contract";
export type { ConnectorProvider, NormalizedMailChange, SyncMode } from "@nxcore/connector-contract";
export interface ConnectorConfig { nangoUrl:string; nangoSecret:string; gmailConfigKey:string; outlookConfigKey:string; pollingIntervalMs:number; enabled:boolean; databasePath:string; }
export interface PullPage { changes: NormalizedMailChange[]; continuation?: string; terminalCursor?: string; }
export interface ConnectorExecutor { discoverScopes?(connection:{provider:ConnectorProvider;nangoConnectionId:string;nangoConfigKey:string}):Promise<Array<{id:string;displayName:string}>>; pull(scope: {provider:ConnectorProvider; nangoConnectionId:string; nangoConfigKey?:string; providerScopeId:string; sourceCursor:string|null}, mode:SyncMode): AsyncGenerator<PullPage>; }
