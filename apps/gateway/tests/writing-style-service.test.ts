import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  documentVersions,
  documents,
  jobs,
  roomDocumentLinks,
  writingStyleSignals,
} from "../src/infrastructure/database/schema.js";
import {
  WritingStyleService,
  WRITING_STYLE_MIN_CHARS,
} from "../src/modules/writing-style/service.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

function paragraph(text: string): unknown {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function body(seed: string, sentences = 40): { contentJson: unknown; charCount: number } {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    parts.push(`${seed}${seed}模块的接口设计遵循渐进披露原则，先给出最小可用集合，再按需补充高级选项与回退说明。`);
  }
  const contentJson = { type: "doc", content: [paragraph(parts.join(""))] };
  return { contentJson, charCount: parts.join("").length };
}

async function setup(): Promise<{ database: DatabaseClient; service: WritingStyleService }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, service: new WritingStyleService(database.db) };
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.sqlite.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

interface SeedDocumentInput {
  id: string;
  roomId: string;
  seed: string;
  sentences?: number;
  agentCreated?: boolean;
  title?: string;
}

function seedDocument(database: DatabaseClient, input: SeedDocumentInput): { contentJson: unknown } {
  const { contentJson } = body(input.seed, input.sentences);
  const now = new Date();
  database.db.insert(documents).values({
    id: input.id,
    title: input.title ?? input.id,
    contentJson,
    contentSchemaVersion: 3,
    version: 1,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  database.db.insert(roomDocumentLinks).values({ roomId: input.roomId, documentId: input.id, linkedAt: now }).run();
  database.db.insert(documentVersions).values({
    id: `${input.id}-v1`,
    documentId: input.id,
    version: 1,
    title: input.title ?? input.id,
    contentJson,
    contentSchemaVersion: 3,
    sourceTransactionId: input.agentCreated ? `op-${input.id}` : null,
    createdAt: now,
  }).run();
  return { contentJson };
}

describe("WritingStyleService 设置与回填", () => {
  it("默认两开关关闭；更新后持久化并触发回填", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    expect(service.getSettings()).toEqual({ completionEnabled: false, generationEnabled: false, configVersion: 1 });

    const updated = service.updateSettings({ completionEnabled: true });
    expect(updated.completionEnabled).toBe(true);
    // 首次开启已在 updateSettings 内部触发回填：extract job 已入队。
    const { jobs: jobsTable } = await import("../src/infrastructure/database/schema.js");
    const pending = database.db.select({ id: jobsTable.id }).from(jobsTable)
      .where(eq(jobsTable.type, "writing-style.extract")).all();
    expect(pending).toHaveLength(1);
    // 已有 pending job 时再次显式回填为 no-op。
    expect(service.backfill().queuedDocuments).toBe(0);
  });

  it("无字段更新被拒绝", async () => {
    const { service } = await setup();
    expect(() => service.updateSettings({})).toThrow("writing_style_settings_invalid");
  });
});

describe("WritingStyleService 提取资格", () => {
  it("agent 创建的文档跳过并标记 origin", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "agent-doc", roomId: "room-1", seed: "风控", agentCreated: true });
    const result = service.extractDocument("agent-doc", "room-1", 1);
    expect(result).toEqual({ changed: false, outcome: "agent_origin_skipped" });
    const corpus = service.listCorpus();
    expect(corpus[0]?.origin).toBe("agent");
    expect(corpus[0]?.status).toBe("skipped");
  });

  it("过短文档跳过", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "short-doc", roomId: "room-1", seed: "短", sentences: 1 });
    const result = service.extractDocument("short-doc", "room-1", 1);
    expect(result.outcome).toBe("too_short");
  });

  it("合格文档提取成功，重复提取内容未变时幂等", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    const first = service.extractDocument("doc-1", "room-1", 1);
    expect(first).toEqual({ changed: true, outcome: "extracted" });
    const second = service.extractDocument("doc-1", "room-1", 1);
    expect(second).toEqual({ changed: false, outcome: "content_unchanged" });
  });

  it("版本倒挂的旧 job 不覆盖新 sketch", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 3);
    const stale = service.extractDocument("doc-1", "room-1", 2);
    expect(stale).toEqual({ changed: false, outcome: "stale_version" });
  });

  it("删除后的文档清理 sketch", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 1);
    expect(service.listCorpus()).toHaveLength(1);
    database.db.update(documents).set({ deletedAt: new Date() }).run();
    service.extractDocument("doc-1", "room-1", 1);
    expect(service.listCorpus()).toHaveLength(0);
  });
});

describe("WritingStyleService 聚合与刷新", () => {
  it("refresh 汇总 extracted 且未排除的 sketch 并写置信档位", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    seedDocument(database, { id: "doc-2", roomId: "room-1", seed: "风控" });
    seedDocument(database, { id: "agent-doc", roomId: "room-1", seed: "风控", agentCreated: true });
    service.extractDocument("doc-1", "room-1", 1);
    service.extractDocument("doc-2", "room-1", 1);
    service.extractDocument("agent-doc", "room-1", 1);

    const { sketchCount } = await service.refreshProfile();
    expect(sketchCount).toBe(2);
    const profile = service.getProfile();
    expect(profile.sampleDocumentCount).toBe(2);
    expect(profile.confidenceTier).toBe("sparse");
    expect(profile.sampleCharCount).toBeGreaterThanOrEqual(WRITING_STYLE_MIN_CHARS * 2);
    expect(profile.sections.vocabulary.join("")).toContain("风控");
  });

  it("排除文档后不再计入聚合", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    seedDocument(database, { id: "doc-2", roomId: "room-2", seed: "网关" });
    service.extractDocument("doc-1", "room-1", 1);
    service.extractDocument("doc-2", "room-2", 1);
    await service.refreshProfile();
    expect(service.getProfile().sampleDocumentCount).toBe(2);

    service.setExclusion("doc-1", true);
    await service.refreshProfile();
    expect(service.getProfile().sampleDocumentCount).toBe(1);
    expect(service.getProfile().sections.vocabulary.join("")).not.toContain("风控");
  });

  it("排除不存在的文档报 404 语义错误", async () => {
    const { service } = await setup();
    expect(() => service.setExclusion("missing", true)).toThrow("writing_style_not_found");
  });
});

describe("行为信号增长触发画像更新（§4.1/§10 缺口修复）", () => {
  async function prepared(): Promise<{ database: DatabaseClient; service: WritingStyleService }> {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    return { database, service };
  }

  function addSignal(database: DatabaseClient, id: string): void {
    database.db.insert(writingStyleSignals).values({
      id,
      type: "rewrite_instruction",
      documentId: null,
      roomId: null,
      instruction: "再短一点",
      category: "concise",
      createdAt: new Date(),
    }).run();
  }

  it("启动兜底：信号增长后未接管的画像文本重生成并吸收新信号", async () => {
    const { database, service } = await prepared();
    const before = service.getProfileText().content;
    expect(before).not.toContain("再短一点");

    addSignal(database, "rw:signal-late-1");
    service.ensureProfileTextInitialized();

    const after = service.getProfileText();
    expect(after.content).not.toBe(before);
    expect(after.content).toContain("再短一点");
    expect(after.userEdited).toBe(false);
    // 指纹已重新对齐：再跑一次兜底不再改写。
    const synced = after.content;
    service.ensureProfileTextInitialized();
    expect(service.getProfileText().content).toBe(synced);
  });

  it("启动兜底：接管后的画像文本永不被信号增长覆盖", async () => {
    const { database, service } = await prepared();
    service.replaceUserContent("我的自定义风格版本。");
    addSignal(database, "rw:signal-late-2");
    service.ensureProfileTextInitialized();
    expect(service.getProfileText().content).toBe("我的自定义风格版本。");
  });

  it("worker 兜底：指纹落后时入队 refresh（单例去重），指纹同步后不再入队", async () => {
    const { database, service } = await prepared();
    const pendingRefresh = () => database.db.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.type, "writing-style.refresh"), eq(jobs.status, "pending"))).all();

    addSignal(database, "rw:signal-late-3");
    service.autoRefreshOnSignalGrowth();
    expect(pendingRefresh().length).toBe(1);
    // 单例去重：重复触发不产生第二个 pending。
    service.autoRefreshOnSignalGrowth();
    expect(pendingRefresh().length).toBe(1);

    // worker 消费（服务侧重算 + job 落定）后指纹重新对齐，不再入队。
    await service.refreshProfile();
    database.db.update(jobs).set({ status: "completed", updatedAt: new Date() })
      .where(eq(jobs.type, "writing-style.refresh")).run();
    service.autoRefreshOnSignalGrowth();
    expect(pendingRefresh().length).toBe(0);
    expect(service.getProfileText().content).toContain("再短一点");
  });
});

describe("协作轮洞察（v2：横幅确认式沉淀）", () => {
  function seedSignals(database: DatabaseClient, ids: string[], at: Date): void {
    for (const id of ids) {
      database.db.insert(writingStyleSignals).values({
        id,
        type: id.startsWith("rev:") ? "revision_delta" : "rewrite_instruction",
        documentId: null,
        roomId: null,
        ...(id.startsWith("rev:") ? {} : { instruction: "写短一点，再简洁一些" }),
        category: id.startsWith("rev:") ? null : "concise",
        ...(id.startsWith("rev:") ? { before: "原文摘录", after: "改后摘录", deltaMeta: { lenBefore: 100, lenAfter: 60, exclamationDelta: 0 } } : {}),
        createdAt: at,
      }).run();
    }
  }

  it("未达安静窗口或信号不足时不蒸馏；安静后走偏好陈述回退", async () => {
    const { database, service } = await setup();
    const at = new Date(Date.now() - 10 * 60 * 1000);
    seedSignals(database, ["rw:a"], at);
    // 单条信号不蒸馏。
    expect(await service.maybeDistillInsight()).toBe(false);
    seedSignals(database, ["rw:b"], at);
    // 两条但最近信号仍在安静窗口内（now = 信号后 1 分钟）。
    expect(await service.maybeDistillInsight(new Date(at.getTime() + 60 * 1000))).toBe(false);
    // 安静收口后蒸馏（无 LLM → 偏好陈述回退，不罗列次数）。
    expect(await service.maybeDistillInsight()).toBe(true);
    const insight = service.listInsights()[0]!;
    expect(insight.status).toBe("pending");
    expect(insight.llmGenerated).toBe(false);
    expect(insight.preferences.join("\n")).toContain("精炼");
  });

  it("完整生命周期：蒸馏 → 横幅稍后（snoozed 可找回）→ 记忆页确认写入画像", async () => {
    const { database, service } = await setup();
    const quiet = new Date(Date.now() - 10 * 60 * 1000);
    seedSignals(database, ["rw:d", "rw:e", "rev:f1"], quiet);

    expect(await service.maybeDistillInsight()).toBe(true);
    let insights = service.listInsights();
    expect(insights).toHaveLength(1);
    expect(insights[0]!.status).toBe("pending");
    expect(insights[0]!.preferences.length).toBeGreaterThan(0);
    expect(insights[0]!.preferences.join("\n")).toContain("精炼");

    // 未决洞察存在时不重复蒸馏。
    seedSignals(database, ["rw:g"], quiet);
    expect(await service.maybeDistillInsight()).toBe(false);

    // 稍后：横幅关闭但记忆页可找回。
    const snoozed = service.snoozeInsight(insights[0]!.id);
    expect(snoozed.status).toBe("snoozed");
    expect(service.listInsights()[0]!.status).toBe("snoozed");

    // 确认：写入画像文本（未接管态 → 重生成，已确认洞察置于行为偏好区最前）。
    const confirmed = service.confirmInsight(insights[0]!.id);
    expect(confirmed.status).toBe("confirmed");
    const text = service.getProfileText();
    expect(text.userEdited).toBe(false);
    expect(text.content).toContain("精炼");
    expect(text.content.indexOf("精炼")).toBeLessThan(text.content.indexOf("样例指令") >= 0 ? text.content.indexOf("样例指令") : text.content.length);
  });

  it("接管态确认：偏好直接追加进用户文本，不解除接管", async () => {
    const { database, service } = await setup();
    seedSignals(database, ["rw:h", "rw:i"], new Date(Date.now() - 10 * 60 * 1000));
    await service.maybeDistillInsight();
    service.replaceUserContent("我的自定义风格。");
    const insight = service.listInsights()[0]!;
    service.confirmInsight(insight.id);
    const text = service.getProfileText();
    expect(text.userEdited).toBe(true);
    expect(text.content).toContain("我的自定义风格。");
    expect(text.content).not.toBe("我的自定义风格。");
  });
});

describe("旧指令表迁移（client.ts）", () => {
  it("user_directives 数据迁入画像文本（接管态）并 DROP 旧表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-legacy-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "gateway.sqlite");
    const first = createDatabase(path, resolve("drizzle"));
    first.sqlite.exec(`
      CREATE TABLE writing_style_user_directives (
        id text PRIMARY KEY, owner_id text NOT NULL, content text NOT NULL,
        enabled integer NOT NULL DEFAULT 1, sort_order integer NOT NULL DEFAULT 0,
        created_at integer NOT NULL, updated_at integer NOT NULL
      );
    `);
    const now = Date.now();
    const insert = first.sqlite.prepare(
      "INSERT INTO writing_style_user_directives (id, owner_id, content, enabled, sort_order, created_at, updated_at) VALUES (?, 'local-user', ?, ?, ?, ?, ?)",
    );
    insert.run("d-1", "少用感叹号", 1, 0, now, now);
    insert.run("d-2", "技术描述用主动语态", 1, 1, now, now);
    insert.run("d-3", "已停用的指令", 0, 2, now, now);
    first.sqlite.close();

    const reopened = createDatabase(path, resolve("drizzle"));
    databases.push(reopened);
    const leftover = reopened.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'writing_style_user_directives'",
    ).get();
    expect(leftover).toBeUndefined();
    const service = new WritingStyleService(reopened.db);
    const text = service.getProfileText();
    expect(text.content).toContain("少用感叹号");
    expect(text.content).toContain("技术描述用主动语态");
    expect(text.content).not.toContain("已停用的指令");
    expect(text.userEdited).toBe(true);
  });
});

describe("WritingStyleService 旧库补列修复", () => {
  it("user_content 缺 user_edited/generated_from_cursor 时重开自动补列", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-repair-test-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "gateway.sqlite");
    const first = createDatabase(path, resolve("drizzle"));
    // 模拟上一轮未发布迁移建出的旧形态：删掉两列。
    first.sqlite.exec("ALTER TABLE writing_style_user_content DROP COLUMN user_edited;");
    first.sqlite.exec("ALTER TABLE writing_style_user_content DROP COLUMN generated_from_cursor;");
    first.sqlite.close();

    const reopened = createDatabase(path, resolve("drizzle"));
    databases.push(reopened);
    const columns = new Set(
      (reopened.sqlite.prepare("PRAGMA table_info(writing_style_user_content)").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    expect(columns.has("user_edited")).toBe(true);
    expect(columns.has("generated_from_cursor")).toBe(true);
    // 旧行默认值正确（接管 = false）。
    reopened.sqlite.exec("INSERT INTO writing_style_user_content (owner_id, content, updated_at) VALUES ('local-user', '旧内容', strftime('%s','now') * 1000)");
    const service = new WritingStyleService(reopened.db);
    expect(service.getProfileText().userEdited).toBe(false);
    expect(service.getProfileText().content).toBe("旧内容");
  });
});

describe("WritingStyleService 用户风格正文", () => {
  it("画像文本为空且未接管时启动兜底补生成；接管后不覆盖", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    // 模拟"单一画像"模型上线前的旧库：统计画像在，文本行为空。
    database.db.run(sql`DELETE FROM writing_style_user_content`);
    expect(service.getProfileText().content).toBe("");

    service.ensureProfileTextInitialized();
    const text = service.getProfileText();
    expect(text.content.length).toBeGreaterThan(0);
    expect(text.userEdited).toBe(false);

    // 接管后兜底不再覆盖。
    service.replaceUserContent("我的版本。");
    service.ensureProfileTextInitialized();
    expect(service.getProfileText().content).toBe("我的版本。");
  });

  it("保存空文本 = 解除接管并立即回填系统版本", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    const systemText = service.getProfileText().content;
    expect(systemText.length).toBeGreaterThan(0);

    service.replaceUserContent("我的接管版本。");
    expect(service.getProfileText().userEdited).toBe(true);

    // 清空：解除接管，统计在 → 立即回系统版。
    service.replaceUserContent("   ");
    const cleared = service.getProfileText();
    expect(cleared.userEdited).toBe(false);
    expect(cleared.content).toBe(systemText);
  });

  it("保存即全量替换，超长拒绝", async () => {
    const { service } = await setup();
    expect(service.getProfileText().content).toBe("");
    const saved = service.replaceUserContent("  简洁的技术笔记体，少用感叹号。  ");
    expect(saved.content).toBe("简洁的技术笔记体，少用感叹号。");
    expect(() => service.replaceUserContent("长".repeat(2_001))).toThrow("writing_style_content_invalid");
    // 被拒绝的写入不影响已存内容。
    expect(service.getProfileText().content).toBe("简洁的技术笔记体，少用感叹号。");
  });

  it("recompute 清空管线产物但零触碰用户正文", async () => {
    const { database, service } = await setup();
    seedDocument(database, { id: "doc-1", roomId: "room-1", seed: "风控" });
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    service.replaceUserContent("避免长定语从句。");

    const { queuedDocuments } = service.recompute();
    expect(queuedDocuments).toBe(1);
    expect(service.getProfileText().content).toBe("避免长定语从句。");
    expect(service.getProfile().profileVersion).toBe(0);
    await expect(service.refreshProfile()).resolves.toMatchObject({ llm: "disabled" });
  });
});
