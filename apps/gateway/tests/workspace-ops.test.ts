import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpaceLayout, AgentWorkspace } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

/**
 * 运维闭环（P4）验收：
 * - 搬移：整个目录跟着搬到新位置，标记与 DB 同步，旧位置不再留副本；
 * - 离线：目录被外部删掉后只标「离线」，不静默重建；修复能建回空骨架；
 * - 接管：已有目录（有标记）沿用 spaceId；复制品必须显式 `reassignSpaceId` 才能另立门户；
 * - 空目录也能被接管成新空间。
 */

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-ops-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "test-token-0123456789",
    agentRuntime: "fake",
    pi: null,
    cursorCompletionPi: null,
    litePi: null,
    backgroundPi: null,
    webSearch: null,
    mcpConfigPath: join(dataDir, "agent", "mcp.json"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function createSpace(
  app: Awaited<ReturnType<typeof createServer>>,
  headers: Record<string, string>,
  name: string,
): Promise<AgentWorkspace> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent/workspaces",
    headers,
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<AgentWorkspace>();
}

describe("project space operations (P4)", () => {
  it("relocates the whole directory and keeps the marker in sync", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const workspace = await createSpace(app, headers, "Relocate me");
    const from = workspace.path as string;
    const to = join(config.dataDir, "Workspace", "relocated-space");

    const moved = await app.inject({
      method: "POST",
      url: `/v1/agent/workspaces/${workspace.id}/relocate`,
      headers,
      payload: { dir: to },
    });
    expect(moved.statusCode).toBe(200);
    const relocated = moved.json<AgentWorkspace>();
    expect(relocated.path).toBe(to);
    expect(relocated.slug).toBe("relocated-space");
    expect(relocated.id).toBe(workspace.id);

    expect(existsSync(from)).toBe(false);
    expect(existsSync(join(to, ".everoffice", "space.json"))).toBe(true);
    const marker = JSON.parse(await readFile(join(to, ".everoffice", "space.json"), "utf8")) as {
      spaceId: string;
      slug: string;
    };
    expect(marker.spaceId).toBe(workspace.id);
    expect(marker.slug).toBe("relocated-space");
    // 角色目录跟着搬（不是重建的）。
    expect(existsSync(join(to, ".everoffice", "memory"))).toBe(true);
    expect(existsSync(join(to, ".tmp"))).toBe(true);

    await app.close();
  });

  it("marks a vanished directory offline instead of recreating it, and repairs on demand", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const workspace = await createSpace(app, headers, "Offline me");
    const root = workspace.path as string;

    await rm(root, { recursive: true, force: true });

    const listed = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    const offline = listed.find((item) => item.id === workspace.id);
    expect(offline?.rootMissingAt).toBeTruthy();
    // 没有被静默重建。
    expect(existsSync(root)).toBe(false);

    const layout = (await app.inject({
      method: "GET",
      url: `/v1/agent/workspaces/${workspace.id}/layout`,
      headers,
    })).json<AgentSpaceLayout>();
    expect(layout.health.exists).toBe(false);

    const repaired = await app.inject({
      method: "POST",
      url: `/v1/agent/workspaces/${workspace.id}/layout/repair`,
      headers,
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json<{ createdMarker: boolean }>().createdMarker).toBe(true);
    expect(existsSync(join(root, ".everoffice", "space.json"))).toBe(true);

    await app.close();
  });

  it("adopts an existing directory, and makes copies opt into a new identity", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const workspace = await createSpace(app, headers, "Original");
    const root = workspace.path as string;

    // 用户把空间目录复制一份（同一 spaceId）。
    const copy = join(config.dataDir, "Workspace", "original-copy");
    await cp(root, copy, { recursive: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/workspaces/adopt",
      headers,
      payload: { dir: copy },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: string }>().error).toBe("space_already_registered");

    const adopted = await app.inject({
      method: "POST",
      url: "/v1/workspaces/adopt",
      headers,
      payload: { dir: copy, name: "Original (copy)", reassignSpaceId: true },
    });
    expect(adopted.statusCode).toBe(201);
    const copySpace = adopted.json<AgentWorkspace>();
    expect(copySpace.id).not.toBe(workspace.id);
    expect(copySpace.path).toBe(copy);
    const copyMarker = JSON.parse(await readFile(join(copy, ".everoffice", "space.json"), "utf8")) as {
      spaceId: string;
      name: string;
    };
    expect(copyMarker.spaceId).toBe(copySpace.id);
    expect(copyMarker.name).toBe("Original (copy)");

    // 原空间不受影响。
    const originalMarker = JSON.parse(await readFile(join(root, ".everoffice", "space.json"), "utf8")) as {
      spaceId: string;
    };
    expect(originalMarker.spaceId).toBe(workspace.id);

    await app.close();
  });

  it("adopts an empty folder as a brand-new space", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const folder = join(config.dataDir, "Documents", "我的项目");
    await mkdir(folder, { recursive: true });

    const adopted = await app.inject({
      method: "POST",
      url: "/v1/workspaces/adopt",
      headers,
      payload: { dir: folder },
    });
    expect(adopted.statusCode).toBe(201);
    const space = adopted.json<AgentWorkspace>();
    expect(space.path).toBe(folder);
    expect(space.rootMode).toBe("external");
    expect(existsSync(join(folder, ".everoffice", "space.json"))).toBe(true);
    expect(existsSync(join(folder, ".tmp"))).toBe(true);

    await app.close();
  });
});
