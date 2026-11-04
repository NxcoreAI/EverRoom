import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryRoutes } from "../src/modules/memory/routes.js";
import { MemoryService } from "../src/modules/memory/service.js";

let root: string;
let service: MemoryService;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nxcore-memory-routes-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
  app = Fastify();
  // 路由用 @fastify/type-provider-typebox 的类型，注册时不需要额外插件即可工作。
  await app.register(memoryRoutes(service));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("memory routes", () => {
  it("reports status with scope buckets", async () => {
    service.remember({ content: "用户偏好简体中文", scope: "room:a" });

    const response = await app.inject({ method: "GET", url: "/v1/memory/status" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(true);
    expect(body.started).toBe(true);
    expect(body.total).toBe(1);
    expect(body.scopes["room:a"]).toBe(1);
  });

  it("lists entries without internal search keys", async () => {
    service.remember({ content: "用户偏好简体中文撰写文档", tags: ["偏好"] });

    const response = await app.inject({ method: "GET", url: "/v1/memory/entries?limit=10" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].content).toBe("用户偏好简体中文撰写文档");
    expect(body.items[0].tags).toEqual(["偏好"]);
  });

  it("returns the profile view (aggregate first, tag fallback otherwise)", async () => {
    service.remember({ content: "用户姓名李展萍", tags: ["身份", "称呼"] });
    service.remember({ content: "导出乱码 → 先转 UTF-8", tags: ["经验"], category: "lesson" });

    const fallback = await app.inject({ method: "GET", url: "/v1/memory/profile" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toMatchObject({
      source: "fallback",
      groups: [{ title: "身份", items: [{ content: "用户姓名李展萍" }] }],
    });

    // 有聚合产物时只展示聚合结果
    service.remember({ content: "正式文档用简体中文", tags: ["画像", "偏好"] });
    const aggregated = await app.inject({ method: "GET", url: "/v1/memory/profile" });
    expect(aggregated.json()).toMatchObject({
      source: "aggregate",
      groups: [{ title: "偏好", items: [{ content: "正式文档用简体中文" }] }],
    });
  });

  it("accepts a limit above the old 50 cap", async () => {
    for (let index = 0; index < 3; index += 1) {
      service.remember({ content: `记忆条目 ${index}`, tags: ["偏好"] });
    }
    const response = await app.inject({ method: "GET", url: "/v1/memory/entries?limit=100" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(3);
  });

  it("searches with a Chinese query", async () => {
    service.remember({ content: "部署前必须跑数据库迁移" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      payload: { query: "数据库迁移" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
  });

  it("deletes an entry and 404s on repeat", async () => {
    const id = service.remember({ content: "临时记忆" });
    if (!id) throw new Error("remember failed");

    const first = await app.inject({ method: "DELETE", url: `/v1/memory/entries/${id}` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await app.inject({ method: "DELETE", url: `/v1/memory/entries/${id}` });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toEqual({ message: "memory_not_found" });
  });

  it("keeps endpoints inert when memory is disabled", async () => {
    const disabledRoot = join(root, "disabled");
    const disabled = new MemoryService({ root: disabledRoot, enabled: false });
    disabled.start();
    const disabledApp = Fastify();
    await disabledApp.register(memoryRoutes(disabled));
    await disabledApp.ready();

    const status = await disabledApp.inject({ method: "GET", url: "/v1/memory/status" });
    expect(status.json()).toMatchObject({ enabled: false, started: false, total: 0 });

    const list = await disabledApp.inject({ method: "GET", url: "/v1/memory/entries" });
    expect(list.json()).toEqual({ items: [] });

    const profile = await disabledApp.inject({ method: "GET", url: "/v1/memory/profile" });
    expect(profile.json()).toEqual({ source: "empty", groups: [] });

    await disabledApp.close();
  });
});
