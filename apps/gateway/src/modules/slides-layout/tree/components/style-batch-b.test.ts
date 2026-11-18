/**
 * 组件样式层（batch B）回归：surface / separator / density / accent / 变体。
 * 直接调各 expander 并显式注入 skin，避免受布局树预算干扰；另用归一用例守住
 * style 白名单（越界枚举报 LAYOUT_TREE_INVALID）。
 */

import { describe, expect, it } from "vitest";
import { resolveTheme, type StyleParamsInput } from "../../theme.js";
import type { ImageElement, ShapeElement, SpecElement, TextElement } from "../../elements.js";
import { resolveComponentSkin, normalizeComponentStyle, type ComponentStyleInput } from "./kit.js";
import { expandPricingTiers, type PricingTier } from "./pricing-tiers.js";
import { expandQuotes, type QuoteEntry } from "./quotes.js";
import { expandTeamGrid, type TeamMember } from "./team-grid.js";
import { expandLogoWall, type LogoSlot } from "./logo-wall.js";
import { expandOrgChart, type OrgNode } from "./org-chart.js";
import { expandBentoGrid, type BentoItem } from "./bento.js";
import { expandIndexHeader } from "./index-header.js";
import { isLeaf, normalizeTree } from "../schema.js";

const FRAME = { x: 60, y: 140, w: 1160, h: 540 };
const PLAIN = resolveTheme(null);

function skinOf(params?: StyleParamsInput | null, style?: ComponentStyleInput) {
  return resolveComponentSkin(style, resolveTheme(params));
}

function shapes(elements: SpecElement[]): ShapeElement[] {
  return elements.filter((el): el is ShapeElement => el.type === "shape");
}

function images(elements: SpecElement[]): ImageElement[] {
  return elements.filter((el): el is ImageElement => el.type === "image");
}

function texts(elements: SpecElement[]): TextElement[] {
  return elements.filter((el): el is TextElement => el.type === "text");
}

const TIERS: PricingTier[] = [
  { name: "团队版", price: "¥198", unit: "/人/月", features: ["50 人以内", "社区支持"] },
  { name: "企业版", price: "¥398", unit: "/人/月", features: ["人数不限", "私有部署", "SLA"], cta: "选择企业版" },
];

const REVIEWS: QuoteEntry[] = [
  { text: "上线第三个月人力复核降到一成以下。", name: "苏黎", role: "运营中心", rating: 5 },
  { text: "两周就跑通了我们的私有数据。", name: "何径" },
];

const LOGOS: LogoSlot[] = [
  { image: "https://example.com/a.png" },
  { image: "https://example.com/b.png" },
  { text: "OMNIA" },
  { text: "北岭云" },
];

describe("style 归一", () => {
  it("越界 surface 枚举报 LAYOUT_TREE_INVALID", () => {
    expect(() => normalizeComponentStyle({ surface: "glass" }, "content.children[0].style"))
      .toThrow(/LAYOUT_TREE_INVALID.*surface 必须是/);
  });

  it("未知 style 字段不再静默丢弃", () => {
    expect(() => normalizeComponentStyle({ glow: true }, "style")).toThrow(/不支持的样式字段/);
  });

  it("合法 style 透传到组件叶子", () => {
    const tree = normalizeTree({
      direction: "column",
      children: [{
        type: "component", name: "quotes", style: { surface: "card", separator: "none" },
        items: [{ text: "甲", name: "乙" }, { text: "丙", name: "丁" }],
      }],
    });
    const leaf = tree.children[0]!;
    if (!isLeaf(leaf) || leaf.type !== "component") return expect.fail("期望组件叶子");
    expect(leaf.style?.surface).toBe("card");
    expect(leaf.style?.separator).toBe("none");
  });
});

describe("pricingTiers：卡面皮肤", () => {
  it("非 featured 卡走主题卡面（cardStroke/cardShadow），featured 浅强调底 + 一条强调边且无阴影", () => {
    const theme = resolveTheme({
      decoration: { cardStroke: "#112233", cardShadow: "soft" },
    });
    const elements = expandPricingTiers(TIERS, 1, FRAME, theme, "定价", resolveComponentSkin(undefined, theme));
    const cards = shapes(elements).filter((el) => el.shape === "roundRect" && el.h > 100);
    expect(cards).toHaveLength(2);
    const [plain, featured] = cards;
    // 普通档 = 主题卡面处理：cardSurface + cardStroke + cardShadow。
    expect(plain!.stroke?.color).toBe("#112233");
    expect(plain!.shadow).toBe("soft");
    // featured 档 = 浅强调底 + 一条强调边（不叠顶条/阴影/反白）。
    expect(featured!.fill).toBe(resolveComponentSkin(undefined, theme).colors.emphasisSoft);
    expect(featured!.stroke).toEqual({ color: resolveComponentSkin(undefined, theme).colors.emphasis, widthPt: 1.25 });
    expect(featured!.shadow).toBeUndefined();
    expect(featured!.fill).not.toBe(plain!.fill);
    // 顶条已取消：featured 强调只剩浅底 + 强调边 + 实心 CTA。
    expect(shapes(elements).filter((el) => el.shape === "rect" && el.h === 4)).toHaveLength(0);
  });

  it("cardShadow:none 时 featured 卡不留任何硬编码阴影", () => {
    const elements = expandPricingTiers(TIERS, 1, FRAME, PLAIN, "定价", resolveComponentSkin(undefined, PLAIN));
    // 平铺风格卡下非 featured 档不铺卡；featured 仍是浅强调底 + 强调边，无阴影。
    const cards = shapes(elements).filter((el) => el.shape === "roundRect" && el.h > 100);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.fill).toBe(resolveComponentSkin(undefined, PLAIN).colors.emphasisSoft);
    expect(cards[0]!.shadow).toBeUndefined();
  });
});

describe("quotes：星级强调色", () => {
  it("accent 与 primary 不同时星标取 accent", () => {
    const theme = resolveTheme({ palette: { accent: "#C9A063" } });
    const elements = expandQuotes(REVIEWS, FRAME, theme, "评价", resolveComponentSkin(undefined, theme));
    const stars = elements.filter((el) => el.type === "icon" && el.icon === "star");
    expect(stars).toHaveLength(5);
    for (const star of stars) expect(star.type === "icon" && star.color).toBe(theme.colors.accent);
  });

  it("accent 与 primary 相同时星标取 primary（缺省风格卡）", () => {
    const elements = expandQuotes(REVIEWS, FRAME, PLAIN, "评价", resolveComponentSkin(undefined, PLAIN));
    const stars = elements.filter((el) => el.type === "icon" && el.icon === "star");
    expect(stars).toHaveLength(5);
    for (const star of stars) expect(star.type === "icon" && star.color).toBe(PLAIN.colors.primary);
  });
});

describe("teamGrid：avatar 变体", () => {
  const MEMBERS: TeamMember[] = [{ name: "甲", role: "CEO" }, { name: "乙" }];

  it("avatar:initial 无头像时画衬线首字徽章，不画 user 图标", () => {
    const elements = expandTeamGrid(MEMBERS, FRAME, PLAIN, "团队", skinOf(), "initial");
    expect(elements.filter((el) => el.type === "icon" && el.icon === "user")).toHaveLength(0);
    // 每人一个椭圆徽章（浅强调底 + 强调色衬线首字）
    const ellipses = shapes(elements).filter((el) => el.shape === "ellipse");
    expect(ellipses).toHaveLength(2);
    const badges = texts(elements).filter((el) =>
      (el.paragraphs[0]?.runs[0]?.sizePt ?? 0) >= 40
      && ["甲", "乙"].includes(el.paragraphs[0]?.runs[0]?.text ?? ""),
    );
    expect(badges).toHaveLength(2);
    expect(badges[0]!.paragraphs[0]!.runs[0]!.color).toBe(PLAIN.colors.primary);
  });

  it("avatar:circle（缺省）同样用首字徽章替掉 user 图标，但取主色实心圆", () => {
    const elements = expandTeamGrid(MEMBERS, FRAME, PLAIN, "团队", skinOf());
    expect(elements.filter((el) => el.type === "icon" && el.icon === "user")).toHaveLength(0);
    const ellipses = shapes(elements).filter((el) => el.shape === "ellipse");
    expect(ellipses).toHaveLength(2);
    for (const badge of ellipses) expect(badge.fill).toBe(PLAIN.colors.primary);
    const initials = texts(elements).filter((el) =>
      (el.paragraphs[0]?.runs[0]?.sizePt ?? 0) >= 40
      && ["甲", "乙"].includes(el.paragraphs[0]?.runs[0]?.text ?? ""),
    );
    expect(initials).toHaveLength(2);
    for (const run of initials) expect(run.paragraphs[0]!.runs[0]!.color).toBe(PLAIN.colors.background);
  });
});

describe("logoWall：monochrome 变体", () => {
  it("monochrome:false 图片不再灰度，contain 语义保留", () => {
    const mono = images(expandLogoWall(LOGOS, FRAME, PLAIN, "客户", skinOf(), true));
    expect(mono).toHaveLength(2);
    for (const img of mono) {
      expect(img.grayscale).toBe(true);
      expect(img.fit).toBe("contain");
    }
    const colorful = images(expandLogoWall(LOGOS, FRAME, PLAIN, "客户", skinOf(), false));
    expect(colorful).toHaveLength(2);
    for (const img of colorful) {
      expect(img.grayscale).toBeUndefined();
      expect(img.fit).toBe("contain");
    }
  });
});

describe("orgChart：connector 变体", () => {
  const ROOT: OrgNode = { title: "项目群", subtitle: "PMO" };
  const CHILDREN: OrgNode[] = [{ title: "产品组" }, { title: "供应链组" }, { title: "渠道组" }];

  it("connector:none 不画任何连接线", () => {
    const elements = expandOrgChart(ROOT, CHILDREN, FRAME, PLAIN, "组织", skinOf(), "none");
    expect(shapes(elements).filter((el) => el.shape === "line")).toHaveLength(0);
    // 节点盒仍在（圆角卡）
    expect(shapes(elements).filter((el) => el.shape === "roundRect")).toHaveLength(4);
  });

  it("connector:elbow（缺省）保留根下垂 + 横干 + 子下垂", () => {
    const elements = expandOrgChart(ROOT, CHILDREN, FRAME, PLAIN, "组织", skinOf());
    expect(shapes(elements).filter((el) => el.shape === "line")).toHaveLength(5);
  });
});

describe("surface / separator / density", () => {
  const ITEMS: BentoItem[] = [
    { title: "冷萃茶饮", body: "零糖零卡" },
    { title: "茶包订阅", body: "月度配送" },
    { title: "周边零售", body: "杯具与联名" },
  ];

  it("surface:card 给每个条目铺一张卡面并在 contentBox 内排版", () => {
    const elements = expandBentoGrid(ITEMS, FRAME, PLAIN, "产品", skinOf(null, { surface: "card" }));
    const cards = shapes(elements).filter((el) => el.shape === "roundRect");
    expect(cards).toHaveLength(3);
    const firstTitle = texts(elements)[0]!;
    expect(firstTitle.x).toBeGreaterThan(FRAME.x); // 内容被 pad 内缩
    // 默认 surface:none 不铺任何卡面
    const bare = expandBentoGrid(ITEMS, FRAME, PLAIN, "产品", skinOf());
    expect(shapes(bare).filter((el) => el.shape === "roundRect")).toHaveLength(0);
  });

  it("separator:none 收掉 indexHeader 的下缘身份线", () => {
    const frame = { x: 60, y: 140, w: 1160, h: 80 };
    const input = { num: "壹", title: "茶之源", note: "起源" };
    const ruled = expandIndexHeader(input, frame, PLAIN, "栏头", skinOf());
    // 下缘身份线升级为 2px 墨线（设计系统「页眉/表头 2px 墨线」）
    expect(shapes(ruled).filter((el) => el.shape === "rect" && el.h === 2)).toHaveLength(1);
    const bare = expandIndexHeader(input, frame, PLAIN, "栏头", skinOf(null, { separator: "none" }));
    expect(shapes(bare)).toHaveLength(0);
  });

  it("density:tight 比 airy 的内边距更紧", () => {
    const tight = expandQuotes(REVIEWS, FRAME, PLAIN, "评价", skinOf(null, { surface: "card", density: "tight" }));
    const airy = expandQuotes(REVIEWS, FRAME, PLAIN, "评价", skinOf(null, { surface: "card", density: "airy" }));
    for (const set of [tight, airy]) {
      expect(shapes(set).filter((el) => el.shape === "roundRect")).toHaveLength(2); // 每条目一张卡
    }
    const tightX = texts(tight)[0]!.x;
    const airyX = texts(airy)[0]!.x;
    expect(tightX).toBeLessThan(airyX);
  });
});
