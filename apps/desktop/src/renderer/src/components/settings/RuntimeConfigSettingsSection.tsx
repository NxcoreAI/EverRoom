import { Check, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import {
  aiFieldsError,
  asrFieldsError,
  asrFieldsFromSnapshot,
  buildUserConfig,
  configTestErrorMessage,
  embeddingFieldsFromSnapshot,
  emptyAiFields,
  emptyAsrFields,
  primaryFieldsFromSnapshot,
  vlmFieldsFromSnapshot,
  type ManualAiConfigFields,
  type ManualAsrFields,
} from '../runtimeConfigFormState'

type SectionTab = 'llm' | 'embedding' | 'vlm' | 'asr'

function pretty(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n` }

/** 单段四要素输入组（label 文案复用 configGate.field*）。 */
function AiFieldsGroup({
  fields,
  onChange,
  labels,
  modelPlaceholder,
}: {
  fields: ManualAiConfigFields
  onChange: (key: keyof ManualAiConfigFields, value: string) => void
  labels: { provider: string; model: string; baseUrl: string; apiKey: string }
  modelPlaceholder?: string
}) {
  return <>
    <label className="rc-form-field"><span>{labels.provider}</span>
      <input value={fields.provider} onChange={(event) => onChange('provider', event.target.value)} /></label>
    <label className="rc-form-field"><span>{labels.model}</span>
      <input value={fields.model} placeholder={modelPlaceholder} onChange={(event) => onChange('model', event.target.value)} /></label>
    <label className="rc-form-field"><span>{labels.baseUrl}</span>
      <input value={fields.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => onChange('baseUrl', event.target.value)} /></label>
    <label className="rc-form-field"><span>{labels.apiKey}</span>
      <input type="password" value={fields.apiKey} placeholder="sk-…" onChange={(event) => onChange('apiKey', event.target.value)} /></label>
  </>
}

export function RuntimeConfigSettingsSection() {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<RuntimeConfigSnapshot | null>(null)
  const [tab, setTab] = useState<SectionTab>('llm')
  const [llm, setLlm] = useState<ManualAiConfigFields>(emptyAiFields())
  const [embedding, setEmbedding] = useState<ManualAiConfigFields>(emptyAiFields())
  const [vlm, setVlm] = useState<ManualAiConfigFields>(emptyAiFields())
  const [asr, setAsr] = useState<ManualAsrFields>(emptyAsrFields())
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [busy, setBusy] = useState<'save' | 'json' | 'test' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<RuntimeConfigTestResult | null>(null)

  const seedFromSnapshot = (next: RuntimeConfigSnapshot) => {
    setSnapshot(next)
    // SaaS configuration is managed by the service. Do not seed its payload
    // into editable form or JSON state in the renderer.
    if (next.selectedSource === 'saas') {
      setLlm(emptyAiFields())
      setEmbedding(emptyAiFields())
      setVlm(emptyAiFields())
      setAsr(emptyAsrFields())
      setJsonText('')
      return
    }
    setLlm(primaryFieldsFromSnapshot(next))
    setEmbedding(embeddingFieldsFromSnapshot(next))
    setVlm(vlmFieldsFromSnapshot(next))
    setAsr(asrFieldsFromSnapshot(next))
    setJsonText(pretty(next.config as Record<string, unknown>))
  }

  const load = async () => {
    if (!window.nxcore) return
    seedFromSnapshot(await window.nxcore.runtimeConfig.get())
  }
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 表单保存：四段校验（可选段 all-or-nothing）通过后一次写入 user source。 */
  const saveForm = async () => {
    setBusy('save'); setMessage(null); setFieldError(null); setTestResult(null)
    const error = aiFieldsError(llm, t) ?? aiFieldsError(embedding, t) ?? aiFieldsError(vlm, t) ?? asrFieldsError(asr, t)
    if (error) { setFieldError(error); setBusy(null); return }
    try {
      const next = await window.nxcore?.runtimeConfig.saveUser(buildUserConfig(snapshot, { primary: llm, embedding, vlm, asr }))
      if (next) { seedFromSnapshot(next); setMessage(t('surface:settings.rcSaved')) }
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : String(saveError))
    } finally { setBusy(null) }
  }

  /** 连通测试：primary/embedding/vlm 各段独立展示，ASR 显示未测试说明。 */
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
  const refreshSaas = async () => {
    setBusy('save'); setMessage(null)
    try {
      const next = await window.nxcore?.runtimeConfig.refreshSaas()
      if (next) seedFromSnapshot(next)
      setMessage(t('surface:settings.rcRefreshed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(null) }
  }
  const selectSource = async (source: 'user' | 'saas' | 'default') => {
    setBusy('save'); setMessage(null)
    try {
      const next = await window.nxcore?.runtimeConfig.selectSource(source)
      if (next) seedFromSnapshot(next)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(null) }
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

  const updateLlm = (key: keyof ManualAiConfigFields, value: string) => setLlm((c) => ({ ...c, [key]: value }))
  const updateEmbedding = (key: keyof ManualAiConfigFields, value: string) => setEmbedding((c) => ({ ...c, [key]: value }))
  const updateVlm = (key: keyof ManualAiConfigFields, value: string) => setVlm((c) => ({ ...c, [key]: value }))
  const updateAsr = (key: 'model' | 'baseUrl' | 'apiKey', value: string) => setAsr((c) => ({ ...c, [key]: value }))
  const updateOss = (key: keyof ManualAsrFields['oss'], value: string) => setAsr((c) => ({ ...c, oss: { ...c.oss, [key]: value } }))

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

  const tabs: Array<{ id: SectionTab; label: string; optional: boolean }> = [
    { id: 'llm', label: t('surface:settings.rcTabLlm'), optional: false },
    { id: 'embedding', label: t('surface:settings.rcTabEmbedding'), optional: true },
    { id: 'vlm', label: t('surface:settings.rcTabVlm'), optional: true },
    { id: 'asr', label: t('surface:settings.rcTabAsr'), optional: true },
  ]

  return <section id="settings-runtime-config" className="reality-settings-section settings-anchor-section" aria-labelledby="runtime-config-title">
    <header><span><ShieldCheck aria-hidden="true" /></span><div><h2 id="runtime-config-title">{t('surface:settings.navigationRuntimeConfig')}</h2><p>{t('surface:settings.rcSectionDescription')}</p></div></header>
    <div className="runtime-config-meta">
      <span>{t('surface:settings.rcMetaSource')}：{snapshot?.source ?? '…'}</span>
      <span>{t('surface:settings.rcMetaVersion')}：{snapshot?.configVersion ?? '--'}</span>
      <span>{t('surface:settings.rcMetaUpdatedAt')}：{snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleString() : '--'}</span>
    </div>
    <div className="runtime-config-source-selector" role="group" aria-label={t('surface:settings.rcSourceLabel')}>
      <span>{t('surface:settings.rcSourceLabel')}</span>
      {([['user', 'rcSourceUser'], ['saas', 'rcSourceSaas'], ['default', 'rcSourceDefault']] as const).map(([source, key]) => <button key={source} type="button" className={snapshot?.selectedSource === source ? 'active' : ''} disabled={busy !== null || (source !== 'default' && !snapshot?.availableSources.includes(source))} onClick={() => void selectSource(source)}>{t(`surface:settings.${key}`)}{source !== 'default' && !snapshot?.availableSources.includes(source) ? t('surface:settings.rcSourceNotConfigured') : ''}</button>)}
    </div>
    {snapshot?.selectedSource === 'saas' ? <div className="runtime-config-saas-safe-state">
      <ShieldCheck aria-hidden="true" />
      <div>
        <strong>{t('surface:settings.rcSaasManagedTitle')}</strong>
        <p>{t('surface:settings.rcSaasManagedBody')}</p>
        <small>{t('surface:settings.rcSaasSecurityNote')}</small>
        {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
      </div>
      <button type="button" className="secondary-button" onClick={() => void refreshSaas()} disabled={busy !== null}>
        <RotateCcw aria-hidden="true" />{t('surface:settings.rcSaasRefresh')}
      </button>
    </div> : <>
    <div className="rc-tabs" role="tablist">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} data-active={tab === item.id} onClick={() => setTab(item.id)}>
        {item.label}
        {item.optional ? <span className="rc-tab-badge">{t('surface:settings.rcOptionalBadge')}</span> : null}
      </button>)}
    </div>

    <div className="rc-form">
      {tab === 'llm' ? <>
        <AiFieldsGroup fields={llm} onChange={updateLlm} labels={aiLabels} modelPlaceholder="gpt-4o-mini / glm-4-flash / …" />
        <p className="rc-form-hint">{t('surface:settings.rcTabHintLlm')}</p>
      </> : null}
      {tab === 'embedding' ? <>
        <AiFieldsGroup fields={embedding} onChange={updateEmbedding} labels={aiLabels} modelPlaceholder="text-embedding-3-small / text-embedding-v4 / …" />
        <p className="rc-form-hint">{t('surface:settings.rcTabHintEmbedding')}</p>
      </> : null}
      {tab === 'vlm' ? <>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={vlm.model} placeholder="qwen-vl-max / gpt-4o-mini / …" onChange={(event) => updateVlm('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
          <input value={vlm.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateVlm('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
          <input type="password" value={vlm.apiKey} placeholder="sk-…" onChange={(event) => updateVlm('apiKey', event.target.value)} /></label>
        <p className="rc-form-hint">{t('surface:settings.rcTabHintVlm')}</p>
      </> : null}
      {tab === 'asr' ? <>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={asr.model} placeholder="qwen-audio-3.0-asr-flash-filetrans" onChange={(event) => updateAsr('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
          <input value={asr.baseUrl} placeholder="https://dashscope.aliyuncs.com/api/v1" onChange={(event) => updateAsr('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
          <input type="password" value={asr.apiKey} placeholder="sk-…" onChange={(event) => updateAsr('apiKey', event.target.value)} /></label>
        <div className="rc-oss-group">
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssRegion')}</span>
            <input value={asr.oss.region} placeholder="oss-cn-beijing" onChange={(event) => updateOss('region', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssBucket')}</span>
            <input value={asr.oss.bucket} onChange={(event) => updateOss('bucket', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssAccessKeyId')}</span>
            <input value={asr.oss.accessKeyId} onChange={(event) => updateOss('accessKeyId', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssAccessKeySecret')}</span>
            <input type="password" value={asr.oss.accessKeySecret} onChange={(event) => updateOss('accessKeySecret', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssStsToken')}</span>
            <input type="password" value={asr.oss.stsToken} onChange={(event) => updateOss('stsToken', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcFieldOssPrefix')}</span>
            <input value={asr.oss.prefix} placeholder="nxcore-asr" onChange={(event) => updateOss('prefix', event.target.value)} /></label>
        </div>
        <p className="rc-form-hint">{t('surface:settings.rcTabHintAsr')}</p>
      </> : null}

      {fieldError ? <p className="rc-form-error" role="alert">{fieldError}</p> : null}
      {testResult ? (
        testLines.length === 0
          ? <p className="rc-form-test rc-form-test-ok"><Check aria-hidden="true" />{t('surface:settings.rcTestOk')}{t('surface:settings.rcTestAsrSkipped')}</p>
          : <div className="rc-form-test" role="alert">{testLines.map((line) => <p key={line}>{line}</p>)}</div>
      ) : null}

      <div className="runtime-config-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy !== null}><RefreshCw aria-hidden="true" />{t('surface:settings.rcReload')}</button>
        <button type="button" className="secondary-button" onClick={() => void refreshSaas()} disabled={busy !== null}><RotateCcw aria-hidden="true" />{t('surface:settings.rcRefreshSaas')}</button>
        <button type="button" className="secondary-button" onClick={() => void clearUser()} disabled={busy !== null}><Trash2 aria-hidden="true" />{t('surface:settings.rcClearUser')}</button>
        <button type="button" className="secondary-button" onClick={() => void runTest()} disabled={busy !== null}>{busy === 'test' ? t('surface:settings.rcTesting') : t('surface:settings.rcRunTest')}</button>
        <button type="button" className="primary-button" onClick={() => void saveForm()} disabled={busy !== null}><Save aria-hidden="true" />{t('surface:settings.rcSaveForm')}</button>
      </div>
      {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
    </div>

    <details className="rc-json-details">
      <summary>{t('surface:settings.rcJsonAdvanced')}</summary>
      <p className="rc-form-hint">{t('surface:settings.rcJsonHint')}</p>
      <textarea className="runtime-config-editor" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} aria-label="runtime config JSON" />
      <div className="runtime-config-actions">
        <button type="button" className="primary-button" onClick={() => void saveJson()} disabled={busy !== null}><Save aria-hidden="true" />JSON</button>
      </div>
    </details>
    </>}
  </section>
}
