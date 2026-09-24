// 临时配置：在纯浏览器里跑真实 renderer，注入 mock window.nxcore 以复现页面交互（验证后删除）。
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

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
const NL = String.fromCharCode(10)
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
// 写作路线导图 mock 状态机（聚焦改版）：动作建行（start/skip 懒建），GET 到点成材——
// 初始层/续层约 6s、拍板写正文约 5s；window.__holdRouteMindmap=true 恒挂 expanding；
// window.__failRouteMindmap='route_planner_failed' 在成材时刻转 failed；
// window.__failRouteWriting=1 让写正文落败；window.__resetRouteMindmap() 清空重走。
// 显式全字段，绝不落进兜底 Proxy。
const routeStore = new Map()
window.__resetRouteMindmap = () => { routeStore.clear() }
const routeRootRef = 'route:root'
const routeFixtureTitles = { 'doc-native-1': '产物：发布计划', 'doc-native-2': '产物：复盘草稿', 'doc-import-1': '资料：飞书周会纪要' }
const routeFind = (node, ref) => node.ref === ref ? node : (node.children ?? []).map((c) => routeFind(c, ref)).find(Boolean) ?? null
const routePathTo = (node, ref) => {
  if (node.ref === ref) return [node.ref]
  for (const child of node.children ?? []) { const sub = routePathTo(child, ref); if (sub) return [node.ref, ...sub] }
  return null
}
const routeOptionPool = [
  ['从现状痛点切入', '先摆 Gmail 双链路分表的排障成本，再引出统一动机'],
  ['按目标架构分层', '身份合并、格式映射自愈两阶段，先架构后落地'],
  ['以风险与开放问题为纲', '会话失效静默等问题先行，倒推方案边界'],
  ['排期与里程碑叙事', 'V1 视觉定稿与联调窗口串成时间线'],
  ['深挖关键证据', '用房间资料里的邮件与周报支撑判断'],
  ['方案对比与取舍', '至少两案对比，说清选型判据'],
]
const routeAttach = (node, depth, count = 4) => {
  node.children = []
  for (let i = 0; i < count; i += 1) {
    const [label, note] = routeOptionPool[(depth + i) % routeOptionPool.length]
    const ref = node.ref === routeRootRef ? 'route:c' + i : node.ref + '-' + i
    node.children.push({ ref, label: label + '（' + (depth + 1) + '层）', note })
  }
}
const routeTick = (row) => {
  if (row.status === 'expanding' && !window.__holdRouteMindmap && Date.now() - row.startedAt >= 6000) {
    if (window.__failRouteMindmap) { row.status = 'failed'; row.error = String(window.__failRouteMindmap); window.__failRouteMindmap = null }
    else if (row.expandingNodeRef) {
      const target = row.graph ? routeFind(row.graph.root, row.expandingNodeRef) : null
      if (!target) { row.status = 'failed'; row.error = 'route_expand_target_lost' }
      else { routeAttach(target, (row.selectionPath ?? [routeRootRef]).length - 1); row.status = 'active'; row.expandingNodeRef = null; row.generatedAt = new Date().toISOString() }
    } else {
      row.graph = { root: { ref: routeRootRef, label: row.title, note: null } }
      routeAttach(row.graph.root, 0)
      row.status = 'active'; row.selectionPath = [routeRootRef]; row.generatedAt = new Date().toISOString()
    }
  }
  if (row.writing && Date.now() - row.writingAt >= 5000) {
    row.writing = false
    row.error = window.__failRouteWriting ? 'route_writing_failed:mock' : null
    if (window.__failRouteWriting) window.__failRouteWriting = null
  }
  return row
}
const routeDto = (roomId, documentId, row, requestVersion) => !row
  ? { roomId, documentId, title: routeFixtureTitles[documentId] ?? '', description: null, status: 'missing', skipped: false, writing: false, error: null, expandingNodeRef: null, graph: null, selectionPath: null, finalizedAt: null, generatedAt: null, promptVersion: null, requestVersion }
  : { roomId, documentId: row.documentId, title: row.title, description: row.description, status: row.status, skipped: row.skipped === true, writing: row.writing === true, error: row.error, expandingNodeRef: row.expandingNodeRef, graph: row.graph, selectionPath: row.selectionPath, finalizedAt: row.finalizedAt, generatedAt: row.generatedAt, promptVersion: row.graph ? 1 : null, requestVersion }
const routeAction = (roomId, q) => {
  let row = routeStore.get(q.documentId) ?? null
  if (q.action === 'start') {
    if (!row) {
      row = { roomId, documentId: q.documentId, title: q.title ?? routeFixtureTitles[q.documentId] ?? '未命名文档', description: q.description ?? null, status: 'expanding', skipped: false, writing: false, error: null, expandingNodeRef: null, graph: null, selectionPath: null, finalizedAt: null, generatedAt: null, startedAt: Date.now(), writingAt: 0 }
      routeStore.set(q.documentId, row)
    } else if (row.status === 'failed') {
      row.error = null; row.status = 'expanding'; row.startedAt = Date.now()
      if (!row.graph || !row.expandingNodeRef) { row.graph = null; row.selectionPath = null }
    } else if (row.skipped && !row.graph) {
      row.skipped = false; row.status = 'expanding'; row.startedAt = Date.now()
    } else if (row.skipped) {
      row.skipped = false
    }
  } else if (q.action === 'expand') {
    if (!row || !row.graph) throw new Error('route_not_generated')
    if (row.status === 'expanding') throw new Error('route_busy')
    if (row.status === 'finalized') throw new Error('route_not_finalizable')
    const node = routeFind(row.graph.root, q.nodeRef)
    if (!node) throw new Error('route_node_not_found')
    row.selectionPath = routePathTo(row.graph.root, q.nodeRef)
    row.skipped = false
    if (!node.children || node.children.length === 0) { row.status = 'expanding'; row.expandingNodeRef = node.ref; row.error = null; row.startedAt = Date.now() }
  } else if (q.action === 'back') {
    if (!row || !row.selectionPath) throw new Error('route_path_missing')
    if (row.status === 'finalized') throw new Error('route_not_finalizable')
    const depth = Math.max(0, Math.min(q.toDepth ?? 0, row.selectionPath.length - 1))
    row.selectionPath = row.selectionPath.slice(0, depth + 1)
  } else if (q.action === 'skip') {
    if (!row) {
      row = { roomId, documentId: q.documentId, title: routeFixtureTitles[q.documentId] ?? '未命名文档', description: null, status: 'active', skipped: true, writing: false, error: null, expandingNodeRef: null, graph: null, selectionPath: null, finalizedAt: null, generatedAt: null, startedAt: 0, writingAt: 0 }
      routeStore.set(q.documentId, row)
    } else row.skipped = true
  } else if (q.action === 'finalize') {
    if (!row || !row.graph) throw new Error('route_not_generated')
    const retryable = row.status === 'finalized' && row.error !== null && row.writing !== true
    if (row.status !== 'active' && !retryable) throw new Error('route_not_finalizable')
    if (!row.selectionPath || row.selectionPath.length < 2) throw new Error('route_path_empty')
    row.status = 'finalized'; row.writing = true; row.error = null; row.finalizedAt = row.finalizedAt ?? new Date().toISOString(); row.writingAt = Date.now()
  }
  if (row) routeTick(row)
  return routeDto(roomId, q.documentId, row, q.requestVersion)
}
// 飞书 agent-auth mock 状态机：start 出 pending 卡；window.__feishu.completeAuth('名字')
// 模拟浏览器授权完成；window.__feishu.reset() 回到未连接；disconnect 走真入口。
const authSubs = new Set()
const authEmit = (frame) => { for (const cb of authSubs) cb(frame) }
let authState = { appConfigured: false, userAuthorized: false, userName: null }
let authChallenge = null
const mkChallenge = (phase) => ({
  id: 'challenge-mock-' + Date.now(),
  provider: 'feishu',
  phase,
  status: 'pending',
  reason: 'not_connected',
  title: '授权飞书账号',
  verificationUrl: phase === 'user_auth' ? 'https://feishu.cn/verify?code=mock123' : 'https://feishu.cn/app-setup',
  steps: [
    { id: 's1', title: '打开授权页面', description: '在浏览器完成飞书登录授权', action: 'open_url', url: 'https://feishu.cn/verify?code=mock123', completed: false },
  ],
  exportRunId: null,
  message: null,
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
})
const authStatus = () => ({
  feishu: { cliState: 'ready', cliPath: '/mock/lark-cli', appConfigured: authState.appConfigured, userAuthorized: authState.userAuthorized, userName: authState.userName, message: null },
  activeChallenge: authChallenge,
})
window.__feishu = {
  completeAuth: (userName = '王小雨') => {
    authState = { appConfigured: true, userAuthorized: true, userName }
    authChallenge = authChallenge ? { ...authChallenge, status: 'authorized', message: '已连接 ' + userName } : null
    authEmit({ type: 'environment.changed', status: authStatus() })
  },
  reset: () => {
    authState = { appConfigured: false, userAuthorized: false, userName: null }
    authChallenge = null
    authEmit({ type: 'environment.changed', status: authStatus() })
  },
}
const base = {
  platform: ${JSON.stringify(process.env.MOCK_PLATFORM || 'win32')},
  window: {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    getState: async () => ({ maximized: false }),
    onMaximizedChange: () => () => {},
  },
  locale: { system: 'zh-CN', getSystem: async () => 'zh-CN' },
  agentAuth: {
    status: async () => authStatus(),
    start: async (input) => {
      const phase = input?.phase ?? (authState.appConfigured ? 'user_auth' : 'app_setup')
      authChallenge = mkChallenge(phase)
      authEmit({ type: 'environment.changed', status: authStatus() })
      return authChallenge
    },
    resume: async () => authStatus(),
    cancel: async (id) => {
      if (authChallenge && (!id || authChallenge.id === id)) {
        authChallenge = null
        authEmit({ type: 'challenge.removed', challengeId: id })
        authEmit({ type: 'environment.changed', status: authStatus() })
      }
      return authStatus()
    },
    disconnect: async (provider) => {
      if (provider !== 'feishu') throw new Error('仅支持飞书')
      authState = { appConfigured: false, userAuthorized: false, userName: null }
      authChallenge = null
      authEmit({ type: 'environment.changed', status: authStatus() })
      return authStatus()
    },
    onEvent: (cb) => { authSubs.add(cb); return () => authSubs.delete(cb) },
  },
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
    // 存量 oo 飞书连接：验证换轨后数据源页彻底隐藏。
    { id: 'conn-feishu-oo', provider: 'feishu', service: 'feishu', connectionName: '公司飞书', status: 'active', updatedAt: '2026-09-08T09:30:00.000Z' },
  ], scopes: [
    { id: 'sc-1', connectionId: 'conn-gmail', provider: 'gmail', label: 'INBOX', state: 'idle', updatedAt: '2026-09-04T10:00:00.000Z' },
  ], runs: [
    { id: 'r1', scopeId: 'sc-1', mode: 'incremental', status: 'completed', processed: 3200, failed: 0, error: null, startedAt: '2026-09-05T08:30:00.000Z', finishedAt: '2026-09-05T08:33:00.000Z' },
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
    recordTotals: async () => ({ mail: 3210, calendar: 0 }) },
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
  ] }),
    // mock-room（工作板块验证）数据面：md 供目录边栏验证，pdf 走外部打开占位卡。
    listRoomFiles: async () => ({ items: [
      { id: 'kfile-md', originalName: '调研笔记：连接器统一.md', bytes: 9216, title: null, status: 'confirmed', decidedBy: null, confidence: null, uploadedAt: new Date(Date.now() - 36 * 3600_000).toISOString() },
      { id: 'kfile-pdf', originalName: '竞品分析.pdf', bytes: 2411724, title: null, status: 'confirmed', decidedBy: null, confidence: null, uploadedAt: new Date(Date.now() - 96 * 3600_000).toISOString() },
    ] }),
    readFileMarkdown: async () => ({ markdown: [
      '# 连接器统一调研',
      '背景与目标概述。',
      '## 现状梳理',
      '三条链路并存：Gmail 双链路、日历、云文档。',
      '### Gmail 链路',
      'oo runs 与 managed-gmail 分表。',
      '### 日历链路',
      'googlecalendar 无连字符命名。',
      '## 目标架构',
      '统一 oo action 执行面。',
      '### 阶段一',
      '连接器身份合并。',
      '### 阶段二',
      '格式映射自愈。',
      '## 风险与开放问题',
      '会话失效静默问题待解。',
    ].join(NL + NL) }),
    revealFile: async () => {},
    listWikiPages: async () => {
      const w = window.__mockWiki = window.__mockWiki || {}
      const status = w.status || 'ready'
      if (status === 'ready') return { status, items: [
        { id: 'wp-1', title: '连接器统一·现状', type: 'page', path: '连接器统一/现状', description: null },
        { id: 'wp-2', title: '连接器统一·目标架构', type: 'page', path: '连接器统一/目标架构', description: null },
        { id: 'wp-3', title: '设计规范·动效篇', type: 'page', path: '设计规范/动效', description: null },
      ], pageCount: 3,
        summary: '连接器统一进入映射表收敛阶段，Gmail/日历双链路已并入统一格式层。目标架构以 provider 命名规范为先，映射表三处同值待收口；设计规范动效篇已定稿。',
        updatedAt: '2026-09-18T08:30:00.000Z' }
      return { status, items: [], pageCount: w.pageCount || 0, summary: '', updatedAt: '' }
    },
    getWikiGraph: async () => {
      if (window.__mockWiki && window.__mockWiki.graphError) throw new Error('KS 临时不可用（503）')
      return { nodes: [
        { id: 'wp-1', title: '连接器统一·现状', path: '连接器统一/现状', inLinks: 0 },
        { id: 'wp-2', title: '连接器统一·目标架构', path: '连接器统一/目标架构', inLinks: 1 },
        { id: 'wp-3', title: '设计规范·动效篇', path: '设计规范/动效', inLinks: 1 },
      ], edges: [
        { source: 'wp-1', target: 'wp-2' },
        { source: 'wp-1', target: 'wp-3' },
      ] }
    },
    // 手动重试构建：processing 起步，页数逐拍推进，3s 后 ready（验证轮询接管）
    retryWikiBuild: async () => {
      const w = window.__mockWiki = window.__mockWiki || {}
      w.status = 'processing'
      w.pageCount = 1
      setTimeout(() => { w.pageCount = 2 }, 1500)
      setTimeout(() => { w.status = 'ready'; w.pageCount = 3 }, 3000)
      return { ok: true }
    },
    getRoomRelations: async () => ({ rooms: [], edges: [], indexing: { status: 'ready', pendingSources: 0 } }),
    getRoomGraph: async () => ({ rooms: [], edges: [], indexing: { status: 'ready', pendingSources: 0 } }),
    // 思路·聚焦=写作路线导图 mock：GET 无行=missing（不轮询），动作走 routeAction。
    getRouteMindmap: async (roomId, q) => {
      const row = routeStore.get(q.documentId) ?? null
      if (row) routeTick(row)
      return routeDto(roomId, q.documentId, row, q.requestVersion)
    },
    routeMindmapAction: async (roomId, q) => routeAction(roomId, q),
    // 思路·知识涌现 mock（仅漫步；聚焦已迁写作路线导图）：8 张带路径的卡按 seed 轮换。
    emergence: async (_roomId, req) => {
      // 默认 900ms 延迟模拟投影耗时；页面里置 window.__holdEmergence=true 可挂起响应（验证加载态），调 window.__releaseEmergence() 放行
      await new Promise((resolve) => {
        const w = window
        const done = () => { if (w.__releaseEmergence === done) w.__releaseEmergence = null; resolve() }
        if (w.__holdEmergence) { w.__releaseEmergence = done; setTimeout(done, 8000) }
        else setTimeout(done, 900)
      })
      const docCenter = 'doc:' + (req.focus.documentId ?? 'doc-native-1')
      const emNodes = [
        { id: 'room:thoughts-mock', nodeType: 'room', label: '思路涌现验证', sourceGraph: 'roomGraph', roomRef: null, updatedAt: '2026-09-14T08:00:00.000Z' },
        { id: 'doc:doc-native-1', nodeType: 'document', label: '产物：发布计划', sourceGraph: 'linkGraph', roomRef: null, updatedAt: '2026-09-13T10:00:00.000Z' },
        { id: 'doc:doc-native-2', nodeType: 'document', label: '产物：复盘草稿', sourceGraph: 'linkGraph', roomRef: null, updatedAt: '2026-09-12T09:00:00.000Z' },
        { id: 'entity:person-linwei', nodeType: 'entity', label: '林薇', sourceGraph: 'entityFacts', roomRef: null, updatedAt: '2026-09-13T04:00:00.000Z' },
        { id: 'entity:team-visual', nodeType: 'entity', label: '视觉组', sourceGraph: 'entityFacts', roomRef: null, updatedAt: '2026-09-11T06:00:00.000Z' },
        { id: 'fact:decision-v1', nodeType: 'fact', label: 'V1 视觉定稿', sourceGraph: 'entityFacts', roomRef: null, updatedAt: '2026-09-13T04:00:00.000Z' },
        { id: 'fact:conflict-timeline', nodeType: 'fact', label: '排期冲突', sourceGraph: 'entityFacts', roomRef: null, updatedAt: '2026-09-10T02:00:00.000Z' },
        { id: 'memory:insight-motion', nodeType: 'memory', label: '动效时长约定 240ms', sourceGraph: 'roomGraph', roomRef: null, updatedAt: '2026-09-09T08:00:00.000Z' },
        { id: 'wiki:3', nodeType: 'wikiPage', label: '设计规范·动效篇', sourceGraph: 'wiki', roomRef: { id: 'room-3', title: '连接器' }, updatedAt: '2026-09-08T08:00:00.000Z' },
      ]
      const emEdges = [
        { id: 'e1', from: 'room:thoughts-mock', to: 'doc:doc-native-1', relationType: '包含', edgeLevel: 'original', confidence: 1 },
        { id: 'e2', from: 'doc:doc-native-1', to: 'fact:decision-v1', relationType: '记录', edgeLevel: 'original', confidence: 0.9 },
        { id: 'e3', from: 'doc:doc-native-1', to: 'entity:person-linwei', relationType: '作者', edgeLevel: 'composed', confidence: null },
        { id: 'e4', from: 'fact:decision-v1', to: 'entity:team-visual', relationType: '涉及', edgeLevel: 'semantic', confidence: null },
        { id: 'e5', from: 'doc:doc-native-2', to: 'fact:conflict-timeline', relationType: '记录', edgeLevel: 'original', confidence: 0.8 },
        { id: 'e6', from: 'entity:person-linwei', to: 'entity:team-visual', relationType: '成员', edgeLevel: 'composed', confidence: null },
        { id: 'e7', from: 'fact:decision-v1', to: 'memory:insight-motion', relationType: '衍生', edgeLevel: 'semantic', confidence: null },
        { id: 'e8', from: 'memory:insight-motion', to: 'wiki:3', relationType: '沉淀于', edgeLevel: 'composed', confidence: null },
        { id: 'e9', from: 'room:thoughts-mock', to: 'doc:doc-native-2', relationType: '包含', edgeLevel: 'original', confidence: 1 },
        { id: 'e10', from: 'fact:conflict-timeline', to: 'entity:person-linwei', relationType: '上报', edgeLevel: 'original', confidence: 0.7 },
      ]
      const start = req.wander?.startNodeRef || docCenter
        const wanderCards = [
          { id: 'w1', kind: 'case', title: '相似案例：Notion 的渐进披露', summary: '同类产品把图谱入口收进右上角，正文保持纯净。', sourceType: 'wikiPage', occurredAt: null, roomRef: { id: 'room-3', title: '连接器' }, reason: '与「设计规范·动效篇」相邻，来自另一条知识链。', quote: null, nodeRef: 'wiki:3',
            path: { nodeRefs: [start, 'memory:insight-motion', 'wiki:3'], hops: ['涉及', '沉淀于'] } },
          { id: 'w2', kind: 'question', title: '待回答：脉络视图在窄容器里怎么收？', summary: '伴随区收窄后图谱是否降级为列表还未定。', sourceType: 'room', occurredAt: null, roomRef: null, reason: '在「动效时长约定」的邻接位置被翻出。', quote: null, nodeRef: 'memory:insight-motion',
            path: { nodeRefs: [start, 'fact:decision-v1', 'memory:insight-motion'], hops: ['记录', '衍生'] } },
          { id: 'w3', kind: 'viewpoint', title: '林薇：动效时长建议 240ms', summary: '全场统一 240ms + ease-out，卡片错峰 40ms 递增。', sourceType: 'entity', occurredAt: '2026-09-13T04:00:00.000Z', roomRef: null, reason: '从「V1 视觉定稿」沿作者关系走到人。', quote: '过渡动画统一 240ms，列表类内容做 40ms 错峰。', nodeRef: 'entity:person-linwei',
            path: { nodeRefs: [start, 'fact:decision-v1', 'entity:person-linwei'], hops: ['记录', '署名'] } },
          { id: 'w4', kind: 'evidence', title: '邮件证据：V1 视觉定稿周报', summary: '林薇发出的周报确认 V1 视觉已定稿。', sourceType: 'mail', occurredAt: '2026-09-12T09:00:00.000Z', roomRef: null, reason: '三跳之外翻到的直接证据。', quote: 'V1 视觉已定稿，附件是标注稿。', nodeRef: 'fact:decision-v1',
            path: { nodeRefs: [start, 'fact:decision-v1'], hops: ['记录'] } },
          { id: 'w5', kind: 'conflict', title: '排期冲突：视觉与连接器里程碑撞车', summary: '同一周内两个团队的交付节点重叠。', sourceType: 'fact', occurredAt: '2026-09-10T02:00:00.000Z', roomRef: null, reason: '在「复盘草稿」的邻接位置被翻出。', quote: null, nodeRef: 'fact:conflict-timeline',
            path: { nodeRefs: [start, 'entity:person-linwei', 'fact:conflict-timeline'], hops: ['参与', '上报'] } },
          { id: 'w6', kind: 'actor', title: '视觉组', summary: '负责 V1 全部视觉产出与设计规范维护。', sourceType: 'entity', occurredAt: null, roomRef: null, reason: '从「排期冲突」沿团队关系走到组织。', quote: null, nodeRef: 'entity:team-visual',
            path: { nodeRefs: [start, 'fact:decision-v1', 'entity:team-visual'], hops: ['记录', '涉及'] } },
          { id: 'w7', kind: 'decision', title: '历史决策：图谱入口收进右上角', summary: '早期版本把图谱放正文底部，后来收敛为图标切换。', sourceType: 'document', occurredAt: '2026-09-11T06:00:00.000Z', roomRef: null, reason: '与「设计规范·动效篇」同源。', quote: null, nodeRef: 'wiki:3',
            path: { nodeRefs: [start, 'memory:insight-motion', 'wiki:3'], hops: ['衍生', '沉淀于'] } },
          { id: 'w8', kind: 'case', title: '相似案例：Roam 的每日笔记', summary: '按时间组织入口、按图谱组织关系的先例。', sourceType: 'wikiPage', occurredAt: null, roomRef: { id: 'room-3', title: '连接器' }, reason: '跨 Room 翻到的相邻案例。', quote: null, nodeRef: 'wiki:3',
            path: { nodeRefs: [start, 'doc:doc-native-2', 'fact:conflict-timeline', 'entity:team-visual'], hops: ['关联', '记录', '涉及'] } },
        ]
        const seed = req.wander?.seed ?? 0
        const rotated = wanderCards.slice(seed % wanderCards.length).concat(wanderCards.slice(0, seed % wanderCards.length)).slice(0, Math.min(req.limit ?? 15, wanderCards.length))
      return { cards: rotated, nodes: emNodes, edges: emEdges, paths: rotated.map((c) => c.path), focusRootRef: start, scoreComponents: null, requestVersion: req.requestVersion, degraded: false, degradedReason: null, generatedAt: new Date().toISOString() } } },
  contextRooms: {
    // 登录后的首启探针读 rooms/deletedRooms 计数；不给 list 会打到兜底 Proxy 上崩。
    list: async () => ({ rooms: [], deletedRooms: [], updatedAt: null }),
    overview: async (roomId) => {
      const day = (offset, hour, minute = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, minute, 0, 0); return d.toISOString() }
      return { roomId, revision: 1, generatedAt: new Date().toISOString(), stale: false,
        overview: [{ id: 'ov-1', section: 'overview', text: '连接器统一进入阶段一：身份合并与命名对齐。', origin: 'fact', confidence: 0.9, evidence: [], corrected: false, occurredAt: null, data: { kind: 'overview', aspect: 'summary' } }],
        status: [{ id: 'st-1', section: 'status', text: 'Gmail 双链路排障入口已明确。', origin: 'fact', confidence: 0.8, evidence: [], corrected: false, occurredAt: null, data: { kind: 'status', category: 'progress', state: 'active' } }],
        nextSteps: [
          { id: 'ns-sched', section: 'next_steps', text: '与设计师同步连接器视觉', origin: 'fact', confidence: 1, evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-1', sourceTitle: null }], corrected: false, occurredAt: null, data: { kind: 'next_step', itemType: 'schedule', actionId: 'cal-1', owner: null, dueAt: day(0, 16), status: 'scheduled', priority: null, provider: 'google_calendar' } },
          { id: 'ns-todo', section: 'next_steps', text: '回复供应商报价邮件', origin: 'fact', confidence: 1, evidence: [{ sourceKind: 'todo', sourceId: 'todo-1', sourceTitle: null }], corrected: false, occurredAt: null, data: { kind: 'next_step', itemType: 'task', actionId: 'todo-1', owner: null, dueAt: day(1, 12), status: 'needsAction', priority: 'high' } },
        ],
        timeline: [
          { id: 'tl-meet', section: 'timeline', text: '周会：连接器排期', origin: 'fact', confidence: 1, evidence: [{ sourceKind: 'calendar-event', sourceId: 'cal-2', sourceTitle: null }], corrected: false, occurredAt: day(0, 14), data: { kind: 'timeline', eventType: 'meeting', title: '周会：连接器排期', description: '确认阶段一范围', certainty: 'fact', provider: 'google_calendar' } },
          { id: 'tl-task', section: 'timeline', text: '补齐 OAuth 文档', origin: 'fact', confidence: 1, evidence: [{ sourceKind: 'todo', sourceId: 'todo-2', sourceTitle: null }], corrected: false, occurredAt: day(-1, 10), data: { kind: 'timeline', eventType: 'task', title: '补齐 OAuth 文档', description: null, certainty: 'fact' } },
          { id: 'tl-fact', section: 'timeline', text: '林薇负责 V1 视觉设计', origin: 'fact', confidence: 0.9, evidence: [{ sourceKind: 'mail', sourceId: 'mail-1', sourceTitle: '设计周报' }], corrected: false, occurredAt: day(-2, 9), data: { kind: 'timeline', eventType: 'fact', title: '林薇负责 V1 视觉设计', description: null, certainty: 'fact' } },
        ],
        entities: [], appliedCorrectionIds: [] }
    },
    listMails: async () => ({ items: [
      { sourceId: 'gmail-1', subject: '设计周报：V1 视觉定稿', senderName: '林薇', senderAddress: 'linwei@example.com', sentAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(), snippet: 'V1 视觉已定稿，附件是标注稿。', hasAttachments: true, provider: 'gmail' },
      { sourceId: 'gmail-2', subject: '供应商报价（Q4）', senderName: '采购部', senderAddress: 'purchase@example.com', sentAt: new Date(Date.now() - 5 * 3600_000).toISOString(), snippet: '三家供应商报价见正文，请确认。', hasAttachments: false, provider: 'gmail' },
    ] }),
    readMail: async (_roomId, sourceId) => ({ sourceId, subject: sourceId === 'gmail-1' ? '设计周报：V1 视觉定稿' : '供应商报价（Q4）', senderName: sourceId === 'gmail-1' ? '林薇' : '采购部', senderAddress: 'purchase@example.com', sentAt: new Date().toISOString(), hasAttachments: false, provider: 'gmail', origin: 'domain', body: '正文摘要（mock）。' + NL + NL + '请确认后回复。' }),
    roomEntities: async () => ({ roomId: 'room-board-mock', entities: [], facts: [], updatedAt: new Date().toISOString() }),
    completeLocalAction: async () => ({}),
  },
  documents: {
    list: async () => [],
    get: async () => null,
    // 编辑器保存链把返回值直接写进 backendRef 并读 contentJson/version，
    // 兜底 Proxy 的空壳对象会污染后续保存对比，这里回显完整文档语义。
    save: async (documentId, payload) => ({
      id: documentId,
      title: payload?.title ?? '',
      contentJson: payload?.contentJson ?? { type: 'doc', content: [] },
      contentSchemaVersion: 1,
      version: (payload?.baseVersion ?? 0) + 1,
      status: 'active',
      origin: 'native',
      activeTransactionId: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    versionChangeSummary: async () => ({ summary: '新增「阶段一」章节，调整风险列表（mock 摘要）。' }),
    listVersions: async () => [],
  },
  ingest: {
    listEvents: async (q) => {
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
    },
    getFilterRules: async () => ({ preference: sessionStorage.getItem('mockFilterPref') || '', insight: '', updatedAt: null }),
    updateFilterPreference: async (content) => ({ preference: content, insight: '', updatedAt: null }) },
  migrations: { sources: async () => [], runs: async () => [], onProgress: () => () => {}, conversations: async () => ({ items: [
    { id: 'thread-1', provider: 'claude', sourceId: 's1', title: '历史会话示例', agentId: 'claude', externalSessionId: 'x', messageCount: 2, lastMessageAt: '2026-09-08T00:00:00.000Z', lastMessageExcerpt: '上次的结论…', available: true },
  ], nextCursor: null }) },
  // 完整 App 入口（/）验证用：已配置 + 已登录，越过 RuntimeConfigGate。
  runtimeConfig: { get: async () => ({ primaryConfigured: true, configSource: 'manual' }) },
  account: { status: async () => ({ authenticated: true, apiBaseUrl: 'https://mock.example', plan: 'pro_plan_active' }) },
  agent: { discoverLocalAgents: async () => [] },
  reality: { listEvents: async () => [], onEvent: () => () => {} },
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
  root: resolve(here, 'src/renderer'),
  // 独立依赖缓存：与 electron-vite 渲染层隔离，避免多服务共用缓存互相改写导致页面整刷。
  cacheDir: resolve(here, 'node_modules/.vite-browser-mock'),
  optimizeDeps: {
    include: ['d3-force'],
  },
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
    alias: { '@': resolve(here, 'src/renderer/src') },
  },
  plugins: [react(), nxcoreMock()],
})
