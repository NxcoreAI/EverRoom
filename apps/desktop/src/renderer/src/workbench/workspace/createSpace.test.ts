import { describe, expect, it } from 'vitest'

import type { AgentSpaceDetectResult } from '@nxcore/agent-contract'

import { directoryToSpaceName, isRegisteredSpace } from './createSpace'

/**
 * 一步式新建项目空间的纯逻辑：目录名 → 空间名、探测结果 → 是否走
 * 「打开已有空间」分支。流程编排骨干（选目录/建空间）依赖原生桥与网关，
 * 由桌面端 e2e 覆盖；这里锁住的是可独立验证的判定规则。
 */

describe('directoryToSpaceName', () => {
  it('取目录最后一段作为空间名', () => {
    expect(directoryToSpaceName('/Users/xjwang/Desktop/连接器项目')).toBe('连接器项目')
    expect(directoryToSpaceName('/Users/xjwang/Desktop/EverRoomMac/')).toBe('EverRoomMac')
  })

  it('兼容 Windows 分隔符与混合分隔符', () => {
    expect(directoryToSpaceName('C:\\Users\\demo\\Reports')).toBe('Reports')
    expect(directoryToSpaceName('C:\\Users/demo\\年末总结')).toBe('年末总结')
  })

  it('折叠空白并去掉结尾的点/空格', () => {
    expect(directoryToSpaceName('/tmp/my  project ')).toBe('my project')
    expect(directoryToSpaceName('/tmp/演示目录...')).toBe('演示目录')
  })

  it('超长目录名截断到 120 字符（后端 name 上限）', () => {
    const long = 'a'.repeat(300)
    const name = directoryToSpaceName(`/tmp/${long}`)
    expect(name).toHaveLength(120)
  })

  it('根目录/空串等极端输入回落到兜底名', () => {
    expect(directoryToSpaceName('/')).toBe('新建项目空间')
    expect(directoryToSpaceName('///')).toBe('新建项目空间')
    expect(directoryToSpaceName('')).toBe('新建项目空间')
    expect(directoryToSpaceName('/tmp/.')).toBe('新建项目空间')
  })
})

describe('isRegisteredSpace', () => {
  const workspaces = [
    { id: 'default', path: null },
    { id: 'ws-1', path: '/Users/demo/Projects/alpha' },
  ]

  const space = (spaceId: string): AgentSpaceDetectResult => ({
    status: 'space',
    root: '/Users/demo/Projects/alpha',
    spaceId,
    name: 'alpha',
    slug: 'alpha',
    layoutVersion: 2,
    readonly: false,
  })

  it('探测到空间标记且库里已注册（按 id 或路径）时走打开分支', () => {
    expect(isRegisteredSpace(space('ws-1'), workspaces)).toBe(true)
    expect(isRegisteredSpace(space('other-id'), workspaces)).toBe(true)
  })

  it('未注册的目录（标记在但库里没有）不算已注册，走接管分支', () => {
    const unregistered = { ...space('orphan'), root: '/Users/demo/Projects/beta' }
    expect(isRegisteredSpace(unregistered, workspaces)).toBe(false)
  })

  it('普通目录（无标记）与探测失败都不走打开分支', () => {
    expect(isRegisteredSpace({ status: 'missing' as const }, workspaces)).toBe(false)
    expect(isRegisteredSpace({ status: 'invalid' as const }, workspaces)).toBe(false)
    expect(isRegisteredSpace(null, workspaces)).toBe(false)
  })
})
