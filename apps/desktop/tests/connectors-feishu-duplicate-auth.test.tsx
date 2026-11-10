// @vitest-environment happy-dom
/**
 * 回归：飞书连接器「一次点击只发起一次授权、只打开一次授权页」。
 *
 * 症状（用户报告）：点击「连接」后发起了两个请求，连接器无法正常连接。
 * 链路：ConnectorsView.connectFeishu → agentAuth.start（主进程 lark-cli 设备码）
 * + 渲染层 window.open（主窗口 setWindowOpenHandler 转系统浏览器）。
 * 主进程 AgentAuthController 在 verificationUrl 首次出现时还会通过
 * onVerificationUrl 自动 openExternalUrl —— 两边各开一次 = 同一授权页打开两次。
 *
 * 本文件钉住渲染层职责：
 * 1) 一次点击只调用一次 agentAuth.start（StrictMode 双挂载/双击不再发起第二个流程）；
 * 2) 授权页最多 window.open 一次（后续轮询看到同一 URL 不重复打开）；
 * 3) 主进程已自动开浏览器时（start 返回的 challenge 带 verificationUrl 且主进程
 *    已回调 onVerificationUrl），渲染层不再二次打开。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsView } from '../src/renderer/src/office-proto/pages/ConnectorsView'
import { resetConnectorsSnapshotForTests } from '../src/renderer/src/office-proto/pages/connectorsData'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush(rounds = 6, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

const REGISTRY = [
  { provider: 'gmail', dataTypes: ['mail'] },
  { provider: 'feishu', dataTypes: ['document'] },
]
const CATALOG = [
  { provider: 'gmail', displayName: null, iconUrl: null },
  { provider: 'feishu', displayName: null, iconUrl: null },
]

function feishuChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'challenge-1',
    provider: 'feishu',
    phase: 'user_auth',
    status: 'pending',
    reason: 'not_connected',
    title: '授权飞书账号',
    verificationUrl: 'https://open.feishu.cn/device?code=abc',
    steps: [],
    exportRunId: null,
    message: null,
    startedAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  }
}

/** 模拟主进程行为：start() 发起授权；onVerificationUrl 自动开浏览器。 */
function installNxcore(options: {
  startChallenge?: Record<string, unknown> | null
  /** 主进程是否已在 URL 出现时自动打开系统浏览器（真实行为：是）。 */
  mainAutoOpens?: boolean
}) {
  const start = vi.fn().mockImplementation(() => Promise.resolve(
    options.startChallenge === null ? null : feishuChallenge(options.startChallenge),
  ))
  const nxcore = {
    nangoConnector: {
      providers: vi.fn().mockResolvedValue({
        enabled: true,
        providers: REGISTRY.map((p) => ({
          provider: p.provider,
          label: p.provider,
          category: 'docs' as const,
          iconKey: p.provider,
          dataTypes: p.dataTypes,
          authChannel: 'nango-oauth' as const,
          connected: false,
          comingSoon: false,
        })),
      }),
      status: vi.fn().mockResolvedValue({ enabled: true, connections: [], disconnected: [], scopes: [], runs: [] }),
      oauthConfigs: vi.fn().mockResolvedValue(CATALOG),
      startAuthorization: vi.fn(),
      authorizationStatus: vi.fn(),
      purgeConnection: vi.fn(),
      reconnectConnection: vi.fn(),
    },
    agentAuth: {
      status: vi.fn().mockImplementation(() => Promise.resolve({
        feishu: {
          cliState: 'ready',
          cliPath: '/usr/local/bin/lark-cli',
          appConfigured: true,
          userAuthorized: false,
          userName: null,
          message: null,
        },
        activeChallenge: options.startChallenge === null ? null : feishuChallenge(options.startChallenge),
      })),
      start,
      resume: vi.fn(),
      cancel: vi.fn(),
      disconnect: vi.fn().mockResolvedValue({ feishu: {}, activeChallenge: null }),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    },
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

beforeEach(() => {
  resetConnectorsSnapshotForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

async function openFeishuDrawerAndConnect(): Promise<ReturnType<typeof installNxcore>> {
  const nxcore = installNxcore({})
  await act(async () => {
    root.render(<ConnectorsView onToast={() => undefined} />)
  })
  await flush()

  const feishuCard = [...container.querySelectorAll('.op-conn-card')]
    .find((card) => card.querySelector('.op-conn-name')?.textContent === '飞书')
  await act(async () => { feishuCard?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush(2)

  const connectBtn = [...container.querySelectorAll('button')]
    .find((btn) => btn.textContent?.trim() === '连接')
  expect(connectBtn, '抽屉里有连接按钮').toBeTruthy()
  await act(async () => { connectBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush(3)
  return nxcore
}

describe('飞书连接器：一次点击只发起一次授权', () => {
  it('点击「连接」只调用一次 agentAuth.start', async () => {
    const nxcore = await openFeishuDrawerAndConnect()
    expect(nxcore.agentAuth.start, 'start 只被调用一次').toHaveBeenCalledTimes(1)
    expect(nxcore.agentAuth.start).toHaveBeenCalledWith({ provider: 'feishu' })
  })

  it('渲染层不自动 window.open 授权页（主进程 onVerificationUrl 已自动打开，双开=用户看到两个授权请求）', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
    await openFeishuDrawerAndConnect()
    // 轮询多个周期，确保「稍后出现的 URL」也不会触发渲染层补开。
    await flush(4)
    const authUrls = windowOpen.mock.calls
      .map((call) => call[0])
      .filter((url) => typeof url === 'string' && url.includes('open.feishu.cn'))
    expect(authUrls, '渲染层绝不自动打开授权页（主进程负责）').toHaveLength(0)
  })
})
