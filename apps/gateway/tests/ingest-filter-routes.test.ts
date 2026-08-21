import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import pino from "pino";
import { ingestRoutes } from "../src/modules/ingest/routes.js";
import { FilterRulesStore, USER_PREFERENCE_END, USER_PREFERENCE_START } from "../src/modules/ingest/rules.js";
import type { IngestService } from "../src/modules/ingest/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger = pino({ level: "silent" });

async function appWithRules() {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-api-"));
  temporaryDirectories.push(dir);
  const file = join(dir, "ingest", "filter-rules.md");
  await mkdir(join(dir, "ingest"), { recursive: true });
  await writeFile(file, [
    "# Ingest 过滤规则",
    "",
    USER_PREFERENCE_START,
    "- 默认偏好",
    USER_PREFERENCE_END,
    "",
    "<!-- everroom:filter:system-insight:start -->",
    "<!-- everroom:filter:system-insight:end -->",
    "",
  ].join("\n"), "utf8");
  const store = new FilterRulesStore({ filePath: file, maxBytes: 2048 }, silentLogger);
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await app.register(ingestRoutes({} as IngestService, store, async () => undefined));
  return { app, store, file, dir };
}

describe("过滤规则 API", () => {
  it("GET /v1/ingest/filter/rules 返回两段", async () => {
    const { app } = await appWithRules();
    const response = await app.inject({ method: "GET", url: "/v1/ingest/filter/rules" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ preference: "- 默认偏好", insight: "" });
    await app.close();
  });

  it("PUT preference 重写偏好段并失效缓存（下一次 GET 见新值）", async () => {
    const { app, file } = await appWithRules();
    const put = await app.inject({
      method: "PUT",
      url: "/v1/ingest/filter/rules/preference",
      payload: { content: "- 新偏好：技术内容全保留" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().preference).toBe("- 新偏好：技术内容全保留");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("- 新偏好：技术内容全保留");
    const get = await app.inject({ method: "GET", url: "/v1/ingest/filter/rules" });
    expect(get.json().preference).toBe("- 新偏好：技术内容全保留");
    await app.close();
  });

  it("PUT preference 非法内容 → 400 + 错误码", async () => {
    const { app } = await appWithRules();
    const empty = await app.inject({
      method: "PUT", url: "/v1/ingest/filter/rules/preference", payload: { content: "  " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("empty_preference");
    await app.close();
  });

  it("POST insight/refresh 走注入的刷新回调", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-refresh-"));
    temporaryDirectories.push(dir);
    const file = join(dir, "f.md");
    await writeFile(file, "x", "utf8");
    const store = new FilterRulesStore({ filePath: file, maxBytes: 2048 }, silentLogger);
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    let called = false;
    await app.register(ingestRoutes({} as IngestService, store, async () => {
      called = true;
    }));
    const response = await app.inject({ method: "POST", url: "/v1/ingest/filter/rules/insight/refresh" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ refreshed: true });
    expect(called).toBe(true);
    await app.close();
  });
});
