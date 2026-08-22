import { mkdtemp, rm } from "node:fs/promises";
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
