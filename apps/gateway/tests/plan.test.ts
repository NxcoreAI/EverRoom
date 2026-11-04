import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { agentWorkspaces } from "../src/infrastructure/database/schema.js";
import { CLAIM_HISTORY_LIMIT } from "../src/modules/plan/claim-package.js";
import { PlanError, PlanService, USER_ACTOR } from "../src/modules/plan/service.js";
import { rankBetween } from "../src/modules/plan/rank.js";

/**
 * 计划（任务 / todo）验收：
 * - 状态机与排序：四列互转、列内 rank 中点插入、completedAt / resultSummary 不变式；
 * - 认领：租约、幂等、抢占、过期回收、跨空间拒绝、依赖阻塞；
 * - 认领包：意图原文照搬、材料只给引用、history 封顶。
 */

let directory: string;
let database: DatabaseClient;
let clock: Date;

function tick(ms = 1_000): void {
  clock = new Date(clock.getTime() + ms);
}

function createService(overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}): PlanService {
  return new PlanService({
    db: database.db,
    now: () => clock,
    ...overrides,
  });
}

function seedWorkspace(id: string, name: string): void {
  database.db.insert(agentWorkspaces).values({
    id,
    name,
    kind: "custom",
    createdAt: clock,
    updatedAt: clock,
    lastOpenedAt: clock,
  }).run();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nxcore-plan-test-"));
  database = createDatabase(join(directory, "gateway.sqlite"), resolve("drizzle"));
  clock = new Date("2026-11-03T10:00:00.000Z");
  seedWorkspace("ws-1", "空间一");
  seedWorkspace("ws-2", "空间二");
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("plan service · 基础", () => {
  it("新建任务落在待开始，并按 rank 递增追加", () => {
    const plan = createService();
    const first = plan.create({ workspaceId: "ws-1", title: "  整理 Q3 成本对比表  " });
    tick();
    const second = plan.create({ workspaceId: "ws-1", title: "补 2025 年数据" });
    expect(first.title).toBe("整理 Q3 成本对比表");
    expect(first.status).toBe("todo");
    expect(first.version).toBe(1);
    expect(first.createdBy).toBe("user");
    expect(rankBetween(first.rank, second.rank)).toBeTruthy();
    const listed = plan.list({ workspaceId: "ws-1" });
    expect(listed.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("拒绝不存在的空间与空标题", () => {
    const plan = createService();
    expect(() => plan.create({ workspaceId: "ws-nope", title: "x" }))
      .toThrowError(expect.objectContaining({ code: "plan_workspace_not_found" }));
    expect(() => plan.create({ workspaceId: "ws-1", title: "   " }))
      .toThrowError(expect.objectContaining({ code: "plan_invalid_input" }));
  });

  it("version 不匹配时拒绝写入（乐观锁）", () => {
    const plan = createService();
    const item = plan.create({ workspaceId: "ws-1", title: "任务" });
    plan.update(item.id, { version: item.version, title: "改名" });
    expect(() => plan.update(item.id, { version: item.version, title: "再改" }))
      .toThrowError(expect.objectContaining({ code: "plan_version_conflict" }));
  });

  it("按空间与负责人过滤", () => {
    const plan = createService();
    plan.create({ workspaceId: "ws-1", title: "A" });
    plan.create({ workspaceId: "ws-2", title: "B" });
    expect(plan.list({ workspaceId: "ws-1" }).map((item) => item.title)).toEqual(["A"]);
    expect(plan.list({ workspaceId: "ws-1", owner: "agent" })).toHaveLength(0);
  });
});

describe("plan service · 状态机与排序", () => {
  it("拖到另一列按 beforeId/afterId 中点插入", () => {
    const plan = createService();
    const a = plan.create({ workspaceId: "ws-1", title: "A", status: "doing" });
    tick();
    const b = plan.create({ workspaceId: "ws-1", title: "B", status: "doing" });
    tick();
    const moving = plan.create({ workspaceId: "ws-1", title: "C" });
    tick();
    // 插到 A 之前
    const moved = plan.move(moving.id, {
      version: moving.version,
      status: "doing",
      afterId: a.id,
    });
    const order = plan.list({ workspaceId: "ws-1", status: "doing" }).map((item) => item.title);
    expect(order).toEqual(["C", "A", "B"]);
    expect(moved.status).toBe("doing");
    // 再插到 B 之后（列尾）
    const again = plan.move(moving.id, {
      version: moved.version,
      status: "doing",
      beforeId: b.id,
    });
    expect(plan.list({ workspaceId: "ws-1", status: "doing" }).map((item) => item.title))
      .toEqual(["A", "B", "C"]);
    expect(again.version).toBe(moved.version + 1);
  });

  it("完成需要结论（Agent 强制，用户可空），并写 completedAt", () => {
    const plan = createService();
    const item = plan.create({ workspaceId: "ws-1", title: "交付" });
    const agent = { kind: "agent" as const, id: "main", sessionId: "session-1" };
    expect(() => plan.move(item.id, { version: item.version, status: "done" }, agent))
      .toThrowError(expect.objectContaining({ code: "plan_result_required" }));
    const done = plan.move(item.id, {
      version: item.version,
      status: "done",
      resultSummary: "产出 xlsx 一份",
    }, agent);
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.resultSummary).toBe("产出 xlsx 一份");
    // 重开清空完成信息
    const reopened = plan.move(done.id, { version: done.version, status: "doing" });
    expect(reopened.completedAt).toBeNull();
  });

  it("取消后可以恢复并保留原因", () => {
    const plan = createService();
    const item = plan.create({ workspaceId: "ws-1", title: "不做了" });
    const dropped = plan.move(item.id, {
      version: item.version,
      status: "dropped",
      reason: "需求变更",
    });
    expect(dropped.status).toBe("dropped");
    expect(dropped.closeReason).toBe("需求变更");
    const restored = plan.move(dropped.id, { version: dropped.version, status: "todo" });
    expect(restored.closeReason).toBeNull();
    expect(restored.completedAt).toBeNull();
  });

  it("依赖不能成环", () => {
    const plan = createService();
    const a = plan.create({ workspaceId: "ws-1", title: "A" });
    const b = plan.create({ workspaceId: "ws-1", title: "B", blockedBy: [a.id] });
    expect(() => plan.update(b.id, { version: b.version, blockedBy: [a.id] })).not.toThrow();
    expect(() => plan.update(a.id, { version: a.version, blockedBy: [b.id] }))
      .toThrowError(expect.objectContaining({ code: "plan_dependency_cycle" }));
    expect(() => plan.update(a.id, { version: a.version, blockedBy: [a.id] }))
      .toThrowError(expect.objectContaining({ code: "plan_dependency_cycle" }));
  });
});

describe("plan service · 认领", () => {
  function claimFixture() {
    const plan = createService({ leaseTtlSec: 600 });
    const item = plan.create({ workspaceId: "ws-1", title: "整理成本表", detail: "背景原文" });
    tick();
    return { plan, item };
  }

  it("认领进入进行中并绑定会话与租约", () => {
    const { plan, item } = claimFixture();
    const pkg = plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" });
    expect(pkg.item.status).toBe("doing");
    const stored = plan.get(item.id);
    expect(stored.ownerKind).toBe("agent");
    expect(stored.ownerAgentId).toBe("main");
    expect(stored.assigneeSessionId).toBe("s1");
    expect(stored.leaseOwner).toBe("s1");
    expect(stored.leaseExpiresAt).toBeTruthy();
  });

  it("同一会话重复认领幂等，换会话则被拒", () => {
    const { plan, item } = claimFixture();
    plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" });
    tick();
    expect(() => plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" })).not.toThrow();
    expect(() => plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s2", agentId: "lite" }))
      .toThrowError(expect.objectContaining({ code: "plan_claimed_elsewhere" }));
  });

  it("跨空间认领一律拒绝", () => {
    const { plan, item } = claimFixture();
    expect(() => plan.claim(item.id, { workspaceId: "ws-2", sessionId: "s1", agentId: "main" }))
      .toThrowError(expect.objectContaining({ code: "plan_scope_mismatch" }));
  });

  it("释放写回原因，下一位认领者在 history 里能看到", () => {
    const { plan, item } = claimFixture();
    plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" });
    tick();
    const released = plan.release(item.id, { reason: "缺少 2025 年成本数据", sessionId: "s1", agentId: "main" });
    expect(released.status).toBe("todo");
    expect(released.ownerKind).toBe("unassigned");
    expect(released.assigneeSessionId).toBeNull();
    tick();
    const pkg = plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s2", agentId: "main" });
    expect(pkg.history.some((event) => event.kind === "released" && event.summary.includes("2025"))).toBe(true);
  });

  it("租约过期由回收器放回待开始，并记事件", () => {
    const { plan, item } = claimFixture();
    plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" });
    expect(plan.expireLeases()).toBe(0);
    clock = new Date(clock.getTime() + 700_000);
    expect(plan.expireLeases()).toBe(1);
    const stored = plan.get(item.id);
    expect(stored.status).toBe("todo");
    expect(stored.leaseOwner).toBeNull();
    const events = plan.events(item.id);
    expect(events.some((event) => event.kind === "lease_expired")).toBe(true);
  });

  it("用户指派优先，会收回别人的租约", async () => {
    const dispatches: Array<{ title: string; prompt: string }> = [];
    const plan = createService({
      dispatch: async ({ item, prompt }) => {
        dispatches.push({ title: item.title, prompt });
        return { sessionId: "session-assigned", runId: "run-1" };
      },
    });
    const item = plan.create({ workspaceId: "ws-1", title: "写周报", acceptance: "三段以内" });
    plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" });
    const assigned = await plan.assign(item.id, { agentId: "main" });
    expect(assigned.sessionId).toBe("session-assigned");
    expect(assigned.runId).toBe("run-1");
    expect(assigned.item.assigneeSessionId).toBe("session-assigned");
    expect(assigned.item.status).toBe("doing");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.prompt).toContain("三段以内");
    const events = plan.events(item.id);
    expect(events.some((event) => event.kind === "lease_preempted")).toBe(true);
  });

  it("依赖未完成时认领被拒", () => {
    const plan = createService();
    const dep = plan.create({ workspaceId: "ws-1", title: "先做的" });
    const item = plan.create({ workspaceId: "ws-1", title: "后做的", blockedBy: [dep.id] });
    expect(() => plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" }))
      .toThrowError(expect.objectContaining({ code: "plan_blocked" }));
    const done = plan.move(dep.id, { version: dep.version, status: "done", resultSummary: "完成" });
    expect(done.status).toBe("done");
    expect(() => plan.claim(item.id, { workspaceId: "ws-1", sessionId: "s1", agentId: "main" })).not.toThrow();
  });
});

describe("plan service · 认领包", () => {
  it("意图原文照搬、材料只给引用、history 封顶", () => {
    const plan = createService({
      spaceOf: () => ({
        name: "空间一",
        root: "/tmp/space-one",
        libraryPath: "/tmp/space-one/Library",
        artifactsPath: "/tmp/space-one/Library/outputs",
      }),
    });
    const item = plan.create({
      workspaceId: "ws-1",
      title: "整理成本表",
      detail: "  背景原文，不要改写  ",
      acceptance: "三页以内",
      constraints: ["只用 2025 年数据"],
      refs: [{ kind: "file", id: "file-1", title: "成本表.xlsx" }],
    });
    for (let index = 0; index < 12; index += 1) {
      const current = plan.get(item.id);
      plan.update(item.id, { version: current.version, note: `进展 ${index}` });
    }
    const pkg = plan.claimPackage(item.id);
    expect(pkg.item.detail).toBe("背景原文，不要改写");
    expect(pkg.item.acceptance).toBe("三页以内");
    expect(pkg.item.constraints).toEqual(["只用 2025 年数据"]);
    expect(pkg.materials).toHaveLength(1);
    expect(pkg.materials[0]).toMatchObject({ kind: "file", id: "file-1", title: "成本表.xlsx" });
    expect(JSON.stringify(pkg)).not.toContain("正文内容"); // 只给引用，不夹带正文
    expect(pkg.history.length).toBeLessThanOrEqual(CLAIM_HISTORY_LIMIT);
    expect(pkg.space.artifactsPath).toBe("/tmp/space-one/Library/outputs");
    expect(pkg.contract.mustWriteResultSummary).toBe(true);
    expect(pkg.contract.leaseTtlSec).toBe(600);
  });

  it("空间未绑定目录时 root 为 null，不假装能读写磁盘", () => {
    const plan = createService({ spaceOf: () => null });
    const item = plan.create({ workspaceId: "ws-1", title: "任务" });
    const pkg = plan.claimPackage(item.id);
    expect(pkg.space.root).toBeNull();
    expect(pkg.contract.outputHint).toBeNull();
  });
});

describe("rank", () => {
  it("中点严格位于两边之间", () => {
    expect(rankBetween(null, null)).toBe("V");
    const middle = rankBetween("V", "W");
    expect(middle > "V" && middle < "W").toBe(true);
    const deep = rankBetween("V", middle);
    expect(deep > "V" && deep < middle).toBe(true);
    const head = rankBetween(null, "0V");
    expect(head < "0V").toBe(true);
  });

  it("列尾追加递增且长度稳定", () => {
    let current = rankBetween(null, null);
    const lengths = new Set<number>();
    for (let index = 0; index < 20; index += 1) {
      lengths.add(current.length);
      const next = rankBetween(current, null);
      expect(next > current).toBe(true);
      current = next;
    }
    expect(lengths.size).toBe(1);
  });

  it("顺序颠倒时报错", () => {
    expect(() => rankBetween("W", "V")).toThrowError("plan_rank_order_invalid");
  });
});

describe("plan errors", () => {
  it("找不到任务时给出稳定 code", () => {
    const plan = createService();
    try {
      plan.get("nope");
      throw new Error("should not reach");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanError);
      expect((error as PlanError).code).toBe("plan_item_not_found");
    }
  });

  it("USER_ACTOR 是用户", () => {
    expect(USER_ACTOR.kind).toBe("user");
  });
});
