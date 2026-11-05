import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { journalEntries } from "../src/infrastructure/database/schema.js";
import type { MemoryHit } from "../src/modules/memory/hippo-adapter.js";
import {
  collectJournalSignals,
  dayWindow,
  fingerprintOf,
  memorySignalWeight,
} from "../src/modules/journal/collector.js";
import {
  buildJournalPrompt,
  parseJournalComposition,
  templateComposition,
} from "../src/modules/journal/composer.js";
import { JournalScheduler } from "../src/modules/journal/scheduler.js";
import { JournalService } from "../src/modules/journal/service.js";

/**
 * 每日洞察（主页「今日洞察」）的验收：
 * - 采集：只认本地当天的记忆条目；同标签聚成一簇、权重排序稳定；
 * - 提炼：编造的 sourceIds 一律丢弃；模型不可用/解析失败走模板并标 `model: null`；
 * - 落盘：一天多版、指纹未变不重写、force 才重写；
 * - 调度：去抖合并、最小间隔、每日上限、单飞行补跑。
 */

const TIMEZONE = "Asia/Shanghai";

function hit(partial: Partial<MemoryHit> & { id: string; content: string; createdAt: string }): MemoryHit {
  return {
    tags: [],
    strength: 1,
    halfLifeDays: 365,
    retrievalCount: 0,
    score: 0,
    category: "fact",
    layer: "semantic",
    scope: null,
    confidence: "observed",
    ...partial,
  } as MemoryHit;
}

describe("collector", () => {
  // 2026-11-03 10:00 (+08:00)
  const now = new Date("2026-11-03T02:00:00.000Z");

  it("按本地时区切日：昨天 23:59 与今天 00:01 分属两天", () => {
    const { start, end } = dayWindow("2026-11-03", TIMEZONE);
    expect(start.toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-03T16:00:00.000Z");
  });

  it("只采当天条目，越界的丢掉", () => {
    const snapshot = collectJournalSignals({
      list: () => [
        hit({ id: "today", content: "今天写的", createdAt: "2026-11-02T16:05:00.000Z" }),
        hit({ id: "yesterday", content: "昨天写的", createdAt: "2026-11-02T15:59:00.000Z" }),
        hit({ id: "tomorrow", content: "明天的", createdAt: "2026-11-03T16:00:00.000Z" }),
      ],
      timezone: () => TIMEZONE,
      now: () => now,
    });
    expect(snapshot.date).toBe("2026-11-03");
    expect(snapshot.signals.map((signal) => signal.id)).toEqual(["memory:today"]);
    expect(snapshot.signalCount).toBe(1);
  });

  it("标签重合的条目聚成一簇，只出一条信号并记合并数", () => {
    const snapshot = collectJournalSignals({
      list: () => [
        hit({
          id: "a", content: "偏好结论先行", createdAt: "2026-11-03T01:00:00.000Z",
          category: "lesson", confidence: "verified", tags: ["偏好", "写作"],
        }),
        hit({
          id: "b", content: "偏好结构化表格", createdAt: "2026-11-03T01:30:00.000Z",
          tags: ["偏好", "写作"],
        }),
        hit({
          id: "c", content: "项目叫锥光", createdAt: "2026-11-03T01:40:00.000Z",
          tags: ["项目"],
        }),
      ],
      timezone: () => TIMEZONE,
      now: () => now,
    });
    expect(snapshot.signals).toHaveLength(2);
    expect(snapshot.signals[0]!.id).toBe("memory:a");
    expect(snapshot.signals[0]!.merged).toBe(1);
    expect(snapshot.signalCount).toBe(3);
  });

  it("权重：经验 > 事实、verified 加分、inferred 扣分、越新越高", () => {
    const window = dayWindow("2026-11-03", TIMEZONE);
    const early = new Date("2026-11-03T00:10:00.000Z");
    const late = new Date("2026-11-03T06:00:00.000Z");
    const lesson = memorySignalWeight({ category: "lesson", confidence: "verified", strength: 1 }, early, window);
    const fact = memorySignalWeight({ category: "fact", confidence: "observed", strength: 1 }, early, window);
    const inferred = memorySignalWeight({ category: "fact", confidence: "inferred", strength: 0.4 }, early, window);
    const fresh = memorySignalWeight({ category: "fact", confidence: "observed", strength: 1 }, late, window);
    expect(lesson).toBeGreaterThan(fact);
    expect(fact).toBeGreaterThan(inferred);
    expect(fresh).toBeGreaterThan(fact);
  });

  it("指纹只看条目集合，不看顺序", () => {
    expect(fingerprintOf("2026-11-03", ["b", "a"])).toBe(fingerprintOf("2026-11-03", ["a", "b"]));
    expect(fingerprintOf("2026-11-03", ["a"])).not.toBe(fingerprintOf("2026-11-04", ["a"]));
  });
});

describe("composer", () => {
  const signals = collectJournalSignals({
    list: () => [
      hit({
        id: "m1", content: "交付前端方案一律给结构化表格", tags: ["偏好"],
        category: "lesson", confidence: "verified", createdAt: "2026-11-03T01:00:00.000Z",
      }),
      hit({
        id: "m2", content: "当前项目主线是锥光的记忆上下文", tags: ["项目"],
        createdAt: "2026-11-03T02:00:00.000Z",
      }),
    ],
    timezone: () => TIMEZONE,
    now: () => new Date("2026-11-03T03:00:00.000Z"),
  }).signals;

  it("prompt 带上条目 id（模型才知道该回填什么）", () => {
    const prompt = buildJournalPrompt("2026-11-03", signals);
    expect(prompt).toContain("id=memory:m1");
    expect(prompt).toContain("id=memory:m2");
    expect(prompt).toContain("2026-11-03");
  });

  it("编造的 sourceIds 被丢弃；有据可依的要点保留", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "记下两条偏好",
      summary: "你今天交代了表格偏好，还提到项目主线是锥光。",
      bullets: [
        { text: "前端方案给结构化表格", sourceIds: ["memory:m1"] },
        { text: "编出来的要点", sourceIds: ["memory:not-exist"] },
      ],
      actions: [
        { label: "编的", kind: "ask-agent", targetId: "memory:nope" },
        { label: "聊聊偏好", kind: "ask-agent", targetId: "memory:m1" },
        { label: "开文件", kind: "open-file", targetId: "memory:m1" },
      ],
    }), signals);

    expect(composition).not.toBeNull();
    expect(composition!.bullets).toHaveLength(1);
    expect(composition!.bullets[0]!.sourceIds).toEqual(["memory:m1"]);
    // 一期只放开 ask-agent，open-file 一律不认。
    expect(composition!.actions).toHaveLength(1);
    expect(composition!.actions[0]!.kind).toBe("ask-agent");
  });

  it("容忍代码块围栏与前后废话", () => {
    const composition = parseJournalComposition(
      "好的，这是结果：\n```json\n{\"headline\":\"今天记下两条\",\"summary\":\"你今天交代了两件事。\",\"bullets\":[{\"text\":\"表格偏好\",\"sourceIds\":[\"memory:m1\"]}],\"actions\":[]}\n```",
      signals,
    );
    expect(composition?.headline).toBe("今天记下两条");
  });

  it("要点全被丢掉时返回 null（交给模板兜底）", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "空的",
      summary: "没有依据的话。",
      bullets: [{ text: "编的", sourceIds: ["memory:ghost"] }],
      actions: [],
    }), signals);
    expect(composition).toBeNull();
  });

  it("模板兜底只陈述事实，不编动作", () => {
    const composition = templateComposition("2026-11-03", signals);
    expect(composition.headline).toContain("2");
    expect(composition.bullets).toHaveLength(2);
    expect(composition.actions).toEqual([]);
  });

  it("prompt 要求总结+建议（advice 字段与口吻约束）", () => {
    const prompt = buildJournalPrompt("2026-11-03", signals);
    expect(prompt).toContain("advice");
    expect(prompt).toContain("可执行建议");
    expect(prompt).toContain("总结今天工作状态与内容的变化");
  });

  it("advice：清洗为最多 2 条、超长截断、空值丢弃", () => {
    const composition = parseJournalComposition(JSON.stringify({
      headline: "记下两条偏好",
      summary: "你今天交代了表格偏好，还提到项目主线。",
      bullets: [{ text: "表格偏好", sourceIds: ["memory:m1"] }],
      advice: ["下次起草直接用结构化表格", "", null, "这条会超长".repeat(20), "第三条会被条数上限丢掉"],
      actions: [],
    }), signals);
    expect(composition!.advice).toHaveLength(2);
    expect(composition!.advice![0]).toBe("下次起草直接用结构化表格");
    expect(composition!.advice![1]!.endsWith("…")).toBe(true);
    expect(composition!.advice![1]!.length).toBeLessThanOrEqual(48);
  });

  it("模板兜底给出确定性建议：有经验 → 起草时用上；全是事实 → 固化偏好", () => {
    const withLesson = templateComposition("2026-11-03", signals); // m1 是 lesson
    expect(withLesson.advice?.[0]).toContain("起草");

    // hit 默认 category=fact：3 条事实 → 建议固化偏好。
    const factsComposition = templateComposition("2026-11-03", collectJournalSignals({
      list: () => [
        hit({ id: "f1", content: "项目主线是锥光", createdAt: "2026-11-03T01:00:00.000Z" }),
        hit({ id: "f2", content: "deadline 在周五", createdAt: "2026-11-03T01:30:00.000Z" }),
        hit({ id: "f3", content: "评审人有两位", createdAt: "2026-11-03T02:00:00.000Z" }),
      ],
      timezone: () => TIMEZONE,
      now: () => new Date("2026-11-03T03:00:00.000Z"),
    }).signals);
    expect(factsComposition.advice?.[0]).toContain("偏好");
  });
});

describe("JournalService", () => {
  let dataDir: string;
  let database: DatabaseClient;
  let composeCalls: number;
  let signals: MemoryHit[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "nxcore-journal-"));
    database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    composeCalls = 0;
    signals = [];
  });

  afterEach(() => {
    database.sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function service(now = new Date("2026-11-03T03:00:00.000Z")) {
    return new JournalService({
      db: database.db,
      list: () => signals,
      compose: async (input) => {
        composeCalls += 1;
        return {
          composition: templateComposition(input.date, input.signals),
          model: "fake-model",
        };
      },
      timezone: () => TIMEZONE,
      now: () => now,
    });
  }

  it("没有信号时只记指纹，不写条目", async () => {
    const journal = service();
    const result = await journal.generate("memory");
    expect(result.generated).toBe(false);
    expect(result.skipped).toBe("no-signals");
    expect(result.view.entry).toBeNull();
    expect(result.view.status).toBe("pending");
    expect(composeCalls).toBe(0);
    expect(database.db.select().from(journalEntries).all()).toHaveLength(0);
  });

  it("有信号写一版；指纹未变不重写；force 才再写一版", async () => {
    signals = [hit({ id: "m1", content: "今天记下的事", createdAt: "2026-11-03T02:30:00.000Z" })];
    const journal = service();

    const first = await journal.generate("memory");
    expect(first.generated).toBe(true);
    expect(first.view.entry?.version).toBe(1);
    expect(first.view.entry?.model).toBe("fake-model");
    expect(first.view.signalCount).toBe(1);

    const again = await journal.generate("memory");
    expect(again.generated).toBe(false);
    expect(again.skipped).toBe("unchanged");
    expect(composeCalls).toBe(1);

    const forced = await journal.generate("manual", { force: true });
    expect(forced.generated).toBe(true);
    expect(forced.view.entry?.version).toBe(2);
    expect(composeCalls).toBe(2);
  });

  it("新证据来了指纹就变，自动写新版（同一天多版）", async () => {
    const journal = service();
    signals = [hit({ id: "m1", content: "第一条", createdAt: "2026-11-03T02:00:00.000Z" })];
    await journal.generate("memory");

    signals = [
      ...signals,
      hit({ id: "m2", content: "第二条", createdAt: "2026-11-03T02:50:00.000Z" }),
    ];
    const result = await journal.generate("memory");
    expect(result.generated).toBe(true);
    expect(result.view.entry?.version).toBe(2);
    expect(result.view.signalCount).toBe(2);
  });

  it("写稿抛错时记失败态，且不覆盖已有版本", async () => {
    signals = [hit({ id: "m1", content: "第一条", createdAt: "2026-11-03T02:00:00.000Z" })];
    const journal = new JournalService({
      db: database.db,
      list: () => signals,
      compose: async () => {
        throw new Error("boom");
      },
      timezone: () => TIMEZONE,
      now: () => new Date("2026-11-03T03:00:00.000Z"),
    });

    const result = await journal.generate("boot");
    expect(result.skipped).toBe("failed");
    expect(result.view.status).toBe("failed");
    expect(result.view.lastError).toContain("boom");
    expect(result.view.entry).toBeNull();
  });
});

describe("JournalScheduler", () => {
  function stubService(overrides: { versions?: number } = {}) {
    const generate = vi.fn(async () => ({
      view: {
        date: "2026-11-03",
        entry: { version: overrides.versions ?? 0 } as never,
        status: "ready" as const,
        signalCount: 1,
        lastError: null,
      },
      generated: true,
      skipped: null,
    }));
    return {
      generate,
      today: () => ({
        date: "2026-11-03",
        // 上限判定读的是「当天已有第几版」，所以 today 必须如实反映版本数。
        entry: (overrides.versions ?? 0) > 0 ? ({ version: overrides.versions } as never) : null,
        status: "pending" as const,
        signalCount: 0,
        lastError: null,
      }),
    };
  }

  it("去抖：连续信号只算一次", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService();
      const scheduler = new JournalScheduler({ service: service as never, debounceMs: 45_000 });
      scheduler.noteSignal("memory");
      vi.advanceTimersByTime(20_000);
      scheduler.noteSignal("memory");
      vi.advanceTimersByTime(44_000);
      expect(service.generate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(service.generate).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("最小间隔：间隔内不动手，到点补一次", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService();
      const scheduler = new JournalScheduler({
        service: service as never,
        debounceMs: 0,
        minIntervalMs: 5 * 60_000,
      });
      await scheduler.requestRun("boot");
      expect(service.generate).toHaveBeenCalledTimes(1);

      await scheduler.requestRun("memory");
      expect(service.generate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(service.generate).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("每日上限：超过上限不再自动生成，手动仍可", async () => {
    vi.useFakeTimers();
    try {
      const service = stubService({ versions: 24 });
      const scheduler = new JournalScheduler({ service: service as never, minIntervalMs: 0, dailyCap: 24 });
      const result = await scheduler.requestRun("memory");
      expect(result.generated).toBe(false);
      expect(service.generate).not.toHaveBeenCalled();

      await scheduler.requestRun("manual", { force: true });
      expect(service.generate).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
