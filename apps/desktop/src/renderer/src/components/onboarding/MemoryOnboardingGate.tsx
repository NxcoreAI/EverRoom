import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronRight,
  DoorOpen,
  Languages,
  RefreshCw,
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

type GateMode = 'checking' | 'app' | 'questions' | 'saving' | 'refining' | 'success' | 'unavailable'

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
const MEMORY_SUCCESS_DISPLAY_MS = 1_200

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `memory-onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function MemoryOnboardingGate({ children }: MemoryOnboardingGateProps) {
  const { locale, setLocale, t, formatDate } = useLocale()
  const isMacDesktop = window.nxcore?.platform === 'darwin' || navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
  const storedMarker = readMemoryOnboardingMarker()
  const initialMarkerRef = useRef<MemoryOnboardingMarker | null>(
    REPEATABLE_MEMORY_ONBOARDING && storedMarker?.status !== 'pending' ? null : storedMarker,
  )
  const [mode, setMode] = useState<GateMode>('checking')
  const [step, setStep] = useState(0)
  const [pageDirection, setPageDirection] = useState<'forward' | 'backward'>('forward')
  const [answers, setAnswers] = useState(['', '', ''])
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [generatedMemory, setGeneratedMemory] = useState<GeneratedMemory | null>(null)
  const [pending, setPending] = useState<Extract<MemoryOnboardingMarker, { status: 'pending' }> | null>(() => {
    const marker = initialMarkerRef.current
    return marker?.status === 'pending' ? marker : null
  })
  const [checkRequest, setCheckRequest] = useState(0)
  const [failureContext, setFailureContext] = useState<'initial' | 'submit'>('initial')
  const baselineIdsRef = useRef<Set<string>>(new Set())
  const foregroundStartedAtRef = useRef(0)
  const submitRequestIdRef = useRef<string | null>(null)
  const finishOnboarding = useCallback(() => {
    setMode('app')
  }, [])

  const resetQuestions = useCallback(() => {
    setStep(0)
    setPageDirection('forward')
    setAnswers(['', '', ''])
    setFieldError(null)
    setGeneratedMemory(null)
    setPending(null)
    baselineIdsRef.current = new Set()
    foregroundStartedAtRef.current = 0
    submitRequestIdRef.current = null
    setMode('questions')
  }, [])

  useEffect(() => {
    let cancelled = false
    const marker = initialMarkerRef.current
    if (marker?.status === 'pending') {
      setPending(marker)
      submitRequestIdRef.current = marker.requestId
      foregroundStartedAtRef.current = Date.now()
      setMode('refining')
      return () => { cancelled = true }
    }
    if (marker && !REPEATABLE_MEMORY_ONBOARDING) {
      setMode('app')
      return () => { cancelled = true }
    }
    const api = window.nxcore?.memory
    if (!api) {
      setFailureContext('initial')
      setMode('unavailable')
      return () => { cancelled = true }
    }
    api.overview()
      .then((overview) => {
        if (cancelled) return
        setMode(REPEATABLE_MEMORY_ONBOARDING || memoryOverviewIsEmpty(overview) ? 'questions' : 'app')
      })
      .catch(() => {
        if (!cancelled) {
          setFailureContext('initial')
          setMode('unavailable')
        }
      })
    return () => { cancelled = true }
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
      setGeneratedMemory({ item, sessionId: marker.sessionId, capturedAt: marker.capturedAt })
      setMode('success')
    }
  }, [])

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

  useEffect(() => {
    if (mode !== 'success' || !generatedMemory) return
    const timer = window.setTimeout(() => {
      finishOnboarding()
    }, MEMORY_SUCCESS_DISPLAY_MS)
    return () => window.clearTimeout(timer)
  }, [finishOnboarding, generatedMemory, mode])

  const skip = () => {
    writeMemoryOnboardingMarker({ status: 'skipped' })
    setPending(null)
    finishOnboarding()
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

  if (mode === 'app') return <>{children({ openMemoryOnboarding: resetQuestions })}</>

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
        <nav className="memory-onboarding-sequence no-drag" aria-label={t('memory:onboarding.memorySetup')}>
          <span data-state="active"><BrainCircuit aria-hidden="true" />{t('memory:onboarding.memorySetup')}</span>
          <ChevronRight aria-hidden="true" />
          <span data-state="upcoming"><DoorOpen aria-hidden="true" />{t('contextRoom:onboarding.eyebrow')}</span>
        </nav>
        <div className="memory-onboarding-actions no-drag">
          <div className="memory-onboarding-language" role="group" aria-label={t('memory:onboarding.language')}>
            <Languages aria-hidden="true" />
            <button type="button" data-active={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
            <button type="button" data-active={locale === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
          </div>
          {mode !== 'success' ? <button type="button" className="memory-onboarding-skip" onClick={skip}>{t('memory:onboarding.skip')}</button> : null}
        </div>
      </header>

      <main className="memory-onboarding-main">
        <section className="memory-onboarding-stage" aria-live="polite">
          {mode === 'checking' ? (
            <div className="memory-onboarding-status-only">
              <Sparkles aria-hidden="true" />
              <span>{t('memory:onboarding.checking')}</span>
            </div>
          ) : null}

          {mode === 'unavailable' ? (
            <div className="memory-onboarding-service-state">
              <span className="memory-onboarding-kicker">{t('memory:onboarding.memorySetup')}</span>
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
                    <span className="memory-onboarding-kicker">{t('memory:onboarding.buildFirstMemory')}</span>
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

          {(mode === 'saving' || mode === 'refining') ? (
            <div className="memory-onboarding-generating">
              <div className="memory-onboarding-generation-mark" aria-hidden="true"><Sparkles /></div>
              <span className="memory-onboarding-kicker">{t('memory:onboarding.buildFirstMemory')}</span>
              <h1>{statusLabel}</h1>
              <p>{mode === 'saving' ? t('memory:onboarding.savingBody') : t('memory:onboarding.refiningBody')}</p>
              <div className="memory-onboarding-loading-dots" aria-hidden="true"><i /><i /><i /></div>
              <div className="memory-onboarding-status-list">
                <span data-complete={mode === 'refining'}><Check aria-hidden="true" />{t('memory:onboarding.savingAnswers')}</span>
                <span data-active={mode === 'refining'}><Sparkles aria-hidden="true" />{t('memory:onboarding.refiningMemory')}</span>
                <span><Check aria-hidden="true" />{t('memory:onboarding.memoryGenerated')}</span>
              </div>
            </div>
          ) : null}

          {mode === 'success' && generatedMemory ? (
            <div className="memory-onboarding-success">
              <span className="memory-onboarding-kicker">{t('memory:onboarding.memoryGenerated')}</span>
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
