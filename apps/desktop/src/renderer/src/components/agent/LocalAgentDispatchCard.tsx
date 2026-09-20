import { useState } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'
import type { DisplayAgentToolCall } from './agentRunActivity'

interface DispatchMaterialSummary {
  id: string
  kind: string
  title: string
  chars: number
  truncated: boolean
  agentOutput: boolean
  sourceDispatchId: string | null
}

interface DispatchDetails {
  taskId: string
  agentId?: string
  provider?: string
  displayName?: string
  assignment?: string
  sharedGoal?: string
  constraints?: string[]
  materials?: DispatchMaterialSummary[]
  packageVersion?: number
  resultPreview?: string
}

function argText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

function readDispatchDetails(tool: DisplayAgentToolCall): DispatchDetails | null {
  const root = tool.result ?? tool.partialResult
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const record = root as Record<string, unknown>
  const source = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : record
  if (typeof source.taskId !== 'string' || !source.taskId) return null
  return source as unknown as DispatchDetails
}

function providerFromAgentId(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined
  const provider = agentId.split(':', 1)[0]
  return provider || undefined
}

export function LocalAgentDispatchCard({
  tool,
  sessionId,
}: {
  tool: DisplayAgentToolCall
  sessionId?: string | null
}) {
  const { t } = useLocale()
  const [fullText, setFullText] = useState<string | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const details = readDispatchDetails(tool)
  const args = tool.args as Record<string, unknown>
  const assignment = details?.assignment ?? argText(args.assignment)
  const sharedGoal = details?.sharedGoal ?? argText(args.sharedGoal)
  const constraints = Array.isArray(args.constraints)
    ? args.constraints.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : details?.constraints ?? []
  const materials = details?.materials ?? []
  const agentId = details?.agentId ?? argText(args.agentId)
  const agentName = details?.displayName ?? providerFromAgentId(agentId)
  const resultPreview = details?.resultPreview

  const loadFullText = async () => {
    if (!sessionId || !details?.taskId || loadingFull) return
    setLoadingFull(true)
    setLoadFailed(false)
    try {
      const dispatch = await window.nxcore?.agent?.getLocalAgentDispatch(sessionId, details.taskId)
      setFullText(dispatch?.resultText ?? '')
    } catch {
      setLoadFailed(true)
    } finally {
      setLoadingFull(false)
    }
  }

  return (
    <div className="agent-dispatch-card">
      <div className="agent-dispatch-executor">
        <Bot aria-hidden="true" />
        <strong>{agentName ?? t('surface:agentExecutionTimeline.localAgentDispatchCard.agentFallbackName')}</strong>
        {details?.provider ?? providerFromAgentId(agentId) ? (
          <span>{details?.provider ?? providerFromAgentId(agentId)}</span>
        ) : null}
        {details?.packageVersion ? <span>{t('surface:agentExecutionTimeline.localAgentDispatchCard.packageVersion', { version: details.packageVersion })}</span> : null}
      </div>
      {assignment ? (
        <>
          <small>{t('surface:agentExecutionTimeline.localAgentDispatchCard.assignment')}</small>
          <p>{assignment}</p>
        </>
      ) : null}
      {sharedGoal ? (
        <>
          <small>{t('surface:agentExecutionTimeline.localAgentDispatchCard.sharedGoal')}</small>
          <p>{sharedGoal}</p>
        </>
      ) : null}
      {constraints.length ? (
        <>
          <small>{t('surface:agentExecutionTimeline.localAgentDispatchCard.constraints')}</small>
          <ul className="agent-dispatch-constraints">
            {constraints.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </>
      ) : null}
      {materials.length ? (
        <>
          <small>{t('surface:agentExecutionTimeline.localAgentDispatchCard.materials')}</small>
          <ul className="agent-dispatch-materials">
            {materials.map((material) => (
              <li key={material.id}>
                <span className="agent-dispatch-material-title">{material.title}</span>
                {material.agentOutput ? (
                  <em className="agent-dispatch-material-badge">
                    {t('surface:agentExecutionTimeline.localAgentDispatchCard.agentOutputBadge')}
                  </em>
                ) : null}
                <span className="agent-dispatch-material-chars">
                  {t('surface:agentExecutionTimeline.localAgentDispatchCard.charCount', { count: material.chars })}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {resultPreview ? (
        <>
          <small>{t('surface:agentExecutionTimeline.localAgentDispatchCard.result')}</small>
          <pre>{resultPreview}</pre>
          {fullText === null ? (
            <button
              type="button"
              className="agent-dispatch-full-toggle"
              disabled={!sessionId || !details?.taskId || loadingFull}
              onClick={() => void loadFullText()}
            >
              {loadingFull
                ? <LoaderCircle className="spin" aria-hidden="true" />
                : null}
              {t('surface:agentExecutionTimeline.localAgentDispatchCard.viewFullText')}
            </button>
          ) : (
            <pre className="agent-dispatch-full-text">{fullText || resultPreview}</pre>
          )}
          {loadFailed ? (
            <p className="agent-tool-error">{t('surface:agentExecutionTimeline.localAgentDispatchCard.loadFailed')}</p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
