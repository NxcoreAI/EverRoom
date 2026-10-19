import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { ScreenRecordingPermissionCard } from '../src/renderer/src/components/settings/ScreenRecordingPermissionCard'

function stubNxcore(overrides: Partial<Record<'appInfo' | 'status' | 'openPermissionSettings' | 'relaunchApp', ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    appInfo: overrides.appInfo ?? vi.fn().mockResolvedValue({ appPath: '/Applications/EverRoom.app', appName: 'EverRoom', iconDataUrl: 'data:image/png;base64,AAA', devMode: false }),
    status: overrides.status ?? vi.fn().mockResolvedValue({ enabled: true, intervalMs: 60_000, permission: 'not-determined', lastResult: null }),
    openPermissionSettings: overrides.openPermissionSettings ?? vi.fn().mockResolvedValue(undefined),
    startAppDrag: vi.fn(),
    relaunchApp: overrides.relaunchApp ?? vi.fn().mockResolvedValue(undefined),
  }
  vi.stubGlobal('window', { nxcore: { screenCapture: api } })
  return api
}

describe('ScreenRecordingPermissionCard', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders nothing while permission is unknown', async () => {
    stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission={undefined} />) })
    expect(renderer!.toJSON()).toBeNull()
  })

  it('renders nothing when already granted on mount', async () => {
    const api = stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission="granted" />) })
    expect(renderer!.toJSON()).toBeNull()
    expect(api.appInfo).not.toHaveBeenCalled()
  })

  it('shows the drag guide when permission is missing', async () => {
    const api = stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission="not-determined" />) })
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(api.appInfo).toHaveBeenCalledTimes(1)
    const card = renderer!.root.findByProps({ className: 'screen-permission-card' })
    expect(card.props['data-state']).toBe('missing')
    const icon = renderer!.root.findByProps({ className: 'screen-permission-drag-icon' })
    expect(icon.props.draggable).toBe(true)
    const openButton = renderer!.root.findAllByType('button').find((button) => button.children.join('') === '打开系统设置')!
    await act(async () => { openButton.props.onClick() })
    expect(api.openPermissionSettings).toHaveBeenCalledTimes(1)
  })

  it('switches to the restart prompt once the poll sees granted', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ enabled: true, intervalMs: 60_000, permission: 'not-determined', lastResult: null })
      .mockResolvedValue({ enabled: true, intervalMs: 60_000, permission: 'granted', lastResult: null })
    const api = stubNxcore({ status })
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission="denied" />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_200) })
    const card = renderer!.root.findByProps({ className: 'screen-permission-card' })
    expect(card.props['data-state']).toBe('granted')
    const restartButton = renderer!.root.findAllByType('button').find((button) => button.children.join('') === '重启应用')!
    await act(async () => { restartButton.props.onClick() })
    expect(api.relaunchApp).toHaveBeenCalledTimes(1)
  })

  it('switches to the restart prompt when the permission prop turns granted', async () => {
    stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission="denied" />) })
    await act(async () => { renderer!.update(<ScreenRecordingPermissionCard permission="granted" />) })
    const card = renderer!.root.findByProps({ className: 'screen-permission-card' })
    expect(card.props['data-state']).toBe('granted')
  })

  it('replaces the restart button with a manual hint in dev mode', async () => {
    stubNxcore({ appInfo: vi.fn().mockResolvedValue({ appPath: '/x/EverRoom.app', appName: 'EverRoom', iconDataUrl: '', devMode: true }) })
    await act(async () => { renderer = TestRenderer.create(<ScreenRecordingPermissionCard permission="denied" />) })
    await act(async () => { renderer!.update(<ScreenRecordingPermissionCard permission="granted" />) })
    const card = renderer!.root.findByProps({ className: 'screen-permission-card' })
    expect(card.props['data-state']).toBe('granted')
    expect(card.findAllByType('button')).toHaveLength(0)
    expect(JSON.stringify(renderer!.toJSON())).toContain('开发模式')
  })
})
