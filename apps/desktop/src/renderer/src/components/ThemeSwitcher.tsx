import { Check, Palette } from 'lucide-react'
import { useRef } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'

export type ThemeId = 'soft' | 'mono' | 'crimson' | 'nxcore'

const themes: Array<{
  id: ThemeId
  label: string
  description: string
  colors: [string, string, string]
}> = [
  {
    id: 'soft',
    label: 'Soft',
    description: '全拟态黑白灰',
    colors: ['#e5e5e5', '#f4f4f4', '#252525'],
  },
  {
    id: 'mono',
    label: 'Mono',
    description: '中性黑白灰',
    colors: ['#f5f5f5', '#ffffff', '#171717'],
  },
  {
    id: 'crimson',
    label: 'Crimson',
    description: '黑白灰与品牌红',
    colors: ['#f5f5f3', '#ffffff', '#b51f2e'],
  },
  {
    id: 'nxcore',
    label: PRODUCT_NAME,
    description: '正式版冷灰白',
    colors: ['#f6f7f9', '#eef1f4', '#3d6ff6'],
  },
]

export function ThemeSwitcher({
  theme,
  onChange,
}: {
  theme: ThemeId
  onChange: (theme: ThemeId) => void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)

  return (
    <details ref={detailsRef} className="theme-switcher no-drag">
      <summary className="icon-button" aria-label="切换界面配色" title="切换界面配色">
        <Palette aria-hidden="true" />
      </summary>
      <div className="theme-menu">
        <div className="theme-menu-heading">
          <strong>界面配色</strong>
          <span>即时预览</span>
        </div>
        {themes.map((item) => (
          <button
            key={item.id}
            type="button"
            className="theme-option"
            data-active={String(theme === item.id)}
            onClick={() => {
              onChange(item.id)
              detailsRef.current?.removeAttribute('open')
            }}
          >
            <span className="theme-swatches" aria-hidden="true">
              {item.colors.map((color) => (
                <span key={color} style={{ backgroundColor: color }} />
              ))}
            </span>
            <span className="theme-option-copy">
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            {theme === item.id ? <Check className="theme-check" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </details>
  )
}
