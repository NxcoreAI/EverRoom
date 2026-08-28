export type RoomOverviewDiagnosticLevel = 'info' | 'warn' | 'error'

/**
 * Send structured, content-free Room overview diagnostics to the desktop log.
 * Never include claim text, citation comments, prompts, or correction contents.
 */
export function recordRoomOverviewDiagnostic(
  event: string,
  detail: Record<string, unknown> = {},
  level: RoomOverviewDiagnosticLevel = 'info',
): void {
  if (typeof window === 'undefined') return
  try {
    window.nxcore?.diagnostics?.log({
      module: 'context-room-overview',
      level,
      event: {
        ...detail,
        event,
        time: new Date().toISOString(),
      },
    })
  } catch {
    // Diagnostics must never interrupt correction application or rendering.
  }
}
