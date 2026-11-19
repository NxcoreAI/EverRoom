import { useState } from 'react'
import { AlertTriangle, LoaderCircle, Trash2 } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'

/**
 * 设置页「数据管理」区块：一键删除本机全部 EverRoom 数据。
 *
 * 主进程 `app:clear-user-data` 会优雅关闭各服务（含本地 SQLite/对象库），
 * 退出后删除 `userData` 下除登录态外的全部内容（数据库、记忆、录音、截图、
 * 连接配置、日志、缓存），再重启应用。登录凭据（refresh token 与设备密钥）
 * 会在删除前备份、删除后还原，重启后自动恢复会话，无需重新登录。
 * 待执行任务存于 gateway.sqlite（agent_schedules 表），随数据库一并清除。
 * 不触碰用户接入的原始文件夹本身，也不影响云端与账号数据。
 *
 * 不可恢复，因此用自绘确认弹窗 + 二次「确认删除」按钮双保险。
 */
export function DataManagementSettingsSection() {
  const { t } = useLocale()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startWipe = async () => {
    if (!window.nxcore || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore.app.clearUserData()
      // 成功路径不会返回：主进程会退出并重启应用。
    } catch (cause) {
      setBusy(false)
      setConfirmOpen(false)
      setError(cause instanceof Error ? cause.message : t('surface:settings.dataWipeFailed'))
    }
  }

  return (
    <section id="settings-data-management" className="reality-settings-section settings-anchor-section" aria-labelledby="data-management-settings-title">
      <header>
        <span className="danger-section-icon"><Trash2 aria-hidden="true" /></span>
        <div>
          <h2 id="data-management-settings-title">{t('surface:settings.dataManagementTitle')}</h2>
          <p>{t('surface:settings.dataManagementDescription')}</p>
        </div>
      </header>
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:settings.dataWipeRowTitle')}</strong>
          <small>{t('surface:settings.dataWipeRowDescription')}</small>
        </div>
        <button type="button" className="danger-button" onClick={() => { setError(null); setConfirmOpen(true) }}>
          <Trash2 aria-hidden="true" />
          {t('surface:settings.dataWipeAction')}
        </button>
      </div>
      {error ? (
        <div className="reality-setting-row">
          <small className="settings-danger-error" role="alert">{error}</small>
        </div>
      ) : null}

      {confirmOpen ? (
        <div className="data-wipe-confirm-overlay" role="presentation" onClick={() => { if (!busy) setConfirmOpen(false) }}>
          <div
            className="data-wipe-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-wipe-confirm-title"
            aria-describedby="data-wipe-confirm-body"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="data-wipe-confirm-heading">
              <AlertTriangle aria-hidden="true" />
              <h3 id="data-wipe-confirm-title">{t('surface:settings.dataWipeConfirmTitle')}</h3>
            </div>
            <p id="data-wipe-confirm-body">{t('surface:settings.dataWipeConfirmBody')}</p>
            <ul className="data-wipe-confirm-list">
              <li>{t('surface:settings.dataWipeConfirmItemFiles')}</li>
              <li>{t('surface:settings.dataWipeConfirmItemMemory')}</li>
              <li>{t('surface:settings.dataWipeConfirmItemRecordings')}</li>
              <li>{t('surface:settings.dataWipeConfirmItemCredentials')}</li>
              <li>{t('surface:settings.dataWipeConfirmItemNotTouched')}</li>
            </ul>
            <div className="data-wipe-confirm-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmOpen(false)}>
                {t('surface:settings.dataWipeCancel')}
              </button>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void startWipe()}>
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                {busy ? t('surface:settings.dataWipeRunning') : t('surface:settings.dataWipeConfirmAction')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
