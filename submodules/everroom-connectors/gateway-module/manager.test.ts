import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectorExecutor, PullPage } from "./types.js";
import { ConnectorManager } from "./manager.js";
import { ConnectorRepository } from "./repository.js";
import { SyncEngine } from "./sync-engine.js";

/**
 * 与 apps/gateway/src/infrastructure/connectors/client.ts 同源的建表 DDL
 * （submodule 自包含：测试不依赖宿主工程文件）。
 */
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

/** 空发现执行器：gmail/notion/google-docs 走的真实路径（discoverScopes 返回 []）。 */
function emptyDiscoveryExecutor(): ConnectorExecutor {
  return {
    async discoverScopes() {
      return [];
    },
    async *pull(): AsyncGenerator<PullPage> {},
  };
}

function createManager(executor: ConnectorExecutor | null) {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA);
  const repository = new ConnectorRepository(sqlite);
  const manager = new ConnectorManager(
    repository,
    executor,
    null,
    new SyncEngine(executor, () => null),
  );
  return { manager, repository, sqlite };
}

describe("ConnectorManager.register scope 种子", () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
  });
  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
  });

  it("在线发现为空时回退注册表 defaultScopes（gmail 的 me）并触发首同步 full", async () => {
    const { manager, repository, sqlite } = createManager(emptyDiscoveryExecutor());
    cleanup.push(async () => {
      await manager.dispose();
      sqlite.close();
    });

    const connection = await manager.register({
      provider: "gmail",
      service: "gmail",
      connectionName: "default",
    });

    const scopes = repository.listScopes().filter((s) => s.connectionId === connection.id);
    expect(scopes.map((s) => s.providerScopeId)).toEqual(["me"]);
    // 首同步被触发（mode=full 的 run 落库）
    await viWaitUntil(() =>
      repository.listRuns().some((r) => r.scopeId === scopes[0]!.id && r.mode === "full"),
    );
  });

  it("同 (provider, connectionName) 重复注册幂等复用既有行（单槽位顶替）", async () => {
    const { manager, repository, sqlite } = createManager(emptyDiscoveryExecutor());
    cleanup.push(async () => {
      await manager.dispose();
      sqlite.close();
    });

    const first = await manager.register({
      provider: "gmail",
      service: "gmail",
      connectionName: "default",
    });
    const second = await manager.register({
      provider: "gmail",
      service: "gmail",
      connectionName: "default",
    });

    expect(second.id).toBe(first.id);
    const rows = repository
      .listConnections()
      .filter((c) => c.provider === "gmail" && c.connectionName === "default");
    expect(rows).toHaveLength(1);
  });

  it("启动自愈为 scope 为空的存量连接补建 scope（清空数据重连受害者的恢复路径）", async () => {
    const { manager, repository, sqlite } = createManager(emptyDiscoveryExecutor());
    cleanup.push(async () => {
      await manager.dispose();
      sqlite.close();
    });

    // 模拟空发现回归时期注册的连接：直接落库，无 scope。
    const orphan = repository.registerConnection({
      provider: "gmail",
      service: "gmail",
      connectionName: "default",
    });
    expect(repository.listScopes().filter((s) => s.connectionId === orphan.id)).toHaveLength(0);

    manager.startPolling(3_600_000);

    await viWaitUntil(() =>
      repository.listScopes().some((s) => s.connectionId === orphan.id),
    );
    const healed = repository.listScopes().filter((s) => s.connectionId === orphan.id);
    expect(healed.map((s) => s.providerScopeId)).toEqual(["me"]);
    await viWaitUntil(() =>
      repository.listRuns().some((r) => r.scopeId === healed[0]!.id && r.mode === "full"),
    );
  });
});

/** vitest 的 waitUntil 未内置于当前版本的使用习惯，这里用轮询小工具。 */
async function viWaitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
