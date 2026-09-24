import {
  ArrowLeft,
  Check,
  Languages,
  LoaderCircle,
  PlugZap,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { OIDC_LOGIN_CANCELLED_MESSAGE, type RuntimeConfigSnapshot, type RuntimeConfigTestResult } from '../../../../shared/sources'
import appleLogo from '@/assets/apple-logo.svg'
import googleLogo from '@/assets/google-logo.svg'
import { ProductBrand } from '@/components/ui/ProductBrand'
import { StartupSplash } from '@/components/ui/StartupSplash'
import { WindowControls } from '@/components/WindowControls'
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
type GateMode = 'checking' | 'app' | 'login' | 'manual' | 'validating' | 'unavailable' | 'authNetwork'
type ManualTab = 'llm' | 'embedding'

/** 闪屏最短展示时长：决策再快也不闪现即逝。 */
const STARTUP_SPLASH_MIN_MS = 900

/** 已认证 + 配置未就绪的续签宽限重查次数（2s 间隔，~30s 上限）。 */
const RELAY_GRACE_RETRIES = 15

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
  const { account, resolved: accountResolved, refreshAccount } = useAccount()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const [mode, setMode] = useState<GateMode>('checking')
  const [snapshot, setSnapshot] = useState<RuntimeConfigSnapshot | null>(null)
  const [fields, setFields] = useState<ManualAiConfigFields>(emptyAiFields())
  const [embedding, setEmbedding] = useState<ManualAiConfigFields>(emptyAiFields())
  const [manualTab, setManualTab] = useState<ManualTab>('llm')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [oidcPending, setOidcPending] = useState<'apple' | 'google' | null>(null)
  const [qrActive, setQrActive] = useState(false)
  // 扫码面板注册的「取消会话」句柄：返回按钮画在页标题左侧，由这里触发。
  const qrCancelRef = useRef<(() => void) | null>(null)
  const registerQrCancel = useCallback((cancel: (() => void) | null) => {
    qrCancelRef.current = cancel
  }, [])
  const [checkRequest, setCheckRequest] = useState(0)
  // 配置就绪不等于可放行：登录态（SaaS 网络往返）落定前停在启动闪屏。
  const [configReady, setConfigReady] = useState(false)
  const modeRef = useRef<GateMode>('checking')
  useEffect(() => { modeRef.current = mode }, [mode])
  // check() 里读「此刻」的登录态（避免 useCallback 依赖 account 导致的重建链）。
  const accountRef = useRef(account)
  accountRef.current = account
  // 续签宽限重查计数：config 就绪即清零。
  const relayGraceRef = useRef(0)
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
        relayGraceRef.current = 0
      } else if (accountRef.current?.authenticated && relayGraceRef.current < RELAY_GRACE_RETRIES) {
        // 已认证但配置未就绪：中转续签（restore 后 rewrite 槽位）通常几秒内
        // 落地——本会话恢复日志已证成功，把已登录用户送去登录页是续签竞态。
        // 停留在 checking（闪屏/安静），2s 后重查，最多 ~30s。
        relayGraceRef.current += 1
        window.setTimeout(() => { void check() }, 2_000)
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
      const next = (event as CustomEvent<{ authenticated?: unknown; authBlocked?: string | null }>).detail
      // 只处理运行中会话失效（登出/被踢）：启动期的未登录由上方 outcome
      // effect 判定，这里抢跑会把中间页直接翻成登录页。
      // authBlocked='network'（凭据在、网络验证失败）不算会话失效，不踢人。
      if (next?.authenticated === false && !next.authBlocked && modeRef.current === 'app') {
        setTestError(null)
        setMode('login')
      }
    }
    window.addEventListener('everroom-account-status-changed', onAccountChanged)
    return () => window.removeEventListener('everroom-account-status-changed', onAccountChanged)
  }, [])

  // 网络受阻判定：凭据在但验证失败 → 明确提示网络问题 + 重试，
  // 而不是呈现登录页（用户会误以为被登出/要重新登录）。恢复后交回正常判定。
  useEffect(() => {
    if (!accountResolved) return
    if (account?.authenticated === false && account.authBlocked === 'network') {
      setMode((current) => (current === 'app' || current === 'authNetwork' ? current : 'authNetwork'))
    } else {
      setMode((current) => (current === 'authNetwork' ? 'login' : current))
    }
  }, [account, accountResolved])

  /** authNetwork 面板重试：重拉账号状态 + 重跑配置检查，任一恢复即离开本态。 */
  const retryAuthNetwork = useCallback(async () => {
    try { await refreshAccount() } catch { /* 状态未变，留在本页 */ }
    setCheckRequest((value) => value + 1)
  }, [refreshAccount])

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
    setOidcPending(provider)
    setTestError(null)
    try {
      await window.nxcore.account.loginWithOidc(provider)
      await completeGateLogin()
    } catch (error) {
      // 用户主动取消：静默回到登录页，不算失败。
      if (error instanceof Error && error.message === OIDC_LOGIN_CANCELLED_MESSAGE) return
      setTestError(t('surface:configGate.loginFailed'))
    } finally {
      setOidcPending(null)
    }
  }

  /** 登录成功后的共同放行：广播账号变化，拉取 SaaS runtime config 并连通测试。 */
  const completeGateLogin = async () => {
    // QR 扫码路径经 void 调用本函数：status 抛错不能让 rejection 被静默吞掉。
    const account = await window.nxcore!.account.status().catch(() => null)
    if (account) {
      window.dispatchEvent(new CustomEvent('everroom-account-status-changed', { detail: account }))
    }
    // 登录钩子（main index）已启动中转保活；relayReady 触发一次续签并轮询
    // 快照直至主配置可用（中转激活重写槽位），轮询窗口内已覆盖首拉空
    // primary 的就绪竞态。失败（网络抖动等）退回网关当前快照——本地仍保留
    // 可用配置时照常放行（#225：不能把已登录用户困在登录页）。
    let next: RuntimeConfigSnapshot | null | undefined
    try {
      next = await window.nxcore!.runtimeConfig.relayReady()
    } catch {
      next = await window.nxcore!.runtimeConfig.get().catch(() => null)
    }
    if (next && isRuntimeConfigReady(next)) {
      // 登录只回答「你是谁」；LLM 连通性不阻塞进入应用（外网端点可能依赖
      // 系统代理，测试失败应是应用内降级提示而非登录失败——认证已成功却
      // 被踹回登录页即由此而来）。首次手动配置仍走 validateAndEnter 把关。
      setSnapshot(next)
      enterApp()
      window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'ready' }))
      try {
        window.sessionStorage.setItem('everroom:post-login-memory-check', '1')
        window.sessionStorage.setItem('everroom:post-login-room-check', '1')
      } catch {
        // Session storage is optional; mounted gates still receive the event.
      }
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('everroom-post-login-onboarding-check')), 0)
      // 连通测试异步补跑：失败亮降级提示（Sidebar / 设置页），不拦人。
      void window.nxcore?.runtimeConfig?.test()
        .then((result) => {
          const failed = result?.valid !== true || gateTestError(result, t) !== null
          if (failed) {
            window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'degraded' }))
          }
        })
        .catch(() => {
          window.dispatchEvent(new CustomEvent('everroom-runtime-config-status', { detail: 'degraded' }))
        })
    } else {
      // 登录成功但中转会话未就绪：留在登录页展示原因，
      // 用户可重试或点「返回」去手动配置。
      setTestError(t('surface:configGate.relayNotReady'))
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
          {mode === 'authNetwork' ? (
            <div className="runtime-config-gate-panel">
              <h1>{t('surface:configGate.authNetworkTitle')}</h1>
              <p>{t('surface:configGate.authNetworkBody')}</p>
              <div className="runtime-config-gate-button-row">
                <button type="button" className="runtime-config-gate-primary" onClick={() => void retryAuthNetwork()}>
                  <RefreshCw aria-hidden="true" />{t('surface:configGate.retry')}
                </button>
              </div>
            </div>
          ) : null}

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
              <h1 className="runtime-config-gate-login-heading">
                {qrActive ? (
                  <button
                    type="button"
                    className="runtime-config-gate-heading-back"
                    aria-label={t('surface:qrLogin.backToMethods')}
                    title={t('surface:qrLogin.backToMethods')}
                    onClick={() => qrCancelRef.current?.()}
                  >
                    <ArrowLeft aria-hidden="true" />
                  </button>
                ) : null}
                {qrActive ? t('surface:configGate.scanLoginHeading') : t('surface:configGate.loginHeading')}
              </h1>

              {!qrActive ? (
                <div className="qr-login-methods" key="gate-methods">
                  <div className="runtime-config-gate-login-row">
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

                  {oidcPending !== null ? (
                    <div className="runtime-config-gate-waiting" role="status">
                      <p><LoaderCircle className="spin" aria-hidden="true" /></p>
                      <button type="button" className="runtime-config-gate-secondary" onClick={() => { void window.nxcore?.account.cancelOidcLogin() }}>
                        {t('surface:configGate.cancelLogin')}
                      </button>
                    </div>
                  ) : null}

                  {testError ? <p className="runtime-config-gate-error" role="alert"><PlugZap aria-hidden="true" />{testError}</p> : null}
                </div>
              ) : null}

              <QrLoginPanel
                account={null}
                onAccountChanged={() => undefined}
                onLoginSucceeded={() => { void completeGateLogin() }}
                onActiveChange={setQrActive}
                registerCancel={registerQrCancel}
                entryDisabled={oidcPending !== null}
              />

              {!qrActive ? (
                <div className="qr-login-methods" key="gate-secondary">
                  <button type="button" className="runtime-config-gate-manual-link" onClick={() => { setTestError(null); setMode('manual') }}>
                    {t('surface:configGate.manualOption')}
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
