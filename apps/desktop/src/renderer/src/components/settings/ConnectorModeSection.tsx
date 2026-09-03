import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, HardDrive } from 'lucide-react'
import { useAccount } from '@/state/AccountContext'

type ConnectorLayerMode = 'saas' | 'local'
interface ConnectorModeState { mode: ConnectorLayerMode; switchedAt: string | null }

/**
 * 连接层模式（P2-4 / D1-D2 决策）：全局单开关，默认 SaaS。
 * - SaaS：OpenConnector 由 EverRoomSass 托管（默认，需登录 EverRoom 账号）
 * - 本地：本地启动 OpenConnector 服务（隐私兜底）
 * 切换后已有连接需重新授权（C3：token 不跨实例迁移）。
 */
export function ConnectorModeSection() {
  const { t } = useTranslation()
  const { account } = useAccount()
  const [state, setState] = useState<ConnectorModeState | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.nxcore?.cliConnector.mode().then(setState).catch(() => setState(null))
  }, [])

  const choose = async (mode: ConnectorLayerMode) => {
    if (!state || state.mode === mode || pending) return
    if (mode === 'saas' && !account?.authenticated) {
      setNotice(t('surface:settings.connectorModeSaasLoginRequired', {
        defaultValue: '使用云端连接层需要先登录 EverRoom 账号（设置 → EverRoom 账号）。',
      }))
      return
    }
    setPending(true)
    try {
      const next = await window.nxcore?.cliConnector.setMode(mode)
      if (next) setState(next)
      setNotice(t('surface:settings.connectorModeSwitchedNotice', {
        defaultValue: '连接层已切换，重启应用后生效；已有连接需要重新授权。',
      }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  const options: Array<{ id: ConnectorLayerMode; icon: typeof Cloud; title: string; description: string; disabled?: boolean }> = [
    {
      id: 'saas',
      icon: Cloud,
      title: t('surface:settings.connectorModeSaasTitle', { defaultValue: '云端连接层（默认）' }),
      description: t('surface:settings.connectorModeSaasDescription', {
        defaultValue: 'OpenConnector 由 EverRoomSass 托管，数百个服务的 OAuth 配置统一管理，无需本地运行。',
      }),
    },
    {
      id: 'local',
      icon: HardDrive,
      title: t('surface:settings.connectorModeLocalTitle', { defaultValue: '本地连接层' }),
      description: t('surface:settings.connectorModeLocalDescription', {
        defaultValue: '在本机启动 OpenConnector 服务，凭据与数据完全留在本地（隐私兜底）。',
      }),
    },
  ]

  if (!window.nxcore?.cliConnector.mode) return null

  return (
    <section id="settings-connector-mode" className="reality-settings-section settings-anchor-section" aria-labelledby="connector-mode-title">
      <header>
        <div>
          <h2 id="connector-mode-title">{t('surface:settings.connectorModeTitle', { defaultValue: '连接层模式' })}</h2>
          <p>{t('surface:settings.connectorModeDescription', {
            defaultValue: '选择第三方服务（Gmail/Notion/日历…）的连接层运行位置；切换后已有连接需重新授权。',
          })}</p>
        </div>
      </header>
      <div className="connector-mode-options">
        {options.map(({ id, icon: Icon, title, description }) => (
          <button
            key={id}
            type="button"
            className="connector-mode-option"
            data-active={String(state?.mode === id)}
            disabled={pending}
            onClick={() => void choose(id)}
          >
            <span className="connector-mode-option-icon"><Icon aria-hidden="true" /></span>
            <span className="connector-mode-option-body">
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <span className="connector-mode-option-state" aria-hidden="true">
              {state?.mode === id ? '●' : ''}
            </span>
          </button>
        ))}
      </div>
      {notice ? <p className="connector-mode-notice" role="status">{notice}</p> : null}
    </section>
  )
}
