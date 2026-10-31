// @vitest-environment happy-dom
/**
 * 回归：渲染层迁移到 everoffice 原型外壳（OfficeProto）后，两个「旧桌面端入口」
 * 不能在迁移里被丢掉——
 *
 * 1) 设置页入口：侧栏账户栏的齿轮按钮（`.op-userbar`，aria-label="账户与设置"）
 *    必须真的打开覆盖层设置页（`SettingsView` 内真实渲染旧的
 *    `@/components/pages/SettingsPage`），且「返回」按钮能关掉覆盖层；
 * 2) 启动登录 gate：未登录 + runtime config 未就绪时，`RuntimeConfigGate` 必须停在
 *    登录入口（Apple/Google OIDC + 手机扫码 QR），而不是把未登录用户放进应用外壳。
 *
 * 这里用 happy-dom + react-dom/client + act 真实渲染组件树，只 mock preload 桥
 * `window.nxcore`：SettingsPage / AccountProvider / QrLoginPanel 的真实 effects 会调用
 * 账号、设备、中转、更新、runtime config 等接口，必须给出最小可用的返回，
 * 否则会出现未捕获异常或 act 告警。
 *
 * 参考 tests/office-proto-real-file-open.test.tsx（同样的 happy-dom + createRoot 写法）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeConfigGate } from '../src/renderer/src/components/onboarding/RuntimeConfigGate'
import i18n from '../src/renderer/src/i18n/i18next'
import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { OfficeProto } from '../src/renderer/src/office-proto/OfficeProto'
import { AccountProvider } from '../src/renderer/src/state/AccountContext'
import type { CloudAccountStatus, RuntimeConfigSnapshot } from '../src/shared/sources'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SIGNED_IN_ACCOUNT: CloudAccountStatus = {
  authenticated: true,
  apiBaseUrl: 'https://api.everroom.test',
  user: { id: 'user-qa', tenantId: 'tenant-qa', email: 'qa@everroom.test', name: 'QA Tester' },
  device: { id: 'device-qa', name: 'QA Mac', platform: 'darwin' },
  subscription: {
    status: 'active',
    planCode: 'pro',
    planName: 'Pro',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    quotaSeconds: 3600,
    usedSeconds: 600,
    remainingSeconds: 3000,
  },
}

const SIGNED_OUT_ACCOUNT: CloudAccountStatus = {
  authenticated: false,
  apiBaseUrl: '',
}

const KEYRING_STATUS = {
  enabled: true,
  initialized: true,
  umkId: 'umk-qa',
  activeVersion: 1,
  deviceStatus: 'ready' as const,
  verificationCode: null,
}

function runtimeSnapshot(primaryConfigured: boolean): RuntimeConfigSnapshot {
  return {
    config: {},
    userConfig: primaryConfigured
      ? {
          primary: {
            provider: 'openai-compatible',
            model: 'gpt-4o-mini',
            baseUrl: 'https://api.example.com/v1',
            apiKey: '********',
          },
        }
      : null,
    source: 'default',
    selectedSource: 'default',
    availableSources: ['user', 'default'],
    configVersion: 1,
    updatedAt: '2026-10-28T00:00:00.000Z',
    primaryConfigured,
  }
}

interface NxcoreOptions {
  account: CloudAccountStatus
  snapshot: RuntimeConfigSnapshot
  /**
   * 让 runtimeConfig.get 比 account.status 晚一拍返回（真实 IPC 竞态里很常见）：
   * gate 首次判定时登录态已经落定，才能稳定走到「未登录 → login」分支，而不是
   * 走 2s 宽限重查。测试因此不需要 fake timers / 真等 2 秒。
   */
  deferRuntimeConfig?: boolean
}

/** 安装最小可用的 preload 桥 mock；返回句柄供断言调用。 */
function installNxcore({ account, snapshot, deferRuntimeConfig = false }: NxcoreOptions) {
  const runtimeGet = vi.fn(() => deferRuntimeConfig
    ? new Promise<RuntimeConfigSnapshot>((resolve) => {
        window.setTimeout(() => resolve(snapshot), 50)
      })
    : Promise.resolve(snapshot))

  const nxcore = {
    platform: 'darwin',
    locale: {
      system: 'zh-CN',
      getSystem: vi.fn().mockResolvedValue('zh-CN'),
      set: vi.fn(),
    },
    account: {
      status: vi.fn().mockResolvedValue(account),
      devices: vi.fn().mockResolvedValue([]),
      keyringStatus: vi.fn().mockResolvedValue(KEYRING_STATUS),
      onAdmissionRequired: vi.fn().mockReturnValue(() => undefined),
      loginWithOidc: vi.fn().mockResolvedValue(account),
      cancelOidcLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(SIGNED_OUT_ACCOUNT),
      createQrLoginSession: vi.fn().mockRejectedValue(new Error('not used in this test')),
      getQrLoginStatus: vi.fn().mockRejectedValue(new Error('not used in this test')),
      cancelQrLoginSession: vi.fn().mockResolvedValue(undefined),
    },
    aiRelay: {
      status: vi.fn().mockResolvedValue(null),
      verdict: vi.fn().mockResolvedValue({ quotaExhausted: false }),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    },
    updater: {
      getStatus: vi.fn().mockResolvedValue({
        version: '0.1.9',
        channel: 'stable',
        installId: 'install-qa',
        supported: true,
      }),
      onProgress: vi.fn().mockReturnValue(() => undefined),
      onDownloaded: vi.fn().mockReturnValue(() => undefined),
      onError: vi.fn().mockReturnValue(() => undefined),
      checkNow: vi.fn().mockResolvedValue('no-update'),
    },
    cliConnector: {
      mode: vi.fn().mockResolvedValue({ mode: 'saas', switchedAt: null }),
      setMode: vi.fn().mockResolvedValue({ mode: 'saas', switchedAt: null }),
    },
    runtimeConfig: {
      get: runtimeGet,
      saveUser: vi.fn(async () => snapshot),
      clearUser: vi.fn(async () => snapshot),
      relayReady: vi.fn().mockResolvedValue(snapshot),
      selectSource: vi.fn(async () => snapshot),
      test: vi.fn().mockResolvedValue({ valid: true }),
    },
    agent: {
      getUsage: vi.fn().mockResolvedValue({
        provider: 'piagent',
        model: 'gpt-4o-mini',
        range: '7d',
        inputTokens: 1200,
        outputTokens: 800,
        cacheHitTokens: 200,
        points: [],
        updatedAt: '2026-10-28T00:00:00.000Z',
      }),
      discoverLocalAgents: vi.fn().mockResolvedValue([]),
    },
    mcp: {
      listServers: vi.fn().mockResolvedValue({ configPath: '/tmp/mcp.json', servers: {} }),
      saveServers: vi.fn().mockResolvedValue({ configPath: '/tmp/mcp.json', servers: {} }),
    },
    files: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    },
  }

  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

let container: HTMLDivElement
let root: Root

/** 推进若干轮宏任务（每轮都在 act 里），让真实 effects / promise 链跑完。 */
async function flush(rounds = 8, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function render(element: React.ReactElement): Promise<void> {
  return act(async () => { root.render(element) })
}

beforeAll(async () => {
  // i18next 的 init 内部用 setTimeout(0)；translate() 在未初始化时会抛错，
  // 所以先等它真正 ready（LocaleProvider 引入的就是这个实例）。
  if (i18n.isInitialized) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500)
    i18n.once('initialized', () => {
      clearTimeout(timer)
      resolve()
    })
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // happy-dom 没有布局/媒体查询：给原型外壳里用到 matchMedia 的地方一个稳定返回。
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  // 故意保留 window.nxcore：AccountProvider 在未登录时会排一个 8s 兜底重查 timer，
  // 卸载后若桥突然消失，它会以「Cannot read properties of undefined」冒成未捕获异常。
})

afterAll(() => {
  delete (window as unknown as { nxcore?: unknown }).nxcore
})

describe('迁移后的设置页入口', () => {
  it('点击侧栏账户栏齿轮打开设置覆盖层，返回按钮关闭', async () => {
    installNxcore({ account: SIGNED_IN_ACCOUNT, snapshot: runtimeSnapshot(true) })

    await render(
      <LocaleProvider>
        <AccountProvider>
          <OfficeProto />
        </AccountProvider>
      </LocaleProvider>,
    )
    await flush(6)

    const userbar = container.querySelector<HTMLButtonElement>('.op-userbar')
    expect(userbar, '侧栏应渲染账户与设置按钮').not.toBeNull()
    expect(userbar!.getAttribute('aria-label')).toBe('账户与设置')
    expect(userbar!.getAttribute('aria-haspopup')).toBe('dialog')
    // AccountProvider 真实接入：按钮显示已登录账号名（而不是「登录 / 设置」）。
    expect(userbar!.textContent).toContain('QA Tester')
    expect(container.querySelector('.op-settings-view'), '设置页初始应关闭').toBeNull()

    await act(async () => { userbar!.click() })
    await flush(6)

    const overlay = container.querySelector<HTMLElement>('.op-settings-view')
    expect(overlay, '点齿轮应打开设置覆盖层').not.toBeNull()
    expect(overlay!.getAttribute('role')).toBe('dialog')

    // 设置页本体是真实渲染的旧 SettingsPage（不是占位），账号区块必须在。
    expect(container.querySelector('.page.settings-page')).not.toBeNull()
    expect(container.querySelector('#settings-account'), '设置页账号区块应存在').not.toBeNull()
    expect(container.querySelector('#settings-account')!.textContent).toContain('qa@everroom.test')

    const back = container.querySelector<HTMLButtonElement>('.op-settings-back')
    expect(back, '设置覆盖层应提供返回按钮').not.toBeNull()
    await act(async () => { back!.click() })
    await flush(4)

    expect(container.querySelector('.op-settings-view'), '点返回后设置覆盖层应关闭').toBeNull()
  })
})

describe('未登录启动 gate', () => {
  it('未登录 + runtime config 未就绪：停在登录入口，不放行应用外壳', async () => {
    const nxcore = installNxcore({
      account: SIGNED_OUT_ACCOUNT,
      snapshot: runtimeSnapshot(false),
      deferRuntimeConfig: true,
    })

    await render(
      <LocaleProvider>
        <AccountProvider>
          <RuntimeConfigGate>
            <div data-testid="app-shell">已进入应用</div>
          </RuntimeConfigGate>
        </AccountProvider>
      </LocaleProvider>,
    )
    await flush(14)

    const gate = container.querySelector<HTMLElement>('.runtime-config-gate')
    expect(gate, '未登录时应渲染启动 gate').not.toBeNull()
    expect(gate!.getAttribute('data-mode'), '未登录且配置未就绪应落在 login 态').toBe('login')

    // 登录入口：标题 + Apple/Google OIDC 按钮 + 真实 QrLoginPanel 的手机扫码入口。
    expect(container.querySelector('.runtime-config-gate-login-heading')!.textContent)
      .toContain('登录 EverRoom 账号')
    expect(container.querySelector('.runtime-config-gate-apple-login')!.textContent)
      .toContain('通过 Apple 登录')
    expect(container.querySelector('.runtime-config-gate-google-login')!.textContent)
      .toContain('使用 Google 账号登录')
    expect(container.querySelector('.qr-login-entry-button')!.textContent)
      .toContain('手机扫码登录')

    // 未登录用户不能被放进应用外壳。
    expect(container.querySelector('[data-testid="app-shell"]')).toBeNull()
    // 未登录是问过主进程账号状态得出的，不是凭空判定的。
    expect(nxcore.account.status).toHaveBeenCalled()
  })
})
