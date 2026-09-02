import type {
  RoomContextCorrection,
  RoomOverviewProjection,
} from '@nxcore/agent-contract'
import type { StartRuntimeRunInput } from '@nxcore/agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import { bundledAgentDefinitionsDir } from '../src/config.js'
import { loadBuiltinAgentBundle } from '../src/modules/agent/builtin-bundles.js'
import { BUILTIN_AGENT_IDS } from '../src/modules/agent/resolver.js'
import { createRoomOverviewAgentTools } from '../src/modules/context-rooms/overview-agent-tools.js'
import type { RoomOverviewService } from '../src/modules/context-rooms/overview-service.js'

function projection(revision = 3): RoomOverviewProjection {
  return {
    roomId: 'room-1',
    revision,
    generatedAt: '2026-08-27T12:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    nextSteps: [],
    timeline: [],
    entities: [],
    appliedCorrectionIds: [],
  }
}

function correction(
  id: string,
  status: RoomContextCorrection['status'],
  sessionId: string | null,
): RoomContextCorrection {
  return {
    id,
    roomId: 'room-1',
    operation: 'content_replace',
    section: 'overview',
    targetClaimId: 'overview:summary',
    originalText: 'Old overview',
    replacementText: 'New overview',
    rationale: 'User requested the change',
    status,
    entryPoint: 'agent',
    sessionId,
    createdAt: '2026-08-27T12:00:00.000Z',
    appliedAt: status === 'applied' ? '2026-08-27T12:01:00.000Z' : null,
    revokedAt: status === 'revoked' ? '2026-08-27T12:02:00.000Z' : null,
  }
}

function run(overrides: Partial<StartRuntimeRunInput> = {}): StartRuntimeRunInput {
  return {
    runId: 'run-confirm',
    sessionId: 'session-1',
    runtimeSessionRef: null,
    prompt: '确认',
    pageLabel: 'Room',
    roomId: 'room-1',
    ...overrides,
  }
}

function tools(service: Partial<RoomOverviewService>) {
  return Object.fromEntries(createRoomOverviewAgentTools(service as RoomOverviewService)
    .map((tool) => [tool.name, tool]))
}

describe('Context Room overview Agent tools', () => {
  it('ships the regenerate tool and the durable correction protocol in the primary Agent bundle', () => {
    const bundle = loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), BUILTIN_AGENT_IDS.primary)

    expect(bundle.tools).toContain('context_room_overview_regenerate')
    expect(bundle.tools).toContain('context_room_correction_apply_citation')
    expect(bundle.tools).toContain('room_correction_draft')
    expect(bundle.systemPrompt).toContain('从 pendingCorrections 取得当前会话的精确 proposal id')
    // 纠正计算已归 room-corrector 子 Agent：主 Agent 逐字转发，不再自带全套编辑规则。
    expect(bundle.systemPrompt).toContain('room_correction_draft(task=citation-correction)')
    expect(bundle.systemPrompt).toContain('edits 逐字转发给 context_room_correction_apply_citation')
  })

  it('returns applied corrections and only the current session pending proposals', async () => {
    const current = correction('proposal-current', 'proposed', 'session-1')
    const otherSession = correction('proposal-other', 'proposed', 'session-2')
    const applied = correction('correction-applied', 'applied', 'session-2')
    const revoked = correction('correction-revoked', 'revoked', 'session-1')
    const service = {
      get: vi.fn(() => projection()),
      list: vi.fn(() => [current, otherSession, applied, revoked]),
    }

    const result = await tools(service).context_room_context_get!.execute(run(), {})
    const payload = JSON.parse(result.content)

    expect(payload.corrections).toEqual([applied])
    // 瘦身：已应用纠正只回最近 20 条 + 历史总数，不再全量进上下文。
    expect(payload.appliedCorrectionCount).toBe(1)
    expect(payload.pendingCorrections).toEqual([current])
    expect(JSON.stringify(payload)).not.toContain('proposal-other')
    expect(JSON.stringify(payload)).not.toContain('correction-revoked')
  })

  it('regenerates and returns the saved projection for immediate UI application', async () => {
    const updated = projection(4)
    const regenerate = vi.fn(async () => updated)

    const result = await tools({ regenerate }).context_room_overview_regenerate!.execute(run(), {})

    expect(regenerate).toHaveBeenCalledWith('room-1')
    expect(result.details).toEqual({ roomId: 'room-1', overview: updated })
  })

  it('keeps correction application bound to the current run and session', async () => {
    const applied = {
      correction: correction('proposal-current', 'applied', 'session-1'),
      overview: projection(5),
    }
    const apply = vi.fn(() => applied)

    const result = await tools({ apply }).context_room_correction_apply!.execute(run(), {
      proposalId: 'proposal-current',
    })

    expect(apply).toHaveBeenCalledWith('room-1', 'proposal-current', {
      sessionId: 'session-1',
      runId: 'run-confirm',
    })
    expect(result.details).toEqual(applied)
  })

  it('directly applies a citation-backed correction in the current run', async () => {
    const applied = {
      corrections: [correction('citation-correction', 'applied', 'session-1')],
      overview: projection(6),
    }
    const applyCitations = vi.fn(() => applied)

    const result = await tools({ applyCitations }).context_room_correction_apply_citation!.execute(run({
      prompt: '写短一点',
    }), {
      edits: [{
        operation: 'content_replace',
        section: 'overview',
        targetClaimId: 'overview:summary',
        originalText: 'Old overview',
        replacementText: 'Short overview',
        rationale: '用户认为原文太长',
      }],
    })

    expect(applyCitations).toHaveBeenCalledWith('room-1', [expect.objectContaining({
      operation: 'content_replace',
      section: 'overview',
      targetClaimId: 'overview:summary',
      originalText: 'Old overview',
      replacementText: 'Short overview',
      entryPoint: 'agent',
    })], {
      sessionId: 'session-1',
      runId: 'run-confirm',
    })
    expect(result.details).toEqual(applied)
    expect(result.content).toContain('原子应用 1 条')
    expect(result.content).toContain('无需再次确认')
  })

  it('folds root-flattened fields into the single edit and defaults the rationale', async () => {
    // 复现 2026-08-28 线上失败：模型把 replacementText 放到工具根参数、且漏掉必填 rationale，
    // 原实现连续 6 次被 schema 校验拒绝导致 run 被取消。
    const applied = {
      corrections: [correction('citation-correction', 'applied', 'session-1')],
      overview: projection(7),
    }
    const applyCitations = vi.fn(() => applied)

    await tools({ applyCitations }).context_room_correction_apply_citation!.execute(run(), {
      roomId: 'room-1',
      edits: [{
        operation: 'content_replace',
        section: 'overview',
        targetClaimId: 'overview:summary',
        originalText: 'Old overview',
      }],
      replacementText: 'New overview',
    })

    expect(applyCitations).toHaveBeenCalledWith('room-1', [expect.objectContaining({
      operation: 'content_replace',
      section: 'overview',
      targetClaimId: 'overview:summary',
      originalText: 'Old overview',
      replacementText: 'New overview',
      rationale: '引用纠正（overview/content_replace）',
      entryPoint: 'agent',
    })], expect.anything())
  })

  it('keeps an explicit per-edit rationale and ignores root duplicates', async () => {
    const applyCitations = vi.fn(() => ({
      corrections: [correction('citation-correction', 'applied', 'session-1')],
      overview: projection(8),
    }))

    await tools({ applyCitations }).context_room_correction_apply_citation!.execute(run(), {
      edits: [{
        operation: 'content_replace',
        section: 'overview',
        targetClaimId: 'overview:summary',
        originalText: 'Old overview',
        replacementText: 'New overview',
        rationale: '用户要求改写',
      }],
      replacementText: 'Root value must not override the edit',
    })

    expect(applyCitations).toHaveBeenCalledWith('room-1', [expect.objectContaining({
      replacementText: 'New overview',
      rationale: '用户要求改写',
    })], expect.anything())
  })
})
