import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import pino from "pino";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorEmails,
  documents,
  entities as entitiesTable,
  entityDocLinks,
  ingestEvents,
  jobs,
  realityEvents,
  roomDocumentLinks,
  routeDecisions,
} from "../src/infrastructure/database/schema.js";
import type { RealityCaptureDevice, RealityInsights, RealityMarker } from "@nxcore/reality-contract";
import { FilesService } from "../src/modules/files/service.js";
import {
  KnowledgeService,
  ingestLedgerOf,
  linkOnlyRoomsOf,
  wikiDisabledForSource,
} from "../src/modules/knowledge/service.js";
import type { MemoryService } from "../src/modules/memory/service.js";
import { IngestService } from "../src/modules/ingest/service.js";
import { ingestRoutes } from "../src/modules/ingest/routes.js";
import {
  loadPolicyOverrides,
  loadProjectDefaults,
  projectPolicyDefaultsPath,
  resolvePipelines,
  validatePipelines,
  POLICY_FILE_NAME,
  PROJECT_POLICY_DEFAULTS_FILE,
  type PolicyLayers,
} from "../src/modules/ingest/policy.js";
import { truncateUtf8 } from "../src/modules/ingest/normalizers.js";
import { IngestError } from "../src/modules/ingest/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger: Logger = pino({ level: "silent" });

interface EngineOptions {
  routerEnabled?: boolean;
  knowledgeEnabled?: boolean;
  memoryEnabled?: boolean;
  memoryError?: boolean;
  memoryErrorOnce?: boolean;
  knowledgeErrorOnce?: boolean;
  policyLayers?: PolicyLayers;
}

async function engineForTest(options: EngineOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const files = new FilesService(db, dataDir);

  const knowledge = {
    enabled: options.knowledgeEnabled ?? true,
    routerEnabled: options.routerEnabled ?? true,
    submitEnvelope: vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" }),
    submitCommittedDocument: options.knowledgeErrorOnce
      ? vi.fn().mockImplementationOnce(() => { throw new Error("knowledge unavailable"); })
        .mockReturnValue({ queued: true, jobId: "route-job-1" })
      : vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" }),
    requestSourceCleanup: vi.fn(),
  } as unknown as KnowledgeService;
  const memorySuccess = {
    document: { id: "mdoc-1", title: "", callerRef: "", version: 1, sessionId: "s1", chunkCount: 3, derivedMemoryCount: null },
    version: 1,
    sessionId: "s1",
    chunkCount: 3,
    deduplicated: false,
    replacedVersions: [],
    acceptedChunks: 3,
  };
  const memory = {
    enabled: options.memoryEnabled ?? true,
    importToMemoryCore: options.memoryError
      ? vi.fn().mockRejectedValue(new Error("memorycore down"))
      : options.memoryErrorOnce
        ? vi.fn().mockRejectedValueOnce(new Error("memorycore down")).mockResolvedValue(memorySuccess)
        : vi.fn().mockResolvedValue(memorySuccess),
    deleteDocumentsByCallerRef: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryService;

  const service = new IngestService(db, files, knowledge, memory, silentLogger, options.policyLayers);
  return { service, db, sqlite, files, dataDir, knowledge, memory };
}

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-ingest-src-"));
  temporaryDirectories.push(dir);
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

// ───────────────────────── 策略层 ─────────────────────────

describe("策略解析（请求覆盖 > 部署覆盖 > 工程默认 > 代码兜底）", () => {
  it("validatePipelines：wiki 无 Room 非法；全关非法", () => {
    expect(validatePipelines({ room: false, wiki: true, memory: true })).toBe("invalid_pipelines");
    expect(validatePipelines({ room: false, wiki: false, memory: false })).toBe("no_pipelines");
    expect(validatePipelines({ room: true, wiki: true, memory: false })).toBeNull();
    expect(validatePipelines({ room: false, wiki: false, memory: true })).toBeNull();
  });

  it("四层逐级生效；覆盖整体替换", () => {
    const layers: PolicyLayers = {
      project: new Map([["document", { room: true, wiki: true, memory: false }]]),
      deploy: new Map([["document", { room: false, wiki: false, memory: true }]]),
    };
    // 代码兜底：office-doc 三链路全开
    expect(resolvePipelines("office-doc", undefined, layers)).toEqual({ room: true, wiki: true, memory: true });
    // 工程默认：document 记忆关
    expect(resolvePipelines("document", undefined, { ...layers, deploy: new Map() }))
      .toEqual({ room: true, wiki: true, memory: false });
    // 部署覆盖压过工程默认
    expect(resolvePipelines("document", undefined, layers))
      .toEqual({ room: false, wiki: false, memory: true });
    // 请求覆盖压过一切（不逐字段合并）
    expect(resolvePipelines("document", { room: true, wiki: true, memory: true }, layers))
      .toEqual({ room: true, wiki: true, memory: true });
    // 未知类型
    expect(() => resolvePipelines("nope", undefined, layers)).toThrow(IngestError);
  });

  it("loadPolicyOverrides（部署层）：合法生效，非法告警跳过；缺文件=空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-policy-"));
    temporaryDirectories.push(dir);
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    // 缺文件：空表
    expect(await loadPolicyOverrides(dir, warn)).toEqual(new Map());
    expect(warnings).toEqual([]);

    // 合法 + 未知类型 + 非法组合 + 缺字段：只有合法进表
    await writeFile(join(dir, POLICY_FILE_NAME), JSON.stringify({
      $comment: "元信息键应被静默忽略",
      document: { room: true, wiki: true, memory: false },
      "no-such-type": { room: true, wiki: true, memory: true },
      slides: { room: false, wiki: true, memory: false },
      html: { room: true, wiki: true },
    }), "utf8");
    const loaded = await loadPolicyOverrides(dir, warn);
    expect(loaded.get("document")).toEqual({ room: true, wiki: true, memory: false });
    expect(loaded.has("slides")).toBe(false);
    expect(loaded.has("html")).toBe(false);
    expect(warnings).toHaveLength(3);

    // 坏 JSON：整表忽略
    await writeFile(join(dir, POLICY_FILE_NAME), "{oops", "utf8");
    expect(await loadPolicyOverrides(dir, warn)).toEqual(new Map());
    expect(warnings).toHaveLength(4);
  });

  it("loadProjectDefaults（工程层）：显式路径加载 + 仓库随附文件本身合法", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-policy-defaults-"));
    temporaryDirectories.push(dir);
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    await writeFile(join(dir, PROJECT_POLICY_DEFAULTS_FILE), JSON.stringify({
      spreadsheet: { room: true, wiki: true, memory: true },
    }), "utf8");
    const loaded = await loadProjectDefaults(warn, join(dir, PROJECT_POLICY_DEFAULTS_FILE));
    expect(loaded.get("spreadsheet")).toEqual({ room: true, wiki: true, memory: true });
    expect(warnings).toEqual([]);

    // 仓库里的工程默认文件（工程师改坏会在 CI 这里红）：解析零告警，键全在注册表内
    const repoFile = await projectPolicyDefaultsPath();
    expect(repoFile).not.toBeNull();
    expect(repoFile!.endsWith(PROJECT_POLICY_DEFAULTS_FILE)).toBe(true);
    const repoDefaults = await loadProjectDefaults(warn, repoFile!);
    expect(warnings).toEqual([]);
    expect(repoDefaults.size).toBeGreaterThan(0);
    for (const pipelines of repoDefaults.values()) expect(validatePipelines(pipelines)).toBeNull();
  });
});

// ───────────────────────── path 输入 ─────────────────────────

describe("引擎主流程：path 输入（U8 只读不拷贝）", () => {
  it("md 文件：归一化→解析落库→台账→双扇出；不写 uploaded_files", async () => {
    const test = await engineForTest();
    const path = await tempFile("接入方案.md", "# 接入方案\n\n正文段落");

    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({
      deduped: false,
      dataType: "document",
      detectedBy: "extension",
      title: "接入方案",
      pipelines: { room: true, wiki: true, memory: true },
      routeJobId: "route-job-1",
    });
    expect(result.memoryResult).toMatchObject({ documentId: "mdoc-1", chunkCount: 3 });

    // U8：path 只读不拷贝——无对象库登记行，但有解析产物与台账
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM uploaded_files").get()).toMatchObject({ c: 0 });
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM parsed_contents").get()).toMatchObject({ c: 1 });
    const event = test.sqlite.prepare("SELECT * FROM ingest_events").get() as Record<string, unknown>;
    expect(event.data_type).toBe("document");
    expect(event.origin_channel).toBe("file");

    // 扇出参数：markdown 全文 + filenamePrefix 信号 + 台账版本流
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "file",
      title: "接入方案",
      markdown: "# 接入方案\n\n正文段落",
      entrySignals: { filenamePrefix: "接入方案.md" },
      sourceVersion: 1,
    }));
    expect(test.memory.importToMemoryCore).toHaveBeenCalledWith(expect.objectContaining({
      title: "接入方案",
      callerRef: result.source.sourceId,
    }));
    test.sqlite.close();
  });

  it("闸1（台账层）：同源同指纹重进零成本跳过——不归一化不扇出", async () => {
    const test = await engineForTest();
    const path = await tempFile("纪要.md", "# 纪要");

    const first = await test.service.ingest({ source: { path } });
    const again = await test.service.ingest({ source: { path } });
    expect(again.deduped).toBe(true);
    expect(again.eventId).toBe(first.eventId);
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(1);
    expect(test.memory.importToMemoryCore).toHaveBeenCalledTimes(1);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM ingest_events").get()).toMatchObject({ c: 1 });
    test.sqlite.close();
  });

  it("来源删除后软删除旧台账并允许相同内容恢复时重新扇出", async () => {
    const test = await engineForTest();
    const path = await tempFile("恢复测试.md", "# 恢复测试");

    const first = await test.service.ingest({ source: { path } });
    await test.service.cleanupSource("file", first.source.sourceId);
    const restored = await test.service.ingest({ source: { path } });

    expect(restored).toMatchObject({ deduped: false, source: { sourceVersion: 2 } });
    expect(test.knowledge.requestSourceCleanup).toHaveBeenCalledWith("file", first.source.sourceId);
    expect(test.memory.deleteDocumentsByCallerRef).toHaveBeenCalledWith(first.source.sourceId);
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(2);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM ingest_events WHERE deleted_at IS NOT NULL").get())
      .toMatchObject({ c: 1 });
    test.sqlite.close();
  });

  it("json 会议纪要：结构嗅探 → meeting-minutes 模板组装", async () => {
    const test = await engineForTest();
    const path = await tempFile("周会.json", JSON.stringify({
      title: "周会",
      participants: ["甲", "乙"],
      summary: "对齐进度",
      decisions: ["冻结范围"],
      actionItems: [{ owner: "甲", task: "补测试", due: "周五" }],
      transcript: [{ speaker: "甲", text: "开始吧" }],
    }));

    const result = await test.service.ingest({ source: { path } });
    expect(result.dataType).toBe("meeting-minutes");
    expect(result.detectedBy).toBe("json-type");
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("**与会人**：甲、乙");
    expect(submitted.markdown).toContain("## 决议\n\n- 冻结范围");
    expect(submitted.markdown).toContain("- 甲：补测试（截止 周五）");
    expect(submitted.markdown).toContain("- **甲**：开始吧");
    test.sqlite.close();
  });

  it("显式 dataType 声明压过结构嗅探（detectedBy=explicit）", async () => {
    const test = await engineForTest();
    const path = await tempFile("结构.json", JSON.stringify({ text: "普通文本" }));
    const result = await test.service.ingest({ source: { path }, dataType: "document" });
    expect(result).toMatchObject({ dataType: "document", detectedBy: "explicit" });
    test.sqlite.close();
  });

  it("未知扩展名嗅探为 md → document/sniff；二进制拒绝 unsupported_type", async () => {
    const test = await engineForTest();
    const text = await tempFile("无扩展名", "就是一段文本");
    expect(await test.service.ingest({ source: { path: text } }))
      .toMatchObject({ dataType: "document", detectedBy: "sniff" });

    const dir = await mkdtemp(join(tmpdir(), "nxcore-ingest-bin-"));
    temporaryDirectories.push(dir);
    const binPath = join(dir, "blob.bin");
    await writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    await expect(test.service.ingest({ source: { path: binPath } }))
      .rejects.toMatchObject({ code: "unsupported_type", statusCode: 422 });
    test.sqlite.close();
  });

  it("损坏的 office 文件 → convert_failed（不是 unsupported）", async () => {
    const test = await engineForTest();
    const docx = await tempFile("坏档.docx", "PK FakeZip 不是合法包");
    await expect(test.service.ingest({ source: { path: docx } }))
      .rejects.toMatchObject({ code: "convert_failed" });
    test.sqlite.close();
  });

  it("源校验：path/ref 二选一", async () => {
    const test = await engineForTest();
    await expect(test.service.ingest({ source: {} })).rejects.toMatchObject({ code: "source_required" });
    await expect(test.service.ingest({
      source: { path: "x.md", ref: { sourceKind: "file", sourceId: "f" } },
    })).rejects.toMatchObject({ code: "source_conflict" });
    await expect(test.service.ingest({ source: { path: "E:/不存在的.md" } }))
      .rejects.toMatchObject({ code: "path_unreadable" });
    test.sqlite.close();
  });
});

// ───────────────────────── ref 输入 ─────────────────────────

describe("ref 输入：file / everroom-doc / reality-event / connector", () => {
  it("file ref：读对象库字节，回填 currentParsedId，版本流递增", async () => {
    const test = await engineForTest();
    const uploaded = await test.files.upload({
      filename: "季度目标.md",
      buffer: Buffer.from("# Q3 目标", "utf8"),
    });

    const first = await test.service.ingest({
      source: { ref: { sourceKind: "file", sourceId: uploaded.fileId } },
    });
    expect(first).toMatchObject({
      dataType: "document",
      detectedBy: "extension",
      source: { sourceVersion: 1 },
    });
    expect(test.files.get(uploaded.fileId)!.currentParsedId).toBe(first.parsedId);

    // 同名新内容 = 新指纹 → 新事件（版本 2），解析指针前移
    const renewed = await test.files.upload({
      filename: "季度目标.md",
      buffer: Buffer.from("# Q3 目标（修订）", "utf8"),
    });
    const second = await test.service.ingest({
      source: { ref: { sourceKind: "file", sourceId: uploaded.fileId } },
    });
    expect(second.deduped).toBe(false);
    expect(second.source.sourceVersion).toBe(2);
    expect(test.files.get(uploaded.fileId)!.currentParsedId).toBe(second.parsedId);
    expect(renewed.contentHash).not.toBe(first.contentHash);
    test.sqlite.close();
  });

  it("file ref 不存在 → ref_not_found 404", async () => {
    const test = await engineForTest();
    await expect(test.service.ingest({
      source: { ref: { sourceKind: "file", sourceId: "file-不存在" } },
    })).rejects.toMatchObject({ code: "ref_not_found", statusCode: 404 });
    test.sqlite.close();
  });

  it("everroom-doc ref：tiptap → md，版本取 documents.version", async () => {
    const test = await engineForTest();
    test.db.insert(documents).values({
      id: "doc-1",
      title: "需求文档",
      version: 3,
      contentJson: {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "需求" }] }],
      },
    }).run();

    const result = await test.service.ingest({
      source: { ref: { sourceKind: "everroom-doc", sourceId: "doc-1" } },
    });
    expect(result).toMatchObject({
      dataType: "document",
      detectedBy: "source-kind",
      source: { sourceVersion: 3 },
      title: "需求文档",
      originChannel: "everroom-doc",
    });
    const submitted = (test.knowledge.submitCommittedDocument as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("# 需求");

    // 内容不变重进 → 台账闸 1
    const again = await test.service.ingest({
      source: { ref: { sourceKind: "everroom-doc", sourceId: "doc-1" } },
    });
    expect(again.deduped).toBe(true);
    test.sqlite.close();
  });

  it("committed document：router 关闭仍按已有 Room 摄取，且仅改标题也产生新事件", async () => {
    const test = await engineForTest({ routerEnabled: false });
    test.db.insert(documents).values({
      id: "doc-committed",
      title: "第一版标题",
      version: 1,
      status: "active",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "相同正文" }] }] },
    }).run();

    const first = await test.service.ingestCommittedDocument("doc-committed", 1);
    test.db.update(documents).set({ title: "第二版标题", version: 2 }).where(eq(documents.id, "doc-committed")).run();
    const second = await test.service.ingestCommittedDocument("doc-committed", 2);

    expect(first?.deduped).toBe(false);
    expect(second?.deduped).toBe(false);
    expect(second?.contentHash).not.toBe(first?.contentHash);
    expect(test.db.select().from(ingestEvents).all()).toHaveLength(2);
    expect(test.knowledge.submitCommittedDocument).toHaveBeenCalledTimes(2);
    test.sqlite.close();
  });

  it("committed document：空正文作为无可摄取内容跳过而不是失败重试", async () => {
    const test = await engineForTest();
    test.db.insert(documents).values({
      id: "doc-empty",
      title: "Empty",
      version: 1,
      status: "active",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    }).run();

    await expect(test.service.ingestCommittedDocument("doc-empty", 1)).resolves.toBeNull();
    expect(test.db.select().from(ingestEvents).all()).toEqual([]);
    expect(test.knowledge.submitCommittedDocument).not.toHaveBeenCalled();
    expect(test.memory.importToMemoryCore).not.toHaveBeenCalled();
    test.sqlite.close();
  });

  it("committed document：Memory 首次失败后从既有台账恢复", async () => {
    const test = await engineForTest({ knowledgeEnabled: false, memoryErrorOnce: true });
    test.db.insert(documents).values({
      id: "doc-memory-retry",
      title: "Memory retry",
      version: 1,
      status: "active",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] },
    }).run();

    await expect(test.service.ingestCommittedDocument("doc-memory-retry", 1))
      .rejects.toThrow("document memory ingest failed");
    await expect(test.service.ingestCommittedDocument("doc-memory-retry", 1))
      .resolves.toMatchObject({ deduped: true, memoryResult: { documentId: "mdoc-1" } });

    expect(test.db.select().from(ingestEvents).all()).toHaveLength(1);
    expect(test.memory.importToMemoryCore).toHaveBeenCalledTimes(2);
    test.sqlite.close();
  });

  it("committed document：Knowledge 首次入队失败后恢复缺失扇出且不重复导入 Memory", async () => {
    const test = await engineForTest({ knowledgeErrorOnce: true });
    test.db.insert(documents).values({
      id: "doc-knowledge-retry",
      title: "Knowledge retry",
      version: 1,
      status: "active",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] },
    }).run();

    await expect(test.service.ingestCommittedDocument("doc-knowledge-retry", 1))
      .rejects.toThrow("knowledge unavailable");
    await expect(test.service.ingestCommittedDocument("doc-knowledge-retry", 1))
      .resolves.toMatchObject({ deduped: true, routeJobId: "route-job-1" });

    expect(test.db.select().from(ingestEvents).all()).toHaveLength(1);
    expect(test.memory.importToMemoryCore).toHaveBeenCalledTimes(1);
    expect(test.knowledge.submitCommittedDocument).toHaveBeenCalledTimes(2);
    test.sqlite.close();
  });

  it("reality-event ref：洞察+转录段 → 会议纪要，说话人标注", async () => {
    const test = await engineForTest();
    const startedAt = new Date("2026-08-01T10:00:00Z");
    test.db.insert(realityEvents).values({
      id: "re-1",
      title: "产品评审",
      status: "completed",
      processingState: "ready",
      captureDevice: { id: "cap-1", name: "测试采集端", kind: "desktop" } as RealityCaptureDevice,
      processingDevice: "test",
      audioSource: "microphone",
      transcript: "",
      transcriptSegments: [
        { id: "s1", text: "先过上一轮", beginTime: 0, endTime: 2000, speakerId: 0, version: 1, isFinal: true, manuallyEdited: false },
        { id: "s2", text: "同意", beginTime: 4000, endTime: 6000, speakerId: 1, version: 1, isFinal: true, manuallyEdited: false },
      ],
      insights: {
        summary: "评审通过",
        keyPoints: ["范围冻结"],
        decisions: ["进入开发"],
        actionItems: ["补齐测试"],
        people: [],
        projects: [],
        unresolvedQuestions: [],
      } as unknown as RealityInsights,
      markers: [] as RealityMarker[],
      startedAt,
      endedAt: new Date("2026-08-01T11:00:00Z"),
      createdAt: startedAt,
      updatedAt: startedAt,
    }).run();

    const result = await test.service.ingest({
      source: { ref: { sourceKind: "reality-event", sourceId: "re-1" } },
    });
    expect(result).toMatchObject({
      dataType: "meeting-minutes",
      detectedBy: "source-kind",
      title: "产品评审",
      originChannel: "reality",
    });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("## 摘要\n\n评审通过");
    expect(submitted.markdown).toContain("## 决议\n\n- 进入开发");
    expect(submitted.markdown).toContain("- **说话人1**（00:00）：先过上一轮");
    expect(submitted.markdown).toContain("- **说话人2**（00:04）：同意");
    expect(submitted.occurredAt).toBe("2026-08-01T11:00:00.000Z");

    // marker/important 等不进入 Markdown 的元数据更新不应制造新内容版本。
    test.sqlite.prepare("UPDATE reality_events SET important = 1, version = version + 1 WHERE id = ?")
      .run("re-1");
    const metadataOnlyRetry = await test.service.ingest({
      source: { ref: { sourceKind: "reality-event", sourceId: "re-1" } },
    });
    expect(metadataOnlyRetry.deduped).toBe(true);
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(1);
    test.sqlite.close();
  });

  it("connector-email ref：规范 Markdown → 台账 → Room/Wiki，内容更新生成新版本", async () => {
    const test = await engineForTest();
    const syncedAt = new Date("2026-08-20T01:00:00.000Z");
    test.db.insert(connectorEmails).values({
      id: "connector-email-1",
      ownerId: "local-user",
      service: "gmail",
      connectionName: "default",
      sourceRecordId: "gmail-source-1",
      sourceUpdatedAt: syncedAt,
      syncedAt,
      schemaVersion: 1,
      promptVersion: 1,
      contentHash: "sync-hash-1",
      extensionPayload: { attachmentList: [{ filename: "需求.pdf", mimeType: "application/pdf" }] },
      messageId: "message-1",
      threadId: "thread-1",
      senderName: "产品经理",
      senderAddress: "pm@example.com",
      recipients: [{ name: "研发", address: "dev@example.com" }],
      subject: "版本评审",
      sentAt: syncedAt,
      bodyText: "请确认本周版本范围。",
      labels: ["INBOX", "IMPORTANT"],
      hasAttachments: true,
    }).run();

    const first = await test.service.ingest({
      source: { ref: { sourceKind: "connector-email", sourceId: "connector-email-1" } },
    });
    expect(first).toMatchObject({
      dataType: "connector-email",
      source: { sourceKind: "mail", sourceVersion: 1 },
      pipelines: { room: true, wiki: true, memory: false },
      originChannel: "connector",
    });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain('source_kind: "mail"');
    expect(submitted.markdown).toContain("# 版本评审");
    expect(submitted.markdown).toContain("产品经理 <pm@example.com>");
    expect(submitted.markdown).toContain("请确认本周版本范围。");
    expect(submitted.markdown).toContain('"filename":"需求.pdf"');
    expect(submitted.entrySignals).toEqual({ sourceTag: "connector:gmail", threadId: "thread-1" });
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM parsed_contents").get()).toMatchObject({ c: 1 });
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM ingest_events").get()).toMatchObject({ c: 1 });

    const unchanged = await test.service.ingest({
      source: { ref: { sourceKind: "connector-email", sourceId: "connector-email-1" } },
    });
    expect(unchanged.deduped).toBe(true);
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(1);

    test.sqlite.prepare("UPDATE connector_emails SET synced_at = ? WHERE id = ?")
      .run(syncedAt.getTime() + 30_000, "connector-email-1");
    const resynced = await test.service.ingest({
      source: { ref: { sourceKind: "connector-email", sourceId: "connector-email-1" } },
    });
    expect(resynced.deduped).toBe(true);
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(1);

    test.sqlite.prepare("UPDATE connector_emails SET body_text = ?, synced_at = ? WHERE id = ?")
      .run("范围已确认，可以发布。", syncedAt.getTime() + 60_000, "connector-email-1");
    const updated = await test.service.ingest({
      source: { ref: { sourceKind: "connector-email", sourceId: "connector-email-1" } },
    });
    expect(updated).toMatchObject({ deduped: false, source: { sourceVersion: 2 } });
    expect(test.knowledge.submitEnvelope).toHaveBeenCalledTimes(2);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM ingest_events").get()).toMatchObject({ c: 2 });
    test.sqlite.close();
  });
});

// ───────────────────────── 扇出与错误语义 ─────────────────────────

describe("扇出语义：策略快照 / router 门 / 记忆失败不阻塞", () => {
  it("工程默认层 memory=false：只走 Room 链路，memoryResult=null", async () => {
    const test = await engineForTest({
      policyLayers: { project: new Map([["document", { room: true, wiki: true, memory: false }]]), deploy: new Map() },
    });
    const path = await tempFile("不走记忆.md", "# 内容");

    const result = await test.service.ingest({ source: { path } });
    expect(result.memoryResult).toBeNull();
    expect(result.routeJobId).toBe("route-job-1");
    expect(test.memory.importToMemoryCore).not.toHaveBeenCalled();
    // 台账快照记录了 memory=false（晋升/增量 ingest 读快照）
    const event = test.db.select().from(ingestEvents).all()[0]!
    expect(event.pipelines).toEqual({ room: true, wiki: true, memory: false });
    test.sqlite.close();
  });

  it("请求级覆盖 room=false：跳过 router 门与 Room 扇出，只进记忆", async () => {
    const test = await engineForTest({ routerEnabled: false });
    const path = await tempFile("只进记忆.md", "# 内容");
    const result = await test.service.ingest({
      source: { path },
      pipelines: { room: false, wiki: false, memory: true },
    });
    expect(result.routeJobId).toBeNull();
    expect(result.memoryResult).toMatchObject({ documentId: "mdoc-1" });
    expect(test.knowledge.submitEnvelope).not.toHaveBeenCalled();
    test.sqlite.close();
  });

  it("room 开启但 router 关闭 → router_disabled 400（镜像旧端点）", async () => {
    const test = await engineForTest({ routerEnabled: false });
    const path = await tempFile("要路由.md", "# 内容");
    await expect(test.service.ingest({ source: { path } }))
      .rejects.toMatchObject({ code: "router_disabled", statusCode: 400 });
    test.sqlite.close();
  });

  it("记忆链路失败：memoryResult={error}，事件照常、Room 链路照走", async () => {
    const test = await engineForTest({ memoryError: true });
    const path = await tempFile("记忆挂.md", "# 内容");
    const result = await test.service.ingest({ source: { path } });
    expect(result.memoryResult).toEqual({ error: "memorycore down" });
    expect(result.routeJobId).toBe("route-job-1");
    const event = test.db.select().from(ingestEvents).all()[0]!;
    expect(event.memoryResult).toEqual({ error: "memorycore down" });
    test.sqlite.close();
  });

  it("MemoryCore 未启用：memoryResult={error: memory_core_disabled} 不抛错", async () => {
    const test = await engineForTest({ memoryEnabled: false });
    const path = await tempFile("无记忆.md", "# 内容");
    const result = await test.service.ingest({ source: { path } });
    expect(result.memoryResult).toEqual({ error: "memory_core_disabled" });
    test.sqlite.close();
  });
});

// ───────────────────────── REST ─────────────────────────

describe("REST /v1/ingest", () => {
  async function appForTest(options?: EngineOptions) {
    const test = await engineForTest(options);
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(ingestRoutes(test.service));
    return { app, test };
  }

  it("POST path 形态 201 + 台账重复 200 deduped；GET 列表/详情", async () => {
    const { app, test } = await appForTest();
    const path = await tempFile("rest.md", "# REST 文档");
    const created = await app.inject({ method: "POST", url: "/v1/ingest", payload: { source: { path } } });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { eventId: string; dataType: string };
    expect(body.dataType).toBe("document");

    const again = await app.inject({ method: "POST", url: "/v1/ingest", payload: { source: { path } } });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { deduped: boolean }).deduped).toBe(true);

    const list = await app.inject({ method: "GET", url: "/v1/ingest?limit=10" });
    expect((list.json() as { items: unknown[]; total: number }).total).toBe(1);

    const detail = await app.inject({ method: "GET", url: `/v1/ingest/${body.eventId}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { id: string }).id).toBe(body.eventId);
    const missing = await app.inject({ method: "GET", url: "/v1/ingest/ing-不存在" });
    expect(missing.statusCode).toBe(404);
    await app.close();
    test.sqlite.close();
  });

  it("策略 API：GET 只读展示三层来源（无写接口）", async () => {
    const { app, test } = await appForTest({
      policyLayers: {
        project: new Map([["slides", { room: true, wiki: true, memory: true }]]),
        deploy: new Map([["document", { room: true, wiki: true, memory: false }]]),
      },
    });
    const list = await app.inject({ method: "GET", url: "/v1/ingest/policies" });
    const items = (list.json() as {
      items: {
        key: string;
        source: string;
        effective: { memory: boolean };
        projectDefaults: object | null;
        fileOverride: object | null;
      }[];
    }).items;
    const document = items.find((item) => item.key === "document")!;
    expect(document.source).toBe("deploy");
    expect(document.fileOverride).toEqual({ room: true, wiki: true, memory: false });
    expect(document.effective.memory).toBe(false);
    const slides = items.find((item) => item.key === "slides")!;
    expect(slides.source).toBe("project");
    expect(slides.effective.memory).toBe(true);
    expect(items.find((item) => item.key === "html")!.source).toBe("code");

    // 策略是配置文件（工程默认层 + 部署覆盖层）：没有 PUT/DELETE 写接口
    const put = await app.inject({
      method: "PUT",
      url: "/v1/ingest/policies/document",
      payload: { room: true, wiki: true, memory: false },
    });
    expect(put.statusCode).toBe(404);
    await app.close();
    test.sqlite.close();
  });

  it("错误映射：convert_failed 422 / ref_not_found 404", async () => {
    const { app, test } = await appForTest();
    const broken = await tempFile("报表.xlsx", "fake bytes");
    const convert = await app.inject({ method: "POST", url: "/v1/ingest", payload: { source: { path: broken } } });
    expect(convert.statusCode).toBe(422);
    expect((convert.json() as { error: string }).error).toBe("convert_failed");

    const missing = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: { source: { ref: { sourceKind: "file", sourceId: "file-x" } } },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
    test.sqlite.close();
  });
});

// ───────────────────────── knowledge 侧 wiki 快照过滤（§6.3） ─────────────────────────

describe("wiki 快照过滤：台账 wiki=false 的源只计链接分", () => {
  async function knowledgeForTest(routerEnabled = true) {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-wiki-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const service = new KnowledgeService(
      db,
      {
        baseUrl: "http://127.0.0.1:9", // 不可达：link-only 路径不应触碰 KS
        serviceId: "everroom",
        teamId: "everroom",
        dataDir,
        roomWikisEnabled: false,
        ingestDebounceMs: 600_000,
        routerEnabled,
        entityPromoteScore: 2.0,
        entityPromoteSources: 2,
        mergeAutoDice: 0.75,
        mergeJudgeDice: 0.6,
        llm: null,
        embeddingLlm: null,
        embeddingModel: "",
      },
      { info: () => {}, warn: () => {}, error: () => {} },
    );
    return { service, db, sqlite };
  }

  function seedLedgerEvent(
    db: Awaited<ReturnType<typeof knowledgeForTest>>["db"],
    sourceId: string,
    wiki: boolean,
  ) {
    db.insert(ingestEvents).values({
      id: `ing-${sourceId}-${wiki ? "on" : "off"}`,
      sourceKind: "file",
      sourceId,
      sourceVersion: 1,
      dataType: "document",
      detectedBy: "extension",
      title: "快照源",
      contentHash: `hash-${sourceId}`,
      parsedId: "parsed-1",
      pipelines: { room: true, wiki, memory: true },
      originChannel: "file",
    }).run();
  }

  it("router 关闭时已提交文档按权威 Room 走确定性直连", async () => {
    const test = await knowledgeForTest(false);
    test.db.insert(documents).values({
      id: "doc-direct",
      title: "Direct",
      version: 2,
      status: "active",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
    }).run();
    test.db.insert(roomDocumentLinks).values({ roomId: "room-direct", documentId: "doc-direct" }).run();
    const direct = vi.spyOn(test.service as unknown as {
      enqueueEntryIngest(document: unknown, roomId: string): string;
    }, "enqueueEntryIngest").mockReturnValue("direct-ingest-job");
    const routed = vi.spyOn(test.service, "submitEnvelope");

    expect(test.service.submitCommittedDocument({
      documentId: "doc-direct",
      sourceVersion: 2,
      title: "Direct",
      markdown: "body",
    })).toEqual({ queued: true, jobId: "direct-ingest-job" });
    expect(direct).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-direct", roomId: "room-direct" }), "room-direct");
    expect(routed).not.toHaveBeenCalled();
    expect(test.db.select().from(jobs).all()).toEqual([]);
    test.service.dispose();
    test.sqlite.close();
  });

  it("启动恢复合并同一实体的历史晋升任务", async () => {
    const test = await knowledgeForTest();
    test.db.insert(entitiesTable).values({
      id: "ent-idempotent",
      name: "幂等实体",
      kind: "项目",
      status: "promoting",
    }).run();
    test.db.insert(jobs).values([
      {
        id: "promote-oldest",
        type: "knowledge.entity-promote",
        status: "pending",
        payload: { entityId: "ent-idempotent", manual: true, previousStatus: "ready" },
        createdAt: new Date(1_000),
      },
      {
        id: "promote-running",
        type: "knowledge.entity-promote",
        status: "running",
        payload: { entityId: "ent-idempotent", manual: true, previousStatus: "ready" },
        createdAt: new Date(2_000),
      },
      {
        id: "promote-latest",
        type: "knowledge.entity-promote",
        status: "pending",
        payload: { entityId: "ent-idempotent", manual: true, previousStatus: "ready" },
        createdAt: new Date(3_000),
      },
    ]).run();

    test.service.start();

    const promotionJobs = test.db.select().from(jobs).all()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    expect(promotionJobs.map((job) => [job.id, job.status])).toEqual([
      ["promote-oldest", "pending"],
      ["promote-running", "cancelled"],
      ["promote-latest", "cancelled"],
    ]);
    expect(test.service.promotionProgress("ent-idempotent")?.jobId).toBe("promote-oldest");
    test.service.dispose();
    test.sqlite.close();
  });

  it("Room 晋升使用独立 worker，不等待正在执行的慢知识任务", async () => {
    const test = await knowledgeForTest();
    test.db.insert(jobs).values({
      id: "route-slow",
      type: "knowledge.route",
      status: "pending",
      payload: { sourceKind: "file", sourceId: "file-1", sourceVersion: 1 },
      createdAt: new Date(1_000),
    }).run();

    const executionOrder: string[] = [];
    let signalRouteStarted!: () => void;
    let releaseRoute!: () => void;
    const routeStarted = new Promise<void>((resolve) => { signalRouteStarted = resolve; });
    const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
    const internal = test.service as unknown as {
      drain(): Promise<void>;
      drainPromotions(): Promise<void>;
      processJob(job: { id: string; type: string }, lockKey: string | null): Promise<void>;
    };
    internal.processJob = vi.fn(async (job: { id: string; type: string }) => {
      executionOrder.push(`${job.id}:start`);
      if (job.id === "route-slow") {
        signalRouteStarted();
        await routeGate;
      }
      test.sqlite.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run(job.id);
      executionOrder.push(`${job.id}:done`);
    });

    const slowDrain = internal.drain();
    await routeStarted;
    test.db.insert(jobs).values({
      id: "promote-new",
      type: "knowledge.entity-promote",
      status: "pending",
      payload: { entityId: "ent-new", manual: true, previousStatus: "ready" },
      createdAt: new Date(2_000),
    }).run();

    await internal.drainPromotions();

    expect(executionOrder).toEqual([
      "route-slow:start",
      "promote-new:start",
      "promote-new:done",
    ]);

    releaseRoute();
    await slowDrain;
    expect(executionOrder.at(-1)).toBe("route-slow:done");
    test.service.dispose();
    test.sqlite.close();
  });

  it("wikiDisabledForSource：无台账行=旧入口不动；有行看快照；多次取最新", async () => {
    const test = await knowledgeForTest();
    expect(wikiDisabledForSource(test.db, "file", "file-旧入口")).toBe(false);
    seedLedgerEvent(test.db, "file-a", false);
    expect(wikiDisabledForSource(test.db, "file", "file-a")).toBe(true);
    seedLedgerEvent(test.db, "file-b", true);
    expect(wikiDisabledForSource(test.db, "file", "file-b")).toBe(false);
    test.sqlite.close();
  });

  it("runIngestJob：快照 wiki=false → 不碰 KS，决策 confirmed + linkOnly 标记", async () => {
    const test = await knowledgeForTest();
    seedLedgerEvent(test.db, "file-off", false);
    test.db.insert(routeDecisions).values({
      id: "dec-1",
      sourceKind: "file",
      sourceId: "file-off",
      sourceVersion: 1,
      sourceTitle: "仅链接",
      sourceMarkdown: "# 仅链接内容",
      primaryRoomId: "room-1",
      confidence: 1,
      decidedBy: "rule",
      status: "auto",
    }).run();

    const internal = test.service as unknown as {
      runIngestJob(payload: { sourceKind: string; sourceId: string; sourceVersion: number; roomId: string; decisionId: string }): Promise<void>;
    };
    await internal.runIngestJob({
      sourceKind: "file", sourceId: "file-off", sourceVersion: 1, roomId: "room-1", decisionId: "dec-1",
    });

    const decision = test.db.select().from(routeDecisions).all()[0]!;
    expect(decision.status).toBe("confirmed");
    expect(linkOnlyRoomsOf(decision)).toEqual(["room-1"]);
    // 懒 ensure：link-only 不建 wiki，也不落 rooms 账本
    expect(ingestLedgerOf(decision)).toEqual([]);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM room_wikis").get()).toMatchObject({ c: 0 });
    test.sqlite.close();
  });

  it("ingestEntityBacklog：晋升补账同样跳过 wiki=false 源", async () => {
    const test = await knowledgeForTest();
    seedLedgerEvent(test.db, "file-off", false);
    test.db.insert(routeDecisions).values({
      id: "dec-2",
      sourceKind: "file",
      sourceId: "file-off",
      sourceVersion: 1,
      sourceTitle: "仅链接",
      sourceMarkdown: "# 仅链接内容",
      primaryRoomId: "room-r",
      confidence: 1,
      decidedBy: "resolution",
      status: "auto",
    }).run();
    test.db.insert(entitiesTable).values({
      id: "ent-1",
      name: "目标实体",
      kind: "项目",
      status: "room",
      roomId: "room-r",
    }).run();
    test.db.insert(entityDocLinks).values({
      id: "link-1",
      entityId: "ent-1",
      sourceKind: "file",
      sourceId: "file-off",
      sourceVersion: 1,
      role: "primary",
      salience: 0.9,
      decidedBy: "resolution",
    }).run();

    const internal = test.service as unknown as { ingestEntityBacklog(entityId: string): Promise<void> };
    await internal.ingestEntityBacklog("ent-1");

    const decision = test.db.select().from(routeDecisions).all()[0]!;
    expect(linkOnlyRoomsOf(decision)).toEqual(["room-r"]);
    expect(ingestLedgerOf(decision)).toEqual([]);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM room_wikis").get()).toMatchObject({ c: 0 });
    test.sqlite.close();
  });
});

// ───────────────────────── 连接器接入 ─────────────────────────

describe("连接器接入：归一化直传共用台账与扇出", () => {
  it("邮件：dataType=mail 三链路扇出，台账 kind=mail，幂等去重", async () => {
    const test = await engineForTest();
    const unit = {
      kind: "mail" as const,
      sourceId: "connector:gmail:c1:mail:m-1",
      dataType: "mail" as const,
      title: "季度总结",
      markdown: "# 季度总结\n\n正文",
    };

    const first = await test.service.ingestConnector(unit);
    expect(first).toMatchObject({
      deduped: false,
      dataType: "mail",
      pipelines: { room: true, wiki: true, memory: true },
      routeJobId: "route-job-1",
    });
    expect(first.memoryResult).toMatchObject({ documentId: "mdoc-1" });
    expect(test.memory.importToMemoryCore).toHaveBeenCalledWith(expect.objectContaining({
      callerRef: unit.sourceId,
      title: "季度总结",
    }));

    // 闸1：同源同指纹重进零成本跳过
    const again = await test.service.ingestConnector(unit);
    expect(again.deduped).toBe(true);
    expect(test.sqlite.prepare("SELECT COUNT(*) c FROM ingest_events").get()).toMatchObject({ c: 1 });
    const event = test.sqlite.prepare("SELECT * FROM ingest_events").get() as Record<string, unknown>;
    expect(event.source_kind).toBe("mail");
    expect(event.origin_channel).toBe("connector");
    test.sqlite.close();
  });

  it("router 未开启时显式降级为仅记忆链路（引擎 room 依赖 router）", async () => {
    const test = await engineForTest();
    const result = await test.service.ingestConnector({
      kind: "mail",
      sourceId: "connector:google-calendar:c1:calendar:ev-1",
      dataType: "calendar",
      title: "评审会",
      markdown: "# 评审会\n\n过方案",
      pipelines: { room: false, wiki: false, memory: true },
    });
    expect(result.pipelines).toEqual({ room: false, wiki: false, memory: true });
    expect(result.routeJobId).toBeNull();
    expect(result.memoryResult).toMatchObject({ documentId: "mdoc-1" });
    test.sqlite.close();
  });
});


// ───────────────────────── U2 格式转换（office/html/csv → md） ─────────────────────────

describe("U2 格式扩展：确定性转换器", () => {
  it("csv → GFM 表（spreadsheet 类型，memory 默认关）", async () => {
    const test = await engineForTest();
    const path = await tempFile("名单.csv", "姓名,角色\n甲,负责人\n乙,评审");
    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({ dataType: "spreadsheet", detectedBy: "extension" });
    // 注册表默认：表格 memory=false（L1 提炼噪音大）
    expect(result.pipelines.memory).toBe(false);
    expect(result.memoryResult).toBeNull();
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("| 姓名 | 角色 |");
    expect(submitted.markdown).toContain("| --- | --- |");
    expect(submitted.markdown).toContain("| 甲 | 负责人 |");
    test.sqlite.close();
  });

  it("csv 引号与竖线转义", async () => {
    const test = await engineForTest();
    const path = await tempFile("引号.csv", "a,b\n\"x,1\",\"y|z\"\n\"line\nbreak\",tail");
    const result = await test.service.ingest({ source: { path } });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("x,1");
    expect(submitted.markdown).toContain("y\\|z");
    expect(submitted.markdown).toContain("line break");
    test.sqlite.close();
  });

  it("html → md（heading/list/链接）", async () => {
    const test = await engineForTest();
    const path = await tempFile("网页.html", "<html><body><h1>标题</h1><p>段落<a href='x'>链</a></p><ul><li>项</li></ul></body></html>");
    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({ dataType: "html", pipelines: { memory: false } });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("# 标题");
    expect(submitted.markdown).toContain("[链](x)");
    // turndown 默认列表缩进：`-   项`
    expect(submitted.markdown).toMatch(/-\s+项/);
    test.sqlite.close();
  });

  it("eml -> clean Markdown through the raw MIME converter", async () => {
    const test = await engineForTest();
    const path = await tempFile("reply.eml", [
      "From: Sender <sender@example.com>",
      "To: Receiver <receiver@example.com>",
      "Subject: Release plan",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "",
      '<style>.noise{color:red}</style><p>Current <strong>reply</strong></p><div class="gmail_quote">Old body</div>',
    ].join("\r\n"));
    const result = await test.service.ingest({ source: { path } });

    expect(result).toMatchObject({ dataType: "email", detectedBy: "extension", pipelines: { memory: false } });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toBe("Current **reply**");
    expect(submitted.markdown).not.toMatch(/noise|color:red|Old body/);
    test.sqlite.close();
  });

  it("xlsx → 每 sheet 一表（ExcelJS 生成的真实工件）", async () => {
    const test = await engineForTest();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("目标");
    sheet.addRow(["指标", "数值"]);
    sheet.addRow(["留存", "78%"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);

    const dir = await mkdtemp(join(tmpdir(), "nxcore-ingest-xlsx-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "指标.xlsx");
    await writeFile(path, buffer);

    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({ dataType: "spreadsheet", title: "指标" });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("## 目标");
    expect(submitted.markdown).toContain("| 指标 | 数值 |");
    expect(submitted.markdown).toContain("| 留存 | 78% |");
    test.sqlite.close();
  });

  it("pptx → 页级列表（JSZip 造最小工件）", async () => {
    const test = await engineForTest();
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld><p:cSld><p:spTree><a:t>封面要点</a:t><a:t>第一点</a:t></p:spTree></p:cSld></p:sld>");
    zip.file("ppt/slides/slide2.xml", "<p:sld><a:t>第二页</a:t><a:t>另一点</a:t></p:sld>");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const dir = await mkdtemp(join(tmpdir(), "nxcore-ingest-pptx-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "演示.pptx");
    await writeFile(path, buffer);

    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({ dataType: "slides", pipelines: { memory: false } });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("## 第 1 页：封面要点");
    expect(submitted.markdown).toContain("- 第一点");
    expect(submitted.markdown).toContain("## 第 2 页：第二页");
    test.sqlite.close();
  });

  it("docx → md（JSZip 造最小 OOXML 工件，mammoth 解析）", async () => {
    const test = await engineForTest();
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段正文</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>');
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const dir = await mkdtemp(join(tmpdir(), "nxcore-ingest-docx-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "报告.docx");
    await writeFile(path, buffer);

    const result = await test.service.ingest({ source: { path } });
    expect(result).toMatchObject({ dataType: "office-doc" });
    const submitted = (test.knowledge.submitEnvelope as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(submitted.markdown).toContain("第一段正文");
    expect(submitted.markdown).toContain("第二段");
    test.sqlite.close();
  });
});

describe("消费端截断 truncateUtf8（§7）", () => {
  it("不超限原样返回；超限按字节截断不劈多字节字符并附标记", () => {
    expect(truncateUtf8("短文", 100, "<!-- M -->")).toBe("短文");
    const long = "汉".repeat(1000); // 3 字节/字
    const cut = truncateUtf8(long, 1000, "<!-- M -->");
    expect(cut.endsWith("<!-- M -->")).toBe(true);
    // 截断后主体（去标记）不超 1000 字节，且不含半个字符（U+FFFD）
    const body = cut.slice(0, cut.indexOf("\n\n<!--"));
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(1000);
    expect(body).not.toContain("�");
  });
});
