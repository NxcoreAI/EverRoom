import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { PlanItem } from "@nxcore/agent-contract";

import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

/**
 * 计划端点的 HTTP 层验收：状态码与错误码映射、乐观锁、批量操作。
 *
 * 服务层语义（状态机 / 租约 / 认领包）在 `plan.test.ts` 里，这里只测"请求进来
 * 到出去"的那一层，避免两处重复。
 */

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-plan-routes-test-"));
  temporaryDirectories.push(dataDir);
  return {
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
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plan routes", () => {
  it("建任务 → 列表 → 改状态 → 乐观锁冲突 → 批量取消", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const empty = await app.inject({ method: "GET", url: "/v1/plan/items?workspaceId=default", headers });
      expect(empty.statusCode).toBe(200);
      expect(empty.json<{ items: PlanItem[] }>().items).toHaveLength(0);

      const created = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: { workspaceId: "default", title: "  整理成本表  ", priority: "high" },
      });
      expect(created.statusCode).toBe(201);
      const item = created.json<PlanItem>();
      expect(item.title).toBe("整理成本表");
      expect(item.status).toBe("todo");
      expect(item.priority).toBe("high");
      expect(item.version).toBe(1);

      const listed = await app.inject({ method: "GET", url: "/v1/plan/items?workspaceId=default", headers });
      expect(listed.json<{ items: PlanItem[] }>().items.map((entry) => entry.id)).toEqual([item.id]);

      const moved = await app.inject({
        method: "POST",
        url: `/v1/plan/items/${item.id}/move`,
        headers,
        payload: { version: item.version, status: "doing", ownerKind: "user" },
      });
      expect(moved.statusCode).toBe(200);
      const movedItem = moved.json<PlanItem>();
      expect(movedItem.status).toBe("doing");
      expect(movedItem.ownerKind).toBe("user");
      expect(movedItem.version).toBe(2);

      const stale = await app.inject({
        method: "PATCH",
        url: `/v1/plan/items/${item.id}`,
        headers,
        payload: { version: item.version, title: "旧版本改标题" },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json<{ error: string }>().error).toBe("plan_version_conflict");

      const second = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: { workspaceId: "default", title: "第二条" },
      });
      const secondItem = second.json<PlanItem>();

      const batch = await app.inject({
        method: "POST",
        url: "/v1/plan/items/batch",
        headers,
        payload: { ids: [movedItem.id, secondItem.id], action: "drop" },
      });
      expect(batch.statusCode).toBe(200);
      const result = batch.json<{ items: PlanItem[]; failed: unknown[] }>();
      expect(result.items).toHaveLength(2);
      expect(result.items.every((entry) => entry.status === "dropped")).toBe(true);

      const events = await app.inject({
        method: "GET",
        url: `/v1/plan/items/${movedItem.id}/events`,
        headers,
      });
      const kinds = events.json<{ events: Array<{ kind: string }> }>().events.map((event) => event.kind);
      expect(kinds).toContain("created");
      expect(kinds).toContain("moved");
      expect(kinds).toContain("dropped");
    } finally {
      await app.close();
    }
  });

  it("错误码映射：不存在的任务 404、空标题 400、坏空间 404", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/plan/items/nope", headers });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: string }>().error).toBe("plan_item_not_found");

      const blankTitle = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: { workspaceId: "default", title: "   " },
      });
      expect(blankTitle.statusCode).toBe(400);

      const badWorkspace = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: { workspaceId: "ws-does-not-exist", title: "x" },
      });
      expect(badWorkspace.statusCode).toBe(404);
      expect(badWorkspace.json<{ error: string }>().error).toBe("plan_workspace_not_found");

      const releaseWithoutReason = await app.inject({
        method: "POST",
        url: "/v1/plan/items/nope/release",
        headers,
        payload: { reason: "" },
      });
      expect(releaseWithoutReason.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("认领包预览包含人写的意图与材料引用", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: {
          workspaceId: "default",
          title: "写立项方案",
          detail: "背景原文",
          acceptance: "两页以内",
          constraints: ["只用 2025 年数据"],
          refs: [{ kind: "file", id: "file-1", title: "成本表.xlsx" }],
        },
      });
      const item = created.json<PlanItem>();
      const pkg = await app.inject({
        method: "GET",
        url: `/v1/plan/items/${item.id}/claim-package`,
        headers,
      });
      expect(pkg.statusCode).toBe(200);
      const body = pkg.json<{
        item: { detail: string; acceptance: string; constraints: string[] };
        materials: Array<{ kind: string; id: string }>;
        contract: { mustWriteResultSummary: boolean; leaseTtlSec: number };
      }>();
      expect(body.item.detail).toBe("背景原文");
      expect(body.item.acceptance).toBe("两页以内");
      expect(body.item.constraints).toEqual(["只用 2025 年数据"]);
      expect(body.materials).toEqual([expect.objectContaining({ kind: "file", id: "file-1" })]);
      expect(body.contract.mustWriteResultSummary).toBe(true);
      expect(body.contract.leaseTtlSec).toBe(600);
    } finally {
      await app.close();
    }
  });

  it("交给 Agent = 建会话 + 起 run，并把会话写回任务", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/plan/items",
        headers,
        payload: { workspaceId: "default", title: "写一版周报", acceptance: "三段以内" },
      });
      const item = created.json<PlanItem>();
      const assigned = await app.inject({
        method: "POST",
        url: `/v1/plan/items/${item.id}/assign`,
        headers,
        payload: {},
      });
      expect(assigned.statusCode).toBe(200);
      const result = assigned.json<{ item: PlanItem; sessionId: string; runId: string }>();
      expect(result.sessionId).toBeTruthy();
      expect(result.runId).toBeTruthy();
      expect(result.item.status).toBe("doing");
      expect(result.item.ownerKind).toBe("agent");
      expect(result.item.assigneeSessionId).toBe(result.sessionId);

      // 认领包渲染成了首条 prompt（技术指令），用户可见文案是"执行计划任务：…"
      const session = await app.inject({
        method: "GET",
        url: `/v1/agent/sessions/${result.sessionId}`,
        headers,
      });
      expect(session.statusCode).toBe(200);
      const events = await app.inject({
        method: "GET",
        url: `/v1/plan/items/${item.id}/events`,
        headers,
      });
      const kinds = events.json<{ events: Array<{ kind: string }> }>().events.map((event) => event.kind);
      expect(kinds).toContain("assigned");
    } finally {
      await app.close();
    }
  });

  it("MCP 端点暴露 tools/list 与 plan_create", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    try {
      const list = await app.inject({
        method: "POST",
        url: "/v1/mcp/plan",
        headers,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(list.statusCode).toBe(200);
      const tools = list.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name);
      expect(tools).toContain("plan_list");
      expect(tools).toContain("plan_claim");

      const call = await app.inject({
        method: "POST",
        url: "/v1/mcp/plan",
        headers,
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "plan_create",
            arguments: { workspaceId: "default", title: "来自 MCP 的任务", agentId: "claude-code" },
          },
        },
      });
      expect(call.statusCode).toBe(200);
      const created = call.json<{ result: { structuredContent: { item: PlanItem } } }>();
      expect(created.result.structuredContent.item.title).toBe("来自 MCP 的任务");
      expect(created.result.structuredContent.item.createdBy).toBe("agent");
    } finally {
      await app.close();
    }
  });
});
