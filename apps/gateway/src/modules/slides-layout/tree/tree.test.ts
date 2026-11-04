import { describe, expect, it } from "vitest";
import { isLeaf, normalizeTree, type LayoutTree } from "./schema.js";
import { contractFromStyleParams } from "./layout-contract.js";
import { darkPageTheme, deriveCardSurface, mixHex, resolveTheme } from "../theme.js";
import { compileTree } from "./compile.js";
import { measureDefects, shrinkToFit } from "./measure.js";
import { auditSimilarity, treeSignature } from "./similarity.js";
import { jpegDimensions, pngDimensions, resolveImageAr, resolveImageArs } from "./aspect-ratio.js";
import { estimateLineHeight } from "../text-metrics.js";
import type { PageSpec, TextElement } from "../elements.js";

const CONTRACT = contractFromStyleParams(null);

/** 测试端复刻墨迹估算（与 expand.test.ts 同口径）查文字两两不重叠。 */
interface InkBox { x: number; y: number; w: number; h: number }

function inkBoxes(spec: PageSpec): InkBox[] {
  const boxes: InkBox[] = [];
  for (const el of spec.elements) {
    if (el.type === "text" || (el.type === "shape" && el.paragraphs)) {
      const paragraphs = el.type === "text" ? el.paragraphs : el.paragraphs!;
      let contentH = 0;
      for (const p of paragraphs) {
        const size = Math.max(18, ...p.runs.map((r) => r.sizePt ?? 18));
        let textW = 0;
        for (const r of p.runs) {
          for (const ch of r.text) textW += (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1.35 : 0.7) * (r.sizePt ?? 18);
        }
        contentH += Math.max(1, Math.ceil(textW / Math.max(1, el.w))) * estimateLineHeight(size, p.lineSpacingPct);
      }
      const anchor = el.valign ?? (el.type === "shape" ? "middle" : "top");
      const top = anchor === "top" ? el.y : anchor === "bottom" ? el.y + el.h - contentH : el.y + (el.h - contentH) / 2;
      boxes.push({ x: el.x, y: top, w: el.w, h: contentH });
    }
  }
  return boxes;
}

function overlaps(a: InkBox, b: InkBox): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 6 && oy > 6;
}

function tree(raw: unknown): LayoutTree {
  return normalizeTree(raw);
}

describe("normalizeTree", () => {
  it("接受合法树并清洗可选字段", () => {
    const normalized = tree({
      role: "content",
      title: "页标题",
      direction: "row",
      weights: [2, 1],
      children: [
        { type: "text", variant: "body", text: "左侧要点一\n左侧要点二", bullet: true },
        { direction: "column", gapScale: 2, children: [{ type: "image", url: "https://example.com/a.jpg", contain: true }] },
      ],
    });
    expect(normalized.role).toBe("content");
    expect(normalized.children).toHaveLength(2);
    expect(normalized.gapScale).toBeUndefined();
  });

  it("既非叶子又非容器的节点报 LAYOUT_TREE_INVALID", () => {
    expect(() => tree({ direction: "row", children: [{ foo: 1 }] })).toThrow(/LAYOUT_TREE_INVALID/);
  });

  it("weights 数量与 children 不一致报错", () => {
    expect(() => tree({ direction: "row", weights: [1], children: [
      { type: "text", variant: "body", text: "a" },
      { type: "text", variant: "body", text: "b" },
    ] })).toThrow(/weights 长度（1）必须等于 children 数（2）/);
  });

  it("图片 url 只收 http(s) 或 everroom-material", () => {
    expect(() => tree({ direction: "row", children: [{ type: "image", url: "file:///etc/passwd" }] })).toThrow(/url 只接受/);
  });

  it("旧 card 叶子被拒并给出迁移指引", () => {
    expect(() => tree({ direction: "row", children: [{ type: "card", value: "3,500", label: "市场规模" }] }))
      .toThrow(/"card" 已拆分为组件/);
  });

  it("超过 12 个子节点报错", () => {
    const children = Array.from({ length: 13 }, () => ({ type: "text", variant: "caption", text: "x" }));
    expect(() => tree({ direction: "row", children })).toThrow(/最多 12 项/);
  });

  it("图表 series 与 categories 数量不一致报错", () => {
    expect(() => tree({ direction: "row", children: [{ type: "chart", kind: "bar", categories: ["a", "b"], series: [{ name: "s", values: [1] }] }] }))
      .toThrow(/必须等于 categories/);
  });

  it("节点预算拦截过碎的树", () => {
    const leaf = { type: "text", variant: "caption", text: "x" };
    let node: unknown = { direction: "column", children: [leaf] };
    for (let i = 0; i < 205; i++) node = { direction: "column", children: [node] };
    expect(() => tree(node)).toThrow(/节点总数超过/);
  });
});

/** 金标准树：role × density × 深嵌套。 */
const GOLDEN_TREES: Record<string, unknown> = {
  cover: {
    role: "cover", dark: true, direction: "column", gapScale: 2, children: [
      { type: "text", variant: "display", text: "中国茶文化出海战略", align: "center" },
      { type: "text", variant: "subtitle", text: "从品类到品牌的三年路线", align: "center", tone: "inverse" },
    ],
  },
  "content image-text": {
    role: "content", title: "冷萃工艺保留茶香本味", direction: "row", weights: [1.6, 1], children: [
      { type: "image", url: "https://example.com/craft.jpg" },
      { direction: "column", gapScale: 1.5, children: [
        { type: "text", variant: "heading", text: "四段低温萃取" },
        { type: "text", variant: "body", text: "全程 8℃ 以下冷萃 12 小时\n锁住茶氨酸与芳香物质", bullet: true },
      ] },
    ],
  },
  "data kpi": {
    role: "data", title: "茶饮市场的四个基本盘", direction: "column", children: [
      { type: "component", name: "stats", items: [
        { value: "3,500", label: "全球市场规模（亿元）" },
        { value: "31%", label: "年复合增长率" },
        { value: "2.6倍", label: "冷萃品类增速" },
        { value: "68%", label: "年轻客群占比" },
      ] },
      { type: "text", variant: "body", text: "数据来源：行业公开报告整理，2026 年 3 月。", tone: "muted" },
    ],
  },
  table: {
    role: "table", title: "三大产区的核心指标对照", direction: "row", children: [
      { type: "table", style: "lines", rows: [
        ["产区", "海拔", "年产量", "单价"],
        ["武夷山", "700m", "3200 吨", "260 元/kg"],
        ["黄山", "800m", "2800 吨", "210 元/kg"],
      ], colWidths: [1, 0.8, 1, 1] },
    ],
  },
  chart: {
    role: "data", title: "收入三年翻八倍", direction: "row", weights: [2, 1], children: [
      { type: "chart", kind: "comboBarLine", categories: ["2025", "2026", "2027", "2028"], series: [
        { name: "收入（万元）", values: [400, 1200, 3800, 9600] },
        { name: "增长率", values: [100, 200, 217, 153] },
      ] },
      { type: "component", name: "featureCards", items: [
        { title: "增速领跑", body: "三年复合增长率 217%" },
        { title: "结构优化", body: "高毛利品类占比过半" },
      ] },
    ],
  },
  "deep nesting": {
    role: "content", title: "深嵌套与 pad/gap 组合", direction: "column", gapScale: 1.5, weights: [1, 3, 2], children: [
      { type: "text", variant: "subtitle", text: "上层要点" },
      { direction: "row", pad: 16, children: [
        { direction: "column", weights: [3, 2], children: [
          { type: "text", variant: "body", text: "左侧第一层\n左侧第二层", bullet: true },
          { type: "text", variant: "caption", text: "备注口径说明", tone: "muted" },
        ] },
        { type: "component", name: "featureCards", items: [
          { title: "侧栏卡一", body: "嵌套三层后的卡" },
          { title: "侧栏卡二", body: "同一组件第二张" },
        ] },
      ] },
      { direction: "row", gapScale: 2, children: [
        { type: "path", d: "M 0 0 L 100 0 L 50 80 Z" },
        { type: "text", variant: "caption", text: "路径装饰与说明文字并排", tone: "muted" },
      ] },
    ],
  },
  quote: {
    role: "quote", title: "一句话定调", direction: "column", pad: 32, children: [
      { type: "text", variant: "heading", text: "好产品是设计出来的，更是迭代出来的。", align: "center" },
      { type: "text", variant: "caption", text: "张三 · 创始人", align: "center", tone: "muted" },
    ],
  },
  closing: {
    role: "closing", dark: true, direction: "column", gapScale: 2, children: [
      { type: "text", variant: "display", text: "山泉茶事", align: "center" },
      { type: "text", variant: "subtitle", text: "一口东方茶，半日山水间", align: "center", tone: "inverse" },
    ],
  },
};

describe("compileTree 金标准", () => {
  for (const [name, raw] of Object.entries(GOLDEN_TREES)) {
    it(`${name} 编译满足结构不变量`, () => {
      const result = compileTree(tree(raw), CONTRACT);
      expect(result.defects).toEqual([]);
      expect(measureDefects(result, CONTRACT)).toEqual([]);
      expect(result.spec.elements.length).toBeGreaterThan(0);
      expect(result.spec.elements.length).toBeLessThanOrEqual(48);
      for (const el of result.spec.elements) {
        expect(Number.isFinite(el.x)).toBe(true);
        expect(Number.isFinite(el.y)).toBe(true);
        expect(Number.isFinite(el.w)).toBe(true);
        expect(Number.isFinite(el.h)).toBe(true);
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(1281);
        expect(el.y + el.h).toBeLessThanOrEqual(721);
      }
      const boxes = inkBoxes(result.spec);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
        }
      }
    });
  }

  it("深色页背景用 darkBackground，标题带在 titleBand", () => {
    const theme = contractFromStyleParams(null).theme;
    const cover = compileTree(tree(GOLDEN_TREES["cover"]), CONTRACT);
    expect(cover.spec.background).toBe(theme.colors.darkBackground);
    const content = compileTree(tree(GOLDEN_TREES["content image-text"]), CONTRACT);
    expect(content.spec.background).toBe(theme.colors.background);
    const title = content.spec.elements.find((el) => el.type === "text" && el.y < 100);
    expect(title).toBeDefined();
  });

  it("图片叶子一律显式 fit（cover/contain 都不缺省）", () => {
    const cover = compileTree(tree(GOLDEN_TREES["content image-text"]), CONTRACT);
    const image = cover.spec.elements.find((el) => el.type === "image");
    expect(image && image.type === "image" ? image.fit : undefined).toBe("cover");
  });

  it("白底页卡面推导退到缺省浅灰，不再白上白", () => {
    const theme = resolveTheme(null);
    expect(theme.colors.background).toBe("#FAFAF8");
    expect(theme.colors.cardSurface).toBe("#f1f1ed");
    expect(deriveCardSurface("#fefefe")).toBe("#f1f1ed");
  });

  it("暖白底卡面同样退到缺省浅灰（面板须可辨）", () => {
    expect(deriveCardSurface("#fbf9f4")).toBe("#f1f1ed");
  });
});

describe("深色页组件主题视图", () => {
  const dark = darkPageTheme(CONTRACT.theme);

  it("深色页 stats：标签换深色页静音色，卡面换深底卡面", () => {
    const result = compileTree(tree({
      dark: true,
      direction: "column",
      children: [{ type: "component", name: "stats", items: [
        { value: "38", label: "同比增速" },
        { value: "1.2", label: "GMV" },
      ] }],
    }), CONTRACT);
    const label = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "同比增速")),
    );
    expect(label && label.type === "text" ? label.paragraphs[0]!.runs[0]!.color : undefined).toBe(dark.colors.textMuted);
    // 深色页：衬线数字换浅色墨，强调刻保持主色，列间发丝线换深色页分隔线
    const numeral = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "38")),
    );
    expect(numeral && numeral.type === "text" ? numeral.paragraphs[0]!.runs[0]!.color : undefined).toBe(dark.colors.text);
    const tick = result.spec.elements.some((el) => el.type === "shape" && el.fill === dark.colors.primary);
    expect(tick).toBe(true);
  });

  it("深色页 funnel：渐隐朝深色页底收淡，末级文字换浅色", () => {
    const result = compileTree(tree({
      dark: true,
      direction: "column",
      children: [{ type: "component", name: "funnel", items: [
        { stage: "访问", value: "120 万" },
        { stage: "注册", value: "36 万" },
        { stage: "付费", value: "7.2 万" },
      ] }],
    }), CONTRACT);
    const fills = result.spec.elements
      .filter((el) => el.type === "shape")
      .map((el) => (el as { fill?: string }).fill!);
    // 新口径：filled 主色明度渐隐（首级主色压深、末级向页墨收淡）。
    const solid = mixHex(dark.colors.primary, dark.colors.text, 0.32);
    expect(fills[0]).not.toBe(fills[2]);
    expect(fills[0]?.toLowerCase()).toBe(mixHex(solid, dark.colors.text, 0.04).toLowerCase());
    expect(fills[2]?.toLowerCase()).toBe(mixHex(solid, dark.colors.text, 0.37).toLowerCase());
    const lastStage = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "付费")),
    );
    expect(lastStage && lastStage.type === "text" ? lastStage.paragraphs[0]!.runs[0]!.color : undefined)
      .toBe(dark.colors.background);
  });

  it("浅色页深面板内的组件同样换深色视图", () => {
    const result = compileTree(tree({
      direction: "row",
      panel: { tone: "dark" },
      children: [{ type: "component", name: "timeline", items: [
        { label: "2024", text: "渠道扩张" },
        { label: "2025", text: "品牌溢价" },
        { label: "2026", text: "出海" },
      ] }],
    }), CONTRACT);
    const label = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "2024")),
    );
    expect(label && label.type === "text" ? label.paragraphs[0]!.runs[0]!.color : undefined)
      .toBe(CONTRACT.theme.colors.onDarkText);
  });

  it("浅色页组件不受影响（回归护栏）", () => {
    const result = compileTree(tree({
      direction: "column",
      children: [{ type: "component", name: "stats", items: [
        { value: "38", label: "同比增速" },
        { value: "1.2", label: "GMV" },
      ] }],
    }), CONTRACT);
    const label = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "同比增速")),
    );
    expect(label && label.type === "text" ? label.paragraphs[0]!.runs[0]!.color : undefined)
      .toBe(CONTRACT.theme.colors.textMuted);
  });
});

describe("measureDefects", () => {
  it("小权重子区域触发 min_size", () => {
    const result = compileTree(tree({
      direction: "row", weights: [20, 1], children: [
        { type: "text", variant: "body", text: "主体内容" },
        { type: "text", variant: "caption", text: "边" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "min_size" && d.path === "root/1")).toBe(true);
  });

  it("长文字小框触发 overflow 并带实测数字", () => {
    const result = compileTree(tree({
      direction: "column", children: [
        { type: "text", variant: "body", text: "很长的一段正文".repeat(300) },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && d.path === "root/0")).toBe(true);
  });

  it("contain 模式图框比例失配触发 image_ar", () => {
    const result = compileTree(tree({
      direction: "row", children: [
        { type: "image", url: "https://example.com/wide.jpg", contain: true },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT, { imageArs: new Map([["https://example.com/wide.jpg", 3.5]]) });
    expect(defects.some((d) => d.type === "image_ar" && d.path === "root/0")).toBe(true);
  });

  it("图数超上限触发 element_cap", () => {
    const children = Array.from({ length: 9 }, (_, i) => ({ type: "image", url: `https://example.com/${i}.jpg` }));
    const result = compileTree(tree({ direction: "row", children }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "element_cap" && /图片数 9/.test(d.detail))).toBe(true);
  });
});

describe("justify 打包", () => {
  it("row 容器带 justify 报错；column 合法", () => {
    expect(() => tree({ direction: "row", justify: "center", children: [
      { type: "text", variant: "body", text: "a" },
    ] })).toThrow(/justify 只用于 column/);
    expect(() => tree({ direction: "column", justify: "end", children: [
      { type: "text", variant: "body", text: "a" },
    ] })).not.toThrow();
  });

  it("center：文本组按自然高垂直居中", () => {
    const result = compileTree(tree({
      role: "quote", title: "引用页",
      direction: "column", justify: "center", pad: 32, children: [
        { type: "text", variant: "heading", text: "一句话", align: "center" },
        { type: "text", variant: "caption", text: "张三 · 创始人", align: "center", tone: "muted" },
      ],
    }), CONTRACT);
    expect(measureDefects(result, CONTRACT)).toEqual([]);
    const texts = result.spec.elements.filter((el) => el.type === "text" && el.y > 100);
    expect(texts.length).toBe(2);
    const first = texts[0]!;
    const second = texts[1]!;
    expect(second.y).toBeGreaterThan(first.y);
    // 组内容远小于内容区（540-64=476px），居中后首元素应落在中部而非顶部。
    expect(first.y).toBeGreaterThan(200);
    // 两个框紧挨（自然高 + 缝隙），不是各分半页。
    expect(second.y - first.y).toBeLessThan(160);
  });

  it("打包超高报缺陷", () => {
    const result = compileTree(tree({
      direction: "column", justify: "center", children: [
        { type: "text", variant: "body", text: "很长".repeat(600) },
        { type: "text", variant: "body", text: "又一段".repeat(300) },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /justify 打包/.test(d.detail))).toBe(true);
  });
});

describe("引擎硬闸镜像（真机 2026-10-15 第 4 页事故回归）", () => {
  it("KPI 卡装不下卡框时自动缩字收敛，不溢出", () => {
    const result = compileTree(tree({
      role: "data", title: "茶经立典",
      direction: "column", weights: [0.6, 1.6], children: [
        { direction: "row", gapScale: 0.7, children: [
          { type: "component", name: "stats", items: [
            { value: "780", unit: "年", label: "《茶经》成书" },
            { value: "3", unit: "卷", label: "全书十节 · 七千余言" },
            { value: "28", unit: "种", label: "记录的茶具" },
          ] },
        ] },
        { type: "text", variant: "body", text: "公元 780 年陆羽《茶经》成书，是世界第一部茶文化元典。" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /KPI 卡/.test(d.detail))).toBe(false);
    expect(result.spec.elements.length).toBeGreaterThan(0);
  });

  it("只把引擎会拒的 emoji 判成 emoji，箭头与裸符号是合法文本", () => {
    const emojiDefects = (text: string) => measureDefects(compileTree(tree({
      direction: "column", children: [{ type: "text", variant: "body", text }],
    }), CONTRACT), CONTRACT).filter((d) => d.type === "emoji");
    expect(emojiDefects("要点一 🎉 与要点二")).toHaveLength(1);
    // 2026-10-24 死锁：必留内容里的「→」被旧正则（2190–21FF）误判 emoji，validate 永远不收敛。
    expect(emojiDefects("Road／Gravel → XC／MTB／Folding")).toHaveLength(0);
    // 引擎只拒 pictograph 与 VS16；裸 ★/●/▲ 等文本字形合法。
    expect(emojiDefects("★ 三条要点 ●")).toHaveLength(0);
    expect(emojiDefects("⭐ 评级")).toHaveLength(0);
    expect(emojiDefects("⭐️ 评级")).toHaveLength(1);
  });

  it("编译产物文本墨迹两两重叠时报 overlap 缺陷", () => {
    const overlapResult = {
      spec: {
        elements: [
          { type: "text", x: 56, y: 259, w: 608, h: 65, paragraphs: [{ runs: [{ text: "很宽的两行正文内容", sizePt: 14 }] }] },
          { type: "text", x: 74, y: 259, w: 156, h: 32, paragraphs: [{ runs: [{ text: "卡标签", sizePt: 14 }] }] },
        ],
      },
      placements: [],
      defects: [],
      stats: { elements: 2, leaves: 0, depth: 0, images: 0, paths: 0 },
    };
    const defects = measureDefects(overlapResult as never, CONTRACT);
    expect(defects.some((d) => d.type === "overlap")).toBe(true);
  });
});

describe("shrinkToFit", () => {
  it("溢出文字降档后收敛并标记 degraded", () => {
    const t = tree({
      direction: "column", children: [
        { type: "text", variant: "body", text: "这是一段需要更多空间的正文内容，用来触发溢出然后验证降档收敛。".repeat(50) },
      ],
    });
    const shrunk = shrinkToFit(t, CONTRACT);
    // 降档确实发生了（degraded），但字号下限抬高之后，超长文字不再能靠缩字号硬塞进去：
    // 这是刻意的——过去正是"缩到 9pt 也要塞下"制造了满屏小字。装不下就该报错回给上游精简。
    expect(shrunk.degraded).toBe(true);
    const sizes = shrunk.result.spec.elements
      .flatMap((element) => (element.type === "text" ? element.paragraphs ?? [] : []))
      .flatMap((paragraph) => paragraph.runs ?? [])
      .map((run) => run.sizePt ?? 0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
    expect(shrunk.defects.some((d) => d.type === "overflow" || d.type === "font_floor")).toBe(true);
  });

  it("字号到下限仍装不下时报 font_floor 且不再降", () => {
    const t = tree({
      direction: "column", weights: [1, 6], children: [
        { type: "text", variant: "body", text: "这一段正文在小高度区域里无论怎么降字号都装不下。".repeat(10) },
        { type: "text", variant: "body", text: "占位" },
      ],
    });
    const shrunk = shrinkToFit(t, CONTRACT);
    expect(shrunk.defects.some((d) => d.type === "font_floor" && d.path === "root/0")).toBe(true);
  });
});

describe("similarity", () => {
  it("相邻同签名页被打回（取后一页）", () => {
    const a = tree({ role: "content", direction: "row", children: [
      { type: "text", variant: "body", text: "a" },
      { type: "text", variant: "body", text: "b" },
    ] });
    const b = tree({ role: "content", direction: "row", children: [
      { type: "text", variant: "body", text: "c" },
      { type: "text", variant: "body", text: "d" },
    ] });
    const c = tree({ role: "content", direction: "column", children: [
      { type: "text", variant: "body", text: "e" },
    ] });
    expect(treeSignature(a)).toBe(treeSignature(b));
    expect(treeSignature(a)).not.toBe(treeSignature(c));
    expect(auditSimilarity([a, b, c])).toEqual([1]);
    expect(auditSimilarity([a, c, b])).toEqual([]);
  });
});

describe("aspect-ratio", () => {
  it("png 头解析宽高", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(bytes.buffer).setUint32(16, 1792);
    new DataView(bytes.buffer).setUint32(20, 1024);
    expect(pngDimensions(bytes)).toEqual({ w: 1792, h: 1024 });
  });

  it("jpeg SOF 解析宽高", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
    new DataView(bytes.buffer).setUint16(7, 600);
    new DataView(bytes.buffer).setUint16(9, 800);
    expect(jpegDimensions(bytes)).toEqual({ w: 800, h: 600 });
  });

  it("resolveImageArs 只保留成功项", async () => {
    const deps = {
      readMaterialBlob: async (hash: string) => {
        if (hash === "a".repeat(64)) {
          const bytes = new Uint8Array(32);
          bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
          new DataView(bytes.buffer).setUint32(16, 1000);
          new DataView(bytes.buffer).setUint32(20, 500);
          return bytes;
        }
        return null;
      },
      fetchHead: async () => null,
    };
    const ar = await resolveImageAr(`everroom-material://${"a".repeat(64)}`, deps);
    expect(ar).toBe(2);
    const map = await resolveImageArs(["https://example.com/x.jpg"], deps);
    expect(map.size).toBe(0);
  });
});

describe("整页背景图（bg）", () => {
  const BG_COVER = {
    role: "cover",
    bg: { image: "https://example.com/cover.jpg" },
    direction: "overlay",
    children: [
      { type: "text", variant: "display", text: "产品发布", place: { x: 8, y: 38, w: 84, h: 30 } },
      { type: "text", variant: "subtitle", text: "2026 秋季", tone: "inverse", place: { x: 8, y: 72, w: 84, h: 12 } },
    ],
  };

  it("归一接受 bg 与 place", () => {
    const t = tree(BG_COVER);
    expect(t.bg?.image).toBe("https://example.com/cover.jpg");
    expect(t.bg?.scrim).toBeUndefined();
    expect((t.children[0] as { place?: { x: number } }).place?.x).toBe(8);
  });

  it("bg.image 非法 url 与 bg.scrim 非法值报错", () => {
    expect(() => tree({ ...BG_COVER, bg: { image: "file:///etc/passwd" } })).toThrow(/bg\.image 只接受/);
    expect(() => tree({ ...BG_COVER, bg: { image: "https://example.com/c.jpg", scrim: "dark" } })).toThrow(/bg\.scrim/);
  });

  it("编译：背景图最底、纱罩其上、bg 页视同深色页", () => {
    const result = compileTree(tree(BG_COVER), CONTRACT);
    const [first, second] = result.spec.elements;
    expect(first).toMatchObject({ type: "image", fit: "cover", x: 0, y: 0, w: 1280, h: 720, url: "https://example.com/cover.jpg" });
    expect(second).toMatchObject({ type: "shape", shape: "rect", fill: expect.stringMatching(/^#[0-9a-f]{6}A6$/) });
    expect(result.spec.background).toBe(CONTRACT.theme.colors.darkBackground);
    expect(result.bg).toEqual({ image: "https://example.com/cover.jpg", scrim: true });
    expect(measureDefects(result, CONTRACT)).toEqual([]);
  });

  it("display 未显式给 tone 时自动 onDarkText", () => {
    const result = compileTree(tree(BG_COVER), CONTRACT);
    const display = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "产品发布")),
    ) as TextElement | undefined;
    expect(display?.paragraphs[0]?.runs[0]?.color).toBe(CONTRACT.theme.colors.onDarkText);
  });

  it("背景图计入元素与图片统计", () => {
    const result = compileTree(tree(BG_COVER), CONTRACT);
    expect(result.stats.images).toBe(1);
    expect(result.stats.elements).toBe(4);
  });

  it("scrim none 且存在固定配色元素触发 contrast；压纱罩不触发", () => {
    const bare = {
      role: "content",
      bg: { image: "https://example.com/c.jpg", scrim: "none" },
      direction: "column",
      children: [{ type: "component", name: "stats", items: [
        { value: "3,500", label: "市场规模（亿元）" },
        { value: "31%", label: "年复合增长率" },
      ] }],
    };
    const defects = measureDefects(compileTree(tree(bare), CONTRACT), CONTRACT);
    expect(defects.some((d) => d.type === "contrast" && d.path === "root.bg")).toBe(true);
    const scrimmed = { ...bare, bg: { image: "https://example.com/c.jpg" } };
    const clean = measureDefects(compileTree(tree(scrimmed), CONTRACT), CONTRACT);
    expect(clean.some((d) => d.type === "contrast")).toBe(false);
  });

  it("bg 参与页签名：有无背景图不算同构", () => {
    const base = { role: "cover", direction: "column", children: [{ type: "text", variant: "subtitle", text: "a" }] };
    const withBg = { ...base, bg: { image: "https://example.com/c.jpg" } };
    expect(treeSignature(tree(withBg))).not.toBe(treeSignature(tree(base)));
  });
});

describe("overlay 叠层", () => {
  it("overlay 子节点缺 place 报错", () => {
    expect(() => tree({ direction: "overlay", children: [{ type: "text", variant: "body", text: "a" }] }))
      .toThrow(/root\/0 缺 place/);
  });

  it("非 overlay 容器带 place 报错", () => {
    expect(() => tree({
      direction: "row",
      children: [{ type: "text", variant: "body", text: "a", place: { x: 0, y: 0, w: 50, h: 50 } }],
    })).toThrow(/place 只允许出现在 overlay/);
  });

  it("place 越界与非法值报错", () => {
    expect(() => tree({
      direction: "overlay",
      children: [{ type: "text", variant: "body", text: "a", place: { x: 60, y: 0, w: 60, h: 50 } }],
    })).toThrow(/越界/);
    expect(() => tree({
      direction: "overlay",
      children: [{ type: "text", variant: "body", text: "a", place: { x: -1, y: 0, w: 60, h: 50 } }],
    })).toThrow(/place\.x/);
  });

  it("overlay 容器带 weights/gapScale 报错（root 同）", () => {
    expect(() => tree({
      direction: "overlay", weights: [1],
      children: [{ type: "text", variant: "body", text: "a", place: { x: 0, y: 0, w: 40, h: 20 } }],
    })).toThrow(/weights 不支持 overlay/);
    expect(() => tree({
      direction: "overlay", gapScale: 2,
      children: [{ type: "text", variant: "body", text: "a", place: { x: 0, y: 0, w: 40, h: 20 } }],
    })).toThrow(/gapScale 不支持 overlay/);
  });

  it("place 百分比换算像素框、声明序即 z 序", () => {
    const cf = CONTRACT.contentFrame;
    const result = compileTree(tree({
      role: "content",
      direction: "overlay",
      children: [
        { type: "image", url: "https://example.com/hero.jpg", place: { x: 0, y: 0, w: 100, h: 100 } },
        { type: "text", variant: "subtitle", text: "角标", tone: "inverse", place: { x: 50, y: 75, w: 40, h: 15 } },
      ],
    }), CONTRACT);
    const [img, txt] = result.spec.elements;
    expect(img).toMatchObject({ x: cf.x, y: cf.y, w: cf.w, h: cf.h });
    expect(txt).toMatchObject({
      x: Math.round(cf.x + (cf.w * 50) / 100),
      y: Math.round(cf.y + (cf.h * 75) / 100),
      w: Math.round((cf.w * 40) / 100),
      h: Math.round((cf.h * 15) / 100),
    });
    expect(measureDefects(result, CONTRACT)).toEqual([]);
  });

  it("overlay 子节点下限放宽到 48×32：小件放行、超限仍报", () => {
    const small = compileTree(tree({
      direction: "overlay",
      children: [
        { type: "image", url: "https://example.com/hero.jpg", place: { x: 0, y: 0, w: 100, h: 100 } },
        { type: "text", variant: "caption", text: "注", tone: "inverse", place: { x: 90, y: 88, w: 8, h: 8 } },
      ],
    }), CONTRACT);
    expect(small.placements.find((p) => p.path === "root/1")?.overlay).toBe(true);
    expect(measureDefects(small, CONTRACT).some((d) => d.type === "min_size")).toBe(false);

    const tooSmall = compileTree(tree({
      direction: "overlay",
      children: [
        { type: "image", url: "https://example.com/hero.jpg", place: { x: 0, y: 0, w: 100, h: 100 } },
        { type: "text", variant: "caption", text: "注", tone: "inverse", place: { x: 90, y: 88, w: 3, h: 6 } },
      ],
    }), CONTRACT);
    const defects = measureDefects(tooSmall, CONTRACT);
    expect(defects.some((d) => d.type === "min_size" && d.path === "root/1" && /48×32/.test(d.detail))).toBe(true);
  });
});

describe("容器面板（panel）与小件叶子", () => {
  it("panel 归一：tone 合法、radius/stroke 只接受 false", () => {
    const t = tree({
      direction: "row",
      children: [
        { direction: "column", panel: { tone: "soft" }, children: [{ type: "text", variant: "body", text: "a" }] },
      ],
    });
    expect((t.children[0] as { panel?: { tone: string } }).panel?.tone).toBe("soft");
    expect(() => tree({
      direction: "row",
      children: [{ direction: "column", panel: { tone: "neon" }, children: [{ type: "text", variant: "body", text: "a" }] }],
    })).toThrow(/panel\.tone 必须是 surface\|soft\|dark/);
    expect(() => tree({
      direction: "row",
      children: [{ direction: "column", panel: { tone: "soft", radius: true }, children: [{ type: "text", variant: "body", text: "a" }] }],
    })).toThrow(/panel\.radius 只接受 false/);
  });

  it("面板铺在子内容之下：元素序=面板先、文字后", () => {
    const result = compileTree(tree({
      direction: "row",
      children: [
        { direction: "column", panel: { tone: "soft" }, gapScale: 1.5, children: [
          { type: "text", variant: "heading", text: "分组一" },
          { type: "text", variant: "body", text: "说明文字" },
        ] },
        { type: "text", variant: "body", text: "右侧" },
      ],
    }), CONTRACT);
    const [panel, firstText] = result.spec.elements;
    expect(panel).toMatchObject({ type: "shape", shape: "roundRect", fill: CONTRACT.theme.colors.primarySoft });
    expect(firstText?.type).toBe("text");
    expect(measureDefects(result, CONTRACT)).toEqual([]);
    expect(result.stats.elements).toBe(4);
  });

  it("dark 面板内文字自动换深色页文字色", () => {
    const result = compileTree(tree({
      direction: "column",
      children: [
        { direction: "column", panel: { tone: "dark" }, children: [
          { type: "text", variant: "heading", text: "深板标题" },
        ] },
        { type: "text", variant: "body", text: "板外正文" },
      ],
    }), CONTRACT);
    const onDark = result.spec.elements.find((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "深板标题"))) as TextElement;
    const outside = result.spec.elements.find((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "板外正文"))) as TextElement;
    expect(onDark?.paragraphs[0]?.runs[0]?.color).toBe(CONTRACT.theme.colors.onDarkText);
    expect(outside?.paragraphs[0]?.runs[0]?.color).toBe(CONTRACT.theme.colors.text);
  });

  it("根节点面板铺满内容区", () => {
    const result = compileTree(tree({
      role: "content",
      panel: { tone: "surface" },
      direction: "column",
      children: [{ type: "text", variant: "body", text: "正文" }],
    }), CONTRACT);
    expect(result.spec.elements[0]).toMatchObject({ type: "shape", fill: CONTRACT.theme.colors.cardSurface, x: CONTRACT.contentFrame.x, y: 140 });
  });

  it("divider：窄高框渲染竖线并豁免 min_size，扁框渲染横线", () => {
    const result = compileTree(tree({
      direction: "row",
      weights: [5.5, 0.2, 5.5],
      children: [
        { type: "text", variant: "body", text: "左" },
        { type: "divider" },
        { type: "text", variant: "body", text: "右" },
      ],
    }), CONTRACT);
    const line = result.spec.elements.find((el) => el.type === "shape" && el.w === 1);
    expect(line).toBeDefined();
    expect(line?.h).toBeGreaterThan(100);
    expect(measureDefects(result, CONTRACT).some((d) => d.type === "min_size" && d.path === "root/1")).toBe(false);

    const flat = compileTree(tree({
      direction: "column",
      children: [
        { type: "text", variant: "body", text: "上" },
        { type: "divider" },
        { type: "text", variant: "body", text: "下" },
      ],
    }), CONTRACT);
    const hline = flat.spec.elements.find((el) => el.type === "shape" && el.h === 1);
    expect(hline).toBeDefined();
    expect(hline?.w).toBeGreaterThan(100);
  });

  it("icon：白名单内放行、白名单外报错；计入元素", () => {
    const ok = compileTree(tree({
      direction: "row",
      children: [{ type: "icon", icon: "rocket-launch" }],
    }), CONTRACT);
    expect(ok.spec.elements[0]).toMatchObject({ type: "icon", icon: "rocket-launch", color: CONTRACT.theme.colors.primary });
    expect(() => tree({ direction: "row", children: [{ type: "icon", icon: "not-an-icon" }] })).toThrow(/icon 必须是引擎图标集内/);
  });

  it("icon 非法名称在 overlay 与普通容器同样被 schema 拦截", () => {
    expect(() => tree({
      direction: "overlay",
      children: [{ type: "icon", icon: "emoji-face", place: { x: 0, y: 0, w: 10, h: 10 } }],
    })).toThrow(/icon 必须是引擎图标集内/);
  });
});

describe("组件层（component）", () => {
  const COMPONENT_TREES: Record<string, unknown> = {
    "timeline 横": {
      role: "content", title: "三年路线", direction: "column", children: [
        { type: "component", name: "timeline", items: [
          { label: "2026", text: "品类验证与供应链打底" },
          { label: "2027", text: "渠道扩张与区域仓成网" },
          { label: "2028", text: "品牌溢价与出海首站" },
        ] },
      ],
    },
    "timeline 竖": {
      role: "content", title: "里程碑", direction: "column", children: [
        { type: "component", name: "timeline", direction: "v", items: [
          { label: "立项", text: "核心班底到位" },
          { label: "内测", text: "首店单店模型跑通" },
          { label: "放量", text: "华东十店同开" },
          { label: "盈利", text: "单季度现金流转正" },
        ] },
      ],
    },
    steps: {
      role: "content", title: "四步落地", direction: "column", children: [
        { type: "component", name: "steps", items: [
          { title: "选品", text: "锁定三个高频品类" },
          { title: "定标", text: "制定感官与安全双标准" },
          { title: "代工", text: "两家代工厂双源备份" },
          { title: "上架", text: "先电商后便利店" },
        ] },
      ],
    },
    stats: {
      role: "data", title: "基本盘", direction: "column", children: [
        { type: "component", name: "stats", items: [
          { value: "3,500", label: "市场规模（亿元）" },
          { value: "31%", label: "年复合增长率" },
        ] },
      ],
    },
    featureCards: {
      role: "content", title: "三个卖点", direction: "column", children: [
        { type: "component", name: "featureCards", items: [
          { title: "冷萃锁鲜", body: "全程 8℃ 以下萃取 12 小时", icon: "sparkles" },
          { title: "零糖零卡", body: "赤藓糖醇复配，血糖友好", icon: "check-circle" },
        ] },
      ],
    },
    quote: {
      role: "quote", title: "定调", direction: "column", children: [
        { type: "component", name: "quote", text: "好产品是设计出来的，更是迭代出来的。", author: "张三 · 创始人" },
      ],
    },
    comparison: {
      role: "content", title: "本品与竞品", direction: "column", children: [
        { type: "component", name: "comparison",
          left: { title: "本品", points: ["冷萃工艺保留茶香", "零糖配方", "单瓶价格低 20%"] },
          right: { title: "竞品", points: ["高温萃取香气损耗", "含糖量高", "价格带偏高"] } },
      ],
    },
  };

  it("六个组件编译通过且满足结构不变量", () => {
    for (const [name, raw] of Object.entries(COMPONENT_TREES)) {
      const result = compileTree(tree(raw), CONTRACT);
      expect(result.defects, name).toEqual([]);
      expect(measureDefects(result, CONTRACT), name).toEqual([]);
      expect(result.spec.elements.length, name).toBeGreaterThan(0);
      expect(result.spec.elements.length, name).toBeLessThanOrEqual(48);
      const boxes = inkBoxes(result.spec);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i]!, boxes[j]!), `${name} 墨迹重叠`).toBe(false);
        }
      }
    }
  });

  it("timeline 横版结构：轴线 + 每条节点/年份/正文", () => {
    const result = compileTree(tree(COMPONENT_TREES["timeline 横"]!), CONTRACT);
    const shapes = result.spec.elements.filter((el) => el.type === "shape") as { shape: string; h: number; w: number; fill?: string }[];
    const axis = shapes.find((el) => el.shape === "rect" && el.h === 2 && el.w > CONTRACT.contentFrame.w * 0.9);
    expect(axis).toBeDefined();
    expect(shapes.filter((el) => el.shape === "ellipse")).toHaveLength(3);
    const texts = result.spec.elements.filter((el) => el.type === "text") as TextElement[];
    for (const year of ["2026", "2027", "2028"]) {
      expect(texts.some((el) => el.paragraphs.some((p) => p.runs.some((r) => r.text === year))), year).toBe(true);
    }
    for (const body of ["品类验证与供应链打底", "渠道扩张与区域仓成网", "品牌溢价与出海首站"]) {
      expect(texts.some((el) => el.paragraphs.some((p) => p.runs.some((r) => r.text === body))), body).toBe(true);
    }
  });

  it("stats 展开元素数 = 每条 3 个 + 列间发丝线", () => {
    const result = compileTree(tree(COMPONENT_TREES.stats!), CONTRACT);
    expect(result.stats.elements).toBe(2 * 3 + 1 + 1); // 2×(刻+标签+数字) + 列间线 + 标题带
  });

  it("featureCards 非法 icon 名被归一拦截", () => {
    expect(() => tree({
      direction: "column",
      children: [{ type: "component", name: "featureCards", items: [
        { title: "a", icon: "not-an-icon" },
        { title: "b" },
      ] }],
    })).toThrow(/items\[0\]\.icon 必须是引擎图标集内/);
  });

  it("组件条目数档位越界报错", () => {
    expect(() => tree({
      direction: "column",
      children: [{ type: "component", name: "timeline", items: [
        { label: "a", text: "b" }, { label: "c", text: "d" },
      ] }],
    })).toThrow(/items 必须是 3~6 项/);
    expect(() => tree({
      direction: "column",
      children: [{ type: "component", name: "steps", items: [
        { title: "1" }, { title: "2" }, { title: "3" }, { title: "4" }, { title: "5" }, { title: "6" },
      ] }],
    })).toThrow(/items 必须是 3~5 项/);
  });

  it("未知组件名报错并列出可用组件", () => {
    expect(() => tree({
      direction: "column",
      children: [{ type: "component", name: "gantt", items: [] }],
    })).toThrow(/name 必须是 timeline\|steps\|stats\|featureCards\|quote\|comparison/);
  });

  it("quote 文字过长装不下时报 overflow 缺陷", () => {
    const result = compileTree(tree({
      direction: "row", weights: [3, 1], children: [
        { type: "text", variant: "body", text: "占位" },
        { type: "component", name: "quote", text: "这是一段非常长的引文。".repeat(20) },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /引言/.test(d.detail))).toBe(true);
  });

  it("组件在 overlay 容器内按 place 定位展开", () => {
    const result = compileTree(tree({
      direction: "overlay",
      children: [
        { type: "image", url: "https://example.com/hero.jpg", place: { x: 0, y: 0, w: 100, h: 100 } },
        { type: "component", name: "quote", text: "图上引言", place: { x: 10, y: 50, w: 80, h: 40 } },
      ],
    }), CONTRACT);
    const cf = CONTRACT.contentFrame;
    const frameX = Math.round(cf.x + (cf.w * 10) / 100);
    const frameW = Math.round((cf.w * 80) / 100);
    const quoteText = result.spec.elements.find((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "图上引言"))) as TextElement | undefined;
    expect(quoteText).toBeDefined();
    expect(quoteText!.x).toBeGreaterThanOrEqual(frameX);
    expect(quoteText!.x + quoteText!.w).toBeLessThanOrEqual(frameX + frameW + 2);
    expect(result.placements.find((p) => p.kind === "component")?.overlay).toBe(true);
  });
});

describe("组件库扩展（第一批+第二批）", () => {
  const LIB_TREES: Record<string, unknown> = {
    matrix2x2: {
      role: "content", title: "市场进入四象限", direction: "column", children: [
        { type: "component", name: "matrix2x2",
          axes: { top: "高增长", bottom: "低增长", left: "小市场", right: "大市场" },
          quadrants: [
            { title: "培育区", points: ["试点验证", "小额投入"] },
            { title: "明星区", points: ["重仓投入", "建护城河"] },
            { title: "观望区", points: ["保持跟踪"] },
            { title: "现金流区", points: ["收割利润", "控成本"] },
          ] },
      ],
    },
    prosCons: {
      role: "content", title: "方案的得与失", direction: "column", children: [
        { type: "component", name: "prosCons",
          pros: ["供应链自主可控", "毛利结构更健康", "品牌资产沉淀"],
          cons: ["前期投入重", "组织能力要求高"] },
      ],
    },
    agenda: {
      role: "agenda", direction: "column", children: [
        { type: "component", name: "agenda", items: ["市场判断", "品类策略", "供应链设计", "渠道打法", "组织与节奏", "财务测算"] },
      ],
    },
    chevron: {
      role: "content", title: "落地四步", direction: "column", children: [
        { type: "component", name: "chevron", items: [
          { title: "选品" }, { title: "定标", text: "双标准" }, { title: "代工", text: "双源备份" }, { title: "上架" },
        ] },
      ],
    },
    pyramid: {
      role: "content", title: "能力金字塔", direction: "column", children: [
        { type: "component", name: "pyramid", items: [
          { title: "品牌" }, { title: "渠道", text: "线上线下融合" }, { title: "供应链", text: "柔性快反" }, { title: "产品", text: "高频刚需" },
        ] },
      ],
    },
    funnel: {
      role: "data", title: "转化漏斗", direction: "column", children: [
        { type: "component", name: "funnel", items: [
          { stage: "曝光", value: "120 万" }, { stage: "进店", value: "18 万" }, { stage: "加购", value: "4.2 万" }, { stage: "成交", value: "9 千" },
        ] },
      ],
    },
    venn: {
      role: "content", title: "两类能力交汇", direction: "column", children: [
        { type: "component", name: "venn", a: "产品力", b: "渠道力", both: "增长引擎" },
      ],
    },
    calloutBox: {
      role: "content", title: "本页结论", direction: "column", children: [
        { type: "component", name: "calloutBox", text: "冷萃品类是三年内唯一兼具增速与毛利的赛道。", icon: "light-bulb" },
      ],
    },
    cycle: {
      role: "content", title: "增长飞轮", direction: "column", children: [
        { type: "component", name: "cycle", items: [
          { title: "引流" }, { title: "转化" }, { title: "复购" }, { title: "推荐" },
        ] },
      ],
    },
    progress: {
      role: "data", title: "季度目标进度", direction: "column", children: [
        { type: "component", name: "progress", items: [
          { label: "营收目标", value: 72 },
          { label: "新客获取", value: 45, unit: "分" },
          { label: "履约时效", value: 90 },
        ] },
      ],
    },
    orgChart: {
      role: "content", title: "项目组织", direction: "column", children: [
        { type: "component", name: "orgChart",
          root: { title: "项目群", subtitle: "PMO" },
          children: [
            { title: "产品组" }, { title: "供应链组", subtitle: "采购+品控" }, { title: "渠道组" },
          ] },
      ],
    },
    persona: {
      role: "content", title: "目标用户画像", direction: "column", children: [
        { type: "component", name: "persona",
          person: { name: "都市新中产", role: "25-35 岁 · 一二线城市" },
          points: ["健康优先，看配料表", "愿为便利付溢价", "品牌忠诚度低"] },
      ],
    },
    bentoGrid: {
      role: "content", title: "产品全景", direction: "column", children: [
        { type: "component", name: "bentoGrid", items: [
          { title: "冷萃茶饮", body: "零糖零卡，8℃ 萃取", icon: "sparkles" },
          { title: "茶包订阅", body: "月度配送", icon: "envelope" },
          { title: "周边零售", body: "杯具与联名", icon: "shopping-cart" },
          { title: "会员体系", body: "积分与权益通吃全渠道", icon: "star", wide: true },
        ] },
      ],
    },
    layeredStack: {
      role: "content", title: "系统架构分层", direction: "column", children: [
        { type: "component", name: "layeredStack", items: [
          { title: "应用层", text: "小程序与门店 POS" },
          { title: "业务层", text: "订单、库存、会员" },
          { title: "数据层", text: "数仓与指标体系" },
          { title: "基础设施", text: "云主机与容器" },
        ] },
      ],
    },
  };

  it("十四个新组件编译通过且满足结构不变量", () => {
    for (const [name, raw] of Object.entries(LIB_TREES)) {
      const result = compileTree(tree(raw), CONTRACT);
      expect(result.defects, name).toEqual([]);
      expect(measureDefects(result, CONTRACT), name).toEqual([]);
      expect(result.spec.elements.length, name).toBeGreaterThan(0);
      expect(result.spec.elements.length, name).toBeLessThanOrEqual(48);
      const boxes = inkBoxes(result.spec);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i]!, boxes[j]!), `${name} 墨迹重叠`).toBe(false);
        }
      }
    }
  });

  it("chevron 首段 homePlate 后续 chevron，默认实心", () => {
    const result = compileTree(tree(LIB_TREES.chevron!), CONTRACT);
    const shapes = result.spec.elements.filter((el) => el.type === "shape") as { shape: string; fill?: string; stroke?: { color: string } }[];
    expect(shapes.map((s) => s.shape)).toEqual(["homePlate", "chevron", "chevron", "chevron"]);
    for (const shape of shapes) {
      expect(shape.fill).toBe(CONTRACT.theme.colors.primary);
      expect(shape.stroke).toBeUndefined();
    }
    // 实心深底 → 段内文字反白。
    const firstText = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "选品")),
    ) as TextElement | undefined;
    expect(firstText?.paragraphs[0]?.runs[0]?.color).toBe(CONTRACT.theme.colors.onDarkText);
  });

  it("chevron 相扣链：等高等距、相邻形留斜缝，文字落在形内", () => {
    const result = compileTree(tree(LIB_TREES.chevron!), CONTRACT);
    const shapes = result.spec.elements.filter((el) => el.type === "shape") as { shape: string; x: number; y: number; w: number; h: number }[];
    const first = shapes[0]!;
    for (const shape of shapes) {
      expect(shape.y).toBe(first.y);
      expect(shape.h).toBe(first.h);
    }
    let previousX = -Infinity;
    for (const shape of shapes) {
      expect(shape.x).toBeGreaterThanOrEqual(previousX); // 列向右推进（形状之间可咬合重叠）
      expect(shape.w).toBeGreaterThan(shape.h * 0.5);
      previousX = shape.x;
    }
    const texts = result.spec.elements.filter(
      (el) => el.type === "text" && el.y >= first.y,
    ) as TextElement[];
    expect(texts.length).toBe(6);
    for (const text of texts) {
      const inside = shapes.some((shape) => text.x + text.w / 2 >= shape.x && text.x + text.w / 2 <= shape.x + shape.w && text.y >= shape.y && text.y <= shape.y + shape.h);
      expect(inside).toBe(true);
    }
  });

  it("venn 两圆相交成透镜、主色淡填充可见，交集标签对透镜中心", () => {
    const result = compileTree(tree(LIB_TREES.venn!), CONTRACT);
    const circles = result.spec.elements.filter((el) => el.type === "shape" && (el as { shape: string }).shape === "ellipse") as { x: number; w: number; fill?: string }[];
    expect(circles).toHaveLength(2);
    const [c1, c2] = circles as [typeof circles[number], typeof circles[number]];
    expect(c2.x).toBeLessThan(c1.x + c1.w); // 相交
    const lens = c1.x + c1.w - c2.x;
    expect(lens).toBeGreaterThanOrEqual(100); // 透镜宽可辨（目标 140）
    for (const c of circles) expect(c.fill).toBe(`${CONTRACT.theme.colors.primary}1C`);
    const both = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs[0]?.runs[0]?.color === CONTRACT.theme.colors.primary,
    ) as { x: number; w: number } | undefined;
    expect(both).toBeDefined();
    const lensMid = (c1.x + c1.w + c2.x) / 2;
    expect(Math.abs(both!.x + both!.w / 2 - lensMid)).toBeLessThanOrEqual(2);
  });

  it("funnel 横条逐级收窄且数值落在条内", () => {
    const result = compileTree(tree(LIB_TREES.funnel!), CONTRACT);
    const bars = result.spec.elements.filter((el) => el.type === "shape" && el.shape === "rect") as { w: number }[];
    expect(bars.length).toBe(4);
    expect(bars[0]!.w).toBeGreaterThan(bars[3]!.w);
  });

  it("progress 前景条宽 = 百分比 × 轨道宽，填充为墨色", () => {
    const result = compileTree(tree(LIB_TREES.progress!), CONTRACT);
    const bars = (result.spec.elements.filter((el) => el.type === "shape" && el.shape === "roundRect") as { x: number; w: number; fill?: string; h: number }[])
      .filter((b) => b.h >= 8);
    expect(bars.length).toBe(6); // 3 项 × 轨道+前景（序：轨道、前景交替）
    expect(bars[1]!.w).toBe(Math.round(bars[0]!.w * 0.72)); // 第一项 value=72
    expect(bars[1]!.fill).toBe(CONTRACT.theme.colors.text);
  });

  it("orgChart 有 line 连接线且两层结构成立", () => {
    const result = compileTree(tree(LIB_TREES.orgChart!), CONTRACT);
    const lines = result.spec.elements.filter((el) => el.type === "shape" && (el as { shape: string }).shape === "line");
    expect(lines.length).toBe(5); // 根下垂 1 + 横干 1 + 子下垂 3
    const boxes = result.spec.elements.filter((el) => el.type === "shape" && (el as { shape: string }).shape === "roundRect");
    expect(boxes.length).toBe(4); // 根 + 3 子（圆角卡）
  });

  it("bentoGrid wide 条目占整行，卡片按行铺排", () => {
    const result = compileTree(tree(LIB_TREES.bentoGrid!), CONTRACT);
    // 新口径用卡片 + 间距分隔，不再画发丝线。
    expect(result.spec.elements.some((el) => el.type === "shape" && el.h === 1)).toBe(false);
    const wideTitle = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "会员体系")),
    ) as TextElement | undefined;
    expect(wideTitle).toBeDefined();
    // wide 行的标题框明显宽于普通 tile（整行铺开）。
    const normalTitle = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "冷萃茶饮")),
    ) as TextElement | undefined;
    expect(wideTitle!.w).toBeGreaterThan(normalTitle!.w);
  });

  it("新组件参数越界在归一层拦下", () => {
    expect(() => tree({ direction: "column", children: [{ type: "component", name: "agenda", items: ["a", "b", "c"] }] }))
      .toThrow(/items 必须是 4~8 项/);
    expect(() => tree({ direction: "column", children: [{ type: "component", name: "progress", items: [{ label: "a", value: 50 }, { label: "b", value: 150 }] }] }))
      .toThrow(/value 必须是 0~100/);
    expect(() => tree({ direction: "column", children: [{ type: "component", name: "venn", a: "" , b: "渠道" }] }))
      .toThrow(/缺少 root\/0\.a/);
    expect(() => tree({ direction: "column", children: [{ type: "component", name: "matrix2x2", quadrants: [
      { title: "a" }, { title: "b" }, { title: "c" },
    ] }] })).toThrow(/quadrants 必须是 4~4 项/);
  });

  it("cycle 窄区域内节点装不下时在展开层报缺陷（归一层只截断不报错）", () => {
    const result = compileTree(tree({
      direction: "row", weights: [1, 4], children: [
        { type: "component", name: "cycle", items: [
          { title: "超长标题" }, { title: "引流" }, { title: "转化" }, { title: "复购" },
        ] },
        { type: "text", variant: "body", text: "占位" },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /节点/.test(d.detail))).toBe(true);
  });

  it("组件名参与页签名：同结构不同组件不再误判同构", () => {
    const pageA = tree({ role: "content", direction: "column", children: [{ type: "component", name: "timeline", items: [
      { label: "a", text: "b" }, { label: "c", text: "d" }, { label: "e", text: "f" },
    ] }] });
    const pageB = tree({ role: "content", direction: "column", children: [{ type: "component", name: "quote", text: "一句话" }] });
    expect(treeSignature(pageA)).not.toBe(treeSignature(pageB));
  });
});

describe("P0 扩展：质感层", () => {
  it("tint 面板：渐层釉面——主色渐层+发丝描边", () => {
    const result = compileTree(tree({
      role: "content", title: "釉面面板", direction: "row", panel: { tone: "tint" },
      children: [{ type: "text", variant: "body", text: "面板上的文字" }],
    }), CONTRACT);
    const panel = result.spec.elements.find((el) => el.type === "shape");
    expect(panel).toBeDefined();
    if (panel?.type !== "shape") return;
    expect(panel.gradient).toBeDefined();
    expect(panel.gradient!.stops[0]!.color).toMatch(/2447b0(15|16)/i); // 8.5% ≈ 0x15
    expect(panel.gradient!.stops[1]!.color).toMatch(/2447b00(9|a)/i);  // 3.5% ≈ 0x09
    expect(panel.stroke?.color).toMatch(/2447b029/i); // 16% ≈ 0x29
    expect(panel.fill).toBeUndefined();
  });

  it("leftBar 面板：白卡+左主色胶囊刻标（2 个形状）", () => {
    const result = compileTree(tree({
      role: "content", title: "刻标卡", direction: "row", panel: { tone: "leftBar" },
      children: [{ type: "text", variant: "body", text: "刻标卡上的文字" }],
    }), CONTRACT);
    const shapes = result.spec.elements.filter((el) => el.type === "shape");
    expect(shapes.length).toBe(2);
    const bar = shapes[1]!;
    if (bar.type !== "shape") return;
    expect(bar.fill).toBe(CONTRACT.theme.colors.primary);
    expect(bar.w).toBe(3);
  });

  it("nested 面板：洗地+内卡两形状，子节点落在内卡框", () => {
    const result = compileTree(tree({
      role: "content", title: "嵌套面板", direction: "row", panel: { tone: "nested" },
      children: [{ type: "text", variant: "body", text: "内卡上的文字" }],
    }), CONTRACT);
    const shapes = result.spec.elements.filter((el) => el.type === "shape");
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    // 文字 x 落在内卡内（面板框 x=60 + insetX 44 + 文本框自身位置）
    const text = result.spec.elements.find((el) => el.type === "text" && el.y > 140);
    expect(text!.x).toBeGreaterThan(100);
  });

  it("outline 面板：零填充+发丝描边+近直角", () => {
    const result = compileTree(tree({
      role: "content", title: "线框面板", direction: "row", panel: { tone: "outline" },
      children: [{ type: "text", variant: "body", text: "线框上的文字" }],
    }), CONTRACT);
    const panel = result.spec.elements.find((el) => el.type === "shape");
    if (panel?.type !== "shape") return;
    expect(panel.fill).toBe("#00000000");
    expect(panel.stroke).toBeDefined();
    expect(panel.adj).toBeGreaterThan(0); // 4px 近直角仍走圆角管径
  });

  it("dark 面板：深底三档渐层", () => {
    const result = compileTree(tree({
      role: "content", title: "墨面", direction: "row", panel: { tone: "dark" },
      children: [{ type: "text", variant: "body", text: "深面板文字" }],
    }), CONTRACT);
    const panel = result.spec.elements.find((el) => el.type === "shape");
    if (panel?.type !== "shape") return;
    expect(panel.gradient).toBeDefined();
    expect(panel.gradient!.stops).toHaveLength(3);
    expect(panel.gradient!.angle).toBe(135);
  });

  it("渐层纱罩：bg.scrim=gradient 产出带 alpha 渐变的满页矩形", () => {
    const result = compileTree(tree({
      role: "content", title: "渐层纱罩", bg: { image: "https://example.com/bg.jpg", scrim: "gradient" },
      direction: "row", children: [{ type: "text", variant: "body", text: "压图文字" }],
    }), CONTRACT);
    const scrims = result.spec.elements.filter((el) => el.type === "shape" && el.gradient);
    expect(scrims).toHaveLength(1);
    const scrim = scrims[0]!;
    if (scrim.type !== "shape") return;
    expect(scrim.gradient!.stops).toHaveLength(2);
    expect(scrim.gradient!.stops[0]!.color).toMatch(/e6$/i);
    expect(scrim.gradient!.stops[1]!.color).toMatch(/26$/i);
    expect(scrim.gradient!.angle).toBe(90);
  });

  it("solid 纱罩仍是缺省：不传 scrim 时产出纯色纱罩", () => {
    const result = compileTree(tree({
      role: "content", title: "默认纱罩", bg: { image: "https://example.com/bg.jpg" },
      direction: "row", children: [{ type: "text", variant: "body", text: "压图文字" }],
    }), CONTRACT);
    expect(result.spec.elements.some((el) => el.type === "shape" && !el.gradient && /a6$/i.test(el.fill ?? ""))).toBe(true);
  });

  it("页脚契约：brand/label/页码注入常规页，整页构图自动跳过", () => {
    const contract = contractFromStyleParams({ footer: { brand: "EverRoom", label: "对外资料", pageNumbers: true } });
    const normal = compileTree(tree({
      role: "content", title: "常规页", direction: "row",
      children: [{ type: "text", variant: "body", text: "正文" }],
    }), contract, undefined, { pageIndex: 7, pageCount: 24 });
    const footerTexts = normal.spec.elements.filter(
      (el) => el.type === "text" && el.y > 680,
    ) as TextElement[];
    const texts = footerTexts.flatMap((el) => el.paragraphs.flatMap((p) => p.runs.map((r) => r.text)));
    expect(texts).toContain("EverRoom");
    expect(texts).toContain("对外资料");
    expect(texts).toContain("7 / 24");
    // 封面（省略 title）无页脚
    const cover = compileTree(tree({
      role: "cover", direction: "column", justify: "center",
      children: [{ type: "text", variant: "display", text: "封面标题", align: "center" }],
    }), contract, undefined, { pageIndex: 1, pageCount: 24 });
    expect(cover.spec.elements.some((el) => el.type === "text" && el.y > 680)).toBe(false);
  });
});

describe("P0 扩展：图表", () => {
  it("area：引擎原生面积图", () => {
    const result = compileTree(tree({
      role: "data", title: "趋势", direction: "row",
      children: [{ type: "chart", kind: "area", categories: ["1月", "2月", "3月"], series: [{ name: "营收", values: [10, 14, 19] }] }],
    }), CONTRACT);
    const chart = result.spec.elements.find((el) => el.type === "chart");
    expect(chart?.type === "chart" && chart.chart).toBe("area");
  });

  it("highlight：首系列逐点填色——高亮列主色、其余浅档", () => {
    const result = compileTree(tree({
      role: "data", title: "重点色", direction: "row",
      children: [{ type: "chart", kind: "bar", categories: ["2023", "2024", "2025"], highlight: "last",
        series: [{ name: "营收", values: [12, 18, 27] }] }],
    }), CONTRACT);
    const chart = result.spec.elements.find((el) => el.type === "chart");
    if (chart?.type !== "chart") return expect.fail("无图表元素");
    expect(chart.pointColors).toBeDefined();
    const row = chart.pointColors![0]!;
    expect(row[2]).toBe(CONTRACT.theme.colors.primary);
    expect(row[0]).not.toBe(CONTRACT.theme.colors.primary);
  });

  it("delta：图表右上角主色圆角徽章", () => {
    const result = compileTree(tree({
      role: "data", title: "涨跌", direction: "row",
      children: [{ type: "chart", kind: "bar", categories: ["2024", "2025"], delta: "+42%",
        series: [{ name: "营收", values: [18, 27] }] }],
    }), CONTRACT);
    const pill = result.spec.elements.find((el) => el.type === "shape" && el.fill === CONTRACT.theme.colors.primary);
    expect(pill).toBeDefined();
  });

  it("waterfall：展开为形状组——结果柱用系列第 4 档色、连接线挂在起点水位", () => {
    const result = compileTree(tree({
      role: "data", title: "瀑布", direction: "row",
      children: [{ type: "chart", kind: "waterfall", categories: ["营收", "成本", "毛利"],
        series: [{ name: "拆解", values: [128, -74, 0] }] }],
    }), CONTRACT);
    const bars = result.spec.elements.filter((el) => el.type === "shape" && !el.paragraphs);
    // 3 根柱 + 2 条连接线
    expect(bars.length).toBe(5);
    const labels = result.spec.elements.filter((el) => el.type === "text" && el.y > 140);
    // 每列数值标注 + 类目标签（页标题带除外）
    expect(labels.length).toBe(6);
  });

  it("waterfall 校验：多系列拒绝、超 8 列拒绝", () => {
    expect(() => tree({
      role: "data", direction: "row",
      children: [{ type: "chart", kind: "waterfall", categories: ["a", "b"], series: [
        { name: "甲", values: [1, 2] }, { name: "乙", values: [2, 1] }] }],
    })).toThrow(/1 个系列/);
    expect(() => tree({
      role: "data", direction: "row",
      children: [{ type: "chart", kind: "waterfall",
        categories: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
        series: [{ name: "甲", values: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] }],
    })).toThrow(/最多 8 列/);
  });
});

describe("P0 扩展：图片处理", () => {
  it("radius/duotone：圆角卡带主题 adj、双色调为主题色对", () => {
    const result = compileTree(tree({
      role: "content", title: "图片卡", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", radius: true, duotone: true }],
    }), CONTRACT);
    const img = result.spec.elements.find((el) => el.type === "image");
    if (img?.type !== "image") return expect.fail("无图片元素");
    expect(img.radiusAdj).toBeGreaterThan(0);
    expect(img.duotone).toHaveLength(2);
    expect(img.duotone![0]).toMatch(/^#/);
  });

  it("focus：焦点透传（0~100）", () => {
    const result = compileTree(tree({
      role: "content", title: "焦点", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", focus: { y: 25 } }],
    }), CONTRACT);
    const img = result.spec.elements.find((el) => el.type === "image");
    if (img?.type !== "image") return expect.fail("无图片元素");
    expect(img.focus).toEqual({ x: 50, y: 25 });
  });

  it("caption：压图小字签为深色玻璃底形状", () => {
    const result = compileTree(tree({
      role: "content", title: "字签", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", caption: "图 1 · 示意" }],
    }), CONTRACT);
    const chips = result.spec.elements.filter((el) => el.type === "shape" && el.paragraphs);
    expect(chips).toHaveLength(1);
    if (chips[0]!.type !== "shape") return;
    expect(chips[0]!.fill).toMatch(/.{2}$/i);
    expect(chips[0]!.fill!.length).toBe(9); // 8 位 hex（含 alpha）
  });

  it("featureCards/bentoGrid 图槽：图片条目替换图标并带圆角", () => {
    const result = compileTree(tree({
      role: "卖点", title: "图卡", direction: "row",
      children: [{ type: "component", name: "featureCards", items: [
        { title: "有图卡", body: "图片在标题上方", image: "https://example.com/x.jpg" },
        { title: "有标卡", body: "图标在标题上方", icon: "bolt" },
      ] }],
    }), CONTRACT);
    const imgs = result.spec.elements.filter((el) => el.type === "image" && el.url === "https://example.com/x.jpg");
    expect(imgs).toHaveLength(1);
    if (imgs[0]!.type !== "image") return;
    expect(imgs[0]!.radiusAdj).toBeGreaterThan(0);
    const icons = result.spec.elements.filter((el) => el.type === "icon");
    expect(icons.length).toBe(1); // 只有图标条目画图标
  });

  it("图槽校验：非法图片地址拒绝", () => {
    expect(() => tree({
      role: "卖点", direction: "row",
      children: [{ type: "component", name: "featureCards", items: [
        { title: "坏图", image: "ftp://example.com/x.jpg" },
        { title: "占位" },
      ] }],
    })).toThrow(/http\(s\)|素材引用/);
  });
});

describe("批次1 扩展：圆形裁切与灰度", () => {
  it("circle 与 radius 同给拒绝", () => {
    expect(() => tree({
      role: "团队", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", circle: true, radius: true }],
    })).toThrow(/二选一/);
  });

  it("circle：圆形裁切透传，无 radiusAdj", () => {
    const result = compileTree(tree({
      role: "团队", title: "头像", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", circle: true }],
    }), CONTRACT);
    const img = result.spec.elements.find((el) => el.type === "image");
    if (img?.type !== "image") return expect.fail("无图片元素");
    expect(img.circle).toBe(true);
    expect(img.radiusAdj).toBeUndefined();
  });

  it("grayscale 与 duotone 同给拒绝", () => {
    expect(() => tree({
      role: "客户", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", grayscale: true, duotone: true }],
    })).toThrow(/二选一/);
  });

  it("grayscale：灰度透传", () => {
    const result = compileTree(tree({
      role: "客户", title: "logo 墙", direction: "row",
      children: [{ type: "image", url: "https://example.com/a.jpg", grayscale: true }],
    }), CONTRACT);
    const img = result.spec.elements.find((el) => el.type === "image");
    if (img?.type !== "image") return expect.fail("无图片元素");
    expect(img.grayscale).toBe(true);
  });
});

describe("批次2 扩展：五个新组件", () => {
  it("comparison 多方：sides+featured 展开三态图标与推荐签；旧 left/right 自动转换", () => {
    const result = compileTree(tree({
      role: "对比", title: "四方案对照", direction: "row",
      children: [{ type: "component", name: "comparison",
        sides: [
          { title: "本品", points: [{ text: "私有化部署", mark: "yes" }, { text: "中文检索", mark: "yes" }] },
          { title: "竞品 A", points: [{ text: "托管", mark: "no" }, "插件生态"] },
          { title: "竞品 B", points: ["部分支持", { text: "只读 API", mark: "mid" }] },
          { title: "竞品 C", points: ["社区版", "企业版"] },
        ],
        featured: 0 }] }), CONTRACT);
    const icons = result.spec.elements.filter((el) => el.type === "icon");
    // yes×2 + no×1 + mid×1
    expect(icons.length).toBe(4);
    // 旧口径：left/right 转 sides 且右列为重点
    const legacy = tree({
      role: "对比", direction: "row",
      children: [{ type: "component", name: "comparison",
        left: { title: "甲", points: ["一", "二"] }, right: { title: "乙", points: ["一", "二"] } }] });
    const first = legacy.children[0]!;
    expect(isLeaf(first) && first.type === "component" && first.name === "comparison").toBe(true);
  });

  it("comparison 校验：sides 与 left/right 同给拒绝；mark 非法拒绝；4 方限 4 点", () => {
    expect(() => tree({ role: "对比", direction: "row", children: [{ type: "component", name: "comparison",
      sides: [{ title: "甲", points: ["一", "二"] }, { title: "乙", points: ["一", "二"] }],
      left: { title: "丙", points: ["一", "二"] }, right: { title: "丁", points: ["一", "二"] } }] })).toThrow(/二选一/);
    expect(() => tree({ role: "对比", direction: "row", children: [{ type: "component", name: "comparison",
      sides: [{ title: "甲", points: [{ text: "一", mark: "bad" }, "二"] }, { title: "乙", points: ["一", "二"] }] }] })).toThrow(/yes\|mid\|no/);
  });

  it("teamGrid：成员元素齐备、无图者画图标占位", () => {
    const result = compileTree(tree({
      role: "团队", title: "核心团队", direction: "row",
      children: [{ type: "component", name: "teamGrid", members: [
        { name: "甲", role: "CEO", bio: "公司创始人", image: "https://example.com/a.jpg" },
        { name: "乙", role: "CTO" },
        { name: "丙", bio: "产品负责人" },
        { name: "丁" },
      ] }] }), CONTRACT);
    const imgs = result.spec.elements.filter((el) => el.type === "image" && el.circle);
    expect(imgs.length).toBe(1);
    // 新口径：无图成员用姓名首字衬线徽章，不再画通用 user 图标。
    const userIcons = result.spec.elements.filter((el) => el.type === "icon" && el.icon === "user");
    expect(userIcons.length).toBe(0);
    const badges = result.spec.elements.filter((el) => el.type === "shape" && el.shape === "ellipse");
    expect(badges.length).toBe(3);
  });

  it("quotes：星级与头像；rating 越界拒绝", () => {
    const result = compileTree(tree({
      role: "评价", title: "客户之声", direction: "row",
      children: [{ type: "component", name: "quotes", items: [
        { text: "上线第三个月人力复核降到一成以下。", name: "苏黎", role: "运营中心", avatar: "https://example.com/a.jpg", rating: 5 },
        { text: "两周就跑通了我们的私有数据。", name: "何径" },
      ] }] }), CONTRACT);
    const stars = result.spec.elements.filter((el) => el.type === "icon" && el.icon === "star");
    expect(stars.length).toBe(5);
    const avatars = result.spec.elements.filter((el) => el.type === "image" && el.circle);
    expect(avatars.length).toBe(1);
    expect(() => tree({ role: "评价", direction: "row", children: [{ type: "component", name: "quotes", items: [
      { text: "甲", name: "乙", rating: 6 }, { text: "丙", name: "丁" }] }] })).toThrow(/1~5/);
  });

  it("pricingTiers：featured 面板与实心按钮；featured 必填且越界拒绝", () => {
    const result = compileTree(tree({
      role: "定价", title: "套餐", direction: "row",
      children: [{ type: "component", name: "pricingTiers",
        tiers: [
          { name: "团队版", price: "¥198", unit: "/人/月", features: ["50 人以内", "社区支持"] },
          { name: "企业版", price: "¥398", unit: "/人/月", features: ["人数不限", "私有部署", "SLA"], cta: "选择企业版" },
        ], featured: 1 }] }), CONTRACT);
    // featured = 一块 ink 反白卡 + 强调色顶条 + 实心按钮；两档同一基线。
    const featuredCards = result.spec.elements.filter(
      (el) => el.type === "shape" && el.shape === "roundRect" && el.h > 100 && el.fill === CONTRACT.theme.colors.text,
    ) as { x: number; y: number; w: number; h: number }[];
    expect(featuredCards.length).toBe(1);
    const solids = result.spec.elements.filter((el) => el.type === "shape" && el.fill === CONTRACT.theme.colors.primary);
    expect(solids.length).toBeGreaterThanOrEqual(2); // 顶条 + 按钮
    const bars = result.spec.elements.filter((el) => el.type === "shape" && el.shape === "rect" && el.h === 4) as { x: number; w: number; y: number }[];
    expect(bars.length).toBe(1);
    expect(bars[0]!.x).toBeGreaterThanOrEqual(featuredCards[0]!.x); // 顶条覆盖卡顶（平铺时与卡同宽）
    // 两档文字都在页面上（非 featured 档平铺在纸面）。
    for (const name of ["团队版", "企业版"]) {
      expect(result.spec.elements.some((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === name))), name).toBe(true);
    }
    expect(() => tree({ role: "定价", direction: "row", children: [{ type: "component", name: "pricingTiers",
      tiers: [{ name: "甲", price: "1", features: ["a", "b"] }, { name: "乙", price: "2", features: ["a", "b"] }] }] })).toThrow(/featured/);
    expect(() => tree({ role: "定价", direction: "row", children: [{ type: "component", name: "pricingTiers",
      tiers: [{ name: "甲", price: "1", features: ["a", "b"] }, { name: "乙", price: "2", features: ["a", "b"] }], featured: 5 }] })).toThrow(/0~1/);
  });

  it("logoWall：文字字标带字距、图片灰度 contain；空槽拒绝", () => {
    const result = compileTree(tree({
      role: "客户", title: "他们都在用", direction: "row",
      children: [{ type: "component", name: "logoWall", logos: [
        { text: "OMNIA" }, { image: "https://example.com/l.png" }, { text: "北岭云" }, { text: "LUMEN+" },
      ] }] }), CONTRACT);
    const marks = result.spec.elements.filter((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.letterSpacing)));
    expect(marks.length).toBe(3);
    const logos = result.spec.elements.filter((el) => el.type === "image" && el.grayscale && el.fit === "contain");
    expect(logos.length).toBe(1);
    expect(() => tree({ role: "客户", direction: "row", children: [{ type: "component", name: "logoWall", logos: [
      { image: "https://example.com/l.png" }, {}, {}, {}] }] })).toThrow(/image 或 text/);
  });
});

describe("表格参数与 pointList（xPoint 嫁接）", () => {
  it("table header:false + topRule：账目式两列表——2px 墨线顶线、表格下移、首行按数据渲染", () => {
    const result = compileTree(tree({
      role: "data", title: "全年接待", direction: "column", children: [
        { type: "table", header: false, topRule: true, colWidths: [3, 2], rows: [
          ["入境过夜游客", "1308.20 万人次"],
          ["国内过夜游客", "7634.60 万人次"],
          ["旅游外汇收入", "110.67 亿美元"],
        ] },
      ],
    }), CONTRACT);
    expect(result.defects).toEqual([]);
    expect(result.stats.elements).toBe(3); // 标题带 + 顶线 + 表格
    const rule = result.spec.elements.find((el) => el.type === "shape") as { h: number; y: number; fill: string } | undefined;
    expect(rule).toBeDefined();
    expect(rule!.h).toBe(2);
    expect(rule!.fill).toBe(CONTRACT.theme.colors.text);
    const table = result.spec.elements.find((el) => el.type === "table") as unknown as {
      y: number;
      rows: { text: string; bold?: boolean; align?: string }[][];
    };
    expect(table.y).toBe(rule!.y + 10); // 顶线 2px + 让位 8px
    expect(table.rows[0]![0]).toEqual({ text: "入境过夜游客", bold: false, align: "left" });
  });

  it("topRule/header 缺省回归：默认表格无顶线形状、首行仍是表头", () => {
    const result = compileTree(tree({
      role: "data", direction: "column", children: [
        { type: "table", rows: [["指标", "数值"], ["游客", "1308.20"]] },
      ],
    }), CONTRACT);
    expect(result.spec.elements.filter((el) => el.type === "shape")).toHaveLength(0);
    const table = result.spec.elements.find((el) => el.type === "table") as unknown as {
      rows: { text: string; bold?: boolean }[][];
    };
    expect(table.rows[0]![0]!.bold).toBe(true);
  });

  it("header/topRule 非法值与 darkHeader 互斥在归一层拦下", () => {
    const base = { type: "table", header: false as const, rows: [["a", "1"], ["b", "2"]] };
    expect(() => tree({ role: "data", direction: "column", children: [{ ...base, header: true }] })).toThrow(/header 只接受 false/);
    expect(() => tree({ role: "data", direction: "column", children: [{ ...base, topRule: false }] })).toThrow(/topRule 只接受 true/);
    expect(() => tree({ role: "data", direction: "column", children: [
      { type: "table", header: false, style: "darkHeader", rows: [["a", "1"], ["b", "2"]] },
    ] })).toThrow(/darkHeader 样式需要表头/);
  });

  const POINT_ITEMS = [
    { label: "地标", body: "平安金融中心 592.5 米，为深圳第一高楼；市民中心呈「大鹏展翅」之势。" },
    { label: "山海", body: "梧桐山 943.7 米为深圳第一高峰；大梅沙 1.8 公里沙滩免费开放。" },
    { label: "人文", body: "世界之窗汇聚 130 余个微缩景观；莲花山公园立邓小平铜像。" },
  ];

  it("pointList numbered：衬线序号主色+字距标签+静音正文，条目间发丝线，墨迹不重叠", () => {
    const result = compileTree(tree({
      role: "content", title: "深圳三题", direction: "column", children: [
        { type: "component", name: "pointList", numbered: true, items: POINT_ITEMS },
      ],
    }), CONTRACT);
    expect(result.defects).toEqual([]);
    expect(measureDefects(result, CONTRACT)).toEqual([]);
    expect(result.stats.elements).toBe(1 + 3 * 3 + 2); // 标题带 + 每条(序号+标签+正文) + 2 发丝线
    const serial = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "01" && r.bold)),
    ) as TextElement | undefined;
    expect(serial).toBeDefined();
    expect(serial!.paragraphs[0]!.runs[0]!.color).toBe(CONTRACT.theme.colors.primary);
    const dividers = result.spec.elements.filter((el) => el.type === "shape" && el.h === 1);
    expect(dividers).toHaveLength(2);
    const boxes = inkBoxes(result.spec);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it("pointList 不带 numbered：无序号元素，每条仅标签+正文", () => {
    const result = compileTree(tree({
      role: "content", title: "要点", direction: "column", children: [
        { type: "component", name: "pointList", items: POINT_ITEMS },
      ],
    }), CONTRACT);
    expect(result.defects).toEqual([]);
    expect(result.stats.elements).toBe(1 + 3 * 2 + 2);
    expect(result.spec.elements.some((el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "01")))).toBe(false);
  });

  it("pointList 装不下报 overflow 缺陷并点名", () => {
    const longBody = { label: "要点", body: "这是一段很长的正文，用来撑爆窄区域的预算。".repeat(8) };
    const result = compileTree(tree({
      direction: "row", weights: [3, 1], children: [
        { type: "text", variant: "body", text: "占位" },
        { type: "component", name: "pointList", numbered: true, items: [longBody, longBody, longBody] },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /精简正文或减少条目/.test(d.detail))).toBe(true);
  });

  it("pointList 参数越界在归一层拦下", () => {
    const one = [{ label: "甲", body: "内容" }];
    const six = Array.from({ length: 6 }, () => ({ label: "甲", body: "内容" }));
    const base = { role: "content", direction: "column" };
    expect(() => tree({ ...base, children: [{ type: "component", name: "pointList", items: one }] })).toThrow(/items 必须是 2~5 项/);
    expect(() => tree({ ...base, children: [{ type: "component", name: "pointList", items: six }] })).toThrow(/items 必须是 2~5 项/);
    expect(() => tree({ ...base, children: [{ type: "component", name: "pointList", numbered: false, items: [...one, ...one] }] })).toThrow(/numbered 只接受 true/);
  });
});

describe("indexHeader 与 eraRail（fork 转正）", () => {
  it("indexHeader：衬线序号主色+标题+右侧小注，发丝线贴区域下缘", () => {
    const result = compileTree(tree({
      role: "content", title: "并列栏", direction: "row", children: [
        { direction: "column", weights: [0.32, 1], gapScale: 1.2, children: [
          { type: "component", name: "indexHeader", num: "壹", title: "茶之源", note: "起源" },
          { type: "text", variant: "body", text: "从战国遗存到三代饮法。" },
        ] },
        { direction: "column", weights: [0.32, 1], gapScale: 1.2, children: [
          { type: "component", name: "indexHeader", num: "贰", title: "茶之典" },
          { type: "text", variant: "body", text: "一部《茶经》写成了文明。" },
        ] },
      ],
    }), CONTRACT);
    expect(result.defects).toEqual([]);
    expect(measureDefects(result, CONTRACT)).toEqual([]);
    const headers = result.spec.elements.filter(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "壹" || r.text === "贰")),
    ) as TextElement[];
    expect(headers).toHaveLength(2);
    expect(headers[0]!.paragraphs[0]!.runs[0]!.color).toBe(CONTRACT.theme.colors.primary);
    const rules = result.spec.elements.filter((el) => el.type === "shape" && el.h === 2);
    expect(rules).toHaveLength(2);
    expect(new Set(rules.map((r) => (r as { y: number }).y)).size).toBe(1); // 两条 2px 墨线同一水平线
  });

  it("eraRail：脊线压顶+刻度+衬线年代+静音短注，highlight 条目主色", () => {
    const result = compileTree(tree({
      role: "content", title: "茶之远", direction: "column", children: [
        { type: "component", name: "eraRail", items: [
          { era: "唐代", note: "东传日韩" },
          { era: "北宋", note: "茶马贸易" },
          { era: "1610 年", note: "荷船抵欧" },
          { era: "1773 年", note: "倾茶事件" },
        ], highlight: 3 },
      ],
    }), CONTRACT);
    expect(result.defects).toEqual([]);
    expect(measureDefects(result, CONTRACT)).toEqual([]);
    // 脊线 1 + 每条(刻度+年代+短注)×4
    expect(result.stats.elements).toBe(1 + 1 + 4 * 3); // 标题带 + 脊线 + 每条 3 元素
    const hotTick = result.spec.elements.find(
      (el) => el.type === "shape" && (el as unknown as { h: number }).h >= 18 && el.fill === CONTRACT.theme.colors.primary,
    ) as unknown as { fill: string } | undefined;
    expect(hotTick).toBeDefined();
    expect(hotTick!.fill).toBe(CONTRACT.theme.colors.primary);
    const era = result.spec.elements.find(
      (el) => el.type === "text" && el.paragraphs.some((p) => p.runs.some((r) => r.text === "1773 年" && r.color === CONTRACT.theme.colors.primary)),
    );
    expect(era).toBeDefined();
  });

  it("eraRail 年代超 8 字、短注超 12 字在归一层拦下", () => {
    const base = { role: "content", direction: "column" };
    const items = [
      { era: "距今近 2500 年", note: "茶叶遗存" },
      { era: "西汉", note: "《僮约》茶市" },
      { era: "唐", note: "饮茶大行" },
    ];
    expect(() => tree({ ...base, children: [{ type: "component", name: "eraRail", items }] }))
      .toThrow(/era「距今近 2500 年」超 8 字/);
    expect(() => tree({ ...base, children: [{ type: "component", name: "eraRail", items: [
      { era: "战国早期", note: "这是一条非常非常长的短注早就超过十二个字了" },
      { era: "西汉", note: "《僮约》茶市" },
      { era: "唐", note: "饮茶大行" },
    ] }] })).toThrow(/note「[^」]+」超 12 字/);
    expect(() => tree({ ...base, children: [{ type: "component", name: "eraRail", items: [
      { era: "战国早期", note: "茶叶遗存" },
      { era: "西汉", note: "《僮约》茶市" },
      { era: "唐", note: "饮茶大行" },
    ], highlight: 9 }] })).toThrow(/highlight 必须是 0~2 的整数/);
  });

  it("indexHeader num 超 2 字在归一层拦下", () => {
    expect(() => tree({ role: "content", direction: "column", children: [
      { type: "component", name: "indexHeader", num: "第一栏", title: "栏目标题" },
    ] })).toThrow(/num 须为 1~2 字/);
  });

  it("timeline 年代超宽降档后仍放不下报缺陷", () => {
    const result = compileTree(tree({
      role: "content", direction: "row", weights: [1.6, 1], children: [
        { type: "text", variant: "body", text: "占位栏，压缩右侧年代轴的格宽。" },
        { type: "component", name: "timeline", items: [
          { label: "距今近两千五百年", text: "战国遗存" },
          { label: "距今更久远的年代", text: "更早的起点" },
          { label: "无法追溯的上古", text: "传说时代" },
        ] },
      ],
    }), CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects.some((d) => d.type === "overflow" && /统一短年代格式/.test(d.detail))).toBe(true);
  });
});
