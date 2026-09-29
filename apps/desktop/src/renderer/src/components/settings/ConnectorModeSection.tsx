import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, HardDrive, Plug } from 'lucide-react'
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
    // 真·开源版（改造清单#6）：重新授权的代价在动手前讲清楚，不是切完才告知。
    if (!window.confirm(t('surface:settings.connectorModeConfirmSwitch', {
      defaultValue: '切换连接层模式后，已连接的服务需要全部重新授权才能继续使用。确定要切换吗？',
    }))) return
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

  const options: Array<{ id: ConnectorLayerMode; icon: typeof Cloud; title: string; desc: string; disabled?: boolean }> = [
    {
      id: 'saas',
      icon: Cloud,
      title: t('surface:settings.connectorModeSaasTitle', { defaultValue: '云端连接层（默认）' }),
      desc: t('surface:settings.connectorModeSaasDesc', { defaultValue: '官方云端执行授权与数据拉取，需登录 EverRoom 账号；凭据不落本机。' }),
      // 已切到本地且未登录时，云端档点不动是"需登录"的拦截——禁用+提示，
      // 而不是无反馈（否则用户以为切换坏了）。
      disabled: !account?.authenticated && state?.mode === 'local',
    },
    {
      id: 'local',
      icon: HardDrive,
      title: t('surface:settings.connectorModeLocalTitle', { defaultValue: '本地连接层' }),
      desc: t('surface:settings.connectorModeLocalDesc', { defaultValue: '在本机运行 OpenConnector，数据不出本机；首次使用需在本地管理台配置各服务的授权凭据。' }),
    },
  ]

  if (!window.nxcore?.cliConnector.mode) return null

  return (
    <section id="settings-connector-mode" className="reality-settings-section settings-anchor-section" aria-labelledby="connector-mode-title">
      <header>
        <span><Plug aria-hidden="true" /></span>
        <div>
          <h2 id="connector-mode-title">{t('surface:settings.connectorModeTitle', { defaultValue: '连接层模式' })}</h2>
        </div>
      </header>
      <div className="connector-mode-options">
        {options.map(({ id, icon: Icon, title, desc, disabled }) => (
          <button
            key={id}
            type="button"
            className="connector-mode-option"
            data-active={String(state?.mode === id)}
            disabled={pending || disabled}
            title={disabled ? t('surface:settings.connectorModeSaasLoginRequired', { defaultValue: '使用云端连接层需要先登录 EverRoom 账号（设置 → EverRoom 账号）。' }) : undefined}
            onClick={() => void choose(id)}
          >
            <span className="connector-mode-option-icon"><Icon aria-hidden="true" /></span>
            <span className="connector-mode-option-body">
              <strong>{title}</strong>
              <small className="connector-mode-option-desc">{desc}</small>
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
