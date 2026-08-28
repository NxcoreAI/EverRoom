import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { extractNotionZip } from '../src/main/migrations/notion-zip-adapter'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('Notion ZIP migration adapter', () => {
  it('imports only text documents and preserves relative identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-zip-')); dirs.push(directory)
    const path = join(directory, 'export.zip'); const zip = new JSZip()
    zip.file('Workspace/Page 0123456789abcdef0123456789abcdef.md', '# Page')
    zip.file('Workspace/Table.csv', 'name,value\nA,1')
    zip.file('Workspace/config.json', '{"token":"must-not-import"}')
    zip.file('Workspace/image.png', Buffer.from([1, 2, 3]))
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
    const extracted = await extractNotionZip(path)
    expect(extracted.files.map((file) => file.relativePath)).toEqual([
      'Workspace/Page 0123456789abcdef0123456789abcdef.md', 'Workspace/Table.csv',
    ])
    expect(extracted.files[0]?.stableKey).toBe('0123456789abcdef0123456789abcdef')
    await extracted.cleanup()
  })
})
