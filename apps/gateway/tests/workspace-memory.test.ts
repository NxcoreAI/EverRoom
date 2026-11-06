import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import { MemoryService } from "../src/modules/memory/service.js";
import { SpaceMemoryRoots } from "../src/modules/workspace-layout/memory-root.js";
import { WorkspaceLayoutService } from "../src/modules/workspace-layout/service.js";

/**
 * 记忆落点（P2）验收：
 * - 绑了目录的工作区，记忆写进 `<space>/.everoffice/memory`，与全局库隔离；
 * - 未绑目录 / 不存在的空间仍用全局库（旧行为不变）；
 * - 全局列表（画像）能合并到空间库里的条目。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function memoryForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-memory-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const layout = new WorkspaceLayoutService({ dataDir });
  const roots = new SpaceMemoryRoots(database.db, layout);

  const spaceId = "ws-memory";
  const provisioned = layout.provision({ spaceId, name: "Memory test" });
  database.db.insert(agentWorkspaces).values({
    id: spaceId,
    name: "Memory test",
    description: null,
    goals: [],
    path: provisioned.paths.root,
    slug: provisioned.marker.slug,
    rootMode: "managed",
    layoutVersion: 2,
    kind: "custom",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastOpenedAt: new Date(),
  }).run();

  const memory = new MemoryService({
    root: join(dataDir, "memory", "hippo"),
    spaceRootFor: roots.resolve,
    enabled: true,
  });
  memory.start();
  return { memory, roots, dataDir, spaceId, root: provisioned.paths.root };
}

describe("project space memory (P2)", () => {
  it("stores a bound space's memories inside <space>/.everoffice/memory", async () => {
    const test = await memoryForTest();
    const id = test.memory.remember({
      content: "飞书项目的周报每周五发",
      workspaceId: test.spaceId,
    });
    expect(id).toBeTruthy();

    const memoryRoot = join(test.root, ".everoffice", "memory");
    expect(existsSync(memoryRoot)).toBe(true);
    const storeFiles = await readdir(memoryRoot, { recursive: true }).catch(() => [] as string[]);
    expect(storeFiles.length).toBeGreaterThan(0);

    const hits = test.memory.recall({ query: "飞书 周报", workspaceId: test.spaceId });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("周报");

    // 别的空间看不到这条记忆。
    expect(test.memory.recall({ query: "飞书 周报", workspaceId: "ws-other" })).toEqual([]);
    test.memory.stop();
  });

  it("keeps unbound workspaces on the global store", async () => {
    const test = await memoryForTest();
    test.memory.remember({ content: "全局记忆：公司统一用中文写周报", workspaceId: "ws-unbound" });
    expect(existsSync(join(test.dataDir, "memory", "hippo"))).toBe(true);
    const hits = test.memory.recall({ query: "中文 周报", workspaceId: "ws-unbound" });
    expect(hits.length).toBeGreaterThan(0);
    test.memory.stop();
  });

  it("merges space memories into the global listing for profile aggregation", async () => {
    const test = await memoryForTest();
    test.memory.remember({ content: "飞书项目：每周五同步", workspaceId: test.spaceId });
    test.memory.remember({ content: "全局：写作风格偏简洁" });
    const listed = test.memory.list({ limit: 50 });
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.some((hit) => hit.content.includes("每周五"))).toBe(true);
    expect(listed.some((hit) => hit.content.includes("写作风格"))).toBe(true);
    expect(test.memory.stats().total).toBeGreaterThanOrEqual(2);
    test.memory.stop();
  });

  it("caches the space root resolution and can be invalidated", async () => {
    const test = await memoryForTest();
    expect(test.roots.resolve(test.spaceId)).toBe(join(test.root, ".everoffice", "memory"));
    expect(test.roots.resolve("ws-unbound")).toBeNull();
    test.roots.invalidate(test.spaceId);
    expect(test.roots.resolve(test.spaceId)).toBe(join(test.root, ".everoffice", "memory"));
  });
});
