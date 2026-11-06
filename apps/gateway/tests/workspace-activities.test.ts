import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { createServer } from "../src/server/create-server.js";
import {
  agentEvents,
  agentRuns,
  agentSessions,
  agentWorkspaces,
  fileEntries,
} from "../src/infrastructure/database/schema.js";
import { PlanService } from "../src/modules/plan/service.js";
import { workspaceActivityRoutes } from "../src/modules/workspace-activity/routes.js";
import {
  WorkspaceActivityError,
  WorkspaceActivityService,
} from "../src/modules/workspace-activity/service.js";

/**
 * 概览「动态」派生读模型验收（`docs/workspace-overview-activity-plan.zh-CN.md` §5）：
 * - 三源合并：`agent_runs`（开始/结束各一条）、`file_entries`（产物/材料）、
 *   `workspace_plan_item_events`（计划事件流）；
 * - 会话只在「从没跑过 run」时出一條 `work-created`，跑过的由 run 事件覆盖，不重复；
 * - 空间隔离、软删文件不出现、游标分页不重不漏、空间不存在时报错。
 */

let directory: string;
let database: DatabaseClient;
let service: WorkspaceActivityService;

/** 固定时钟：排序断言不依赖真实时间。 */
const T0 = new Date("2026-11-03T10:00:00.000Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function seedWorkspace(id: string, name = id): void {
  database.db.insert(agentWorkspaces).values({
    id,
    name,
    kind: "custom",
    createdAt: T0,
    updatedAt: T0,
    lastOpenedAt: T0,
  }).run();
}

function seedSession(id: string, workspaceId: string, createdAt: Date, status: "idle" | "running" | "closed" = "idle"): void {
  database.db.insert(agentSessions).values({
    id,
    workspaceId,
    pageLabel: "概览",
    runtimeId: "pi:main",
    activeAgentId: "main",
    title: `工作 ${id}`,
    status,
    createdAt,
    updatedAt: createdAt,
  }).run();
}

function seedRun(input: {
  id: string;
  sessionId: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  status?: "running" | "completed" | "failed";
}): void {
  database.db.insert(agentRuns).values({
    id: input.id,
    sessionId: input.sessionId,
    agentId: "main",
    idempotencyKey: `key-${input.id}`,
    prompt: "干活",
    status: input.status ?? "completed",
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.startedAt ?? T0,
  }).run();
}

function seedFile(input: {
  id: string;
  workspaceId: string;
  updatedAt: Date;
  sourceKind?: "agent-generated" | "manual-upload" | "artifact-imported" | "connector";
  deletedAt?: Date | null;
}): void {
  database.db.insert(fileEntries).values({
    id: input.id,
    sourceKind: input.sourceKind ?? "manual-upload",
    sourceKey: `key-${input.id}`,
    originalName: `${input.id}.docx`,
    extension: "docx",
    workspaceId: input.workspaceId,
    state: input.deletedAt ? "deleted" : "ready",
    deletedAt: input.deletedAt ?? null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  }).run();
}

function seedApproval(input: {
  id: string;
  runId: string;
  sessionId: string;
  type: "approval.requested" | "approval.resolved";
  approvalId: string;
  toolName?: string;
  seq: number;
  at: Date;
}): void {
  database.db.insert(agentEvents).values({
    id: input.id,
    sessionId: input.sessionId,
    runId: input.runId,
    seq: input.seq,
    type: input.type,
    payload: {
      approvalId: input.approvalId,
      toolName: input.toolName ?? "bash",
      command: "npm test",
    },
    createdAt: input.at,
  }).run();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nxcore-workspace-activity-test-"));
  database = createDatabase(join(directory, "gateway.sqlite"), resolve("drizzle"));
  service = new WorkspaceActivityService({ db: database.db });
  seedWorkspace("ws-1");
  seedWorkspace("ws-2");
});

afterEach(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("workspace activities · 合并与语义", () => {
  it("run 的开始与结束各一条事件，文件按产物/材料分流，计划事件带任务引用", () => {
    seedSession("s-1", "ws-1", at(0), "running");
    seedRun({ id: "run-1", sessionId: "s-1", startedAt: at(1), completedAt: at(9) });
    seedFile({ id: "f-gen", workspaceId: "ws-1", updatedAt: at(3), sourceKind: "agent-generated" });
    seedFile({ id: "f-conn", workspaceId: "ws-1", updatedAt: at(2), sourceKind: "connector" });

    const plan = new PlanService({ db: database.db, now: () => at(10) });
    plan.create({ workspaceId: "ws-1", title: "整理成本表" });

    const page = service.list("ws-1");
    const ids = page.items.map((item) => item.id);
    // 计划事件时间最晚（at(10)）→ 排第一；随后 run 结束 → 文件 → run 开始。
    expect(ids[0]).toMatch(/^plan:/);
    expect(ids[1]).toBe("run:run-1:end");
    expect(ids[2]).toBe("file:f-gen");
    expect(ids[3]).toBe("file:f-conn");
    expect(ids[4]).toBe("run:run-1:start");

    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get("run:run-1:start")?.kind).toBe("work-run");
    expect(byId.get("run:run-1:start")?.segments).toEqual([{ text: "开始了工作 " }, { sessionId: "s-1" }]);
    expect(byId.get("run:run-1:end")?.kind).toBe("work-done");
    expect(byId.get("run:run-1:end")?.at).toBe(at(9).toISOString());
    expect(byId.get("file:f-gen")?.kind).toBe("output");
    expect(byId.get("file:f-gen")?.segments).toEqual([{ text: "生成了 " }, { fileId: "f-gen" }]);
    expect(byId.get("file:f-conn")?.kind).toBe("material");
    expect(byId.get("file:f-conn")?.segments).toEqual([{ text: "添加了材料 " }, { fileId: "f-conn" }]);
    expect(byId.get(ids[0]!)?.segments[0]).toHaveProperty("planItemId");

    // 引用只带 id，不带展示名（改名后历史自动跟随）。
    for (const item of page.items) {
      for (const segment of item.segments) {
        expect(segment).not.toHaveProperty("name");
        expect(segment).not.toHaveProperty("title");
      }
    }
  });

  it("失败的 run 出「执行失败」，仍是 work-done 视觉分组", () => {
    seedSession("s-1", "ws-1", at(0), "running");
    seedRun({ id: "run-bad", sessionId: "s-1", startedAt: at(1), completedAt: at(2), status: "failed" });

    const end = service.list("ws-1").items.find((item) => item.id === "run:run-bad:end");
    expect(end?.kind).toBe("work-done");
    expect(end?.segments).toEqual([{ text: "执行失败 " }, { sessionId: "s-1" }]);
  });

  it("从没跑过 run 的会话出一条 work-created；跑过的会话不重复出", () => {
    seedSession("s-run", "ws-1", at(0), "running");
    seedRun({ id: "run-1", sessionId: "s-run", startedAt: at(1), completedAt: at(2) });
    seedSession("s-new", "ws-1", at(3));

    const ids = service.list("ws-1").items.map((item) => item.id);
    expect(ids).toContain("session:s-new");
    expect(ids).not.toContain("session:s-run");
    const created = service.list("ws-1").items.find((item) => item.id === "session:s-new");
    expect(created?.kind).toBe("work-created");
    expect(created?.segments).toEqual([{ text: "新建了工作 " }, { sessionId: "s-new" }]);
  });

  it("软删文件与其它空间的事件都不出现", () => {
    // ws-2 已在 beforeEach 里建好，这里只放不属于 ws-1 的事件。
    seedFile({ id: "f-gone", workspaceId: "ws-1", updatedAt: at(4), deletedAt: at(5) });
    seedFile({ id: "f-other", workspaceId: "ws-2", updatedAt: at(6) });
    seedSession("s-other", "ws-2", at(7));

    const ids = service.list("ws-1").items.map((item) => item.id);
    expect(ids).toEqual([]);

    const other = service.list("ws-2").items.map((item) => item.id);
    expect(other).toEqual(["session:s-other", "file:f-other"]);
  });

  it("空间不存在时报 workspace_not_found", () => {
    expect(() => service.list("ws-nope"))
      .toThrowError(expect.objectContaining({ code: "workspace_not_found" }));
    expect(() => service.list("ws-nope")).toThrow(WorkspaceActivityError);
  });
});

describe("workspace activities · 游标分页", () => {
  it("(at, id) 双键游标翻页不重不漏", () => {
    // 同一毫秒塞三条：单键游标会漏条，双键必须稳定。
    for (const id of ["f-a", "f-b", "f-c"]) {
      seedFile({ id, workspaceId: "ws-1", updatedAt: at(1) });
    }
    seedFile({ id: "f-d", workspaceId: "ws-1", updatedAt: at(2) });

    const seen: string[] = [];
    let cursor: { beforeAt?: string; beforeId?: string } = {};
    for (let guard = 0; guard < 10; guard += 1) {
      const page = service.list("ws-1", { limit: 2, ...cursor });
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextBeforeAt) break;
      cursor = page.nextBeforeId
        ? { beforeAt: page.nextBeforeAt, beforeId: page.nextBeforeId }
        : { beforeAt: page.nextBeforeAt };
    }

    expect(seen).toEqual(["file:f-d", "file:f-c", "file:f-b", "file:f-a"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("最后一页不给游标（前端不必再判断空页）", () => {
    seedFile({ id: "f-only", workspaceId: "ws-1", updatedAt: at(1) });
    const page = service.list("ws-1", { limit: 8 });
    expect(page.items).toHaveLength(1);
    expect(page.nextBeforeAt).toBeNull();
    expect(page.nextBeforeId).toBeNull();
  });

  it("limit 夹在 1..50", () => {
    for (let index = 0; index < 5; index += 1) {
      seedFile({ id: `f-${index}`, workspaceId: "ws-1", updatedAt: at(index) });
    }
    expect(service.list("ws-1", { limit: 0 }).items).toHaveLength(1);
    expect(service.list("ws-1", { limit: 999 }).items).toHaveLength(5);
  });
});

describe("workspace activities · HTTP 层", () => {
  it("GET 返回一页事件；游标透传；空间不存在 404", async () => {
    seedFile({ id: "f-1", workspaceId: "ws-1", updatedAt: at(1), sourceKind: "agent-generated" });
    seedFile({ id: "f-2", workspaceId: "ws-1", updatedAt: at(2) });

    const app = Fastify();
    await app.register(workspaceActivityRoutes(service));
    try {
      const first = await app.inject({
        method: "GET",
        url: "/v1/agent/workspaces/ws-1/activities?limit=1",
      });
      expect(first.statusCode).toBe(200);
      const page1 = first.json<{ items: { id: string }[]; nextBeforeAt: string | null; nextBeforeId: string | null }>();
      expect(page1.items.map((item) => item.id)).toEqual(["file:f-2"]);
      expect(page1.nextBeforeAt).toBe(at(2).toISOString());
      expect(page1.nextBeforeId).toBe("file:f-2");

      const second = await app.inject({
        method: "GET",
        url: `/v1/agent/workspaces/ws-1/activities?limit=1&beforeAt=${encodeURIComponent(page1.nextBeforeAt!)}&beforeId=${encodeURIComponent(page1.nextBeforeId!)}`,
      });
      expect(second.statusCode).toBe(200);
      const page2 = second.json<{ items: { id: string }[]; nextBeforeAt: string | null }>();
      expect(page2.items.map((item) => item.id)).toEqual(["file:f-1"]);
      expect(page2.nextBeforeAt).toBeNull();

      const missing = await app.inject({ method: "GET", url: "/v1/agent/workspaces/ws-nope/activities" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: string }>().error).toBe("workspace_not_found");
    } finally {
      await app.close();
    }
  });
});

describe("workspace activities · 真实网关挂载", () => {
  it("createServer 挂上端点、强制鉴权、空空间返回空页", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-ws-activity-route-"));
    const config: GatewayConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      databasePath: join(dataDir, "database", "gateway.sqlite"),
      migrationsDir: resolve("drizzle"),
      runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
      logLevel: "silent",
      authToken: "test-token-0123456789",
      agentRuntime: "fake",
      pi: null,
      cursorCompletionPi: null,
      litePi: null,
      backgroundPi: null,
      webSearch: null,
      mcpConfigPath: join(dataDir, "agent", "mcp.json"),
    };
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/v1/agent/workspaces/default/activities",
      });
      expect(unauthorized.statusCode).toBe(401);

      const created = await app.inject({
        method: "POST",
        url: "/v1/agent/workspaces",
        headers,
        payload: { name: "动态验收空间" },
      });
      expect(created.statusCode).toBeLessThan(300);
      const workspaceId = created.json<{ id: string }>().id;

      const page = await app.inject({
        method: "GET",
        url: `/v1/agent/workspaces/${workspaceId}/activities?limit=8`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json<{ items: unknown[]; nextBeforeAt: string | null }>()).toMatchObject({
        items: [],
        nextBeforeAt: null,
        nextBeforeId: null,
      });

      const missing = await app.inject({
        method: "GET",
        url: "/v1/agent/workspaces/ws-nope/activities",
        headers,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: string }>().error).toBe("workspace_not_found");
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
describe("workspace activities · 等你确认（活状态）", () => {
  it("跑着的 run 里有未处理的审批 → 出一条 work-review，引用回会话", () => {
    seedSession("s-1", "ws-1", at(0), "running");
    seedRun({ id: "run-1", sessionId: "s-1", startedAt: at(1), status: "running" });
    seedApproval({ id: "ev-1", runId: "run-1", sessionId: "s-1", type: "approval.requested", approvalId: "apr-1", toolName: "bash", seq: 3, at: at(2) });

    const rows = service.list("ws-1").items;
    const review = rows.find((item) => item.id === "approval:run-1:apr-1");
    expect(review).toBeDefined();
    expect(review?.kind).toBe("work-review");
    expect(review?.segments).toEqual([
      { text: "等你确认 " },
      { sessionId: "s-1" },
      { text: " · bash" },
    ]);
    expect(review?.source.table).toBe("agent_events");
    // 时间 = 卡片弹出（requested）的时刻，排位自然靠前。
    expect(review?.at).toBe(at(2).toISOString());
  });

  it("approval.resolved 落地后行消失；run 结束后也不再出", () => {
    seedSession("s-1", "ws-1", at(0), "running");
    seedRun({ id: "run-1", sessionId: "s-1", startedAt: at(1), status: "running" });
    seedApproval({ id: "ev-1", runId: "run-1", sessionId: "s-1", type: "approval.requested", approvalId: "apr-1", seq: 3, at: at(2) });
    seedApproval({ id: "ev-2", runId: "run-1", sessionId: "s-1", type: "approval.resolved", approvalId: "apr-1", seq: 4, at: at(3) });
    // 已完成的 run：卡早已无效。
    seedSession("s-2", "ws-1", at(0), "idle");
    seedRun({ id: "run-done", sessionId: "s-2", startedAt: at(1), completedAt: at(4), status: "completed" });
    seedApproval({ id: "ev-3", runId: "run-done", sessionId: "s-2", type: "approval.requested", approvalId: "apr-2", seq: 5, at: at(5) });

    expect(service.list("ws-1").items.filter((item) => item.kind === "work-review")).toEqual([]);
  });

  it("其它空间的审批不出；同一张卡只出一行", () => {
    seedSession("s-1", "ws-1", at(0), "running");
    seedRun({ id: "run-1", sessionId: "s-1", startedAt: at(1), status: "running" });
    // 同一 approvalId 重发（重试）：seq 不同、时间不同，只保留一行。
    seedApproval({ id: "ev-1", runId: "run-1", sessionId: "s-1", type: "approval.requested", approvalId: "apr-1", seq: 3, at: at(2) });
    seedApproval({ id: "ev-1b", runId: "run-1", sessionId: "s-1", type: "approval.requested", approvalId: "apr-1", seq: 6, at: at(6) });

    seedSession("s-9", "ws-2", at(0), "running");
    seedRun({ id: "run-9", sessionId: "s-9", startedAt: at(1), status: "running" });
    seedApproval({ id: "ev-9", runId: "run-9", sessionId: "s-9", type: "approval.requested", approvalId: "apr-9", seq: 3, at: at(2) });

    const reviews = service.list("ws-1").items.filter((item) => item.kind === "work-review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe("approval:run-1:apr-1");
  });
});
