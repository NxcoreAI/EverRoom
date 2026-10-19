// 临时入口：纯浏览器单挂 DiaryPage，验证时间轴排序（最新事件在最上方）。
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { DiaryPage } from './components/diary/DiaryPage'
import type { DiaryDayDetails } from '../../shared/sources'
import '@/styles/tokens.css'
import './styles.css'

const today = new Date()
today.setHours(0, 0, 0, 0)
const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
const at = (hours: number, minutes: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes).toISOString()

const details: DiaryDayDetails = {
  day: { date: dateKey, status: 'ready', eventCount: 6, lastError: null },
  currentVersion: {
    id: 'v1',
    date: dateKey,
    version: 1,
    agentModel: 'test',
    createdAt: at(18, 0),
    content: {
      headline: '验证时间轴排序',
      summary: '六条按时间升序排列的事件，渲染后最新的应显示在最上方。',
      reflection: '排序验证用样例数据。',
      range: { start: at(9, 5), end: at(17, 30) },
      events: [
        { time: at(9, 5), title: '早晨专注', summary: '第一条（最早）', sourceRefs: ['focus-1'] },
        { time: at(10, 30), title: '邮件往来', summary: '第二条', sourceRefs: ['mail-1'] },
        { time: at(12, 0), title: '屏幕截图', summary: '第三条', sourceRefs: ['visual-1'] },
        { time: at(14, 20), title: '会议录音', summary: '第四条', sourceRefs: ['rec-1'] },
        { time: at(16, 45), title: '文档编辑', summary: '第五条', sourceRefs: ['doc-1'] },
        { time: at(17, 30), title: '日历安排', summary: '第六条（最晚）', sourceRefs: ['cal-1'] },
      ],
      closing: '样例收尾语。',
    },
  },
  sources: [
    { sourceId: 'focus-1', sourceKind: 'memory', occurredAt: at(9, 5), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: null, mime: null },
    { sourceId: 'mail-1', sourceKind: 'connector_email', occurredAt: at(10, 30), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: null, mime: null },
    { sourceId: 'visual-1', sourceKind: 'visual_node', occurredAt: at(12, 0), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: 'screenshot', mime: null },
    { sourceId: 'rec-1', sourceKind: 'recording', occurredAt: at(14, 20), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: null, mime: null, realityEventId: 'rec-1' },
    { sourceId: 'doc-1', sourceKind: 'file', occurredAt: at(16, 45), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: 'document', mime: null },
    { sourceId: 'cal-1', sourceKind: 'connector_calendar', occurredAt: at(17, 30), endedAt: null, timeBasis: 'event', evidenceSummary: '', assetFileId: null, assetKind: null, mime: null },
  ],
}

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'diary') {
      return {
        ...((target.diary as object) ?? {}),
        activeRun: async () => null,
        days: async () => [details.day],
        day: async () => details,
      }
    }
    if (prop === 'files') {
      return {
        ...((target.files as object) ?? {}),
        readDataUrl: async () => {
          throw new Error('mock: no media')
        },
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <DiaryPage />
  </LocaleProvider>,
)
