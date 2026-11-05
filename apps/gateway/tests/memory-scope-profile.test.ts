import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/modules/memory/service.js";
import { MemoryModelUnavailableError } from "../src/modules/memory/model-errors.js";
import { MemoryProfileAggregator, parseGroups } from "../src/modules/memory/profile.js";

let root: string;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-scope-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("工作空间作用域", () => {
  it("写入带 workspaceId 时落到 workspace:<id>", () => {
    service.remember({ content: "本空间约定：周报固定三段式", workspaceId: "ws-a", tags: ["决策"] });

    const own = service.list({ workspaceId: "ws-a" });
    expect(own).toHaveLength(1);
    // 别的空间看不到
    expect(service.list({ workspaceId: "ws-b" })).toHaveLength(0);
  });

  it("检索默认「本空间 + 全局」两层", () => {
    service.remember({ content: "空间级约定：甲", workspaceId: "ws-a", tags: ["决策"] });
    service.remember({ content: "全局偏好：乙", tags: ["偏好"] });

    const inSpace = service.recall({ query: "约定 全局偏好", workspaceId: "ws-a", limit: 10 });
    expect(inSpace.length).toBe(2);

    // 另一个空间只能看到全局那条
    const otherSpace = service.recall({ query: "约定 全局偏好", workspaceId: "ws-b", limit: 10 });
    expect(otherSpace).toHaveLength(1);
    expect(otherSpace[0]?.content).toContain("全局偏好");
  });

  it("不传 workspaceId 时不过滤作用域", () => {
    service.remember({ content: "空间级甲", workspaceId: "ws-a" });
    service.remember({ content: "全局乙" });

    expect(service.list()).toHaveLength(2);
  });
});

describe("长期事实与经验分层", () => {
  it("fact 写 semantic、lesson 写 episodic", () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"], category: "fact" });
    service.remember({ content: "导出乱码 → 先转 UTF-8", tags: ["经验"], category: "lesson" });

    expect(service.list({ category: "fact" }).map((hit) => hit.content)).toEqual(["用户偏好简体中文"]);
    expect(service.list({ category: "lesson" }).map((hit) => hit.content)).toEqual(["导出乱码 → 先转 UTF-8"]);
  });

  it("检索可按类别过滤", () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"], category: "fact" });
    service.remember({ content: "导出乱码 → 先转 UTF-8", tags: ["经验"], category: "lesson" });

    const lessons = service.recall({ query: "导出 乱码 简体中文", category: "lesson", limit: 10 });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.category).toBe("lesson");
    expect(lessons[0]?.layer).toBe("episodic");
  });
});

describe("画像聚合", () => {
  it("解析画像 JSON（容错围栏与超长条目）", () => {
    const raw = '```json\n[{"title":"偏好","items":["结论先行","' + "长".repeat(100) + '"]}]\n```';
    const groups = parseGroups(raw);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toEqual(["结论先行"]);
  });

  it("把偏好类事实聚合成画像，并覆盖上一版", async () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    service.remember({ content: "用户要求结论先行", tags: ["偏好"] });
    // 经验不进画像来源
    service.remember({ content: "导出乱码 → 转 UTF-8", tags: ["经验"], category: "lesson" });

    const generate = vi.fn(async () => '[{"title":"偏好","items":["正式文档用简体中文","结论先行"]}]');
    const aggregator = new MemoryProfileAggregator({ service, generate });

    const first = await aggregator.run({ reason: "manual" });
    expect(first).toMatchObject({ groups: 1, items: 2, skipped: null });

    const profile = aggregator.read();
    expect(profile).toHaveLength(1);
    expect([...(profile[0]?.items ?? [])].sort()).toEqual(["正式文档用简体中文", "结论先行"].sort());
    // 聚合输入不含 lesson
    const firstCall = generate.mock.calls.at(0) as [string] | undefined;
    expect(firstCall?.[0] ?? "").not.toContain("导出乱码");

    // 第二版覆盖：旧条目被清掉，不累加
    const generate2 = vi.fn(async () => '[{"title":"偏好","items":["只用简体中文"]}]');
    const aggregator2 = new MemoryProfileAggregator({ service, generate: generate2 });
    await aggregator2.run();
    expect(aggregator2.read()).toEqual([{ title: "偏好", items: ["只用简体中文"] }]);
    // 不该掺进 ASCII 检索键
    expect(service.list({ limit: 50 }).every((hit) => hit.tags.every((tag) => /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(tag)))).toBe(true);
  });

  it("没有来源事实时跳过且不调用模型", async () => {
    const generate = vi.fn(async () => "[]");
    const aggregator = new MemoryProfileAggregator({ service, generate });

    expect(await aggregator.run()).toMatchObject({ skipped: "no-source" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("档位未就绪时不推进阈值基准，就绪后写一条即重试", async () => {
    let slotReady = false;
    const generate = vi.fn(async () => {
      if (!slotReady) throw new MemoryModelUnavailableError();
      return '[{"title":"偏好","items":["简体中文"]}]';
    });
    const aggregator = new MemoryProfileAggregator({ service, generate, growthThreshold: 2 });

    service.remember({ content: "偏好甲", tags: ["偏好"] });
    service.remember({ content: "偏好乙", tags: ["偏好"] });

    const blocked = await aggregator.run({ reason: "growth" });
    expect(blocked.skipped).toBe("model-unavailable");
    expect(aggregator.read()).toEqual([]);

    slotReady = true;
    // 阈值基准没被推进：只多写 1 条就够触发（2 + 1 - 0 >= 2）
    service.setOnRemembered(() => aggregator.noteNewMemory());
    service.remember({ content: "偏好丙", tags: ["偏好"] });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(aggregator.read()).toEqual([{ title: "偏好", items: ["简体中文"] }]);
  });

  it("模型报错时降级不抛异常", async () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    const aggregator = new MemoryProfileAggregator({
      service,
      generate: async () => { throw new Error("boom") },
    });

    expect(await aggregator.run()).toMatchObject({ skipped: "model-error" });
  });

  it("新增偏好类事实达到阈值时自动触发", async () => {
    const generate = vi.fn(async () => '[{"title":"偏好","items":["简体中文"]}]');
    const aggregator = new MemoryProfileAggregator({ service, generate, growthThreshold: 2 });
    service.setOnRemembered(() => aggregator.noteNewMemory());

    service.remember({ content: "偏好甲", tags: ["偏好"] });
    service.remember({ content: "偏好乙", tags: ["偏好"] });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(generate).toHaveBeenCalledTimes(1);
  });
});
