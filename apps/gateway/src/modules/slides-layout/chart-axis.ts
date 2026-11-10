/**
 * 图表值轴刻度：把"刻度该多密"从渲染器自动推变成可计算的确定性结果。
 *
 * 背景：值轴刻度数量由绘图区尺寸自动决定——1280×720 的画布上，两根柱子也会长出
 * 十来条刻度线（实测产物：2 根柱 + 10 条 Y 轴标签），而数据标签已经把数字直接标在
 * 柱顶了。这类小字是纯粹的视觉噪音，也是"AI 味"的一大来源。
 *
 * 两条规则（确定性，无随机）：
 *   1. 数据标签已经直接标注、且类目很少（≤4）→ 值轴整条隐藏，只留类目轴；
 *   2. 其余情况给一个"好读的步长"，让刻度落在 3~5 条之间。
 */

/** 主刻度目标条数：投影场合 4 条最舒服（0 / 1 / 2 / 3 / 4 这种）。 */
const TARGET_TICKS = 4;

/** 1 / 2 / 2.5 / 5 / 10 × 10^k —— 人眼好读的步长族。 */
const NICE_MANTISSAS = [1, 2, 2.5, 5, 10] as const;

/** 把任意步长吸到最近的"好读步长"。 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const mantissa = NICE_MANTISSAS.find((candidate) => normalized <= candidate) ?? 10;
  return mantissa * magnitude;
}

export interface ValueAxisPlan {
  /** c:majorUnit：不传则由引擎按绘图区自动推。 */
  majorUnit?: number;
  /** 整条值轴隐藏（数据标签已经承担数字）。 */
  hideValueAxis?: boolean;
}

export interface ValueAxisInput {
  /** 全部系列的全部数值（忽略 NaN / Infinity）。 */
  values: ReadonlyArray<number>;
  /** 画在图上的是数据标签吗（是才允许隐藏值轴）。 */
  dataLabels: boolean;
  /** 类目数量。 */
  categories: number;
}

export function valueAxisPlan(input: ValueAxisInput): ValueAxisPlan {
  const finite = input.values.filter((value) => Number.isFinite(value)).map((value) => Math.abs(value));
  const magnitude = finite.length > 0 ? Math.max(...finite) : 0;
  // 全零/空数据没有刻度可言，交给引擎兜底。
  if (magnitude <= 0) return {};

  // 类目少 + 已直接标注：数字在柱顶，值轴只剩噪音。
  if (input.dataLabels && input.categories <= 4) return { hideValueAxis: true };

  let step = niceStep(magnitude / TARGET_TICKS);
  // 步长太大导致只有 1 条刻度（等于没刻度）时，对半再吸，最多退 8 次。
  for (let guard = 0; guard < 8 && magnitude / step < 2; guard += 1) step = niceStep(step / 2);
  return { majorUnit: step };
}
