/**
 * 组件审美收敛（通用融资 BP 规格）验收：
 * 1. 装饰收敛——数据/内容组件不再画默认短强调线与纯装饰索引；
 * 2. 视觉强调对应主次——featured 只用浅强调底 + 一条强调边，徽章不自动生成；
 * 3. 文字尺度统一——同级文字不随组件框高度缩放，正文不低于 16pt；
 * 4. 无整体缩字兜底——装不下直接走布局错误通道。
 */

import { describe, expect, it } from "vitest";
import type { Frame } from "../../grid.js";
import { resolveTheme } from "../../theme.js";
import { expandComponent, normalizeComponentLeaf } from "./index.js";
import type { SpecElement } from "../../elements.js";

const WIDE: Frame = { x: 64, y: 64, w: 1152, h: 560 };
const HALF: Frame = { x: 64, y: 64, w: 560, h: 280 };
const NARROW: Frame = { x: 64, y: 64, w: 260, h: 200 };

function expand(node: Record<string, unknown>, frame: Frame = WIDE, styleParams: Record<string, unknown> = {}): SpecElement[] {
  const leaf = normalizeComponentLeaf({ type: "component", ...node }, "root");
  return expandComponent(leaf, frame, resolveTheme(styleParams as never), "root");
}

function shapes(els: SpecElement[]): Extract<SpecElement, { type: "shape" }>[] {
  return els.filter((el): el is Extract<SpecElement, { type: "shape" }> => el.type === "shape");
}

function texts(els: SpecElement[]): Extract<SpecElement, { type: "text" }>[] {
  return els.filter((el): el is Extract<SpecElement, { type: "text" }> => el.type === "text");
}

function runsOf(els: SpecElement[]): { text: string; sizePt?: number }[] {
  return texts(els).flatMap((el) => el.paragraphs).flatMap((p) => p.runs);
}

/** 默认强调色短规则（窄横条 h≤4、强调色填充）。 */
function accentRules(els: SpecElement[], emphasis: string): Extract<SpecElement, { type: "shape" }>[] {
  return shapes(els).filter((el) => typeof el.fill === "string" && el.fill.toLowerCase() === emphasis.toLowerCase() && el.h <= 4 && el.w >= 20);
}

describe("装饰收敛：数据组件", () => {
  it("stats 默认不画短强调线，保留列间分组发丝线", () => {
    const t = resolveTheme();
    const els = expand({ name: "stats", items: [{ value: "2.83", unit: "万亿元", label: "GDP" }, { value: "3.87", unit: "万亿元", label: "预估" }] });
    expect(accentRules(els, t.design.accent === "primary" ? t.colors.primary : t.colors.accent)).toHaveLength(0);
    // 列间分组线仍在（separator:line 缺省）。
    expect(shapes(els).filter((el) => el.w === 1).length).toBe(1);
  });

  it("stats 数字 56–80pt 按长度适配，且不随框高缩放", () => {
    const items = [{ value: "3.87", label: "A" }, { value: "2.83", label: "B" }];
    const tall = expand({ name: "stats", items }, WIDE);
    const short = expand({ name: "stats", items }, HALF);
    const sizeAt = (els: SpecElement[]) => runsOf(els).find((r) => r.text === "3.87")?.sizePt;
    expect(sizeAt(tall)).toBe(sizeAt(short));
    expect(sizeAt(tall)).toBeGreaterThanOrEqual(56);
    expect(sizeAt(tall)).toBeLessThanOrEqual(80);
  });
});

describe("装饰收敛：内容组件", () => {
  it("featureCards 不画短规则与压底序号，用户图标照常显示", () => {
    const els = expand({ name: "featureCards", items: [
      { title: "直连工厂", body: "去掉中间商", icon: "check-circle" },
      { title: "柔性供应", body: "小单快反" },
    ] });
    const t = resolveTheme();
    expect(accentRules(els, t.colors.accent)).toHaveLength(0);
    const allRuns = runsOf(els).map((r) => r.text);
    expect(allRuns).not.toContain("01");
    expect(allRuns).not.toContain("02");
    expect(els.some((el) => el.type === "icon")).toBe(true);
  });

  it("bentoGrid 默认各项平级：首格不反白、无索引、无短规则", () => {
    const els = expand({ name: "bentoGrid", items: [
      { title: "品类聚焦", body: "只做冷萃" },
      { title: "渠道直连", body: "去掉中间商" },
      { title: "复购运营", body: "私域沉淀" },
    ] }, WIDE, { composition: "editorial", decoration: { cardStroke: "#112233" } });
    const t = resolveTheme();
    // 无 ink 反白卡。
    expect(shapes(els).some((el) => el.fill === t.colors.text)).toBe(false);
    const allRuns = runsOf(els).map((r) => r.text);
    expect(allRuns).not.toContain("01");
    expect(accentRules(els, t.colors.accent)).toHaveLength(0);
  });

  it("pointList 编号列表保留编号", () => {
    const els = expand({ name: "pointList", numbered: true, items: [
      { label: "品类聚焦", body: "只做冷萃" },
      { label: "渠道直连", body: "去掉中间商" },
    ] });
    const allRuns = runsOf(els).map((r) => r.text);
    expect(allRuns).toContain("01");
    expect(allRuns).toContain("02");
  });
});

describe("装饰收敛：关系组件", () => {
  it("steps 保留顺序轨道，取消幽灵大序号与逐列短规则", () => {
    const els = expand({ name: "steps", items: [
      { title: "选品", text: "锁定品类" },
      { title: "定标", text: "双标准" },
      { title: "上架", text: "先电商" },
    ] });
    const t = resolveTheme();
    // 连接轨道（横线 + 落点圆点）仍在。
    expect(shapes(els).some((el) => el.h === 2)).toBe(true);
    expect(shapes(els).some((el) => el.shape === "ellipse")).toBe(true);
    // STEP 微标签（语义序号）保留。
    expect(runsOf(els).map((r) => r.text)).toContain("STEP 01");
    // 无幽灵大序号：不存在 >40pt 的装饰数字 run。
    expect(runsOf(els).some((r) => /^\d{2}$/.test(r.text) && (r.sizePt ?? 0) > 40)).toBe(false);
    // 无逐列刻标短规则（4px 高的强调色块）；2px 轨道是顺序结构件，保留。
    expect(shapes(els).filter((el) => el.fill === t.colors.accent && el.h === 4)).toHaveLength(0);
  });

  it("timeline 保留轴线与节点", () => {
    const els = expand({ name: "timeline", items: [
      { label: "2026", text: "品类验证" },
      { label: "2027", text: "渠道扩张" },
      { label: "2028", text: "品牌溢价" },
    ] });
    const axis = shapes(els).filter((el) => el.h === 2);
    const nodes = shapes(els).filter((el) => el.shape === "ellipse");
    expect(axis.length).toBeGreaterThanOrEqual(1);
    expect(nodes.length).toBe(3);
  });
});

describe("装饰收敛：引语/团队/人物", () => {
  it("quote/quotes/teamGrid/persona 不再画强调短规则", () => {
    const t = resolveTheme();
    const quote = expand({ name: "quote", text: "先把品类做扎实，再谈扩张。", author: "创始人" });
    const quotes = expand({ name: "quotes", items: [
      { text: "履约稳定，补货快。", name: "王经理", role: "采购总监" },
      { text: "毛利结构健康。", name: "李投资人", role: "合伙人" },
    ] });
    const team = expand({ name: "teamGrid", members: [
      { name: "张一", role: "CEO", bio: "前品类负责人" },
      { name: "李二", role: "CTO", bio: "供应链系统" },
      { name: "王三", role: "COO" },
    ] });
    const persona = expand({ name: "persona", person: { name: "张一", role: "CEO" }, points: ["十年品类经验", "连续创业者"] });
    for (const els of [quote, quotes, team, persona]) {
      expect(accentRules(els, t.colors.accent)).toHaveLength(0);
    }
  });

  it("quotes 无图时用首字头像，不叠加徽章；teamGrid 无索引序号", () => {
    const quotes = expand({ name: "quotes", items: [
      { text: "履约稳定。", name: "王经理" },
      { text: "补货很快。", name: "李店长" },
    ] });
    const initials = runsOf(quotes).map((r) => r.text);
    expect(initials).toContain("王");
    const team = expand({ name: "teamGrid", members: [{ name: "张一", role: "CEO" }, { name: "李二", role: "CTO" }] });
    const teamRuns = runsOf(team).map((r) => r.text);
    expect(teamRuns).not.toContain("01");
    expect(teamRuns).not.toContain("02");
  });

  it("teamGrid 头像尺寸全组统一（姓名基线对齐）", () => {
    const els = expand({ name: "teamGrid", members: [
      { name: "张一", role: "CEO", bio: "前品类负责人，负责整体战略与融资节奏" },
      { name: "李二", role: "CTO" },
      { name: "王三", role: "COO" },
      { name: "赵四", role: "CMO", bio: "增长" },
    ] });
    const avatars = shapes(els).filter((el) => el.shape === "ellipse" && el.w === el.h && el.w >= 56);
    const widths = new Set(avatars.map((el) => el.w));
    expect(widths.size).toBe(1);
  });
});

describe("视觉强调对应主次", () => {
  it("comparison featured = 浅强调底 + 一条强调边；无顶条、不自动生成推荐徽章", () => {
    const els = expand({ name: "comparison", sides: [
      { title: "传统经销", points: ["层层加价", "库存压力大"] },
      { title: "直连模式", points: ["出厂价直供", "以销定产"] },
    ], featured: 1 });
    const t = resolveTheme();
    const cards = shapes(els).filter((el) => el.shape === "roundRect" && el.h > 100);
    const featured = cards.find((el) => el.stroke);
    expect(featured).toBeDefined();
    expect(featured!.stroke!.color).toBe(t.colors.accent);
    expect(featured!.fill).not.toBe(t.colors.text);
    // 无自动「推荐」徽章、无 4px 顶条。
    expect(runsOf(els).map((r) => r.text)).not.toContain("推荐");
    expect(shapes(els).filter((el) => el.h === 4)).toHaveLength(0);
  });

  it("comparison featured 带标签时徽章显示标签文本", () => {
    const els = expand({ name: "comparison", sides: [
      { title: "传统经销", points: ["层层加价", "库存压力"] },
      { title: "直连模式", tag: "建议", points: ["出厂价直供", "以销定产"] },
    ], featured: 1 });
    const badge = shapes(els).find((el) => Array.isArray(el.paragraphs));
    expect(badge?.paragraphs?.[0]?.runs[0]?.text).toBe("建议");
  });

  it("comparison 标题起点与首条要点跨列统一", () => {
    const els = expand({ name: "comparison", sides: [
      { title: "传统经销", points: ["层层加价", "库存压力"] },
      { title: "直连电商直连模式", points: ["出厂价直供", "以销定产"] },
    ] });
    const titles = texts(els).filter((el) => ["传统经销", "直连电商直连模式"].includes(el.paragraphs[0]!.runs[0]!.text!));
    expect(titles).toHaveLength(2);
    expect(titles[0]!.y).toBe(titles[1]!.y);
    expect(titles[0]!.h).toBe(titles[1]!.h);
  });

  it("pricingTiers featured = 浅强调底 + 强调边（不反白、无顶条、无阴影）", () => {
    const els = expand({ name: "pricingTiers", tiers: [
      { name: "团队版", price: "¥198", features: ["50 人以内", "社区支持"] },
      { name: "企业版", price: "¥398", features: ["人数不限", "私有部署"] },
    ], featured: 1 }, WIDE, { decoration: { cardShadow: "soft" } });
    const t = resolveTheme();
    const cards = shapes(els).filter((el) => el.shape === "roundRect" && el.h > 100);
    const featured = cards.find((el) => el.stroke?.color === t.colors.accent);
    expect(featured).toBeDefined();
    expect(featured!.fill).not.toBe(t.colors.text);
    expect(featured!.shadow).toBeUndefined();
    expect(shapes(els).filter((el) => el.h === 4)).toHaveLength(0);
  });
});

describe("统一阅读尺度", () => {
  it("同级正文/标签不随组件框高度变化", () => {
    const node = { name: "pointList", items: [{ label: "品类聚焦", body: "只做冷萃，先做规模再做出海品牌溢价。" }, { label: "渠道直连", body: "去掉中间商，以销定产。" }] };
    const bodyAt = (frame: Frame) => runsOf(expand(node, frame)).find((r) => r.text.startsWith("只做冷萃"))?.sizePt;
    expect(bodyAt(WIDE)).toBe(bodyAt(HALF));
    expect(bodyAt(WIDE)).toBe(18);
  });

  it("中文长标题与英文长词：换行可排，不裁切不报错", () => {
    const els = expand({ name: "featureCards", items: [
      { title: "供应链直连与柔性快反体系", body: "English long words like internationalization and straight-through processing wrap without clipping." },
      { title: "数据驱动选品", body: "动销数据驱动月度换款。" },
    ] }, WIDE);
    const all = runsOf(els);
    expect(all.some((r) => r.text.includes("internationalization"))).toBe(true);
    expect(all.some((r) => r.text === "供应链直连与柔性快反体系")).toBe(true);
  });

  it("不同长度数字与单位：短数字放大、长数字适配到 56pt 下限", () => {
    const els = expand({ name: "stats", items: [
      { value: "3", unit: "亿", label: "A" },
      { value: "1286.5", unit: "%", label: "B" },
      { value: "45", unit: "%", label: "C" },
    ] }, { x: 64, y: 64, w: 900, h: 300 });
    const sizeOf = (text: string) => runsOf(els).find((r) => r.text === text)?.sizePt;
    expect(sizeOf("3")).toBe(80);
    expect(sizeOf("45")).toBe(80);
    expect(sizeOf("1286.5")).toBeLessThan(80);
    expect(sizeOf("1286.5")).toBeGreaterThanOrEqual(56);
  });

  it("正文收缩不低于 16pt（quotes 引文）", () => {
    const long = "这套供应链体系让我们的履约时效和毛利结构都显著优于传统经销渠道，复购与转介绍持续走高。";
    const els = expand({ name: "quotes", items: [
      { text: long, name: "王经理", role: "采购总监" },
      { text: "合作三年，履约一直稳。", name: "李店长", role: "连锁便利" },
    ] }, HALF);
    const q = runsOf(els).find((r) => r.text === long);
    expect(q?.sizePt).toBeGreaterThanOrEqual(16);
  });
});

describe("移除整体缩字兜底", () => {
  it("装不下直接抛 LAYOUT_LEAF_INVALID（不再 0.85/0.72/0.6 重试）", () => {
    const leaf = normalizeComponentLeaf({ type: "component", name: "featureCards", items: [
      { title: "直连工厂去掉中间商", body: "与源头工厂直接合作，砍掉层层加价，出厂价直供终端门店，毛利空间显著优于传统经销。" },
      { title: "柔性供应链", body: "小单快反，以销定产，库存周转天数从九十天压缩到三十天以内。" },
    ] }, "root");
    const tiny: Frame = { x: 0, y: 0, w: 220, h: 120 };
    expect(() => expandComponent(leaf, tiny, resolveTheme(), "root")).toThrow(/LAYOUT_LEAF_INVALID: .*(超过|装不下)/);
  });
});
