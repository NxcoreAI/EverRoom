import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

import { AgentShellApproval } from './AgentShellApproval'

describe('AgentShellApproval', () => {
  it('shows command context and submits an explicit approval decision', () => {
    const onResolve = vi.fn()
    const renderer = TestRenderer.create(
      <AgentShellApproval
        approvals={[
          {
            approvalId: 'approval-1',
            runId: 'run-1',
            toolName: 'bash',
            command: 'pnpm test',
            cwd: '/workspace',
            reason: 'Runs project tests',
            requestedAt: '2026-08-21T00:00:00.000Z',
          },
          {
            approvalId: 'approval-2',
            runId: 'run-1',
            toolName: 'bash',
            command: 'pnpm build',
            requestedAt: '2026-08-21T00:00:01.000Z',
          },
        ]}
        resolvingApprovalIds={new Set()}
        onResolve={onResolve}
      />,
    )

    expect(renderer.root.findAllByType('code')[0]?.children).toEqual(['pnpm test'])
    expect(renderer.root.findByProps({ className: 'agent-shell-approval-count' }).children).toEqual(['+', '1'])
    act(() => renderer.root.findByProps({ className: 'agent-shell-approve' }).props.onClick())
    expect(onResolve).toHaveBeenCalledWith('approval-1', 'approved')
    act(() => renderer.root.findByProps({ className: 'agent-shell-approve agent-shell-approve-session' }).props.onClick())
    expect(onResolve).toHaveBeenCalledWith('approval-1', 'approved_session')
  })

  it('uses edit-approval copy for kind=edit requests', () => {
    const renderer = TestRenderer.create(
      <AgentShellApproval
        approvals={[
          {
            approvalId: 'approval-edit',
            runId: 'run-1',
            toolName: 'edit',
            kind: 'edit',
            command: '/workspace/src/index.ts',
            requestedAt: '2026-08-21T00:00:00.000Z',
          },
        ]}
        resolvingApprovalIds={new Set()}
        onResolve={vi.fn()}
      />,
    )
    const strong = renderer.root.findByType('strong')
    expect(strong.children).toEqual(['surface:agentChat.editApprovalTitle'])
    const small = renderer.root.findByType('small')
    expect(small.children).toEqual(['surface:agentChat.editApprovalDescription'])
    expect(renderer.root.findAllByType('code')[0]?.children).toEqual(['/workspace/src/index.ts'])
  })
})
