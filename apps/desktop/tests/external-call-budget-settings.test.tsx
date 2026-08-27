import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/state/toast', () => ({ showToast: vi.fn() }))

import { ExternalCallBudgetSettingsSection } from '../src/renderer/src/components/settings/ExternalCallBudgetSettingsSection'

const emptyPage = { items: [], total: 0, limit: 50, offset: 0 }

describe('ExternalCallBudgetSettingsSection', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.unstubAllGlobals()
  })

  it('starts disabled and saves an explicit service budget', async () => {
    const savePolicy = vi.fn().mockResolvedValue({ id: 'policy-1' })
    const listAudits = vi.fn().mockResolvedValue(emptyPage)
    vi.stubGlobal('window', {
      nxcore: { externalCalls: {
        listPolicies: vi.fn().mockResolvedValue(emptyPage),
        listUsage: vi.fn().mockResolvedValue(emptyPage),
        listAudits,
        savePolicy,
        deletePolicy: vi.fn(),
      } },
      confirm: vi.fn(() => true),
    })

    await act(async () => { renderer = TestRenderer.create(<ExternalCallBudgetSettingsSection />) })
    expect(savePolicy).not.toHaveBeenCalled()
    expect(listAudits).toHaveBeenCalledWith(expect.not.objectContaining({ subjectScope: 'service' }))

    const policiesTab = renderer!.root.findAllByType('button').find((button) => button.children.join('') === '预算设置')!
    act(() => policiesTab.props.onClick())
    const enable = renderer!.root.findAllByType('button').find((button) => button.children.join('') === '启用预算')!
    act(() => enable.props.onClick())

    const limit = renderer!.root.findAllByType('input')[0]!
    act(() => limit.props.onChange({ target: { value: '10' } }))
    const save = renderer!.root.findAllByProps({ className: 'primary-button' })[0]!
    await act(async () => { save.props.onClick(); await Promise.resolve() })

    expect(savePolicy).toHaveBeenCalledWith({
      subjectScope: 'service',
      subjectId: 'WEB_SEARCH',
      service: 'WEB_SEARCH',
      period: 'UTC_DAY',
      limit: 10,
      warningThreshold: 10,
      enforcement: 'AUDIT_ONLY',
    })
  })
})
