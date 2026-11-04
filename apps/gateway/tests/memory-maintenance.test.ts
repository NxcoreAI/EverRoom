import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/modules/memory/service.js";

let root: string;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-maint-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("记忆整理回合（hippo sleep）", () => {
  it("整理后经验条目仍然按经验归类（合并成 semantic 也不改类别）", async () => {
    service.remember({ content: "导出中文文件名乱码 → 先转 UTF-8 再导出", category: "lesson" });
    service.remember({ content: "中文文件名导出乱码 → 转 UTF-8 后再导出文件", category: "lesson" });
    service.remember({ content: "用户偏好简体中文撰写正式文档", tags: ["偏好"], category: "fact" });

    const result = await service.maintain();
    expect(result).not.toBeNull();

    const lessons = service.list({ category: "lesson" }).map((hit) => hit.content);
    const facts = service.list({ category: "fact" }).map((hit) => hit.content);
    // 两条经验（或被合并后的那条）仍属于经验，事实不受影响
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.every((content) => content.includes("UTF-8"))).toBe(true);
    expect(facts).toEqual(["用户偏好简体中文撰写正式文档"]);
  });

  it("启动时固化 extraction.enabled=false，避免整理时把记忆正文发到 Anthropic", () => {
    const path = join(root, "config.json");
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf8")) as { extraction?: { enabled?: boolean } };
    expect(config.extraction?.enabled).toBe(false);
  });

  it("保留 config.json 里用户自己写的其它键", () => {
    const second = new MemoryService({ root: join(root, "kept"), enabled: true });
    // 先手写一份带自定义键的配置，再启动服务。
    const path = join(root, "kept", "config.json");
    mkdirSync(join(root, "kept"), { recursive: true });
    writeFileSync(path, JSON.stringify({ dormant: { enabled: false } }), "utf8");

    second.start();
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      dormant?: { enabled?: boolean };
      extraction?: { enabled?: boolean };
    };
    expect(config.dormant?.enabled).toBe(false);
    expect(config.extraction?.enabled).toBe(false);
    second.stop();
  });

  it("整理空库不报错，返回统计", async () => {
    const result = await service.maintain();
    expect(result).not.toBeNull();
    expect(result?.dryRun).toBe(false);
    expect(result?.active).toBe(0);
  });

  it("整理后记忆仍在（dryRun 不落库，真跑也不丢）", async () => {
    service.remember({ content: "用户偏好用简体中文撰写文档", tags: ["偏好"] });

    const dry = await service.maintain({ dryRun: true });
    expect(dry?.dryRun).toBe(true);
    expect(service.list()).toHaveLength(1);

    await service.maintain();
    expect(service.list()).toHaveLength(1);
  });

  it("整理全程零出站网络", async () => {
    service.remember({ content: "部署前必须先跑数据库迁移", tags: ["经验"] });
    const fetchSpy = vi.fn(() => { throw new Error("outbound network is not allowed") });
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await service.maintain();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("记忆关闭时整理直接返回 null", async () => {
    const disabled = new MemoryService({ root: join(root, "off"), enabled: false });
    disabled.start();
    expect(await disabled.maintain()).toBeNull();
    disabled.stop();
  });

  it("stop 后不再整理", async () => {
    service.stop();
    expect(await service.maintain()).toBeNull();
  });
});
