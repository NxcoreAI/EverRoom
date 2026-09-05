import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// react-test-renderer 无法把 portal 挂到真实 DOM 容器——透传为普通子树
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPortal: (children: React.ReactNode) => children,
}))

import type { ObsidianVaultBinding, ObsidianVaultCandidate } from '../src/shared/obsidian'
import { ObsidianImportDialog } from '../src/renderer/src/components/pages/sources/ObsidianImportDialog'
import { ObsidianSourceCard } from '../src/renderer/src/components/pages/sources/SourceCard'
import { SourceDrawer } from '../src/renderer/src/components/pages/sources/SourceDrawer'

function candidate(overrides: Partial<ObsidianVaultCandidate> = {}): ObsidianVaultCandidate {
  return {
    id: 'obsidian-candidate-product',
    name: 'Product Vault',
    noteCount: 3,
    attachmentCount: 1,
    discoveredFrom: 'registry',
    lastOpenedAt: null,
    mountedVaultId: null,
    mountedRoomId: null,
    memoryEnabled: false,
    ...overrides,
  }
}

function vault(overrides: Partial<ObsidianVaultBinding> = {}): ObsidianVaultBinding {
  return {
    id: 'obsidian-vault-product',
    name: 'Product Vault',
    noteCount: 3,
    attachmentCount: 1,
    status: 'connected',
    updatedAt: '2026-09-01T10:00:00.000Z',
    mountMode: 'memory',
    memoryEnabled: true,
    ...overrides,
  } as ObsidianVaultBinding
}

describe('Obsidian source discovery', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('shows newly discovered projects as a pending chip on the aggregate card', () => {
    const onRescan = vi.fn()
    act(() => {
      renderer = TestRenderer.create(<ObsidianSourceCard
        vaults={[]}
        candidates={[candidate()]}
        busy={false}
        onOpen={vi.fn()}
        onRescan={onRescan}
      />)
    })

    // 待导入 chip（数据:计数）
    const chip = renderer.root.findByProps({ className: 'src-card-chip' })
    expect(String(chip.props.children)).toContain('1')

    // 重新扫描动作仍可用（children 里混着 lucide 图标元素,只比对字符串部分）
    const rescan = renderer.root.findAllByProps({ className: 'src-mini-btn' })
      .find((node) => node.props.children.some((child: unknown) => typeof child === 'string' && child.includes('重新扫描')))
    expect(rescan).toBeTruthy()
    act(() => { rescan?.props.onClick() })
    expect(onRescan).toHaveBeenCalledOnce()
  })

  it('exposes the import action for pending candidates in the source drawer', () => {
    const onImport = vi.fn()
    act(() => {
      renderer = TestRenderer.create(<SourceDrawer
        target={{ type: 'obsidian' }}
        open
        files={[]}
        filesLoading={false}
        vaults={[]}
        obsidianCandidates={[candidate()]}
        scopes={[]}
        runs={[]}
        busyId={null}
        onClose={vi.fn()}
        onSync={vi.fn()}
        onTogglePaused={vi.fn()}
        onClear={vi.fn()}
        onOpenEvidence={vi.fn()}
        onPreviewFile={vi.fn()}
        onShowFile={vi.fn()}
        onRescanObsidian={vi.fn()}
        onOpenVaultRoom={vi.fn()}
        onDisconnectVault={vi.fn()}
        onImportObsidianCandidate={onImport}
        onScopeSync={vi.fn()}
        onToggleEnabled={vi.fn()}
        onPurge={vi.fn()}
      />)
    })

    const importButton = renderer.root.findByProps({ 'aria-label': '导入 Obsidian 项目：Product Vault' })
    act(() => importButton.props.onClick())
    expect(onImport).toHaveBeenCalledOnce()
  })

  it('refreshes an open import dialog when the Obsidian registry changes', async () => {
    const first = candidate()
    const second = candidate({ id: 'obsidian-candidate-research', name: 'Research Vault' })
    let notifyDiscoveryChanged: (() => void) | undefined
    const unsubscribe = vi.fn()
    const discover = vi.fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second])

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        nxcore: {
          obsidian: {
            discover,
            onDiscoveryChanged: (listener: () => void) => {
              notifyDiscoveryChanged = listener
              return unsubscribe
            },
          },
        },
      },
    })

    await act(async () => {
      renderer = TestRenderer.create(<ObsidianImportDialog
        target={{ kind: 'memory' }}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />)
      await Promise.resolve()
    })
    expect(renderer.root.findAllByProps({ className: 'obsidian-candidate-row' })).toHaveLength(1)

    await act(async () => {
      notifyDiscoveryChanged?.()
      await Promise.resolve()
    })

    expect(discover).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ className: 'obsidian-candidate-row' })).toHaveLength(2)
    expect(renderer.root.findByProps({ children: 'Research Vault' })).toBeTruthy()

    act(() => renderer?.unmount())
    renderer = null
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
