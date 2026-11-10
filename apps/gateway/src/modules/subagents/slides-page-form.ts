/**
 * 内容形态（page form）：大纲每页"靠什么证据成立"的封闭词表，替代原来的版式六选一。
 *
 * 为什么要有这一层：版式名（immersive/editorial/…）是对审美的偏好，没有客观对错，
 * 模型只能按训练频率猜，于是收敛到最通用、最没特点的那个。内容形态（单一事实/
 * 两方对照/一串先后…）是对内容的判断，对错可查、可打回重写。
 *
 * 本模块是唯一真源：形态的取值、单元数范围、预算系数、骨架意图、引擎构图推导都在这里。
 * 大纲只声明形态，版式由 deriveComposition/deriveSkeleton 决定。
 *
 * 方案正文见 docs/slides-storyboard-form-plan.zh-CN.md；
 * 字数预算系数化见 docs/slides-quality-batch1-plan.zh-CN.md。
 */

import { proseBudgetBaseForDensity, type SceneDensity } from "../slides-layout/scene.js";

/** 引擎构图（v2 的 composition）：只决定 validate 检查哪组硬约束，不决定几何。 */
export type EngineComposition = "immersive" | "hero-data" | "editorial" | "swiss" | "poster" | "chapter";

/**
 * 九类内容形态。判定条件必须能被校验器判定，不能靠口味——
 * 这是这个方案成立的前提：形态有客观对错，版式没有。
 */
export const PAGE_FORMS = [
  "single-fact",
  "contrast",
  "sequence",
  "hierarchy",
  "breakdown",
  "image-led",
  "quotation",
  "table",
  "light-page",
] as const;

export type PageForm = (typeof PAGE_FORMS)[number];

/** 全册分量：替代原来"相邻页版式不得相同"的弱约束，用于节奏曲线校验。 */
export const PAGE_WEIGHTS = ["light", "medium", "heavy"] as const;
export type PageWeight = (typeof PAGE_WEIGHTS)[number];

export interface PageFormSpec {
  /** 中文名，给人看与给 agent 看用同一套词。 */
  label: string;
  /** 这页允许的单元数（对照的"方"、序列的"步"、拆解的"块"）。table 用行数。 */
  units: readonly [number, number];
  /** copy.facts 上限。按形态给，因为全局 3 条会卡死序列页。 */
  factsMax: number;
  /** 页面叙事文案预算（message + supporting + quote）。 */
  proseCoefficient: number;
  /** 形态判定条件：写给人看，也给声明义务校验用。 */
  when: string;
  /** 骨架意图：交给 layouter 的几何指令，不是版式名。 */
  skeleton: string;
}

export const PAGE_FORM_SPEC: Record<PageForm, PageFormSpec> = {
  "single-fact": {
    label: "单一事实",
    units: [1, 1],
    factsMax: 2,
    proseCoefficient: 0.8,
    when: "只有 1 个数字或 1 个结论要成立，没有并列、没有先后。",
    skeleton: "一个大数字或一句结论占主角（hero 字号），旁边最多两条极小注脚；不要并列块，不要列表。",
  },
  contrast: {
    label: "两方对照",
    units: [2, 4],
    factsMax: 4,
    proseCoefficient: 1.2,
    when: "有 2 方以上互相对立的属性，能说清「一边是什么、另一边是什么」。",
    skeleton: "两块并置，权重 1.4:1（有重点方时）或 1:1；中缝用细分隔线或留白分开；两块各自有栏头。",
  },
  sequence: {
    label: "一串先后",
    units: [3, 5],
    factsMax: 5,
    proseCoefficient: 1.3,
    when: "单元之间有先后、因果或阶段关系，顺序不可调换。",
    skeleton: "一条横向轨道串起 3~5 个节点（或纵向阶梯），每个节点一个短标签；不要让单元变成等权卡片。",
  },
  hierarchy: {
    label: "逐层拆解",
    units: [3, 5],
    factsMax: 5,
    proseCoefficient: 1.3,
    when: "单元之间有层级或包含关系：上一层由下层构成，或从粗到细。",
    skeleton: "逐层加宽或逐层缩进，每层的宽度/缩进差要看得出来；不要做成等分网格。",
  },
  breakdown: {
    label: "并列拆解",
    units: [3, 4],
    factsMax: 4,
    proseCoefficient: 1.2,
    when: "3~4 个并列等权单元，单元之间没有先后也没有层级。",
    skeleton: "并列块，但不要等宽：至少一块明显更大；块之间用间距或细线分开，不要用同样的卡面堆 3~4 张。",
  },
  "image-led": {
    label: "图为主视觉",
    units: [1, 2],
    factsMax: 2,
    proseCoefficient: 0.6,
    when: "页面主体是一个画面，文字只做结论和注释。图从哪来（现成素材还是生成）不影响这个判定。",
    skeleton: "图片出血到页边（至少一侧）或占版心一半，按本册明暗与色系统一处理；文字压在图上要加 60% 以上深色遮罩，控制在两行以内。",
  },
  quotation: {
    label: "原文引用",
    units: [1, 1],
    factsMax: 1,
    proseCoefficient: 0.8,
    when: "必须保留原话的引用，改一个字就不成立。",
    skeleton: "大面积留白 + 一行（至多两句）原话，用 display 字号；署名小字压在下缘；不要配并列块或图表。",
  },
  table: {
    label: "对照表",
    units: [3, 8],
    factsMax: 3,
    proseCoefficient: 0.9,
    when: "≥3 行的对照表（参数表、成本表、竞品表、财务表）。units 填行数。",
    skeleton: "表格占版心主体，列宽按内容分配不等宽；标题右侧补一个结论数字或一句结论，避免表格孤零零居中。",
  },
  "light-page": {
    label: "轻页",
    units: [1, 1],
    factsMax: 0,
    proseCoefficient: 0.5,
    when: "内容量本来就少：封面、章节分隔、收尾、金句。它不是「写不出结构」的出口。",
    skeleton: "一句话（display 字号）+ 大留白 + 满版底色，最多一个小色块；不要为了填版面加要点列表。",
  },
};

const ENGINE_COMPOSITIONS: readonly EngineComposition[] = [
  "immersive", "hero-data", "editorial", "swiss", "poster", "chapter",
];

export function isPageForm(value: unknown): value is PageForm {
  return typeof value === "string" && (PAGE_FORMS as readonly string[]).includes(value);
}

export function isPageWeight(value: unknown): value is PageWeight {
  return typeof value === "string" && (PAGE_WEIGHTS as readonly string[]).includes(value);
}

export function formSpec(form: PageForm): PageFormSpec {
  return PAGE_FORM_SPEC[form];
}

/** 单元数是否落在形态的允许区间。 */
export function unitsValid(form: PageForm, units: number): boolean {
  const [min, max] = PAGE_FORM_SPEC[form].units;
  return Number.isInteger(units) && units >= min && units <= max;
}

/**
 * 形态 + 图片条件 → 引擎构图。
 *
 * 只推能保证满足硬约束的构图（immersive 要出血图、editorial 要图 + h1/h2、
 * hero-data 要 hero 字或 chart、poster/chapter 要 display）。推不出的落到 swiss——
 * 它在本方案里不表示"等分网格"，只表示"引擎没有额外硬约束"，几何由 skeleton 决定。
 * 注意：swiss 是"没有图可用"这个事实推出来的结果，不是任何页面的兜底选项。
 */
export function deriveComposition(
  form: PageForm,
  options: { hasImage?: boolean; role?: string; hasNumber?: boolean } = {},
): EngineComposition {
  const hasImage = options.hasImage === true;
  switch (form) {
    case "image-led":
      // immersive 的硬约束是「至少一个出血图」。图被丢弃或素材缺失时不能推成 immersive，
      // 退回 poster（靠 display 撑住整页），否则整页会被 validate 拒收。
      return hasImage ? "immersive" : "poster";
    case "quotation":
      return "poster";
    case "single-fact":
      return "hero-data";
    case "light-page":
      return options.role === "section" ? "chapter" : "poster";
    case "contrast":
    case "sequence":
    case "hierarchy":
    case "breakdown":
      // 有图才能走 editorial（硬约束要图 + h1/h2）；没图只能自由排。
      return hasImage ? "editorial" : "swiss";
    case "table":
      // 表格页给不出 hero 就没有 hero-data 的硬约束，走自由排。
      return "swiss";
    default:
      return "swiss";
  }
}

/** 形态 → 骨架意图（交给 layouter 的几何指令；单元数不同时补一句数量）。 */
export function deriveSkeleton(form: PageForm, units?: number): string {
  const spec = PAGE_FORM_SPEC[form];
  const count = typeof units === "number" && Number.isFinite(units) ? `本页 ${units} 个单元。` : "";
  return `${spec.label}：${spec.skeleton}${count}`;
}

/**
 * 形态 → 字数**系数**（不是绝对值）。绝对值 = 场景密度基准 × 本系数。
 *
 * 为什么改成系数：字号由场景（观看距离）决定，字数由场景（信息密度）决定，
 * 两者必须联动——投影档字号变大 25%，同样字数就装不下。系数化之后
 * 「把字放大」与「把字减少」是同一个动作的两面，不会各自漂移。
 */
export function proseCoefficientForForm(form: PageForm): number {
  return PAGE_FORM_SPEC[form].proseCoefficient;
}

/**
 * 形态 + 场景密度 → 页面叙事文案预算（message + supporting + quote 合计字数）。
 * 缺省密度 standard（60 字基准）。
 */
export function proseBudgetForForm(form: PageForm, density: SceneDensity = "standard"): number {
  return Math.round(proseBudgetBaseForDensity(density) * PAGE_FORM_SPEC[form].proseCoefficient);
}

export function factsMaxForForm(form: PageForm): number {
  return PAGE_FORM_SPEC[form].factsMax;
}

/** 校验器侧：非法构图值兜底（内部用，不对外暴露选择权）。 */
export function isEngineComposition(value: unknown): value is EngineComposition {
  return typeof value === "string" && (ENGINE_COMPOSITIONS as readonly string[]).includes(value);
}
