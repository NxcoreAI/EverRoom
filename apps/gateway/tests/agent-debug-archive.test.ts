import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDebugEvent, AgentDebugRun } from "@nxcore/agent-contract";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDebugArchive, type AgentDebugArchiveOptions } from "../src/modules/agent-debug/archive.js";
import { AgentDebugTraceStore } from "../src/modules/agent-debug/trace-store.js";

const tempDirs: string[] = [];

/** 测试固定"当前时间"：让 2026-10-01 前后的 run 落在默认 7 天保留窗口内。 */
const TEST_NOW = Date.parse("2026-10-04T00:00:00.000Z");

function createArchive(
  dir: string,
  options: Omit<AgentDebugArchiveOptions, "dir"> = {},
): AgentDebugArchive {
  return new AgentDebugArchive({ dir, now: () => TEST_NOW, ...options });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-debug-archive-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function makeRun(runId: string, overrides: Partial<AgentDebugRun> = {}): AgentDebugRun {
  return {
    runId,
    agentId: "main",
    agentName: "EverRoom",
    agentKind: "builtin",
    runtimeId: "pi:main",
    sessionId: "session-1",
    pageLabel: "Home",
    task: "hello",
    status: "completed",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:05.000Z",
    eventCount: 0,
    droppedEvents: 0,
    toolCallCount: 0,
    reasoningChars: 0,
    lastEventAt: "2026-10-01T00:00:05.000Z",
    errorMessage: null,
    ...overrides,
  };
}

function makeEvents(count: number, payload: unknown = {}): AgentDebugEvent[] {
  const events: AgentDebugEvent[] = [];
  for (let index = 1; index <= count; index += 1) {
    const type: AgentDebugEvent["type"] = index === 1
      ? "run.started"
      : index === count ? "run.completed" : "message.delta";
    events.push({
      seq: index,
      type,
      occurredAt: `2026-10-01T00:00:0${index}.000Z`,
      payload: type === "message.delta" ? { delta: `d${index}`, ...(payload as object) } : payload,
    });
  }
  return events;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(root);
  return files;
}

describe("AgentDebugArchive", () => {
  it("writes a terminal run to ndjson + index and survives a fresh instance", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    const run = makeRun("run-1");
    await archive.archiveRun(run, makeEvents(3));
    await archive.flush();

    expect(archive.listRuns(10)).toEqual([
      expect.objectContaining({ runId: "run-1", origin: "archive", status: "completed", eventCount: 3 }),
    ]);
    expect(archive.getRun("run-1")).toMatchObject({ runId: "run-1", origin: "archive" });
    // sessionTitle 是查询时补全字段，不落归档。
    expect(archive.getRun("run-1")?.sessionTitle).toBeUndefined();

    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as {
      version: number;
      runs: Array<{ run: AgentDebugRun; file: string; bytes: number }>;
    };
    expect(index.version).toBe(1);
    expect(index.runs).toHaveLength(1);
    expect(index.runs[0]?.file).toMatch(/^runs\/\d{8}\/run-1\.ndjson$/);
    expect(index.runs[0]?.bytes).toBeGreaterThan(0);

    const lines = (await readFile(join(dir, index.runs[0]!.file), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "run", run: { runId: "run-1" } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: "event", event: { seq: 1 } });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: "event", event: { seq: 3 } });

    // 模拟重启：新实例只读索引，事件按需读文件。
    const restarted = createArchive(dir);
    expect(restarted.listRuns(10).map(({ runId }) => runId)).toEqual(["run-1"]);
    expect(restarted.readEvents("run-1")).toMatchObject({
      events: [
        { seq: 1, type: "run.started" },
        { seq: 2, type: "message.delta" },
        { seq: 3, type: "run.completed" },
      ],
      latestSeq: 3,
    });
    expect(restarted.info()).toMatchObject({
      enabled: true,
      retentionDays: 7,
      runCount: 1,
    });
    expect(restarted.info().bytes).toBeGreaterThan(0);
    expect(restarted.info().oldestStartedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("filters archived events by afterSeq and limit", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    await archive.archiveRun(makeRun("run-1"), makeEvents(5));
    await archive.flush();

    expect(archive.readEvents("run-1", 0, 5)?.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
    expect(archive.readEvents("run-1", 2, 10)?.events.map(({ seq }) => seq)).toEqual([3, 4, 5]);
    expect(archive.readEvents("run-1", 2, 2)).toEqual({
      events: [expect.objectContaining({ seq: 3 }), expect.objectContaining({ seq: 4 })],
      latestSeq: 5,
    });
    // 终态静态归档：afterSeq 对齐 latestSeq 后为空，latestSeq 保持不变。
    expect(archive.readEvents("run-1", 5)).toEqual({ events: [], latestSeq: 5 });
    expect(archive.readEvents("missing")).toBeNull();
  });

  it("is idempotent for the same runId", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    await archive.archiveRun(makeRun("run-1"), makeEvents(2));
    await archive.flush();
    await archive.archiveRun(makeRun("run-1", { task: "rewritten" }), makeEvents(9));
    await archive.flush();

    expect(archive.listRuns(10)).toHaveLength(1);
    expect(archive.readEvents("run-1")?.events).toHaveLength(2);
    expect(archive.getRun("run-1")?.task).toBe("hello");
  });

  it("keeps runIds path-safe", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    const runId = "../evil/session:1";
    await archive.archiveRun(makeRun(runId), makeEvents(1));
    await archive.flush();

    const files = await walkFiles(dir);
    const runFiles = files.filter((file) => file.endsWith(".ndjson"));
    expect(runFiles).toHaveLength(1);
    expect(runFiles[0]).toContain(".._evil_session_1.ndjson");
    expect(archive.getRun(runId)).not.toBeNull();
  });

  it("prunes runs older than the retention window", async () => {
    const dir = await tempDir();
    let nowMs = Date.parse("2026-10-02T00:00:00.000Z");
    const archive = createArchive(dir, { retentionDays: 7, now: () => nowMs });
    await archive.archiveRun(makeRun("stale", { startedAt: "2026-10-01T00:00:00.000Z" }), makeEvents(1));
    await archive.flush();
    expect(archive.getRun("stale")).not.toBeNull();

    // 时间推进到窗口之外，再写一条新 run：写入后即时裁剪最旧的 stale。
    nowMs = Date.parse("2026-10-20T00:00:00.000Z");
    await archive.archiveRun(makeRun("fresh", { startedAt: "2026-10-19T00:00:00.000Z" }), makeEvents(1));
    await archive.flush();
    expect(archive.getRun("stale")).toBeNull();
    expect(archive.getRun("fresh")).not.toBeNull();
    expect(archive.info().runCount).toBe(1);

    // 重启后索引与文件都不再包含被裁剪的 run。
    const restarted = createArchive(dir);
    expect(restarted.listRuns(10).map(({ runId }) => runId)).toEqual(["fresh"]);
    const runFiles = (await walkFiles(dir)).filter((file) => file.endsWith(".ndjson"));
    expect(runFiles.some((file) => file.includes("stale"))).toBe(false);
  });

  it("prunes the oldest runs beyond the max run count", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir, { maxRuns: 2 });
    await archive.archiveRun(makeRun("run-1", { startedAt: "2026-10-01T00:00:00.000Z" }), makeEvents(1));
    await archive.archiveRun(makeRun("run-2", { startedAt: "2026-10-02T00:00:00.000Z" }), makeEvents(1));
    await archive.archiveRun(makeRun("run-3", { startedAt: "2026-10-03T00:00:00.000Z" }), makeEvents(1));
    await archive.flush();

    expect(archive.listRuns(10).map(({ runId }) => runId)).toEqual(["run-3", "run-2"]);
    expect(archive.getRun("run-1")).toBeNull();
    expect(archive.info().runCount).toBe(2);
    expect((await walkFiles(dir)).some((file) => file.includes("run-1"))).toBe(false);
  });

  it("prunes the oldest runs beyond the max byte budget", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir, { maxBytes: 900 });
    const bigPayload = { text: "x".repeat(200) };
    await archive.archiveRun(makeRun("run-1", { startedAt: "2026-10-01T00:00:00.000Z" }), makeEvents(1, bigPayload));
    await archive.flush();
    expect(archive.getRun("run-1")).not.toBeNull();
    const singleRunBytes = archive.info().bytes;
    expect(singleRunBytes).toBeLessThan(900);

    await archive.archiveRun(makeRun("run-2", { startedAt: "2026-10-02T00:00:00.000Z" }), makeEvents(1, bigPayload));
    await archive.flush();
    expect(singleRunBytes * 2).toBeGreaterThan(900);
    expect(archive.getRun("run-1")).toBeNull();
    expect(archive.getRun("run-2")).not.toBeNull();
    expect(archive.info().bytes).toBeLessThanOrEqual(900);
  });

  it("rebuilds the index from ndjson first lines when index.json is corrupted or missing", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    await archive.archiveRun(makeRun("run-1"), makeEvents(2));
    await archive.archiveRun(makeRun("run-2", { startedAt: "2026-10-02T00:00:00.000Z" }), makeEvents(1));
    await archive.flush();

    await writeFile(join(dir, "index.json"), "{ this is not json", "utf8");
    const fromCorrupt = createArchive(dir);
    expect(fromCorrupt.listRuns(10).map(({ runId }) => runId)).toEqual(["run-2", "run-1"]);
    expect(fromCorrupt.readEvents("run-1")?.latestSeq).toBe(2);
    // 自愈后重写 index.json，后续实例不再依赖扫描。
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toMatchObject({ version: 1 });

    await rm(join(dir, "index.json"), { force: true });
    const fromMissing = createArchive(dir);
    expect(fromMissing.listRuns(10)).toHaveLength(2);
    expect(fromMissing.info().runCount).toBe(2);
  });

  it("skips bad ndjson lines and unparseable run files", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    await archive.archiveRun(makeRun("good"), makeEvents(3));
    await archive.flush();

    const [runFile] = (await walkFiles(dir)).filter((file) => file.endsWith(".ndjson"));
    expect(runFile).toBeDefined();
    await writeFile(
      runFile!,
      `${await readFile(runFile!, "utf8")}{ not json\n{"kind":"event","event":{"type":"broken"}}\n`,
      "utf8",
    );
    expect(archive.readEvents("good")).toMatchObject({
      events: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 3 })],
      latestSeq: 3,
    });

    // 一个首行坏掉的 ndjson 文件在索引重建时被整体跳过，不影响其它 run。
    const runsRoot = join(dir, "runs");
    const [dayDir] = await readdir(runsRoot);
    await writeFile(join(runsRoot, dayDir!, "broken.ndjson"), "garbage\n", "utf8");
    await rm(join(dir, "index.json"), { force: true });
    const rebuilt = createArchive(dir);
    expect(rebuilt.listRuns(10).map(({ runId }) => runId)).toEqual(["good"]);
  });

  it("never rejects and warns when the archive directory cannot be written", async () => {
    const root = await tempDir();
    const blocked = join(root, "blocked");
    await mkdir(root, { recursive: true });
    await writeFile(blocked, "not a directory", "utf8");
    const warnings: string[] = [];
    const archive = createArchive(blocked, { warn: (message) => warnings.push(message) });

    await expect(archive.archiveRun(makeRun("run-1"), makeEvents(1))).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(archive.listRuns(10)).toHaveLength(0);
    expect(archive.info()).toMatchObject({ enabled: true, runCount: 0 });
  });
});

describe("AgentDebugTraceStore archive integration", () => {
  it("archives a terminal run with all materialized events", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    const store = new AgentDebugTraceStore(archive);
    store.beginRun({
      runId: "run-1",
      agentId: "main",
      agentName: "EverRoom",
      agentKind: "builtin",
      runtimeId: "pi:main",
      sessionId: "session-1",
      pageLabel: "Home",
      task: "hello",
    });
    store.recordEvent("run-1", { type: "run.started", payload: {} });
    store.recordEvent("run-1", { type: "message.delta", payload: { delta: "你" } });
    store.recordEvent("run-1", { type: "message.delta", payload: { delta: "好" } });
    store.recordEvent("run-1", { type: "run.completed", payload: {} });
    await archive.flush();

    const restarted = createArchive(dir);
    expect(restarted.getRun("run-1")).toMatchObject({
      runId: "run-1",
      status: "completed",
      origin: "archive",
      eventCount: 3,
      reasoningChars: 0,
    });
    // 相邻同类型 delta 合并后只落一条累计事件。
    const page = restarted.readEvents("run-1");
    expect(page?.events.map(({ type }) => type)).toEqual(["run.started", "message.delta", "run.completed"]);
    expect(page?.events[1]?.payload).toEqual({ delta: "你好" });

    await store.dispose();
    await archive.flush();
  });

  it("dispose archives still-running runs as interrupted before flushing", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir);
    const store = new AgentDebugTraceStore(archive);
    store.beginRun({
      runId: "run-running",
      agentId: "main",
      agentName: "EverRoom",
      agentKind: "builtin",
      runtimeId: "pi:main",
      sessionId: "session-1",
      pageLabel: "Home",
      task: "long task",
    });
    store.recordEvent("run-running", { type: "run.started", payload: {} });

    await store.dispose();
    expect(store.getRun("run-running")).toMatchObject({ status: "interrupted", origin: "archive" });

    const restarted = createArchive(dir);
    expect(restarted.getRun("run-running")).toMatchObject({
      runId: "run-running",
      status: "interrupted",
      origin: "archive",
    });
    expect(restarted.readEvents("run-running")?.events.map(({ type }) => type)).toEqual(["run.started"]);
  });

  it("lists live runs with origin live and merges archived history without duplicates", async () => {
    const dir = await tempDir();
    const archive = createArchive(dir, { now: () => Date.parse("2026-01-02T00:00:00.000Z") });
    await archive.archiveRun(
      makeRun("run-history", {
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      }),
      makeEvents(1),
    );
    await archive.flush();

    const store = new AgentDebugTraceStore(archive);
    store.beginRun({
      runId: "run-live",
      agentId: "main",
      agentName: "EverRoom",
      agentKind: "builtin",
      runtimeId: "pi:main",
      sessionId: "session-1",
      pageLabel: "Home",
      task: "live",
    });

    expect(store.listRuns(10, "exclude").map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-live", origin: "live" },
    ]);
    expect(store.listRuns(10, "only").map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-history", origin: "archive" },
    ]);

    // live run 与归档 run 混合：运行中永远最前，其余按 startedAt 倒序。
    expect(store.listRuns(10, "include").map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: "run-live", origin: "live" },
      { runId: "run-history", origin: "archive" },
    ]);

    // 同一 runId 同时存在于内存与归档时以内存为准（不重复出现）。
    store.finishRun("run-live", "completed");
    await archive.flush();
    const merged = store.listRuns(10, "include");
    expect(merged.filter(({ runId }) => runId === "run-live")).toHaveLength(1);
    expect(merged.find(({ runId }) => runId === "run-live")?.origin).toBe("live");

    // 内存没有时，getRun / listEvents 回落归档。
    const archivedOnly = new AgentDebugTraceStore(archive);
    expect(archivedOnly.getRun("run-history")).toMatchObject({ runId: "run-history", origin: "archive" });
    expect(archivedOnly.listEvents("run-history")?.events).toHaveLength(1);
    expect(archivedOnly.listEvents("missing")).toBeNull();
    expect(archivedOnly.getRun("missing")).toBeNull();

    await archivedOnly.dispose();
    await store.dispose();
  });

  it("does not receive an archive when archiving is disabled", async () => {
    const dir = await tempDir();
    const store = new AgentDebugTraceStore();
    store.beginRun({
      runId: "run-1",
      agentId: "main",
      agentName: "EverRoom",
      agentKind: "builtin",
      runtimeId: "pi:main",
      sessionId: "session-1",
      pageLabel: "Home",
      task: "hello",
    });
    store.recordEvent("run-1", { type: "run.completed", payload: {} });
    expect(store.archiveInfo()).toEqual({
      enabled: false,
      retentionDays: 0,
      runCount: 0,
      bytes: 0,
      oldestStartedAt: null,
    });
    expect(store.listRuns(10, "only")).toEqual([]);
    await store.dispose();

    // 未注入归档 → 内存 run 生命周期结束后不会在 dataDir 下留下任何文件。
    const dataDir = join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    expect(existsSync(join(dataDir, "agent-debug"))).toBe(false);
  });
});
