import { PowerOff, RefreshCw, Unplug } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryFailure } from './useMemoryData'

export function MemoryDisabledView() {
  const { t } = useLocale()
  return (
    <div className="mem-status" data-kind="disabled">
      <PowerOff aria-hidden="true" strokeWidth={1.6} />
      <h2>{t('记忆服务未启用')}</h2>
      <p>
        {t('EverRoom 通过 TencentDB Agent Memory（MemoryCore）沉淀长期记忆。')}
        {t('在网关配置')} <code>NXCORE_MEMORY_ENABLED=true</code> {t('并指向运行中的 MemoryCore 实例后，与 AI 助手的对话将自动提炼为记忆。')}
      </p>
    </div>
  )
}

export function MemoryUnreachableView({ failure, onRetry }: {
  failure: MemoryFailure
  onRetry: () => void
}) {
  const { t } = useLocale()
  return (
    <div className="mem-status" data-kind="unreachable">
      <Unplug aria-hidden="true" strokeWidth={1.6} />
      <h2>{t('无法连接记忆服务')}</h2>
      <p>{t(failure.message)} {t('MemoryCore 是独立进程，可能晚于 EverRoom 启动。')}</p>
      <button type="button" className="mem-retry" onClick={onRetry}>
        <RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('重试')}
      </button>
    </div>
  )
}

export function MemoryEmptyView({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mem-status" data-kind="empty">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
    </div>
  )
}
