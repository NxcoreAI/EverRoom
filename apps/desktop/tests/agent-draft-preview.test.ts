import { afterEach, describe, expect, it, vi } from 'vitest'

import { readAgentDraftMarkdown } from '../src/renderer/src/components/agent/AgentDraftPreviewDialog'

describe('Agent draft preview data source', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the draft markdown through the documents preload API by documentId', async () => {
    const readMarkdown = vi.fn(async (documentId: string) => ({ documentId, markdown: '# 幻灯片内容稿\n\n正文' }))
    vi.stubGlobal('window', { nxcore: { documents: { readMarkdown } } })

    await expect(readAgentDraftMarkdown('doc-draft-1')).resolves.toBe('# 幻灯片内容稿\n\n正文')
    expect(readMarkdown).toHaveBeenCalledWith('doc-draft-1')
  })

  it('fails loudly when the preload API is missing instead of showing an empty draft', async () => {
    vi.stubGlobal('window', {})

    await expect(readAgentDraftMarkdown('doc-draft-1')).rejects.toThrow('documents.readMarkdown is unavailable')
  })
})
