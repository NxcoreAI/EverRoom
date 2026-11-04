import { RotateCw, Settings2 } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { useWorkbenchStore } from '../state/store'
import { Button, EmptyState, Spinner } from '../ui/primitives'

type SettingsViewProps = {
  onStartFullOnboarding?: () => void
  hideHeader?: boolean
  section?: string | null
}

/**
 * 设置页（主页一级页面）：复用旧桌面端 `components/pages/SettingsPage` 的分区与表单，
 * 页头交给主页外壳（`hideHeader`），只保留左侧分区导航 + 右侧内容。
 *
 * `section` 来自 workbench store：账号菜单「账号与同步」等入口可直达某个分区。
 */
export function SettingsHost() {
  const section = useWorkbenchStore((state) => state.settingsSection)
  const [View, setView] = useState<ComponentType<SettingsViewProps> | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void import('@/components/pages/SettingsPage')
      .then((module) => {
        if (!cancelled) setView(() => module.SettingsPage as ComponentType<SettingsViewProps>)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [nonce])

  return (
    <div className="wb-home-embed">
      {failed ? (
        <EmptyState
          icon={<Settings2 size={18} />}
          title="设置页暂时无法加载"
          description="重新加载这一页即可，已保存的设置不会受影响。"
          action={(
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCw size={13} />}
              onClick={() => { setView(null); setNonce((value) => value + 1) }}
            >
              重试
            </Button>
          )}
        />
      ) : View ? (
        <View hideHeader section={section} />
      ) : (
        <div className="wb-home-state"><Spinner /> 正在打开设置…</div>
      )}
    </div>
  )
}
