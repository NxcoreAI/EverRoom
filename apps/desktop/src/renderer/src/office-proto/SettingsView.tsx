import { useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'

import { SettingsPage } from '@/components/pages/SettingsPage'
import { WindowControls } from '@/components/WindowControls'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * 原型外壳（OfficeProto）内的设置页容器。
 *
 * 设置页本体是从旧桌面端恢复的 SettingsPage（账号/登录、模型与运行时、连接器、
 * MCP、本地 Agent、用量、更新等完整设置面）；原型外壳没有旧 App 的页面路由与
 * 顶栏，所以这里用一个覆盖整个窗口的层承载它，并补上「返回」入口、窗口拖拽区
 * 与 Windows 自绘窗口按钮。
 */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="op-settings-view" role="dialog" aria-modal="true" aria-label={t('surface:settings.settings')}>
      <header className="op-settings-view-bar drag-region">
        <button
          className="op-settings-back no-drag"
          type="button"
          title={t('surface:configGate.back')}
          aria-label={t('surface:configGate.back')}
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t('surface:configGate.back')}</span>
        </button>
        <div className="op-settings-view-actions no-drag">
          <WindowControls />
        </div>
      </header>
      <div className="op-settings-view-body">
        <SettingsPage />
      </div>
    </div>
  )
}
