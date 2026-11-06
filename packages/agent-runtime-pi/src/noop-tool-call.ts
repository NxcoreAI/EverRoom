/**
 * 空转工具调用识别。
 *
 * 模型偶尔会把工具当"心跳"：反复 `echo stepN`、`read /dev/null`，每次都拿到一份
 * 回执，于是误以为在推进。实测一个透视表 run 里连刷了 269 次 `echo step…`，直到
 * 用户手动取消——中间一步实质工作都没做。
 *
 * 这里只认"结构上不可能有副作用"的调用，宁可漏判也不误杀真实命令；连续命中超过
 * 阈值就中止 run（见 index.ts 的 noOpLimitExceeded）。
 */
const NO_SIDE_EFFECT_MARKERS = /[><|;&`$()]/

/** bash 命令是否纯打点（echo/printf/true/false/:），且没有任何重定向/管道/串联。 */
export function isNoOpBashCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  // 有重定向、管道、串联或命令替换就可能产生副作用，不算空转。
  if (NO_SIDE_EFFECT_MARKERS.test(trimmed)) return false
  if (trimmed === ':') return true
  return /^(?:echo|printf|true|false)\b/i.test(trimmed)
}

/**
 * 工具调用是否没有实际作用。
 * `read /dev/null` 是同一类打点手段（永远返回空，只为凑一次调用）。
 */
export function isNoOpToolCall(name: unknown, args: unknown): boolean {
  if (typeof name !== 'string' || !args || typeof args !== 'object') return false
  const record = args as Record<string, unknown>
  if (name === 'bash' || name === 'shell' || name === 'terminal') {
    return isNoOpBashCommand(record.command)
  }
  if (name === 'read') {
    const path = record.path
    return typeof path === 'string' && (path === '' || path.startsWith('/dev/null'))
  }
  return false
}

/** 连续多少次空调用判定为空转并中止 run。 */
export const DEFAULT_MAX_NOOP_TOOL_CALLS = 8

/** 参数顺序无关的稳定序列化：同一调用的指纹不受 JSON key 顺序影响。 */
export function stableToolArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableToolArgs).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableToolArgs(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 连续相同调用（同名工具 + 参数指纹一致）判定阈值：超过即视为空转。
 * 实测 2026-11-06：模型用 magick 对同一裁剪区域循环执行同一条颜色分析命令
 * 30+ 次（每次都拿真输出，echo 类空转守卫不认），直到撞 60 次硬顶才停。
 */
export const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 5
