import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronRight,
  DoorOpen,
  Languages,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { MemoryAtomicItemDto, MemoryOnboardingResultDto } from '../../../../shared/memory'
import { ProductBrand } from '@/components/ui/ProductBrand'
import { useLocale } from '@/i18n/LocaleContext'
import {
  candidateOnboardingMemories,
  MEMORY_ONBOARDING_BACKGROUND_POLL_MS,
  MEMORY_ONBOARDING_FOREGROUND_POLL_MS,
  MEMORY_ONBOARDING_FOREGROUND_TIMEOUT_MS,
  memoryOverviewIsEmpty,
  provenanceMatchesOnboarding,
  readMemoryOnboardingMarker,
  type MemoryOnboardingMarker,
  writeMemoryOnboardingMarker,
} from './memoryOnboardingState'
import './MemoryOnboardingGate.css'

type GateMode = 'checking' | 'app' | 'questions' | 'saving' | 'refining' | 'success' | 'ready' | 'unavailable'

interface GeneratedMemory {
  item: MemoryAtomicItemDto
  sessionId: string
  capturedAt: string
}

interface MemoryOnboardingControls {
  openMemoryOnboarding: () => void
}

interface MemoryOnboardingGateProps {
  children: (controls: MemoryOnboardingControls) => ReactNode
  onFinished?: () => void
  onMemoryGenerated?: (item: MemoryAtomicItemDto) => void
  onNavigateStage?: (stage: 'memory' | 'room' | 'folder' | 'ready') => void
  activeStage?: 'idle' | 'memory' | 'room' | 'folder' | 'ready'
}

const MEMORY_TYPE_KEYS: Record<string, string> = {
  episodic: 'memory:onboarding.type.episodic',
  persona: 'memory:onboarding.type.persona',
  instruction: 'memory:onboarding.type.instruction',
  other: 'memory:onboarding.type.other',
}

const TRACE_PLACEHOLDER_KEYS = [
  'memory:onboarding.tracePlaceholder1',
  'memory:onboarding.tracePlaceholder2',
  'memory:onboarding.tracePlaceholder3',
] as const

// A pending generation is still recovered instead of starting a duplicate run.
// Completed or skipped onboarding is reopened explicitly from Settings.
const REPEATABLE_MEMORY_ONBOARDING = false
// 首判 overview 自动重试：1s + 2s*4 ≈ 9s，覆盖登录时 MemoryCore 为应用
// runtime config 重启的窗口（实测约 3s）；持续失败才落到 unavailable。
const OVERVIEW_RETRY_ATTEMPTS = 5

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `memory-onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function MemoryOnboardingGate({ children, onFinished, onMemoryGenerated, onNavigateStage, activeStage = 'idle' }: MemoryOnboardingGateProps) {
  const { locale, preference, setLocale, t, formatDate } = useLocale()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const storedMarker = readMemoryOnboardingMarker()
  const initialMarkerRef = useRef<MemoryOnboardingMarker | null>(
    REPEATABLE_MEMORY_ONBOARDING && storedMarker?.status !== 'pending' ? null : storedMarker,
  )
  const [mode, setMode] = useState<GateMode>(() => {
    // A restored pending request keeps polling in the background. Only an
    // explicitly active Memory stage should block on the refining screen.
    if (initialMarkerRef.current?.status === 'pending') return activeStage === 'memory' ? 'refining' : 'app'
    if (initialMarkerRef.current && !REPEATABLE_MEMORY_ONBOARDING) return 'app'
    return 'checking'
  })
  const [step, setStep] = useState(0)
  const [pageDirection, setPageDirection] = useState<'forward' | 'backward'>('forward')
  const [answers, setAnswers] = useState(['', '', ''])
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [generatedMemory, setGeneratedMemory] = useState<GeneratedMemory | null>(null)
  const [canContinue, setCanContinue] = useState(false)
  const [pending, setPending] = useState<Extract<MemoryOnboardingMarker, { status: 'pending' }> | null>(() => {
    const marker = initialMarkerRef.current
    return marker?.status === 'pending' ? marker : null
  })
  const [checkRequest, setCheckRequest] = useState(0)
  const [failureContext, setFailureContext] = useState<'initial' | 'submit'>('initial')
  const forceLocalDataCheckRef = useRef(false)
  const baselineIdsRef = useRef<Set<string>>(new Set())
  const foregroundStartedAtRef = useRef(0)
  const continueStartedAtRef = useRef(0)
  const submitRequestIdRef = useRef<string | null>(null)
  const finishOnboarding = useCallback(() => {
    setMode('app')
    // 通知主进程引导结束：解除云端转写物化延迟（首登时 materialize 会把
    // 云端历史写进 MemoryCore L0，若先于本 gate 的 overview 判定完成，
    // 会被误判为「已完成记忆设置」而跳过引导）。
    window.nxcore?.memory?.onboardingFinished?.()
    onFinished?.()
  }, [onFinished])

  const resetQuestions = useCallback(() => {
    console.info('[onboarding] memory-open', { activeStage })
    setStep(0)
    setPageDirection('forward')
    setAnswers(['', '', ''])
    setFieldError(null)
    setGeneratedMemory(null)
    setCanContinue(false)
    setPending(null)
    baselineIdsRef.current = new Set()
    foregroundStartedAtRef.current = 0
    continueStartedAtRef.current = 0
    submitRequestIdRef.current = null
    setMode('questions')
  }, [activeStage])

  useEffect(() => {
    console.info('[onboarding] memory-mode', { mode, activeStage })
  }, [activeStage, mode])

  useEffect(() => {
    let storedForceCheck = false
    try {
      storedForceCheck = window.sessionStorage.getItem('everroom:post-login-memory-check') === '1'
      if (storedForceCheck) window.sessionStorage.removeItem('everroom:post-login-memory-check')
    } catch {
      // Session storage is optional.
    }
    const forceLocalDataCheck = () => {
      forceLocalDataCheckRef.current = true
      setCheckRequest((value) => value + 1)
    }
    window.addEventListener('everroom-post-login-onboarding-check', forceLocalDataCheck)
    if (storedForceCheck) setCheckRequest((value) => value + 1)
    return () => window.removeEventListener('everroom-post-login-onboarding-check', forceLocalDataCheck)
  }, [])

  useEffect(() => {
    let cancelled = false
    const marker = initialMarkerRef.current
    const forceLocalDataCheck = forceLocalDataCheckRef.current
    forceLocalDataCheckRef.current = false
    if (marker?.status === 'pending') {
      setPending(marker)
      submitRequestIdRef.current = marker.requestId
      foregroundStartedAtRef.current = Date.now()
      continueStartedAtRef.current = Date.now()
      if (activeStage === 'memory') {
        setMode('refining')
      } else {
        window.nxcore?.memory?.onboardingFinished?.()
        setMode('app')
      }
      return () => { cancelled = true }
    }
    if (marker && !REPEATABLE_MEMORY_ONBOARDING && !forceLocalDataCheck) {
      window.nxcore?.memory?.onboardingFinished?.()
      setMode('app')
      return () => { cancelled = true }
    }
    const api = window.nxcore?.memory
    if (!api) {
      setFailureContext('initial')
      setMode('unavailable')
      return () => { cancelled = true }
    }
    // 登录瞬间 MemoryCore 可能正为应用 runtime config 重启（约 3s 窗口）：
    // 判定请求先自动重试一段时间，持续不可达才进 unavailable（用户重试）。
    let attempt = 0
    let timer: number | null = null
    const attemptOverview = () => {
      api.overview()
        .then((overview) => {
          if (cancelled) return
          if (REPEATABLE_MEMORY_ONBOARDING || memoryOverviewIsEmpty(overview)) {
            setMode('questions')
          } else {
            // 已有记忆时给用户选择：继续进入，或重新完成一遍引导。
            window.nxcore?.memory?.onboardingFinished?.()
            setMode('ready')
          }
        })
        .catch(() => {
          if (cancelled) return
          attempt += 1
          if (attempt >= OVERVIEW_RETRY_ATTEMPTS) {
            setFailureContext('initial')
            setMode('unavailable')
            return
          }
          timer = window.setTimeout(attemptOverview, attempt === 1 ? 1_000 : 2_000)
        })
    }
    attemptOverview()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [checkRequest])

  const findGeneratedMemory = useCallback(async (
    marker: Pick<Extract<MemoryOnboardingMarker, { status: 'pending' }>, 'sessionId' | 'capturedAt'>,
  ): Promise<MemoryAtomicItemDto | null> => {
    const api = window.nxcore?.memory
    if (!api) return null
    const page = await api.listAtomic({ limit: 100 })
    const candidates = candidateOnboardingMemories(page.items, marker.capturedAt, baselineIdsRef.current)
    for (const item of candidates) {
      try {
        const provenance = await api.atomicProvenance(item.id)
        if (provenanceMatchesOnboarding(provenance, marker.sessionId)) return item
      } catch {
        // A memory can briefly be visible before its provenance is queryable.
      }
    }
    return null
  }, [])

  const completeWithMemory = useCallback((
    marker: Extract<MemoryOnboardingMarker, { status: 'pending' }>,
    item: MemoryAtomicItemDto,
    showResult: boolean,
  ) => {
    writeMemoryOnboardingMarker({ ...marker, status: 'completed', memoryId: item.id })
    setPending(null)
    if (showResult) {
      // 前台：直接在成功页展示生成结果；后台通知弹窗只留给用户已离开
      // 等待页（gate 转 app 后仍在轮询）的完成场景，避免双展示。
      setGeneratedMemory({ item, sessionId: marker.sessionId, capturedAt: marker.capturedAt })
      setMode('success')
    } else {
      onMemoryGenerated?.(item)
    }
  }, [onMemoryGenerated])

  useEffect(() => {
    if (mode !== 'saving' && mode !== 'refining') {
      setCanContinue(false)
      return
    }
    if (!continueStartedAtRef.current) continueStartedAtRef.current = Date.now()
    const remaining = Math.max(0, 3_000 - (Date.now() - continueStartedAtRef.current))
    const timer = window.setTimeout(() => setCanContinue(true), remaining)
    return () => window.clearTimeout(timer)
  }, [mode])

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer: number | null = null
    const foreground = mode === 'refining'

    const poll = async () => {
      try {
        const item = await findGeneratedMemory(pending)
        if (cancelled) return
        if (item) {
          completeWithMemory(pending, item, foreground)
          return
        }
      } catch {
        // Transient failures are retried; the pending request remains recoverable.
      }

      if (foreground && Date.now() - foregroundStartedAtRef.current >= MEMORY_ONBOARDING_FOREGROUND_TIMEOUT_MS) {
        setFailureContext('submit')
        setMode('unavailable')
        return
      }
      timer = window.setTimeout(
        poll,
        foreground ? MEMORY_ONBOARDING_FOREGROUND_POLL_MS : MEMORY_ONBOARDING_BACKGROUND_POLL_MS,
      )
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [completeWithMemory, findGeneratedMemory, finishOnboarding, mode, pending])

  const skip = () => {
    writeMemoryOnboardingMarker({ status: 'skipped' })
    initialMarkerRef.current = { status: 'skipped' }
    setPending(null)
    finishOnboarding()
  }

  const continueWithExistingMemory = () => {
    // Existing memory satisfies setup, but still needs a durable acknowledgement
    // so a renderer reload does not reopen the ready screen on every launch.
    writeMemoryOnboardingMarker({ status: 'skipped' })
    initialMarkerRef.current = { status: 'skipped' }
    finishOnboarding()
  }

  const navigateStage = (stage: 'room' | 'folder' | 'ready') => {
    setMode('app')
    onNavigateStage?.(stage)
  }

  const updateAnswer = (value: string) => {
    setAnswers((current) => current.map((answer, index) => index === step ? value.slice(0, 500) : answer))
    setFieldError(null)
  }

  const advance = () => {
    if (step < 2 && !answers[step].trim()) {
      setFieldError(t('memory:onboarding.required'))
      return
    }
    setFieldError(null)
    setPageDirection('forward')
    setStep((current) => Math.min(2, current + 1))
  }

  const submit = async () => {
    if (!answers[0].trim() || !answers[1].trim()) {
      const missingStep = !answers[0].trim() ? 0 : 1
      setPageDirection(missingStep < step ? 'backward' : 'forward')
      setStep(missingStep)
      setFieldError(t('memory:onboarding.required'))
      return
    }
    const api = window.nxcore?.memory
    if (!api) {
      setFailureContext('submit')
      setMode('unavailable')
      return
    }
    setFieldError(null)
    setMode('saving')
    continueStartedAtRef.current = Date.now()
    try {
      const baseline = await api.listAtomic({ limit: 100 })
      baselineIdsRef.current = new Set(baseline.items.map((item) => item.id))
      const requestId = submitRequestIdRef.current ?? createRequestId()
      submitRequestIdRef.current = requestId
      const result: MemoryOnboardingResultDto = await api.startOnboarding({
        requestId,
        locale,
        workContext: answers[0].trim(),
        currentFocus: answers[1].trim(),
        collaborationPreference: answers[2].trim() || undefined,
      })
      const marker: Extract<MemoryOnboardingMarker, { status: 'pending' }> = {
        status: 'pending',
        requestId,
        sessionId: result.sessionId,
        capturedAt: result.capturedAt,
      }
      writeMemoryOnboardingMarker(marker)
      setPending(marker)
      foregroundStartedAtRef.current = Date.now()
      setMode('refining')
    } catch {
      setFailureContext('submit')
      setMode('unavailable')
    }
  }

  const questions = useMemo(() => [
    {
      title: t('memory:onboarding.questionWork'),
      hint: t('memory:onboarding.hintWork'),
      placeholder: t('memory:onboarding.placeholderWork'),
    },
    {
      title: t('memory:onboarding.questionFocus'),
      hint: t('memory:onboarding.hintFocus'),
      placeholder: t('memory:onboarding.placeholderFocus'),
    },
    {
      title: t('memory:onboarding.questionCollaboration'),
      hint: t('memory:onboarding.hintCollaboration'),
      placeholder: t('memory:onboarding.placeholderCollaboration'),
    },
  ], [t])

  if (mode === 'app' || (activeStage !== 'idle' && activeStage !== 'memory')) return <>{children({ openMemoryOnboarding: resetQuestions })}</>

  const activeQuestion = questions[step]
  const visibleAnswers = answers.map((answer) => answer.trim())
  const statusLabel = mode === 'saving'
    ? t('memory:onboarding.savingAnswers')
    : mode === 'refining'
      ? t('memory:onboarding.refiningMemory')
      : mode === 'success'
        ? t('memory:onboarding.memoryGenerated')
        : null

  return (
    <div className="memory-onboarding" data-mode={mode} data-mac-desktop={String(isMacDesktop)}>
      <header className="memory-onboarding-header drag-region">
        <ProductBrand className="memory-onboarding-brand" />
        <div className="memory-onboarding-actions no-drag">
          <div className="memory-onboarding-language" role="group" aria-label={t('memory:onboarding.language')}>
            <Languages aria-hidden="true" />
            <button type="button" data-active={preference === 'system'} onClick={() => setLocale('system')}>{t('surface:settings.followSystem')}</button>
            <button type="button" data-active={preference === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
            <button type="button" data-active={preference === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
          </div>
          {mode !== 'success' ? <button type="button" className="memory-onboarding-skip" onClick={skip}>{t('memory:onboarding.skip')}</button> : null}
        </div>
      </header>

      <main className="memory-onboarding-main">
        <nav className="memory-onboarding-sequence" aria-label={t('memory:onboarding.memorySetup')}>
          <span data-state="active"><BrainCircuit aria-hidden="true" />{t('memory:onboarding.memorySetup')}</span>
          <ChevronRight aria-hidden="true" />
          <span role="button" tabIndex={0} data-state="upcoming" onClick={() => navigateStage('room')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigateStage('room') }}><DoorOpen aria-hidden="true" />{t('contextRoom:onboarding.eyebrow')}</span>
          <ChevronRight aria-hidden="true" />
          <span role="button" tabIndex={0} data-state="upcoming" onClick={() => navigateStage('folder')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigateStage('folder') }}><ShieldCheck aria-hidden="true" />{t('surface:settings.folderGuide.eyebrow')}</span>
          <ChevronRight aria-hidden="true" />
          <span role="button" tabIndex={0} data-state="upcoming" onClick={() => navigateStage('ready')} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigateStage('ready') }}><Check aria-hidden="true" />{t('surface:settings.folderGuide.readyTitle')}</span>
        </nav>
        <section className="memory-onboarding-stage" aria-live="polite">
          {mode === 'checking' ? (
            <div className="memory-onboarding-status-only">
              <Sparkles aria-hidden="true" />
              <span>{t('memory:onboarding.checking')}</span>
            </div>
          ) : null}

          {mode === 'unavailable' ? (
            <div className="memory-onboarding-service-state">
              <h1>{t('memory:onboarding.serviceNotReady')}</h1>
              <p>{t('memory:onboarding.serviceNotReadyBody')}</p>
              <div className="memory-onboarding-button-row">
                <button type="button" className="memory-onboarding-primary" onClick={() => {
                  if (failureContext === 'submit') void submit()
                  else { setMode('checking'); setCheckRequest((value) => value + 1) }
                }}>
                  <RefreshCw aria-hidden="true" />{t('memory:onboarding.retry')}
                </button>
                <button type="button" className="memory-onboarding-secondary" onClick={skip}>{t('memory:onboarding.skipForNow')}</button>
              </div>
            </div>
          ) : null}

          {mode === 'questions' ? (
            <div className="memory-onboarding-question-deck">
              <div className="memory-onboarding-deck-sheet memory-onboarding-deck-sheet-back" aria-hidden="true" />
              <div className="memory-onboarding-deck-sheet memory-onboarding-deck-sheet-middle" aria-hidden="true" />
              <article className="memory-onboarding-question" data-direction={pageDirection} key={step}>
                <header className="memory-onboarding-card-header">
                  <div>
                    <span className="memory-onboarding-step-label">{t('memory:onboarding.stepCount', { current: step + 1, total: 3 })}</span>
                  </div>
                  <div className="memory-onboarding-page-number" aria-hidden="true">
                    <strong>0{step + 1}</strong><span>/ 03</span>
                  </div>
                </header>
                <div className="memory-onboarding-progress" aria-hidden="true">
                  {[0, 1, 2].map((index) => <i key={index} data-active={index <= step} />)}
                </div>
                <div className="memory-onboarding-card-body">
                  <h1>{activeQuestion.title}</h1>
                  <p>{activeQuestion.hint}</p>
                  <label className="memory-onboarding-field">
                    <textarea
                      autoFocus
                      maxLength={500}
                      value={answers[step]}
                      placeholder={activeQuestion.placeholder}
                      aria-invalid={Boolean(fieldError)}
                      onChange={(event) => updateAnswer(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault()
                          if (step === 2) void submit()
                          else advance()
                        }
                      }}
                    />
                    <span className="memory-onboarding-counter">{answers[step].length}/500</span>
                  </label>
                  <div className="memory-onboarding-validation" aria-live="polite">{fieldError ?? (step === 2 ? t('memory:onboarding.optional') : '\u00a0')}</div>
                </div>
                <footer className="memory-onboarding-card-footer">
                  {step === 2 ? <p className="memory-onboarding-consent">{t('memory:onboarding.consent')}</p> : <span />}
                  <div className="memory-onboarding-button-row">
                    {step > 0 ? (
                      <button type="button" className="memory-onboarding-secondary memory-onboarding-back" onClick={() => {
                        setFieldError(null)
                        setPageDirection('backward')
                        setStep((current) => current - 1)
                      }}>
                        <ArrowLeft aria-hidden="true" />{t('memory:onboarding.back')}
                      </button>
                    ) : <span />}
                    <button type="button" className="memory-onboarding-primary" onClick={() => step === 2 ? void submit() : advance()}>
                      {step === 2 ? <Sparkles aria-hidden="true" /> : null}
                      {step === 2 ? t('memory:onboarding.generate') : t('memory:onboarding.continue')}
                      {step < 2 ? <ArrowRight aria-hidden="true" /> : null}
                    </button>
                  </div>
                </footer>
              </article>
            </div>
          ) : null}

          {mode === 'ready' ? (
            <div className="memory-onboarding-ready">
              <Check className="memory-onboarding-ready-icon" aria-hidden="true" />
              <h1>{t('memory:onboarding.alreadyReadyTitle')}</h1>
              <p>{t('memory:onboarding.alreadyReadyBody')}</p>
              <div className="memory-onboarding-button-row">
                <button type="button" className="memory-onboarding-secondary" onClick={resetQuestions}>{t('memory:onboarding.restart')}</button>
                <button type="button" className="memory-onboarding-primary" onClick={continueWithExistingMemory}>{t('memory:onboarding.continueToRoom')}<ChevronRight aria-hidden="true" /></button>
              </div>
            </div>
          ) : null}

          {(mode === 'saving' || mode === 'refining') ? (
            <div className="memory-onboarding-generating">
              <div className="memory-onboarding-generation-mark" aria-hidden="true"><Sparkles /></div>
              <h1>{statusLabel}</h1>
              <p>{mode === 'saving' ? t('memory:onboarding.savingBody') : t('memory:onboarding.refiningBody')}</p>
              <div className="memory-onboarding-loading-dots" aria-hidden="true"><i /><i /><i /></div>
              <div className="memory-onboarding-status-list">
                <span data-complete={mode === 'refining'}><Check aria-hidden="true" />{t('memory:onboarding.savingAnswers')}</span>
                <span data-active={mode === 'refining'}><Sparkles aria-hidden="true" />{t('memory:onboarding.refiningMemory')}</span>
                <span><Check aria-hidden="true" />{t('memory:onboarding.memoryGenerated')}</span>
              </div>
              {mode === 'refining' && canContinue ? (
                <button
                  type="button"
                  className="memory-onboarding-continue-later"
                  onClick={() => navigateStage('room')}
                >
                  {t('memory:onboarding.continueNextStep')}<ChevronRight aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}

          {mode === 'success' && generatedMemory ? (
            <div className="memory-onboarding-success">
              <h1>{t('memory:onboarding.readyTitle')}</h1>
              <p>{t('memory:onboarding.readyBody')}</p>
              <article className="memory-onboarding-result">
                <header>
                  <span>{t(MEMORY_TYPE_KEYS[generatedMemory.item.type] ?? MEMORY_TYPE_KEYS.other)}</span>
                  <time>{formatDate(generatedMemory.item.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                </header>
                <p>{generatedMemory.item.content}</p>
                <footer>{t('memory:onboarding.sourceSummary', { session: generatedMemory.sessionId.slice(0, 24), time: formatDate(generatedMemory.capturedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</footer>
              </article>
              <div className="memory-onboarding-button-row memory-onboarding-success-actions">
                <button type="button" className="memory-onboarding-primary" onClick={finishOnboarding}>
                  {t('memory:onboarding.continueToRoom')}<ChevronRight aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="memory-onboarding-trace" data-aggregating={mode === 'refining'} aria-label={t('memory:onboarding.trace')}>
          <div className="memory-trace-line" aria-hidden="true" />
          {visibleAnswers.map((answer, index) => (
            <div key={index} className="memory-trace-answer" data-filled={Boolean(answer)}>
              <span>{index + 1}</span>
              <p>{answer || t(TRACE_PLACEHOLDER_KEYS[index] ?? TRACE_PLACEHOLDER_KEYS[0])}</p>
            </div>
          ))}
          <div className="memory-trace-memory" data-ready={mode === 'success'}>
            <Sparkles aria-hidden="true" />
            <div>
              <strong>{t('memory:onboarding.atomicMemory')}</strong>
              <span>{mode === 'success' ? t('memory:onboarding.memoryGenerated') : t('memory:onboarding.waitingToConverge')}</span>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
