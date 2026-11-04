import { Check, Palette } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import {
  APPEARANCE_THEMES,
  loadAppearanceTheme,
  saveAppearanceTheme,
  type AppearanceTheme,
} from '@/state/appearanceSettings'

import './AppearanceSettingsSection.css'

const THEME_I18N: Record<AppearanceTheme, { name: string; hint: string }> = {
  paper: {
    name: 'surface:settings.appearancePaper',
    hint: 'surface:settings.appearancePaperHint',
  },
  plain: {
    name: 'surface:settings.appearancePlain',
    hint: 'surface:settings.appearancePlainHint',
  },
  moss: {
    name: 'surface:settings.appearanceMoss',
    hint: 'surface:settings.appearanceMossHint',
  },
  night: {
    name: 'surface:settings.appearanceNight',
    hint: 'surface:settings.appearanceNightHint',
  },
}

/**
 * 外观设置：四套全局风格任选，立即应用到整个应用（含所有窗口）。
 * 预览色块是「风格样本」，与 themes.css 的取值保持一致，但不随当前主题变化。
 */
export function AppearanceSettingsSection() {
  const { t } = useLocale()
  const [theme, setTheme] = useState<AppearanceTheme>(() => loadAppearanceTheme())
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([])

  const choose = (next: AppearanceTheme) => {
    if (next === theme) return
    setTheme(next)
    saveAppearanceTheme(next)
  }

  // 单选组的方向键语义：左右/上下切换并聚焦到对应卡片。
  const onCardKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0
    if (!step) return
    event.preventDefault()
    const nextIndex = (index + step + APPEARANCE_THEMES.length) % APPEARANCE_THEMES.length
    choose(APPEARANCE_THEMES[nextIndex])
    cardRefs.current[nextIndex]?.focus()
  }

  return (
    <section
      id="settings-appearance"
      className="reality-settings-section settings-anchor-section appearance-settings-section"
      aria-labelledby="appearance-settings-title"
    >
      <header>
        <span><Palette aria-hidden="true" /></span>
        <div>
          <h2 id="appearance-settings-title">{t('surface:settings.appearanceTitle')}</h2>
        </div>
      </header>

      <p className="appearance-settings-description">
        {t('surface:settings.appearanceDescription')}
      </p>

      <div
        className="appearance-theme-grid"
        role="radiogroup"
        aria-label={t('surface:settings.appearanceTitle')}
      >
        {APPEARANCE_THEMES.map((id, index) => {
          const active = id === theme
          return (
            <button
              key={id}
              ref={(node) => { cardRefs.current[index] = node }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              className="appearance-theme-card"
              data-active={String(active)}
              data-theme-sample={id}
              onClick={() => choose(id)}
              onKeyDown={(event) => onCardKeyDown(event, index)}
            >
              <span className="appearance-theme-preview" aria-hidden="true">
                <span className="appearance-theme-preview-chrome">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="appearance-theme-preview-canvas">
                  <i className="appearance-theme-preview-line" />
                  <i className="appearance-theme-preview-line is-short" />
                  <i className="appearance-theme-preview-pill" />
                </span>
              </span>
              <span className="appearance-theme-meta">
                <strong>{t(THEME_I18N[id].name)}</strong>
                <small>{t(THEME_I18N[id].hint)}</small>
              </span>
              <span className="appearance-theme-check" aria-hidden="true">
                <Check />
              </span>
            </button>
          )
        })}
      </div>

      <p className="appearance-settings-note">{t('surface:settings.appearanceNote')}</p>
    </section>
  )
}
