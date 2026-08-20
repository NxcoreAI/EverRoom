import { Check, Palette } from 'lucide-react'
import { useRef } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'
import { useLocale } from '@/i18n/LocaleContext'

export type ThemeId = 'soft' | 'mono' | 'crimson' | 'nxcore'

const themes: Array<{
  id: ThemeId
  label: string
  description: string
  colors: [string, string, string]
}> = [
  {
    id: 'soft',
    label: 'surface:themeSwitcher.soft',
    description: 'surface:themeSwitcher.softDescription',
    colors: ['#e5e5e5', '#f4f4f4', '#252525'],
  },
  {
    id: 'mono',
    label: 'surface:themeSwitcher.mono',
    description: 'surface:themeSwitcher.monoDescription',
    colors: ['#f5f5f5', '#ffffff', '#171717'],
  },
  {
    id: 'crimson',
    label: 'surface:themeSwitcher.crimson',
    description: 'surface:themeSwitcher.crimsonDescription',
    colors: ['#f5f5f3', '#ffffff', '#b51f2e'],
  },
  {
    id: 'nxcore',
    label: PRODUCT_NAME,
    description: 'surface:themeSwitcher.nxcoreDescription',
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
  const { t } = useLocale()
  const detailsRef = useRef<HTMLDetailsElement>(null)

  return (
    <details ref={detailsRef} className="theme-switcher no-drag">
      <summary className="icon-button" aria-label={t('surface:themeSwitcher.changeInterfaceTheme')} title={t('surface:themeSwitcher.changeInterfaceTheme')}>
        <Palette aria-hidden="true" />
      </summary>
      <div className="theme-menu">
        <div className="theme-menu-heading">
          <strong>{t('surface:themeSwitcher.interfaceTheme')}</strong>
          <span>{t('surface:themeSwitcher.livePreview')}</span>
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
              <strong>{item.id === 'nxcore' ? PRODUCT_NAME : t(item.label)}</strong>
              <small>{t(item.description)}</small>
            </span>
            {theme === item.id ? <Check className="theme-check" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
    </details>
  )
}
