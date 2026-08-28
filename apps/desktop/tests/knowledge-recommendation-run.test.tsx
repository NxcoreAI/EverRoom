import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => (
        actual.translate('zh-CN', message, values)
      ),
    }),
  }
})

import { showToast } from '@/state/toast'
import { KnowledgePendingPanel } from '../src/renderer/src/components/context-room/ported/components/KnowledgePendingPanel'
import { ROOM_RECOMMENDATION_RUN_EVENT } from '../src/renderer/src/components/context-room/ported/roomRecommendationRun'

if (typeof CustomEvent === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CustomEvent = class CustomEvent<T> {
    constructor(public type: string, public detail?: T) {}
  }
}

interface DecisionFixture {
  decisionId: string
  sourceKind: string
  sourceId: string
  title: string
  status: string
}

interface OutcomeFixture {
  filename: string
  fileId: string | null
  error: string | null
}

function entityFixture(id: string, status: 'weak' | 'ready') {
  return {
    id,
    name: '汇编语言',
    kind: '主题',
    status,
    roomId: null,
    evidenceScore: 2.2,
    sourceCount: 2,
    eligibleSourceCount: 2,
    trustedSourceCount: 2,
    strongSourceCount: 2,
    readinessPath: 'strong',
    sourceKinds: ['file'],
    excludedSourceCount: 0,
    firstEvidence: '两份讲义均以汇编语言为主题',
    lastLinkedAt: null,
    // 未来时间戳：确保计入会话开始后的“新抽取”实体
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
    promotion: null,
  }
}

interface ProgressEventFixture {
  status: 'started' | 'file-started' | 'file-completed' | 'completed'
  total: number
  completed: number
  filename: string | null
}

/**
 * 真实 EventTarget 交接事件；导入/决策/实体池由测试翻转，模拟提交后
 * 「导入 → 路由落库 → 实体证据累积 → 达阈值出推荐」的原有机制。
 * failImports：导入前 N 次网络失败（验证自动重试）。
 */
function installBridge(importOutcomes: OutcomeFixture[], failImports = 0) {
  const target = new EventTarget()
  let decisions: DecisionFixture[] = []
  let readyVisible = false
  let importCalls = 0
  let resolveImport!: (value: OutcomeFixture[]) => void
  const knowledge = {
    listEntities: vi.fn((status: string) => {
      if (status === 'ready') return Promise.resolve({ items: readyVisible ? [entityFixture('r-1', 'ready')] : [] })
      if (status === 'weak') return Promise.resolve({ items: [entityFixture('w-1', 'weak')] })
      return Promise.resolve({ items: [] })
    }),
    // 按 sourceId 直查（任意状态）——与 gateway /v1/knowledge/route-status 同语义
    routeStatus: vi.fn((sourceIds: string[]) => Promise.resolve({
      items: sourceIds
        .filter((id) => decisions.some((decision) => decision.sourceId === id))
        .map((id) => {
          const decision = decisions.find((item) => item.sourceId === id)!
          return {
            sourceId: id,
            status: decision.status,
            title: decision.title,
            updatedAt: new Date().toISOString(),
          }
        }),
    })),
    listRecentDecisions: vi.fn(() => Promise.resolve({ items: decisions })),
    promoteEntities: vi.fn((entityIds: string[]) => Promise.resolve({
      items: entityIds.map((entityId) => ({ entityId, status: 'queued', jobId: `job-${entityId}`, error: null })),
    })),
    suppressEntities: vi.fn((entityIds: string[]) => Promise.resolve({
      items: entityIds.map((entityId) => ({ entityId, status: 'suppressed', error: null })),
    })),
  }
  let progressListener: ((event: ProgressEventFixture) => void) | null = null
  const files = {
    importPaths: vi.fn(() => {
      importCalls += 1
      if (importCalls <= failImports) return Promise.reject(new Error('network down'))
      return new Promise<OutcomeFixture[]>((resolve) => { resolveImport = resolve })
    }),
    onImportProgress: vi.fn((listener: (event: ProgressEventFixture) => void) => {
      progressListener = listener
      return () => { progressListener = null }
    }),
  }
  const storage = new Map<string, string>()
  const tickers: Array<() => void> = []
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: EventListener) => target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListener) => target.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
    setInterval: vi.fn((fn: () => void) => { tickers.push(fn); return tickers.length }),
    clearInterval: vi.fn(),
    setTimeout: (fn: () => void) => { fn(); return 0 },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    nxcore: { knowledge, files },
  })
  const flush = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  return {
    knowledge,
    files,
    storage,
    runKey: 'everroom:room-recommendation-run',
    tickers,
    flush,
    startRun: (intent: string | null = '汇编语言课程设计') => target.dispatchEvent(new CustomEvent(ROOM_RECOMMENDATION_RUN_EVENT, {
      detail: { paths: ['/docs/讲义.md', '/docs/实验.md'], intent },
    })),
    settleImport: () => resolveImport(importOutcomes),
    emitProgress: (event: ProgressEventFixture) => progressListener?.(event),
    route: (sourceId: string, title: string, status = 'awaiting_review') => {
      decisions = [...decisions, { decisionId: `d-${sourceId}`, sourceKind: 'file', sourceId, title, status }]
    },
    revealReady: () => { readyVisible = true },
  }
}

const okOutcomes: OutcomeFixture[] = [
  { filename: '讲义.md', fileId: 'file-1', error: null },
  { filename: '实验.md', fileId: 'file-2', error: null },
]

describe('KnowledgePendingPanel：推荐生成会话（整卡蒙层，真实机制驱动）', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  const render = async () => {
    await act(async () => {
      renderer = TestRenderer.create(<KnowledgePendingPanel onFocusAgent={vi.fn()} onOpenCreateRoom={() => {}} />)
      await Promise.resolve()
    })
    return renderer!.root
  }

  it('提交后：导入→路由→累积逐步推进，新推荐落池时撤蒙层并提示', async () => {
    const bridge = installBridge(okOutcomes)
    const root = await render()
    expect(root.findAllByProps({ 'data-testid': 'context-room-recommendation-run' })).toHaveLength(0)

    // 提交：蒙层出现（导入阶段），importPaths 收到暂存路径
    await act(async () => {
      bridge.startRun()
      await bridge.flush()
    })
    expect(bridge.files.importPaths).toHaveBeenCalledWith(['/docs/讲义.md', '/docs/实验.md'])
    let overlay = root.findByProps({ 'data-testid': 'context-room-recommendation-run' })
    expect(overlay.props['data-phase']).toBe('importing')
    expect(JSON.stringify(renderer!.toJSON())).toContain('正在围绕「汇编语言课程设计」生成 Room 推荐')

    // 导入进度事件驱动 1/2
    await act(async () => {
      bridge.emitProgress({ status: 'started', total: 2, completed: 0, filename: null })
      bridge.emitProgress({ status: 'file-completed', total: 2, completed: 1, filename: '讲义.md' })
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('导入中 1/2')

    // 导入完成：进入路由阶段；仅 file-1 落库 → 已解析 1/2
    bridge.route('file-1', '讲义.md')
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    overlay = root.findByProps({ 'data-testid': 'context-room-recommendation-run' })
    expect(overlay.props['data-phase']).toBe('routing')
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 1/2')

    // 全部落库但阈值未到：累积证据 + 候选实体数
    bridge.route('file-2', '实验.md')
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('accumulating')
    expect(JSON.stringify(renderer!.toJSON())).toContain('已抽取 1 个候选实体')

    // ready 实体落池（原有机制达阈值）：蒙层撤下 + toast 指路 + 推荐卡就位
    bridge.revealReady()
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(root.findAllByProps({ 'data-testid': 'context-room-recommendation-run' })).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '推荐已生成' }))
    expect(root.findAllByProps({ 'data-state': 'recommended' })).toHaveLength(1)
  })

  it('导入全部失败：蒙层转失败态，可重试导入或关闭恢复操作', async () => {
    const bridge = installBridge([{ filename: '讲义.md', fileId: null, error: '不可读' }])
    const root = await render()

    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    const overlay = root.findByProps({ 'data-testid': 'context-room-recommendation-run' })
    expect(overlay.props['data-phase']).toBe('failed')
    expect(JSON.stringify(renderer!.toJSON())).toContain('资料导入失败')

    const retry = root.findAllByType('button')
      .find((button) => button.props.className === 'context-room-knowledge-overlay-retry')
    expect(retry).toBeDefined()
    await act(async () => {
      retry!.props.onClick()
      await bridge.flush()
    })
    // 重试重新进入导入阶段（网络恢复后可续传）
    expect(bridge.files.importPaths.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('importing')

    // 仍然全失败 → 回到失败态，可关闭蒙层恢复操作
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('failed')
    const dismiss = root.findAllByType('button')
      .find((button) => button.props.className === 'context-room-knowledge-overlay-dismiss')
    act(() => dismiss!.props.onClick())
    expect(root.findAllByProps({ 'data-testid': 'context-room-recommendation-run' })).toHaveLength(0)
  })

  it('网络波动：导入自动重试后继续推进', async () => {
    const bridge = installBridge(okOutcomes, 2)
    const root = await render()

    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    // 前两次网络失败被自动重试吞掉，第三次进入真实导入
    expect(bridge.files.importPaths).toHaveBeenCalledTimes(3)
    bridge.route('file-1', '讲义.md')
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('routing')
  })

  it('部分失败显性化：蒙层显示成功/失败计数，聚合 toast 不逐文件刷屏', async () => {
    const bridge = installBridge([
      { filename: '讲义.md', fileId: 'file-1', error: null },
      { filename: '扫描件.pdf', fileId: null, error: 'PDF 无可提取文本，扫描件请先执行 OCR' },
    ])
    const root = await render()

    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    // 失败文件不进路由分母，成功文件继续推进
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('routing')
    expect(JSON.stringify(renderer!.toJSON())).toContain('已导入 1 项，1 项失败')
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已导入 1 项，1 项失败',
      message: '部分文件无法导入（扫描版 PDF 请先 OCR），其余文件继续生成推荐',
    }))
    const uploadTitles = (showToast as unknown as { mock: { calls: Array<[{
      title: string }]> } }).mock.calls.map(([toast]) => toast.title)
    expect(uploadTitles.filter((title) => title.includes('扫描件.pdf'))).toHaveLength(0)

    // 唯一成功文件落库即全部解析完成 → 累积阶段
    bridge.route('file-1', '讲义.md')
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('accumulating')
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 1/1')
  })

  it('无进度超时：路由与候选持续无增长才转超时，有推进则不误杀', async () => {
    const bridge = installBridge(okOutcomes)
    const root = await render()

    bridge.route('file-1', '讲义.md')
    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('routing')

    // 长时间路由与候选均无增长（决策队列卡死/网关失联）→ 无进度超时；
    // 半程（30 拍）不得提前转超时，避免路由积压（串行 LLM）被误杀。
    for (let tick = 0; tick < 30; tick += 1) {
      await act(async () => {
        bridge.tickers.forEach((fn) => fn())
        await bridge.flush()
      })
    }
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('routing')
    for (let tick = 0; tick < 30; tick += 1) {
      await act(async () => {
        bridge.tickers.forEach((fn) => fn())
        await bridge.flush()
      })
    }
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('timeout')
    expect(JSON.stringify(renderer!.toJSON())).toContain('资料已入库，证据仍在后台累积')

    // 超时可关闭蒙层恢复操作，清单同步清除
    const dismiss = root.findAllByType('button')
      .find((button) => button.props.className === 'context-room-knowledge-overlay-dismiss')
    act(() => dismiss!.props.onClick())
    expect(root.findAllByProps({ 'data-testid': 'context-room-recommendation-run' })).toHaveLength(0)
    expect(bridge.storage.has(bridge.runKey)).toBe(false)
  })

  it('已解析计数走 routeStatus：awaiting_review/auto 即计入，不依赖 confirmed', async () => {
    const bridge = installBridge(okOutcomes)
    const root = await render()

    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    // 网关已路由但等待用户确认（awaiting_review）——旧实现只看 confirmed 列表会永远 0
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 0/2')
    bridge.route('file-1', '讲义.md', 'awaiting_review')
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(bridge.knowledge.routeStatus).toHaveBeenCalledWith(['file-1', 'file-2'])
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 1/2')
  })

  it('旧网关无 routeStatus：回退 listRecentDecisions 匹配，计数仍推进', async () => {
    const bridge = installBridge(okOutcomes)
    delete (bridge.knowledge as { routeStatus?: unknown }).routeStatus
    const root = await render()

    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    bridge.route('file-1', '讲义.md', 'auto')
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(bridge.knowledge.listRecentDecisions).toHaveBeenCalled()
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 1/2')
  })

  it('状态持久化：应用重启后恢复会话进度并续跑到底', async () => {
    const bridge = installBridge(okOutcomes)
    let root = await render()

    // 推进到路由阶段后“重启应用”（卸载面板；localStorage 保留清单）
    bridge.route('file-1', '讲义.md')
    await act(async () => {
      bridge.startRun(null)
      await bridge.flush()
    })
    await act(async () => {
      bridge.settleImport()
      await bridge.flush()
    })
    expect(root.findByProps({ 'data-testid': 'context-room-recommendation-run' }).props['data-phase'])
      .toBe('routing')
    expect(bridge.storage.has(bridge.runKey)).toBe(true)
    act(() => renderer?.unmount())
    renderer = null

    // 重启：恢复蒙层（路由阶段不重跑导入），轮询续上
    root = await render()
    await act(async () => { await bridge.flush() })
    expect(bridge.files.importPaths).toHaveBeenCalledTimes(1)
    const overlay = root.findByProps({ 'data-testid': 'context-room-recommendation-run' })
    expect(overlay.props['data-phase']).toBe('routing')
    expect(JSON.stringify(renderer!.toJSON())).toContain('已解析 1/2')

    // 续跑到完成：蒙层撤下 + 清单清除
    bridge.route('file-2', '实验.md')
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    bridge.revealReady()
    await act(async () => {
      bridge.tickers.forEach((tick) => tick())
      await bridge.flush()
    })
    expect(root.findAllByProps({ 'data-testid': 'context-room-recommendation-run' })).toHaveLength(0)
    expect(bridge.storage.has(bridge.runKey)).toBe(false)
  })
})
