// @vitest-environment happy-dom
/**
 * 回归：连接器页目录 = SaaS 已配置 OAuth 的应用全集（真正可连接的），
 * 不再以网关注册表（只有查询档案内的 6 个服务）为准。
 *
 * 场景：
 * 1) SaaS 配置了网关注册表未收录的 provider（如 slack、未知 SaaS 直配应用）
 *    → 目录必须包含它们（SaaS 配置即可连接）；
 * 2) SaaS 一个都没配（明细为空数组）→ 目录空态，不回落注册表全量；
 * 3) oauthConfigs 不可用（null，local 模式）→ 回落网关注册表全量。
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

function installNxcore(options: {
  registryProviders?: Array<{ provider: string; dataTypes: string[] }>
  oauthConfigs?: Array<{ provider: string; displayName: string | null; iconUrl: string | null }> | string[] | null
  status?: {
    connections?: Array<{ provider: string; service: string; connectionName: string }>
    disconnected?: Array<{ service: string; connectionName: string }>
  }
  /** 飞书本机 lark-cli 授权状态（agentAuth.status 返回值）。 */
  feishuAuth?: {
    cliState: 'ready' | 'missing' | 'error' | 'unknown'
    appConfigured: boolean | null
    userAuthorized: boolean | null
    userName: string | null
    message?: string | null
  }
}) {
  const registry = options.registryProviders ?? [
    { provider: 'gmail', dataTypes: ['mail'] },
    { provider: 'notion', dataTypes: ['document'] },
  ]
  const nxcore = {
    nangoConnector: {
      providers: vi.fn().mockResolvedValue({
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
      }),
      status: vi.fn().mockResolvedValue({
        enabled: true,
        connections: (options.status?.connections ?? []).map((c) => ({
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
        disconnected: options.status?.disconnected ?? [],
        scopes: [],
        runs: [],
      }),
      oauthConfigs: vi.fn().mockResolvedValue(options.oauthConfigs),
      startAuthorization: vi.fn(),
      authorizationStatus: vi.fn(),
      purgeConnection: vi.fn(),
      reconnectConnection: vi.fn(),
    },
  }
  // 飞书凭据来自本机 lark-cli（agentAuth），与 nangoConnector 无关。
  const feishuAuth = options.feishuAuth ?? {
    cliState: 'ready' as const,
    appConfigured: true,
    userAuthorized: false,
    userName: null,
    message: null,
  }
  ;(nxcore as unknown as { agentAuth: unknown }).agentAuth = {
    status: vi.fn().mockResolvedValue({
      feishu: {
        cliState: feishuAuth.cliState,
        cliPath: '/usr/local/bin/lark-cli',
        appConfigured: feishuAuth.appConfigured,
        userAuthorized: feishuAuth.userAuthorized,
        userName: feishuAuth.userName,
        message: feishuAuth.message ?? null,
      },
      activeChallenge: null,
    }),
    start: vi.fn().mockResolvedValue({
      id: 'challenge-1',
      provider: 'feishu',
      phase: 'user_auth',
      status: 'pending',
      reason: 'not_connected',
      title: '授权飞书账号',
      verificationUrl: 'https://open.feishu.cn/device',
      steps: [],
      exportRunId: null,
      message: null,
      startedAt: new Date().toISOString(),
      expiresAt: null,
    }),
    resume: vi.fn(),
    cancel: vi.fn(),
    disconnect: vi.fn().mockResolvedValue({ feishu: {}, activeChallenge: null }),
    onEvent: vi.fn().mockReturnValue(() => undefined),
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

function cardNames(): string[] {
  return [...container.querySelectorAll('.op-conn-name')].map((el) => el.textContent ?? '')
}

/** 卡片状态徽标文案（title 属性承载三态语义）。 */
function cardStateTitles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const card of container.querySelectorAll('.op-conn-card')) {
    const name = card.querySelector('.op-conn-name')?.textContent ?? ''
    out[name] = card.querySelector('.op-conn-state')?.getAttribute('title') ?? ''
  }
  return out
}

beforeEach(() => {
  // 连接器数据层有模块级快照缓存：每个用例前清空，避免上一个用例的数据
  // 被当成这一用例的首帧（否则目录断言会互相污染）。
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

describe('连接器目录 = SaaS 已配置 OAuth 的应用全集', () => {
  it('SaaS 配置的未收录 provider（slack/未知应用）也出现在目录里', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: [
        { provider: 'gmail', displayName: null, iconUrl: null },
        { provider: 'slack', displayName: 'Slack', iconUrl: 'https://cdn.example.com/slack.png' },
        { provider: 'linear', displayName: 'Linear', iconUrl: null },
      ],
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const names = cardNames()
    expect(names, 'SaaS 配置即目录：注册表内的 gmail + 未收录的 slack/linear').toContain('Gmail')
    expect(names).toContain('Slack')
    expect(names).toContain('Linear')
    expect(names, '未配置的注册表 provider（notion）不在目录里').not.toContain('Notion')
  })

  it('SaaS 空明细（一个都没配）→ 目录空态，不回落注册表全量', async () => {
    installNxcore({
      registryProviders: [{ provider: 'gmail', dataTypes: ['mail'] }],
      oauthConfigs: [],
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    expect(cardNames(), '空明细 = 空目录').toEqual([])
  })

  it('oauthConfigs 不可用（null，local 模式）→ 回落网关注册表全量', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: null,
      status: {
        // local 模式下 oo 同样会把租户内所有凭据列出来（npm 等内部应用）。
        connections: [
          { provider: 'gmail', service: 'gmail', connectionName: 'default' },
          { provider: 'npm', service: 'npm', connectionName: 'default' },
        ],
      },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const names = cardNames()
    expect(names).toContain('Gmail')
    expect(names).toContain('Notion')
    expect(names, '内部凭据不生成卡片').not.toContain('npm')
    expect(names, '目录严格等于注册表').toHaveLength(2)
  })

  it('旧版主进程（string[] 名单）→ 按名单过滤注册表', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: ['gmail'],
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const names = cardNames()
    expect(names).toContain('Gmail')
    expect(names, '名单外的注册表 provider 不显示').not.toContain('Notion')
  })
})

describe('连接器三态（与 oo token 解耦）', () => {
  const CATALOG = [
    { provider: 'gmail', displayName: null, iconUrl: null },
    { provider: 'notion', displayName: null, iconUrl: null },
  ]

  it('oo 无 token → 未连接；有 token 且开启 → 已连接', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: CATALOG,
      status: {
        connections: [
          { provider: 'gmail', service: 'gmail', connectionName: 'default' },
        ],
      },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const states = cardStateTitles()
    expect(states.Gmail, 'oo 有 token 且开启').toBe('已连接')
    expect(states.Notion, 'oo 无 token').toBe('未连接')
  })

  it('oo 有 token 但被墓碑挡住 → 未开启（不再显示为已连接）', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: CATALOG,
      status: {
        connections: [],
        disconnected: [{ service: 'gmail', connectionName: 'default' }],
      },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const states = cardStateTitles()
    expect(states.Gmail, 'oo 有凭据但被关掉').toBe('未开启')
    expect(states.Notion).toBe('未连接')
    expect(cardNames(), '目录不被连接清单撑大（29 卡问题的回归）').toHaveLength(2)
  })

  it('未开启态的抽屉提供「开启」，点击走 reconnect（不动 oo token）', async () => {
    const nxcore = installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: CATALOG,
      status: {
        connections: [],
        disconnected: [{ service: 'gmail', connectionName: 'default' }],
      },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    // 打开 Gmail 卡片的抽屉
    const gmailCard = [...container.querySelectorAll('.op-conn-card')]
      .find((card) => card.querySelector('.op-conn-name')?.textContent === 'Gmail')
    await act(async () => { gmailCard?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(2)

    const enableBtn = container.querySelector('.op-conn-account-on')
    expect(enableBtn, '未开启账号行有「开启」按钮').toBeTruthy()
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(nxcore.nangoConnector.reconnectConnection).toHaveBeenCalledWith('gmail:default')
    expect(nxcore.nangoConnector.purgeConnection, '开启 ≠ 断开重连，不动墓碑以外的通道').not.toHaveBeenCalled()
  })

  it('oo 租户里非目录的凭据（npm 等）不生成卡片——目录严格等于 SaaS 配置', async () => {
    installNxcore({
      registryProviders: [
        { provider: 'gmail', dataTypes: ['mail'] },
        { provider: 'notion', dataTypes: ['document'] },
      ],
      oauthConfigs: CATALOG,
      status: {
        // oo GET /v1/apps 会把租户里所有服务凭据都列进来（连接器之外的内部凭据也在）。
        connections: [
          { provider: 'gmail', service: 'gmail', connectionName: 'default' },
          { provider: 'npm', service: 'npm', connectionName: 'default' },
          { provider: 'my-internal-svc', service: 'my-internal-svc', connectionName: 'default' },
        ],
      },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    const names = cardNames()
    expect(names, '只有 SaaS 配置的 2 个应用').toHaveLength(2)
    expect(names).toEqual(['Gmail', 'Notion'])
    expect(names, 'npm 等内部凭据不进连接器页').not.toContain('npm')
    expect(names).not.toContain('my-internal-svc')
  })
})

describe('飞书凭据走本机 lark-cli（不走 oo）', () => {
  const FEISHU_CATALOG = [
    { provider: 'gmail', displayName: null, iconUrl: null },
    { provider: 'feishu', displayName: null, iconUrl: null },
  ]
  const REGISTRY = [
    { provider: 'gmail', dataTypes: ['mail'] },
    { provider: 'feishu', dataTypes: ['document'] },
  ]

  it('lark-cli 未授权 → 未连接（即便 oo 里有 feishu 凭据）', async () => {
    installNxcore({
      registryProviders: REGISTRY,
      oauthConfigs: FEISHU_CATALOG,
      status: {
        // oo 侧残留的飞书连接不应影响飞书卡片状态。
        connections: [{ provider: 'feishu', service: 'feishu', connectionName: 'oo-default' }],
      },
      feishuAuth: { cliState: 'ready', appConfigured: true, userAuthorized: false, userName: null },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    expect(cardStateTitles()['飞书'], '凭据看 lark-cli，不看 oo').toBe('未连接')
  })

  it('lark-cli 已授权 → 已连接（显示 CLI 账号名）', async () => {
    installNxcore({
      registryProviders: REGISTRY,
      oauthConfigs: FEISHU_CATALOG,
      feishuAuth: { cliState: 'ready', appConfigured: true, userAuthorized: true, userName: '张三' },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    expect(cardStateTitles()['飞书']).toBe('已连接')

    const feishuCard = [...container.querySelectorAll('.op-conn-card')]
      .find((card) => card.querySelector('.op-conn-name')?.textContent === '飞书')
    await act(async () => { feishuCard?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush(2)
    expect(container.textContent).toContain('张三')
  })

  it('lark-cli 已授权但连接器被关闭 → 未开启（墓碑 feishu:default）', async () => {
    installNxcore({
      registryProviders: REGISTRY,
      oauthConfigs: FEISHU_CATALOG,
      status: { connections: [], disconnected: [{ service: 'feishu', connectionName: 'default' }] },
      feishuAuth: { cliState: 'ready', appConfigured: true, userAuthorized: true, userName: '张三' },
    })
    await act(async () => {
      root.render(<ConnectorsView onToast={() => undefined} />)
    })
    await flush()

    expect(cardStateTitles()['飞书']).toBe('未开启')
  })

  it('未连接点「连接」走 agentAuth.start（lark-cli 设备码），不走 nango 授权', async () => {
    const nxcore = installNxcore({
      registryProviders: REGISTRY,
      oauthConfigs: FEISHU_CATALOG,
      feishuAuth: { cliState: 'ready', appConfigured: true, userAuthorized: false, userName: null },
    })
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
    await flush(2)

    const agentAuth = (nxcore as unknown as { agentAuth: { start: ReturnType<typeof vi.fn> } }).agentAuth
    expect(agentAuth.start).toHaveBeenCalledWith({ provider: 'feishu' })
    expect(nxcore.nangoConnector.startAuthorization, '飞书不走 oo/Nango 授权').not.toHaveBeenCalled()
  })
})
