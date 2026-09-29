import { describe, expect, it } from "vitest";

import { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import { officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import type { DocumentExecutionContext } from "../src/modules/documents/capabilities/types.js";
import { SlidesReviewGate, slidesGatePlanFrom } from "../src/modules/subagents/slides-review-gate.js";
import { vi } from "vitest";

const PLAN = {
  title: "季度汇报",
  narrative: "以增长主线收束到下季度投入",
  pages: [
    {
      title: "封面",
      points: ["一季度营收破千万", "新客占比 42%"],
      data: "营收: 1000 万 | 新客: 42%",
      materials: [{ url: "https://example.com/a.jpg", desc: "办公楼" }],
      notes: "深色满版底",
    },
    { title: "营收" },
    { title: "展望" },
  ],
  warnings: ["Q4 数据未拿到"],
};

function gateEvents(gate: SlidesReviewGate, runId: string) {
  const events: Array<Record<string, unknown>> = [];
  gate.setRelay(runId, (event) => {
    const { kind, snapshot, ...rest } = event;
    events.push({ kind, ...rest, snapshot });
  });
  return events;
}

describe("SlidesReviewGate", () => {
  it("新页过闸：awaitDecision 挂起 → continue 放行并推进 doneCount", async () => {
    const gate = new SlidesReviewGate();
    gate.arm("run-1", PLAN);
    const events = gateEvents(gate, "run-1");
    const pending = gate.awaitDecision("run-1", 0);
    expect(gate.resolve("no-such-id", { action: "continue" })).toBe(false);
    const opened = events.filter((event) => event.kind === "gate_open");
    expect(opened).toHaveLength(1);
    const approvalId = opened[0]!.approvalId as string;
    expect(opened[0]!.snapshot).toMatchObject({
      doneCount: 0,
      awaitingIndex: 0,
      totalPages: 3,
      narrative: PLAN.narrative,
      warnings: PLAN.warnings,
      pages: PLAN.pages,
    });
    expect(gate.resolve(approvalId, { action: "continue" })).toBe(true);
    await expect(pending).resolves.toEqual({ action: "continue" });
    expect(events.at(-1)).toMatchObject({ kind: "page_resolved", action: "continue", snapshot: { doneCount: 1, awaitingIndex: null } });
  });

  it("revise：重落同页再次过闸；continue 后同页替换（QA 自检）直通", async () => {
    const gate = new SlidesReviewGate();
    gate.arm("run-1", PLAN);
    gateEvents(gate, "run-1");
    const first = gate.awaitDecision("run-1", 1);
    const approvalId = (gate as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string;
    gate.resolve(approvalId, { action: "revise", feedback: "标题再大一点" });
    await expect(first).resolves.toEqual({ action: "revise", feedback: "标题再大一点" });
    // 重落同一页：再次过闸
    const redo = gate.awaitDecision("run-1", 1);
    const redoApprovalId = (gate as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string;
    gate.resolve(redoApprovalId, { action: "continue" });
    await expect(redo).resolves.toEqual({ action: "continue" });
    // QA 自检回填旧页：直通不挂起
    await expect(gate.awaitDecision("run-1", 0)).resolves.toEqual({ action: "continue" });
  });

  it("finish：表态后后续页全部直通", async () => {
    const gate = new SlidesReviewGate();
    gate.arm("run-1", PLAN);
    gateEvents(gate, "run-1");
    const pending = gate.awaitDecision("run-1", 0);
    const approvalId = (gate as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string;
    gate.resolve(approvalId, { action: "finish" });
    await expect(pending).resolves.toEqual({ action: "finish" });
    await expect(gate.awaitDecision("run-1", 1)).resolves.toEqual({ action: "continue" });
    await expect(gate.awaitDecision("run-1", 2)).resolves.toEqual({ action: "continue" });
  });

  it("超时：5 分钟无表态自动视为 continue（带 timedOut）", async () => {
    vi.useFakeTimers();
    try {
      const gate = new SlidesReviewGate();
      gate.arm("run-1", PLAN);
      const pending = gate.awaitDecision("run-1", 0);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(pending).resolves.toEqual({ action: "continue", timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("未布闸 / 已 disarm：直通", async () => {
    const gate = new SlidesReviewGate();
    await expect(gate.awaitDecision("run-x", 0)).resolves.toEqual({ action: "continue" });
    gate.arm("run-1", PLAN);
    gate.disarm("run-1");
    await expect(gate.awaitDecision("run-1", 0)).resolves.toEqual({ action: "continue" });
  });
});

describe("slidesGatePlanFrom", () => {
  it("透传每页文案要点/数据/配图/方向与叙事告警", () => {
    const plan = slidesGatePlanFrom({
      title: "复盘",
      narrative: "数据驱动的年度总结",
      warnings: ["素材缺一张"],
      pages: [
        {
          title: "增长",
          role: "data",
          points: ["营收 +38%"],
          data: "营收: 1.38 亿",
          materials: [{ url: "https://example.com/x.jpg", desc: "曲线" }],
          notes: "图表为主",
        },
      ],
    });
    expect(plan).toEqual({
      title: "复盘",
      narrative: "数据驱动的年度总结",
      warnings: ["素材缺一张"],
      pages: [
        {
          title: "增长",
          role: "data",
          points: ["营收 +38%"],
          data: "营收: 1.38 亿",
          materials: [{ url: "https://example.com/x.jpg", desc: "曲线" }],
          notes: "图表为主",
        },
      ],
    });
  });

  it("截长防爆量：points ≤6、materials ≤3 且只留 http(s)、字符串按上限截断", () => {
    const plan = slidesGatePlanFrom({
      title: "t".repeat(200),
      pages: [
        {
          title: "页",
          points: Array.from({ length: 9 }, (_, i) => `点${i}` + "长".repeat(300)),
          data: "数".repeat(500),
          notes: "向".repeat(300),
          materials: [
            { url: "ftp://bad.example/x.jpg" },
            { url: "https://good.example/1.jpg", desc: "d".repeat(200) },
            { url: "https://good.example/2.jpg" },
            { url: "https://good.example/3.jpg" },
            { url: "https://good.example/4.jpg" },
          ],
        },
      ],
    });
    expect(plan).not.toBeNull();
    expect(plan!.title).toHaveLength(120);
    const page = plan!.pages[0]!;
    expect(page.points).toHaveLength(6);
    expect(page.points![0]!.length).toBeLessThanOrEqual(160);
    expect(page.data).toHaveLength(240);
    expect(page.notes).toHaveLength(140);
    expect(page.materials).toHaveLength(3);
    expect(page.materials!.every((material) => material.url.startsWith("https://"))).toBe(true);
    expect(page.materials![0]!.desc).toHaveLength(60);
  });

  it("缺标题 / 缺页清单 / 非对象输入 → null；页内非对象元素按空页保留序号", () => {
    expect(slidesGatePlanFrom(null)).toBeNull();
    expect(slidesGatePlanFrom("nope")).toBeNull();
    expect(slidesGatePlanFrom({ pages: [{ title: "x" }] })).toBeNull();
    expect(slidesGatePlanFrom({ title: "t", pages: [] })).toBeNull();
    const plan = slidesGatePlanFrom({ title: "t", pages: [null, 42, { title: "有效页" }] });
    expect(plan!.pages).toHaveLength(3);
    expect(plan!.pages[2]!.title).toBe("有效页");
  });
});

describe("office set_page × 逐页审阅", () => {
  function harness(gate: SlidesReviewGate | null) {
    const bridge = new OfficeBridgeClient({ baseUrl: "http://127.0.0.1:9", token: "test-token" });
    const fillPage = vi.spyOn(bridge, "fillPage").mockResolvedValue({
      ok: true,
      applied: true,
      records: [{ op: "insertSlidePptx", created: ["s-9"] }],
      saved: true,
      outline: "Page 1\n  (filled)",
    });
    const plugin = officePlugin(bridge, gate);
    const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]));
    return { fillPage, tools };
  }

  const context: DocumentExecutionContext = { agentSessionId: "session-1", runId: "run-1", roomId: "room-1" };
  const args = {
    fileId: "active",
    slideIndex: 0,
    spec: { background: "#FFFFFF", elements: [] },
  };

  it("闸门布防：返回带 review 与 revise nextAction；闸门表态前 set_page 不返回", async () => {
    const gate = new SlidesReviewGate();
    gate.arm("run-1", PLAN);
    const { tools } = harness(gate);
    const pending = tools.get("context_room_slides_set_page")!.execute(args, context);
    await settle();
    // 还挂在闸门里等表态：挂起表恰好一项
    const pendingMap = (gate as unknown as { pending: Map<string, unknown> }).pending;
    expect(pendingMap.size).toBe(1);
    const approvalId = pendingMap.keys().next().value as string;
    gate.resolve(approvalId, { action: "revise", feedback: "换成深色底" });
    const result = await pending;
    expect(result.structuredContent.review).toEqual({ action: "revise", feedback: "换成深色底" });
    expect(result.structuredContent.nextAction).toBe("regenerate_same_page_with_feedback");
  });

  it("无闸门 / 未布防 run：返回不带 review，nextAction 保持 fill_next_page", async () => {
    const gate = new SlidesReviewGate();
    const { tools } = harness(gate);
    const result = await tools.get("context_room_slides_set_page")!.execute(args, context);
    expect(result.structuredContent.review).toBeUndefined();
    expect(result.structuredContent.nextAction).toBe("fill_next_page");
  });

/** execute 内部先走 bridge mock（微任务），稍候一拍再读闸门挂起表。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("finish 表态：nextAction=stop_and_submit", async () => {
    const gate = new SlidesReviewGate();
    gate.arm("run-1", PLAN);
    const { tools } = harness(gate);
    const pending = tools.get("context_room_slides_set_page")!.execute(args, context);
    await settle();
    const approvalId = (gate as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string;
    gate.resolve(approvalId, { action: "finish" });
    const result = await pending;
    expect(result.structuredContent.nextAction).toBe("stop_and_submit");
  });
});
