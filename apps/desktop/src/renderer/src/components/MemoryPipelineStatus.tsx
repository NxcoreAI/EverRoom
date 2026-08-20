import { Activity, Check, CircleAlert, Loader } from 'lucide-react'
import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

import type { PageId } from '@/data/navigation'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import type { MemoryOverviewDto } from '../../../shared/memory'
import './MemoryPipelineStatus.css'

type PipelineState = 'loading' | 'running' | 'queued' | 'idle' | 'unavailable'
type DeltaLevel = 'l1' | 'l2' | 'l3'

const STATE_ICONS: Record<PipelineState, typeof Activity> = {
  loading: Activity,
  running: Loader,
  queued: Activity,
  idle: Check,
  unavailable: CircleAlert,
}

/** 点击后跳转记忆页时要打开的 tab。 */
const DELTA_TABS: Record<DeltaLevel, string> = {
  l1: 'atomic',
  l2: 'scenario',
  l3: 'core',
}

/** 记忆页监听该事件切换 tab（detail: { tab }），避免跨组件层层透传。 */
export const MEMORY_TAB_EVENT = 'nxcore:memory:open-tab'

interface MemorySnapshot {
  l1: number | null
  l2: number | null
  l3UpdatedAt: string | null
}

interface MemoryDelta {
  l1: number
  l2: number
  l3Updated: boolean
}

interface MemoryParticleBurstProps {
  targetRef: RefObject<HTMLElement | null>
  count: number
  onDone: () => void
}

interface ParticleGeometry {
  startX: number
  startY: number
  targetX: number
  targetY: number
}

function MemoryParticleBurst({ targetRef, count, onDone }: MemoryParticleBurstProps) {
  const [geometry, setGeometry] = useState<ParticleGeometry | null>(null)

  useEffect(() => {
    let frame = 0
    const target = targetRef.current
    if (!target) return undefined

    frame = window.requestAnimationFrame(() => {
      const targetRect = target.getBoundingClientRect()
      if (targetRect.width === 0 || targetRect.height === 0) return
      const workspace = document.querySelector<HTMLElement>('.workspace-main')
      const workspaceRect = workspace?.getBoundingClientRect()
      const startX = workspaceRect
        ? workspaceRect.left + workspaceRect.width * 0.58
        : window.innerWidth * 0.72
      const startY = workspaceRect
        ? workspaceRect.top + workspaceRect.height * 0.42
        : window.innerHeight * 0.48
      setGeometry({
        startX,
        startY,
        targetX: targetRect.left + targetRect.width / 2,
        targetY: targetRect.top + targetRect.height / 2,
      })
    })

    const timeout = window.setTimeout(onDone, 1_350)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [onDone, targetRef])

  if (!geometry) return null

  const coreCount = Math.min(Math.max(1, count), 16)
  const particleCount = Math.min(48, Math.max(6, coreCount * 2, 4 + count * 2))
  const coreRadius = coreCount === 1 ? 0 : coreCount <= 4 ? 20 : 26
  const coreOffsets = Array.from({ length: coreCount }, (_, coreIndex) => {
    const angle = coreCount === 1 ? 0 : -Math.PI / 2 + (coreIndex / coreCount) * Math.PI * 2
    return [Math.cos(angle) * coreRadius, Math.sin(angle) * coreRadius] as const
  })
  const particles = Array.from({ length: particleCount }, (_, index) => {
    const wave = index - (particleCount - 1) / 2
    const spreadX = Math.sin(index * 2.2) * 92 + wave * 3
    const spreadY = Math.cos(index * 1.55) * 54 + Math.sin(index * 0.7) * 12
    const originX = geometry.startX + spreadX
    const originY = geometry.startY + spreadY
    const core = coreOffsets[index % coreCount]!
    const coreJitter = (Math.floor(index / coreCount) % 2 === 0 ? -1 : 1) * (index % 3)
    const gatherX = geometry.startX + core[0] + coreJitter
    const gatherY = geometry.startY + core[1] + coreJitter
    const flightArcX = Math.sin(index * 1.8) * 34 + wave * 2.5
    const flightArcY = Math.cos(index * 1.35) * 26
    const flightDx = geometry.targetX - gatherX
    const flightDy = geometry.targetY - gatherY
    const style = {
      '--particle-start-x': `${originX}px`,
      '--particle-start-y': `${originY}px`,
      '--particle-dx': `${geometry.targetX - originX}px`,
      '--particle-dy': `${geometry.targetY - originY}px`,
      '--particle-gather-x': `${gatherX - originX}px`,
      '--particle-gather-y': `${gatherY - originY}px`,
      '--particle-mid-x': `${gatherX - originX + flightDx * 0.56 + flightArcX}px`,
      '--particle-mid-y': `${gatherY - originY + flightDy * 0.56 + flightArcY}px`,
      '--particle-delay': `${(index % 5) * 32}ms`,
      '--particle-duration': `${860 + (index % 4) * 85}ms`,
      '--particle-size': `${3 + (index % 3) * 0.8}px`,
    } as CSSProperties
    return <i key={index} className="memory-particle" style={style} />
  })

  return createPortal(
    <div className="memory-particle-layer" aria-hidden="true">
      {particles}
    </div>,
    document.body,
  )
}

function snapshotOf(overview: MemoryOverviewDto): MemorySnapshot {
  return {
    l1: overview.l1?.total ?? null,
    l2: overview.l2?.total ?? null,
    l3UpdatedAt: overview.l3?.updatedAt ?? null,
  }
}

function deltaBetween(previous: MemorySnapshot, current: MemorySnapshot): MemoryDelta | null {
  const delta: MemoryDelta = {
    l1: previous.l1 !== null && current.l1 !== null ? Math.max(0, current.l1 - previous.l1) : 0,
    l2: previous.l2 !== null && current.l2 !== null ? Math.max(0, current.l2 - previous.l2) : 0,
    l3Updated: Boolean(previous.l3UpdatedAt && current.l3UpdatedAt && previous.l3UpdatedAt !== current.l3UpdatedAt),
  }
  return delta.l1 > 0 || delta.l2 > 0 || delta.l3Updated ? delta : null
}

function deltaSummary(delta: MemoryDelta, t: Translate): string {
  const parts: string[] = []
  if (delta.l1 > 0) parts.push(t('memory:pipeline.atomicMemoryAdded', { count: delta.l1 }))
  if (delta.l2 > 0) parts.push(t('memory:pipeline.scenesAdded', { count: delta.l2 }))
  if (delta.l3Updated) parts.push(t('memory:pipeline.profileUpdated'))
  return parts.join(' · ')
}

function primaryDeltaLevel(delta: MemoryDelta): DeltaLevel {
  if (delta.l1 > 0) return 'l1'
  if (delta.l2 > 0) return 'l2'
  return 'l3'
}

function stageCount(
  overview: MemoryOverviewDto | null,
  key: 'l1' | 'l2' | 'l3',
  kind: 'running' | 'queued',
): number {
  return overview?.pipeline?.[key]?.[kind] ?? 0
}

function activeLabel(overview: MemoryOverviewDto | null, state: PipelineState): string {
  if (!overview?.pipeline) return ''
  const kind = state === 'running' ? 'running' : 'queued'
  for (const key of ['l1', 'l2', 'l3'] as const) {
    const count = stageCount(overview, key, kind)
    if (count > 0) return `${key.toUpperCase()} ${count}`
  }
  return ''
}

function tooltipLines(overview: MemoryOverviewDto | null, state: PipelineState, delta: MemoryDelta | null, t: Translate): string[] {
  if (state === 'unavailable') return [t('memory:pipeline.memoryCoreUnavailable')]
  if (state === 'running' || state === 'queued') {
    const running = stageCount(overview, 'l1', 'running') + stageCount(overview, 'l2', 'running') + stageCount(overview, 'l3', 'running')
    const queued = stageCount(overview, 'l1', 'queued') + stageCount(overview, 'l2', 'queued') + stageCount(overview, 'l3', 'queued')
    return state === 'running'
      ? [t('memory:pipeline.refiningSessions', { count: running }), t('memory:pipeline.waitingSessions', { count: queued })]
      : [t('memory:pipeline.waitingToRefineSessions', { count: queued })]
  }
  const lines: string[] = []
  if (delta) lines.push(t('memory:pipeline.newThisRound', { summary: deltaSummary(delta, t) }))
  if (overview?.l1) lines.push(t('memory:pipeline.persistedSummary', { atomic: overview.l1.total, scenes: overview.l2?.total ?? 0 }))
  return lines.length > 0 ? lines : [t('memory:pipeline.upToDate')]
}

export function getPipelineState(overview: MemoryOverviewDto | null, unavailable = false): PipelineState {
  if (unavailable || !overview) return unavailable ? 'unavailable' : 'loading'
  if (!overview.pipeline) return 'unavailable'
  const stages = [overview.pipeline.l1, overview.pipeline.l2, overview.pipeline.l3]
  if (stages.some((stage) => (stage?.running ?? 0) > 0)) return 'running'
  if (stages.some((stage) => (stage?.queued ?? 0) > 0)) return 'queued'
  return 'idle'
}

export const MemoryPipelineStatus = memo(function MemoryPipelineStatus({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void
}) {
  const { t } = useLocale()
  const [overview, setOverview] = useState<MemoryOverviewDto | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [delta, setDelta] = useState<MemoryDelta | null>(null)
  const [particleBurst, setParticleBurst] = useState<{ id: number; count: number } | null>(null)
  const particleBurstIdRef = useRef(0)
  const pipelineRef = useRef<HTMLDivElement>(null)
  const previousRef = useRef<MemorySnapshot | null>(null)
  const clearParticleBurst = useCallback(() => setParticleBurst(null), [])

  useEffect(() => {
    let disposed = false
    let timeout = 0

    const refresh = async () => {
      let nextDelay = 15_000
      try {
        if (!window.nxcore?.memory) throw new Error('memory_api_unavailable')
        const nextOverview = await window.nxcore.memory.overview()
        if (disposed) return
        const nextSnapshot = snapshotOf(nextOverview)
        if (previousRef.current) {
          const nextDelta = deltaBetween(previousRef.current, nextSnapshot)
          if (nextDelta) {
            setVisible(true)
            setDelta(nextDelta)
            if (nextDelta.l1 > 0) {
              setParticleBurst({ id: particleBurstIdRef.current++, count: nextDelta.l1 })
            }
          }
        }
        previousRef.current = nextSnapshot
        setOverview(nextOverview)
        setUnavailable(false)
        const stages = nextOverview.pipeline
          ? [nextOverview.pipeline.l1, nextOverview.pipeline.l2, nextOverview.pipeline.l3]
          : []
        nextDelay = stages.some((stage) => (stage?.running ?? 0) > 0 || (stage?.queued ?? 0) > 0)
          ? 2_500
          : 15_000
      } catch {
        if (!disposed) setUnavailable(true)
        nextDelay = 6_000
      } finally {
        if (!disposed) timeout = window.setTimeout(refresh, nextDelay)
      }
    }

    void refresh()
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [])

  const state: PipelineState = getPipelineState(overview, unavailable)
  const StatusIcon = STATE_ICONS[state]
  const animated = state === 'running' || state === 'queued'
  const label = delta ? deltaSummary(delta, t) : activeLabel(overview, state)

  // 整个状态条：提炼结束后静置 60s（无互动）就整体收起，
  // 等下一轮记忆提炼开始时再出现。
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (state === 'running' || state === 'queued') {
      setVisible(true)
      return
    }
    let hidden = false
    let timer = window.setTimeout(() => {
      hidden = true
      setVisible(false)
    }, 60_000)
    const interact = () => {
      if (hidden) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        hidden = true
        setVisible(false)
      }, 60_000)
    }
    window.addEventListener('pointerdown', interact)
    window.addEventListener('keydown', interact)
    return () => {
      window.removeEventListener('pointerdown', interact)
      window.removeEventListener('keydown', interact)
      window.clearTimeout(timer)
    }
  }, [state])

  const openMemory = () => {
    const target = delta ? DELTA_TABS[primaryDeltaLevel(delta)] : 'overview'
    setDelta(null)
    onNavigate('memory')
    // 层级变化（如画像）默认落在对应 tab，方便直接看到新增内容。
    window.dispatchEvent(new CustomEvent(MEMORY_TAB_EVENT, { detail: { tab: target } }))
  }

  if (!visible) return null

  return (
    <>
      <div
        ref={pipelineRef}
        className="sidebar-memory-pipeline"
        data-state={state}
        data-has-delta={String(Boolean(delta))}
        role="status"
        aria-label={t('memory:pipeline.statusLabel')}
        tabIndex={0}
        onClick={openMemory}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openMemory()
          }
        }}
      >
        <span className="sidebar-memory-pipeline-icon" aria-hidden="true">
          <StatusIcon strokeWidth={1.8} />
        </span>
        <span className="sidebar-memory-pipeline-label">{t('memory:pipeline.memory')}</span>
        {animated || delta ? (
          <span className="sidebar-memory-pipeline-state">{label}</span>
        ) : null}
        {animated ? (
          <ol className="sidebar-memory-pipeline-steps" aria-hidden="true">
            {(['l1', 'l2', 'l3'] as const).map((key) => {
              const running = stageCount(overview, key, 'running')
              const queued = stageCount(overview, key, 'queued')
              return (
                <li
                  key={key}
                  data-state={running > 0 ? 'running' : queued > 0 ? 'queued' : 'idle'}
                />
              )
            })}
          </ol>
        ) : null}
        <div className="sidebar-memory-pipeline-tooltip" role="tooltip">
          {tooltipLines(overview, state, delta, t).map((line) => <p key={line}>{line}</p>)}
          <p className="sidebar-memory-pipeline-tooltip-hint">{t('memory:pipeline.viewMemory')}</p>
        </div>
      </div>
      {particleBurst ? (
        <MemoryParticleBurst
          key={particleBurst.id}
          targetRef={pipelineRef}
          count={particleBurst.count}
          onDone={clearParticleBurst}
        />
      ) : null}
    </>
  )
})
