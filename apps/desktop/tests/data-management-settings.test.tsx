import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import { DataManagementSettingsSection } from '../src/renderer/src/components/settings/DataManagementSettingsSection'

function stubNxcore(overrides: Partial<Record<'clearUserData', ReturnType<typeof vi.fn>>> = {}) {
  const api = { clearUserData: overrides.clearUserData ?? vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('window', { nxcore: { app: api } })
  return api
}

describe('DataManagementSettingsSection', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.unstubAllGlobals()
  })

  it('renders the section without a dialog initially', async () => {
    stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<DataManagementSettingsSection />) })
    expect(renderer!.root.findByProps({ id: 'settings-data-management' })).toBeTruthy()
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    const trigger = renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('一键删除'))!
    expect(trigger).toBeTruthy()
  })

  it('opens the confirmation dialog and wipes only after confirming', async () => {
    const api = stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<DataManagementSettingsSection />) })
    await act(async () => {
      renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('一键删除'))!.props.onClick()
    })
    // 弹窗打开但尚未调用清理
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
    expect(api.clearUserData).not.toHaveBeenCalled()

    const confirm = renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('确认删除'))!
    await act(async () => { confirm.props.onClick() })
    expect(api.clearUserData).toHaveBeenCalledTimes(1)
    // 成功路径应用会退出重启；弹窗保持、按钮进入忙碌态防重复触发
    expect(confirm.props.disabled).toBe(true)
  })

  it('closes the dialog on cancel without wiping', async () => {
    const api = stubNxcore()
    await act(async () => { renderer = TestRenderer.create(<DataManagementSettingsSection />) })
    await act(async () => {
      renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('一键删除'))!.props.onClick()
    })
    const cancel = renderer!.root.findAllByType('button').find((button) => button.children.join('') === '取消')!
    await act(async () => { cancel.props.onClick() })
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(api.clearUserData).not.toHaveBeenCalled()
  })

  it('surfaces a localized error when the wipe request fails', async () => {
    const api = stubNxcore({ clearUserData: vi.fn().mockRejectedValue(new Error('boom')) })
    await act(async () => { renderer = TestRenderer.create(<DataManagementSettingsSection />) })
    await act(async () => {
      renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('一键删除'))!.props.onClick()
    })
    await act(async () => {
      renderer!.root.findAllByType('button').find((button) => button.children.join('').includes('确认删除'))!.props.onClick()
    })
    expect(api.clearUserData).toHaveBeenCalledTimes(1)
    // 失败后弹窗关闭并展示错误行
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ role: 'alert' })[0]?.children.join('')).toContain('boom')
  })
})
