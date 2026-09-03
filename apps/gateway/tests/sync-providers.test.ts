import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";
import { ConnectorRepository } from "@nxcore/connectors-module/repository.js";
import { ConnectorManager } from "@nxcore/connectors-module/manager.js";
import { NangoExecutor } from "@nxcore/connectors-module/nango-executor.js";
import { nangoConnectorRoutes } from "@nxcore/connectors-module/routes.js";
import {
  SYNC_PROVIDERS,
  assertSyncProvidersValid,
  syncProviderOf,
  syncProviderNames,
} from "@nxcore/connectors-module/sync-providers/index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("sync provider registry", () => {
  it("passes the startup self-check and covers the seven builtin providers", () => {
    expect(() => assertSyncProvidersValid()).not.toThrow();
    expect(syncProviderNames().sort()).toEqual(["feishu-wiki", "gmail", "google-calendar", "google-docs", "ics-calendar", "notion", "outlook"]);
    for (const definition of SYNC_PROVIDERS) {
      expect(definition.provider).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(definition.dataTypes.length).toBeGreaterThan(0);
      expect(definition.ui.label).toBeTruthy();
      expect(["mail", "calendar", "docs"]).toContain(definition.ui.category);
      expect(definition.auth.nango?.integrationProvider ?? "direct").toBeTruthy();
      expect(definition.auth.nango?.configKeyDefault ?? "direct").toBeTruthy();
      expect(definition.defaultScopes.length).toBeGreaterThan(0);
      expect(typeof (definition.pull ?? definition.pullDirect)).toBe("function");
    }
    expect(syncProviderOf("gmail")?.auth.nango?.oauthScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("keeps the nango executor free of provider literals (registry dispatch only)", async () => {
    const source = await readFile(resolve("../../submodules/everroom-connectors/gateway-module/nango-executor.ts"), "utf8");
    expect(source).not.toMatch(/"gmail"|"outlook"|"google-docs"|"notion"|"google-calendar"/);
  });

  it("rejects unknown providers at the engine boundary", async () => {
    const executor = new NangoExecutor("https://nango.local", "secret");
    await expect(executor.discoverScopes({ provider: "feishu", nangoConnectionId: "c", nangoConfigKey: "k" }))
      .rejects.toThrow("unknown_connector_provider: feishu");
    await expect(async () => {
      for await (const _page of executor.pull({ provider: "feishu", nangoConnectionId: "c", nangoConfigKey: "k", providerScopeId: "me", sourceCursor: null }, "full")) break;
    }).rejects.toThrow("unknown_connector_provider: feishu");
  });

  it("seeds default scopes from the registry when no executor is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sync-provider-test-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const repo = new ConnectorRepository(connectors.sqlite);
    const manager = new ConnectorManager(repo, null);
    const connection = await manager.register({ provider: "google-docs", nangoConfigKey: "docs", nangoConnectionId: "c" });
    // 旧实现的兜底 ternary 会给出 inbox/Inbox；注册表给出 provider 自己的种子。
    expect(repo.listScopes().filter((scope) => scope.connectionId === connection.id))
      .toEqual([expect.objectContaining({ providerScopeId: "documents", displayName: "Google Docs" })]);
    await manager.dispose();
    connectors.sqlite.close();
  });
});

describe("provider metadata endpoint", () => {
  it("serves registry metadata with connected flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sync-provider-routes-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const repo = new ConnectorRepository(connectors.sqlite);
    repo.registerConnection({ provider: "gmail", nangoConfigKey: "google-mail", nangoConnectionId: "c" });
    const manager = new ConnectorManager(repo, null);
    const app = Fastify();
    await app.register(nangoConnectorRoutes(manager, true));
    const response = await app.inject({ url: "/v1/nango-connectors/providers" });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.enabled).toBe(true);
    const gmail = payload.providers.find((item: any) => item.provider === "gmail");
    expect(gmail).toMatchObject({ label: "Gmail", category: "mail", iconKey: "gmail", connected: true, comingSoon: false });
    expect(payload.providers.find((item: any) => item.provider === "notion")).toMatchObject({ connected: false });
    await app.close();
    await manager.dispose();
    connectors.sqlite.close();
  });
});
