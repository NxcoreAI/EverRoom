import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorManager } from "./manager.js";
import { ConnectorRepository } from "./repository.js";
import { nangoConnectorRoutes } from "./routes.js";
import { SyncEngine } from "./sync-engine.js";
import type { ConnectorExecutor, PullPage } from "./types.js";

/** 与 manager.test.ts 同源的建表 DDL + 空发现执行器（测试自包含，不跨测试文件导入）。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, service TEXT NOT NULL, connection_name TEXT NOT NULL, account_identity_hash TEXT, status TEXT NOT NULL DEFAULT 'active', filters_json TEXT NOT NULL DEFAULT '{}', auth_method TEXT NOT NULL DEFAULT 'nango-oauth', credentials_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,connection_name));
CREATE TABLE IF NOT EXISTS sync_scopes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connector_connections(id), provider_scope_id TEXT NOT NULL, display_name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle', source_cursor TEXT, delivery_cursor INTEGER NOT NULL DEFAULT 0, checkpoint_revision INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, fence_token INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_scope_id));
CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES sync_scopes(id), mode TEXT NOT NULL, status TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT, cursor TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS sync_failures (id TEXT PRIMARY KEY, run_id TEXT, scope_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, provider_item_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_threads (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL, subject TEXT, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_thread_id));
CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_message_id TEXT NOT NULL, provider_thread_id TEXT, subject TEXT, snippet TEXT, text_body TEXT, html_body TEXT, received_at TEXT, sent_at TEXT, is_read INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, is_draft INTEGER NOT NULL DEFAULT 0, is_tombstone INTEGER NOT NULL DEFAULT 0, provider_revision TEXT, updated_at TEXT NOT NULL, UNIQUE(connection_id,provider_message_id));
CREATE TABLE IF NOT EXISTS mail_addresses (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, display_name TEXT, address TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_memberships (message_id TEXT NOT NULL, scope_id TEXT NOT NULL, membership_key TEXT NOT NULL, PRIMARY KEY(message_id,scope_id,membership_key));
CREATE TABLE IF NOT EXISTS mail_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, provider_id TEXT, filename TEXT, mime_type TEXT, size INTEGER, inline_attachment INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS connector_records (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, record_type TEXT NOT NULL, provider_record_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id,record_type,provider_record_id));
CREATE TABLE IF NOT EXISTS sync_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL, scope_id TEXT NOT NULL, message_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL);
`;

function emptyDiscoveryExecutor(): ConnectorExecutor {
  return {
    async discoverScopes() {
      return [];
    },
    async *pull(): AsyncGenerator<PullPage> {},
  };
}

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeManager() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.exec(SCHEMA);
  const executor = emptyDiscoveryExecutor();
  return new ConnectorManager(new ConnectorRepository(sqlite), executor, null, new SyncEngine(executor, () => null));
}

async function app(manager: ConnectorManager, onPurge?: (id: string) => Promise<void>) {
  const server = Fastify();
  await server.register(nangoConnectorRoutes(manager, true, undefined, onPurge));
  return server;
}

describe("nangoConnectorRoutes DELETE connection", () => {
  it("onPurge 在 repository 清理前调用（级联可读连接行），完成后连接被清", async () => {
    const manager = makeManager();
    const connection = await manager.register({ provider: "gmail", service: "gmail", connectionName: "c1" });
    let seenInHook: string | null = null;
    const server = await app(manager, async (id) => {
      seenInHook = manager.repository.getConnection(id)?.provider ?? null;
    });
    const response = await server.inject({ method: "DELETE", url: `/v1/nango-connectors/connections/${connection.id}` });
    expect(response.statusCode).toBe(200);
    expect(seenInHook).toBe("gmail");
    expect(manager.repository.getConnection(connection.id)).toBeNull();
  });

  it("onPurge 抛错 → 500 且连接保留（可重试）", async () => {
    const manager = makeManager();
    const connection = await manager.register({ provider: "gmail", service: "gmail", connectionName: "c1" });
    const server = await app(manager, async () => {
      throw new Error("cascade failed");
    });
    const response = await server.inject({ method: "DELETE", url: `/v1/nango-connectors/connections/${connection.id}` });
    expect(response.statusCode).toBe(500);
    expect(manager.repository.getConnection(connection.id)?.id).toBe(connection.id);
  });

  it("未注入 onPurge 时行为不变", async () => {
    const manager = makeManager();
    const connection = await manager.register({ provider: "gmail", service: "gmail", connectionName: "c1" });
    const server = await app(manager);
    const response = await server.inject({ method: "DELETE", url: `/v1/nango-connectors/connections/${connection.id}` });
    expect(response.statusCode).toBe(200);
    expect(manager.repository.getConnection(connection.id)).toBeNull();
  });
});
