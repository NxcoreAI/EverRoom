// 临时入口：纯浏览器挂载 AppToast，验证 error 变体顶部红色横幅的进出场（验证后删除）。
import { createRoot } from 'react-dom/client'

import { AppToast } from './components/AppToast'
import { LocaleProvider } from './i18n/LocaleContext'
import { showToast } from './state/toast'
import '@/styles/tokens.css'
import './styles.css'

const button = (label: string, onClick: () => void) => (
  <button type="button" onClick={onClick} style={{ padding: '8px 14px' }}>{label}</button>
)

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <div style={{ display: 'flex', gap: 12, padding: 80 }}>
      {button('error', () => showToast({ variant: 'error', title: '请求未完成', message: '浏览器登录等待超时，请重试。' }))}
      {button('error+action', () => showToast({
        variant: 'error',
        title: '请求未完成',
        message: '无法访问麦克风，请检查系统权限。',
        actionLabel: '打开系统设置',
        onAction: () => { window.console.log('action clicked') },
      }))}
      {button('info', () => showToast({ title: '操作提示', message: '请求过于频繁，请稍后再试。' }))}
    </div>
    <AppToast />
  </LocaleProvider>,
)
