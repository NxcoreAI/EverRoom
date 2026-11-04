import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemory, writeEntry } from "hippo-memory";
import { isSearchKey } from "../src/modules/memory/cjk.js";
import { HippoMemoryAdapter } from "../src/modules/memory/hippo-adapter.js";

let root: string;
let adapter: HippoMemoryAdapter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-hippo-test-"));
  adapter = new HippoMemoryAdapter({ root });
  adapter.open();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("HippoMemoryAdapter", () => {
  it("stores a Chinese memory and retrieves it by a Chinese query", () => {
    const id = adapter.remember({ content: "用户偏好使用简体中文撰写文档" });
    expect(id).toBeTruthy();

    const hits = adapter.recall({ query: "简体中文" });
    expect(hits.map((hit) => hit.id)).toContain(id);
    // 返回给调用方的是原句，而不是转写串
    expect(hits[0]?.content).toBe("用户偏好使用简体中文撰写文档");
  });

  it("retrieves Chinese memories by a shorter Chinese keyword", () => {
    adapter.remember({ content: "部署之前必须先跑数据库迁移" });

    expect(adapter.recall({ query: "数据库迁移" }).length).toBeGreaterThan(0);
    expect(adapter.recall({ query: "迁移" }).length).toBeGreaterThan(0);
  });

  it("keeps English retrieval working", () => {
    adapter.remember({ content: "use pnpm workspace for the monorepo" });
    adapter.remember({ content: "用户偏好使用简体中文撰写文档" });

    const hits = adapter.recall({ query: "pnpm workspace" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("pnpm");
  });

  it("retrieves mixed Chinese and English memories from either side", () => {
    adapter.remember({ content: "部署 deploy 之前先跑 migrate" });

    expect(adapter.recall({ query: "deploy" }).length).toBeGreaterThan(0);
    expect(adapter.recall({ query: "部署" }).length).toBeGreaterThan(0);
  });

  it("filters by scope", () => {
    adapter.remember({ content: "房间级偏好：回答要简洁", scope: "room:alpha" });
    adapter.remember({ content: "全局偏好：使用简体中文", scope: "global" });

    const alpha = adapter.recall({ query: "偏好", scope: "room:alpha" });
    expect(alpha.length).toBeGreaterThan(0);
    // 全局记忆不应出现在 room 作用域检索里
    expect(alpha.some((hit) => hit.content.includes("全局偏好"))).toBe(false);
  });

  it("never leaks internal search keys into visible tags", () => {
    const id = adapter.remember({ content: "用户偏好深色主题", tags: ["偏好"] });
    const hits = adapter.recall({ query: "主题" });
    const hit = hits.find((candidate) => candidate.id === id);

    expect(hit).toBeDefined();
    expect(hit?.tags).toContain("偏好");
    expect(hit?.tags.some(isSearchKey)).toBe(false);
  });

  it("persists outcome feedback", () => {
    const id = adapter.remember({ content: "不要在生产库上直接跑迁移" });
    if (!id) throw new Error("remember failed");

    expect(adapter.feedback(id, true)).toBe(true);

    const hit = adapter.list().find((entry) => entry.id === id);
    expect(hit?.retrievalCount).toBeGreaterThanOrEqual(0);
    expect(hit?.strength).toBeGreaterThan(0);
  });

  it("forgets a memory so it no longer surfaces", () => {
    const id = adapter.remember({ content: "临时记忆：本次发布冻结" });
    if (!id) throw new Error("remember failed");
    expect(adapter.recall({ query: "发布冻结" }).length).toBeGreaterThan(0);

    expect(adapter.forget(id)).toBe(true);
    expect(adapter.recall({ query: "发布冻结" })).toEqual([]);
  });

  it("degrades to empty results instead of throwing on bad input", () => {
    expect(adapter.remember({ content: "   " })).toBeNull();
    expect(adapter.recall({ query: "" })).toEqual([]);
    expect(adapter.feedback("mem_does_not_exist", true)).toBe(false);
  });

  it("reports stats with scope buckets", () => {
    adapter.remember({ content: "记忆甲", scope: "room:a" });
    adapter.remember({ content: "记忆乙", scope: "room:a" });
    adapter.remember({ content: "记忆丙" });

    const stats = adapter.stats();
    expect(stats.total).toBe(3);
    expect(stats.scopes["room:a"]).toBe(2);
    expect(stats.scopes["(global)"]).toBe(1);
  });

  it("marks retrieved entries so useful memories decay slower", () => {
    const id = adapter.remember({ content: "导出前先把中文文件名转成 UTF-8" });
    if (!id) throw new Error("remember failed");
    const before = adapter.list().find((entry) => entry.id === id);
    if (!before) throw new Error("entry missing");

    expect(adapter.markUsed([id])).toBe(1);
    const after = adapter.list().find((entry) => entry.id === id);

    expect(after?.retrievalCount).toBe(before.retrievalCount + 1);
    expect(after?.halfLifeDays ?? 0).toBeGreaterThan(before.halfLifeDays);
    // 不存在的 id 不报错，只是不计数
    expect(adapter.markUsed(["mem_missing"])).toBe(0);
    expect(adapter.markUsed([])).toBe(0);
  });

  it("keeps lessons identifiable after hippo merges them into semantic", () => {
    // lesson 写入自动带「经验」标签
    const lessonId = adapter.remember({ content: "导出乱码 → 先转 UTF-8", category: "lesson" });
    const lesson = adapter.list().find((entry) => entry.id === lessonId);
    expect(lesson?.tags).toContain("经验");
    expect(lesson?.layer).toBe("episodic");

    // 模拟 hippo 整理回合的产物：合并后的语义层条目，标签取 cluster 并集
    const merged = createMemory("多条导出经验合并：先转 UTF-8 再导出", { tags: ["经验"], layer: "semantic" });
    writeEntry(root, merged, { actor: "test" });

    // 标签优先：合并后仍算经验，不会被当成事实
    const asLesson = adapter.list({ category: "lesson" }).map((hit) => hit.id);
    expect(asLesson).toContain(merged.id);
    expect(adapter.list({ category: "fact" }).map((hit) => hit.id)).not.toContain(merged.id);
    expect(adapter.categoryDrift().lessonTaggedNotEpisodic).toBe(1);
  });

  it("treats an existing 经验 tag as a lesson even without an explicit category", () => {
    const id = adapter.remember({ content: "部署前先跑迁移 → 否则新表缺失", tags: ["经验"] });
    const hit = adapter.list().find((entry) => entry.id === id);

    expect(hit?.category).toBe("lesson");
    expect(hit?.layer).toBe("episodic");
  });

  it("clamps the recall limit", () => {
    for (let index = 0; index < 8; index += 1) {
      adapter.remember({ content: `偏好条目 ${index} 关于文档格式` });
    }

    expect(adapter.recall({ query: "偏好 文档格式", limit: 3 }).length).toBeLessThanOrEqual(3);
  });
});
