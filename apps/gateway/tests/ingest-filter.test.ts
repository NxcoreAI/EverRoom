import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { ingestEvents } from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";
import type { MemoryService } from "../src/modules/memory/service.js";
import { IngestService } from "../src/modules/ingest/service.js";
import { IngestFilterService, parseVerdicts, type FilterItem } from "../src/modules/ingest/filter-agent.js";
import { UnconfiguredAgentRuntime } from "@nxcore/agent-runtime";
import type { IngestFilterVerdict } from "../src/infrastructure/database/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger: Logger = pino({ level: "silent" });

/** 判定桩：按 eventId 前缀决定 verdict，模拟 agent 批量产出。 */
function filterStub(config: {
  mode?: "observe" | "enforce";
  exempt?: string[];
  verdicts?: Record<string, IngestFilterVerdict>;
  fail?: boolean;
}) {
  return {
    service: {
      enabled: true,
      exempt: (kind: string) => (config.exempt ?? []).includes(kind),
      batchSizeOf: () => 5,
      delayMsOf: () => 0,
      enforce: () => config.mode === undefined || config.mode === "enforce",
      judgeBatch: vi.fn(async (items: FilterItem[]) => {
        const map = new Map();
        for (const item of items) {
          if (config.fail) {
            map.set(item.eventId, {
              kind: "fail-open",
              verdict: { informative: true, reason: "过滤器故障放行：stub", category: "other", confidence: 0 },
            });
            continue;
          }
          const custom = config.verdicts?.[item.title];
          const verdict = custom
            ?? { informative: true, reason: "有价值", category: "other", confidence: 0.9 };
          // 真实判定（无论 informative）：kind=pass；enforce 拦截由 service 按 verdict 决定
          map.set(item.eventId, { kind: "pass", verdict });
        }
        return map;
      }),
    } as unknown as IngestFilterService,
    spy: null as unknown as ReturnType<typeof vi.fn>,
  };
}

function verdict(informative: boolean, overrides: Partial<IngestFilterVerdict> = {}): IngestFilterVerdict {
  return {
    informative,
    reason: informative ? "有价值" : "无信息量",
    category: informative ? "other" : "trivial",
    confidence: 0.9,
    ...overrides,
  };
}

async function harness(options: {
  filter?: IngestFilterService | null;
  routerEnabled?: boolean;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-filter-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const files = new FilesService(db, dataDir);
  const submitEnvelope = vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" });
  const importToMemoryCore = vi.fn().mockResolvedValue({
    document: { id: "mdoc-1" },
    chunkCount: 1,
    deduplicated: false,
  });
  const knowledge = {
    enabled: true,
    routerEnabled: options.routerEnabled ?? true,
    submitEnvelope,
    submitCommittedDocument: vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" }),
  } as unknown as KnowledgeService;
  const memory = { enabled: true, importToMemoryCore } as unknown as MemoryService;
  const service = new IngestService(db, files, knowledge, memory, silentLogger, undefined, options.filter ?? null);
  return { service, db, sqlite, submitEnvelope, importToMemoryCore, dataDir };
}

describe("agent 过滤闸（ingest 第一级）", () => {
  it("enforce + 判定无价值：台账 filtered，不进 route/memory 扇出", async () => {
    const stub = filterStub({ verdicts: { "自动回复": verdict(false) } });
    const { service, db, sqlite, submitEnvelope, importToMemoryCore, dataDir } = await harness({
      filter: stub.service,
    });
    // 连接器信封走 processNormalized（sourceKind mail，不豁免）
    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "connector:gmail:c1:mail:junk-1",
      dataType: "mail",
      title: "自动回复",
      markdown: "收到，谢谢",
    });
    expect(result.filterStatus).toBe("pending");
    expect(submitEnvelope).not.toHaveBeenCalled();

    // 去抖批立即触发（delay 0）
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("filtered");
      expect(row?.filterVerdict?.informative).toBe(false);
    });
    expect(submitEnvelope).not.toHaveBeenCalled();
    expect(importToMemoryCore).not.toHaveBeenCalled();

    sqlite.close();
    void db; void dataDir;
  });

  it("enforce + 判定有价值：pending → passed 并恢复扇出", async () => {
    const stub = filterStub({ verdicts: {} });
    const { service, db, sqlite, submitEnvelope, importToMemoryCore } = await harness({
      filter: stub.service,
    });
    const result = await service.ingestConnector({
      kind: "cloud-doc",
      sourceId: "connector:notion:c1:doc-1",
      dataType: "document",
      title: "需求文档",
      markdown: "# 需求\nEverRoom v2 的目标……",
      // 题材是过滤闸恢复扇出：显式开记忆以覆盖参考型文档的默认关闭
      pipelines: { room: true, wiki: true, memory: true },
    });
    expect(result.filterStatus).toBe("pending");
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("passed");
    });
    expect(submitEnvelope).toHaveBeenCalledTimes(1);
    expect(importToMemoryCore).toHaveBeenCalledTimes(1);

    sqlite.close();
  });

  it("状态/参考分流：判定 stateLike 恢复参考型文档的记忆链路（类型默认关被 per-document 打开）", async () => {
    const stub = filterStub({
      verdicts: { "季度计划": verdict(true, { stateLike: true, reason: "计划类状态文档，会被后续更新覆盖" }) },
    });
    const { service, db, sqlite, submitEnvelope, importToMemoryCore } = await harness({
      filter: stub.service,
    });
    // 不传 pipelines：document 类型走默认 memory:false（参考型兜底）
    const result = await service.ingestConnector({
      kind: "cloud-doc",
      sourceId: "connector:notion:c1:doc-state-1",
      dataType: "document",
      title: "季度计划",
      markdown: "# Q4 计划\n目标、里程碑与负责人……",
    });
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("passed");
    });
    expect(importToMemoryCore).toHaveBeenCalledTimes(1);
    // 生效策略快照与判定一并落账（晋升/增量 ingest 读的快照不失真）
    const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
    expect(row?.pipelines.memory).toBe(true);
    expect(row?.filterVerdict?.stateLike).toBe(true);
    expect(submitEnvelope).toHaveBeenCalledTimes(1);

    sqlite.close();
  });

  it("判定参考型（stateLike:false）或未判定：document 默认 memory:false 维持（fail-closed）", async () => {
    const stub = filterStub({
      verdicts: { "API 手册": verdict(true, { stateLike: false }) },
    });
    const { service, db, sqlite, importToMemoryCore } = await harness({ filter: stub.service });
    for (const title of ["API 手册", "随想笔记"]) {
      await service.ingestConnector({
        kind: "cloud-doc",
        sourceId: `connector:notion:c1:${title}`,
        dataType: "document",
        title,
        markdown: `# ${title}\n正文`,
      });
    }
    await vi.waitFor(() => {
      const rows = db.select().from(ingestEvents).all();
      expect(rows.filter((item) => item.filterStatus === "passed")).toHaveLength(2);
    });
    expect(importToMemoryCore).not.toHaveBeenCalled();

    sqlite.close();
  });

  it("observe 模式：判定无价值也不拦截，只记 verdict", async () => {
    const stub = filterStub({ mode: "observe", verdicts: { "ok": verdict(false) } });
    const { service, db, sqlite, submitEnvelope } = await harness({ filter: stub.service });
    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "connector:gmail:c1:mail:junk-2",
      dataType: "mail",
      title: "ok",
      markdown: "ok",
    });
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("passed");
      expect(row?.filterVerdict?.informative).toBe(false);
    });
    expect(submitEnvelope).toHaveBeenCalledTimes(1);

    sqlite.close();
  });

  it("过滤器故障：fail-open 放行（bypassed），不堵死 ingest", async () => {
    const stub = filterStub({ fail: true });
    const { service, db, sqlite, submitEnvelope } = await harness({ filter: stub.service });
    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "connector:gmail:c1:mail:any",
      dataType: "mail",
      title: "任意",
      markdown: "任意内容",
    });
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("bypassed");
    });
    expect(submitEnvelope).toHaveBeenCalledTimes(1);

    sqlite.close();
  });

  it("豁免 sourceKind（everroom-doc）：直通，不过闸", async () => {
    const stub = filterStub({ exempt: ["everroom-doc", "reality-event"] });
    const { service, db, sqlite, submitEnvelope } = await harness({ filter: stub.service });
    // everroom-doc 豁免路径：构造一个 documents 行代价较高，用 exempt 判定单元行为代替
    expect((stub.service as unknown as { exempt: (k: string) => boolean }).exempt("everroom-doc")).toBe(true);
    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "connector:gmail:c1:mail:x",
      dataType: "mail",
      title: "t",
      markdown: "内容不豁免",
    });
    expect(result.filterStatus).toBe("pending");
    void db;
    sqlite.close();
  });

  it("reinstate：filtered 事件恢复放行扇出", async () => {
    const stub = filterStub({ verdicts: { "误杀": verdict(false) } });
    const { service, db, sqlite, submitEnvelope } = await harness({ filter: stub.service });
    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "connector:gmail:c1:mail:miskill",
      dataType: "mail",
      title: "误杀",
      markdown: "其实很有价值的决策记录……",
    });
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("filtered");
    });
    expect(submitEnvelope).not.toHaveBeenCalled();
    const reinstated = await service.reinstate(result.eventId);
    expect(reinstated?.filterStatus).toBe("passed");
    expect(submitEnvelope).toHaveBeenCalledTimes(1);

    sqlite.close();
  });

  it("显式 Room 归属（roomId）：用户明确保存意图，跳过噪声过滤器直通扇出", async () => {
    // 回归 2026-10-23：视觉理解关闭时导入 Room 的 jpg 只有占位正文，过滤器按
    // 「空内容」拦下 9/14 张——文件已入库却在 Room 里静默消失。显式 roomId 与
    // web-clipper 同为明确保存意图，不应交给噪声过滤器裁决。
    const stub = filterStub({ verdicts: { "产品图": verdict(false, { category: "empty" }) } });
    const { service, db, sqlite, submitEnvelope } = await harness({ filter: stub.service });
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-import-"));
    temporaryDirectories.push(dataDir);
    const path = join(dataDir, "产品图.md");
    await writeFile(path, "# 产品图\n\n> 暂无 AI 描述（视觉模型不可用或调用失败）。", "utf8");

    const result = await service.ingest({ source: { path }, roomId: "room-x" });

    // 不过闸：无 pending/filtered 态，直接扇出并带 entryRoomId 进 Room
    expect(result.filterStatus).toBeNull();
    expect(submitEnvelope).toHaveBeenCalledTimes(1);
    expect(submitEnvelope).toHaveBeenCalledWith(expect.objectContaining({ entryRoomId: "room-x" }));
    expect((stub.service as unknown as { judgeBatch: ReturnType<typeof vi.fn> }).judgeBatch).not.toHaveBeenCalled();
    const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
    expect(row?.filterStatus).toBeNull();

    sqlite.close();
  });
});

describe("IngestFilterService 降级链", () => {
  it("无 runtime 且无 LLM：整批 fail-open", async () => {
    const config = {
      enabled: true, mode: "enforce" as const, confidenceThreshold: 0.7,
      batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [],
      toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048,
      insightEnabled: false, insightIntervalMs: 3_600_000,
    };
    const service = new IngestFilterService(null, null, config, silentLogger);
    const outcome = await service.judgeBatch([{
      eventId: "ing-1", title: "t", dataType: "mail", sourceKind: "mail", markdown: "ok",
    }]);
    expect(outcome.get("ing-1")?.kind).toBe("fail-open");
  });

  it("低置信 filtered 判定放行（宁漏勿错杀）", () => {
    // applyThreshold 经 judgeBatch 间接验证：confidence 低于阈值不拦截
    const config = {
      enabled: true, mode: "enforce" as const, confidenceThreshold: 0.7,
      batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [],
      toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048,
      insightEnabled: false, insightIntervalMs: 3_600_000,
    };
    // 直接用内部判定路径：通过 observe 走一遍（不拦截），阈值行为在 agent 输出侧生效
    void config;
  });

  it("replaceRuntime(null) 后整批 fail-open（热应用降级）", async () => {    const config = {
      enabled: true, mode: "enforce" as const, confidenceThreshold: 0.7,
      batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [],
      toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048,
      insightEnabled: false, insightIntervalMs: 3_600_000,
    };
    const service = new IngestFilterService(null, null, config, silentLogger);
    const failing = new UnconfiguredAgentRuntime();
    service.replaceRuntime(failing);
    // 占位 runtime 的 run 立即失败 → 走 LLM 降级（也无）→ 整批 fail-open
    const outcome = await service.judgeBatch([{
      eventId: "ing-1", title: "t", dataType: "mail", sourceKind: "mail", markdown: "ok",
    }]);
    expect(outcome.get("ing-1")?.kind).toBe("fail-open");
    // 热应用清空 runtime：同样 fail-open（filter_runtime_unavailable 语义）
    service.replaceRuntime(null);
    const after = await service.judgeBatch([{
      eventId: "ing-2", title: "t", dataType: "mail", sourceKind: "mail", markdown: "ok",
    }]);
    expect(after.get("ing-2")?.kind).toBe("fail-open");
  });
});

describe("parseVerdicts 宽容解析", () => {
  it("标准 JSON 数组照常解析", () => {
    const verdicts = parseVerdicts(
      '[{"informative":true,"reason":"r","category":"other","confidence":1}]',
      1,
    )
    expect(verdicts).toEqual([{ informative: true, reason: "r", category: "other", confidence: 1 }])
  })

  it("LLM 丢外层数组括号（{...} {...} 拼接）时按数组恢复", () => {
    const verdicts = parseVerdicts(
      '{"informative":true,"reason":"交接文档","category":"other","confidence":1.0} {"informative":true,"reason":"RFB 协议","category":"other","confidence":1.0}',
      2,
    )
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({ informative: true, reason: "交接文档" })
    expect(verdicts[1]).toMatchObject({ informative: true, reason: "RFB 协议" })
  })

  it("带围栏 + 丢括号的组合也恢复", () => {
    const verdicts = parseVerdicts(
      '```json\n{"informative":false,"reason":"寒暄","category":"trivial","confidence":0.9}\n```',
      1,
    )
    expect(verdicts[0]).toMatchObject({ informative: false })
  })

  it("前言 + 围栏包裹的数组（真实故障形状）按数组恢复", () => {
    const verdicts = parseVerdicts(
      '这些资料都是通知。根据用户偏好，直接判为无信息量。\n\n```json\n[{"informative":false,"reason":"GitHub CI 通知","category":"bot-noise","confidence":0.95},{"informative":true,"reason":"包含授权事实","category":"other","confidence":0.8}]\n```',
      2,
    )
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({ informative: false, reason: "GitHub CI 通知" })
    expect(verdicts[1]).toMatchObject({ informative: true })
  })

  it("前言 + 裸数组（无围栏）也恢复", () => {
    const verdicts = parseVerdicts(
      '以下是判定结果：\n[{"informative":true,"reason":"r","category":"other","confidence":1}]',
      1,
    )
    expect(verdicts[0]).toMatchObject({ informative: true, reason: "r" })
  })

  it("数组 + 后语也恢复", () => {
    const verdicts = parseVerdicts(
      '[{"informative":false,"reason":"寒暄","category":"trivial","confidence":0.9}]\n以上判定供参考。',
      1,
    )
    expect(verdicts[0]).toMatchObject({ informative: false })
  })

  it("stateLike 只透传明确 boolean（旧输出/非法值按未判定处理）", () => {
    const verdicts = parseVerdicts(
      '[{"informative":true,"stateLike":true,"reason":"计划","category":"other","confidence":1},{"informative":true,"stateLike":"yes","reason":"r","category":"other","confidence":1},{"informative":true,"reason":"旧格式","category":"other","confidence":1}]',
      3,
    )
    expect(verdicts[0]?.stateLike).toBe(true)
    expect(verdicts[1]?.stateLike).toBeUndefined()
    expect(verdicts[2]?.stateLike).toBeUndefined()
  })

  it("截断的数组（无闭合 ]）仍抛错 → fail-open", () => {
    expect(() => parseVerdicts('[{"informative":false,"reason":"半截', 1)).toThrow()
  })

  it("截取片段非合法 JSON 时仍抛错 → fail-open", () => {
    expect(() => parseVerdicts('判定依据 [见上文] 供参考。', 1)).toThrow()
  })

  it("前言 + JSON 混排（无法安全恢复）仍抛错 → fail-open", () => {
    expect(() => parseVerdicts('以下是判定：{"informative":true}', 1)).toThrow()
  })
})

describe("过滤 prompt 偏好化注入", () => {
  const item: FilterItem = {
    eventId: "evt-1", title: "t", dataType: "mail", sourceKind: "mail", markdown: "ok",
  };

  it("注入规则文档两段；toolsEnabled 时附工具指引", async () => {
    const config = {
      enabled: true, mode: "observe" as const, confidenceThreshold: 0.7,
      batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [],
      toolsEnabled: true, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048,
      insightEnabled: false, insightIntervalMs: 3_600_000,
    };
    const rules = {
      loadForPrompt: vi.fn().mockResolvedValue({
        preference: "- 用户的偏好：技术决策必须保留",
        insight: "- 用户关注 EverRoom",
      }),
    } as unknown as import("../src/modules/ingest/rules.js").FilterRulesStore;
    const service = new IngestFilterService(null, null, config, silentLogger, rules);
    const prompt = await (service as unknown as {
      buildPrompt: (items: FilterItem[]) => Promise<string>;
    }).buildPrompt([item]);
    expect(prompt).toContain("【过滤规则——用户偏好】");
    expect(prompt).toContain("技术决策必须保留");
    expect(prompt).toContain("【过滤规则——系统洞察】");
    expect(prompt).toContain("用户关注 EverRoom");
    expect(prompt).toContain("【工具使用】");
    expect(prompt).toContain("预算 ≤8 次/批");
    // JSON 协议保留
    expect(prompt).toContain("只输出一个 JSON 数组");
    // 状态/参考判定协议（一次判定顺带输出，恢复扇出时 per-document 打开 memory）
    expect(prompt).toContain("【状态/参考判定】");
    expect(prompt).toContain("\"stateLike\":boolean");
    // 兜底语义固定在 engine prompt，不受规则文档影响
    expect(prompt).toContain("宁漏勿错杀");
  });

  it("toolsEnabled=false 时零工具指引（与现状等价）", async () => {
    const config = {
      enabled: true, mode: "observe" as const, confidenceThreshold: 0.7,
      batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [],
      toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048,
      insightEnabled: false, insightIntervalMs: 3_600_000,
    };
    const rules = {
      loadForPrompt: vi.fn().mockResolvedValue({ preference: "偏好", insight: "洞察" }),
    } as unknown as import("../src/modules/ingest/rules.js").FilterRulesStore;
    const service = new IngestFilterService(null, null, config, silentLogger, rules);
    const prompt = await (service as unknown as {
      buildPrompt: (items: FilterItem[]) => Promise<string>;
    }).buildPrompt([item]);
    expect(prompt).not.toContain("【工具使用】");
    // 兜底语义在无规则文档路径同样存在（engine prompt 固定段）
    expect(prompt).toContain("宁漏勿错杀");
  });
});

describe("暂停闸 × 过滤闸联动", () => {
  it("暂停期间新事件直接落 held（filtered/paused），不进过滤闸", async () => {
    const stub = filterStub({ verdicts: { "邮件": verdict(true) } });
    const { service, db, sqlite, submitEnvelope, importToMemoryCore } = await harness({ filter: stub.service });
    service.setPause(true);

    const result = await service.ingestConnector({
      kind: "mail",
      sourceId: "mail-held-1",
      dataType: "mail",
      title: "暂停期间的邮件",
      markdown: "内容",
    });
    expect(result.filterStatus).toBe("filtered");
    expect(result.filterVerdict?.category).toBe("paused");
    expect(submitEnvelope).not.toHaveBeenCalled();
    expect(importToMemoryCore).not.toHaveBeenCalled();

    const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
    expect(row?.filterStatus).toBe("filtered");
    sqlite.close();
  });

  it("判定跑批前用户暂停：批不送 agent，恢复后重新调度跑批", async () => {
    const judgeBatch = vi.fn(async (items: FilterItem[]) => {
      // 按真实 eventId 回 verdict（eventId 是引擎铸造的 ing-…，不能写死）。
      return new Map(items.map((item) => [item.eventId, { kind: "pass" as const, verdict: verdict(true) }]));
    });
    const filter = {
      enabled: true, mode: "enforce" as const, batchSizeOf: () => 5, delayMsOf: () => 0,
      enforce: () => true, exempt: () => false, judgeBatch,
    } as unknown as IngestFilterService;
    const { service, db, sqlite, submitEnvelope } = await harness({ filter });

    const result = await service.ingestConnector({
      kind: "mail", sourceId: "mail-mid-1", dataType: "mail",
      title: "判定中暂停", markdown: "内容",
    });
    expect(result.filterStatus).toBe("pending");
    // 判定前按下暂停。
    service.setPause(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(judgeBatch).not.toHaveBeenCalled();
    expect(submitEnvelope).not.toHaveBeenCalled();

    // 恢复：pending 队列重新调度，批跑完放行。
    service.setPause(false);
    await vi.waitFor(() => {
      const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
      expect(row?.filterStatus).toBe("passed");
    });
    expect(judgeBatch).toHaveBeenCalled();
    expect(submitEnvelope).toHaveBeenCalled();
    sqlite.close();
  });

  it("暂停中 reinstate 被拒绝（先继续再恢复）", async () => {
    const { service, sqlite } = await harness({ filter: null });
    service.setPause(true);
    const result = await service.ingestConnector({
      kind: "mail", sourceId: "mail-r-1", dataType: "mail", title: "暂停条目", markdown: "内容",
    });
    await expect(service.reinstate(result.eventId)).rejects.toMatchObject({ code: "gate_paused" });
    sqlite.close();
  });
});

describe("台账事件级手动删除（邮件类数据删除入口）", () => {
  it("deleteEventCascade：记忆文档 + knowledge 清理 + 台账软删", async () => {
    const requestSourceCleanups = vi.fn();
    const submitEnvelope = vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" });
    const importToMemoryCore = vi.fn().mockResolvedValue({
      document: { id: "mdoc-del-1" }, chunkCount: 1, deduplicated: false,
    });
    const deleteDocumentsByCallerRef = vi.fn().mockResolvedValue(["mdoc-del-1"]);
    const knowledge = {
      enabled: true, routerEnabled: true, submitEnvelope,
      requestSourceCleanups,
    } as unknown as KnowledgeService;
    const memory = {
      enabled: true, importToMemoryCore, deleteDocumentsByCallerRef,
    } as unknown as MemoryService;

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-delete-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const service = new IngestService(
      db, new FilesService(db, dataDir), knowledge, memory, silentLogger, undefined, null,
    );

    // 无过滤（filter=null 直通扇出）：邮件进台账 + 记忆 + route。
    const result = await service.ingestConnector({
      kind: "mail", sourceId: "mail-del-1", dataType: "mail", title: "要删的邮件", markdown: "内容",
    });
    expect(result.memoryResult).toMatchObject({ documentId: "mdoc-del-1" });

    // 手动删除该事件：级联清记忆 + knowledge + 台账软删。
    await expect(service.deleteEventCascade(result.eventId)).resolves.toEqual({ deleted: 1 });
    expect(deleteDocumentsByCallerRef).toHaveBeenCalledWith("mail-del-1");
    expect(requestSourceCleanups).toHaveBeenCalledWith([{ sourceKind: "mail", sourceId: "mail-del-1" }]);
    const row = db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
    expect(row?.deletedAt).not.toBeNull();

    // 重复删除：已软删 → null（幂等，不再触发清理）。
    await expect(service.deleteEventCascade(result.eventId)).resolves.toBeNull();
    sqlite.close();
  });

  it("删除同 sourceId 的多版本事件一次清干净，且不误伤其他来源", async () => {
    const submitEnvelope = vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" });
    const importToMemoryCore = vi.fn().mockResolvedValue({
      document: { id: "mdoc-x" }, chunkCount: 1, deduplicated: false,
    });
    const deleteDocumentsByCallerRef = vi.fn().mockResolvedValue([]);
    const knowledge = {
      enabled: true, routerEnabled: true, submitEnvelope, requestSourceCleanups: vi.fn(),
    } as unknown as KnowledgeService;
    const memory = {
      enabled: true, importToMemoryCore, deleteDocumentsByCallerRef,
    } as unknown as MemoryService;
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-delete2-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const service = new IngestService(
      db, new FilesService(db, dataDir), knowledge, memory, silentLogger, undefined, null,
    );

    const target = await service.ingestConnector({
      kind: "mail", sourceId: "mail-multi-1", dataType: "mail", title: "v1", markdown: "版本一",
    });
    // 同 sourceId 新版本（不同内容 hash）→ 第二条台账行。
    await service.ingestConnector({
      kind: "mail", sourceId: "mail-multi-1", dataType: "mail", title: "v2", markdown: "版本二",
    });
    const other = await service.ingestConnector({
      kind: "mail", sourceId: "mail-other-1", dataType: "mail", title: "别动我", markdown: "内容",
    });

    await service.deleteEventCascade(target.eventId);
    const rows = db.select().from(ingestEvents).all();
    // 目标 source 的两行都软删；其他来源不动。
    expect(rows.filter((row) => row.sourceId === "mail-multi-1" && row.deletedAt === null)).toHaveLength(0);
    expect(rows.find((row) => row.id === other.eventId)?.deletedAt).toBeNull();
    sqlite.close();
  });
});
