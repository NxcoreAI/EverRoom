import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// react-test-renderer 无法把 portal 挂到真实 DOM 容器——透传为普通子树
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPortal: (children: React.ReactNode) => children,
}))

import type { ConnectorConnection, SyncRun, SyncScope } from '@nxcore/connector-contract'
import { CloudSourceCard } from '../src/renderer/src/components/pages/sources/SourceCard'
import { SourceDrawer, groupRuns } from '../src/renderer/src/components/pages/sources/SourceDrawer'

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: 'connection-gmail',
    provider: 'gmail',
    service: 'gmail',
    connectionName: 'default',
    accountIdentityHash: null,
    status: 'active',
    filters: {},
    createdAt: '2026-09-07T07:13:35.207Z',
    updatedAt: '2026-09-07T07:50:00.000Z',
    ...overrides,
  }
}

function scope(overrides: Partial<SyncScope> = {}): SyncScope {
  return {
    id: 'scope-me',
    connectionId: 'connection-gmail',
    providerScopeId: 'me',
    displayName: 'Mailbox',
    state: 'idle',
    sourceCursor: null,
    deliveryCursor: 0,
    checkpointRevision: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    fenceToken: 0,
    updatedAt: '2026-09-07T07:50:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-1',
    scopeId: 'scope-me',
    mode: 'full',
    status: 'failed',
    processed: 0,
    failed: 0,
    error: 'format_mapping_pending:gmail:mail（等待格式映射生成，通常 1 分钟内自动完成）',
    startedAt: '2026-09-07T07:40:00.000Z',
    finishedAt: '2026-09-07T07:40:02.000Z',
    ...overrides,
  }
}

/** 12 次映射未就绪的轮询重试 + 1 次不同错误，应为两组。 */
const retryPile = Array.from({ length: 12 }, (_, index) => run({ id: `run-${index}`, startedAt: new Date(Date.parse('2026-09-07T07:40:00.000Z') - index * 300_000).toISOString() }))

function miniButtons(root: TestRenderer.ReactTestRenderer) {
  return root.findAllByProps({ className: 'src-mini-btn' })
}

function buttonWithText(nodes: ReturnType<typeof miniButtons>, text: string) {
  return nodes.find((node) => Array.isArray(node.props.children)
    && node.props.children.some((child: unknown) => typeof child === 'string' && child.includes(text)))
}

describe('cloud source card/drawer', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('groups the polling retry pile of identical failed runs into one row', () => {
    const groups = groupRuns([...retryPile, run({ id: 'run-other', error: 'scope_busy' })])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ attempts: 12 })
    expect(groups[1]).toMatchObject({ attempts: 1 })
    // 顺序保持（runs 按 startedAt 倒序传入）
    expect(groups[1].run.error).toBe('scope_busy')
  })

  it('keeps a growing full run visible and ungrouped', () => {
    const groups = groupRuns([
      run({ id: 'run-live', status: 'running', processed: 600, error: null, finishedAt: null }),
      ...retryPile,
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ run: { id: 'run-live' }, attempts: 1 })
    expect(groups[1]).toMatchObject({ attempts: 12 })
  })

  it('disables incremental sync before the initial full sync lands a cursor', () => {
    const onSync = vi.fn()
    act(() => {
      renderer = TestRenderer.create(<SourceDrawer
        target={{ type: 'cloud', connection: connection() }}
        open
        files={[]}
        filesLoading={false}
        vaults={[]}
        obsidianCandidates={[]}
        scopes={[scope()]}
        runs={[run({ id: 'run-live', status: 'running', processed: 600, error: null, finishedAt: null }), ...retryPile]}
        totals={{ mail: 600, calendar: 0 }}
        busyId={null}
        onClose={vi.fn()}
        onSync={onSync}
        onTogglePaused={vi.fn()}
        onClear={vi.fn()}
        onOpenEvidence={vi.fn()}
        onPreviewFile={vi.fn()}
        onShowFile={vi.fn()}
        onRescanObsidian={vi.fn()}
        onOpenVaultRoom={vi.fn()}
        onDisconnectVault={vi.fn()}
        onImportObsidianCandidate={vi.fn()}
        onScopeSync={vi.fn()}
        onToggleEnabled={vi.fn()}
        onPurge={vi.fn()}
        onReplaceAccount={vi.fn()}
      />)
    })

    const incremental = buttonWithText(miniButtons(renderer.root), '增量同步')
    expect(incremental).toBeTruthy()
    expect(incremental?.props.disabled).toBe(true)
    // 单槽位邮箱不出现"同步范围"
    expect(renderer.root.findAllByProps({ className: 'src-scope-row' })).toHaveLength(0)
    // 已同步实际数量
    expect(renderer.root.findByProps({ children: '已同步' })).toBeTruthy()
    // 12 次重试折叠成一行「共 12 次」，加上在跑的全量共两行
    const strongTexts = renderer.root.findAllByType('strong').map((node) => [node.props.children].flat().join(''))
    expect(strongTexts.filter((text) => text.includes('共 12 次'))).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: 'src-run-row' })).toHaveLength(2)
  })

  it('enables incremental sync once every scope has a cursor', () => {
    const onSync = vi.fn()
    act(() => {
      renderer = TestRenderer.create(<SourceDrawer
        target={{ type: 'cloud', connection: connection() }}
        open
        files={[]}
        filesLoading={false}
        vaults={[]}
        obsidianCandidates={[]}
        scopes={[scope({ sourceCursor: '1788767438582' })]}
        runs={[run({ id: 'run-done', status: 'completed', processed: 600, error: null, finishedAt: '2026-09-07T08:10:00.000Z' })]}
        totals={{ mail: 600, calendar: 0 }}
        busyId={null}
        onClose={vi.fn()}
        onSync={onSync}
        onTogglePaused={vi.fn()}
        onClear={vi.fn()}
        onOpenEvidence={vi.fn()}
        onPreviewFile={vi.fn()}
        onShowFile={vi.fn()}
        onRescanObsidian={vi.fn()}
        onOpenVaultRoom={vi.fn()}
        onDisconnectVault={vi.fn()}
        onImportObsidianCandidate={vi.fn()}
        onScopeSync={vi.fn()}
        onToggleEnabled={vi.fn()}
        onPurge={vi.fn()}
        onReplaceAccount={vi.fn()}
      />)
    })

    const incremental = buttonWithText(miniButtons(renderer.root), '增量同步')
    expect(incremental?.props.disabled).toBe(false)
  })

  it('shows synced totals instead of scope count on the gmail card', () => {
    act(() => {
      renderer = TestRenderer.create(<CloudSourceCard
        connection={connection()}
        scopes={[scope()]}
        runs={[run({ id: 'run-live', status: 'running', processed: 600, error: null, finishedAt: null })]}
        totals={{ mail: 600, calendar: 0 }}
        busy={false}
        onOpen={vi.fn()}
        onSync={vi.fn()}
        onToggleEnabled={vi.fn()}
        onPurge={vi.fn()}
        onReplaceAccount={vi.fn()}
      />)
    })

    const stats = renderer.root.findAllByType('small').map((node) => node.props.children)
    expect(stats).toContain('已同步')
    const statValues = renderer.root.findAllByType('b').map((node) => node.props.children)
    expect(statValues).toContain('600')
    expect(stats).not.toContain('同步范围')
    const incremental = buttonWithText(miniButtons(renderer.root), '增量同步')
    expect(incremental?.props.disabled).toBe(true)
  })
})
