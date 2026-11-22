import { describe, expect, it } from "vitest";
import {
  BP_ADDONS,
  BP_MODULES,
  BP_NARRATIVE_ORDERS,
  BP_STAGE_TUNINGS,
  BP_TRACKS,
  BP_X01_MODULES,
  type BpModuleId,
} from "../src/modules/bp-template/data.js";
import {
  BP_NARRATIVE_ORDER_COUNT,
  buildPlannerInjection,
  getBpTrack,
  missingModuleCoverage,
  BpSelectionError,
} from "../src/modules/bp-template/selection.js";

const ALL_MODULE_IDS = Array.from({ length: 13 }, (_, i) => `M${String(i + 1).padStart(2, "0")}` as BpModuleId);
const ALL_TRACK_IDS = Array.from({ length: 18 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);

describe("bp-template data completeness (standard v1.0)", () => {
  it("modules cover M01-M13 exactly once with all four fields", () => {
    expect(BP_MODULES.map((m) => m.id)).toEqual(ALL_MODULE_IDS);
    for (const m of BP_MODULES) {
      expect(m.title.trim().length).toBeGreaterThan(0);
      expect(m.question.trim().length).toBeGreaterThan(0);
      expect(m.content.trim().length).toBeGreaterThan(0);
      expect(m.evidence.trim().length).toBeGreaterThan(0);
      expect(m.pitfalls.trim().length).toBeGreaterThan(0);
    }
  });

  it("tracks cover T01-T18 exactly once", () => {
    expect(BP_TRACKS.map((t) => t.id)).toEqual(ALL_TRACK_IDS);
  });

  it("every track moduleOrder is a permutation of all 13 modules", () => {
    for (const t of BP_TRACKS) {
      expect([...t.moduleOrder].sort(), `order of ${t.id}`).toEqual(ALL_MODULE_IDS);
      expect(new Set(t.moduleOrder).size, `no dup in ${t.id}`).toBe(13);
    }
  });

  it("every track has core question, metrics, anti-patterns and intro", () => {
    for (const t of BP_TRACKS) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.coreQuestion.trim().length).toBeGreaterThan(0);
      expect(t.metrics.trim().length).toBeGreaterThan(0);
      expect(t.antiPatterns.length).toBeGreaterThan(0);
      expect(t.intro.trim().length).toBeGreaterThan(0);
    }
  });

  it("track overrides reference valid module ids only", () => {
    const valid = new Set<string>(ALL_MODULE_IDS);
    for (const t of BP_TRACKS) {
      for (const key of Object.keys(t.overrides)) {
        expect(valid.has(key), `override ${key} of ${t.id}`).toBe(true);
      }
    }
  });

  it("narrative orders are the canonical four; stage tunings have 3 stages; addons non-empty", () => {
    expect(BP_NARRATIVE_ORDERS.length).toBe(4);
    expect(BP_NARRATIVE_ORDER_COUNT).toBe(4);
    expect(BP_STAGE_TUNINGS.length).toBeGreaterThanOrEqual(7);
    for (const s of BP_STAGE_TUNINGS) {
      expect(s.early.trim().length).toBeGreaterThan(0);
      expect(s.growth.trim().length).toBeGreaterThan(0);
      expect(s.mature.trim().length).toBeGreaterThan(0);
    }
    expect(BP_ADDONS.length).toBe(4);
    for (const a of BP_ADDONS) expect(a.requirements.trim().length).toBeGreaterThan(0);
    expect(BP_X01_MODULES.length).toBe(6);
  });
});

describe("buildPlannerInjection", () => {
  const baseSelection = {
    trackId: "T01" as const,
    stage: "growth" as const,
    keyJudgement: "客户会持续付费，交付和销售能复制",
    addonIds: ["AI与数据能力"],
    includeX01: false,
  };

  it("renders outline of 13 module titles in track order", () => {
    const inj = buildPlannerInjection(baseSelection);
    expect(inj.outline).toHaveLength(13);
    expect(inj.outline[0]).toBe("定位与融资摘要");
    const track = getBpTrack("T01");
    expect(inj.outline).toEqual(track.moduleOrder.map((id) => BP_MODULES.find((m) => m.id === id)!.title));
  });

  it("referenceOutline starts with core question then module questions", () => {
    const inj = buildPlannerInjection(baseSelection);
    expect(inj.referenceOutline).toHaveLength(14);
    expect(inj.referenceOutline[0]).toContain("客户是否持续付费");
  });

  it("instruction contains track stamp, key judgement, metrics and anti-patterns within budget", () => {
    const inj = buildPlannerInjection(baseSelection);
    expect(inj.instruction).toContain("【BP 模板】T01 企业软件与行业数字化");
    expect(inj.instruction).toContain("客户会持续付费，交付和销售能复制");
    expect(inj.instruction).toContain("【优先指标】");
    expect(inj.instruction).toContain("【常见错误（禁止出现）】");
    expect(inj.instruction).toContain("【发展阶段调整（growth");
    expect(inj.instruction).toContain("【专项叠加：AI与数据能力】");
    expect(inj.instruction).toContain("【硬约束】");
    expect(inj.instruction.length).toBeLessThanOrEqual(12000);
  });

  it("narrative order reorder puts product/validation right after positioning", () => {
    const inj = buildPlannerInjection({ ...baseSelection, narrativeOrderIndex: 1 });
    expect(inj.outline[0]).toBe("定位与融资摘要");
    expect(inj.outline.slice(1, 3)).toEqual(["产品与解决方案", "验证与经营进展"]);
  });

  it("X01 addon appends asset modules section", () => {
    const inj = buildPlannerInjection({ ...baseSelection, includeX01: true, addonIds: [] });
    expect(inj.instruction).toContain("【X01 资产运营扩展（叠加）】");
    expect(inj.instruction).toContain("资产与权利");
  });

  it("rejects invalid selections", () => {
    expect(() => buildPlannerInjection({ ...baseSelection, trackId: "T99" as never })).toThrow(BpSelectionError);
    expect(() => buildPlannerInjection({ ...baseSelection, keyJudgement: " " })).toThrow(BpSelectionError);
    expect(() => buildPlannerInjection({ ...baseSelection, narrativeOrderIndex: 9 })).toThrow(BpSelectionError);
    expect(() => buildPlannerInjection({ ...baseSelection, addonIds: ["不存在"] })).toThrow(BpSelectionError);
  });

  it("every track/stage renders within instruction budget (exhaustive)", () => {
    for (const trackId of ALL_TRACK_IDS) {
      for (const stage of ["early", "growth", "mature"] as const) {
        const inj = buildPlannerInjection({
          trackId: trackId as never,
          stage,
          keyJudgement: "测试判断",
          addonIds: [],
          includeX01: true,
        });
        expect(inj.instruction.length, `${trackId}/${stage}`).toBeLessThanOrEqual(12000);
        expect(inj.outline).toHaveLength(13);
      }
    }
  });
});

describe("missingModuleCoverage", () => {
  it("returns empty when all module titles present", () => {
    const titles = BP_MODULES.map((m) => m.title);
    expect(missingModuleCoverage(titles, "T01")).toEqual([]);
  });

  it("detects missing modules", () => {
    const titles = BP_MODULES.slice(0, 6).map((m) => m.title);
    const missing = missingModuleCoverage(titles, "T01");
    expect(missing.length).toBe(7);
    expect(missing[0]).toContain("M07");
  });

  it("matches with page-number suffixes or spacing", () => {
    const titles = BP_MODULES.map((m, i) => `${i + 1}. ${m.title}`);
    expect(missingModuleCoverage(titles, "T14")).toEqual([]);
  });
});
