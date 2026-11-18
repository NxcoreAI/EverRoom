import { describe, expect, it } from "vitest";
import { createBpTemplatePiTool } from "../src/modules/bp-template/tool.js";

const tool = createBpTemplatePiTool();

function call(params: Record<string, unknown>) {
  return tool.execute({ runId: "test", sessionId: "test" } as never, params, undefined) as Promise<{ content: string }>;
}

function parse(result: { content: string }) {
  return JSON.parse(result.content) as { ok: boolean; brief?: string; error?: string; moduleCount?: number };
}

describe("bp_template_get tool", () => {
  it("renders a full track brief with 13 modules for T01", async () => {
    const r = parse(await call({ trackId: "T01", stage: "growth" }));
    expect(r.ok).toBe(true);
    expect(r.moduleCount).toBe(13);
    expect(r.brief).toContain("【赛道】T01 企业软件与行业数字化");
    expect(r.brief).toContain("【核心判断】");
    expect(r.brief).toContain("【优先指标】");
    expect(r.brief).toContain("【常见错误】");
    expect(r.brief).toContain("【阶段口径（growth）】");
    expect(r.brief).toContain("【模块骨架");
    expect(r.brief).toContain("1. 定位与融资摘要（M01）");
    expect(r.brief).toContain("13. 风险与应对（M13）");
    // T01 专项：M02 覆盖 required 内容
    expect(r.brief).toContain("写清使用者、采购者、预算归属");
    expect(r.brief).toContain("【硬约束】");
  });

  it("narrative order reorders the skeleton", async () => {
    const r = parse(await call({ trackId: "T01", stage: "growth", narrativeOrderIndex: 1 }));
    expect(r.ok).toBe(true);
    expect(r.brief).toContain("【讲述顺序】产品与数据已验证");
    // 定位后紧跟产品与验证
    const idx1 = r.brief!.indexOf("1. 定位与融资摘要");
    const idx2 = r.brief!.indexOf("2. 产品与解决方案");
    const idx3 = r.brief!.indexOf("3. 验证与经营进展");
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it("includeX01 and addons append sections", async () => {
    const r = parse(await call({ trackId: "T12", stage: "mature", includeX01: true, addonIds: ["跨境与全球化"] }));
    expect(r.ok).toBe(true);
    expect(r.brief).toContain("【X01 资产运营扩展（叠加）】");
    expect(r.brief).toContain("资产与权利");
    expect(r.brief).toContain("【专项叠加：跨境与全球化】");
  });

  it("rejects unknown track / stage / narrative / addon", async () => {
    expect(parse(await call({ trackId: "T99", stage: "growth" })).ok).toBe(false);
    expect(parse(await call({ trackId: "T01", stage: "later" })).ok).toBe(false);
    expect(parse(await call({ trackId: "T01", stage: "growth", narrativeOrderIndex: 7 })).ok).toBe(false);
    expect(parse(await call({ trackId: "T01", stage: "growth", addonIds: ["不存在"] })).ok).toBe(false);
  });

  it("every track renders for every stage within a reasonable size", async () => {
    for (let i = 1; i <= 18; i++) {
      const trackId = `T${String(i).padStart(2, "0")}`;
      for (const stage of ["early", "growth", "mature"] as const) {
        const r = parse(await call({ trackId, stage }));
        expect(r.ok, `${trackId}/${stage}`).toBe(true);
        expect(r.brief!.length, `${trackId}/${stage}`).toBeLessThan(12000);
        expect(r.brief!.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(13);
      }
    }
  });
});
