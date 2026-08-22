import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const names = [
  'NXCORE_SAAS_API_URL',
  'NXCORE_KNOWLEDGE_ROUTER_ENABLED',
  'NXCORE_KNOWLEDGE_INGEST_DEBOUNCE_MS',
  'NXCORE_CONNECTOR_POLL_MS',
  'NXCORE_INGEST_FILTER_ENABLED',
  'NXCORE_INGEST_FILTER_MODE',
  'NXCORE_NANGO_URL',
  'NXCORE_NANGO_GMAIL_CONFIG_KEY',
  'NXCORE_NANGO_GOOGLE_CLIENT_ID',
  'NXCORE_NANGO_GOOGLE_CLIENT_SECRET',
  'NXCORE_NANGO_NOTION_CLIENT_ID',
  'NXCORE_NANGO_NOTION_CLIENT_SECRET',
  'NXCORE_NANGO_OUTLOOK_CLIENT_ID',
  'NXCORE_NANGO_OUTLOOK_CLIENT_SECRET',
  'NXCORE_NANGO_OUTLOOK_CONFIG_KEY',
]

const missing = names.filter((name) => !process.env[name])
if (missing.length) throw new Error(`Missing packaged environment variables: ${missing.join(', ')}`)

const output = resolve(process.cwd(), 'build', 'packaged-env.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name]])), null, 2)}\n`)
console.log(`Wrote ${names.length} packaged environment variables to ${output}`)
