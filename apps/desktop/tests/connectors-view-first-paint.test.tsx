// @vitest-environment happy-dom
/**
 * 回归：「进入连接器页面会闪烁一下」——首帧不得用网关注册表兜底目录（7 个连接器）
 * 冒充真实目录，再在异步数据返回后收缩成 SaaS 真实配置集合。
 *
 * 闪烁根因（Lead 定位）：ConnectorsView 首帧以 REGISTRY_FALLBACK 渲染，
 * providers/status/oauthConfigs/agentAuth.status 返回后目录收缩 → 卡片数、
 * 筛选 tab、滚动条、hint 计数同时跳变。
 *
 * 本文件用「可控 deferred promise」精确卡住异步数据，逐帧取证：
 * 1) 首帧：只允许骨架（.op-conn-skel-*；骨架卡是纯 .op-conn-skel-card，
 *    不复用 .op-conn-card，因此首帧 .op-conn-card 数量必须为 0），
 *    不得出现 SaaS 未配置的注册表兜底连接器（Outlook / Notion / Slack 等）；
 * 2) 全挂载过程：MutationObserver 记录每次出现的 .op-conn-name 集合，
 *    每个非空集合都必须是最终 catalog 名字集合的子集（注册表专属 provider 从不闪现）；
 * 3) 重复进入：模块级缓存命中时首帧即真实卡片、无骨架；
 * 4) 失败兜底不回归：oauthConfigs=null（local 模式）最终回落注册表全量；
 *    gateway 调用失败时有限重试后出现兜底内容，不永久停在骨架，且失败快照不写缓存。
 *
 * 不依赖真实 sleep 时序：deferred 由用例手动 resolve，flush 只是有限轮次
 * 的 act 推进；重试路径用 vi.useFakeTimers 精确推进虚拟时间。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsView } from '../src/renderer/src/office-proto/pages/ConnectorsView'
import {
  peekConnectorsSnapshot,
  resetConnectorsSnapshotForTests,
} from '../src/renderer/src/office-proto/pages/connectorsData'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ───────────── 可手动 resolve / reject 的 deferred mock ───────────── */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 网关注册表全量（与首帧兜底目录同集）：修复前首帧假目录的来源。 */
const REGISTRY = [
  { provider: 'gmail', dataTypes: ['mail'] },
  { provider: 'outlook', dataTypes: ['mail'] },
  { provider: 'google-calendar', dataTypes: ['event'] },
  { provider: 'google-docs', dataTypes: ['document'] },
  { provider: 'notion', dataTypes: ['document'] },
  { provider: 'slack', dataTypes: ['message'] },
  { provider: 'feishu', dataTypes: ['document'] },
] as const

/** 注册表兜底专属（SaaS 只配置 gmail 时绝不该出现在页面上）的连接器名。 */
const REGISTRY_ONLY_NAMES = ['Outlook', 'Google 日历', 'Google Drive', 'Notion', 'Slack', '飞书']

type OauthConfigs = Array<{ provider: string; displayName: string | null; iconUrl: string | null }> | null

interface GatewayData {
  registry?: Array<{ provider: string; dataTypes: string[] }>
  oauthConfigs: OauthConfigs
  connections?: Array<{ provider: string; service: string; connectionName: string }>
  disconnected?: Array<{ service: string; connectionName: string }>
  feishuAuth?: {
    cliState: 'ready' | 'missing' | 'error' | 'unknown'
    appConfigured: boolean | null
    userAuthorized: boolean | null
    userName: string | null
    message?: string | null
  }
}

interface NxcoreGate {
  /** 各异步接口的 deferred：先让它们挂起，观察首帧，再逐项 resolve/reject。 */
  providersDeferred: Deferred<unknown>
  statusDeferred: Deferred<unknown>
  oauthConfigsDeferred: Deferred<unknown>
  agentAuthStatusDeferred: Deferred<unknown>
  nxcore: {
    nangoConnector: Record<string, ReturnType<typeof vi.fn>>
    agentAuth: Record<string, ReturnType<typeof vi.fn>>
  }
}

function buildGatewayResponses(data: GatewayData) {
  const registry = data.registry ?? [...REGISTRY]
  const feishuAuth = data.feishuAuth ?? {
    cliState: 'ready' as const,
    appConfigured: true,
    userAuthorized: false,
    userName: null,
    message: null,
  }
  const providers = {
    enabled: true,
    providers: registry.map((p) => ({
      provider: p.provider,
      label: p.provider,
      category: 'docs' as const,
      iconKey: p.provider,
      dataTypes: p.dataTypes,
      authChannel: 'nango-oauth' as const,
      connected: false,
      comingSoon: false,
    })),
  }
  const status = {
    enabled: true,
    connections: (data.connections ?? []).map((c) => ({
      id: `${c.service}:${c.connectionName}`,
      provider: c.provider,
      service: c.service,
      connectionName: c.connectionName,
      accountIdentityHash: null,
      status: 'active' as const,
      filters: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      authMethod: 'nango-oauth' as const,
    })),
    disconnected: data.disconnected ?? [],
    scopes: [],
    runs: [],
  }
  const agentAuthStatus = {
    feishu: {
      cliState: feishuAuth.cliState,
      cliPath: '/usr/local/bin/lark-cli',
      appConfigured: feishuAuth.appConfigured,
      userAuthorized: feishuAuth.userAuthorized,
      userName: feishuAuth.userName,
      message: feishuAuth.message ?? null,
    },
    activeChallenge: null,
  }
  return { providers, status, agentAuthStatus }
}

/**
 * 安装可控 window.nxcore：目录/状态接口全部返回「挂起中的 deferred promise」，
 * 用例可以精确控制「异步数据何时返回」，从而稳定观察首帧。
 */
function installNxcore(): NxcoreGate {
  const gate: NxcoreGate = {
    providersDeferred: createDeferred<unknown>(),
    statusDeferred: createDeferred<unknown>(),
    oauthConfigsDeferred: createDeferred<unknown>(),
    agentAuthStatusDeferred: createDeferred<unknown>(),
    nxcore: { nangoConnector: {}, agentAuth: {} },
  }
  const nxcore = {
    nangoConnector: {
      providers: vi.fn(() => gate.providersDeferred.promise),
      status: vi.fn(() => gate.statusDeferred.promise),
      oauthConfigs: vi.fn(() => gate.oauthConfigsDeferred.promise),
      startAuthorization: vi.fn(),
      authorizationStatus: vi.fn(),
      purgeConnection: vi.fn(),
      reconnectConnection: vi.fn(),
    },
    agentAuth: {
      status: vi.fn(() => gate.agentAuthStatusDeferred.promise),
      start: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      disconnect: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    },
  }
  gate.nxcore = nxcore as unknown as NxcoreGate['nxcore']
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return gate
}

/** 手动 resolve 全部异步数据（模拟 providers/status/oauthConfigs/agentAuth 返回）。 */
async function resolveGateway(gate: NxcoreGate, data: GatewayData): Promise<void> {
  const { providers, status, agentAuthStatus } = buildGatewayResponses(data)
  await act(async () => {
    gate.providersDeferred.resolve(providers)
    gate.statusDeferred.resolve(status)
    gate.oauthConfigsDeferred.resolve(data.oauthConfigs)
    gate.agentAuthStatusDeferred.resolve(agentAuthStatus)
    // 让 allSettled 的续体在 act 内跑完，避免微任务逃逸到用例断言之后。
    await Promise.resolve()
  })
  await flush()
}

/* ───────────── 渲染与取证工具（复用既有 catalog 测试的模式） ───────────── */

let container: HTMLDivElement
let root: Root

/**
 * 推进有限轮 act（默认 8 轮 × 0ms 宏任务）。固定轮数而非「等够多少毫秒」，
 * 目的是给 React 提交、promise 续体、MutationObserver 回调足够的调度机会。
 */
async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** 真实卡片：骨架卡是纯 .op-conn-skel-card，因此 .op-conn-card 就是准确选择器。 */
function realCards(): Element[] {
  return [...container.querySelectorAll('.op-conn-card')]
}

function cardNames(): string[] {
  return [...container.querySelectorAll('.op-conn-name')].map((el) => el.textContent ?? '')
}

/** 骨架元素数量（.op-conn-skel-card / .op-conn-skel-pill 等骨架 class 族）。 */
function skeletonCount(): number {
  return container.querySelectorAll('[class*="op-conn-skel"]').length
}

/** 筛选 tab 文案（.op-seg 的按钮）。 */
function tabLabels(): string[] {
  return [...container.querySelectorAll('.op-seg .op-seg-btn')].map((el) => el.textContent ?? '')
}

/** 页面 hint 文案（PageHead 的 <p>）。 */
function hintText(): string {
  return container.querySelector('.op-page-head p')?.textContent ?? ''
}

/** 单个时点的取证串：断言失败时直接给出「那一帧长什么样」，作为闪烁证据。 */
function paintEvidence(label: string): string {
  return [
    `${label}：`,
    `真实卡片=${JSON.stringify(cardNames())}`,
    `真实卡片数=${realCards().length}`,
    `骨架数=${skeletonCount()}`,
    `tab=${JSON.stringify(tabLabels())}`,
    `hint=${JSON.stringify(hintText())}`,
  ].join(' ')
}

/** 非空名字集合（用于 MutationObserver 快照）。 */
function nonEmptyNames(): Set<string> {
  return new Set(cardNames().map((name) => name.trim()).filter((name) => name.length > 0))
}

/** 卸载当前 root 并用新容器重新挂载（用于模拟「重复进入页面」）。 */
async function remount(): Promise<void> {
  await act(async () => { root.unmount() })
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}

beforeEach(() => {
  // 模块级缓存跨用例共享：每个用例从「无缓存」的冷启动开始，保证首帧断言可重复。
  resetConnectorsSnapshotForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  resetConnectorsSnapshotForTests()
})

describe('连接器页首帧不闪烁（异步数据返回前只显示骨架）', () => {
  it('首帧不得出现任何真实卡片，也不得出现注册表兜底连接器；数据返回后才单次提交 catalog', async () => {
    const gate = installNxcore()

    // ── 首帧：四个异步接口全部挂起（真实数据尚未返回） ──
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })

    const firstPaint = cardNames()
    expect(
      realCards().length,
      `首帧即渲染了 ${realCards().length} 张真实卡片（应为 0 张，只显示骨架）。` +
      `这就是「闪烁一下」的直接证据：${paintEvidence('首帧')}`,
    ).toBe(0)
    expect(
      container.querySelectorAll('.op-conn-card'),
      `首帧 .op-conn-card（真实卡片）数量必须为 0；骨架卡已改为纯 .op-conn-skel-card 类，` +
      `不能再共用真实卡片 class：${paintEvidence('首帧')}`,
    ).toHaveLength(0)
    expect(
      firstPaint,
      `首帧不得有任何连接器名字（.op-conn-name 只属于真实卡片）：${paintEvidence('首帧')}`,
    ).toEqual([])
    expect(
      firstPaint.filter((name) => REGISTRY_ONLY_NAMES.includes(name)),
      `首帧出现了 SaaS 未配置的注册表兜底连接器，说明目录仍在用注册表兜底冒充真实数据：${paintEvidence('首帧')}`,
    ).toEqual([])
    expect(
      skeletonCount(),
      `首帧应渲染 .op-conn-skel-* 骨架占位（布局稳定，避免后续内容跳动）：${paintEvidence('首帧')}`,
    ).toBeGreaterThan(0)

    // ── 筛选 tab / hint 计数在首帧也不得按注册表 7 个连接器计算（否则会跳变） ──
    for (const registryOnlyTab of ['日历', '文档与云盘', '通讯协作']) {
      expect(
        tabLabels(),
        `首帧筛选 tab 不得包含最终 catalog 没有的分类「${registryOnlyTab}」` +
        `（tab 收缩本身就是闪烁的一部分）：${paintEvidence('首帧')}`,
      ).not.toContain(registryOnlyTab)
    }
    expect(
      hintText(),
      `首帧 hint 使用了注册表兜底的 7 个连接器计数（已连接 x/7），数据返回后必然跳变：${paintEvidence('首帧')}`,
    ).not.toMatch(/\/\s*7/)

    // ── 异步数据返回：SaaS 只配置了 gmail，注册表里有 7 个（含未配置的） ──
    await resolveGateway(gate, {
      oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
    })

    const finalPaint = cardNames()
    expect(
      finalPaint,
      `数据返回后卡片应恰好等于 SaaS 配置的目录（仅 Gmail），不能残留/闪现注册表兜底项：${paintEvidence('终态')}`,
    ).toEqual(['Gmail'])
    expect(
      realCards().length,
      `终态只应有 1 张真实卡片：${paintEvidence('终态')}`,
    ).toBe(1)
    expect(
      tabLabels(),
      `终态分类 tab 应只包含 gmail 的「邮件」分类：${paintEvidence('终态')}`,
    ).toEqual(['全部', '邮件'])
    expect(
      skeletonCount(),
      `真实数据提交后骨架必须消失，不能卡死在骨架态：${paintEvidence('终态')}`,
    ).toBe(0)
    expect(
      gate.nxcore.nangoConnector.oauthConfigs,
      '目录来源 oauthConfigs 应至少被调用一次（目录不能只靠注册表）',
    ).toHaveBeenCalled()
    expect(
      gate.nxcore.nangoConnector.providers,
      '目录来源 providers 应至少被调用一次（真实注册表要合并进目录）',
    ).toHaveBeenCalled()
  })

  it('整个挂载过程中任何时刻都不闪现注册表兜底目录（MutationObserver 逐次取证）', async () => {
    const gate = installNxcore()

    /** 每次 DOM 变更后记录一次「当前页面上出现的连接器名集合」。 */
    const observedSnapshots: string[][] = []
    const observer = new MutationObserver(() => {
      observedSnapshots.push([...nonEmptyNames()])
    })
    observer.observe(container, { childList: true, subtree: true, characterData: true })

    try {
      await act(async () => {
        root.render(<ConnectorsView onToast={() => undefined} />)
      })
      // MutationObserver 回调在微任务里执行，可能晚于首个 act；首帧由 render
      // 同步提交，这里手动补录一次，确保「首帧」一定被纳入子集断言。
      observedSnapshots.push([...nonEmptyNames()])

      await resolveGateway(gate, {
        oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
      })

      // 让 MutationObserver 的最后一批回调落地后再汇总。
      await flush(2)
      observedSnapshots.push([...nonEmptyNames()])

      const finalNames = new Set(cardNames())
      expect(
        [...finalNames],
        `终态目录应只有 SaaS 配置的 Gmail：${paintEvidence('终态')}`,
      ).toEqual(['Gmail'])

      // 只要有任何一个快照出现「注册表兜底专属 provider」，就说明首帧/中间帧
      // 曾把兜底目录画到页面上——这就是用户看到的闪烁。
      for (const snapshot of observedSnapshots) {
        const illegal = snapshot.filter((name) => !finalNames.has(name))
        expect(
          illegal,
          `挂载过程中某次渲染出现了最终 catalog 之外的连接器 ${JSON.stringify(illegal)}；` +
          `快照序列=${JSON.stringify(observedSnapshots)}。注册表兜底目录一旦上屏就会造成闪烁。`,
        ).toEqual([])
      }
    } finally {
      observer.disconnect()
    }
  })

  it('重复进入用模块级缓存：第二次挂载首帧即真实卡片、无骨架', async () => {
    const gate = installNxcore()

    // 第一次进入（冷启动）：先骨架，数据返回后提交真实目录。
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    expect(realCards().length, `冷启动首帧不应有真实卡片：${paintEvidence('首次挂载首帧')}`).toBe(0)
    await resolveGateway(gate, {
      oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
    })
    expect(cardNames(), `首次进入数据返回后应显示真实目录：${paintEvidence('首次挂载终态')}`).toEqual(['Gmail'])

    // 成功快照应写入模块级缓存（这是「重复进入不闪」的前提）。
    expect(
      peekConnectorsSnapshot(),
      '成功加载的快照应写入模块级缓存，供下次进入直接命中',
    ).not.toBeNull()
    expect(
      peekConnectorsSnapshot()?.complete,
      '只有可信快照（complete=true）才能进缓存，否则会把失败兜底当首屏数据',
    ).toBe(true)

    // 第二次进入（缓存命中）：换一套「永不返回」的 gateway mock，
    // 这样首帧如果还能显示真实卡片，就只可能来自模块级缓存（而非异步数据瞬时返回）。
    installNxcore()
    await remount()
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })

    expect(
      cardNames(),
      `缓存命中时第二次进入的首帧就应是真实卡片（不能先骨架再闪成真实内容）：${paintEvidence('第二次挂载首帧')}`,
    ).toEqual(['Gmail'])
    expect(
      skeletonCount(),
      `缓存命中时首帧不应再出现骨架：${paintEvidence('第二次挂载首帧')}`,
    ).toBe(0)
  })

  it('账号切换清缓存：事件后再次进入不得沿用旧账号的目录（防止缓存串数据）', async () => {
    const gate = installNxcore()
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await resolveGateway(gate, {
      oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
    })
    expect(cardNames(), `暖缓存后应显示 Gmail：${paintEvidence('切换账号前')}`).toEqual(['Gmail'])
    expect(peekConnectorsSnapshot(), '暖缓存后应已有模块级缓存').not.toBeNull()

    // 账号切换（登录/注销/换号）：目录与连接清单可能整体变化，旧缓存必须失效。
    await act(async () => {
      window.dispatchEvent(new CustomEvent('everroom-account-status-changed'))
    })
    expect(
      peekConnectorsSnapshot(),
      '账号切换事件后必须清空模块级缓存，否则新账号首帧会先闪出旧账号的连接器目录',
    ).toBeNull()

    // 再次进入：换一套挂起 mock，首帧必须是骨架（不能复用旧账号缓存）。
    installNxcore()
    await remount()
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    expect(
      realCards().length,
      `账号切换后再次进入的首帧不得是旧账号的真实目录：${paintEvidence('切换账号后首帧')}`,
    ).toBe(0)
    expect(
      skeletonCount(),
      `账号切换后未拿到新数据前应显示骨架：${paintEvidence('切换账号后首帧')}`,
    ).toBeGreaterThan(0)
  })

  it('账号切换竞态：旧账号在途结果不得写回缓存（generation 丢弃后按新账号重拉）', async () => {
    // 账号 A：四个网关调用全部挂起（在途请求已发出）。
    const gateA = installNxcore()
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    expect(
      cardNames(),
      `账号 A 数据未返回时应保持骨架：${paintEvidence('A 在途首帧')}`,
    ).toEqual([])

    // A 的请求还没回来时切换账号：AccountContext 派发同名事件 →
    // loader 清缓存并递增代际（之后 A 的结果必须被丢弃）。
    await act(async () => {
      window.dispatchEvent(new CustomEvent('everroom-account-status-changed', {
        detail: { authenticated: false, apiBaseUrl: '' },
      }))
    })
    // 主进程桥换成账号 B；loader 因代际变化重拉时必须读取新的 window.nxcore。
    const gateB = installNxcore()
    expect(peekConnectorsSnapshot(), '账号切换后旧缓存应已清空').toBeNull()

    // 旧账号 A 的结果现在才返回。
    await resolveGateway(gateA, {
      oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
    })
    expect(
      peekConnectorsSnapshot(),
      '旧账号 A 的在途结果不得写回缓存；否则账号 B 下次进入首帧会先闪旧目录再被纠正（竞态 bug）',
    ).toBeNull()
    expect(
      cardNames(),
      `旧账号 A 的目录也不得上屏（无论走缓存还是渲染都会造成闪烁）：${paintEvidence('A 结果返回后')}`,
    ).toEqual([])
    expect(
      skeletonCount(),
      `等待新账号重拉期间应保持骨架，不能回退到旧账号内容：${paintEvidence('A 结果返回后')}`,
    ).toBeGreaterThan(0)

    // 新账号 B 的数据返回：单次提交，缓存与页面都必须是 B 的内容。
    await resolveGateway(gateB, {
      oauthConfigs: [{ provider: 'notion', displayName: null, iconUrl: null }],
    })
    const snapshot = peekConnectorsSnapshot()
    expect(snapshot, '账号 B 的可信快照应写入缓存').not.toBeNull()
    expect(snapshot?.complete, '账号 B 的快照应是可信快照（complete=true）').toBe(true)
    expect(
      snapshot?.oauthCatalog,
      '缓存里的目录必须是账号 B 的 notion，不能是账号 A 的 gmail',
    ).toEqual([{ provider: 'notion', displayName: null, iconUrl: null }])
    expect(
      cardNames(),
      `页面应显示账号 B 的目录（Notion）：${paintEvidence('B 数据返回后')}`,
    ).toEqual(['Notion'])
    expect(
      skeletonCount(),
      `账号 B 数据提交后骨架必须结束：${paintEvidence('B 数据返回后')}`,
    ).toBe(0)
  })

  it('oauthConfigs=null（local 模式）→ 最终回落注册表全量，且不会永久停在骨架', async () => {
    const gate = installNxcore()

    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })

    // 数据未返回：仍然只允许骨架，不允许提前用注册表兜底目录上屏。
    expect(
      realCards().length,
      `首帧不得提前渲染注册表目录：${paintEvidence('首帧')}`,
    ).toBe(0)

    await resolveGateway(gate, { oauthConfigs: null })

    const names = cardNames()
    expect(
      names,
      `local 模式（oauthConfigs=null）最终应回落注册表全量 7 个连接器，不能卡在骨架或空目录：${paintEvidence('终态')}`,
    ).toHaveLength(7)
    expect(names, '回落注册表时 Gmail 必须在').toContain('Gmail')
    expect(names, '回落注册表时 Notion 必须在').toContain('Notion')
    expect(names, '回落注册表时 飞书 必须在').toContain('飞书')
    expect(
      skeletonCount(),
      `拿到 null 结果后骨架必须结束：${paintEvidence('终态')}`,
    ).toBe(0)
  })

  it('gateway 失败：有限重试后出现兜底内容（不永久停骨架），且失败快照不写缓存', async () => {
    vi.useFakeTimers()
    const gate = installNxcore()

    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    expect(realCards().length, `数据未返回时不应有真实卡片：${paintEvidence('首帧')}`).toBe(0)
    expect(skeletonCount(), '数据未返回时应显示骨架').toBeGreaterThan(0)

    // providers/status/oauthConfigs 全部失败（网关还没起来）。
    await act(async () => {
      gate.providersDeferred.reject(new Error('gateway not ready'))
      gate.statusDeferred.reject(new Error('gateway not ready'))
      gate.oauthConfigsDeferred.reject(new Error('gateway not ready'))
      gate.agentAuthStatusDeferred.resolve({ feishu: null, activeChallenge: null })
      await Promise.resolve()
    })

    // 视图对失败快照做有限次短重试（3 × 700ms）后才退回兜底内容：
    // 用假定时器精确推进虚拟时间，避免真实 sleep 导致的 flaky。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(
      skeletonCount(),
      `有限重试后不应永久停在骨架（用户会看到永远加载不出来的页面）：${paintEvidence('失败兜底终态')}`,
    ).toBe(0)
    expect(
      cardNames(),
      `重试耗尽后应退回注册表兜底内容（gmail/notion 等），而不是空页面：${paintEvidence('失败兜底终态')}`,
    ).toContain('Gmail')
    expect(
      peekConnectorsSnapshot(),
      '失败兜底快照（complete=false）不得写缓存，否则下次进入会把兜底目录当首屏数据、再被真实数据纠正 → 又一次闪烁',
    ).toBeNull()
  })

  it('桥方法同步 throw（旧 preload 桩）→ 不整体 reject、不永久骨架，catalog 仍生效', async () => {
    vi.useFakeTimers()
    const gate = installNxcore()
    // providers 同步抛异常（而非返回 rejected promise）：loader 已用
    // Promise.resolve().then 包裹，异常必须走 allSettled 的失败分支。
    gate.nxcore.nangoConnector.providers.mockImplementation(() => {
      throw new Error('sync bridge boom')
    })

    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    expect(realCards().length, `数据未返回时不应有真实卡片：${paintEvidence('首帧')}`).toBe(0)

    // 其余三路正常返回，只有 providers 同步抛。
    const { status, agentAuthStatus } = buildGatewayResponses({
      oauthConfigs: [{ provider: 'gmail', displayName: null, iconUrl: null }],
    })
    await act(async () => {
      gate.statusDeferred.resolve(status)
      gate.oauthConfigsDeferred.resolve([{ provider: 'gmail', displayName: null, iconUrl: null }])
      gate.agentAuthStatusDeferred.resolve(agentAuthStatus)
      await Promise.resolve()
    })

    // 失败快照 → 有限重试（3 × 700ms）后提交兜底内容。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(
      skeletonCount(),
      `providers 同步 throw 不能让页面永久停在骨架：${paintEvidence('同步 throw 终态')}`,
    ).toBe(0)
    expect(
      cardNames(),
      `providers 失败不应连累 catalog：目录仍应来自 oauthConfigs 的 gmail（注册表只兜底元数据）：${paintEvidence('同步 throw 终态')}`,
    ).toEqual(['Gmail'])
    expect(
      peekConnectorsSnapshot(),
      '含失败兜底的快照（complete=false）不得写缓存',
    ).toBeNull()
  })
})