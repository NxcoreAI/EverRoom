import { Check, Loader2, PlugZap, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import {
  buildUserPayload,
  configTestErrorMessage,
  emptyAiFields,
  formStateFromSnapshot,
  runtimeConfigFormError,
  TEXT_SCENARIO_IDS,
  type ManualAiConfigFields,
  type RuntimeConfigFormState,
  type ScenarioMode,
  type TextScenarioId,
} from '../runtimeConfigFormState'

function pretty(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n` }

const SCENARIO_LABEL_KEYS: Record<TextScenarioId, string> = {
  primary: 'rcScenarioPrimary',
  background: 'rcScenarioBackground',
  lite: 'rcScenarioLite',
  cursorCompletion: 'rcScenarioCursor',
}

export function RuntimeConfigSettingsSection() {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<RuntimeConfigSnapshot | null>(null)
  /** 自定义表单视图：已保存 user 源时跟随 selectedSource；未保存过时也可进入草稿编辑。 */
  const [customView, setCustomView] = useState(false)
  const [form, setForm] = useState<RuntimeConfigFormState>(() => formStateFromSnapshot(null))
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [busy, setBusy] = useState<'save' | 'json' | 'test' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<RuntimeConfigTestResult | null>(null)
  /** 清除二次确认：首次点击进入待确认态，3 秒内再点执行，超时自动取消。 */
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current) }, [])

  const seedFromSnapshot = (next: RuntimeConfigSnapshot) => {
    setSnapshot(next)
    setForm(formStateFromSnapshot(next))
    setCustomView(next.selectedSource === 'user')
    setJsonText(pretty(next.userConfig ?? {}))
  }

  const load = async () => {
    if (!window.nxcore) return
    seedFromSnapshot(await window.nxcore.runtimeConfig.get())
  }
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 表单保存：整体校验通过后一次写入 user source（保存即切到自定义配置）。 */
  const saveForm = async () => {
    setBusy('save'); setMessage(null); setFieldError(null); setTestResult(null)
    let error = runtimeConfigFormError(form, t)
    if (!error && form.webSearchCustom) {
      const keyReady = form.webSearch.apiKey.trim() || snapshot?.webSearchCredential?.configured || form.deleteSearchKey
      error = form.webSearch.model.trim() && form.webSearch.baseUrl.trim() && keyReady
        ? null
        : t('surface:configGate.fieldRequired')
    }
    if (error) { setFieldError(error); setBusy(null); return }
    try {
      const config = buildUserPayload(snapshot, form)
      const next = await window.nxcore?.runtimeConfig.saveUser(config)
      if (next) { seedFromSnapshot(next); setMessage(t('surface:settings.rcSaved')) }
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : String(saveError))
    } finally { setBusy(null) }
  }

  const runTest = async () => {
    setBusy('test'); setMessage(null); setTestResult(null)
    try {
      setTestResult(await window.nxcore?.runtimeConfig.test() ?? null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(null) }
  }

  const clearUser = async () => {
    setBusy('save'); setMessage(null)
    try {
      const next = await window.nxcore?.runtimeConfig.clearUser()
      if (next) seedFromSnapshot(next)
      setMessage(t('surface:settings.rcCleared'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(null) }
  }

  const requestClear = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      confirmResetTimer.current = setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current)
    setConfirmClear(false)
    void clearUser()
  }

  const switchMode = async (mode: 'official' | 'custom') => {
    if (mode === 'official') {
      if (snapshot?.selectedSource === 'default') { setCustomView(false); return }
      setBusy('save'); setMessage(null)
      try {
        const next = await window.nxcore?.runtimeConfig.selectSource('default')
        if (next) seedFromSnapshot(next)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
      } finally { setBusy(null) }
      return
    }
    // 已有自定义配置：真切源；没有：进入草稿编辑，保存时随 set() 一并启用。
    if (snapshot?.availableSources.includes('user')) {
      setBusy('save'); setMessage(null)
      try {
        const next = await window.nxcore?.runtimeConfig.selectSource('user')
        if (next) seedFromSnapshot(next)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
      } finally { setBusy(null) }
      return
    }
    setCustomView(true)
  }

  const saveJson = async () => {
    setBusy('json'); setMessage(null)
    try {
      const parsed = JSON.parse(jsonText) as unknown
      const next = await window.nxcore?.runtimeConfig.saveUser(parsed)
      if (next) { seedFromSnapshot(next); setMessage(t('surface:settings.rcSaved')) }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'JSON invalid')
    } finally { setBusy(null) }
  }

  const updateGeneric = (key: keyof ManualAiConfigFields, value: string) =>
    setForm((current) => ({ ...current, generic: { ...current.generic, [key]: value } }))
  const updateScenario = (id: TextScenarioId, patch: Partial<{ mode: ScenarioMode; model: string; baseUrl: string; apiKey: string }>) =>
    setForm((current) => ({ ...current, scenarios: { ...current.scenarios, [id]: { ...current.scenarios[id], ...patch } } }))
  const updateSpecial = (slot: 'vlm', key: keyof ManualAiConfigFields, value: string) =>
    setForm((current) => ({ ...current, [slot]: { ...current[slot], [key]: value } }))
  const updateSearch = (key: keyof ManualAiConfigFields, value: string) =>
    setForm((current) => ({ ...current, deleteSearchKey: false, webSearch: { ...current.webSearch, [key]: value } }))

  const aiLabels = {
    provider: t('surface:configGate.fieldProvider'),
    model: t('surface:configGate.fieldModel'),
    baseUrl: t('surface:configGate.fieldBaseUrl'),
    apiKey: t('surface:configGate.fieldApiKey'),
  }

  const testLines: string[] = []
  if (testResult) {
    if (testResult.valid !== true) testLines.push(configTestErrorMessage(testResult.error, t))
    if (testResult.vlm && testResult.vlm.valid !== true) {
      testLines.push(`${t('surface:settings.rcTestLabelVlm')}${configTestErrorMessage(testResult.vlm.error, t)}`)
    }
  }

  const scenarioOptions: Array<{ value: ScenarioMode; label: string }> = [
    { value: 'generic', label: t('surface:settings.rcScenarioFollow') },
    { value: 'custom', label: t('surface:settings.rcScenarioCustom') },
    { value: 'official', label: t('surface:settings.rcScenarioOfficial') },
  ]
  const specialOptions = [
    { value: 'official', label: t('surface:settings.rcScenarioOfficial') },
    { value: 'custom', label: t('surface:settings.rcModeCustom') },
  ] as const

  return <section id="settings-runtime-config" className="reality-settings-section rc-settings-section settings-anchor-section" aria-labelledby="runtime-config-title">
    <header>
      <span><ShieldCheck aria-hidden="true" /></span>
      <div><h2 id="runtime-config-title">{t('surface:settings.navigationRuntimeConfig')}</h2></div>
      <div className="rc-header-actions">
        <button type="button" className="rc-icon-button" onClick={() => void runTest()} disabled={busy !== null}
          title={t('surface:settings.rcRunTest')} aria-label={t('surface:settings.rcRunTest')}>
          {busy === 'test' ? <Loader2 aria-hidden="true" className="is-spinning" /> : <PlugZap aria-hidden="true" />}
        </button>
        {snapshot?.userConfig ? (
          <button type="button" className="rc-icon-button" data-armed={String(confirmClear)} onClick={requestClear} disabled={busy !== null}
            title={confirmClear ? t('surface:settings.rcClearConfirm') : t('surface:settings.rcClearUser')}
            aria-label={confirmClear ? t('surface:settings.rcClearConfirm') : t('surface:settings.rcClearUser')}>
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>

    <div className="rc-mode-switch">
      <div className="segmented-control" role="group" aria-label={t('surface:settings.rcSourceLabel')}>
        <button type="button" data-active={String(!customView)} disabled={busy !== null} onClick={() => void switchMode('official')}>{t('surface:settings.rcModeOfficial')}</button>
        <button type="button" data-active={String(customView)} disabled={busy !== null} onClick={() => void switchMode('custom')}>{t('surface:settings.rcModeCustom')}</button>
      </div>
    </div>

    {customView ? <div className="rc-form">
      <h3 className="rc-group-title">{t('surface:settings.rcGenericGroup')}</h3>
      <div className="rc-grid">
        <label className="rc-form-field"><span>{aiLabels.provider}</span>
          <input value={form.generic.provider} onChange={(event) => updateGeneric('provider', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={form.generic.model} placeholder="gpt-4o-mini / glm-4-flash / …" onChange={(event) => updateGeneric('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{t('surface:settings.rcMaxTokens')}</span>
          <input
            inputMode="numeric"
            value={form.maxTokens}
            placeholder="8192"
            onChange={(event) => setForm((current) => ({ ...current, maxTokens: event.target.value.replace(/[^0-9]/g, '') }))}
          /></label>
        <p className="rc-form-hint rc-span-2">{t('surface:settings.rcMaxTokensHint')}</p>
        <label className="rc-form-field rc-span-2"><span>{aiLabels.baseUrl}</span>
          <input value={form.generic.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateGeneric('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
          <input type="password" value={form.generic.apiKey} placeholder="sk-…" onChange={(event) => updateGeneric('apiKey', event.target.value)} /></label>
      </div>

      <h3 className="rc-group-title">{t('surface:settings.rcScenarioGroup')}</h3>
      <div className="rc-scenario-list">
        {TEXT_SCENARIO_IDS.map((id) => {
          const assignment = form.scenarios[id]
          const label = t(`surface:settings.${SCENARIO_LABEL_KEYS[id]}`)
          return <div key={id} className="rc-scenario-item">
            <div className="rc-scenario-row">
              <span className="rc-scenario-name">{label}</span>
              <select value={assignment.mode} disabled={busy !== null} aria-label={label}
                onChange={(event) => updateScenario(id, { mode: event.target.value as ScenarioMode })}>
                {scenarioOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {assignment.mode === 'custom'
                ? <input className="rc-scenario-model" value={assignment.model} placeholder={aiLabels.model} disabled={busy !== null}
                  onChange={(event) => updateScenario(id, { model: event.target.value })} />
                : null}
            </div>
            {assignment.mode === 'custom' ? <details className="rc-own-connection">
              <summary>{t('surface:settings.rcOwnConnection')}</summary>
              <div className="rc-grid">
                <label className="rc-form-field rc-span-2"><span>{aiLabels.baseUrl}</span>
                  <input value={assignment.baseUrl} placeholder="https://api.example.com/v1" disabled={busy !== null}
                    onChange={(event) => updateScenario(id, { baseUrl: event.target.value })} /></label>
                <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
                  <input type="password" value={assignment.apiKey} placeholder="sk-…" disabled={busy !== null}
                    onChange={(event) => updateScenario(id, { apiKey: event.target.value })} /></label>
              </div>
            </details> : null}
          </div>
        })}
      </div>

      <h3 className="rc-group-title">{t('surface:settings.rcSpecialGroup')}</h3>
      <div className="rc-scenario-list">
        <div className="rc-scenario-item">
          <div className="rc-scenario-row">
            <span className="rc-scenario-name">{t('surface:settings.rcSpecialVlm')}</span>
            <select value={form.vlm.mode} disabled={busy !== null} aria-label={t('surface:settings.rcSpecialVlm')}
              onChange={(event) => setForm((current) => ({ ...current, vlm: { ...current.vlm, mode: event.target.value as 'custom' | 'official' } }))}>
              {specialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {form.vlm.mode === 'custom' ? <input className="rc-scenario-model" value={form.vlm.model} placeholder="qwen-vl-max / gpt-4o-mini / …" disabled={busy !== null}
              onChange={(event) => updateSpecial('vlm', 'model', event.target.value)} /> : null}
          </div>
          {form.vlm.mode === 'custom' ? <details className="rc-own-connection">
            <summary>{t('surface:settings.rcOwnConnection')}</summary>
            <div className="rc-grid">
              <label className="rc-form-field rc-span-2"><span>{aiLabels.baseUrl}</span>
                <input value={form.vlm.baseUrl} placeholder="https://api.example.com/v1" disabled={busy !== null}
                  onChange={(event) => updateSpecial('vlm', 'baseUrl', event.target.value)} /></label>
              <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
                <input type="password" value={form.vlm.apiKey} placeholder="sk-…" disabled={busy !== null}
                  onChange={(event) => updateSpecial('vlm', 'apiKey', event.target.value)} /></label>
            </div>
          </details> : null}
        </div>

        <div className="rc-scenario-item">
          <div className="rc-scenario-row">
            <span className="rc-scenario-name">{t('surface:settings.rcSpecialSearch')}</span>
            <select value={form.webSearchCustom ? 'custom' : 'official'} disabled={busy !== null} aria-label={t('surface:settings.rcSpecialSearch')}
              onChange={(event) => setForm((current) => ({ ...current, webSearchCustom: event.target.value === 'custom', webSearch: current.webSearch.model || current.webSearch.baseUrl ? current.webSearch : emptyAiFields() }))}>
              {specialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {form.webSearchCustom ? <div className="rc-special-fields">
            <div className="rc-grid">
              <label className="rc-form-field"><span>{aiLabels.model}</span>
                <input value={form.webSearch.model} placeholder="qwen-plus" onChange={(event) => updateSearch('model', event.target.value)} /></label>
              <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
                <input value={form.webSearch.baseUrl} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" onChange={(event) => updateSearch('baseUrl', event.target.value)} /></label>
              <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
                <input type="password" value={form.webSearch.apiKey} placeholder={snapshot?.webSearchCredential?.configured ? t('surface:settings.rcSearchConfigured') : 'sk-...'} onChange={(event) => updateSearch('apiKey', event.target.value)} /></label>
            </div>
            {snapshot?.webSearchCredential?.source === 'user' ? <button type="button" className="secondary-button rc-search-delete" onClick={() => setForm((current) => ({ ...current, deleteSearchKey: true, webSearch: { ...current.webSearch, apiKey: '' } }))} disabled={busy !== null || form.deleteSearchKey}>
              <Trash2 aria-hidden="true" />{form.deleteSearchKey ? t('surface:settings.rcSearchDeletePending') : t('surface:settings.rcSearchDelete')}
            </button> : null}
          </div> : null}
        </div>
      </div>

      {fieldError ? <p className="rc-form-error" role="alert">{fieldError}</p> : null}
      {testResult ? (
        testLines.length === 0
          ? <p className="rc-form-test rc-form-test-ok"><Check aria-hidden="true" />{t('surface:settings.rcTestOk')}</p>
          : <div className="rc-form-test" role="alert">{testLines.map((line) => <p key={line}>{line}</p>)}</div>
      ) : null}

      <div className="runtime-config-actions">
        <button type="button" className="primary-button" onClick={() => void saveForm()} disabled={busy !== null}><Save aria-hidden="true" />{t('surface:settings.rcSaveForm')}</button>
      </div>
      {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
    </div> : <div className="rc-form">
      {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
      {testResult ? (
        testLines.length === 0
          ? <p className="rc-form-test rc-form-test-ok"><Check aria-hidden="true" />{t('surface:settings.rcTestOk')}</p>
          : <div className="rc-form-test" role="alert">{testLines.map((line) => <p key={line}>{line}</p>)}</div>
      ) : null}
    </div>}

    <details className="rc-json-details">
      <summary>{t('surface:settings.rcJsonAdvanced')}</summary>
      <textarea className="runtime-config-editor" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} aria-label="runtime config JSON" />
      <div className="runtime-config-actions">
        <button type="button" className="primary-button" onClick={() => void saveJson()} disabled={busy !== null}><Save aria-hidden="true" />JSON</button>
      </div>
    </details>
  </section>
}
