import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/modules/memory/service.js";
import { MemoryOutcomeTracker } from "../src/modules/memory/outcomes.js";

let root: string;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-outcomes-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true });
});

/** 造一条草稿态经验（等价于提炼产出的 lesson）。 */
function draftLesson(content = "周报排期以李明邮件附件为准 → 引用时标注以邮件为准"): string {
  const id = service.remember({
    content,
    category: "lesson",
    confidence: "inferred",
  });
  if (!id) throw new Error("remember failed");
  return id;
}

describe("检索事后结算（无人工）", () => {
  it("顺利跑完才算「用上了」，并累计正反馈", () => {
    const id = draftLesson();
    const tracker = new MemoryOutcomeTracker({ service });

    tracker.recordRecall("run-1", [id]);
    const settled = tracker.settle("run-1", { failed: false });

    expect(settled).toMatchObject({ checked: 1, confirmed: 1, promoted: 0 });
    const entry = service.list()[0];
    expect(entry?.confidence).toBe("inferred");
    expect(entry?.retrievalCount ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("这条 run 出过事就不确认（也不误伤）", () => {
    const id = draftLesson();
    const tracker = new MemoryOutcomeTracker({ service });

    tracker.recordRecall("run-1", [id]);
    expect(tracker.settle("run-1", { failed: true })).toMatchObject({ confirmed: 0, promoted: 0 });

    // 没攒到确认 -> 仍是草稿
    expect(service.list()[0]?.confidence).toBe("inferred");
  });

  it("两次顺利复用后草稿转正为已核实", () => {
    const id = draftLesson();
    const tracker = new MemoryOutcomeTracker({ service });

    tracker.recordRecall("run-1", [id]);
    tracker.settle("run-1", { failed: false });
    expect(service.list()[0]?.confidence).toBe("inferred");

    tracker.recordRecall("run-2", [id]);
    const second = tracker.settle("run-2", { failed: false });

    expect(second.promoted).toBe(1);
    expect(service.list()[0]?.confidence).toBe("verified");
  });

  it("没被检索过的 run 不结算任何东西", () => {
    draftLesson();
    const tracker = new MemoryOutcomeTracker({ service });

    expect(tracker.settle("run-x", { failed: false })).toMatchObject({ checked: 0, confirmed: 0 });
  });

  it("discard 之后不再结算", () => {
    const id = draftLesson();
    const tracker = new MemoryOutcomeTracker({ service });

    tracker.recordRecall("run-1", [id]);
    tracker.discard("run-1");

    expect(tracker.settle("run-1", { failed: false })).toMatchObject({ checked: 0 });
    expect(service.list()[0]?.confidence).toBe("inferred");
  });

  it("已核实条目不会被重复「晋升」，但确认照记", () => {
    const id = service.remember({
      content: "用户偏好用简体中文撰写正式文档",
      tags: ["偏好"],
      category: "fact",
      confidence: "verified",
    });
    if (!id) throw new Error("remember failed");
    const tracker = new MemoryOutcomeTracker({ service });

    tracker.recordRecall("run-1", [id]);
    const settled = tracker.settle("run-1", { failed: false });

    expect(settled).toMatchObject({ confirmed: 1, promoted: 0 });
    expect(service.list()[0]?.confidence).toBe("verified");
  });
});
