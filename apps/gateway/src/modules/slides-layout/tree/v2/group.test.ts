import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { measureDefects } from "../measure.js";
import { contractFromStyleParams } from "../layout-contract.js";
import { treeSignature } from "../similarity.js";
import { visualRichnessIssues } from "./richness.js";

const STYLE = {
  spacing: { margin: 64, gutter: 24, cardPadding: 16, cornerRadius: 6 },
  typography: {
    typeScale: {
      display: 56, hero: 72, h1: 40, h2: 32, h3: 26, lead: 20, body: 16, label: 13, kicker: 12, caption: 10,
    },
  },
};
const CONTRACT = contractFromStyleParams(STYLE);

/** swiss 无硬约束：group 用例都在 swiss 页里跑，避免 composition 规则干扰。 */
function page(nodes: unknown[], role = "content") {
  return normalizeTree({ version: 2, role, composition: "swiss", nodes });
}

function compile(nodes: unknown[], role = "content") {
  return compileTree(page(nodes, role), CONTRACT);
}

const GROUP_SLOT = { col: [1, 12], row: [1, 8] } as const;
/** margin 64 → group 帧 1152×592（画布 1280×720）。 */
const GROUP_FRAME = { x: 64, y: 64, w: 1152, h: 592 };

function texts(result: ReturnType<typeof compile>) {
  return result.spec.elements.flatMap((element) => (element.type === "text" ? [element] : []));
}

describe("v2 group: 原生分区", () => {
  it("按 weights 切 row：两子节点宽度比 = 权重比", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row", weights: [2, 1],
        children: [
          { type: "text", token: "body", text: "左栏" },
          { type: "text", token: "body", text: "右栏" },
        ],
      },
    ]);
    const [left, right] = texts(result);
    expect(left && right).toBeTruthy();
    expect(left!.w / right!.w).toBeGreaterThan(1.9);
    expect(left!.w / right!.w).toBeLessThan(2.1);
    // 缝隙 = 主题 gutter(24) × gapScale(缺省 1)
    expect(right!.x).toBe(left!.x + left!.w + 24);
    expect(left!.x).toBe(GROUP_FRAME.x);
    expect(left!.w + 24 + right!.w).toBe(GROUP_FRAME.w);
  });

  it("缺省 weights 时均分，gapScale=0 时无缝隙", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "column", gapScale: 0,
        children: [
          { type: "text", token: "body", text: "上" },
          { type: "text", token: "body", text: "下" },
        ],
      },
    ]);
    const [top, bottom] = texts(result);
    expect(top!.h).toBe(bottom!.h);
    expect(bottom!.y).toBe(top!.y + top!.h);
  });

  it("overlay 子节点按 place 百分比换算到父帧内", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "overlay",
        children: [
          { type: "text", token: "h3", text: "左上", place: { x: 0, y: 0, w: 50, h: 50 } },
          { type: "shape", shape: "rect", fill: "#2F5BFF", place: { x: 50, y: 50, w: 50, h: 50 } },
        ],
      },
    ]);
    const text = texts(result)[0]!;
    expect(text).toMatchObject({ x: GROUP_FRAME.x, y: GROUP_FRAME.y, w: GROUP_FRAME.w / 2, h: GROUP_FRAME.h / 2 });
    const shape = result.spec.elements.find((element) => element.type === "shape")!;
    expect(shape).toMatchObject({
      x: GROUP_FRAME.x + GROUP_FRAME.w / 2,
      y: GROUP_FRAME.y + GROUP_FRAME.h / 2,
      w: GROUP_FRAME.w / 2,
      h: GROUP_FRAME.h / 2,
    });
  });

  it("pad 先内缩帧，panel 底板压在最底层", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row", pad: 16, panel: "tint",
        children: [{ type: "text", token: "body", text: "内容" }],
      },
    ]);
    const panel = result.spec.elements.find((element) => element.type === "shape")!;
    expect(panel).toMatchObject(GROUP_FRAME);
    const text = texts(result)[0]!;
    expect(text).toMatchObject({ x: GROUP_FRAME.x + 16, y: GROUP_FRAME.y + 16, w: GROUP_FRAME.w - 32, h: GROUP_FRAME.h - 32 });
    // panel 在 text 之前（子节点压在板上）
    expect(result.spec.elements.indexOf(panel)).toBeLessThan(result.spec.elements.indexOf(text));
  });

  it("justify=center 时整组下移一半空白（子区域划分不变）", () => {
    const children = [
      { type: "text", token: "body", text: "第一行" },
      { type: "text", token: "body", text: "第二行" },
    ];
    const start = compile([{ type: "group", slot: GROUP_SLOT, direction: "column", children }]);
    const centered = compile([{ type: "group", slot: GROUP_SLOT, direction: "column", justify: "center", children }]);
    const startTop = texts(start)[0]!.y;
    const centeredTop = texts(centered)[0]!.y;
    expect(startTop).toBe(GROUP_FRAME.y);
    expect(centeredTop).toBeGreaterThan(GROUP_FRAME.y + 100);
    // 平移量一致作用于整组：两个子节点的相对位移相同
    expect(centeredTop - startTop).toBe(texts(centered)[1]!.y - texts(start)[1]!.y);
    // 内容（而不是文字框：文字框本身是满子区域高、上对齐）仍在 panel 内
    expect(texts(centered).every((element) => element.y < GROUP_FRAME.y + GROUP_FRAME.h)).toBe(true);
  });

  it("group 套 group（深度 3）仍可编译", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row",
        children: [{
          type: "group", direction: "column",
          children: [{
            type: "group", direction: "row",
            children: [{ type: "text", token: "body", text: "最内层" }],
          }],
        }],
      },
    ]);
    expect(texts(result)).toHaveLength(1);
  });

  it("group 的 slot/bleed 在页面级照常生效", () => {
    const result = compile([
      {
        type: "group", slot: { col: [1, 6], row: [1, 4] }, direction: "row", panel: "outline",
        children: [{ type: "text", token: "body", text: "框内" }],
      },
    ]);
    const panel = result.spec.elements.find((element) => element.type === "shape")!;
    expect(panel.x).toBe(64);
    expect(panel.w).toBeLessThan(GROUP_FRAME.w);
  });
});

describe("v2 group: 非法输入", () => {
  it("拒收 v1 tree 字段", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, panel: "tint",
      tree: { direction: "row", children: [{ type: "text", variant: "body", text: "旧语法" }] },
    }])).toThrow(/group 不再接受 v1 树：把 tree 拆成 children 的 v2 节点，用 weight 表达比例/);
  });

  it("嵌套超过 3 层报错", () => {
    const leaf = { type: "text", token: "body", text: "x" };
    const depth3 = { type: "group", direction: "row", children: [leaf] };
    const depth2 = { type: "group", direction: "row", children: [depth3] };
    const depth1TooDeep = { type: "group", direction: "row", children: [depth2] };
    // 页面级 group(1) → 2 → 3 合法
    expect(() => page([{ type: "group", slot: GROUP_SLOT, direction: "row", children: [depth2] }])).not.toThrow();
    // 页面级 group(1) → 2 → 3 → 4 报错
    expect(() => page([{ type: "group", slot: GROUP_SLOT, direction: "row", children: [depth1TooDeep] }])).toThrow(/group 最多嵌套 3 层/);
  });

  it("子节点写 slot 报错", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row",
      children: [{ type: "text", token: "body", text: "x", slot: { col: [1, 2], row: [1, 1] } }],
    }])).toThrow(/slot 不能写/);
  });

  it("子节点写 bleed 报错（image 也不能外溢）", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row",
      children: [{ type: "image", url: "https://example.com/a.png", bleed: true }],
    }])).toThrow(/bleed 不能写/);
  });

  it("子节点不允许 connector", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "overlay",
      children: [{ type: "connector", from: { x: 0, y: 0 }, to: { x: 50, y: 50 }, place: { x: 0, y: 0, w: 50, h: 50 } }],
    }])).toThrow(/不允许 connector/);
  });

  it("weights 个数必须等于 children 数", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row", weights: [1, 1],
      children: [{ type: "text", token: "body", text: "只有一个" }],
    }])).toThrow(/weights 个数 2 必须等于 children 数 1/);
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row", weights: [0, 1],
      children: [{ type: "text", token: "body", text: "a" }, { type: "text", token: "body", text: "b" }],
    }])).toThrow(/weights\[0\] 必须是 0\.1~20 的数字/);
  });

  it("overlay / row / column 的专属字段各自拒收", () => {
    const children = [{ type: "text", token: "body", text: "x", place: { x: 0, y: 0, w: 100, h: 100 } }];
    // overlay 禁 weights/gapScale
    expect(() => page([{ type: "group", slot: GROUP_SLOT, direction: "overlay", weights: [1], children }]))
      .toThrow(/weights 不支持 overlay/);
    expect(() => page([{ type: "group", slot: GROUP_SLOT, direction: "overlay", gapScale: 1, children }]))
      .toThrow(/gapScale 不支持 overlay/);
    // overlay 子节点必须写 place
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "overlay",
      children: [{ type: "text", token: "body", text: "缺 place" }],
    }])).toThrow(/place 必填/);
    // row/column 子节点不许写 place
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row",
      children: [{ type: "text", token: "body", text: "x", place: { x: 0, y: 0, w: 100, h: 100 } }],
    }])).toThrow(/place 只用于 overlay/);
    // justify 只给 column
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "row", justify: "center",
      children: [{ type: "text", token: "body", text: "x" }],
    }])).toThrow(/justify 只用于 column/);
  });

  it("place 越界（x+w>100）报错", () => {
    expect(() => page([{
      type: "group", slot: GROUP_SLOT, direction: "overlay",
      children: [{ type: "text", token: "body", text: "x", place: { x: 60, y: 0, w: 50, h: 50 } }],
    }])).toThrow(/不得超过 100/);
  });

  it("递归节点总数仍受页面节点预算约束", () => {
    const leaf = { type: "text", token: "caption", text: "x" };
    const inner = { type: "group", direction: "row", children: Array.from({ length: 12 }, () => leaf) };
    const outer = Array.from({ length: 5 }, () => ({ type: "group", slot: GROUP_SLOT, direction: "row", children: [inner] }));
    // 5 × (1 group + 12 leaf + 1 group) = 70 > 64
    expect(() => page(outer)).toThrow(/节点总数 .*（含 group 子节点）超过 64/);
  });
});

describe("v2 group: richness 与签名", () => {
  it("group 内只有 text 不算视觉锚点；节点数递归统计", () => {
    const onlyText = page([
      { type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } },
      {
        type: "group", slot: { col: [1, 8], row: [3, 7] }, direction: "column",
        children: [
          { type: "text", token: "body", text: "一" },
          { type: "text", token: "body", text: "二" },
          { type: "text", token: "body", text: "三" },
        ],
      },
    ]).v2!;
    const issues = visualRichnessIssues(onlyText);
    expect(issues.some((issue) => issue.includes("缺少视觉锚点"))).toBe(true);
    // 1 标题 + 1 group + 3 子节点 = 5，递归统计后不再报“模块过少”
    expect(issues.some((issue) => issue.includes("模块过少"))).toBe(false);
  });

  it("group 内的 icon 算视觉锚点", () => {
    const tree = page([
      { type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } },
      { type: "text", token: "body", text: "正文", slot: { col: [1, 8], row: [3, 3] } },
      { type: "text", token: "caption", text: "来源", slot: { col: [8, 12], row: [8, 8] } },
      {
        type: "group", slot: { col: [1, 4], row: [4, 7] }, direction: "row",
        children: [{ type: "icon", name: "bolt" }],
      },
    ]).v2!;
    expect(visualRichnessIssues(tree)).toEqual([]);
  });

  it("两页只是 group 内部不同 → 签名不同", () => {
    const make = (childType: "text" | "icon") => page([
      { type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } },
      {
        type: "group", slot: { col: [1, 8], row: [3, 7] }, direction: "row",
        children: [childType === "text"
          ? { type: "text", token: "body", text: "文字" }
          : { type: "icon", name: "bolt" }],
      },
    ]);
    expect(treeSignature(make("text"))).not.toBe(treeSignature(make("icon")));
    expect(treeSignature(make("text"))).toContain("g:row:1");
  });
});

describe("v2 group: 统一权重规则（父 weights 优先，缺省从子节点 weight 推导）", () => {
  it("仅子节点 weight：row 按 weight 比例分宽", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row",
        children: [
          { type: "text", token: "body", text: "左", weight: 2 },
          { type: "text", token: "body", text: "右", weight: 1 },
        ],
      },
    ]);
    const [left, right] = texts(result);
    expect(left!.w / right!.w).toBeGreaterThan(1.9);
    expect(left!.w / right!.w).toBeLessThan(2.1);
    expect(right!.x).toBe(left!.x + left!.w + 24);
  });

  it("父 weights 与子 weight 同时存在：父级优先，子 weight 被忽略", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row", weights: [1, 1],
        children: [
          { type: "text", token: "body", text: "左", weight: 5 },
          { type: "text", token: "body", text: "右" },
        ],
      },
    ]);
    const [left, right] = texts(result);
    expect(left!.w).toBe(right!.w);
  });

  it("row/column 嵌套：外层 row 按父 weights 分宽，内层 column 按子 weight 分高", () => {
    const result = compile([
      {
        type: "group", slot: GROUP_SLOT, direction: "row", weights: [1, 2],
        children: [
          { type: "text", token: "body", text: "窄栏" },
          {
            type: "group", direction: "column",
            children: [
              { type: "text", token: "body", text: "上", weight: 1 },
              { type: "text", token: "body", text: "下", weight: 3 },
            ],
          },
        ],
      },
    ]);
    const [narrow, top, bottom] = texts(result);
    // 外层：usable = 1152 - 24 = 1128 → 376 / 752
    expect(narrow!.w).toBe(376);
    expect(top!.w).toBe(752);
    // 内层 column：usable = 592 - 16 = 576 → 144 / 432
    expect(top!.h).toBe(144);
    expect(bottom!.h).toBe(432);
    expect(bottom!.y).toBe(top!.y + top!.h + 16);
  });
});

describe("v2 text: fit=shrink 编译期缩字", () => {
  const BODY = (chars: number, fit?: "shrink"): Record<string, unknown> => ({
    type: "text", token: "body", text: "字".repeat(chars),
    slot: { col: [1, 3], row: [1, 4] },
    ...(fit ? { fit } : {}),
  });
  const allSizes = (result: ReturnType<typeof compile>): number[] =>
    result.spec.elements
      .flatMap((element) => (element.type === "text" ? element.paragraphs ?? [] : []))
      .flatMap((paragraph) => paragraph.runs.map((run) => run.sizePt ?? 12));

  it("无需缩字：fits 时不缩，字号原样", () => {
    const result = compile([BODY(10, "shrink")]);
    expect(allSizes(result)).toEqual([20]);
    expect(result.defects).toHaveLength(0);
  });

  it("15% 内可容纳：取能容纳的最大档，全部 run 同比例", () => {
    // 1.0 档 324px、0.95 档 307.8px 均超 288；0.9 档（18pt，8 行×32.4=259.2px）装下
    const result = compile([BODY(85, "shrink")]);
    expect(allSizes(result)).toEqual([18]);
    expect(measureDefects(result, CONTRACT).filter((defect) => defect.type === "overflow")).toHaveLength(0);
  });

  it("缩到 15% 仍溢出：按最小档落元素，缺陷照常上报", () => {
    const result = compile([BODY(300, "shrink")]);
    expect(allSizes(result)).toEqual([17]);
    const overflow = measureDefects(result, CONTRACT).find((defect) => defect.type === "overflow");
    expect(overflow).toBeTruthy();
  });

  it("场景字号下限：缩字不低于场景 floor（near 档 body 16 → 下限 14，不是 13）", () => {
    const near = contractFromStyleParams(STYLE, "reading");
    const tree = normalizeTree({
      version: 2, role: "content", composition: "swiss",
      nodes: [BODY(140, "shrink")],
    });
    const result = compileTree(tree, near);
    const sizes = result.spec.elements
      .flatMap((element) => (element.type === "text" ? element.paragraphs ?? [] : []))
      .flatMap((paragraph) => paragraph.runs.map((run) => run.sizePt ?? 12));
    expect(sizes).toEqual([14]);
  });

  it("混排：同一缩放比例作用于全部 run，字号比例与全文保留", () => {
    const result = compile([
      {
        type: "text", token: "body", fit: "shrink",
        slot: { col: [1, 3], row: [1, 8] },
        runs: [
          { text: "标".repeat(20), token: "h1" },
          { text: "正".repeat(50), token: "body" },
        ],
      },
    ]);
    // 1.0/0.95 档放不下，0.9 档（h1 36pt、body 18pt）装下：同一步、同一比例
    const sizes = allSizes(result);
    expect(sizes).toEqual([36, 18]);
    const text = result.spec.elements
      .flatMap((element) => (element.type === "text" ? element.paragraphs ?? [] : []))
      .flatMap((paragraph) => paragraph.runs.map((run) => run.text))
      .join("");
    expect(text).toBe("标".repeat(20) + "正".repeat(50));
    expect(result.defects.filter((defect) => defect.type === "overflow")).toHaveLength(0);
  });

  it("默认 fit=none 不缩：溢出保持原字号（现行为不变）", () => {
    const result = compile([BODY(300)]);
    expect(allSizes(result)).toEqual([20]);
    expect(measureDefects(result, CONTRACT).some((defect) => defect.type === "overflow")).toBe(true);
  });

  it("校验与落页同一实际字号：编译是纯函数，两次调用产物一致", () => {
    const tree = page([BODY(85, "shrink")]);
    const first = compileTree(tree, CONTRACT);
    const second = compileTree(tree, CONTRACT);
    expect(JSON.stringify(first.spec)).toBe(JSON.stringify(second.spec));
  });
});
