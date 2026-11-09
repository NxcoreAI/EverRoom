import { Cable, RotateCw } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'

import { workbenchToast } from '../shell/toast'
import { Button, EmptyState, Spinner } from '../ui/primitives'
import { Modal } from '../ui/modal'

/**
 * 对话区「连接器」弹窗：复用主页连接器页的数据层（connectorsData 模块级缓存，
 * 两处状态互通）与授权动作（useConnectorActions）。
 *
 * 与主页 ConnectorsHost 的差异只在容器：这里是 Modal 而非整页滚动容器，因此
 * 传入 `variant="dialog"` 让复用组件隐藏自己的页头（标题由 Modal 提供）、
 * 收紧网格间距。授权/开启/关闭行为与主页完全一致。
 */
export function ConnectorsDialog({ open, onClose }: {
  open: boolean
  onClose: () => void
}) {
  const [View, setView] = useState<ComponentType<ConnectorsDialogViewProps> | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setFailed(false)
    void import('@/office-proto/pages/ConnectorsView')
      .then((module) => {
        if (!cancelled) setView(() => module.ConnectorsView as ComponentType<ConnectorsDialogViewProps>)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [open, nonce])

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose() }}
      title="连接器"
      description="连接后 Agent 在本会话中可以直接查询这些来源"
      size="lg"
    >
      {failed ? (
        <EmptyState
          icon={<Cable size={18} />}
          title="连接器暂时无法加载"
          description="模块加载失败，稍后重试。"
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
        <View variant="dialog" onToast={workbenchToast} />
      ) : (
        <div className="wb-conn-dialog-loading"><Spinner /> 正在加载连接器…</div>
      )}
    </Modal>
  )
}

/** 复用组件在弹窗形态下需要的 props（variant 让它隐藏页头/切换布局）。 */
export interface ConnectorsDialogViewProps {
  variant?: 'dialog'
  onToast: (message: string) => void
}
