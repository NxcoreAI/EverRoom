import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface ConnectorDatabase { sqlite: Database.Database; close(): void; }
const schema = `
CREATE TABLE IF NOT EXISTS connector_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, nango_config_key TEXT NOT NULL, nango_connection_id TEXT NOT NULL, account_identity_hash TEXT, status TEXT NOT NULL DEFAULT 'active', filters_json TEXT NOT NULL DEFAULT '{}', auth_method TEXT NOT NULL DEFAULT 'nango-oauth', credentials_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,nango_connection_id));
CREATE TABLE IF NOT EXISTS sync_scopes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connector_connections(id), provider_scope_id TEXT NOT NULL, display_name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', source_cursor TEXT, delivery_cursor INTEGER NOT NULL DEFAULT 0, checkpoint_revision INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, fence_token INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_scope_id));
CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES sync_scopes(id), mode TEXT NOT NULL, status TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS sync_failures (id TEXT PRIMARY KEY, run_id TEXT, scope_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, provider_item_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_threads (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL, subject TEXT, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_thread_id));
CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_message_id TEXT NOT NULL, provider_thread_id TEXT, subject TEXT, snippet TEXT, text_body TEXT, html_body TEXT, received_at TEXT, sent_at TEXT, is_read INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, is_draft INTEGER NOT NULL DEFAULT 0, is_tombstone INTEGER NOT NULL DEFAULT 0, provider_revision TEXT, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_message_id));
CREATE TABLE IF NOT EXISTS mail_addresses (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, display_name TEXT, address TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_memberships (message_id TEXT NOT NULL, scope_id TEXT NOT NULL, membership_key TEXT NOT NULL, PRIMARY KEY(message_id,scope_id,membership_key));
CREATE TABLE IF NOT EXISTS mail_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, provider_id TEXT, filename TEXT, mime_type TEXT, size INTEGER, inline_attachment INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS connector_records (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, record_type TEXT NOT NULL, provider_record_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id,record_type,provider_record_id));
CREATE TABLE IF NOT EXISTS sync_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL, scope_id TEXT NOT NULL, message_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mail_messages_connection_updated ON mail_messages(connection_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_connector_records_type_updated ON connector_records(record_type,updated_at);
`;

function migrate(sqlite: Database.Database): void {
  const syncChangeColumns = sqlite
    .prepare("PRAGMA table_info(sync_changes)")
    .all() as Array<{ name: string }>;
  if (!syncChangeColumns.some((column) => column.name === "scope_id")) {
    sqlite.exec(
      "ALTER TABLE sync_changes ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''",
    );
  }
  // 阶段三：授权通道解耦——连接记录授权方式与凭据引用（存量行回落 nango-oauth/NULL）。
  const connectionColumns = sqlite
    .prepare("PRAGMA table_info(connector_connections)")
    .all() as Array<{ name: string }>;
  if (!connectionColumns.some((column) => column.name === "auth_method")) {
    sqlite.exec("ALTER TABLE connector_connections ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'nango-oauth'");
  }
  if (!connectionColumns.some((column) => column.name === "credentials_ref")) {
    sqlite.exec("ALTER TABLE connector_connections ADD COLUMN credentials_ref TEXT");
  }
}

export function createConnectorDatabase(databasePath:string): ConnectorDatabase { if(databasePath!==":memory:")mkdirSync(dirname(databasePath),{recursive:true}); const sqlite=new Database(databasePath); if(databasePath!==":memory:")try{chmodSync(databasePath,0o600);}catch{} sqlite.pragma("journal_mode = WAL"); sqlite.pragma("foreign_keys = ON"); sqlite.pragma("busy_timeout = 5000"); sqlite.pragma("synchronous = NORMAL"); sqlite.exec(schema); migrate(sqlite); return {sqlite,close:()=>sqlite.close()}; }
