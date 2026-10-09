import { describe, expect, it, vi } from 'vitest'

import type { VaultNoteSnapshot } from '../src/shared/obsidian'
import {
  noteFileNameFromTitle,
  pushDocumentSaveToVault,
  titleForNotePath,
  trashDocumentInVault,
  type VaultDocumentSyncDeps,
} from '../src/main/obsidian/vault-document-sync'

function snapshot(overrides: Partial<VaultNoteSnapshot> = {}): VaultNoteSnapshot {
  return {
    resource: {
      id: 'resource-1',
      vaultId: 'vault-1',
      relativePath: 'notes/roadmap.md',
      name: 'roadmap.md',
      kind: 'note',
      byteSize: 10,
      sourceHash: 'hash-on-disk',
      modifiedAt: '2026-10-08T00:00:00.000Z',
      assetUrl: null,
    },
    markdown: 'disk version',
    sourceHash: 'hash-on-disk',
    ...overrides,
  }
}

function fixture(overrides: {
  snapshot?: VaultNoteSnapshot
  markdown?: string
  saveResult?: 'saved' | 'conflict'
  note?: { vaultId: string; resourceId: string } | null
} = {}) {
  const note = overrides.note !== undefined ? overrides.note : { vaultId: 'vault-1', resourceId: 'resource-1' }
  const current = overrides.snapshot ?? snapshot()
  const calls = {
    documentMarkdown: 0,
    saveNote: 0,
    moveNote: 0,
    trashNote: 0,
    revert: 0,
  }
  const deps: VaultDocumentSyncDeps = {
    vaults: {
      noteForDocument: vi.fn(() => note),
      readNote: vi.fn(async () => current),
      saveNote: vi.fn(async (_vaultId: string, _resourceId: string, markdown: string, _hash: string) => {
        calls.saveNote += 1
        if (overrides.saveResult === 'conflict') {
          return { status: 'conflict' as const, snapshot: snapshot({ markdown: 'external edit', sourceHash: 'hash-external' }) }
        }
        return { status: 'saved' as const, snapshot: snapshot({ markdown, sourceHash: 'hash-saved' }) }
      }),
      moveNote: vi.fn(async (_vaultId: string, _resourceId: string, relativePath: string, _hash: string) => {
        calls.moveNote += 1
        return { ...current, resource: { ...current.resource, relativePath }, sourceHash: 'hash-moved' }
      }),
      trashNote: vi.fn(async () => {
        calls.trashNote += 1
      }),
    },
    documentMarkdown: vi.fn(async () => {
      calls.documentMarkdown += 1
      return overrides.markdown ?? current.markdown
    }),
    revertDocumentToDisk: vi.fn(async () => {
      calls.revert += 1
    }),
  }
  return { deps, calls }
}

describe('pushDocumentSaveToVault', () => {
  it('skips documents without a vault binding', async () => {
    const { deps, calls } = fixture({ note: null })
    await pushDocumentSaveToVault(deps, { documentId: 'doc-1' })
    expect(calls.documentMarkdown).toBe(0)
    expect(calls.saveNote).toBe(0)
  })

  it('skips write-back silently when the vault is offline', async () => {
    const { deps, calls } = fixture()
    deps.vaults.readNote = vi.fn(async () => {
      throw new Error('vault offline')
    })
    await pushDocumentSaveToVault(deps, { documentId: 'doc-1' })
    expect(calls.documentMarkdown).toBe(0)
    expect(calls.saveNote).toBe(0)
  })

  it('does not touch the file when content already matches', async () => {
    const { deps, calls } = fixture()
    await pushDocumentSaveToVault(deps, { documentId: 'doc-1' })
    expect(calls.saveNote).toBe(0)
    expect(calls.moveNote).toBe(0)
  })

  it('writes serialized markdown back and renames when the title changed', async () => {
    const { deps, calls } = fixture({ markdown: 'new body' })
    await pushDocumentSaveToVault(deps, { documentId: 'doc-1', previousTitle: 'roadmap', nextTitle: '新路线' })
    expect(calls.saveNote).toBe(1)
    expect(deps.vaults.saveNote).toHaveBeenCalledWith('vault-1', 'resource-1', 'new body', 'hash-on-disk')
    expect(calls.moveNote).toBe(1)
    expect(deps.vaults.moveNote).toHaveBeenCalledWith('vault-1', 'resource-1', 'notes/新路线.md', 'hash-saved')
  })

  it('reports a conflict, reverts the document to disk, and keeps the file untouched', async () => {
    const { deps, calls } = fixture({ markdown: 'new body', saveResult: 'conflict' })
    await expect(pushDocumentSaveToVault(deps, { documentId: 'doc-1' })).rejects.toThrow('VAULT_SOURCE_CONFLICT')
    expect(calls.revert).toBe(1)
    expect(deps.revertDocumentToDisk).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      vaultId: 'vault-1',
      relativePath: 'notes/roadmap.md',
      sourceHash: 'hash-external',
      markdown: 'external edit',
    }))
    expect(calls.moveNote).toBe(0)
  })

  it('keeps the save even when the revert after a conflict fails', async () => {
    const { deps } = fixture({ markdown: 'new body', saveResult: 'conflict' })
    deps.revertDocumentToDisk = vi.fn(async () => {
      throw new Error('gateway down')
    })
    await expect(pushDocumentSaveToVault(deps, { documentId: 'doc-1' })).rejects.toThrow('VAULT_SOURCE_CONFLICT')
  })
})

describe('trashDocumentInVault', () => {
  it('trashes the note file with the current source hash', async () => {
    const { deps, calls } = fixture()
    await trashDocumentInVault(deps, 'doc-1')
    expect(calls.trashNote).toBe(1)
    expect(deps.vaults.trashNote).toHaveBeenCalledWith('vault-1', 'resource-1', 'hash-on-disk')
  })

  it('does not block deletion when the note cannot be read', async () => {
    const { deps, calls } = fixture()
    deps.vaults.readNote = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(trashDocumentInVault(deps, 'doc-1')).resolves.toBeUndefined()
    expect(calls.trashNote).toBe(0)
  })
})

describe('helpers', () => {
  it('derives document titles and safe note file names', () => {
    expect(titleForNotePath('notes/my note.md')).toBe('my note')
    expect(noteFileNameFromTitle('a/b:c', '.md')).toBe('a-b-c.md')
    expect(noteFileNameFromTitle('..hidden', '.md')).toBe('hidden.md')
    expect(noteFileNameFromTitle('\x00\x01', '.md')).toBe('未命名.md')
  })
})
