// 临时入口：纯浏览器单挂 HighRiskImportReview，验证按钮视觉层级。
import { createRoot } from 'react-dom/client'

import { HighRiskImportReview } from './components/HighRiskImportReview'
import { LocaleProvider } from './i18n/LocaleContext'
import type { HighRiskImportResolution, HighRiskImportReview as HighRiskImportReviewDto } from '../../shared/ingest'
import '@/styles/tokens.css'
import './styles.css'

const reviews: HighRiskImportReviewDto[] = [
  { id: 'rev-1', origin: 'auto-scan', sourceLabel: '产品笔记', fileCount: 46, createdAt: new Date().toISOString() },
  { id: 'rev-2', origin: 'manual-import', sourceLabel: '本地文件夹', fileCount: 8, createdAt: new Date().toISOString() },
]

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'files') {
      return {
        ...((target.files as object) ?? {}),
        listHighRiskReviews: async () => ({ items: reviews }),
        resolveHighRiskReview: async (_id: string, accepted: boolean): Promise<HighRiskImportResolution> => {
          reviews.shift()
          return { accepted, imported: accepted ? reviews.length + 41 : 0, failed: 0 }
        },
        onHighRiskReviewsChanged: () => () => {},
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <HighRiskImportReview />
  </LocaleProvider>,
)
