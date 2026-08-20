import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  diaryVersionSources,
  entities,
  entityDocLinks,
  uploadedFiles,
  visualNodes,
  visualObservations,
} from "../src/infrastructure/database/schema.js";
import { DiaryService, type DiaryGenerator, type DiaryMemoryProvider } from "../src/modules/diary/service.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const NOW = new Date("2026-08-20T12:00:00.000Z");

async function setup(generator?: DiaryGenerator, memory?: DiaryMemoryProvider, maxAttempts = 1): Promise<{ database: DatabaseClient; service: DiaryService }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-diary-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, service: new DiaryService(database.db, {
    ...(generator ? { generator } : {}),
    ...(memory ? { memory } : {}),
    now: () => new Date(NOW),
    maxAttempts,
  }) };
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DiaryService", () => {
  it("creates an empty immutable version without invoking the generator when no sources exist", async () => {
    const generate = vi.fn(async () => { throw new Error("must not be called"); });
    const { service } = await setup({ generate });
    const runId = service.createRun("2026-08-20");

    await service.drain();

    expect(generate).not.toHaveBeenCalled();
    expect(service.getRun(runId)?.status).toBe("completed");
    expect(service.listVersions("2026-08-20")[0]?.content.events).toEqual([]);
  });

  it("does not retry a generation that reached the model output limit", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async () => {
      throw new Error("本次处理达到模型输出上限，未能生成最终结论。已保留处理过程，请缩小范围后重试。");
    });
    const { database, service } = await setup({ model: "test", generate }, undefined, 5);
    database.db.insert(uploadedFiles).values({
      id: "token-limit-source", contentHash: "token-limit-hash", storagePath: "files/token-limit",
      originalName: "source.md", bytes: 1, capturedAt: new Date("2026-08-20T10:00:00.000Z"),
      createdAt: NOW, updatedAt: NOW,
    }).run();
    const runId = service.createRun("2026-08-20");

    await service.drain();
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
    expect(service.getRun(runId)).toMatchObject({ status: "failed", attempt: 1 });
    expect(service.getRun(runId)?.finishedAt).toBeInstanceOf(Date);
  });

  it("reuses an active manual run and exposes it for UI recovery", async () => {
    const { service } = await setup();
    const firstRunId = service.createRun("2026-08-20");
    const secondRunId = service.createRun("2026-08-20");

    expect(secondRunId).toBe(firstRunId);
    expect(service.getActiveRun()).toMatchObject({ id: firstRunId, status: "pending" });
  });

  it("limits source reads to the run manifest and marks a ready day stale after source changes", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => {
      expect(await input.readSource("file:file-1")).toBe("first body");
      expect(await input.readSource("file:not-in-manifest")).toBeNull();
      const source = input.sources[0]!;
      return {
        headline: "A day", summary: "Summary", reflection: "Reflection", range: input.range,
        events: [{ time: source.occurredAt, title: "File", summary: source.evidenceSummary, sourceRefs: [source.sourceId] }],
        closing: "Closing",
      };
    });
    const { database, service } = await setup({ model: "test", generate });
    database.db.insert(uploadedFiles).values({
      id: "file-1", contentHash: "hash-1", storagePath: "files/1", originalName: "notes.md",
      bytes: 10, capturedAt: new Date("2026-08-20T10:00:00.000Z"), createdAt: NOW, updatedAt: NOW,
    }).run();
    database.sqlite.prepare("INSERT INTO parsed_contents (id, content_hash, parser_version, markdown, parsed_at) VALUES (?, ?, ?, ?, ?)").run("parsed-1", "hash-1", "v1", "first body", NOW.getTime());
    database.db.update(uploadedFiles).set({ currentParsedId: "parsed-1" }).where(eq(uploadedFiles.id, "file-1")).run();

    service.createRun("2026-08-20");
    await service.drain();

    const version = service.listVersions("2026-08-20")[0]!;
    expect(database.db.select().from(diaryVersionSources).where(eq(diaryVersionSources.versionId, version.id)).all()).toHaveLength(1);
    expect(service.getDay("2026-08-20").sources[0]).toMatchObject({ assetKind: "document", mime: "text/markdown" });
    expect(service.getDay("2026-08-20").day?.status).toBe("ready");

    database.db.update(uploadedFiles).set({ contentHash: "hash-2" }).where(eq(uploadedFiles.id, "file-1")).run();
    await service.drain();
    expect(service.getDay("2026-08-20").day?.status).toBe("stale");
    expect(service.listVersions("2026-08-20")).toHaveLength(1);
  });

  it("rejects generated events outside the strict half-open window", async () => {
    const { database, service } = await setup({
      async generate(input) {
        return { headline: "bad", summary: "bad", reflection: "bad", range: input.range, events: [{ time: input.range.end, title: "bad", summary: "bad", sourceRefs: [input.sources[0]!.sourceId] }], closing: "bad" };
      },
    });
    database.db.insert(uploadedFiles).values({ id: "file-2", contentHash: "hash", storagePath: "files/2", originalName: "source.md", bytes: 1, capturedAt: new Date("2026-08-20T10:00:00.000Z"), createdAt: NOW, updatedAt: NOW }).run();
    const runId = service.createRun("2026-08-20");
    await service.drain();
    expect(service.getRun(runId)).toMatchObject({ status: "failed", error: "event_outside_window" });
    expect(service.listVersions("2026-08-20")).toEqual([]);
  });

  it("aligns merged event time to the complete evidence range", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => {
      expect(input.timezone).toBe("Asia/Shanghai");
      expect(input.sources[0]).toMatchObject({
        occurredAt: "2026-08-20T10:05:00.000Z",
        endedAt: "2026-08-20T11:40:00.000Z",
        timeBasis: "visual_capture_range",
      });
      return {
        headline: "工作记录", summary: "完成一段工作", reflection: "", range: input.range,
        events: [{ time: "2026-08-20T10:30:00.000Z", title: "持续工作", summary: "整理资料", sourceRefs: [input.sources[0]!.sourceId] }],
        closing: "",
      };
    });
    const { database, service } = await setup({ model: "test", generate });
    database.db.insert(visualNodes).values({
      id: "visual-range", kind: "screenshot",
      startAt: new Date("2026-08-20T10:05:00.000Z"), endAt: new Date("2026-08-20T11:40:00.000Z"),
      sampleCount: 4, vlmStatus: "ready", summary: "持续整理资料",
    }).run();

    service.createRun("2026-08-20");
    await service.drain();

    expect(service.listVersions("2026-08-20")[0]?.content.events).toEqual([expect.objectContaining({
      time: "2026-08-20T10:05:00.000Z",
      endTime: "2026-08-20T11:40:00.000Z",
    })]);
    expect(service.getDay("2026-08-20").sources[0]).toMatchObject({
      endedAt: new Date("2026-08-20T11:40:00.000Z"),
      timeBasis: "visual_capture_range",
    });
  });

  it("does not send a registered screenshot as both a file and a visual node", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => {
      expect(input.sources).toHaveLength(1);
      expect(input.sources[0]).toMatchObject({
        kind: "visual_node",
        assetFileId: "screenshot-file",
        keyPoints: ["正在编辑实体感知代码"],
        insightTags: [expect.objectContaining({ kind: "entity", label: "EverRoom" })],
      });
      expect(await input.readSource(input.sources[0]!.sourceId)).toContain("## 实体与事实");
      return {
        headline: "截图记录", summary: "截图活动", reflection: "", range: input.range,
        events: [{ time: input.sources[0]!.occurredAt, title: "截图活动", summary: "截图活动", sourceRefs: [input.sources[0]!.sourceId] }],
        closing: "",
      };
    });
    const { database, service } = await setup({ model: "test", generate });
    const capturedAt = new Date("2026-08-20T10:05:00.000Z");
    database.db.insert(uploadedFiles).values({
      id: "screenshot-file", contentHash: "screenshot-hash", storagePath: "files/screenshot",
      originalName: "screen.jpg", bytes: 10, mime: "image/jpeg", assetKind: "screenshot",
      capturedAt, createdAt: capturedAt, updatedAt: capturedAt,
    }).run();
    database.db.insert(visualNodes).values({
      id: "visual-screenshot", kind: "screenshot", startAt: capturedAt, endAt: capturedAt,
      sampleCount: 1, representativeObservationId: "observation-screenshot", vlmStatus: "ready",
      eventType: "WORK", title: "编辑实体感知", summary: "截图活动",
      keyPoints: ["正在编辑实体感知代码"],
      representativeTags: [{ kind: "entity", label: "EverRoom", entityType: "project", evidence: "EverRoom" }],
    }).run();
    database.db.insert(visualObservations).values({
      id: "observation-screenshot", nodeId: "visual-screenshot", fileId: "screenshot-file",
      kind: "screenshot", capturedAt,
    }).run();

    service.createRun("2026-08-20");
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not include visual nodes until VLM processing is ready", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => ({
      headline: "已完成感知", summary: "只有完成理解的截图进入日记", reflection: "", range: input.range,
      events: input.sources.map((source) => ({
        time: source.occurredAt, title: source.evidenceSummary, summary: source.evidenceSummary,
        sourceRefs: [source.sourceId],
      })), closing: "",
    }));
    const { database, service } = await setup({ model: "test", generate });
    const capturedAt = new Date("2026-08-20T10:05:00.000Z");
    for (const [id, status] of [["visual-pending", "pending"], ["visual-ready", "ready"]] as const) {
      database.db.insert(visualNodes).values({
        id, kind: "screenshot", startAt: capturedAt, endAt: capturedAt,
        sampleCount: 1, vlmStatus: status, summary: status === "ready" ? "VLM 已描述内容" : null,
      }).run();
    }

    service.createRun("2026-08-20");
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].sources).toHaveLength(1);
    expect(generate.mock.calls[0]?.[0].sources[0]).toMatchObject({
      sourceId: "visual_node:visual-ready", evidenceSummary: "VLM 已描述内容",
    });
  });

  it("includes a visual range that started before the local diary day", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => ({
      headline: "跨日记录", summary: "跨日活动", reflection: "", range: input.range,
      events: [{ time: input.sources[0]!.occurredAt, title: "跨日活动", summary: "活动延续到今天", sourceRefs: [input.sources[0]!.sourceId] }],
      closing: "",
    }));
    const { database, service } = await setup({ model: "test", generate });
    database.db.insert(visualNodes).values({
      id: "visual-cross-day", kind: "screenshot",
      startAt: new Date("2026-08-19T15:58:00.000Z"), endAt: new Date("2026-08-19T16:10:00.000Z"),
      sampleCount: 3, vlmStatus: "ready", summary: "跨午夜活动",
    }).run();

    service.createRun("2026-08-20");
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
    expect(service.listVersions("2026-08-20")[0]?.content.events[0]).toMatchObject({
      time: "2026-08-19T16:00:00.000Z",
      endTime: "2026-08-19T16:10:00.000Z",
    });
  });

  it("queues catch-up days oldest first immediately after scheduling is enabled", async () => {
    const { database, service } = await setup();
    const settings = service.updateSettings({ enabled: true, enabledFrom: "2026-08-18" });
    expect(settings.enabledFrom).toBe("2026-08-18");
    expect(settings.nextRunAt).toEqual(new Date("2026-08-20T15:30:00.000Z"));

    await service.drain();

    const runs = database.sqlite.prepare("SELECT date, trigger, status FROM diary_runs ORDER BY created_at, date").all();
    expect(runs).toEqual([
      { date: "2026-08-18", trigger: "catch_up", status: "completed" },
      { date: "2026-08-19", trigger: "catch_up", status: "completed" },
    ]);
    await service.drain();
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM diary_runs").get()).toEqual({ count: 2 });
  });

  it("completes without sources when the optional memory query fails", async () => {
    const query = vi.fn(async () => { throw new Error("memory unavailable"); });
    const { service } = await setup(undefined, { query });
    const runId = service.createRun("2026-08-20");

    await service.drain();

    expect(query).toHaveBeenCalledOnce();
    expect(service.getRun(runId)?.status).toBe("completed");
    expect(service.listVersions("2026-08-20")[0]?.content.events).toEqual([]);
  });

  it("treats ranges as half-open and reads manifest summaries when full content is unavailable", async () => {
    const query = vi.fn(async () => [{
      sourceId: "memory:previous-day",
      kind: "memory" as const,
      version: "1",
      occurredAt: "2026-08-19T15:30:00.000Z",
      endedAt: "2026-08-19T16:00:00.000Z",
      fingerprint: "previous-day",
      evidenceSummary: "上一天结束的记忆",
    }, {
      sourceId: "memory:current-day",
      kind: "memory" as const,
      version: "1",
      occurredAt: "2026-08-20T09:00:00.000Z",
      fingerprint: "current-day",
      evidenceSummary: "清单内的摘要证据",
    }]);
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => {
      expect(input.sources.map((source) => source.sourceId)).toEqual(["memory:current-day"]);
      expect(await input.readSource("memory:current-day")).toBe("清单内的摘要证据");
      expect(await input.readSource("memory:previous-day")).toBeNull();
      return {
        headline: "当天记录", summary: "摘要", reflection: "", range: input.range,
        events: [{
          time: input.sources[0]!.occurredAt,
          title: "记忆",
          summary: input.sources[0]!.evidenceSummary,
          sourceRefs: [input.sources[0]!.sourceId],
        }],
        closing: "",
      };
    });
    const { service } = await setup({ model: "test", generate }, { query });

    service.createRun("2026-08-20");
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
    expect(service.listVersions("2026-08-20")[0]?.content.events).toHaveLength(1);
  });

  it("does not mark a day stale when equal-time memory sources arrive in a different order", async () => {
    const sources = ["b", "a"].map((id) => ({
      sourceId: `memory:${id}`,
      kind: "memory" as const,
      version: "1",
      occurredAt: "2026-08-20T09:00:00.000Z",
      fingerprint: id,
      evidenceSummary: id,
      content: id,
    }));
    let reversed = false;
    const query = vi.fn(async () => {
      reversed = !reversed;
      return reversed ? sources : [...sources].reverse();
    });
    const { service } = await setup({
      model: "test",
      async generate(input) {
        return {
          headline: "稳定排序", summary: "摘要", reflection: "", range: input.range,
          events: [{
            time: input.sources[0]!.occurredAt,
            title: "记忆",
            summary: "内容未变化",
            sourceRefs: input.sources.map((source) => source.sourceId),
          }],
          closing: "",
        };
      },
    }, { query });

    service.createRun("2026-08-20");
    await service.drain();
    await service.drain();

    expect(query).toHaveBeenCalledTimes(2);
    expect(service.getDay("2026-08-20").day?.status).toBe("ready");
  });

  it("collects connector email, document, and calendar evidence for the diary Agent", async () => {
    const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => {
      expect(input.sources.map((source) => source.kind)).toEqual([
        "connector_email", "connector_document", "connector_calendar",
      ]);
      expect(input.sources[0]?.knowledgeEntities).toEqual([expect.objectContaining({
        entityId: "entity-budget-owner",
        name: "张三",
        kind: "人物",
        role: "primary",
        evidence: "张三发起预算审批",
      })]);
      expect(await Promise.all(input.sources.map((source) => input.readSource(source.sourceId)))).toEqual([
        "邮件正文", "文档正文", "日程描述",
      ]);
      return {
        headline: "连接器记录", summary: "摘要", reflection: "", range: input.range,
        events: input.sources.map((source) => ({
          time: source.occurredAt,
          ...(source.endedAt ? { endTime: source.endedAt } : {}),
          title: source.evidenceSummary,
          summary: source.evidenceSummary,
          sourceRefs: [source.sourceId],
        })),
        closing: "",
      };
    });
    const { database, service } = await setup({ model: "test", generate });
    const common = {
      ownerId: "local-user", service: "test", connectionName: "primary",
      schemaVersion: 1, promptVersion: 1, syncedAt: new Date("2026-08-20T09:00:00.000Z"),
    };
    database.db.insert(connectorEmails).values({
      ...common, id: "email-1", sourceRecordId: "email-source-1", messageId: "message-1",
      recipients: [], subject: "邮件", sentAt: new Date("2026-08-20T08:00:00.000Z"), bodyText: "邮件正文",
      labels: [], hasAttachments: false, contentHash: "email-hash",
    }).run();
    database.db.insert(connectorDocuments).values({
      ...common, id: "document-1", sourceRecordId: "document-source-1", documentId: "remote-document-1",
      title: "文档", bodyText: "文档正文", sourceUpdatedAt: new Date("2026-08-20T09:00:00.000Z"),
      contentHash: "document-hash",
    }).run();
    database.db.insert(connectorCalendarEvents).values({
      ...common, id: "calendar-1", sourceRecordId: "calendar-source-1", eventId: "remote-calendar-1",
      title: "日程", description: "日程描述", attendees: [], startAt: new Date("2026-08-20T10:00:00.000Z"),
      endAt: new Date("2026-08-20T11:00:00.000Z"), allDay: false, contentHash: "calendar-hash",
    }).run();
    database.db.insert(entities).values({
      id: "entity-budget-owner", name: "张三", kind: "人物", status: "ready",
    }).run();
    database.db.insert(entityDocLinks).values({
      id: "link-email-budget-owner", entityId: "entity-budget-owner", sourceKind: "mail",
      sourceId: "connector_email:email-1", sourceVersion: 1, role: "primary", salience: 0.9,
      evidence: "张三发起预算审批", decidedBy: "resolution",
    }).run();

    service.createRun("2026-08-20");
    await service.drain();

    expect(generate).toHaveBeenCalledOnce();
    expect(service.getDay("2026-08-20").sources).toHaveLength(3);
    expect(service.getDay("2026-08-20").day?.status).toBe("ready");

    database.db.insert(entities).values({
      id: "entity-budget-project", name: "第三季度预算", kind: "项目", status: "weak",
    }).run();
    database.db.insert(entityDocLinks).values({
      id: "link-email-budget-project", entityId: "entity-budget-project", sourceKind: "mail",
      sourceId: "connector_email:email-1", sourceVersion: 1, role: "mention", salience: 0.6,
      evidence: "邮件正文提到第三季度预算", decidedBy: "resolution",
    }).run();
    await service.drain();

    expect(service.getDay("2026-08-20").day?.status).toBe("stale");
    expect(service.listVersions("2026-08-20")).toHaveLength(1);
  });
});
