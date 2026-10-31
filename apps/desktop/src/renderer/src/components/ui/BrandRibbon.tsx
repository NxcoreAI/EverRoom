import './BrandRibbon.css'

/**
 * 品牌缎带（Brand Ribbon）——EverRoom 图标里三段错位的色块：
 * 青绿 / 墨青 / 蜜桃。它是应用唯一允许“做动作”的视觉签名，只出现在
 * 品牌时刻（hero、登录门、空态、启动页），不参与正文装饰。
 */
export interface BrandRibbonProps {
  /** 宽度，高度按图标比例约 0.72 倍自动换算。 */
  size?: number
  /** 入场动画：三条色块依次从左滑入（品牌时刻用）。 */
  animated?: boolean
  className?: string
}

export function BrandRibbon({ size = 32, animated = false, className }: BrandRibbonProps) {
  const classes = ['ui-ribbon', animated ? 'is-animated' : '', className].filter(Boolean).join(' ')
  return (
    <span
      className={classes}
      style={{ width: `${size}px`, height: `${Math.round(size * 0.72)}px` }}
      aria-hidden="true"
    >
      <i className="ui-ribbon-bar ui-ribbon-teal" />
      <i className="ui-ribbon-bar ui-ribbon-ink" />
      <i className="ui-ribbon-bar ui-ribbon-peach" />
    </span>
  )
}
