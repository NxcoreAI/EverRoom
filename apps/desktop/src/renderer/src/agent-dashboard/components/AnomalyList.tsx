/** 异常与瓶颈：首屏只有一句话结论，明细默认收起。 */
import { useMemo } from 'react'

import { THRESHOLDS } from '../insight/analyze'
import { formatOffset } from '../insight/format'
import type { Anomaly, TraceInsight } from '../insight/types'
import { Panel } from './Panel'

import './anomaly-list.css'

const KIND_LABEL: Record<Anomaly['kind'], string> = {
  slow: '慢步骤',
  error: '调用失败',
  loop: '重复调用',
  retry: '失败重试',
  context_pressure: '上下文压力',
  compaction: '记忆压缩',
  no_progress: '疑似卡住',
}

interface AnomalyListProps {
  insight: TraceInsight
  selectedStepId: string | null
  onSelectStep: (stepId: string | null) => void
}

export function AnomalyList({ insight, selectedStepId, onSelectStep }: AnomalyListProps) {
  const { anomalies } = insight

  const conclusion = useMemo(() => {
    if (anomalies.length === 0) return '没有失败调用、没有超阈值慢步骤，上下文峰值也在安全区内。'
    const counts = new Map<Anomaly['kind'], number>()
    for (const anomaly of anomalies) counts.set(anomaly.kind, (counts.get(anomaly.kind) ?? 0) + 1)
    const parts = [...counts.entries()].map(([kind, count]) => `${KIND_LABEL[kind]} ${count}`)
    return `${anomalies.length} 条：${parts.join(' · ')}。`
  }, [anomalies])

  return (
    <Panel
      title="异常与瓶颈"
      meta={`${anomalies.length} 条`}
      conclusion={conclusion}
      collapsible={anomalies.length > 0}
      expandLabel="查看明细"
    >
      {anomalies.length === 0 ? (
        <p className="anomaly-criteria">
          判据：单步超过 {THRESHOLDS.slowStepMs / 1000}s 记慢步骤 · 失败调用记异常 · 同名同参达到 {THRESHOLDS.loopRepeatCount} 次记循环 ·
          上下文超过 {THRESHOLDS.contextPressurePercent}% 记压力。
        </p>
      ) : (
        <>
          <ul className="anomaly-list">
            {anomalies.map((anomaly) => (
              <li key={anomaly.id}>
                <button
                  type="button"
                  className="anomaly-item"
                  data-sev={anomaly.severity}
                  data-selected={(selectedStepId !== null && anomaly.stepId === selectedStepId) || undefined}
                  onClick={() => onSelectStep(anomaly.stepId)}
                  disabled={!anomaly.stepId}
                  title={anomaly.stepId ? '打开下钻' : '该异常不对应单个步骤'}
                >
                  <span className="anomaly-kind" data-sev={anomaly.severity}>{KIND_LABEL[anomaly.kind]}</span>
                  <span className="anomaly-title">{anomaly.title}</span>
                  <span className="anomaly-detail">{anomaly.detail}</span>
                  <span className="anomaly-time num">{formatOffset(anomaly.atMs)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="anomaly-criteria">
            判据：单步超过 {THRESHOLDS.slowStepMs / 1000}s 记慢步骤 · 失败调用记异常 · 同名同参达到 {THRESHOLDS.loopRepeatCount} 次记循环 ·
            上下文超过 {THRESHOLDS.contextPressurePercent}% 记压力。
          </p>
        </>
      )}
    </Panel>
  )
}
