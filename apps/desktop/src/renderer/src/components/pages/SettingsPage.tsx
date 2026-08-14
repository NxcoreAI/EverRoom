import { Brain, ChevronRight, HardDrive, Settings, ShieldCheck, type LucideIcon } from 'lucide-react'

import { PageHeader } from './PageHeader'

const SETTINGS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  { icon: HardDrive, title: '本地数据', description: '数据目录、备份与保留策略' },
  { icon: Brain, title: '模型与记忆', description: '模型供应商、Embedding 与记忆治理' },
  { icon: ShieldCheck, title: '隐私与权限', description: '外发范围、审批和审计记录' },
  { icon: Settings, title: '通用', description: '语言、启动行为与界面偏好' },
]

export function SettingsPage() {
  return (
    <div className="page settings-page">
      <PageHeader title="设置" description="管理本地工作区、模型和数据边界。" />
      <div className="settings-list">
        {SETTINGS.map(({ icon: Icon, title, description }) => (
          <button key={title} type="button" className="settings-row">
            <span className="item-icon"><Icon aria-hidden="true" strokeWidth={1.8} /></span>
            <span><strong>{title}</strong><small>{description}</small></span>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        ))}
      </div>
    </div>
  )
}
