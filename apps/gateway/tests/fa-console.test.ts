import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { roomEntityFacts, rooms } from "../src/infrastructure/database/schema.js";
import { faConsoleRoutes } from "../src/modules/fa-console/routes.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let app: ReturnType<typeof Fastify> & { inject: unknown };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-console-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;

  db.insert(rooms).values([
    { id: "proj-1", title: "某AI项目", kind: "项目", origin: "user" },
    { id: "inst-1", title: "测试机构", kind: "机构", origin: "user" },
    { id: "person-1", title: "李合伙人", kind: "人物", origin: "user" },
  ]).onConflictDoNothing().run();

  db.insert(roomEntityFacts).values([
    {
      id: "fact-1", roomId: "proj-1", factId: "f1", content: "2025 年收入 1200 万元",
      type: "属性", grade: "fact", sourceKind: "everroom-doc", sourceId: "doc-1", sourceVersion: 1,
      numeric: { value: 1200, unit: "万元", period: "2025", currency: "CNY" },
    },
    {
      id: "fact-2", roomId: "proj-1", factId: "f2", content: "预计明年翻倍",
      type: "属性", grade: "forecast", sourceKind: "everroom-doc", sourceId: "doc-1", sourceVersion: 1,
    },
  ]).onConflictDoNothing().run();

  const fastify = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await fastify.register(faConsoleRoutes(db));
  await fastify.ready();
  app = fastify as never;
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

describe("FA 分析控制台节点注册表", () => {
  it("返回全部节点，每个节点带真实输入/产出/工具/执行通道", async () => {
    const res = await (app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { nodes: Array<Record<string, unknown>> } }> })
      .inject({ method: "GET", url: "/v1/fa-console/nodes" });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json();
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    const byId = Object.fromEntries(nodes.map((n) => [n.id as string, n]));
    // 八站齐备：进入/核实/档案/模板/DD/BP/匹配/简报/反馈/回流
    for (const id of ["intake", "verification", "archive", "bp-template", "dd-list", "bp-slides", "matching", "meeting-brief", "feedback", "loopback"]) {
      expect(byId[id], `missing node ${id}`).toBeTruthy();
    }
    // 提示词节点声明 agent run 通道与 trace 读法
    expect(JSON.stringify(byId["dd-list"]?.tools)).toContain("/v1/agent/sessions/:sessionId/runs");
    // 模板节点指向新 REST
    expect(JSON.stringify(byId["bp-template"]?.outputs)).toContain("/v1/fa-console/bp-template");
    // 每个节点都有输入与产出说明
    for (const node of nodes) {
      expect((node.inputs as unknown[]).length).toBeGreaterThan(0);
      expect((node.outputs as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

describe("Room 选择器与事实流", () => {
  it("rooms 列表支持 kind 过滤", async () => {
    const inject = app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { items: Array<{ id: string; kind: string }> } }> };
    const all = await inject.inject({ method: "GET", url: "/v1/fa-console/rooms" });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((r) => r.id)).toEqual(expect.arrayContaining(["proj-1", "inst-1", "person-1"]));

    const institutions = await inject.inject({ method: "GET", url: "/v1/fa-console/rooms?kind=%E6%9C%BA%E6%9E%84" });
    expect(institutions.json().items.map((r) => r.id)).toEqual(["inst-1"]);
  });

  it("facts 按房间取数并支持 grade 过滤", async () => {
    const inject = app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { items: Array<{ id: string; grade: string; numeric: unknown }> } }> };
    const all = await inject.inject({ method: "GET", url: "/v1/fa-console/rooms/proj-1/facts" });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toHaveLength(2);

    const onlyFacts = await inject.inject({ method: "GET", url: "/v1/fa-console/rooms/proj-1/facts?grade=fact" });
    expect(onlyFacts.json().items).toHaveLength(1);
    expect(onlyFacts.json().items[0]?.numeric).toMatchObject({ value: 1200 });
  });
});

describe("bp-template 纯读渲染（与 bp_template_get 同源）", () => {
  it("合法选型返回 13 模块骨架", async () => {
    const inject = app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { ok: boolean; moduleCount: number; brief: string; trackId: string } }> };
    const res = await inject.inject({
      method: "POST", url: "/v1/fa-console/bp-template",
      payload: { trackId: "T01", stage: "growth" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.moduleCount).toBe(13);
    expect(body.brief).toContain("【模块骨架");
    expect(body.brief).toContain("检查重点");
  });

  it("未知赛道 422 且错误码与工具链一致", async () => {
    const inject = app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { error: string } }> };
    const res = await inject.inject({
      method: "POST", url: "/v1/fa-console/bp-template",
      payload: { trackId: "T99", stage: "early" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("BP_TEMPLATE_UNKNOWN_TRACK:T99");
  });

  it("未知专项叠加 422", async () => {
    const inject = app as never as { inject: (o: object) => Promise<{ statusCode: number; json: () => { error: string } }> };
    const res = await inject.inject({
      method: "POST", url: "/v1/fa-console/bp-template",
      payload: { trackId: "T01", stage: "early", addonIds: ["nope"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("BP_TEMPLATE_UNKNOWN_ADDON");
  });
});
