import { PRODUCT_NAME } from './brand'
import { ProductLogo } from './ProductLogo'
import './StartupSplash.css'

/**
 * 首次进入应用的启动闪屏：全屏覆盖层，仅启动阶段显示一次（决策后缩放淡出
 * 过渡到目标页，之后不再出现）。独立于登录页/控制台的样式，只用主题变量
 * 与品牌资源。
 */
export function StartupSplash({ exiting, onExited }: {
  exiting?: boolean
  onExited?: () => void
}) {
  return (
    <div
      className="startup-splash"
      data-exiting={exiting ? 'true' : undefined}
      role="status"
      aria-label={PRODUCT_NAME}
      onAnimationEnd={(event) => {
        if (exiting && event.target === event.currentTarget) onExited?.()
      }}
    >
      <div className="startup-splash-scene">
        <div className="startup-splash-icon"><ProductLogo variant="icon" /></div>
        <div className="startup-splash-shadow" aria-hidden="true" />
        <div className="startup-splash-dots" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </div>
  )
}
