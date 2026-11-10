import { Plug, RotateCw } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { workbenchToast } from '../shell/toast'
import { Button, EmptyState, Spinner } from '../ui/primitives'

type ConnectorsViewProps = { onToast: (message: string) => void }

/**
 * 连接器页：直接复用 `office-proto` 的 `ConnectorsView`（已接真实 nango/agentAuth，
 * 自带页头与分类筛选），这里只提供主页标签的滚动容器，不改组件源码。
 */
export function ConnectorsHost() {
  const [View, setView] = useState<ComponentType<ConnectorsViewProps> | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void import('@/office-proto/pages/ConnectorsView')
      .then((module) => {
        if (!cancelled) setView(() => module.ConnectorsView as ComponentType<ConnectorsViewProps>)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [nonce])

  return (
    <div className="wb-home-scroll is-embed">
      <div className="wb-home-embed-inner">
        {failed ? (
          <EmptyState
            icon={<Plug size={18} />}
            title="连接器页暂时无法加载"
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
          <View onToast={workbenchToast} />
        ) : (
          <div className="wb-home-state"><Spinner /> 正在加载连接器…</div>
        )}
      </div>
    </div>
  )
}
