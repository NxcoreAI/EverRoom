import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const names = [
  'NXCORE_AGENT_RUNTIME',
  'NXCORE_SAAS_API_URL',
  'NXCORE_KNOWLEDGE_ROUTER_ENABLED',
  'NXCORE_KNOWLEDGE_INGEST_DEBOUNCE_MS',
  'NXCORE_CONNECTOR_POLL_MS',
  'NXCORE_INGEST_FILTER_ENABLED',
  'NXCORE_INGEST_FILTER_MODE',
  'NXCORE_NANGO_URL',
  'NXCORE_NANGO_SECRET',
  'NXCORE_NANGO_GMAIL_CONFIG_KEY',
  'NXCORE_NANGO_GOOGLE_CLIENT_ID',
  'NXCORE_NANGO_GOOGLE_CLIENT_SECRET',
  'NXCORE_NANGO_NOTION_CLIENT_ID',
  'NXCORE_NANGO_NOTION_CLIENT_SECRET',
  'NXCORE_NANGO_OUTLOOK_CLIENT_ID',
  'NXCORE_NANGO_OUTLOOK_CLIENT_SECRET',
  'NXCORE_NANGO_OUTLOOK_CONFIG_KEY',
  'NXCORE_BROWSER_EXTENSION_STORE_URL',
  'NXCORE_BROWSER_EXTENSION_ID',
]

// 可选打包变量：缺失时跳过（不阻断构建），运行时各自有缺省行为
// （channel 缺省 stable；fallback 缺省跳过备源降级）。
const optionalNames = [
  'NXCORE_UPDATE_CHANNEL',
  'NXCORE_UPDATE_FALLBACK_URL',
]

// GitHub vars 可能连引号一起存（vars.X = "pi"），剥掉包裹引号再下发，
// 否则 gateway 的整数/布尔解析在打包版里直接崩（Invalid NXCORE_NANGO_CONNECTOR_POLL_MS）。
const value = (name) => process.env[name].replace(/^"(.*)"$/, '$1')

const missing = names.filter((name) => !process.env[name])
if (missing.length) throw new Error(`Missing packaged environment variables: ${missing.join(', ')}`)

const entries = [
  ...names.map((name) => [name, value(name)]),
  ...optionalNames.filter((name) => process.env[name]).map((name) => [name, value(name)]),
]

const output = resolve(process.cwd(), 'build', 'packaged-env.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`)
console.log(`Wrote ${entries.length} packaged environment variables to ${output}`)
