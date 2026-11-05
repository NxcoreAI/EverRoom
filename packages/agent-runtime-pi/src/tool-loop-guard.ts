/**
 * 重复调用守卫：同一工具连续用**完全相同的参数**调 N 次，判定为原地打转。
 *
 * 实测案例：一个 PPT 任务里模型解压 .pptx 后用 `python3 - <<EOF …` 改 XML，同一条
 * 命令连续重复约 170 次，跑了 7 分钟直到用户手动停止——期间 PPT 一次都没被改。
 * 空转守卫（echo / read /dev/null）抓不到这种「真的在干活、但一步没前进」的循环。
 */
export interface RepeatedCallState {
  /** 上一次调用的签名（工具名 + 参数）。 */
  signature: string | null;
  /** 连续相同签名的次数。 */
  count: number;
}

/** 连续多少次完全相同的调用判定为打转。 */
export const DEFAULT_MAX_REPEATED_CALLS = 5;

export function createRepeatedCallState(): RepeatedCallState {
  return { signature: null, count: 0 };
}

/** 参数规范化：只按 key 排序序列化，避免对象字面量顺序导致的假不同。 */
function canonicalArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args) ?? "";
  const record = args as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/**
 * 记录一次调用，返回是否已经连续重复到上限。
 * 任何一次不同的调用都会把计数清零——只抓「紧邻的连续重复」。
 */
export function trackRepeatedCall(
  state: RepeatedCallState,
  name: unknown,
  args: unknown,
  limit: number = DEFAULT_MAX_REPEATED_CALLS,
): boolean {
  const signature = `${typeof name === "string" ? name : "tool"}\u0000${canonicalArgs(args)}`;
  if (state.signature === signature) {
    state.count += 1;
  } else {
    state.signature = signature;
    state.count = 1;
  }
  return limit > 0 && state.count >= limit;
}

/**
 * 命中打转/空转时的处置：先纠偏一次，再犯才中止。
 *
 * 直接杀掉会浪费「其实会干、只是起手用错工具」的情况（实测模型先连刷 8 个 echo，
 * 给它一句"别用 bash 打点"就能拐回来）。所以第一次只注入纠偏提示并清零计数，
 * 第二次命中才真正中止。
 */
export type StallAction = "none" | "steer" | "abort";

export function resolveStallAction(hit: boolean, alreadySteered: boolean): StallAction {
  if (!hit) return "none";
  return alreadySteered ? "abort" : "steer";
}
