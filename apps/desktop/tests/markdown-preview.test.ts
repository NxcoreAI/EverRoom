import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import type { Connector } from '../src/main/connectors/types'
import { LocalDataService } from '../src/main/core/local-data-service'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('Markdown source preview', () => {
  it('reads the synchronized local object copy for offline preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-markdown-preview-'))
    directories.push(directory)
    const markdown = '# Project notes\n\n- [x] Synced\n\n```ts\nconst ready = true\n```\n'
    const connector: Connector<Record<string, never>> = {
      kind: 'google-docs',
      capabilities: ['pull'],
      getConnectionKey: () => 'preview-test',
      scan: async () => ({
        failed: 0,
        items: [{
          remoteId: 'doc-1',
          title: 'Project notes',
          uri: 'https://docs.example.test/doc-1',
          path: 'Project notes.md',
          extension: '.md',
          byteSize: Buffer.byteLength(markdown),
          modifiedAt: '2026-08-17T08:00:00.000Z',
          openContent: () => Readable.from([markdown]),
        }],
      }),
    }
    const service = new LocalDataService(directory, new ConnectorRegistry().register(connector))
    await service.initialize()
    try {
      const result = await service.addConnection('google-docs', 'Google Docs', {})
      const file = service.listFiles(result.source.id)[0]!
      await expect(service.previewFile(result.source.id, file.id)).resolves.toEqual({
        fileName: 'Project notes.md',
        relativePath: 'Project notes.md',
        modifiedAt: '2026-08-17T08:00:00.000Z',
        content: markdown,
      })
    } finally {
      await service.shutdown()
    }
  })
})
