import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * `handle()` 只写主进程注册表，真正挂上 ipcMain 的是 `installIpcRouters()` 里
 * channelGroups 数组列出的分组。漏列一个分组 = 该分组的通道永远没有 handler，
 * 渲染层每次调用都报 `Error occurred in handler for 'x': Error: No handler
 * registered for 'x'`（Electron 对「无 handler」与「handler 抛错」打同一句 ERROR）。
 *
 * 这个坑在仓库里已经复发过两次（ai-relay:status、SCREEN_MEMORY_CHANNELS），
 * 所以用结构性断言把它锁住：只要是走注册表注册的通道分组，就必须出现在安装清单里。
 */
const mainSource = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')

/** `installIpcRouters()` 的 channelGroups 清单——唯一决定「哪些分组真的被安装」。 */
function installedChannelGroups(source: string): string[] {
  const functionStart = source.indexOf('function installIpcRouters')
  expect(functionStart).toBeGreaterThanOrEqual(0)
  const arrayStart = source.indexOf('const channelGroups = [', functionStart)
  expect(arrayStart).toBeGreaterThanOrEqual(0)
  const arrayEnd = source.indexOf(']', arrayStart)
  return [...source.slice(arrayStart, arrayEnd).matchAll(/([A-Z][A-Z0-9_]*_CHANNELS)/g)].map((match) => match[1])
}

/** 走 `handle()` / `handleGroup()` 注册表的分组（`ipcMain.handle(...)` 直挂的不算）。 */
function registryChannelGroups(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/(?<!\.)\bhandle(?:Group)?\(\s*([A-Z][A-Z0-9_]*_CHANNELS)\b/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/** 某个分组声明的全部通道字面量，失败信息里给到具体通道名。 */
function channelValues(source: string, group: string): string[] {
  const declaration = source.indexOf(`const ${group} = {`)
  if (declaration < 0) return []
  const body = source.slice(declaration, source.indexOf('} as const', declaration))
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function missingFromInstaller(source: string): Array<{ group: string; channels: string[] }> {
  const installed = new Set(installedChannelGroups(source))
  return registryChannelGroups(source)
    .filter((group) => !installed.has(group))
    .map((group) => ({ group, channels: channelValues(source, group) }))
}

/** 注册表里直挂字面量的通道（`handle('x:y', ...)`）——同样必须被安装，否则一样是死通道。 */
function registryLiteralChannels(source: string): string[] {
  const channels = new Set<string>()
  for (const match of source.matchAll(/(?<!\.)\bhandle(?:Group)?\(\s*'([^']+)'/g)) channels.add(match[1])
  return [...channels].sort()
}

/** 真正会被安装的通道集合：channelGroups 里各分组的通道值 + 文件内直挂 ipcMain.handle 的字面量。 */
function routedChannels(source: string): Set<string> {
  const routed = new Set<string>()
  for (const group of installedChannelGroups(source)) {
    for (const channel of channelValues(source, group)) routed.add(channel)
  }
  for (const match of source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) routed.add(match[1])
  return routed
}

describe('IPC 通道路由安装', () => {
  let missing: Array<{ group: string; channels: string[] }>

  beforeAll(() => {
    missing = missingFromInstaller(mainSource)
  })

  it('走 handle() 注册表的分组都出现在 installIpcRouters 的 channelGroups 里', () => {
    // 失败时打印「分组 → 通道」，直接给出要补的那一行和受影响的通道。
    expect(missing).toEqual([])
  })

  it('记忆面板通道（memory:list-entries / memory:get-profile）已安装路由', () => {
    expect(registryChannelGroups(mainSource)).toContain('MEMORY_CHANNELS')
    expect(installedChannelGroups(mainSource)).toContain('MEMORY_CHANNELS')
    expect(channelValues(mainSource, 'MEMORY_CHANNELS')).toEqual([
      'memory:list-entries',
      'memory:get-profile',
    ])
  })

  it('注册表里直挂字面量的通道都被 installIpcRouters 收进了分组', () => {
    // 直挂字面量绕过 channelGroups 时最容易再漏一次；失败信息给出仍未被路由的通道。
    const routed = routedChannels(mainSource)
    const uninstalled = registryLiteralChannels(mainSource).filter((channel) => !routed.has(channel))
    expect(uninstalled).toEqual([])
  })

  it('通知偏好/云端会话通道（notifications:*）已安装路由', () => {
    expect(installedChannelGroups(mainSource)).toContain('NOTIFICATION_CHANNELS')
    const routed = routedChannels(mainSource)
    for (const channel of channelValues(mainSource, 'NOTIFICATION_CHANNELS')) {
      expect(routed.has(channel)).toBe(true)
    }
  })
})
