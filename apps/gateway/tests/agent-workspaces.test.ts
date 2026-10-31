import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentWorkspace } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-workspaces-test-"));
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

describe("agent workspaces", () => {
  it("seeds and protects the default workspace", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const initial = await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers });
    expect(initial.statusCode).toBe(200);
    const workspaces = initial.json<AgentWorkspace[]>();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: "default",
      name: "默认工作区",
      path: null,
      kind: "default",
    });

    const removed = await app.inject({ method: "DELETE", url: "/v1/agent/workspaces/default", headers });
    expect(removed.statusCode).toBe(409);
    expect(removed.json<{ error: string }>().error).toBe("default_immutable");
    await app.close();
  });

  it("creates, renames, reorders, and deletes custom workspaces", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "项目 A", path: config.dataDir },
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json<AgentWorkspace>();
    expect(workspace).toMatchObject({ name: "项目 A", path: config.dataDir, kind: "custom" });
    expect(workspace.id).not.toBe("default");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { name: "项目 B", lastOpenedAt: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<AgentWorkspace>().name).toBe("项目 B");

    // 最近打开时间倒序：刚 touch 的自定义工作区排在默认工作区之前。
    const listed = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(listed.map((item) => item.id)).toEqual([workspace.id, "default"]);

    const relativePath = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { path: "relative/dir" },
    });
    expect(relativePath.statusCode).toBe(400);
    expect(relativePath.json<{ error: string }>().error).toBe("invalid_workspace_path");

    const blankName = await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "   " },
    });
    expect(blankName.statusCode).toBe(400);
    expect(blankName.json<{ error: string }>().error).toBe("invalid_workspace_name");

    expect((await app.inject({
      method: "PATCH",
      url: "/v1/agent/workspaces/missing",
      headers,
      payload: { name: "无此工作区" },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE",
      url: "/v1/agent/workspaces/missing",
      headers,
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: "DELETE",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
    })).statusCode).toBe(204);
    const remaining = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(remaining.map((item) => item.id)).toEqual(["default"]);
    await app.close();
  });

  it("assigns sessions to workspaces, filters by workspace, and re-homes on delete", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const workspace = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "项目 A" },
    })).json<AgentWorkspace>();

    const defaultSession = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "工作台" },
    })).json<AgentSession>();
    expect(defaultSession.workspaceId).toBe("default");

    const workspaceSession = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "工作台", workspaceId: workspace.id },
    })).json<AgentSession>();
    expect(workspaceSession.workspaceId).toBe(workspace.id);

    // 不存在的工作区 id 回落默认工作区，不报错。
    const fallbackSession = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "工作台", workspaceId: "missing-workspace" },
    })).json<AgentSession>();
    expect(fallbackSession.workspaceId).toBe("default");

    const all = (await app.inject({ method: "GET", url: "/v1/agent/sessions", headers }))
      .json<AgentSession[]>();
    expect(all).toHaveLength(3);

    const filtered = (await app.inject({
      method: "GET",
      url: `/v1/agent/sessions?workspaceId=${encodeURIComponent(workspace.id)}`,
      headers,
    })).json<AgentSession[]>();
    expect(filtered.map((session) => session.id)).toEqual([workspaceSession.id]);

    const defaultFiltered = (await app.inject({
      method: "GET",
      url: "/v1/agent/sessions?workspaceId=default",
      headers,
    })).json<AgentSession[]>();
    expect(new Set(defaultFiltered.map((session) => session.id)))
      .toEqual(new Set([defaultSession.id, fallbackSession.id]));

    const none = (await app.inject({
      method: "GET",
      url: "/v1/agent/sessions?workspaceId=missing-workspace",
      headers,
    })).json<AgentSession[]>();
    expect(none).toEqual([]);

    // 删除工作区后，其会话回落到默认工作区（不留孤儿）。
    await app.inject({ method: "DELETE", url: `/v1/agent/workspaces/${workspace.id}`, headers });
    const rehomed = (await app.inject({
      method: "GET",
      url: "/v1/agent/sessions?workspaceId=default",
      headers,
    })).json<AgentSession[]>();
    expect(new Set(rehomed.map((session) => session.id)))
      .toEqual(new Set([defaultSession.id, fallbackSession.id, workspaceSession.id]));
    expect(rehomed.every((session) => session.workspaceId === "default")).toBe(true);
    await app.close();
  });

  it("persists description and goals metadata across create, update, and list", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    // 创建时带描述与目标；首尾空白应在落库前 trim。
    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: {
        name: "项目 Meta",
        description: "  面向概览页的空间描述  ",
        goals: ["  发布首个版本  ", "补齐文档"],
      },
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json<AgentWorkspace>();
    expect(workspace).toMatchObject({
      name: "项目 Meta",
      description: "面向概览页的空间描述",
      goals: ["发布首个版本", "补齐文档"],
    });

    // 列表回读新字段；未填写的默认工作区为 null / []。
    const listed = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>();
    expect(listed.find((item) => item.id === workspace.id)).toMatchObject({
      description: "面向概览页的空间描述",
      goals: ["发布首个版本", "补齐文档"],
    });
    expect(listed.find((item) => item.id === "default")).toMatchObject({ description: null, goals: [] });

    // 更新：description 传 null 清空，goals 整体替换。
    const replaced = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { description: null, goals: ["新目标"] },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<AgentWorkspace>()).toMatchObject({ description: null, goals: ["新目标"] });

    // 空白描述等价于清空；goals 传 [] 清空。
    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { description: "   ", goals: [] },
    });
    expect(cleared.json<AgentWorkspace>()).toMatchObject({ description: null, goals: [] });

    // 边界值：2000 字符描述与 12 条目标均允许。
    const boundaryDescription = "描".repeat(2_000);
    const boundaryGoals = Array.from({ length: 12 }, (_, index) => `目标 ${index + 1}`);
    const boundary = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { description: boundaryDescription, goals: boundaryGoals },
    });
    expect(boundary.statusCode).toBe(200);
    const boundaryWorkspace = boundary.json<AgentWorkspace>();
    expect(boundaryWorkspace.description).toHaveLength(2_000);
    expect(boundaryWorkspace.goals).toEqual(boundaryGoals);

    // 持久化回读。
    const reread = (await app.inject({
      method: "GET",
      url: `/v1/agent/workspaces`,
      headers,
    })).json<AgentWorkspace[]>().find((item) => item.id === workspace.id);
    expect(reread).toMatchObject({ description: boundaryDescription, goals: boundaryGoals });

    // 未传元数据的自定义工作区：null / []。
    const bare = (await app.inject({
      method: "POST",
      url: "/v1/agent/workspaces",
      headers,
      payload: { name: "无元数据" },
    })).json<AgentWorkspace>();
    expect(bare).toMatchObject({ description: null, goals: [] });

    // 非法输入：空白目标项由 service 校验并映射为 invalid_workspace_goals。
    const blankGoal = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { goals: ["有效目标", "   "] },
    });
    expect(blankGoal.statusCode).toBe(400);
    expect(blankGoal.json<{ error: string }>().error).toBe("invalid_workspace_goals");

    // 非法输入：超长描述、超长目标项、目标条数超限由路由 JSON schema 拦截。
    const tooLongDescription = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { description: "x".repeat(2_001) },
    });
    expect(tooLongDescription.statusCode).toBe(400);

    const tooLongGoal = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { goals: ["y".repeat(201)] },
    });
    expect(tooLongGoal.statusCode).toBe(400);

    const tooManyGoals = await app.inject({
      method: "PATCH",
      url: `/v1/agent/workspaces/${workspace.id}`,
      headers,
      payload: { goals: Array.from({ length: 13 }, (_, index) => `目标 ${index + 1}`) },
    });
    expect(tooManyGoals.statusCode).toBe(400);

    // 非法输入未落库：仍保留边界值。
    const untouched = (await app.inject({ method: "GET", url: "/v1/agent/workspaces", headers }))
      .json<AgentWorkspace[]>().find((item) => item.id === workspace.id);
    expect(untouched).toMatchObject({ description: boundaryDescription, goals: boundaryGoals });
    await app.close();
  });
});