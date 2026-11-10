/**
 * 骨架（skeleton）：第二册的核心——把"这页怎么分区"从模型手里拿走。
 *
 * 一个骨架 = 语义槽位 + 参数档 + 容量上下限，**输出一页合法的 v2 页面**。
 * 模型只交内容（message / supporting / facts / data）与主角（emphasis），
 * 骨架由 `pickSkeleton()` 按 form × emphasis × 内容量打分选出，参数由内容量算。
 *
 * 三条硬规矩（写在这里是为了让后面加骨架的人不用重新想）：
 *   1. 一页一主角：每个骨架恰好一个主块，面积落在内容区的 30%~72%（`projected` 档）；
 *   2. 容量协商：内容装不下就整条退回 `rejected`（调用方写进讲稿），**绝不硬塞、绝不改页数**；
 *   3. 骨架不许自己决定字号/颜色：token 交给契约，色号一个都不写。
 */

import { CRAFT_BANDS } from "../../craft.js";
import type { V2Footer, V2Page } from "../v2/schema.js";

export type SkeletonEmphasis = "title" | "number" | "image" | "quote" | "chart" | "table";

/** 骨架能吃的内容。键名就是槽位名，多给的键会被忽略（且记进 ignored）。 */
export interface SkeletonContent {
  message?: string;
  supporting?: string[];
  facts?: Array<{ label?: string; value?: string; unit?: string; body?: string }>;
  quote?: { text: string; source?: string };
  /** 结构化条目：轨道/金字塔/漏斗/要点列表这类组件骨架吃它。 */
  items?: Array<{ label: string; text?: string; value?: string }>;
  /** 表格骨架吃它；columns 是表头。 */
  table?: { columns: string[]; rows: string[][] };
  /** 图片骨架吃它。 */
  image?: { url: string };
  footer?: string;
}

export interface SkeletonParams {
  /** 主次比例档（左右分栏时用）。 */
  split?: "5:7" | "6:6" | "7:5";
  align?: "left" | "center";
  density?: "airy" | "standard" | "dense";
}

export interface SkeletonBuild {
  page: V2Page;
  /** 装不下、被退回调用方写进讲稿的条目。 */
  rejected: string[];
}

export interface SkeletonDef {
  id: string;
  form: string;
  /** 这个骨架能承载的主角类型。 */
  emphasis: ReadonlyArray<SkeletonEmphasis>;
  /** 支撑句容量（含）。 */
  capacity: { supportMin: number; supportMax: number };
  /** 一句话说明，进画廊 HTML。 */
  note: string;
  /** 默认组件（骨架替模型选，模型不必知道组件目录）。 */
  preferredComponents?: ReadonlyArray<string>;
  build(content: SkeletonContent, params?: SkeletonParams): SkeletonBuild;
}

type Slot = { col: [number, number]; row: [number, number] };

function slot(c0: number, c1: number, r0: number, r1: number): Slot {
  return { col: [c0, c1], row: [r0, r1] };
}

/** 密度 → 缝隙/内边距倍率：airy 更松、dense 更紧。骨架必须真的消费它。 */
function gapFor(params: SkeletonParams, base: number): number {
  if (params.density === "airy") return base * 1.6;
  if (params.density === "dense") return base * 0.7;
  return base;
}

function footerOf(content: SkeletonContent): V2Footer {
  return content.footer ? { left: content.footer, pageNumbers: true, tone: "muted" } : { pageNumbers: true, tone: "muted" };
}

function page(role: string, composition: V2Page["composition"], nodes: unknown[], content: SkeletonContent): V2Page {
  return {
    version: 2,
    role,
    composition,
    nodes: nodes as V2Page["nodes"],
    footer: footerOf(content),
  };
}

/** 取前 n 条支撑句，其余退回。 */
function take(content: SkeletonContent, max: number): { taken: string[]; rejected: string[] } {
  const list = (content.supporting ?? []).map((item) => item.trim()).filter(Boolean);
  return { taken: list.slice(0, max), rejected: list.slice(max) };
}

/* ------------------------------------------------------------------ */
/* 骨架实现                                                            */
/* ------------------------------------------------------------------ */

const singleFactNumber: SkeletonDef = {
  id: "single-fact.number.hero-left",
  form: "single-fact",
  emphasis: ["number", "title"],
  capacity: { supportMin: 0, supportMax: 2 },
  note: "一个大数字占左侧 58% 宽，底下接一句主张；右侧只放至多两条短支撑。不做并列块。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 2);
    const fact = content.facts?.[0];
    // 单个数字不能用 stats 节点（它要求 2~4 条），用 display token 拼「数字 + 单位」。
    const heroValue = fact?.value;
    const hero: unknown[] = heroValue
      ? [
          {
            type: "text",
            token: "display",
            runs: [
              { text: heroValue, token: "display" as const, bold: true },
              ...(fact?.unit ? [{ text: ` ${fact.unit}`, token: "h2" as const }] : []),
            ],
            slot: slot(1, 9, 1, 4),
            valign: "bottom",
          },
          ...(fact?.label ? [{ type: "text", token: "label", text: fact.label, tone: "muted", slot: slot(1, 9, 5, 5) }] : []),
        ]
      : [{ type: "text", token: "display", text: fact?.body ?? content.message ?? "", slot: slot(1, 9, 1, 4), valign: "bottom" }];
    const nodes: unknown[] = [
      ...hero,
      ...(content.message ? [{ type: "text", token: "h2", text: content.message, slot: slot(1, 9, 6, 7) }] : []),
    ];
    if (taken.length > 0) {
      nodes.push({
        type: "group",
        direction: "column",
        justify: "center",
        gapScale: gapFor(params, 2),
        slot: slot(10, 12, 1, 5),
        children: taken.map((text) => ({ type: "text", token: "body", text, tone: "muted", valign: "top" })),
      });
    }
    return { page: page("data", "swiss", nodes, content), rejected };
  },
};

const contrastSplit: SkeletonDef = {
  id: "contrast.title.two-column-split",
  form: "contrast",
  emphasis: ["title", "number"],
  capacity: { supportMin: 2, supportMax: 2 },
  note: "两方对照：左方与右方各占一栏，各自有栏头与一句正文，中缝留白分开；比例按 split 档（5:7 / 6:6 / 7:5）。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 2);
    const [left, right] = taken;
    const weights = params.split === "5:7" ? [5, 7] : params.split === "7:5" ? [7, 5] : [6, 6];
    const sides = content.facts && content.facts.length >= 2 ? content.facts.slice(0, 2) : [];
    const children = [left, right].map((text, index) => {
      const side = sides[index];
      return {
        type: "group",
        direction: "column",
        justify: "start",
        gapScale: 1,
        ...(side?.label ? { weights: [1, 8] } : {}),
        children: [
          ...(side?.label ? [{ type: "text", token: "kicker" as const, text: side.label, tone: "muted" }] : []),
          { type: "text", token: "body" as const, text: text ?? "", valign: "top" },
        ],
      };
    });
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
      { type: "group", direction: "row", weights, gapScale: gapFor(params, 3), slot: slot(1, 12, 4, 8), children },
    ];
    return { page: page("content", "swiss", nodes, content), rejected };
  },
};

const sequenceTrack: SkeletonDef = {
  id: "sequence.title.horizontal-track",
  form: "sequence",
  emphasis: ["title"],
  capacity: { supportMin: 2, supportMax: 4 },
  note: "横向轨道：主张在上，下面 2~4 个节点等权排开，每个节点一个栏头 + 一句正文；不允许变成等权卡片墙。",
  preferredComponents: ["steps", "chevron", "timeline"],
  build(content, params = {}) {
    const { taken, rejected } = take(content, 4);
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
      {
        type: "group",
        direction: "row",
        gapScale: gapFor(params, 2),
        slot: slot(1, 12, 4, 8),
        children: taken.map((text, index) => ({
          type: "group",
          direction: "column",
          justify: "start",
          gapScale: 1,
          weights: [1, 8],
          children: [
            { type: "text", token: "kicker", text: `0${index + 1}`, tone: "muted" },
            { type: "text", token: "body", text, valign: "top" },
          ],
        })),
      },
    ];
    return { page: page("flow", "swiss", nodes, content), rejected };
  },
};

const breakdownGrid: SkeletonDef = {
  id: "breakdown.title.grid-2x2",
  form: "breakdown",
  emphasis: ["title", "number"],
  capacity: { supportMin: 3, supportMax: 4 },
  note: "四宫格拆解：主张在上，三到四块内容排成 2×2（不足四块时最后一格留白，不拉伸填满）。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 3);
    const cells = taken.map((text) => ({
      type: "group",
      direction: "column",
      justify: "start",
      gapScale: 1,
      children: [{ type: "text", token: "body", text, valign: "top" }],
    }));
    if (cells.length === 4) {
      return {
        page: page("content", "swiss", [
          ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
          {
            type: "group",
            direction: "row",
            gapScale: gapFor(params, 2),
            slot: slot(1, 12, 4, 8),
            children: [
              { type: "group", direction: "column", gapScale: gapFor(params, 2), children: cells.slice(0, 2) },
              { type: "group", direction: "column", gapScale: gapFor(params, 2), children: cells.slice(2, 4) },
            ],
          },
        ], content),
        rejected,
      };
    }
    return {
      page: page("content", "swiss", [
        ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
        { type: "group", direction: "row", gapScale: gapFor(params, 2), slot: slot(1, 12, 4, 8), children: cells },
      ], content),
      rejected,
    };
  },
};

const quoteCenter: SkeletonDef = {
  id: "quotation.quote.center",
  form: "quotation",
  emphasis: ["quote"],
  capacity: { supportMin: 0, supportMax: 0 },
  note: "大面积留白 + 一句原话（hero 字号，折成两行 ≈26 字以内）+ 署名压在下缘；不配并列块，不配图表。",
  build(content, params = {}) {
    const text = content.quote?.text ?? content.message ?? "";
    const nodes: unknown[] = [
      { type: "text", token: "hero", text, align: params.align ?? "left", valign: "middle", slot: slot(2, 11, 2, 6) },
      ...(content.quote?.source
        ? [{ type: "text", token: "kicker", text: `—— ${content.quote.source}`, tone: "muted", slot: slot(2, 11, 7, 8) }]
        : []),
    ];
    return { page: page("content", "swiss", nodes, content), rejected: [] };
  },
};


const claimOnly: SkeletonDef = {
  id: "single-fact.title.claim-only",
  form: "single-fact",
  emphasis: ["title"],
  capacity: { supportMin: 0, supportMax: 1 },
  note: "没有数字时：一句主张用 display 占上半页，最多一条支撑压在下缘；禁并列块、禁列表。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 1);
    const nodes: unknown[] = [
      { type: "text", token: "display", text: content.message ?? "", valign: "bottom", slot: slot(1, 11, 2, 5) },
      ...(taken.length > 0
        ? [{ type: "text", token: "lead", text: taken[0]!, tone: "muted", slot: slot(1, 11, 6, 7) }]
        : []),
    ];
    return { page: page("content", "poster", nodes, content), rejected };
  },
};

const beforeAfterRail: SkeletonDef = {
  id: "contrast.title.before-after-rail",
  form: "contrast",
  emphasis: ["title"],
  capacity: { supportMin: 2, supportMax: 2 },
  note: "对照带中缝：两栏之间立一条竖直发丝线，左=之前/问题，右=之后/解法；栏头用 kicker。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 2);
    const labels = content.facts && content.facts.length >= 2 ? content.facts.slice(0, 2) : [];
    const column = (text: string | undefined, label: string | undefined) => ({
      type: "group",
      direction: "column",
      justify: "start",
      gapScale: 1,
      ...(label ? { weights: [1, 8] } : {}),
      children: [
        ...(label ? [{ type: "text", token: "kicker" as const, text: label, tone: "muted" }] : []),
        { type: "text", token: "body" as const, text: text ?? "", valign: "top" },
      ],
    });
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
      // 竖线立在版心左缘做对照引导线：放中缝会压到左栏文字。
      { type: "shape", shape: "line", tone: "divider", slot: slot(1, 1, 4, 8) },
      { type: "group", direction: "row", weights: [1, 1], gapScale: gapFor(params, 4), slot: slot(1, 12, 4, 7), children: [
        column(taken[0], labels[0]?.label),
        column(taken[1], labels[1]?.label),
      ] },
    ];
    return { page: page("content", "swiss", nodes, content), rejected };
  },
};

const verticalLadder: SkeletonDef = {
  id: "sequence.title.vertical-ladder",
  form: "sequence",
  emphasis: ["title"],
  capacity: { supportMin: 3, supportMax: 4 },
  note: "纵向阶梯：每个节点一行，序号在左、正文在右；行高按内容，不做等分卡片。",
  preferredComponents: ["timeline", "steps"],
  build(content, params = {}) {
    const { taken, rejected } = take(content, 4);
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
      {
        type: "group",
        direction: "column",
        gapScale: gapFor(params, 2),
        slot: slot(1, 12, 4, 8),
        children: taken.map((text, index) => ({
          type: "group",
          direction: "row",
          weights: [1, 10],
          children: [
            { type: "text", token: "kicker", text: `0${index + 1}`, tone: "muted" },
            { type: "text", token: "body", text, valign: "top" },
          ],
        })),
      },
    ];
    return { page: page("flow", "swiss", nodes, content), rejected };
  },
};

/** 用组件而不是自己摆格子：这就是"骨架替模型选高级组件"的意思。 */
function componentSkeleton(spec: {
  id: string;
  form: string;
  emphasis: SkeletonEmphasis[];
  capacity: { supportMin: number; supportMax: number };
  note: string;
  name: string;
  payload: (items: NonNullable<SkeletonContent["items"]>) => Record<string, unknown>;
  favored: string[];
  /** 组件自身的条目下限（组件的 normalize 会拒），不够就不上组件。 */
  minItems: number;
}): SkeletonDef {
  return {
    id: spec.id,
    form: spec.form,
    emphasis: [...spec.emphasis],
    capacity: spec.capacity,
    note: spec.note,
    preferredComponents: spec.favored,
    build(content, params = {}) {
      const source = content.items && content.items.length > 0
        ? content.items
        : (content.supporting ?? []).map((text) => ({ label: text, text }));
      const items = source.slice(0, spec.capacity.supportMax);
      const rejected = source.slice(spec.capacity.supportMax).map((item) => item.label);
      if (items.length < spec.minItems) {
        // 条目不够就不硬上组件（timeline 要 3 条起），退化成"标签+正文"的纵列。
        const fallback = items.length > 0 ? items : [{ label: content.message ?? "", text: content.message ?? "" }];
        return {
          page: page("content", "swiss", [
            ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
            {
              type: "group",
              direction: "column",
              gapScale: gapFor(params, 2),
              slot: slot(1, 12, 4, 8),
              children: fallback.map((item) => ({
                type: "group",
                direction: "row",
                weights: [1, 6],
                children: [
                  { type: "text", token: "kicker", text: item.label, tone: "muted" },
                  { type: "text", token: "body", text: item.text ?? item.label, valign: "top" },
                ],
              })),
            },
          ], content),
          rejected: [...rejected, `${spec.name} 条目不足（需 ≥${spec.minItems}）`],
        };
      }
      const nodes: unknown[] = [
        ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
        {
          type: "component",
          name: spec.name,
          ...spec.payload(items),
          ...(params.density ? { style: { density: params.density } } : {}),
          slot: slot(1, 12, 3, 8),
        },
      ];
      return { page: page("content", "swiss", nodes, content), rejected };
    },
  };
}

const hierarchyPyramid = componentSkeleton({
  id: "hierarchy.title.pyramid",
  form: "hierarchy",
  emphasis: ["title"],
  capacity: { supportMin: 3, supportMax: 5 },
  note: "层级用金字塔组件：三层，上窄下宽；每层一个标题（≤16 字），可选一句注解。",
  name: "pyramid",
  favored: ["pyramid"],
  minItems: 3,
  payload: (items) => ({
    form: "outline",
    items: items.map((item) => ({ title: item.label.slice(0, 16), ...(item.text ? { text: item.text.slice(0, 40) } : {}) })),
  }),
});

const breakdownPointList = componentSkeleton({
  id: "breakdown.title.point-list",
  form: "breakdown",
  emphasis: ["title"],
  capacity: { supportMin: 2, supportMax: 5 },
  note: "要点列表组件（衬线序号）：三条左右、每条一句；比表格轻，比卡片墙克制。",
  name: "pointList",
  favored: ["pointList"],
  minItems: 2,
  payload: (items) => ({
    numbered: true,
    items: items.map((item, index) => ({ label: (item.label || `0${index + 1}`).slice(0, 12), body: (item.text ?? item.label).slice(0, 140) })),
  }),
});

const sequenceTimeline = componentSkeleton({
  id: "sequence.title.timeline-band",
  form: "sequence",
  emphasis: ["title"],
  capacity: { supportMin: 3, supportMax: 5 },
  note: "时间线组件（横向）：三到五个节点挂在一条轨道上，节点=短标签+一句说明。",
  name: "timeline",
  favored: ["timeline"],
  minItems: 3,
  payload: (items) => ({
    items: items.map((item) => ({ label: item.label.slice(0, 24), text: (item.text ?? item.label).slice(0, 80) })),
  }),
});

const tableWithConclusion: SkeletonDef = {
  id: "table.table.with-conclusion",
  form: "table",
  emphasis: ["table"],
  capacity: { supportMin: 1, supportMax: 1 },
  note: "表格占版心主体，标题右侧必带一句结论（不许表格孤零零居中）；结论装不下就退回。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 1);
    const table = content.table;
    if (!table) {
      // 没有表就不画表：退回"主张 + 一句结论"，把缺失原因交给调用方补数据。
      return {
        page: page("table", "swiss", [
          { type: "text", token: "h1", text: content.message ?? "", slot: slot(1, 12, 1, 3) },
          { type: "text", token: "body", text: taken[0] ?? "（缺少表格数据）", tone: "muted", slot: slot(1, 12, 4, 5) },
        ], content),
        rejected: [...rejected, "缺 table"],
      };
    }
    const rows: unknown[] = [
      table.columns.map((text) => ({ text, bold: true, align: "left" })),
      ...table.rows.map((row) => row.map((text) => ({ text, align: "left" }))),
    ];
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 8, 1, 2) }] : []),
      ...(taken.length > 0 ? [{ type: "text", token: "lead", text: taken[0]!, tone: "muted", slot: slot(9, 12, 1, 2) }] : []),
      { type: "table", header: true, style: "outline", rows, slot: slot(1, 12, 3, 7) },
    ];
    return { page: page("table", "swiss", nodes, content), rejected };
  },
};

const tableFullWidth: SkeletonDef = {
  id: "table.table.full-width",
  form: "table",
  emphasis: ["table"],
  capacity: { supportMin: 0, supportMax: 1 },
  note: "满宽表：列多（≥4 列）时用，表头分区色、隔行浅底；不塞结论也不居中留白。",
  build(content) {
    const table = content.table;
    if (!table) {
      return {
        page: page("table", "swiss", [{ type: "text", token: "h1", text: content.message ?? "", slot: slot(1, 12, 1, 3) }], content),
        rejected: ["缺 table"],
      };
    }
    const nodes: unknown[] = [
      ...(content.message ? [{ type: "text", token: "h1", text: content.message, slot: slot(1, 12, 1, 2) }] : []),
      {
        type: "table",
        header: true,
        style: "banded",
        zebra: true,
        rows: [table.columns.map((text) => ({ text, bold: true })), ...table.rows.map((row) => row.map((text) => ({ text })))],
        slot: slot(1, 12, 3, 7),
      },
    ];
    return { page: page("table", "swiss", nodes, content), rejected: [] };
  },
};

const lightPage: SkeletonDef = {
  id: "light-page.title.center",
  form: "light-page",
  emphasis: ["title"],
  capacity: { supportMin: 0, supportMax: 1 },
  note: "过渡/收尾：一句话居中（h1），其余全留白；不为了填版面加要点。",
  build(content, params = {}) {
    const { taken, rejected } = take(content, 1);
    const nodes: unknown[] = [
      {
        type: "group",
        direction: "column",
        justify: "center",
        gapScale: 2,
        slot: slot(2, 11, 3, 7),
        children: [
          { type: "text", token: "h1", text: content.message ?? "", align: params.align ?? "center" },
          ...(taken.length > 0 ? [{ type: "text", token: "body", text: taken[0]!, tone: "muted", align: params.align ?? "center" }] : []),
        ],
      },
    ];
    return { page: page("content", "swiss", nodes, content), rejected };
  },
};

const quoteOffsetRule: SkeletonDef = {
  id: "quotation.quote.offset-rule",
  form: "quotation",
  emphasis: ["quote"],
  capacity: { supportMin: 0, supportMax: 0 },
  note: "引文偏置版：一条竖线立在左侧，原话右移贴线，署名在下方；比居中版更有版面感。",
  build(content) {
    const nodes: unknown[] = [
      { type: "shape", shape: "line", tone: "accent", slot: slot(3, 3, 3, 6) },
      { type: "text", token: "hero", text: content.quote?.text ?? content.message ?? "", slot: slot(4, 11, 3, 6), valign: "middle" },
      ...(content.quote?.source
        ? [{ type: "text", token: "kicker", text: `—— ${content.quote.source}`, tone: "muted", slot: slot(4, 11, 7, 8) }]
        : []),
    ];
    return { page: page("content", "swiss", nodes, content), rejected: [] };
  },
};

export const SKELETONS: ReadonlyArray<SkeletonDef> = [
  singleFactNumber,
  claimOnly,
  contrastSplit,
  beforeAfterRail,
  sequenceTrack,
  verticalLadder,
  sequenceTimeline,
  breakdownGrid,
  breakdownPointList,
  hierarchyPyramid,
  tableWithConclusion,
  tableFullWidth,
  quoteCenter,
  quoteOffsetRule,
  lightPage,
];

export function skeletonById(id: string): SkeletonDef | undefined {
  return SKELETONS.find((skeleton) => skeleton.id === id);
}

/* ------------------------------------------------------------------ */
/* 选骨架（确定性打分，同分按 id 字典序）                                */
/* ------------------------------------------------------------------ */

export interface PickSkeletonInput {
  form: string;
  emphasis?: SkeletonEmphasis;
  /** 这页要放的支撑条目数。 */
  units: number;
  /** 前两页用过的骨架 id（顺序：越靠后越近）。 */
  recent?: ReadonlyArray<string | undefined>;
}

export interface PickSkeletonResult {
  skeleton: SkeletonDef;
  score: number;
  /** 全部候选与得分，便于解释"为什么选它"。 */
  candidates: Array<{ id: string; score: number; fits: boolean }>;
}

/**
 * 打分口径（与方案 §8 一致）：
 *   +3 容量匹配 / −100 容量装不下（硬不通） / +2 主角命中 / +1 形态命中
 *   +1 与上一页不同骨架 / −5 与上两页同骨架 / −2 与上一页同骨架同比例档
 */
export function pickSkeleton(input: PickSkeletonInput): PickSkeletonResult {
  const recent = input.recent ?? [];
  const [last, before] = [recent[recent.length - 1], recent[recent.length - 2]];
  const pool = SKELETONS.filter((skeleton) => skeleton.form === input.form);
  const usable = pool.length > 0 ? pool : SKELETONS;

  const scored = usable.map((skeleton) => {
    const fits = input.units >= skeleton.capacity.supportMin && input.units <= skeleton.capacity.supportMax;
    let score = fits ? 3 : -100;
    if (input.emphasis && skeleton.emphasis.includes(input.emphasis)) score += 2;
    if (last && last !== skeleton.id) score += 1;
    if (last === skeleton.id && before === skeleton.id) score -= 5;
    else if (last === skeleton.id) score -= 2;
    return { id: skeleton.id, score, fits, skeleton };
  });

  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const winner = scored[0]!;
  return {
    skeleton: winner.skeleton,
    score: winner.score,
    candidates: scored.map(({ id, score, fits }) => ({ id, score, fits })),
  };
}

/** 结构档里投影档的主角面积区间，骨架实现用它做自检。 */
export const SKELETON_HERO_BAND = CRAFT_BANDS.projected.heroAreaRatio;
