import { ServerCog } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppPrefs } from '@/state/appPrefs'

/** 与主进程 store 的 normalizeUrl 同口径：http(s) 绝对地址才算合法。 */
function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https://'
  } catch {
    return false
  }
}

interface UrlRowProps {
  label: string
  /** 主进程当前值（null=未自定义）。 */
  value: string | null
  placeholder: string
  ready: boolean
  invalidHint: string
  saveLabel: string
  clearLabel: string
  onSave(url: string | null): void
}

/** 文本输入 + 保存/清除：非空时校验 http(s)，空输入保存即清除（回落官方默认）。 */
function UrlRow(props: UrlRowProps): ReactNode {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => { setDraft(props.value ?? '') }, [props.value])
  const trimmed = draft.trim()
  const invalid = trimmed.length > 0 && !isValidHttpUrl(trimmed)
  const dirty = (trimmed || null) !== props.value
  return (
    <div className="reality-setting-row">
      <div>
        <strong>{props.label}</strong>
        <label className="rc-form-field">
          <input
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setError(false) }}
            placeholder={props.placeholder}
            spellCheck={false}
            disabled={!props.ready}
          />
        </label>
        {invalid && error ? <p className="rc-form-error">{props.invalidHint}</p> : null}
      </div>
      <div>
        <button
          className="secondary-button"
          type="button"
          disabled={!props.ready || !dirty}
          onClick={() => {
            if (invalid) { setError(true); return }
            props.onSave(trimmed || null)
          }}
        >
          {props.saveLabel}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!props.ready || !props.value}
          onClick={() => props.onSave(null)}
        >
          {props.clearLabel}
        </button>
      </div>
    </div>
  )
}

export function AppPrefsSection() {
  const { t } = useTranslation()
  const { prefs, ready, update } = useAppPrefs()
  return (
    <section id="settings-app-prefs" className="reality-settings-section settings-anchor-section" aria-labelledby="app-prefs-title">
      <header>
        <span><ServerCog aria-hidden="true" /></span>
        <div>
          <h2 id="app-prefs-title">{t('surface:settings.appPrefsTitle', { defaultValue: '高级选项' })}</h2>
        </div>
      </header>
      <UrlRow
        label={t('surface:settings.appPrefsUpdateFeed', { defaultValue: '自定义更新源' })}
        value={prefs.updateFeedUrl}
        placeholder="https://my-host/app/feed"
        ready={ready}
        invalidHint={t('surface:settings.appPrefsInvalidUrl', { defaultValue: '需为以 http:// 或 https:// 开头的完整地址' })}
        saveLabel={t('surface:settings.appPrefsSave', { defaultValue: '保存' })}
        clearLabel={t('surface:settings.appPrefsClear', { defaultValue: '清除' })}
        onSave={(url) => void update({ updateFeedUrl: url })}
      />
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:settings.appPrefsCrashReporting', { defaultValue: '崩溃与错误上报' })}</strong>
        </div>
        <button
          className="settings-toggle"
          type="button"
          role="switch"
          aria-checked={prefs.crashReporting}
          aria-label={t('surface:settings.appPrefsCrashReporting', { defaultValue: '崩溃与错误上报' })}
          data-active={String(prefs.crashReporting)}
          disabled={!ready}
          onClick={() => void update({ crashReporting: !prefs.crashReporting })}
        >
          <span aria-hidden="true" />
          {t(prefs.crashReporting ? 'surface:settings.on' : 'surface:settings.off')}
        </button>
      </div>
      <UrlRow
        label={t('surface:settings.appPrefsSaasBaseUrl', { defaultValue: 'SaaS 服务地址' })}
        value={prefs.saasBaseUrl}
        placeholder="https://your-host/api/v1"
        ready={ready}
        invalidHint={t('surface:settings.appPrefsInvalidUrl', { defaultValue: '需为以 http:// 或 https:// 开头的完整地址' })}
        saveLabel={t('surface:settings.appPrefsSave', { defaultValue: '保存' })}
        clearLabel={t('surface:settings.appPrefsClear', { defaultValue: '清除' })}
        onSave={(url) => void update({ saasBaseUrl: url })}
      />
    </section>
  )
}
