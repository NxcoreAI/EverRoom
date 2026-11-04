import { lstat } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { loadBuiltinAgentBundle } from "../src/modules/agent/builtin-bundles.js";
import { BUILTIN_AGENT_IDS } from "../src/modules/agent/resolver.js";
import { skillRoutes } from "../src/modules/skills/routes.js";
import { SkillNotFoundError, SkillService } from "../src/modules/skills/service.js";
import { AgentSkillStateStore } from "../src/modules/skills/state-store.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { SkillInputError, UserSkillStore } from "../src/modules/skills/user-skills.js";
import type { LoadedSubagentDefinition } from "../src/modules/subagents/types.js";

const temporaryDirectories: string[] = [];
const openApps: FastifyInstance[] = [];

/** 仓库里随应用发布的 Agents 目录（内置 bundle + 子 Agent 清单都在这）。 */
const AGENTS_DIR = resolve(join(process.cwd(), "..", "..", "agents"));
const logger = { info: () => undefined, warn: () => undefined };

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHarness(options: { subagents?: () => readonly LoadedSubagentDefinition[] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-skills-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const store = new AgentSkillStateStore(database.db);
  const userSkills = new UserSkillStore(join(dataDir, "agent", "skills"));
  const service = new SkillService({
    store,
    definitionsDir: AGENTS_DIR,
    userSkills,
    ...(options.subagents ? { subagents: options.subagents } : {}),
    logger,
  });
  return { dataDir, database, store, service, userSkills };
}

/** 子 Agent 清单来自注册表（Revision 里带着技能文件副本）。 */
async function loadSubagents(dataDir: string): Promise<LoadedSubagentDefinition[]> {
  const database = createDatabase(join(dataDir, "subagents.sqlite"), resolve("drizzle"));
  const registry = new SubagentRegistry(database.db, {
    enabled: true,
    definitionsDir: AGENTS_DIR,
    runtimeDir: join(dataDir, "runtime"),
    defaultTimeoutMs: 30_000,
    maxConcurrent: 4,
  }, {}, logger);
  await registry.initialize();
  return registry.listAvailable();
}

describe("技能目录", () => {
  it("列出内置 Agent 的 SKILL.md（名字/描述/正文都来自文件本身）", async () => {
    const { service } = await createHarness();
    const skills = service.list();
    const exportSkill = skills.find((skill) => skill.id === "builtin:main:document-export");
    expect(exportSkill).toBeTruthy();
    expect(exportSkill!.ownerId).toBe("main");
    expect(exportSkill!.ownerKind).toBe("builtin");
    expect(exportSkill!.enabled).toBe(true);
    expect(exportSkill!.description).toContain("export");
    expect(exportSkill!.bytes).toBeGreaterThan(0);

    const detail = service.get("builtin:main:document-export");
    expect(detail?.prompt).toContain("Document Export");
    expect(detail?.prompt.startsWith("---")).toBe(true);
  });

  it("子 Agent 的技能进同一份清单（含 Revision 里的描述）", async () => {
    const { dataDir, service } = await createHarness();
    const subagents = await loadSubagents(dataDir);
    const withSubagents = new SkillService({
      store: new AgentSkillStateStore(createDatabase(join(dataDir, "second.sqlite"), resolve("drizzle")).db),
      definitionsDir: AGENTS_DIR,
      subagents: () => subagents,
      logger,
    });
    const skill = withSubagents.list().find((entry) => entry.id === "subagent:doc-writer:rewrite");
    expect(skill).toBeTruthy();
    expect(skill!.ownerName).toBe("Document Writer");
    expect(skill!.description).toContain("selectedText");
    expect(withSubagents.get("subagent:doc-writer:rewrite")?.prompt).toContain("# Rewrite");
    expect(service.list().some((entry) => entry.ownerKind === "subagent")).toBe(false);
  });

  it("不认识 id 时抛 SkillNotFoundError", async () => {
    const { service } = await createHarness();
    expect(() => service.setEnabled("builtin:main:not-a-skill", false)).toThrow(SkillNotFoundError);
  });
});

describe("启停", () => {
  it("关掉的技能落库，并在重建服务后仍然关着", async () => {
    const { database, service } = await createHarness();
    const updated = service.setEnabled("builtin:main:document-export", false);
    expect(updated.enabled).toBe(false);
    expect(updated.updatedAt).not.toBeNull();

    const reloaded = new SkillService({
      store: new AgentSkillStateStore(database.db),
      definitionsDir: AGENTS_DIR,
      logger,
    });
    expect(reloaded.get("builtin:main:document-export")?.enabled).toBe(false);
  });

  it("内置 Agent 的 skillPrompts 按状态过滤（运行时装的就是这份）", async () => {
    const { service } = await createHarness();
    const bundle = loadBuiltinAgentBundle(AGENTS_DIR, BUILTIN_AGENT_IDS.primary);
    expect(Object.keys(service.builtinSkillPrompts(bundle))).toEqual(["document-export"]);

    service.setEnabled("builtin:main:document-export", false);
    expect(service.builtinSkillPrompts(bundle)).toEqual({});
  });

  it("子 Agent 的技能路径按状态过滤（保序）", async () => {
    const { dataDir } = await createHarness();
    const subagents = await loadSubagents(dataDir);
    const service = new SkillService({
      store: new AgentSkillStateStore(createDatabase(join(dataDir, "gated.sqlite"), resolve("drizzle")).db),
      definitionsDir: AGENTS_DIR,
      subagents: () => subagents,
      logger,
    });
    const paths = ["./skills/draft-create", "./skills/rewrite"];
    expect(service.subagentSkillPaths("doc-writer", paths)).toEqual(paths);

    service.setEnabled("subagent:doc-writer:rewrite", false);
    expect(service.subagentSkillPaths("doc-writer", paths)).toEqual(["./skills/draft-create"]);
    // 同一技能换一个 owner 不受影响。
    expect(service.subagentSkillPaths("content-analyst", paths)).toEqual(paths);
  });
});

describe("技能路由", () => {
  async function createApp(service: SkillService) {
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    openApps.push(app);
    const reloads: Array<{ skillId: string; enabled: boolean }> = [];
    const catalogChanges: Array<{ action: string; skillId: string }> = [];
    await app.register(skillRoutes(service, {
      onStateChanged: async (skillId, enabled) => { reloads.push({ skillId, enabled }); },
      onCatalogChanged: async (action, skillId) => { catalogChanges.push({ action, skillId }); },
    }));
    return { app, reloads, catalogChanges };
  }

  it("GET /v1/skills 返回清单与计数", async () => {
    const { service } = await createHarness();
    const { app } = await createApp(service);
    const response = await app.inject({ method: "GET", url: "/v1/skills" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { skills: Array<{ id: string }>; counts: { total: number; enabled: number } };
    expect(body.skills.length).toBe(body.counts.total);
    expect(body.counts.enabled).toBe(body.counts.total);
    expect(body.skills.some((skill) => skill.id === "builtin:main:document-export")).toBe(true);
  });

  it("PATCH 改状态：落库 + 触发运行时重装；未知技能 404", async () => {
    const { service } = await createHarness();
    const { app, reloads } = await createApp(service);
    const id = encodeURIComponent("builtin:main:document-export");

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/skills/${id}`,
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { enabled: boolean }).enabled).toBe(false);
    expect(reloads).toEqual([{ skillId: "builtin:main:document-export", enabled: false }]);

    const missing = await app.inject({
      method: "PATCH",
      url: `/v1/skills/${encodeURIComponent("builtin:main:nope")}`,
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);

    const detail = await app.inject({ method: "GET", url: `/v1/skills/${id}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { prompt: string }).prompt).toContain("document_export");
  });
});

describe("用户技能（新增 / 导入 / 删除）", () => {
  it("手写技能落盘成 SKILL.md，并注入用户档 Agent 的系统提示词", async () => {
    const { service, dataDir } = await createHarness();
    const created = service.createUserSkill({
      name: "weekly-report",
      description: "把本周邮件与会议汇总成周报",
      body: "# 周报\n\n先列结论，再列风险。",
    });

    expect(created.id).toBe("user:local:weekly-report");
    expect(created.ownerKind).toBe("user");
    expect(created.ownerName).toBe("自定义技能");
    expect(created.enabled).toBe(true);
    expect(created.path).toBe("agent/skills/weekly-report");

    const onDisk = await readFile(
      join(dataDir, "agent", "skills", "weekly-report", "SKILL.md"),
      "utf8",
    );
    expect(onDisk).toContain("name: weekly-report");
    expect(onDisk).toContain("description: 把本周邮件与会议汇总成周报");
    expect(onDisk).toContain("# 周报");

    const primary = loadBuiltinAgentBundle(AGENTS_DIR, BUILTIN_AGENT_IDS.primary);
    expect(service.builtinSkillPrompts(primary)["weekly-report"]).toContain("# 周报");
    // 内部专用 Agent（补全）不吃用户技能：它们有自己的输出契约。
    const completion = loadBuiltinAgentBundle(AGENTS_DIR, BUILTIN_AGENT_IDS.cursorCompletion);
    expect(service.builtinSkillPrompts(completion)["weekly-report"]).toBeUndefined();
  });

  it("停用的用户技能不进系统提示词，重新启用后回来", async () => {
    const { service } = await createHarness();
    const created = service.createUserSkill({ name: "weekly-report", description: "周报", body: "# 周报" });
    const primary = loadBuiltinAgentBundle(AGENTS_DIR, BUILTIN_AGENT_IDS.primary);

    service.setEnabled(created.id, false);
    expect(service.builtinSkillPrompts(primary)["weekly-report"]).toBeUndefined();
    service.setEnabled(created.id, true);
    expect(service.builtinSkillPrompts(primary)["weekly-report"]).toContain("# 周报");
  });

  it("非法名称与重名都被拒", async () => {
    const { service } = await createHarness();
    service.createUserSkill({ name: "weekly-report", description: "周报", body: "# 周报" });

    expect(() => service.createUserSkill({ name: "../escape", description: "x", body: "x" }))
      .toThrow(SkillInputError);
    expect(() => service.createUserSkill({ name: "a/b", description: "x", body: "x" }))
      .toThrow(SkillInputError);
    expect(() => service.createUserSkill({ name: ".hidden", description: "x", body: "x" }))
      .toThrow(SkillInputError);
    expect(() => service.createUserSkill({ name: "weekly-report", description: "再写一个", body: "x" }))
      .toThrow(/skill_name_taken/);
  });

  it("从文件夹导入：带上附属文件，目录名取 frontmatter name", async () => {
    const { dataDir, service } = await createHarness();
    const source = join(dataDir, "inbox", "my-skill");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: imported-skill\ndescription: 导入进来的技能\n---\n\n# Imported\n",
      "utf8",
    );
    await writeFile(join(source, "references", "notes.md"), "# notes\n", "utf8");

    const imported = service.importUserSkill(source);
    expect(imported.id).toBe("user:local:imported-skill");
    expect(imported.name).toBe("imported-skill");
    expect(imported.description).toBe("导入进来的技能");
    await expect(readFile(
      join(dataDir, "agent", "skills", "imported-skill", "references", "notes.md"),
      "utf8",
    )).resolves.toContain("# notes");
  });

  it("导入缺 SKILL.md 的目录被拒", async () => {
    const { dataDir, service } = await createHarness();
    const source = join(dataDir, "inbox", "not-a-skill");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# 不是技能\n", "utf8");
    expect(() => service.importUserSkill(source)).toThrow(/skill_source_missing_manifest/);
  });

  it("删除用户技能：目录与启停记录一起清掉", async () => {
    const { dataDir, service, store } = await createHarness();
    const created = service.createUserSkill({ name: "weekly-report", description: "周报", body: "# 周报" });
    const onDisk = join(dataDir, "agent", "skills", "weekly-report");

    service.setEnabled(created.id, false);
    expect(store.get(created.id).enabled).toBe(false);

    service.removeSkill(created.id);
    expect(service.list().some((skill) => skill.id === created.id)).toBe(false);
    expect(store.get(created.id)).toEqual({ enabled: true, updatedAt: null });
    await expect(lstat(join(onDisk, "SKILL.md"))).rejects.toThrow();
  });

  it("内置/子 Agent 技能删不掉，未知技能报不存在", async () => {
    const { service } = await createHarness();
    expect(() => service.removeSkill("builtin:main:document-export")).toThrow(/skill_not_removable/);
    expect(() => service.removeSkill("user:local:nope")).toThrow(SkillNotFoundError);
  });
});

describe("用户技能路由", () => {
  it("POST 建技能 → 200 并触发目录重装；重名 409", async () => {
    const { service } = await createHarness();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    openApps.push(app);
    const changes: Array<{ action: string; skillId: string }> = [];
    await app.register(skillRoutes(service, {
      onStateChanged: async () => undefined,
      onCatalogChanged: async (action, skillId) => { changes.push({ action, skillId }); },
    }));

    const created = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "weekly-report", description: "周报", body: "# 周报" },
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { id: string }).id).toBe("user:local:weekly-report");
    expect(changes).toEqual([{ action: "created", skillId: "user:local:weekly-report" }]);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "weekly-report", description: "再来一个", body: "# 周报" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error: string }).error).toBe("skill_name_taken");
  });

  it("POST /v1/skills/import 复制目录；DELETE 删用户技能，删内置技能 409", async () => {
    const { dataDir, service } = await createHarness();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    openApps.push(app);
    await app.register(skillRoutes(service, {
      onStateChanged: async () => undefined,
      onCatalogChanged: async () => undefined,
    }));

    const source = join(dataDir, "inbox", "imported");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: imported\ndescription: 导入\n---\n\n# x\n", "utf8");
    const imported = await app.inject({
      method: "POST",
      url: "/v1/skills/import",
      payload: { sourceDirectory: source },
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json() as { id: string }).id).toBe("user:local:imported");

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/skills/${encodeURIComponent("user:local:imported")}`,
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { removed: boolean }).removed).toBe(true);

    const builtin = await app.inject({
      method: "DELETE",
      url: `/v1/skills/${encodeURIComponent("builtin:main:document-export")}`,
    });
    expect(builtin.statusCode).toBe(409);
    expect((builtin.json() as { error: string }).error).toBe("skill_not_removable");

    const missing = await app.inject({
      method: "DELETE",
      url: `/v1/skills/${encodeURIComponent("user:local:nope")}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
