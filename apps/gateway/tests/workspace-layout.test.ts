import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpaceCandidate, AgentSpaceLayout, AgentWorkspace } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

/**
 * 项目空间目录化（P0 + v2 布局）验收：
 * - 新建空间不传 path 也会落 `<dataDir>/Workspace/<slug>`，根上只有两个隐藏目录
 *   （`.everoffice/` 元数据、`.tmp/` 过程缓存），资料库根＝空间根；
 * - 标记可被解析回 spaceId/name/layout，内部角色目录齐全；
 * - default 空间绑到 `Workspace/inbox`；
 * - v1 布局（`Library/` + 根上标记）在接管/修复时就地迁到 v2，资料不搬丢；
 * - 修复/发现/冲突按方案 §4.3、§8.2、§16 收敛。
 *
 * 方案：docs/project-space-layout-plan.zh-CN.md
 */

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-layout-test-"));
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface MarkerOnDisk {
  $everoffice: number;
  kind: string;
  spaceId: string;
  name: string;
  slug: string;
  layoutVersion: number;
  rootMode: string;
  layout: {
    library: string;
    meta: string;
    memory: string;
    conversation: string;
    trash: string;
    objects: string;
    derived: string;
    tmp: string;
  };
  integrity?: string;
}

/** v2 标记：`<root>/.everoffice/space.json`。 */
async function readMarker(root: string): Promise<MarkerOnDisk> {
  return JSON.parse(
    await readFile(join(root, ".everoffice", "space.json"), "utf8"),
  ) as MarkerOnDisk;
}

/** 空白空间里应当存在的目录（相对空间根）。 */
const EXPECTED_DIRECTORIES = [
  ".everoffice",
  ".everoffice/memory",
  ".everoffice/conversation",
  ".everoffice/trash",
  ".everoffice/objects",
  ".everoffice/cache",
  ".everoffice/cache/derived",
  ".tmp",
];

/** 目录树里所有空间标记（v2 `space.json` 与遗留 `*.everoffice`）。 */
async function markerFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative);
      } else if (entry.name === "space.json" || entry.name.endsWith(".everoffice")) {
        found.push(relative);
      }
    }
  };
  await walk(root, "");
  return found.sort();
}

/** 写一份 v1 空间（老版本建出来的目录），用于迁移测试。 */
async function writeLegacySpaceV1(root: string): Promise<{ spaceId: string }> {
  const spaceId = "3f6a1b9e-6c1d-4a2f-9d6e-7b6a5c4e3d2a";
  await mkdir(join(root, "Library", "inbox"), { recursive: true });
  await mkdir(join(root, "Library", ".cache", "objects"), { recursive: true });
  await mkdir(join(root, "Library", ".cache", "tmp"), { recursive: true });
  await mkdir(join(root, "Memory"), { recursive: true });
  await mkdir(join(root, "Conversation"), { recursive: true });
  await mkdir(join(root, ".trash", "20260101", "bucket"), { recursive: true });
  await writeFile(join(root, "Library", "inbox", "季度汇报.md"), "# 旧资料", "utf8");
  await writeFile(join(root, "Library", ".cache", "objects", "abc123"), "blob", "utf8");
  await writeFile(join(root, "Memory", "notes.md"), "# 旧记忆", "utf8");
  await writeFile(join(root, ".trash", "20260101", "bucket", "old.md"), "# 已删", "utf8");
  await writeFile(join(root, "space.everoffice"), `${JSON.stringify({
    $everoffice: 1,
    kind: "space",
    spaceId,
    name: "Legacy space",
    slug: "legacy-space",
    layoutVersion: 1,
    rootMode: "external",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: { app: "EverOffice", version: "0.0.1", platform: "darwin" },
    layout: {
      library: "Library",
      memory: "Memory",
      conversation: "Conversation",
      trash: ".trash",
      cache: "Library/.cache",
      cacheParts: { tmp: "tmp", derived: "derived", objects: "objects" },
    },
    roles: {
      library: { writable: true, retention: "keep" },
      memory: { writable: true, retention: "keep" },
      cache: { writable: true, retention: "ephemeral", gc: {} },
      trash: { retention: "30d" },
    },
    flags: { conversationMirror: false, memoryLocal: false },
  }, null, 2)}\n`, "utf8");
  return { spaceId };
}

describe("project space layout (P0/v2)", () => {
  it("creates the space directory under <dataDir>/Workspace with a single hidden meta dir", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Feishu work" },
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json<AgentWorkspace>();

    expect(workspace.slug).toBe("feishu-work");
    expect(workspace.rootMode).toBe("managed");
    expect(workspace.layoutVersion).toBe(2);
    expect(workspace.path).toBe(join(config.dataDir, "Workspace", "feishu-work"));

    const root = workspace.path as string;
    const marker = await readMarker(root);
    expect(marker).toMatchObject({
      $everoffice: 2,
      kind: "space",
      spaceId: workspace.id,
      name: "Feishu work",
      slug: "feishu-work",
      layoutVersion: 2,
      rootMode: "managed",
      // 根即资料库：library 是空串，其余角色都在 `.everoffice/` 或 `.tmp/` 下。
      layout: {
        library: "",
        meta: ".everoffice",
        memory: ".everoffice/memory",
        conversation: ".everoffice/conversation",
        trash: ".everoffice/trash",
        objects: ".everoffice/objects",
        derived: ".everoffice/cache/derived",
        tmp: ".tmp",
      },
    });
    expect(marker.integrity).toMatch(/^sha256:[0-9a-f]{64}$/u);

    for (const relative of EXPECTED_DIRECTORIES) {
      expect((await stat(join(root, relative))).isDirectory()).toBe(true);
    }

    // 单标记：整棵空间内只有一个标记，且在 `.everoffice/` 里。
    expect(await markerFiles(root)).toEqual([".everoffice/space.json"]);

    // 空间根上只有两个隐藏目录——用户放资料不会和应用的任何文件冲突。
    expect((await readdir(root)).sort()).toEqual([".everoffice", ".tmp"]);

    await app.close();
  });

  it("falls back to a hash slug for non-ASCII names and de-duplicates on collision", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const first = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "飞书相关工作" },
    })).json<AgentWorkspace>();
    expect(first.slug).toMatch(/^space-[0-9a-f]{6}$/u);
    expect(first.path).toBe(join(config.dataDir, "Workspace", first.slug as string));

    const second = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "飞书相关工作" },
    })).json<AgentWorkspace>();
    // 同名空间：第二个拿到 -2 后缀，绝不覆盖前一个目录。
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(second.path).not.toBe(first.path);

    await app.close();
  });

  it("binds the default workspace to Workspace/inbox", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const listed = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    const fallback = listed.find((item) => item.id === "default");
    expect(fallback).toMatchObject({
      path: join(config.dataDir, "Workspace", "inbox"),
      slug: "inbox",
      rootMode: "managed",
      layoutVersion: 2,
    });
    expect(existsSync(join(config.dataDir, "Workspace", "inbox", ".everoffice", "space.json"))).toBe(true);

    await app.close();
  });

  it("reports layout health and repairs deleted directories", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Layout repair" },
    })).json<AgentWorkspace>();
    const root = workspace.path as string;

    const healthy = (await app.inject({
      method: "GET",
      url: `/v1/agent/workspaces/${workspace.id}/layout`,
      headers,
    })).json<AgentSpaceLayout>();
    expect(healthy.health).toMatchObject({ exists: true, markerPresent: true, missingDirectories: [] });
    expect(healthy.paths).toMatchObject({
      root,
      // v2：资料库根＝空间根，元数据收进 `.everoffice/`，过程缓存单独放 `.tmp/`。
      library: root,
      meta: join(root, ".everoffice"),
      memory: join(root, ".everoffice", "memory"),
      cache: join(root, ".everoffice", "cache"),
      tmp: join(root, ".tmp"),
    });

    // 用户把记忆目录删了：健康检查要报出来，repair 要补回来。
    const memoryDir = join(root, ".everoffice", "memory");
    await rm(memoryDir, { recursive: true, force: true });
    const broken = (await app.inject({
      method: "GET",
      url: `/v1/agent/workspaces/${workspace.id}/layout`,
      headers,
    })).json<AgentSpaceLayout>();
    expect(broken.health.missingDirectories).toEqual([".everoffice/memory"]);

    const repaired = await app.inject({
      method: "POST",
      url: `/v1/agent/workspaces/${workspace.id}/layout/repair`,
      headers,
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json<{ createdDirectories: string[] }>().createdDirectories).toEqual([".everoffice/memory"]);
    expect(existsSync(memoryDir)).toBe(true);

    await app.close();
  });

  it("detects an existing directory and refuses to reuse another space's marker", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Detect me" },
    })).json<AgentWorkspace>();
    const root = workspace.path as string;

    const detected = await app.inject({
      method: "POST",
      url: "/v1/workspaces/detect",
      headers,
      payload: { dir: root },
    });
    expect(detected.statusCode).toBe(200);
    expect(detected.json()).toMatchObject({
      status: "space",
      root,
      spaceId: workspace.id,
      slug: "detect-me",
      layoutVersion: 2,
    });

    const empty = await mkdtemp(join(config.dataDir, "empty-"));
    const notSpace = await app.inject({
      method: "POST",
      url: "/v1/workspaces/detect",
      headers,
      payload: { dir: empty },
    });
    expect(notSpace.json()).toEqual({ status: "missing" });

    // 同一个目录不能再挂第二个空间（目录冲突统一 409，与 /v1/workspaces/adopt 同口径）。
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Copy cat", path: root },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: string }>().error).toBe("space_marker_conflict");

    await app.close();
  });

  it("previews the default root and discovers unregistered spaces", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const preview = (await app.inject({
      method: "GET",
      url: "/v1/workspaces/default-root?name=Feishu%20work",
      headers,
    })).json<{ root: string; slug: string; exists: boolean }>();
    expect(preview).toMatchObject({ slug: "feishu-work", exists: false });
    expect(preview.root).toBe(join(config.dataDir, "Workspace", "feishu-work"));

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Feishu work" },
    })).json<AgentWorkspace>();

    // 用户把空间目录复制一份（同一 spaceId，未注册）：discover 要能列出来。
    await cp(workspace.path as string, join(config.dataDir, "Workspace", "feishu-work-copy"), {
      recursive: true,
    });
    const candidates = (await app.inject({ method: "GET", url: "/v1/workspaces/discover", headers }))
      .json<AgentSpaceCandidate[]>();
    const registered = candidates.find((item) => item.root === workspace.path);
    const orphan = candidates.find((item) => item.root.endsWith("feishu-work-copy"));
    expect(registered).toMatchObject({ registered: true, workspaceId: workspace.id });
    expect(orphan).toMatchObject({ registered: false, workspaceId: null });

    await app.close();
  });

  it("serves the .tmp listing over HTTP without touching the library index", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "Scratch listing" },
    })).json<AgentWorkspace>();
    const root = workspace.path as string;

    // Agent 写了一批过程文件（不经过任何导入管线）。
    await mkdir(join(root, ".tmp", "thesis", "run-1"), { recursive: true });
    await writeFile(join(root, ".tmp", "thesis", "run-1", "transcript.txt"), "hello", "utf8");
    await writeFile(join(root, ".tmp", "screenshot.jpg"), Buffer.alloc(10));

    const listed = await app.inject({
      method: "GET",
      url: `/v1/agent/workspaces/${workspace.id}/cache/scratch`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{
      bound: boolean;
      present: boolean;
      entries: Array<{ path: string; size: number; modifiedAt: string }>;
      fileCount: number;
      totalBytes: number;
      truncated: boolean;
    }>();
    expect(body).toMatchObject({ bound: true, present: true, fileCount: 2, truncated: false });
    expect(body.totalBytes).toBe(15);
    expect(body.entries.map((entry) => entry.path).sort()).toEqual([
      "screenshot.jpg",
      "thesis/run-1/transcript.txt",
    ]);

    // 只读：资料库里一条索引都没多出来。
    const catalog = (await app.inject({
      method: "GET",
      url: `/v1/files?workspaceId=${workspace.id}`,
      headers,
    })).json<{ items: unknown[] }>();
    expect(catalog.items).toHaveLength(0);

    await app.close();
  });

  it("migrates a v1 space (Library/) to v2 (root is the library) on adopt", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const root = join(config.dataDir, "legacy-space");
    await mkdir(root, { recursive: true });
    const { spaceId } = await writeLegacySpaceV1(root);

    const adopted = await app.inject({
      method: "POST",
      url: "/v1/workspaces/adopt",
      headers,
      payload: { dir: root },
    });
    expect(adopted.statusCode).toBe(201);

    const workspace = adopted.json<AgentWorkspace>();
    expect(workspace.id).toBe(spaceId);
    expect(workspace.layoutVersion).toBe(2);

    // 标记搬到元数据目录里，且已经是 v2 契约。
    const marker = await readMarker(root);
    expect(marker.$everoffice).toBe(2);
    expect(marker.layoutVersion).toBe(2);
    expect(marker.layout.library).toBe("");
    expect(existsSync(join(root, "space.everoffice"))).toBe(false);

    // `Library/` 的 children 原样上移到根：v1 的 `inbox/季度汇报.md` →
    // `<root>/inbox/季度汇报.md`，DB 里的 relative_path 不用改；旧 `Library/` 消失。
    expect(existsSync(join(root, "inbox", "季度汇报.md"))).toBe(true);
    expect(existsSync(join(root, "Library"))).toBe(false);
    // 记忆/回收站/对象快照搬进 `.everoffice/`，过程缓存换到 `.tmp/`。
    expect(await readFile(join(root, ".everoffice", "memory", "notes.md"), "utf8")).toBe("# 旧记忆");
    expect(existsSync(join(root, ".everoffice", "objects", "abc123"))).toBe(true);
    expect(existsSync(join(root, ".everoffice", "trash", "20260101", "bucket", "old.md"))).toBe(true);
    expect((await stat(join(root, ".tmp"))).isDirectory()).toBe(true);
    expect(await markerFiles(root)).toEqual([".everoffice/space.json"]);

    // 迁移后对账：文件在根上，DB 也能继续正常列出。
    const listed = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(listed.find((item) => item.id === spaceId)?.layoutVersion).toBe(2);

    await app.close();
  });
});
