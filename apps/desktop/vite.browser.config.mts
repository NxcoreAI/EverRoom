// 临时配置：在纯浏览器里跑真实 renderer，注入 mock window.nxcore 以复现页面交互（验证后删除）。
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function nxcoreMock(): Plugin {
  return {
    name: 'mock-nxcore',
    transformIndexHtml(html) {
      return html.replace('<head>', '<head><script src="/@mock/nxcore.js"></script>')
    },
    configureServer(server) {
      server.middlewares.use('/@mock/nxcore.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(`
const file = (over) => ({ id: 'f1', name: 'overview.md', relativePath: 'docs/overview.md', previousRelativePath: null, originalPath: '/data/docs/overview.md', extension: '.md', size: 2048, modifiedAt: '2026-09-05T02:00:00.000Z', exists: true, status: 'unchanged', changedAt: '2026-09-05T02:00:00.000Z', versionCount: 3, ...over })
const source = (over) => ({ id: 'src-local', kind: 'local-folder', name: '产品笔记', rootPath: '/Users/xjwang/Notes/产品', status: 'connected', fileCount: 128, versionCount: 402, totalBytes: 52000000, lastSyncedAt: '2026-09-05T02:11:00.000Z', lastError: null, createdAt: '2026-08-01T08:00:00.000Z', ...over })
const sources = [
  source({}),
  source({ id: 'src-git', kind: 'github', name: 'everroom/connectors', rootPath: 'https://github.com/everroom/connectors', fileCount: 412, versionCount: 980, totalBytes: 84000000, lastSyncedAt: '2026-09-04T18:40:00.000Z' }),
]
// 任意缺失的 nxcore 方法返回「可调用 + thenable + 可取属性」的万能对象:
// 调用结果仍是 magic（既能 await 当空结果,也能继续调用当取消订阅函数）。
const magicCache = new Map()
const magic = (name) => {
  const cached = magicCache.get(name)
  if (cached) return cached
  const fn = ((..._args) => magic(name + '()'))
  fn.then = (res, rej) => Promise.resolve({ enabled: true, connections: [], scopes: [], runs: [], items: [], total: 0 }).then(res, rej)
  const proxy = new Proxy(fn, {
    get: (target, prop) => {
      if (prop === 'then') return target.then
      if (prop === Symbol.toPrimitive) return () => 0
      return magic(name + '.' + String(prop))
    },
  })
  magicCache.set(name, proxy)
  return proxy
}
const face = (obj) => new Proxy(obj, {
  get: (target, prop) => (prop in target ? target[prop] : magic('x.' + String(prop))),
})
const base = {
  locale: { system: 'zh-CN', getSystem: async () => 'zh-CN' },
  sources: {
    list: async () => sources,
    listFiles: async (id) => id === 'src-git' ? [file({ id: 'f2', name: 'a.ts', relativePath: 'src/a.ts', originalPath: 'repo/src/a.ts', extension: '.ts', status: 'updated', versionCount: 5 })] : [file({}), file({ id: 'f3', name: 'b.md', relativePath: 'notes/b.md', originalPath: '/data/notes/b.md', status: 'added', versionCount: 1 })],
    onChanged: () => () => {},
    sync: async () => ({ source: sources[0], discovered: 0, changed: 0, removed: 0 }),
    setPaused: async () => {},
  },
  nangoConnector: { status: async () => ({ enabled: true, connections: [
    { id: 'conn-gmail', provider: 'gmail', service: 'gmail', connectionName: 'work@gmail.com', status: 'active', updatedAt: '2026-09-04T10:00:00.000Z' },
  ], scopes: [
    { id: 'sc-1', connectionId: 'conn-gmail', provider: 'gmail', label: 'INBOX', state: 'idle', updatedAt: '2026-09-04T10:00:00.000Z' },
  ], runs: [
    { id: 'r1', scopeId: 'sc-1', mode: 'incremental', status: 'completed', processed: 3200, failed: 0, error: null, startedAt: '2026-09-05T08:30:00.000Z', finishedAt: '2026-09-05T08:33:00.000Z' },
    { id: 'r7', scopeId: 'sc-1', mode: 'incremental', status: 'running', processed: 120, failed: 0, error: null, startedAt: '2026-09-05T09:00:00.000Z', finishedAt: null },
  ] }), providers: async () => null, oauthConfigs: async () => null, recordTotals: async () => ({ mail: 3210, calendar: 0 }) },
  ingest: { listEvents: async (q) => {
    const limit = q?.limit ?? 50
    const offset = q?.offset ?? 0
    const all = Array.from({ length: 137 }, (_, i) => {
      const kind = i % 3
      const at = new Date(Date.now() - i * 3600_000).toISOString()
      return {
        id: 'e' + i,
        sourceKind: kind === 0 ? 'mail' : kind === 1 ? 'file' : 'calendar-event',
        provider: kind === 0 ? 'gmail' : kind === 1 ? null : 'googlecalendar',
        sourceLabel: kind === 0 ? 'work@gmail.com' : kind === 1 ? '本地文件夹' : '个人日历',
        title: kind === 0 ? '周会纪要：连接器统一排期 ' + i : kind === 1 ? '产品笔记 ' + i + '.md' : '与设计师同步 ' + i,
        filterStatus: i % 7 === 0 ? 'filtered' : i % 5 === 0 ? 'pending' : 'passed',
        createdAt: at,
        updatedAt: at,
      }
    })
    return { items: all.slice(offset, offset + limit), total: all.length }
  } },
  migrations: { sources: async () => [], runs: async () => [], onProgress: () => () => {} },
  obsidian: { list: async () => [], discover: async () => [], onChanged: () => () => {}, onDiscoveryChanged: () => () => {} },
}
// 预览窗格 document.hidden 恒为 true 会挡住页面轮询;强制视为可见。
Object.defineProperty(document, 'hidden', { get: () => false })
window.nxcore = new Proxy(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v && typeof v === 'object' ? face(v) : v])), {
  get: (target, prop) => prop in target ? target[prop] : magic(String(prop)),
})
`)
      })
    },
  }
}

export default defineConfig({
  root: resolve('src/renderer'),
  server: {
    port: 5181,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve('src/renderer/src') },
  },
  plugins: [react(), nxcoreMock()],
})
