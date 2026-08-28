/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordRoomOverviewDiagnostic } from '../src/renderer/src/components/context-room/roomOverviewDiagnostics'

afterEach(() => vi.restoreAllMocks())

describe('Room overview diagnostics', () => {
  it('forwards structured metadata through the desktop diagnostic channel', () => {
    const log = vi.fn()
    Object.defineProperty(window, 'nxcore', {
      configurable: true,
      value: { diagnostics: { log } },
    })

    recordRoomOverviewDiagnostic('projection.applied', {
      roomId: 'room-1', currentRevision: 4, incomingRevision: 5,
    })

    expect(log).toHaveBeenCalledWith({
      module: 'context-room-overview',
      level: 'info',
      event: expect.objectContaining({
        event: 'projection.applied',
        roomId: 'room-1',
        currentRevision: 4,
        incomingRevision: 5,
        time: expect.any(String),
      }),
    })
  })

  it('never throws when the diagnostic transport fails', () => {
    Object.defineProperty(window, 'nxcore', {
      configurable: true,
      value: { diagnostics: { log: () => { throw new Error('transport failed') } } },
    })
    expect(() => recordRoomOverviewDiagnostic('load.failed', { roomId: 'room-1' }, 'error')).not.toThrow()
  })
})
