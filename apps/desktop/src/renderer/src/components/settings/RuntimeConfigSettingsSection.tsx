import { Check, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NxcoreAsrStatusPayload, RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import {
  buildUserPayload,
  configTestErrorMessage,
  emptyAiFields,
  emptyAsrFields,
  formStateFromSnapshot,
  runtimeConfigFormError,
  TEXT_SCENARIO_IDS,
  type ManualAiConfigFields,
  type ManualAsrFields,
  type RuntimeConfigFormState,
  type ScenarioMode,
  type TextScenarioId,
} from '../runtimeConfigFormState'

function pretty(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n` }

const SCENARIO_LABEL_KEYS: Record<TextScenarioId, string> = {
  primary: 'rcScenarioPrimary',
  background: 'rcScenarioBackground',
  transcriptionSummary: 'rcScenarioTranscription',
  lite: 'rcScenarioLite',
  cursorCompletion: 'rcScenarioCursor',
}

const MANAGED_ASR_STEPS = 4

/** 内置离线转写（nxcore-asr）托管状态区：档位选择 + 引擎启停 + 安装进度。
 * 就绪即自动保存表单（把托管连接写进用户配置）。 */
function ManagedAsrStatus({ onReady, disabled }: { onReady?: () => void; disabled: boolean }) {
  const { t } = useLocale()
  const [status, setStatus] = useState<NxcoreAsrStatusPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const readyFiredRef = useRef(false)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  useEffect(() => {
    const api = window.nxcore?.nxcoreAsr
    if (!api) return
    let disposed = false
    const refresh = () => {
      void api.status().then((value) => {
        if (disposed || !value) return
        setStatus(value)
        if ((value.state === 'ready' || value.state === 'reused') && !readyFiredRef.current) {
          readyFiredRef.current = true
          onReadyRef.current?.()
        }
      }).catch(() => undefined)
    }
    refresh()
    // 首装（依赖/模型下载）持续数分钟且明细高频变化，1s 轮询跟进。
    const timer = window.setInterval(refresh, 1_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])
  const start = async () => {
    setBusy(true)
    try { const value = await window.nxcore?.nxcoreAsr?.start(); if (value) setStatus(value) } catch { /* 状态轮询会呈现失败 */ }
    finally { setBusy(false) }
  }
  const switchTier = async (tier: 'lite' | 'full') => {
    if (tier === (status?.tier ?? 'full')) return
    setBusy(true)
    readyFiredRef.current = false
    try { const value = await window.nxcore?.nxcoreAsr?.setTier(tier); if (value) setStatus(value) } catch { /* 轮询兜底 */ }
    finally { setBusy(false) }
  }
  const state = status?.state ?? 'unknown'
  const ready = state === 'ready' || state === 'reused'
  const working = state === 'setup-venv' || state === 'starting'
  const failed = state === 'error' || state === 'missing-python'
  const step = Math.min(status?.step ?? 0, MANAGED_ASR_STEPS)
  const stateText = ready ? t('surface:settings.rcAsrManagedReady') : t(`surface:settings.rcAsrManagedState.${state}`)
  return (
    <div className="rc-asr-managed">
      <div className="rc-scenario-row">
        <span className="rc-scenario-name">{t('surface:settings.rcAsrTier')}</span>
        <select value={status?.tier ?? 'full'} disabled={busy || disabled} aria-label={t('surface:settings.rcAsrTier')}
          onChange={(event) => { void switchTier(event.target.value as 'lite' | 'full') }}>
          <option value="lite">{t('surface:settings.rcAsrTierLite')}</option>
          <option value="full">{t('surface:settings.rcAsrTierFull')}</option>
        </select>
      </div>
      <div className="rc-scenario-row">
        <span className="rc-scenario-name">{t('surface:settings.rcAsrManagedStatusLabel')}</span>
        <span className={`rc-asr-state${ready ? ' rc-asr-state-ok' : failed ? ' rc-asr-state-error' : ''}`}>{stateText}</span>
        <button className="secondary-button rc-asr-action" type="button" disabled={busy || disabled || ready} onClick={() => void start()}>
          {ready ? t('surface:settings.rcAsrManagedRunning') : working ? t('surface:settings.rcAsrManagedWorking') : t('surface:settings.rcAsrManagedStart')}
        </button>
      </div>
      {working ? <progress className="managed-asr-progress" value={step} max={MANAGED_ASR_STEPS} /> : null}
      {status?.message || status?.detail ? <p className="rc-asr-managed-detail">{status?.detail ?? status?.message}</p> : null}
    </div>
  )
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
        : t('surface:configGate.embeddingIncomplete')
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
  const updateEmbedding = (key: keyof ManualAiConfigFields, value: string) =>
    setForm((current) => ({ ...current, embedding: { ...current.embedding, [key]: value } }))
  const updateVlm = (key: keyof ManualAiConfigFields, value: string) =>
    setForm((current) => ({ ...current, vlm: { ...current.vlm, [key]: value } }))
  const updateAsr = (key: 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'language', value: string) =>
    setForm((current) => ({ ...current, asr: { ...current.asr, [key]: value } }))
  const updateOss = (key: keyof ManualAsrFields['oss'], value: string) =>
    setForm((current) => ({ ...current, asr: { ...current.asr, oss: { ...current.asr.oss, [key]: value } } }))
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
    if (testResult.embedding && testResult.embedding.valid !== true) {
      testLines.push(`${t('surface:settings.rcTestLabelEmbedding')}${configTestErrorMessage(testResult.embedding.error, t)}`)
    }
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

  const renderAiFields = (
    fields: ManualAiConfigFields,
    onChange: (key: keyof ManualAiConfigFields, value: string) => void,
    options: { provider?: boolean; modelPlaceholder?: string } = {},
  ) => <div className="rc-grid">
    {options.provider !== false ? <label className="rc-form-field"><span>{aiLabels.provider}</span>
      <input value={fields.provider} onChange={(event) => onChange('provider', event.target.value)} /></label> : null}
    <label className="rc-form-field"><span>{aiLabels.model}</span>
      <input value={fields.model} placeholder={options.modelPlaceholder} onChange={(event) => onChange('model', event.target.value)} /></label>
    <label className="rc-form-field rc-span-2"><span>{aiLabels.baseUrl}</span>
      <input value={fields.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => onChange('baseUrl', event.target.value)} /></label>
    <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
      <input type="password" value={fields.apiKey} placeholder="sk-…" onChange={(event) => onChange('apiKey', event.target.value)} /></label>
  </div>

  return <section id="settings-runtime-config" className="reality-settings-section settings-anchor-section" aria-labelledby="runtime-config-title">
    <header><span><ShieldCheck aria-hidden="true" /></span><div><h2 id="runtime-config-title">{t('surface:settings.navigationRuntimeConfig')}</h2></div></header>

    <div className="rc-mode-switch">
      <div className="segmented-control" role="group" aria-label={t('surface:settings.rcSourceLabel')}>
        <button type="button" data-active={String(!customView)} disabled={busy !== null} onClick={() => void switchMode('official')}>{t('surface:settings.rcModeOfficial')}</button>
        <button type="button" data-active={String(customView)} disabled={busy !== null} onClick={() => void switchMode('custom')}>{t('surface:settings.rcModeCustom')}</button>
      </div>
    </div>

    {customView ? <div className="rc-form">
      <h3 className="rc-group-title">{t('surface:settings.rcGenericGroup')}</h3>
      {renderAiFields(form.generic, updateGeneric, { modelPlaceholder: 'gpt-4o-mini / glm-4-flash / …' })}

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
            <span className="rc-scenario-name">{t('surface:settings.rcSpecialEmbedding')}</span>
            <select value={form.embeddingCustom ? 'custom' : 'official'} disabled={busy !== null} aria-label={t('surface:settings.rcSpecialEmbedding')}
              onChange={(event) => setForm((current) => ({ ...current, embeddingCustom: event.target.value === 'custom', embedding: current.embedding.model || current.embedding.baseUrl ? current.embedding : emptyAiFields() }))}>
              {specialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {form.embeddingCustom ? <div className="rc-special-fields">
            {renderAiFields(form.embedding, updateEmbedding, { modelPlaceholder: 'text-embedding-3-small / text-embedding-v4 / …' })}
          </div> : null}
        </div>

        <div className="rc-scenario-item">
          <div className="rc-scenario-row">
            <span className="rc-scenario-name">{t('surface:settings.rcSpecialVlm')}</span>
            <select value={form.vlmCustom ? 'custom' : 'official'} disabled={busy !== null} aria-label={t('surface:settings.rcSpecialVlm')}
              onChange={(event) => setForm((current) => ({ ...current, vlmCustom: event.target.value === 'custom', vlm: current.vlm.model || current.vlm.baseUrl ? current.vlm : emptyAiFields() }))}>
              {specialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {form.vlmCustom ? <div className="rc-special-fields">
            {renderAiFields(form.vlm, updateVlm, { provider: false, modelPlaceholder: 'qwen-vl-max / gpt-4o-mini / …' })}
          </div> : null}
        </div>

        <div className="rc-scenario-item">
          <div className="rc-scenario-row">
            <span className="rc-scenario-name">{t('surface:settings.rcSpecialAsr')}</span>
            <select value={form.asrCustom ? 'custom' : 'official'} disabled={busy !== null} aria-label={t('surface:settings.rcSpecialAsr')}
              onChange={(event) => setForm((current) => ({ ...current, asrCustom: event.target.value === 'custom', asr: current.asr.model || current.asr.baseUrl ? current.asr : emptyAsrFields() }))}>
              {specialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {form.asrCustom ? <div className="rc-special-fields">
            <div className="rc-grid">
              <label className="rc-form-field"><span>{t('surface:settings.rcAsrEngine')}</span>
                <select value={form.asr.provider} disabled={busy !== null} aria-label={t('surface:settings.rcAsrEngine')}
                  onChange={(event) => updateAsr('provider', event.target.value)}>
                  <option value="aliyun">{t('surface:settings.rcAsrEngineAliyun')}</option>
                  <option value="openai-compatible">{t('surface:settings.rcAsrEngineSelfHosted')}</option>
                  <option value="nxcore-asr-managed">{t('surface:settings.rcAsrEngineManaged')}</option>
                </select>
              </label>
              {form.asr.provider === 'openai-compatible' ? <label className="rc-form-field"><span>{t('surface:settings.rcAsrLanguage')}</span>
                <select value={form.asr.language} disabled={busy !== null}
                  onChange={(event) => updateAsr('language', event.target.value)}>
                  <option value="">{t('surface:settings.rcAsrLanguageAuto')}</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </label> : null}
            </div>
            {form.asr.provider === 'nxcore-asr-managed' ? <ManagedAsrStatus onReady={() => void saveForm()} disabled={busy !== null} /> : null}
            {form.asr.provider === 'openai-compatible' ? <div className="rc-grid">
              <label className="rc-form-field"><span>{aiLabels.model}</span>
                <input value={form.asr.model} placeholder="whisper-1" onChange={(event) => updateAsr('model', event.target.value)} /></label>
              <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
                <input value={form.asr.baseUrl} placeholder="http://127.0.0.1:8000" onChange={(event) => updateAsr('baseUrl', event.target.value)} /></label>
              <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
                <input type="password" value={form.asr.apiKey} placeholder={t('surface:settings.rcAsrOptionalKey')} onChange={(event) => updateAsr('apiKey', event.target.value)} /></label>
            </div> : null}
            {form.asr.provider === 'aliyun' ? <>
              <div className="rc-grid">
                <label className="rc-form-field"><span>{aiLabels.model}</span>
                  <input value={form.asr.model} placeholder="qwen-audio-3.0-asr-flash-filetrans" onChange={(event) => updateAsr('model', event.target.value)} /></label>
                <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
                  <input value={form.asr.baseUrl} placeholder="https://dashscope.aliyuncs.com/api/v1" onChange={(event) => updateAsr('baseUrl', event.target.value)} /></label>
                <label className="rc-form-field rc-span-2"><span>{aiLabels.apiKey}</span>
                  <input type="password" value={form.asr.apiKey} placeholder="sk-…" onChange={(event) => updateAsr('apiKey', event.target.value)} /></label>
              </div>
              <div className="rc-oss-group">
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssRegion')}</span>
                  <input value={form.asr.oss.region} placeholder="oss-cn-beijing" onChange={(event) => updateOss('region', event.target.value)} /></label>
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssBucket')}</span>
                  <input value={form.asr.oss.bucket} onChange={(event) => updateOss('bucket', event.target.value)} /></label>
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssAccessKeyId')}</span>
                  <input value={form.asr.oss.accessKeyId} onChange={(event) => updateOss('accessKeyId', event.target.value)} /></label>
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssAccessKeySecret')}</span>
                  <input type="password" value={form.asr.oss.accessKeySecret} onChange={(event) => updateOss('accessKeySecret', event.target.value)} /></label>
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssStsToken')}</span>
                  <input type="password" value={form.asr.oss.stsToken} onChange={(event) => updateOss('stsToken', event.target.value)} /></label>
                <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssPrefix')}</span>
                  <input value={form.asr.oss.prefix} placeholder="nxcore-asr" onChange={(event) => updateOss('prefix', event.target.value)} /></label>
              </div>
            </> : null}
          </div> : null}
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
          ? <p className="rc-form-test rc-form-test-ok"><Check aria-hidden="true" />{t('surface:settings.rcTestOk')}{t('surface:settings.rcTestAsrSkipped')}</p>
          : <div className="rc-form-test" role="alert">{testLines.map((line) => <p key={line}>{line}</p>)}</div>
      ) : null}

      <div className="runtime-config-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy !== null}><RefreshCw aria-hidden="true" />{t('surface:settings.rcReload')}</button>
        <button type="button" className="secondary-button" onClick={() => void clearUser()} disabled={busy !== null}><Trash2 aria-hidden="true" />{t('surface:settings.rcClearUser')}</button>
        <button type="button" className="secondary-button" onClick={() => void runTest()} disabled={busy !== null}>{busy === 'test' ? t('surface:settings.rcTesting') : t('surface:settings.rcRunTest')}</button>
        <button type="button" className="primary-button" onClick={() => void saveForm()} disabled={busy !== null}><Save aria-hidden="true" />{t('surface:settings.rcSaveForm')}</button>
      </div>
      {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
    </div> : <div className="rc-form">
      <div className="runtime-config-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy !== null}><RefreshCw aria-hidden="true" />{t('surface:settings.rcReload')}</button>
        {snapshot?.userConfig ? <button type="button" className="secondary-button" onClick={() => void clearUser()} disabled={busy !== null}><Trash2 aria-hidden="true" />{t('surface:settings.rcClearUser')}</button> : null}
        <button type="button" className="secondary-button" onClick={() => void runTest()} disabled={busy !== null}>{busy === 'test' ? t('surface:settings.rcTesting') : t('surface:settings.rcRunTest')}</button>
      </div>
      {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
      {testResult ? (
        testLines.length === 0
          ? <p className="rc-form-test rc-form-test-ok"><Check aria-hidden="true" />{t('surface:settings.rcTestOk')}{t('surface:settings.rcTestAsrSkipped')}</p>
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
