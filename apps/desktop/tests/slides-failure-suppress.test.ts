import { describe, expect, it } from 'vitest'

import type { DisplayAgentToolCall } from '../src/renderer/src/components/agent/agentRunActivity'
import { slidesFailureSuppressed } from '../src/renderer/src/components/agent/slides/slidesState'

function failedEntry(runId: string): { tool: DisplayAgentToolCall; progress: { stage: 'failed' } } {
  return {
    tool: {
      id: 'tool-1',
      runId,
      name: 'slides_draft',
      args: {},
      status: 'error',
      startedAt: '2026-11-03T00:00:00.000Z',
    },
    progress: { stage: 'failed' },
  }
}

describe('slides failure suppression', () => {
  it('suppresses the failed card while the owning run has not terminated', () => {
    expect(slidesFailureSuppressed(failedEntry('run-1'), {})).toBe(true)
    expect(slidesFailureSuppressed(failedEntry('run-1'), { 'run-2': '2026-11-03T00:01:00.000Z' })).toBe(true)
  })

  it('shows the failed card once the owning run terminated', () => {
    expect(slidesFailureSuppressed(failedEntry('run-1'), { 'run-1': '2026-11-03T00:01:00.000Z' })).toBe(false)
  })

  it('never suppresses non-failed stages', () => {
    const entry = { ...failedEntry('run-1'), progress: { stage: 'drafting' as const } }
    expect(slidesFailureSuppressed(entry, {})).toBe(false)
  })
})
