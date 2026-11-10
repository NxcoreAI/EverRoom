import { describe, expect, it } from "vitest";
import {
  isSearchKey,
  needsSegmentation,
  searchKeys,
  segment,
  toHippoQuery,
} from "../src/modules/memory/cjk.js";

describe("memory/cjk", () => {
  it("segments Chinese into words, dropping single characters", () => {
    const tokens = segment("用户偏好用简体中文撰写文档");

    expect(tokens).toContain("用户");
    expect(tokens).toContain("偏好");
    expect(tokens).toContain("简体中文");
    // 单字（如「用」）按 hippo 自身规则丢弃
    expect(tokens.every((token) => token.length > 1)).toBe(true);
  });

  it("transliterates Chinese tokens into \\w-matching search keys", () => {
    const keys = searchKeys("用户偏好");

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      // 关键性质：转写后的键全部由 \w 字符组成，否则 hippo 的 tokenize 会丢掉它们
      expect(key).toMatch(/^\w+$/);
      expect(isSearchKey(key)).toBe(true);
    }
  });

  it("keeps ASCII words as-is so English retrieval does not regress", () => {
    const keys = searchKeys("deploy pnpm workspace");

    expect(keys).toContain("deploy");
    expect(keys).toContain("pnpm");
    expect(keys).toContain("workspace");
    expect(keys.every((key) => !isSearchKey(key))).toBe(true);
  });

  it("handles mixed Chinese and English without dropping either side", () => {
    const keys = searchKeys("部署 deploy 用 k8s");

    expect(keys).toContain("deploy");
    expect(keys).toContain("k8s");
    expect(keys.some(isSearchKey)).toBe(true);
  });

  it("produces a stable, non-empty hippo query for Chinese input", () => {
    const query = toHippoQuery("数据库迁移");

    expect(query.length).toBeGreaterThan(0);
    expect(query).toBe(toHippoQuery("数据库迁移"));
  });

  it("deduplicates repeated tokens", () => {
    const keys = searchKeys("偏好 偏好 偏好");

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("detects non-ASCII text to skip segmentation for pure English", () => {
    expect(needsSegmentation("deploy pnpm")).toBe(false);
    expect(needsSegmentation("部署 pnpm")).toBe(true);
  });

  it("returns no keys for whitespace-only input", () => {
    expect(searchKeys("   ")).toEqual([]);
    expect(toHippoQuery("   ")).toBe("");
  });
});
