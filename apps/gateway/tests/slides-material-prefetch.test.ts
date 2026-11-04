import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";

import type { MaterialHit } from "../src/modules/subagents/slides-material-prefetch.js";
import type { SlidesProgressPage } from "../src/modules/subagents/slides-draft-doc.js";
import {
  materialSearchTerms,
  prefetchSlidesMaterials,
} from "../src/modules/subagents/slides-material-prefetch.js";

function hit(ref: string, rank = 4, desc = "素材描述"): MaterialHit {
  return { ref, kind: "photo", desc, meta: "照片 1920×1080", rank };
}

const LONG_HINT = "三张等宽横排实景摄影——雪山背景下两人驾驶雪地摩托、骑士驾驶哈雷摩托在公路上、草地泥地上的 Polaris 红色越野车。";

describe("materialSearchTerms（确定性取词）", () => {
  it("从长配图描述提取画面词，滤掉数量词/虚词/泛化词", () => {
    const terms = materialSearchTerms([LONG_HINT]);
    expect(terms).toContain("摩托");
    expect(terms).toContain("雪山");
    expect(terms).toContain("哈雷");
    expect(terms).toContain("polaris");
    expect(terms).toContain("草地");
    expect(terms).not.toContain("三张");
    expect(terms).not.toContain("两人");
    expect(terms).not.toContain("摄影");
    // 每页最多拆 4 个 query，每个 query 6 词。
    expect(terms.length).toBeLessThanOrEqual(24);
    // 段间轮转：前 6 词应覆盖多个画面，而不是堆在第一个分句里。
    expect(terms.slice(0, 6).some((term) => term === "雪山" || term === "驾驶")).toBe(true);
    expect(terms.slice(0, 6)).toContain("polaris");
  });

  it("短配图意图提取蓝色/海浪，不受「照片」这类泛化词干扰", () => {
    const terms = materialSearchTerms(["蓝色调海浪照片竖带，占页面左侧约四分之一"]);
    expect(terms).toContain("海浪");
    expect(terms).toContain("蓝色");
    expect(terms).not.toContain("照片");
  });
});

describe("prefetchSlidesMaterials（按页预取）", () => {
  it("配图意图优先；无命中的页不进输入；命中按页去重限长", () => {
    const pages: SlidesProgressPage[] = [
      { title: "封面", points: ["季度汇报"], materialHints: "雪山背景下两人驾驶雪地摩托" },
      { title: "团队", points: ["湖边合影", "室内调试"] },
      { title: "财务", data: "Q1: 1.2 亿" },
    ];
    const search = vi.fn((query: string, limit?: number) => {
      if (query.includes("雪山") || query.includes("摩托")) {
        return [hit("everroom-material://snow", 6, "雪山 雪地摩托"), hit("everroom-material://snow", 6, "同图重复")];
      }
      if (query.includes("湖边") || query.includes("合影") || query.includes("团队")) {
        return [hit("everroom-material://lake", 3)];
      }
      return [];
    });

    const result = prefetchSlidesMaterials({ pages, search });

    expect(result.map((page) => page.pageIndex)).toEqual([0, 1]);
    expect(result[0]).toMatchObject({
      pageIndex: 0,
      hits: [{ ref: "everroom-material://snow", kind: "photo", desc: "雪山 雪地摩托", meta: "照片 1920×1080" }],
    });
    expect(result[0]!.query).toContain("雪山");
    expect(result[1]).toMatchObject({ pageIndex: 1, hits: [{ ref: "everroom-material://lake" }] });
    // 财务页只有 data，没有配图意图/标题要点可检索 → 不进输入，由 planner 写 imagePrompt。
    expect(result.some((page) => page.pageIndex === 2)).toBe(false);
    expect(search).toHaveBeenCalledWith(expect.any(String), 3);
  });

  it("检索抛错按零命中处理，不拖垮 arrange", () => {
    const search = vi.fn(() => {
      throw new Error("materials_db_unavailable");
    });
    expect(prefetchSlidesMaterials({
      pages: [{ title: "封面", materialHints: "城市夜景" }],
      search,
    })).toEqual([]);
  });

  it("单页命中数量受 limitPerPage 约束，超出部分丢弃", () => {
    const search = vi.fn(() => [
      hit("everroom-material://a", 9),
      hit("everroom-material://b", 8),
      hit("everroom-material://c", 7),
      hit("everroom-material://d", 6),
    ]);
    const result = prefetchSlidesMaterials({
      pages: [{ title: "封面", materialHints: "城市夜景" }],
      search,
      limitPerPage: 2,
    });
    expect(result[0]!.hits.map((item) => item.ref)).toEqual([
      "everroom-material://a",
      "everroom-material://b",
    ]);
  });

  it("长描述截断：desc 最长 120、meta 最长 48，超长不留原文", () => {
    const search = vi.fn(() => [{
      ...hit("everroom-material://long", 2, "描".repeat(400)),
      meta: "m".repeat(80),
    }]);
    const result = prefetchSlidesMaterials({
      pages: [{ title: "封面", materialHints: "城市夜景" }],
      search,
    });
    expect([...result[0]!.hits[0]!.desc]).toHaveLength(120);
    expect([...result[0]!.hits[0]!.meta]).toHaveLength(48);
  });

  it("预取结果满足 planner arrange 输入契约（input.schema.json 可直接校验）", () => {
    const schemaPath = resolve("../../agents/slides-planner/schemas/input.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    const materialHits = prefetchSlidesMaterials({
      pages: [{ title: "封面", materialHints: "城市夜景" }],
      search: vi.fn(() => [hit("everroom-material://night")]),
    });
    expect(validate({
      phase: "arrange",
      instruction: "做一份 3 页汇报",
      roomId: "room-1",
      contentMode: "semantic-v3",
      draftPages: [{ title: "封面" }],
      sources: [{ id: "src-1", pageId: "page-1", kind: "title", value: "封面", mustShow: true }],
      materialHits,
    })).toBe(true);
  });
});
