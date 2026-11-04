/**
 * 看板列内的分数序排序键（fractional rank）。
 *
 * 为什么不用整数序号：拖拽插入一条就要整列重排。这里把 rank 当成 base62 小数的
 * 数字串（"V" = 0.5、"V5" = 0.55），**字串的字典序即数值序**，于是插入 = 取左右
 * 邻居的中点，只写一行。
 *
 * 两条不变量（生成侧保证，读取侧可依赖）：
 * - rank 非空；
 * - rank 不以最小位（"0"）结尾——否则 (rank, rank+"0") 这样的区间在字典序下为空。
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX = DIGITS.length - 1;
const MIN_DIGIT = DIGITS[0]!;
/** 新列首条的 rank（0.5 位置的数字位）。 */
export const MIDDLE_RANK = "V";

function digitAt(value: string, index: number): number {
  const char = value[index];
  if (char === undefined) return -1;
  const digit = DIGITS.indexOf(char);
  if (digit < 0) throw new Error("plan_rank_invalid");
  return digit;
}

function assertValidRank(value: string): void {
  if (value.length === 0) throw new Error("plan_rank_invalid");
  for (let index = 0; index < value.length; index += 1) digitAt(value, index);
  if (value.length > 0 && value[value.length - 1] === MIN_DIGIT) {
    // 以最小位结尾会让 (value, value+"0") 在字典序下无解，直接判为脏数据。
    throw new Error("plan_rank_invalid");
  }
}

/** 字典序比较（等价于数值比较）。 */
export function compareRank(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 末尾追加：优先把最后一位 +1（不增长），已经到最大位时才延长一位。 */
function appendAfter(lower: string | null): string {
  if (!lower) return MIDDLE_RANK;
  const last = digitAt(lower, lower.length - 1);
  if (last < MAX) return lower.slice(0, -1) + DIGITS[last + 1];
  return lower + MIDDLE_RANK;
}

/**
 * 生成严格位于 `left` 与 `right` 之间的 rank。
 *
 * - `rankBetween(null, null)` = 空列第一条；
 * - `rankBetween(last, null)` = 追加到列尾；
 * - `rankBetween(null, first)` = 插到列首；
 * - `left >= right` 视为调用方 bug，抛 `plan_rank_order_invalid`；
 * - 区间为空（`left` 是 `right` 的前缀且下一位是最小位，脏数据才会出现）抛 `plan_rank_exhausted`。
 */
export function rankBetween(left: string | null, right: string | null): string {
  const lower = left && left.length > 0 ? left : null;
  if (lower) assertValidRank(lower);
  if (right !== null) assertValidRank(right);

  if (lower !== null && right !== null && compareRank(lower, right) >= 0) {
    throw new Error("plan_rank_order_invalid");
  }
  if (right === null) return appendAfter(lower);

  let out = "";
  for (let index = 0; index < right.length; index += 1) {
    const low = lower !== null && index < lower.length ? digitAt(lower, index) : 0;
    const high = digitAt(right, index);
    if (low === high) {
      out += DIGITS[low];
      continue;
    }
    if (high - low >= 2) {
      return out + DIGITS[low + Math.floor((high - low) / 2)];
    }
    // high === low + 1：这一位只能取 low；一旦取了，上界就不再约束，
    // 剩下的低位只要保证 > lower 的剩余部分即可。
    const rest = lower !== null && index + 1 < lower.length ? lower.slice(index + 1) : null;
    return out + DIGITS[low] + appendAfter(rest);
  }
  // 走到这里说明 out 已经等于 right（lower 是 right 的前缀且后续位都是最小位）。
  throw new Error("plan_rank_exhausted");
}
