import { RotateCw, Settings2 } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { Button, EmptyState, Spinner } from '../ui/primitives'

type SettingsViewProps = { onStartFullOnboarding?: () => void }

/**
 * 设置页：直接复用旧桌面端 `components/pages/SettingsPage`（自带页头与内部滚动），
 * 这里只给主页标签一个撑满内容区的宿主，不改组件源码。
 */
export function SettingsHost() {
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
          description="页面模块加载失败，稍后重试。"
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
        <View />
      ) : (
        <div className="wb-home-state"><Spinner /> 正在加载设置…</div>
      )}
    </div>
  )
}
