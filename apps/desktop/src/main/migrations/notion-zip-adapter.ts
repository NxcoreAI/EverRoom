import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'

const MAX_FILES = 10_000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const NOTION_ID = /(?:^|\s)([0-9a-f]{32})(?=\.[^.]+$)/iu
const ALLOWED = new Set(['.md', '.html', '.htm', '.csv'])
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

function normalizedPath(name: string): string {
  const value = name.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//u.test(value) || value.split('/').some((part) => part === '..')) throw new Error('Notion ZIP contains an unsafe path')
  return value
}

export async function extractNotionZip(zipPath: string): Promise<{ directory: string; files: Array<{ path: string; relativePath: string; stableKey: string }>; cleanup: () => Promise<void> }> {
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then(({ readFile }) => readFile(zipPath)), { checkCRC32: true, createFolders: false })
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length > MAX_FILES) throw new Error('Notion ZIP contains too many files')
  const directory = await mkdtemp(join(tmpdir(), 'everroom-notion-'))
  let total = 0
  const files: Array<{ path: string; relativePath: string; stableKey: string }> = []
  try {
    for (const entry of entries) {
      const relativePath = normalizedPath(entry.name)
      const permissions = typeof entry.unixPermissions === 'string' ? Number.parseInt(entry.unixPermissions, 8) : entry.unixPermissions
      if (typeof permissions === 'number' && (permissions & 0o170000) === 0o120000) throw new Error('Notion ZIP contains a symbolic link')
      if (!ALLOWED.has(extname(relativePath).toLowerCase())) continue
      const bytes = await entry.async('nodebuffer')
      total += bytes.byteLength
      if (bytes.byteLength > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Notion ZIP exceeds migration limits')
      const path = join(directory, `${hash(relativePath)}${extname(relativePath).toLowerCase()}`)
      await writeFile(path, bytes)
      const notionId = NOTION_ID.exec(basename(relativePath))?.[1]?.toLowerCase()
      files.push({ path, relativePath, stableKey: notionId ?? relativePath.normalize('NFC').toLowerCase() })
    }
    if (!files.length) throw new Error('Notion ZIP contains no supported text documents')
    return { directory, files, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}
