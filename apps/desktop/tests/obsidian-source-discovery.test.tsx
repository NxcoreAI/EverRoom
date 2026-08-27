import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ObsidianVaultCandidate } from '../src/shared/obsidian'
import { ObsidianImportDialog } from '../src/renderer/src/components/pages/sources/ObsidianImportDialog'
import { SourceTable } from '../src/renderer/src/components/pages/sources/SourceTable'

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

describe('Obsidian source discovery', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('shows newly discovered projects as pending and exposes an import action', () => {
    const pending = candidate()
    const onImport = vi.fn()

    act(() => {
      renderer = TestRenderer.create(<SourceTable
        sources={[]}
        vaults={[]}
        obsidianCandidates={[pending]}
        loading={false}
        busyId={null}
        expandedSourceId={null}
        filesBySource={{}}
        filesLoadingId={null}
        onToggleFiles={vi.fn()}
        onSync={vi.fn()}
        onTogglePaused={vi.fn()}
        onClear={vi.fn()}
        onOpenEvidence={vi.fn()}
        onPreviewFile={vi.fn()}
        onShowFile={vi.fn()}
        obsidianExpanded
        onToggleObsidian={vi.fn()}
        onRescanObsidian={vi.fn()}
        onOpenVaultRoom={vi.fn()}
        onDisconnectVault={vi.fn()}
        onImportObsidianCandidate={onImport}
      />)
    })

    expect(renderer.root.findAllByProps({ className: 'obsidian-project-row', 'data-status': 'pending' })).toHaveLength(1)
    const importButton = renderer.root.findByProps({ 'aria-label': '导入 Obsidian 项目：Product Vault' })
    act(() => importButton.props.onClick())
    expect(onImport).toHaveBeenCalledWith(pending)
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
