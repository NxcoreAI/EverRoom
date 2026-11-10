/**
 * 场景档案：把「用户做什么场合的 deck」翻译成两个相互独立的设计旋钮。
 *
 *   距离（far / near） → 决定**字号阶梯与硬下限**
 *   密度（airy / standard / dense） → 决定**每页字数预算基准**
 *
 * 两个旋钮正交：投影场合可以又密又大（路演 BP），研读场合也可以很疏（讲义）。
 * 字号与字数一律由本表给出，**风格卡不参与**（styleParams.sizes / typeScale 一律忽略），
 * 避免"同一场景下每份 deck 字号各漂各的"。
 *
 * 取值的依据：
 *   - near 档与已验证的好参考 deck（nexwing 13p 实测 56/44/34/26/22/17/16/13/12/11/10）基本重合；
 *   - far 档正文落在投影 18–24pt 的通行最佳实践区间（取 20pt）。
 *
 * **中文宽度约束**：汉字是满宽字，一行能排的字数 ≈ 可用宽 / 字号宽。标题级字号
 * 直接决定"一行能不能放下一句标题"：display 96pt 在 1280 宽画布上每行只放得下 9 个汉字，
 * 「深圳：一座仍在生长的城市」这种正常标题必然折行溢出。所以 CJK 阶梯的上限比同尺寸
 * 拉丁阶梯低约一档（display 60 而非 72~96），这不是保守，是排得下。
 */

import type { TypeToken } from "./theme.js";

export const SCENES = ["fundraising", "internal-review", "keynote", "training", "reading"] as const;
export type SceneId = typeof SCENES[number];

export const SCENE_DISTANCES = ["far", "near"] as const;
export type SceneDistance = typeof SCENE_DISTANCES[number];

export const SCENE_DENSITIES = ["airy", "standard", "dense"] as const;
export type SceneDensity = typeof SCENE_DENSITIES[number];

/** 字号硬下限的 5 个变体：降档兜底到此为止（由 layout-contract 消费）。 */
export const FLOOR_VARIANTS = ["display", "heading", "subtitle", "body", "caption"] as const;
export type FloorVariant = typeof FLOOR_VARIANTS[number];

export type SceneFontFloors = Record<FloorVariant, number>;

export interface SceneProfile {
  id: SceneId;
  /** 用户可读的场景名。只写进 deck 元数据，不新增界面元素。 */
  label: string;
  distance: SceneDistance;
  density: SceneDensity;
  /** v2 字号阶梯（pt），场景唯一真源。 */
  typeScale: Record<TypeToken, number>;
  fontFloors: SceneFontFloors;
  /** 每页正文合计字数基准（再乘 form 系数）。 */
  proseBudgetBase: number;
}

/** 投影档（远距）：正文 20pt，caption 13pt。 */
const FAR_SCALE: Record<TypeToken, number> = {
  display: 60,
  hero: 54,
  h1: 40,
  h2: 32,
  h3: 26,
  lead: 24,
  body: 20,
  label: 15,
  kicker: 14,
  caption: 13,
};

const FAR_FLOORS: SceneFontFloors = { display: 44, heading: 26, subtitle: 18, body: 16, caption: 12 };

/** 研读档（近距）：正文 16pt，caption 11pt——与 nexwing 参考 deck 实测阶梯对齐。 */
const NEAR_SCALE: Record<TypeToken, number> = {
  display: 46,
  hero: 42,
  h1: 32,
  h2: 25,
  h3: 21,
  lead: 19,
  body: 16,
  label: 13,
  kicker: 12,
  caption: 11,
};

const NEAR_FLOORS: SceneFontFloors = { display: 34, heading: 22, subtitle: 16, body: 14, caption: 10 };

/** 密度 → 每页字数基准。 */
const PROSE_BUDGET_BASE: Record<SceneDensity, number> = {
  airy: 35,
  standard: 60,
  dense: 95,
};

/** 场景 → 双旋钮。对外 5 个场景名，对内只有距离与密度两个值。 */
const SCENE_AXES: Record<SceneId, { label: string; distance: SceneDistance; density: SceneDensity }> = {
  fundraising: { label: "路演融资 BP", distance: "far", density: "dense" },
  "internal-review": { label: "内部汇报", distance: "far", density: "standard" },
  keynote: { label: "发布会 / 主题演讲", distance: "far", density: "airy" },
  training: { label: "培训教学", distance: "near", density: "standard" },
  reading: { label: "打印研读 / 尽调", distance: "near", density: "dense" },
};

/** agent 判断不确定时的落点：最保守的一档（投影 + 标准密度）。 */
export const DEFAULT_SCENE: SceneId = "internal-review";

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === "string" && (SCENES as readonly string[]).includes(value);
}

/** 场景 id → 完整档案。非法/缺失一律落 DEFAULT_SCENE，绝不抛错（落页不能因场景字段失败）。 */
export function resolveScene(id?: string | null): SceneProfile {
  const sceneId: SceneId = isSceneId(id) ? id : DEFAULT_SCENE;
  const axes = SCENE_AXES[sceneId];
  return {
    id: sceneId,
    label: axes.label,
    distance: axes.distance,
    density: axes.density,
    typeScale: { ...(axes.distance === "far" ? FAR_SCALE : NEAR_SCALE) },
    fontFloors: { ...(axes.distance === "far" ? FAR_FLOORS : NEAR_FLOORS) },
    proseBudgetBase: PROSE_BUDGET_BASE[axes.density],
  };
}

/** 只按旋钮取字号表（供测试与"场景之外"的重算使用）。 */
export function typeScaleForDistance(distance: SceneDistance): Record<TypeToken, number> {
  return { ...(distance === "far" ? FAR_SCALE : NEAR_SCALE) };
}

export function fontFloorsForDistance(distance: SceneDistance): SceneFontFloors {
  return { ...(distance === "far" ? FAR_FLOORS : NEAR_FLOORS) };
}

export function proseBudgetBaseForDensity(density: SceneDensity): number {
  return PROSE_BUDGET_BASE[density];
}

/**
 * 场景静默判断：只看用户这一句指令里的场合词。
 *
 * 为什么不让 agent 输出场景：场景一旦成为模型输出的字段，它就会被"猜一个安全值"，
 * 而场景错了整套字号/预算都跟着错。指令里的场合词是用户真实说过的，判错可追。
 * 判断不了就落最保守的一档（投影 + 标准密度），不猜。
 */
const SCENE_HINTS: Record<SceneId, RegExp> = {
  reading: /(研读|尽调|阅读|打印|白皮书|备忘录|书面材料|存档)/u,
  training: /(培训|教学|课程|新人|入职|课堂|讲义|讲解)/u,
  keynote: /(发布会|keynote|演讲|峰会|大会|主旨|开幕|宣讲)/iu,
  fundraising: /(路演|融资|投资人|募资|估值|商业计划书|BP|VC|风投|ts)/iu,
  "internal-review": /(汇报|周会|月会|评审|复盘|内部|对齐|例会|立项|述职|讨论)/u,
};

/** 优先级：场合越"专门"越先判（研读/培训/发布会/路演 > 内部汇报）。 */
const SCENE_PRIORITY: readonly SceneId[] = ["reading", "training", "keynote", "fundraising", "internal-review"];

export function inferSceneId(instruction?: string | null): SceneId {
  const text = (instruction ?? "").trim();
  if (!text) return DEFAULT_SCENE;
  for (const scene of SCENE_PRIORITY) {
    if (SCENE_HINTS[scene].test(text)) return scene;
  }
  return DEFAULT_SCENE;
}

/** 场景 → 用户可读标签（写 deck 元数据用，不上界面）。 */
export function sceneLabel(id?: string | null): string {
  return resolveScene(id).label;
}
