/**
 * 空转工具调用识别（渲染层副本）。
 *
 * 与 `packages/agent-runtime-pi/src/noop-tool-call.ts` 保持同一套判定：运行时用它
 * 中止空转的 run，界面用它把已经发生过的空转行折叠掉。两边故意各留一份——渲染层
 * 不能引运行时包（会拖进 node 内置模块），改动时请同步两处。
 *
 * 背景：模型偶尔会把工具当"心跳"，反复 `echo stepN` / `read /dev/null`，每次都拿到
 * 一份回执，于是误以为在推进（实测一个 run 里刷了 269 次 `echo step…`）。
 */

const NO_SIDE_EFFECT_MARKERS = /[><|;&`$()]/

export function isNoOpBashCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  // 有重定向/管道/串联/命令替换就可能产生副作用，一律不算空转。
  if (NO_SIDE_EFFECT_MARKERS.test(trimmed)) return false
  if (trimmed === ':') return true
  return /^(?:echo|printf|true|false)\b/i.test(trimmed)
}

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

/** 折叠展示用的摘要：把空转命令压成一行样本。 */
export function noOpCommandSummary(args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command) return command.length > 40 ? `${command.slice(0, 40)}…` : command
  const path = typeof args.path === 'string' ? args.path : ''
  return path || '—'
}
