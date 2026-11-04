// @vitest-environment happy-dom
/**
 * 回归：「最近」页首页两处假数据治理——
 *
 * 1) 每日洞察卡（原型 mock：dailyInsight 的「王小雨 / 供应商报价」叙事）在接上
 *    真实洞察数据源前必须隐藏（SHOW_DAILY_INSIGHT = false）；
 * 2) 问候语人名必须来自真实账号（AccountProvider → user.name），不再硬编码
 *    「王小雨」；未登录/无 provider 时退回不含姓名的纯问候；
 * 3) 副标题「今天有 3 封新邮件和 1 场会议…」同为 mock：改为真实文件库计数
 *    （files.list 的 total），空库/无桥时显示中性文案。
 *
 * 与 tests/office-proto-real-file-open.test.tsx 同款 happy-dom + createRoot 写法，
 * 只 mock preload 桥 window.nxcore，真实渲染 OfficeProto 组件树。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../src/renderer/src/i18n/i18next'
import { OfficeProto } from '../src/renderer/src/office-proto/OfficeProto'
import { AccountProvider } from '../src/renderer/src/state/AccountContext'
import type { CloudAccountStatus } from '../src/shared/sources'

// React 18 的 act() 需要显式声明测试环境，否则每次状态更新都会打 warning。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONTENT_HASH = 'b'.repeat(64)

const SIGNED_IN_ACCOUNT: CloudAccountStatus = {
  authenticated: true,
  apiBaseUrl: 'https://api.everroom.test',
  user: { id: 'user-qa', tenantId: 'tenant-qa', email: 'qa@everroom.test', name: '真实用户' },
}

const catalog = {
  id: 'file-real-docx',
  originalName: '真实文档.docx',
  displayName: null,
  sharedTitle: '真实文档',
  sourceKind: 'manual-upload' as const,
  sourceLabel: '本地上传',
  relativePath: null,
  provider: null,
  bytes: 12_800,
  dataType: null,
  agentCategory: null,
  summary: null,
  tags: [],
  processingState: 'ready' as const,
  clusterId: null,
  contentHash: CONTENT_HASH,
  currentVersionId: null,
  parsed: true,
  updatedAt: new Date().toISOString(),
}

let container: HTMLDivElement
let root: Root

/** 推进若干轮宏任务（每轮都在 act 里），让 effects / promise 链跑完。 */
async function flush(rounds = 10, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

function installNxcore(options: { total: number; account: CloudAccountStatus }) {
  const nxcore = {
    platform: 'darwin',
    account: {
      status: vi.fn().mockResolvedValue(options.account),
      onAdmissionRequired: vi.fn().mockReturnValue(() => undefined),
    },
    files: {
      list: vi.fn().mockResolvedValue(
        options.total > 0
          ? { items: [catalog], total: options.total }
          : { items: [], total: 0 },
      ),
      openOriginal: vi.fn().mockResolvedValue({
        openedWith: 'office' as const,
        instanceId: catalog.id,
        kind: 'doc' as const,
        title: catalog.originalName,
      }),
      setActiveInstance: vi.fn().mockResolvedValue(true),
      closeInstance: vi.fn().mockResolvedValue(true),
      setWorkspaceBounds: vi.fn(),
    },
    office: {
      setActiveInstance: vi.fn().mockResolvedValue(true),
      closeInstance: vi.fn().mockResolvedValue(true),
      setWorkspaceBounds: vi.fn(),
    },
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = nxcore
  return nxcore
}

beforeEach(async () => {
  // i18next 未初始化时 translate() 会抛错（settings 系测试的教训）。
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500)
      i18n.once('initialized', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // happy-dom 没有布局/媒体查询：给 matchMedia 一个稳定返回（打字机效果等用到）。
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
  // 与 settings-login.test.tsx 同理：保留 window.nxcore，避免卸载后的
  // 兜底重查 timer 因桥消失冒成未捕获异常；beforeEach 会整体覆盖安装。
})

describe('「最近」页假数据治理', () => {
  it('每日洞察卡已隐藏（mock 数据源，接真实数据前不显示）', async () => {
    installNxcore({ total: 1, account: SIGNED_IN_ACCOUNT })
    await act(async () => {
      root.render(
        <AccountProvider>
          <OfficeProto />
        </AccountProvider>,
      )
    })
    await flush()

    expect(container.querySelector('.op-insight-card'), '洞察卡不应渲染').toBeNull()
  })

  it('问候语用真实账号名，副标题用真实文件库计数', async () => {
    installNxcore({ total: 7, account: SIGNED_IN_ACCOUNT })
    await act(async () => {
      root.render(
        <AccountProvider>
          <OfficeProto />
        </AccountProvider>,
      )
    })
    await flush()

    const heading = container.querySelector<HTMLElement>('.op-greeting h1')
    expect(heading, '问候语标题应存在').not.toBeNull()
    expect(heading!.textContent).toContain('真实用户')
    expect(heading!.textContent, '不再显示 mock 人名').not.toContain('王小雨')

    const sub = container.querySelector<HTMLElement>('.op-greeting p')
    expect(sub, '问候语副标题应存在').not.toBeNull()
    expect(sub!.textContent).toContain('7 份文件')
    expect(sub!.textContent, '不再显示 mock 的邮件/会议统计').not.toContain('3 封新邮件')
  })

  it('未登录时退回纯问候（不含人名）', async () => {
    installNxcore({ total: 1, account: { authenticated: false, apiBaseUrl: '' } })
    await act(async () => {
      root.render(
        <AccountProvider>
          <OfficeProto />
        </AccountProvider>,
      )
    })
    await flush()

    const heading = container.querySelector<HTMLElement>('.op-greeting h1')
    expect(heading).not.toBeNull()
    expect(heading!.textContent).not.toContain('王小雨')
    expect(heading!.textContent, '纯问候不加逗号尾巴').not.toContain('，')
  })

  it('空文件库时副标题显示中性文案', async () => {
    installNxcore({ total: 0, account: SIGNED_IN_ACCOUNT })
    await act(async () => {
      root.render(
        <AccountProvider>
          <OfficeProto />
        </AccountProvider>,
      )
    })
    await flush()

    const sub = container.querySelector<HTMLElement>('.op-greeting p')
    expect(sub).not.toBeNull()
    expect(sub!.textContent).toContain('文件库还没有内容')
  })

  it('无 preload 桥（浏览器预览）时不崩，问候退回纯问候', async () => {
    delete (window as unknown as { nxcore?: unknown }).nxcore
    await act(async () => {
      root.render(<OfficeProto />)
    })
    await flush()

    const heading = container.querySelector<HTMLElement>('.op-greeting h1')
    expect(heading).not.toBeNull()
    expect(heading!.textContent).not.toContain('王小雨')
    expect(container.querySelector('.op-insight-card')).toBeNull()
  })
})
