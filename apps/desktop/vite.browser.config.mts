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
// Notion 文档列表（导入面板 mock）：混合 origin/wiki/imported/owner 的 14 篇。
const notionDocs = [
  ['doc-1', '产品需求文档：Context Room 2.0', 'page', null, '王小雨', '2026-09-07T08:30:00.000Z', true],
  ['doc-2', '周会纪要 2026-09-05', 'page', null, '王小雨', '2026-09-05T03:00:00.000Z', true],
  ['doc-3', '连接器架构评审', 'page', null, '李明', '2026-09-06T11:20:00.000Z', false],
  ['doc-4', '飞书 OpenConnector 调研', 'page', null, '李明', '2026-09-01T09:00:00.000Z', false],
  ['doc-5', '用户访谈记录 · 第 12 期', 'page', null, '赵倩', '2026-08-28T07:45:00.000Z', false],
  ['doc-6', 'OKR 2026 Q3', 'page', null, '王小雨', '2026-09-07T02:10:00.000Z', false],
  ['doc-7', '竞品分析：Notion AI vs Everroom', 'page', null, '赵倩', '2026-09-03T06:30:00.000Z', false],
  ['doc-8', '设计规范 · 色彩篇', 'page', null, '孙俪', '2026-08-20T05:00:00.000Z', true],
  ['doc-9', '营销日历 9 月', 'page', null, '钱进', '2026-09-02T01:15:00.000Z', false],
  ['doc-10', '客服 FAQ 维护', 'page', null, '周杰', '2026-08-15T08:00:00.000Z', false],
  ['doc-11', '数据迁移方案（草稿）', 'page', null, '李明', '2026-09-07T09:40:00.000Z', false],
  ['doc-12', 'Onboarding 文案', 'page', null, '赵倩', '2026-08-25T04:20:00.000Z', false],
  ['doc-13', '第三方依赖审计报告', 'page', null, '吴强', '2026-08-10T02:00:00.000Z', false],
  ['doc-14', 'Roadmap 2026 H2', 'page', null, '王小雨', '2026-09-06T10:00:00.000Z', false],
].map(([id, title, origin, wikiSpaceName, ownerName, updatedAt, imported]) => ({ provider: 'notion', remoteDocumentId: id, title, sourceUrl: 'https://notion.so/' + id, updatedAt, ownerName, origin, wikiSpaceName, imported }))
// 导入批模拟：每次 status 调用推进 2 条，4 条失败其一。
let batchState = null
const mkBatch = (input) => {
  const items = input.remoteDocumentIds.map((id) => {
    const doc = notionDocs.find((item) => item.remoteDocumentId === id)
    return { remoteDocumentId: id, title: doc?.title ?? id, status: 'pending', roomId: null, documentId: null, importRunId: null, error: null }
  })
  batchState = { id: 'batch-' + Date.now(), provider: input.provider, connectionName: input.connectionName ?? null, mode: input.mode, targetRoomId: input.roomId ?? null, status: 'running', total: items.length, processed: 0, succeeded: 0, failed: 0, items, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null }
  return batchState
}
const tickBatch = () => {
  if (!batchState || batchState.status !== 'running') return batchState
  const next = batchState.items.find((item) => item.status === 'pending')
  if (!next) { batchState.status = 'completed'; batchState.completedAt = new Date().toISOString(); return batchState }
  next.status = next.remoteDocumentId === 'doc-4' ? 'failed' : batchState.mode === 'auto' && next.remoteDocumentId === 'doc-9' ? 'incubated' : 'imported'
  if (next.status === 'failed') { next.error = 'sync failed: ECONNRESET (mock)'; batchState.failed += 1 } else batchState.succeeded += 1
  batchState.processed += 1
  batchState.updatedAt = new Date().toISOString()
  return batchState
}
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
    { id: 'conn-notion', provider: 'notion', service: 'notion', connectionName: '我的 Notion 工作区', status: 'active', updatedAt: '2026-09-08T09:30:00.000Z' },
  ], scopes: [
    { id: 'sc-1', connectionId: 'conn-gmail', provider: 'gmail', label: 'INBOX', state: 'idle', updatedAt: '2026-09-04T10:00:00.000Z' },
  ], runs: [
    { id: 'r1', scopeId: 'sc-1', mode: 'incremental', status: 'completed', processed: 3200, failed: 0, error: null, startedAt: '2026-09-05T08:30:00.000Z', finishedAt: '2026-09-05T08:33:00.000Z' },
    { id: 'r2', scopeId: 'sc-1', mode: 'incremental', status: 'failed', processed: 100, failed: 0, error: 'OpenConnector sync timed out after 60000ms', startedAt: '2026-09-05T07:10:00.000Z', finishedAt: '2026-09-05T07:11:00.000Z' },
    { id: 'r3', scopeId: 'sc-1', mode: 'full', status: 'failed', processed: 0, failed: 0, error: 'format_mapping_pending:gmail:mail', startedAt: '2026-09-05T06:40:00.000Z', finishedAt: '2026-09-05T06:40:05.000Z' },
    { id: 'r4', scopeId: 'sc-1', mode: 'incremental', status: 'failed', processed: 0, failed: 0, error: 'request failed: ECONNRESET', startedAt: '2026-09-05T05:20:00.000Z', finishedAt: '2026-09-05T05:20:30.000Z' },
    { id: 'r5', scopeId: 'sc-1', mode: 'full', status: 'interrupted', processed: 45, failed: 0, error: null, startedAt: '2026-09-05T04:00:00.000Z', finishedAt: '2026-09-05T04:02:00.000Z' },
    { id: 'r6', scopeId: 'sc-1', mode: 'incremental', status: 'failed', processed: 0, failed: 0, error: 'reauthorization_required: token expired', startedAt: '2026-09-05T03:00:00.000Z', finishedAt: '2026-09-05T03:00:10.000Z' },
    { id: 'r7', scopeId: 'sc-1', mode: 'incremental', status: 'running', processed: 120, failed: 0, error: null, startedAt: '2026-09-05T09:00:00.000Z', finishedAt: null },
  ] }),
    providers: async () => ({ providers: [
      { provider: 'gmail', label: 'Gmail', category: 'mail', iconKey: 'gmail', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'outlook', label: 'Outlook', category: 'mail', iconKey: 'outlook', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'google-calendar', label: 'Google Calendar', category: 'calendar', iconKey: 'google-calendar', dataTypes: ['calendar'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'google-docs', label: 'Google Docs', category: 'docs', iconKey: 'google-docs', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'notion', label: 'Notion', category: 'docs', iconKey: 'notion', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'feishu', label: '飞书', category: 'docs', iconKey: 'feishu', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
      { provider: 'ics-calendar', label: '日历订阅（WebCal/ICS）', category: 'calendar', iconKey: 'ics-calendar', dataTypes: ['calendar'], authChannel: 'webcal-url', connected: false, comingSoon: false },
    ] }),
    oauthConfigs: async () => null,
    recordTotals: async () => ({ mail: 3200, calendar: 0 }) },
  cliConnector: {
    execute: async (req) => req.command?.kind === 'apps'
      ? { data: [
          { service: 'notion', connectionName: 'default', displayName: '我的 Notion 工作区', accountLabel: 'me@example.com', authType: 'oauth', status: 'active', scopes: [], isDefault: true },
        ] }
      : { data: [] },
    startAuthorization: async () => {},
    openConsole: async () => {},
  },
  externalDocuments: {
    importList: async (provider, _conn, cachedOnly) => provider === 'notion'
      ? { provider, items: notionDocs, truncated: false, warnings: cachedOnly ? [] : [], fetchedAt: cachedOnly ? '2026-09-08T09:30:00.000Z' : new Date().toISOString() }
      : { provider, items: [], truncated: false, warnings: [], fetchedAt: null },
    importBatch: async (input) => mkBatch(input),
    importBatchStatus: async () => tickBatch(),
    cancelImportBatch: async () => { if (batchState) { batchState.status = 'cancelled'; batchState.completedAt = new Date().toISOString() } return batchState },
  },
  knowledge: { listRooms: async () => ({ items: [
    { id: 'room-1', title: '产品调研', kind: 'project', aliases: ['research'], description: null },
    { id: 'room-2', title: '设计系统', kind: 'topic', aliases: [], description: null },
    { id: 'room-3', title: '连接器', kind: 'project', aliases: ['connector', 'feishu'], description: null },
    { id: 'room-4', title: '周会', kind: 'meeting', aliases: [], description: null },
    { id: 'room-5', title: '营销', kind: 'topic', aliases: [], description: null },
  ] }) },
  ingest: { listEvents: async (q) => ({ items: Array.from({ length: Math.min(q.limit, 8) }, (_, i) => ({ id: 'e' + i, sourceKind: 'file', title: '事件 ' + i, filterStatus: 'passed', createdAt: '2026-09-05T0' + i + ':00:00.000Z', updatedAt: '2026-09-05T0' + i + ':00:00.000Z' })), total: 8 }),
    getFilterRules: async () => ({ preference: '', insight: '', updatedAt: null }),
    updateFilterPreference: async (content) => ({ preference: content, insight: '', updatedAt: null }) },
  migrations: { sources: async () => [], runs: async () => [], onProgress: () => () => {} },
  obsidian: { list: async () => [], discover: async () => [], onChanged: () => () => {}, onDiscoveryChanged: () => () => {} },
}
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
