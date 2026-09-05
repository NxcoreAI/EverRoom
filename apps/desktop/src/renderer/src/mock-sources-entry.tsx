// 临时入口:纯浏览器单独挂载 SourcesPage(配合 /@mock/nxcore.js),复现页面交互(验证后删除)。
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { SourcesPage } from './components/pages/SourcesPage'
import '@/styles/tokens.css'
import './styles.css'

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <SourcesPage />
  </LocaleProvider>,
)
