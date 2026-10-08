import { Check, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import {
  aiFieldsError,
  asrFieldsError,
  asrFieldsFromSnapshot,
  aiFieldsIncomplete,
  asrFieldsIncomplete,
  liteFieldsIncomplete,
  buildUserConfig,
  configTestErrorMessage,
  embeddingFieldsFromSnapshot,
  emptyAiFields,
  emptyAsrFields,
  liteFieldsError,
  liteFieldsFromSnapshot,
  primaryFieldsFromSnapshot,
  vlmFieldsFromSnapshot,
  type ManualAiConfigFields,
  type ManualAsrFields,
} from '../runtimeConfigFormState'

type SectionTab = 'llm' | 'embedding' | 'vlm' | 'asr' | 'search' | 'lite'

interface ManagedAsrStatusValue {
  state: string
  message: string | null
  baseUrl: string | null
  step: number
  detail: string | null
}

const MANAGED_ASR_STEPS = 5

/** 内置离线转写引擎的托管状态区：轮询 supervisor 状态 + 启动按钮 + 进度明细。
 *  onReady：引擎首次到达就绪态时触发一次——父组件借机自动保存表单，
 *  免去"启动了但忘了点保存表单"导致录音报 provider not configured。 */
function ManagedAsrStatus({ onReady }: { onReady?: () => void }) {
  const { t } = useLocale()
  const [status, setStatus] = useState<ManagedAsrStatusValue | null>(null)
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
    try { await window.nxcore?.nxcoreAsr?.start() } catch { /* 状态轮询会呈现失败 */ }
    finally { setBusy(false) }
  }
  const state = status?.state ?? 'unknown'
  const ready = state === 'ready' || state === 'reused'
  const working = state === 'setup-venv' || state === 'starting'
  const step = Math.min(status?.step ?? 0, MANAGED_ASR_STEPS)
  return (
    <div className="reality-setting-row">
      <div>
        <strong>{ready ? t('surface:settings.rcAsrManagedReady') : t('surface:settings.rcAsrManagedState.' + state, { defaultValue: t('surface:settings.rcAsrManagedState.unknown') })}</strong>
        {status?.message ? <p className="rc-form-hint">{status.message}</p> : null}
        {status?.detail ? <p className="rc-form-hint">{status.detail}</p> : null}
        {working ? <progress className="managed-asr-progress" value={step} max={MANAGED_ASR_STEPS} /> : null}
      </div>
      <button className="secondary-button" type="button" disabled={busy || ready} onClick={() => void start()}>
        {ready ? t('surface:settings.rcAsrManagedRunning') : working ? t('surface:settings.rcAsrManagedWorking') : t('surface:settings.rcAsrManagedStart')}
      </button>
    </div>
  )
}

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
  const [search, setSearch] = useState<ManualAiConfigFields>(emptyAiFields())
  const [lite, setLite] = useState<ManualAiConfigFields>(emptyAiFields())
  const [deleteSearchKey, setDeleteSearchKey] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [busy, setBusy] = useState<'save' | 'json' | 'test' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<RuntimeConfigTestResult | null>(null)

  const seedFromSnapshot = (next: RuntimeConfigSnapshot) => {
    setSnapshot(next)
    setLlm(primaryFieldsFromSnapshot(next))
    setEmbedding(embeddingFieldsFromSnapshot(next))
    setVlm(vlmFieldsFromSnapshot(next))
    setAsr(asrFieldsFromSnapshot(next))
    setLite(liteFieldsFromSnapshot(next))
    const webSearch = ((next.userConfig as Record<string, unknown> | undefined)?.webSearch ?? {}) as Record<string, unknown>
    setSearch({
      provider: typeof webSearch.provider === 'string' ? webSearch.provider : 'openai-compatible',
      model: typeof webSearch.model === 'string' ? webSearch.model : '',
      baseUrl: typeof webSearch.baseUrl === 'string' ? webSearch.baseUrl : '',
      apiKey: '',
    })
    setDeleteSearchKey(false)
    setJsonText(pretty(next.config as Record<string, unknown>))
  }

  const load = async () => {
    if (!window.nxcore) return
    seedFromSnapshot(await window.nxcore.runtimeConfig.get())
  }
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 表单保存：只有 primary 必须完整；其余可选段（embedding/vlm/asr/lite/搜索）
   *  未填全一律按未配置清空落库（含历史污染数据自愈），不阻塞保存。 */
  const saveForm = async () => {
    setBusy('save'); setMessage(null); setFieldError(null); setTestResult(null)
    const searchReady = !search.model.trim() && !search.baseUrl.trim()
      ? null
      : search.model.trim() && search.baseUrl.trim() && (search.apiKey.trim() || snapshot?.webSearchCredential?.configured || deleteSearchKey)
        ? null
        : t('surface:configGate.embeddingIncomplete')
    const error = aiFieldsError(llm, t)
    if (error) { setFieldError(error); setBusy(null); return }
    const cleared: string[] = []
    if (aiFieldsIncomplete(embedding)) cleared.push(t('surface:settings.rcTabEmbedding'))
    if (aiFieldsIncomplete(vlm)) cleared.push(t('surface:settings.rcTabVlm'))
    if (asrFieldsIncomplete(asr)) cleared.push(t('surface:settings.rcTabAsr'))
    if (liteFieldsIncomplete(lite)) cleared.push(t('surface:settings.rcTabLite'))
    if (searchReady !== null) cleared.push(t('surface:settings.rcTabSearch'))
    try {
      const config = buildUserConfig(snapshot, { primary: llm, embedding, vlm, asr, lite })
      config.webSearch = {
        provider: search.provider.trim() || 'openai-compatible',
        model: searchReady === null ? search.model.trim() : '',
        baseUrl: searchReady === null ? search.baseUrl.trim() : '',
        api: 'openai-completions',
        apiKey: deleteSearchKey
          ? { operation: 'delete' }
          : search.apiKey.trim()
            ? { operation: 'set', value: search.apiKey.trim() }
            : { operation: 'keep' },
      }
      const next = await window.nxcore?.runtimeConfig.saveUser(config)
      if (next) {
        seedFromSnapshot(next)
        setMessage(cleared.length > 0
          ? t('surface:settings.rcSavedWithCleared', { sections: cleared.join('、') })
          : t('surface:settings.rcSaved'))
      }
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
  const selectSource = async (source: 'user' | 'default') => {
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
  const updateAsr = (key: 'model' | 'baseUrl' | 'apiKey' | 'language', value: string) => setAsr((c) => ({ ...c, [key]: value }))
  const updateLite = (key: keyof ManualAiConfigFields, value: string) => setLite((c) => ({ ...c, [key]: value }))
  const updateSearch = (key: keyof ManualAiConfigFields, value: string) => {
    setDeleteSearchKey(false)
    setSearch((current) => ({ ...current, [key]: value }))
  }
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
    { id: 'lite', label: t('surface:settings.rcTabLite'), optional: true },
    { id: 'embedding', label: t('surface:settings.rcTabEmbedding'), optional: true },
    { id: 'vlm', label: t('surface:settings.rcTabVlm'), optional: true },
    { id: 'asr', label: t('surface:settings.rcTabAsr'), optional: true },
    { id: 'search', label: t('surface:settings.rcTabSearch'), optional: true },
  ]

  return <section id="settings-runtime-config" className="reality-settings-section settings-anchor-section" aria-labelledby="runtime-config-title">
    <header><span><ShieldCheck aria-hidden="true" /></span><div><h2 id="runtime-config-title">{t('surface:settings.navigationRuntimeConfig')}</h2></div></header>
    <div className="runtime-config-meta">
      <span>{t('surface:settings.rcMetaSource')}：{snapshot?.source ?? '…'}</span>
      <span>{t('surface:settings.rcMetaVersion')}：{snapshot?.configVersion ?? '--'}</span>
      <span>{t('surface:settings.rcMetaUpdatedAt')}：{snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleString() : '--'}</span>
    </div>
    <div className="runtime-config-source-selector" role="group" aria-label={t('surface:settings.rcSourceLabel')}>
      <span>{t('surface:settings.rcSourceLabel')}</span>
      {([['user', 'rcSourceUser'], ['default', 'rcSourceDefault']] as const).map(([source, key]) => <button key={source} type="button" className={snapshot?.selectedSource === source ? 'active' : ''} disabled={busy !== null || (source !== 'default' && !snapshot?.availableSources.includes(source))} onClick={() => void selectSource(source)}>{t(`surface:settings.${key}`)}{source !== 'default' && !snapshot?.availableSources.includes(source) ? t('surface:settings.rcSourceNotConfigured') : ''}</button>)}
    </div>
    <div className="rc-tabs" role="tablist">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} data-active={tab === item.id} onClick={() => setTab(item.id)}>
        {item.label}
        {item.optional ? <span className="rc-tab-badge">{t('surface:settings.rcOptionalBadge')}</span> : null}
      </button>)}
    </div>

    <div className="rc-form">
      {tab === 'llm' ? <>
        <AiFieldsGroup fields={llm} onChange={updateLlm} labels={aiLabels} modelPlaceholder="gpt-4o-mini / glm-4-flash / …" />
      </> : null}
      {tab === 'lite' ? <>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={lite.model} placeholder="gpt-4o-mini / qwen-flash / glm-4-flash / …" onChange={(event) => updateLite('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.provider}</span>
          <input value={lite.provider} onChange={(event) => updateLite('provider', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
          <input value={lite.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateLite('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
          <input type="password" value={lite.apiKey} placeholder="sk-…" onChange={(event) => updateLite('apiKey', event.target.value)} /></label>
        <p className="rc-form-hint">{t('surface:settings.rcLiteHint')}</p>
      </> : null}
      {tab === 'embedding' ? <>
        <AiFieldsGroup fields={embedding} onChange={updateEmbedding} labels={aiLabels} modelPlaceholder="text-embedding-3-small / text-embedding-v4 / …" />
      </> : null}
      {tab === 'vlm' ? <>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={vlm.model} placeholder="qwen-vl-max / gpt-4o-mini / …" onChange={(event) => updateVlm('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
          <input value={vlm.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateVlm('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
          <input type="password" value={vlm.apiKey} placeholder="sk-…" onChange={(event) => updateVlm('apiKey', event.target.value)} /></label>
      </> : null}
      {tab === 'asr' ? <>
        <label className="rc-form-field"><span>{t('surface:settings.rcAsrEngine')}</span>
          <div className="segmented-control">
            <button type="button" data-active={String(asr.provider !== 'openai-compatible' && asr.provider !== 'nxcore-asr-managed')} onClick={() => setAsr((c) => ({ ...c, provider: 'aliyun' }))}>{t('surface:settings.rcAsrEngineAliyun')}</button>
            <button type="button" data-active={String(asr.provider === 'openai-compatible')} onClick={() => setAsr((c) => ({ ...c, provider: 'openai-compatible' }))}>{t('surface:settings.rcAsrEngineSelfHosted')}</button>
            <button type="button" data-active={String(asr.provider === 'nxcore-asr-managed')} onClick={() => setAsr((c) => ({ ...c, provider: 'nxcore-asr-managed' }))}>{t('surface:settings.rcAsrEngineManaged')}</button>
          </div>
        </label>
        {asr.provider === 'nxcore-asr-managed' ? <>
          <p className="rc-form-hint">{t('surface:settings.rcAsrManagedHint')}</p>
          <ManagedAsrStatus onReady={() => void saveForm()} />
        </> : asr.provider === 'openai-compatible' ? <>
          <p className="rc-form-hint">{t('surface:settings.rcAsrSelfHostedHint')}</p>
          <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
            <input value={asr.baseUrl} placeholder="http://127.0.0.1:9000" onChange={(event) => updateAsr('baseUrl', event.target.value)} /></label>
          <label className="rc-form-field"><span>{aiLabels.model}</span>
            <input value={asr.model} placeholder="完整模型 ID，如 FunAudioLLM/SenseVoiceSmall、whisper-large-v3" onChange={(event) => updateAsr('model', event.target.value)} /></label>
          <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
            <input type="password" value={asr.apiKey} placeholder={t('surface:settings.rcAsrOptionalKey')} onChange={(event) => updateAsr('apiKey', event.target.value)} /></label>
          <label className="rc-form-field"><span>{t('surface:settings.rcAsrLanguage')}</span>
            <input value={asr.language} placeholder="zh" onChange={(event) => updateAsr('language', event.target.value)} /></label>
        </> : <>
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
        </>}
      </> : null}
      {tab === 'search' ? <>
        <label className="rc-form-field"><span>{aiLabels.model}</span>
          <input value={search.model} placeholder="qwen-plus" onChange={(event) => updateSearch('model', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.baseUrl}</span>
          <input value={search.baseUrl} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" onChange={(event) => updateSearch('baseUrl', event.target.value)} /></label>
        <label className="rc-form-field"><span>{aiLabels.apiKey}</span>
          <input type="password" value={search.apiKey} placeholder={snapshot?.webSearchCredential?.configured ? t('surface:settings.rcSearchConfigured') : 'sk-...'} onChange={(event) => updateSearch('apiKey', event.target.value)} /></label>
        <p className="rc-form-hint">{snapshot?.webSearchCredential?.configured
          ? t('surface:settings.rcSearchSource', { source: snapshot.webSearchCredential.source })
          : t('surface:settings.rcSearchNotConfigured')}</p>
        {snapshot?.webSearchCredential?.source === 'user' ? <button type="button" className="secondary-button" onClick={() => { setDeleteSearchKey(true); setSearch((current) => ({ ...current, apiKey: '' })) }} disabled={busy !== null || deleteSearchKey}>
          <Trash2 aria-hidden="true" />{deleteSearchKey ? t('surface:settings.rcSearchDeletePending') : t('surface:settings.rcSearchDelete')}
        </button> : null}
      </> : null}

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
    </div>

    <details className="rc-json-details">
      <summary>{t('surface:settings.rcJsonAdvanced')}</summary>
      <textarea className="runtime-config-editor" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} aria-label="runtime config JSON" />
      <div className="runtime-config-actions">
        <button type="button" className="primary-button" onClick={() => void saveJson()} disabled={busy !== null}><Save aria-hidden="true" />JSON</button>
      </div>
    </details>
  </section>
}
