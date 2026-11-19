import { describe, expect, it, vi } from 'vitest'

import { genofficeSessionGone } from './office-preview-registry'

// 只加载纯函数：registry 模块顶层 import electron，mock 成 bridge 测试同款最小面。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}))

describe('genofficeSessionGone', () => {
  it('registry 实例在而 genoffice session 丢失的两类错误判 true（映射回 not_open 触发自动重开）', () => {
    expect(genofficeSessionGone('no slides session for this view')).toBe(true)
    expect(genofficeSessionGone('the slides view is gone')).toBe(true)
  })

  it('op 级失败与其他主机级错误不误判（保持原语义透传）', () => {
    expect(genofficeSessionGone('page 1: the page could not be merged into this deck')).toBe(false)
    expect(genofficeSessionGone('slideIndex must be an integer between 0 and 3')).toBe(false)
    expect(genofficeSessionGone(undefined)).toBe(false)
    expect(genofficeSessionGone({ error: 'no slides session for this view' })).toBe(false)
  })
})
