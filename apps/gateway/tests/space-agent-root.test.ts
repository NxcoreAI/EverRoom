import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import { SpaceAgentRoots } from "../src/modules/workspace-layout/agent-root.js";
import { WorkspaceLayoutService } from "../src/modules/workspace-layout/service.js";

/**
 * Agent 工作目录（P2）验收：
 * - 绑了目录的空间 → 返回空间根，作为 pi 会话 cwd / 沙箱根 / AGENTS.md 来源；
 * - 未绑目录 / 目录被删 / 标记坏了 → 返回 null，调用方回落 agent 默认工作目录；
 * - 换绑后缓存主动失效能立刻看到新目录。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function rootsForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-space-agent-root-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const layout = new WorkspaceLayoutService({ dataDir });
  const roots = new SpaceAgentRoots(database.db, layout);
  return { dataDir, db: database.db, layout, roots };
}

function insertSpace(
  db: Awaited<ReturnType<typeof rootsForTest>>["db"],
  input: { id: string; name: string; path: string | null; slug?: string | null },
) {
  db.insert(agentWorkspaces).values({
    id: input.id,
    name: input.name,
    description: null,
    goals: [],
    path: input.path,
    ...(input.slug ? { slug: input.slug } : {}),
    rootMode: "managed",
    layoutVersion: 2,
    kind: "custom",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastOpenedAt: new Date(),
  }).run();
}

describe("project space agent root (P2)", () => {
  it("returns the space root for a bound, healthy space directory", async () => {
    const test = await rootsForTest();
    const provisioned = test.layout.provision({ spaceId: "ws-bound", name: "Bound space" });
    insertSpace(test.db, {
      id: "ws-bound",
      name: "Bound space",
      path: provisioned.paths.root,
      slug: provisioned.marker.slug,
    });

    expect(test.roots.resolve("ws-bound")).toBe(provisioned.paths.root);
    // 标记被删就当场失效（不缓存）：宁可回落默认目录，也不让会话拿着不可信的根。
    await rm(join(provisioned.paths.root, ".everoffice", "space.json"), { force: true });
    expect(test.roots.resolve("ws-bound")).toBeNull();
  });

  it("returns null for unbound, missing and marker-less directories", async () => {
    const test = await rootsForTest();
    insertSpace(test.db, { id: "ws-unbound", name: "No dir", path: null });

    // 有目录但没有 `.everoffice/space.json`：不是项目空间，不能当工作根。
    const plain = join(test.dataDir, "plain-dir");
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, "notes.md"), "not a space");
    insertSpace(test.db, { id: "ws-plain", name: "Plain dir", path: plain });

    // 登记过但目录已被外部删掉：只回落，不重建。
    insertSpace(test.db, { id: "ws-gone", name: "Gone", path: join(test.dataDir, "deleted-space") });

    expect(test.roots.resolve("ws-unbound")).toBeNull();
    expect(test.roots.resolve("ws-plain")).toBeNull();
    expect(test.roots.resolve("ws-gone")).toBeNull();
    expect(test.roots.resolve(null)).toBeNull();
    expect(test.roots.resolve("  ")).toBeNull();
  });

  it("follows a relocated space after invalidation", async () => {
    const test = await rootsForTest();
    const first = test.layout.provision({ spaceId: "ws-move", name: "Movable" });
    insertSpace(test.db, {
      id: "ws-move",
      name: "Movable",
      path: first.paths.root,
      slug: first.marker.slug,
    });
    expect(test.roots.resolve("ws-move")).toBe(first.paths.root);

    const second = test.layout.provision({ spaceId: "ws-move", name: "Movable elsewhere" });
    test.db.update(agentWorkspaces).set({ path: second.paths.root })
      .where(eq(agentWorkspaces.id, "ws-move")).run();
    // 换绑后下一轮 run 立刻用新根（无缓存窗口）。
    expect(test.roots.resolve("ws-move")).toBe(second.paths.root);
  });
});
