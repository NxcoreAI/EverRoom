import { CloudCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CloudControlSettings } from '../../../../shared/sources'
import { useCloudControlSettings } from '@/state/cloudControlSettings'

interface CloudControlFlag {
  key: keyof CloudControlSettings
  titleKey: string
  title: string
}

const FLAGS: CloudControlFlag[] = [
  {
    key: 'audioUpload',
    titleKey: 'surface:settings.cloudControlAudioUpload',
    title: '录音音频备份上云',
  },
  {
    key: 'transcriptSync',
    titleKey: 'surface:settings.cloudControlTranscriptSync',
    title: '本地转写文字同步上云',
  },
  {
    key: 'remoteAgentChannel',
    titleKey: 'surface:settings.cloudControlRemoteAgent',
    title: '远程 Agent 遥控通道',
  },
  {
    key: 'aiRelay',
    titleKey: 'surface:settings.cloudControlAiRelay',
    title: '模型请求经官方中转',
  },
]

export function CloudControlSection() {
  const { t } = useTranslation()
  const { settings, ready, update } = useCloudControlSettings()
  return (
    <section id="settings-cloud-control" className="reality-settings-section settings-anchor-section" aria-labelledby="cloud-control-title">
      <header>
        <span><CloudCog aria-hidden="true" /></span>
        <div>
          <h2 id="cloud-control-title">{t('surface:settings.cloudControlTitle', { defaultValue: '云端同步与远程控制' })}</h2>
        </div>
      </header>
      {FLAGS.map(({ key, titleKey, title }) => (
        <div className="reality-setting-row" key={key}>
          <div>
            <strong>{t(titleKey, { defaultValue: title })}</strong>
          </div>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-checked={settings[key]}
            aria-label={t(titleKey, { defaultValue: title })}
            data-active={String(settings[key])}
            disabled={!ready}
            onClick={() => void update({ [key]: !settings[key] })}
          >
            <span aria-hidden="true" />
            {t(settings[key] ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
      ))}
    </section>
  )
}
