import {
  ArrowLeft,
  Check,
  Languages,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Settings2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { RuntimeConfigSnapshot, RuntimeConfigTestResult } from '../../../../shared/sources'
import appleLogo from '@/assets/apple-logo.svg'
import googleLogo from '@/assets/google-logo.svg'
import { ProductBrand } from '@/components/ui/ProductBrand'
import { StartupSplash } from '@/components/ui/StartupSplash'
import { WindowControls } from '@/components/WindowControls'
import { RedeemCodeField, useRedeemCode } from '@/components/account/RedeemCodeField'
import { QrLoginPanel } from '@/components/account/QrLoginPanel'
import { useLocale } from '@/i18n/LocaleContext'
import { useAccount } from '@/state/AccountContext'
import {
  buildUserConfig,
  configTestErrorMessage,
  embeddingFieldsFromSnapshot,
  emptyAiFields,
  isRuntimeConfigReady,
  manualConfigFieldError,
  primaryFieldsFromSnapshot,
  startupGateOutcome,
  type ManualAiConfigFields,
} from './runtimeConfigGateState'
import './RuntimeConfigGate.css'

/**
 * 启动 runtime config gate：打开应用先检查 AI 运行时配置是否就绪；
 * 未配置时提供「登录 SaaS」与「手动配置」两条路，保存后必须通过
 * gateway 连通测试（POST /v1/runtime-config/test）才放行进入应用。
 * 手动配置含 LLM（必填）与 embedding（可选，填了才测 /embeddings）两个 tab。
 */
type GateMode = 'checking' | 'app' | 'login' | 'manual' | 'validating' | 'unavailable'
type ManualTab = 'llm' | 'embedding'

/** 闪屏最短展示时长：决策再快也不闪现即逝。 */
const STARTUP_SPLASH_MIN_MS = 900

/** 测试结果 → 用户可读错误；embedding 失败带专属前缀区分两 tab。 */
function gateTestError(result: RuntimeConfigTestResult | undefined, t: (key: string) => string): string | null {
  if (result?.valid !== true) return configTestErrorMessage(result?.error, t)
  if (result.embedding && result.embedding.valid !== true) {
    return `${t('surface:configGate.embeddingTestLabel')}${configTestErrorMessage(result.embedding.error, t)}`
  }
  return null
}

export function RuntimeConfigGate({ children }: { children: ReactNode }) {
  const { locale, preference, setLocale, t } = useLocale()
  const { account, resolved: accountResolved } = useAccount()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const [mode, setMode] = useState<GateMode>('checking')
  const [snapshot, setSnapshot] = useState<RuntimeConfigSnapshot | null>(null)
  const [fields, setFields] = useState<ManualAiConfigFields>(emptyAiFields())
  const [embedding, setEmbedding] = useState<ManualAiConfigFields>(emptyAiFields())
  const [manualTab, setManualTab] = useState<ManualTab>('llm')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const redeemCode = useRedeemCode()
  const [testError, setTestError] = useState<string | null>(null)
  const [oidcPending, setOidcPending] = useState<'apple' | 'google' | null>(null)
  const [qrActive, setQrActive] = useState(false)
  const [checkRequest, setCheckRequest] = useState(0)
  // 配置就绪不等于可放行：登录态（SaaS 网络往返）落定前停在启动闪屏。
  const [configReady, setConfigReady] = useState(false)
  const modeRef = useRef<GateMode>('checking')
  useEffect(() => { modeRef.current = mode }, [mode])
  // 启动闪屏只在首次进入时出现一次：show（覆盖中）→ exiting（退场过渡）→
  // gone（永不再现）。最短展示时长防止"闪一下就消失"的廉价感。
  const [splash, setSplash] = useState<'show' | 'exiting' | 'gone'>('show')
  const splashShownAtRef = useRef(Date.now())
  const splashExitTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (splashExitTimerRef.current !== null) window.clearTimeout(splashExitTimerRef.current)
  }, [])
  const scheduleSplashExit = useCallback(() => {
    const wait = Math.max(0, STARTUP_SPLASH_MIN_MS - (Date.now() - splashShownAtRef.current))
    splashExitTimerRef.current = window.setTimeout(() => {
      setSplash((current) => (current === 'show' ? 'exiting' : current))
    }, wait)
  }, [])

  const check = useCallback(async () => {
    setMode('checking')
    window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'checking' }))
    setTestError(null)
    const runtimeConfig = window.nxcore?.runtimeConfig
    if (!runtimeConfig) {
      // 无 preload（测试环境）：直接放行，不闪屏。
      setSplash('gone')
      setMode('app')
      return
    }
    try {
      const next = await runtimeConfig.get()
      setSnapshot(next)
      setFields(primaryFieldsFromSnapshot(next))
      setEmbedding(embeddingFieldsFromSnapshot(next))
      if (isRuntimeConfigReady(next)) {
        // 不直接进 app：由下方 effect 等登录态落定后决定 app/login。
        setConfigReady(true)
      } else {
        setConfigReady(false)
        setMode('login')
        scheduleSplashExit()
        window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'missing' }))
      }
    } catch {
      // gateway 未就绪：给重试入口，不静默放行。
      setConfigReady(false)
      setMode('unavailable')
      scheduleSplashExit()
      window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'error' }))
    }
  }, [scheduleSplashExit])

  useEffect(() => { void check() }, [check, checkRequest])

  useEffect(() => {
    const outcome = startupGateOutcome({
      configReady,
      accountResolved,
      authenticated: account?.authenticated ?? null,
      configSource: snapshot?.selectedSource ?? null,
    })
    if (outcome === 'wait') return
    if (outcome === 'app') {
      setMode('app')
      window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'ready' }))
    } else {
      setMode('login')
    }
    scheduleSplashExit()
  }, [configReady, accountResolved, account, snapshot, scheduleSplashExit])

  useEffect(() => {
    const onAccountChanged = (event: Event) => {
      const next = (event as CustomEvent<{ authenticated?: unknown }>).detail
      // 只处理运行中会话失效（登出/被踢）：启动期的未登录由上方 outcome
      // effect 判定，这里抢跑会把中间页直接翻成登录页。
      if (next?.authenticated === false && modeRef.current === 'app') {
        setTestError(null)
        setMode('login')
      }
    }
    window.addEventListener('everroom-account-status-changed', onAccountChanged)
    return () => window.removeEventListener('everroom-account-status-changed', onAccountChanged)
  }, [])

  const enterApp = () => setMode('app')

  /** 连通测试通过才放行（primary 必须有效；embedding 配置了才要求有效）。失败留在来源页（login/manual），不弹回选择页。 */
  const validateAndEnter = async (next: RuntimeConfigSnapshot, from: 'login' | 'manual' = 'manual'): Promise<boolean> => {
    setMode('validating')
    window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'testing' }))
    try {
      const result = await window.nxcore?.runtimeConfig?.test()
      if (result?.valid) {
        const error = gateTestError(result, t)
        if (error) {
          setTestError(error)
          setMode(from)
          return false
        }
        setSnapshot(next)
        enterApp()
        window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'ready' }))
        return true
      }
      setTestError(configTestErrorMessage(result?.error, t))
      setMode(from)
    } catch (error) {
      setTestError(error instanceof Error ? error.message : t('surface:configGate.testFailedGeneric'))
      setMode(from)
    }
    return false
  }

  const loginWithOidc = async (provider: 'apple' | 'google') => {
    if (!window.nxcore) return
    let redeemCodeValue:string|undefined
    try { redeemCodeValue=await redeemCode.prepare() } catch { setTestError(t('surface:settings.redeemCodeInvalid')); return }
    setOidcPending(provider)
    setTestError(null)
    try {
      const account = await window.nxcore.account.loginWithOidc(provider,redeemCodeValue)
      if(redeemCodeValue&&account.registration){
        window.alert(t(account.registration.invitationRejected==='pro_plan_active'?'surface:settings.redeemCodeProActive':'surface:settings.redeemCodeApplied'))
        redeemCode.reset()
      }
      await completeGateLogin()
    } catch (error) {
      if(redeemCodeValue&&error instanceof Error&&/invitation code/i.test(error.message))redeemCode.markInvalid()
      setTestError(t('surface:configGate.loginFailed'))
    } finally {
      setOidcPending(null)
    }
  }

  /** 登录成功后的共同放行：广播账号变化，拉取 SaaS runtime config 并连通测试。 */
  const completeGateLogin = async () => {
    const account = await window.nxcore!.account.status()
    window.dispatchEvent(new CustomEvent('everroom-account-status-changed', { detail: account }))
    // 登录钩子（main index）会把 SaaS runtime config 写进 gateway；
    // 这里再显式拉取一次确保 saas source 已保存，然后走连通测试。
    const next = await window.nxcore!.runtimeConfig.refreshSaas()
    if (next && isRuntimeConfigReady(next)) {
      const entered = await validateAndEnter(next, 'login')
      if (entered) {
        try {
          window.sessionStorage.setItem('everroom:post-login-memory-check', '1')
          window.sessionStorage.setItem('everroom:post-login-room-check', '1')
        } catch {
          // Session storage is optional; mounted gates still receive the event.
        }
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('everroom-post-login-onboarding-check')), 0)
      }
    } else {
      // 登录成功但云端没下发有效配置：留在登录页展示原因，
      // 用户可重试或点「返回」去手动配置。
      setTestError(t('surface:configGate.saasConfigMissing'))
    }
  }

  const saveManual = async () => {
    const runtimeConfig = window.nxcore?.runtimeConfig
    if (!runtimeConfig) return
    const error = manualConfigFieldError(fields, embedding, t)
    if (error) {
      setFieldError(error)
      return
    }
    setFieldError(null)
    setTestError(null)
    try {
      const next = await runtimeConfig.saveUser(buildUserConfig(snapshot, { primary: fields, embedding }))
      await validateAndEnter(next, 'manual')
    } catch (saveError) {
      setTestError(saveError instanceof Error ? saveError.message : t('surface:configGate.testFailedGeneric'))
    }
  }

  // 启动闪屏覆盖层：show/exiting 期间盖在最上层，退场动画结束（gone）后卸载，
  // 之后无论模式怎么流转都不再出现（含 check() 重试——控制台保持可见）。
  const splashOverlay = splash !== 'gone'
    ? <StartupSplash exiting={splash === 'exiting'} onExited={() => setSplash('gone')} />
    : null
  if (mode === 'app' || mode === 'validating' || (mode === 'checking' && splash === 'gone')) {
    return <>{children}{splashOverlay}</>
  }

  const updateField = (key: keyof ManualAiConfigFields, value: string) => {
    setFields((current) => ({ ...current, [key]: value }))
    setFieldError(null)
  }

  const updateEmbeddingField = (key: keyof ManualAiConfigFields, value: string) => {
    setEmbedding((current) => ({ ...current, [key]: value }))
    setFieldError(null)
  }

  return (
    <div className="runtime-config-gate" data-mode={mode} data-mac-desktop={String(isMacDesktop)}>
      <header className="runtime-config-gate-header drag-region">
        <ProductBrand className="runtime-config-gate-brand" />
        <div className="runtime-config-gate-actions no-drag">
          <div className="runtime-config-gate-language" role="group" aria-label={t('surface:configGate.language')}>
            <Languages aria-hidden="true" />
            <button type="button" data-active={preference === 'system'} onClick={() => setLocale('system')}>{t('surface:settings.followSystem')}</button>
            <button type="button" data-active={preference === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
            <button type="button" data-active={preference === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
          </div>
          <WindowControls />
        </div>
      </header>

      <main className="runtime-config-gate-main">
        <section className="runtime-config-gate-stage" aria-live="polite">
          {mode === 'unavailable' ? (
            <div className="runtime-config-gate-panel">
              <h1>{t('surface:configGate.unavailableTitle')}</h1>
              <p>{t('surface:configGate.unavailableBody')}</p>
              <div className="runtime-config-gate-button-row">
                <button type="button" className="runtime-config-gate-primary" onClick={() => setCheckRequest((value) => value + 1)}>
                  <RefreshCw aria-hidden="true" />{t('surface:configGate.retry')}
                </button>
              </div>
            </div>
          ) : null}

          {mode === 'login' ? (
            <div className="runtime-config-gate-panel">
              <h1>{t('surface:configGate.loginHeading')}</h1>

              {!qrActive ? (
                <div className="qr-login-methods" key="gate-methods">
                  <RedeemCodeField value={redeemCode.code} state={redeemCode.state} open={redeemCode.open} disabled={oidcPending!==null} onChange={redeemCode.change} onToggle={()=>redeemCode.setOpen(value=>!value)}/>

                  <div className="runtime-config-gate-button-row runtime-config-gate-login-row">
                    <button type="button" className="runtime-config-gate-social-button runtime-config-gate-apple-login" disabled={oidcPending !== null} onClick={() => void loginWithOidc('apple')}>
                      <span className="runtime-config-gate-brand-login-icon" aria-hidden="true">
                        {oidcPending === 'apple' ? <LoaderCircle className="spin" /> : <img src={appleLogo} alt="" />}
                      </span>
                      {t('surface:settings.signInWithApple')}
                    </button>
                    <button type="button" className="runtime-config-gate-social-button runtime-config-gate-google-login" disabled={oidcPending !== null} onClick={() => void loginWithOidc('google')}>
                      <span className="runtime-config-gate-brand-login-icon" aria-hidden="true">
                        {oidcPending === 'google' ? <LoaderCircle className="spin" /> : <img src={googleLogo} alt="" />}
                      </span>
                      {t('surface:settings.signInWithGoogle')}
                    </button>
                  </div>
                  <p className="runtime-config-gate-note">
                    {oidcPending
                      ? t('surface:settings.completeSignInInYourBrowserYouWill')
                      : t('surface:settings.signInIsCompletedSecurelyInYourBrowser')}
                  </p>

                  {testError ? <p className="runtime-config-gate-error" role="alert"><PlugZap aria-hidden="true" />{testError}</p> : null}
                </div>
              ) : null}

              <QrLoginPanel
                account={null}
                onAccountChanged={() => undefined}
                onLoginSucceeded={() => { void completeGateLogin() }}
                onActiveChange={setQrActive}
                entryDisabled={oidcPending !== null}
              />

              {!qrActive ? (
                <div className="runtime-config-gate-button-row" key="gate-manual">
                  <button type="button" className="runtime-config-gate-secondary" onClick={() => { setTestError(null); setMode('manual') }}>
                    <Settings2 aria-hidden="true" />{t('surface:configGate.manualOption')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === 'manual' ? (
            <div className="runtime-config-gate-panel runtime-config-gate-panel-form">
              <h1>{t('surface:configGate.manualHeading')}</h1>
              <p>{t('surface:configGate.manualBody')}</p>

              <div className="runtime-config-gate-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualTab === 'llm'}
                  data-active={manualTab === 'llm'}
                  onClick={() => setManualTab('llm')}
                >
                  {t('surface:configGate.tabLlm')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualTab === 'embedding'}
                  data-active={manualTab === 'embedding'}
                  onClick={() => setManualTab('embedding')}
                >
                  {t('surface:configGate.tabEmbedding')}
                  <span className="runtime-config-gate-tab-badge">{t('surface:configGate.embeddingOptional')}</span>
                </button>
              </div>

              {manualTab === 'llm' ? (
                <>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldProvider')}</span>
                    <input value={fields.provider} onChange={(event) => updateField('provider', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldModel')}</span>
                    <input value={fields.model} placeholder="gpt-4o-mini / glm-4-flash / …" onChange={(event) => updateField('model', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldBaseUrl')}</span>
                    <input value={fields.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateField('baseUrl', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldApiKey')}</span>
                    <input type="password" value={fields.apiKey} placeholder="sk-…" onChange={(event) => updateField('apiKey', event.target.value)} />
                  </label>
                </>
              ) : (
                <>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldProvider')}</span>
                    <input value={embedding.provider} onChange={(event) => updateEmbeddingField('provider', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldModel')}</span>
                    <input value={embedding.model} placeholder="text-embedding-3-small / text-embedding-v4 / …" onChange={(event) => updateEmbeddingField('model', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldBaseUrl')}</span>
                    <input value={embedding.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => updateEmbeddingField('baseUrl', event.target.value)} />
                  </label>
                  <label className="runtime-config-gate-field">
                    <span>{t('surface:configGate.fieldApiKey')}</span>
                    <input type="password" value={embedding.apiKey} placeholder="sk-…" onChange={(event) => updateEmbeddingField('apiKey', event.target.value)} />
                  </label>
                  <p className="runtime-config-gate-note">{t('surface:configGate.embeddingHint')}</p>
                </>
              )}

              <div className="runtime-config-gate-validation" aria-live="polite">{fieldError ?? ' '}</div>
              {testError ? <p className="runtime-config-gate-error" role="alert"><PlugZap aria-hidden="true" />{testError}</p> : null}

              <div className="runtime-config-gate-button-row">
                <button type="button" className="runtime-config-gate-secondary" onClick={() => { setFieldError(null); setTestError(null); setMode('login') }}>
                  <ArrowLeft aria-hidden="true" />{t('surface:configGate.back')}
                </button>
                <button type="button" className="runtime-config-gate-primary" onClick={() => void saveManual()}>
                  <Check aria-hidden="true" />{t('surface:configGate.saveAndTest')}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
      {splashOverlay}
    </div>
  )
}
