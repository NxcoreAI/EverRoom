// 统一搜索面板浏览器验证页：注入 script 化 nxcore.search 数据面，
// 驱动四类结果、筛选、高亮、meta_only 优先处理与上下文展开。
import { createRoot } from 'react-dom/client'
import { useState } from 'react'

import { SearchPalette } from './components/search/SearchPalette'
import { LocaleProvider } from './i18n/LocaleContext'
import type { SearchHitDto, SearchPageDto } from '../../shared/search'
import '@/styles/tokens.css'
import './styles.css'

const now = Date.now()
const iso = (offsetHours: number) => new Date(now - offsetHours * 3600_000).toISOString()

const seedHits: SearchHitDto[] = [
  {
    id: 'file:1', itemType: 'file', refId: 'file-1', title: '定价方案 v3.md',
    snippet: '本次定价方案采用阶梯制，定价基准为成本加成 30%，年度合同再降 5 个点。',
    sourceKind: 'local-folder', roomIds: ['room-1'], occurredAt: iso(26), ingestedAt: iso(24),
    timeBasis: 'occurred', versionLabel: 'v3', fileVersionId: 'fv-1', status: 'indexed', sessionId: null, pageId: null,
  },
  {
    id: 'message:2', itemType: 'message', refId: 'msg-2', title: '产品调研',
    snippet: '竞品的定价方案在 9 月更新过，新客首年打七折，我们建议跟进类似的定价策略。',
    sourceKind: null, roomIds: ['room-1'], occurredAt: null, ingestedAt: iso(5), timeBasis: 'ingested',
    versionLabel: null, fileVersionId: null, status: 'indexed', sessionId: 'session-1', pageId: 'home',
  },
  {
    id: 'room:3', itemType: 'room', refId: 'room-1', title: '产品调研',
    snippet: '连接器统一调研：三条链路并存，目标架构以统一执行面为先。',
    sourceKind: 'room', roomIds: ['room-1'], occurredAt: null, ingestedAt: iso(24 * 30), timeBasis: 'ingested',
    versionLabel: null, fileVersionId: null, status: 'indexed', sessionId: null, pageId: null,
  },
  {
    id: 'document:4', itemType: 'document', refId: 'doc-4', title: '定价策略汇报.pptx',
    snippet: '', sourceKind: 'native', roomIds: ['room-1'], occurredAt: null, ingestedAt: iso(10),
    timeBasis: 'ingested', versionLabel: 'v2', fileVersionId: null, status: 'meta_only', sessionId: null, pageId: null,
  },
]

const rooms = [
  { id: 'room-1', title: '产品调研' },
  { id: 'room-2', title: '设计系统' },
]

let pending = 3

function installSearchMock(): void {
  const target = window.nxcore as unknown as Record<string, unknown> | undefined
  const searchMock = {
    invoke: async (request: { query?: string; types?: string[]; roomIds?: string[] }): Promise<SearchPageDto> => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const query = (request.query ?? '').trim()
      let items = seedHits
      if (query) items = items.filter((hit) => hit.title.includes(query) || hit.snippet.includes(query))
      if (request.types?.length) items = items.filter((hit) => request.types!.includes(hit.itemType))
      if (request.roomIds?.length) items = items.filter((hit) => hit.roomIds.some((id) => request.roomIds!.includes(id)))
      return {
        items,
        total: items.length,
        scope: { indexedCount: 1284, pendingCount: pending },
        providers: [],
      }
    },
    status: async () => ({ indexedCount: 1284, pendingCount: pending }),
    prioritize: async () => {
      pending = Math.max(0, pending - 1)
      seedHits[3] = {
        ...seedHits[3],
        snippet: '第 8 页给出阶梯定价的三档对照：个人版 39、团队版 99、企业版面议。',
        status: 'indexed',
      }
      return { ok: true }
    },
    messageContext: async () => ({
      sessionId: 'session-1',
      messages: [
        { id: 'msg-1', role: 'user', content: '竞品最近的价格政策有什么变化？', createdAt: iso(5.2) },
        { id: 'msg-2', role: 'assistant', content: '竞品的定价方案在 9 月更新过，新客首年打七折，建议跟进。', createdAt: iso(5) },
        { id: 'msg-3', role: 'user', content: '把对比写进调研文档。', createdAt: iso(4.8) },
      ],
    }),
  }
  if (target) target.search = searchMock
  else (window as unknown as Record<string, unknown>).nxcore = { search: searchMock }
}

installSearchMock()

function MockSearchApp() {
  const [open, setOpen] = useState(true)
  const [log, setLog] = useState<string[]>([])
  const push = (line: string) => setLog((current) => [...current, line])
  return (
    <LocaleProvider>
      <div style={{ padding: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button type="button" onClick={() => setOpen(true)}>打开搜索面板</button>
        <span style={{ color: '#888', fontSize: 12 }}>动作日志：{log.join(' / ') || '—'}</span>
      </div>
      <SearchPalette
        open={open}
        onClose={() => setOpen(false)}
        rooms={rooms}
        onOpenFile={(fileId) => push(`openFile(${fileId})`)}
        onOpenRoom={(roomId, title) => push(`openRoom(${roomId},${title})`)}
        onOpenSession={(hit) => push(`openSession(${hit.sessionId})`)}
        onAttach={(hit) => push(`attach(${hit.refId})`)}
        onDispatch={(hit, agent, instruction) => push(`dispatch(${hit.refId},${agent?.displayName ?? 'main'},${instruction})`)}
      />
    </LocaleProvider>
  )
}

createRoot(document.getElementById('mock-root')!).render(<MockSearchApp />)
