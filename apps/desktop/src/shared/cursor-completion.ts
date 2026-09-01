/**
 * 补全 IPC 的预期失败（409 session_busy、网络瞬断等）由渲染端统一分类——
 * 退避重试、熔断豁免、诊断落盘都在那里。若主进程 handler 直接 reject，Electron
 * 会对每次调用打一条 ERROR 级 "Error occurred in handler" console 日志：渲染端
 * 每重试一次就多一条假错误。因此主进程改为返回本哨兵对象，preload 还原成 Error
 * 抛出，渲染端代码路径不变。
 */
export const CURSOR_COMPLETION_AGENT_ERROR_KEY = '__cursorCompletionAgentError'

export interface CursorCompletionAgentErrorPayload {
  [CURSOR_COMPLETION_AGENT_ERROR_KEY]: string
}

export function isCursorCompletionAgentErrorPayload(
  value: unknown,
): value is CursorCompletionAgentErrorPayload {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && CURSOR_COMPLETION_AGENT_ERROR_KEY in value
    && typeof (value as Record<string, unknown>)[CURSOR_COMPLETION_AGENT_ERROR_KEY] === 'string'
}
