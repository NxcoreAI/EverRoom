/**
 * 下钻探针：点任意一步，在这里看它的原始数据。
 * 结构固定三段：这段是什么（摘要）→ 关键数据（入参/出参 或 输出/思考）→ 原始事件（折叠）。
 */
import { useCallback, useMemo, useState } from 'react'

import type { AgentDebugEvent } from '@nxcore/agent-contract'

import { formatMs, formatOffset, formatPercent, formatTokens } from '../insight/format'
import { formatCost } from '../insight/pricing'
import { errorClassLabel } from '../insight/toolErrors'
import type { LlmRound, ToolCall, TraceInsight } from '../insight/types'
import { JsonBlock } from './JsonBlock'

import './drill-down.css'

const SEGMENT_LABEL: Record<string, string> = {
  systemPrompt: '系统提示',
  tools: '工具定义',
  user: '用户输入',
  assistant: '助手输出',
  toolResults: '工具结果',
  other: '其它',
}

type Target =
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'round'; round: LlmRound }
  | null

function resolveTarget(insight: TraceInsight, stepId: string | null): Target {
  if (!stepId) return null
  if (stepId.startsWith('llm:')) {
    const index = Number(stepId.split(':')[1])
    const round = insight.rounds.find((item) => item.index === index)
    return round ? { kind: 'round', round } : null
  }
  const tool = insight.tools.find((item) => item.id === stepId)
  return tool ? { kind: 'tool', tool } : null
}

interface DrillDownDrawerProps {
  insight: TraceInsight
  stepId: string | null
  onClose: () => void
  onSelectStep: (stepId: string | null) => void
  currency: 'USD' | 'CNY'
}

export function DrillDownDrawer({ insight, stepId, onClose, onSelectStep, currency }: DrillDownDrawerProps) {
  const target = useMemo(() => resolveTarget(insight, stepId), [insight, stepId])
  const [rawOpen, setRawOpen] = useState(false)

  const rawEvents = useMemo((): AgentDebugEvent[] => {
    if (!target) return []
    const seqs = new Set(target.kind === 'tool' ? target.tool.eventSeqs : target.round.eventSeqs)
    return insight.events.filter((event) => seqs.has(event.seq))
  }, [target, insight.events])

  const copy = useCallback((value: unknown) => {
    let text: string
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
    void navigator.clipboard?.writeText(text)
  }, [])

  if (!stepId) return null

  const heading = target === null
    ? '步骤已不在缓冲中'
    : target.kind === 'tool'
      ? target.tool.name
      : `R${target.round.index} · 模型回合`

  return (
    <>
      <div className="drill-backdrop" onClick={onClose} role="presentation" />
      <aside className="drill" aria-label="步骤下钻">
        <header className="drill-head">
          <div className="drill-title-wrap">
            <span className="drill-kind">{target?.kind === 'tool' ? '工具调用' : '模型回合'}</span>
            <span className="drill-title">{heading}</span>
          </div>
          <button type="button" className="drill-close" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        <div className="drill-body">
          {target === null && (
            <p className="drill-note">该步骤的事件可能已被环形缓冲淘汰，或属于另一条 run。</p>
          )}

          {target?.kind === 'tool' && (
            <>
              <div className="drill-summary">
                <div><span>状态</span><b data-tone={target.tool.severity}>{statusText(target.tool)}</b></div>
                <div><span>耗时</span><b className="num">{formatMs(target.tool.durationMs)}</b></div>
                <div><span>回合</span><b className="num">R{target.tool.roundIndex}</b></div>
                <div><span>并发</span><b className="num">第 {target.tool.lane + 1} 路</b></div>
                <div><span>开始</span><b className="num">{formatOffset(target.tool.startMs)}</b></div>
                <div><span>进度</span><b className="num">{target.tool.updates} 次</b></div>
              </div>

              {target.tool.errorClass && (
                <section className="drill-section drill-error">
                  <h3 className="drill-section-title">
                    失败 · {errorClassLabel(target.tool.errorClass)}
                    <button type="button" className="drill-copy" onClick={() => copy(target.tool.error ?? '')}>复制</button>
                  </h3>
                  <pre className="drill-error-text">{target.tool.error ?? '工具未返回错误文本'}</pre>
                </section>
              )}

              <section className="drill-section">
                <h3 className="drill-section-title">
                  入参
                  <button type="button" className="drill-copy" onClick={() => copy(target.tool.args)}>复制 JSON</button>
                </h3>
                <JsonBlock value={target.tool.args} emptyText="（无入参）" maxHeight={200} />
              </section>

              <section className="drill-section">
                <h3 className="drill-section-title">
                  返回值
                  <button type="button" className="drill-copy" onClick={() => copy(target.tool.result)}>复制 JSON</button>
                </h3>
                <JsonBlock value={target.tool.result} emptyText="（尚未返回）" maxHeight={280} />
              </section>
            </>
          )}

          {target?.kind === 'round' && (
            <>
              <div className="drill-summary">
                <div><span>回合时长</span><b className="num">{formatMs(target.round.latencyMs)}</b></div>
                <div><span>TTFT</span><b className="num">{target.round.ttftMs === null ? '不可测' : formatMs(target.round.ttftMs)}</b></div>
                <div><span>生成跨度</span><b className="num">{formatMs(target.round.generationMs)}</b></div>
                <div><span>模型往返</span><b className="num">{formatMs(target.round.modelWaitMs)}</b></div>
                <div><span>上下文</span><b className="num">{formatTokens(target.round.contextTokens)} · {formatPercent(target.round.contextPercent)}</b></div>
                <div><span>成本</span><b className="num" data-tone="cost">{formatCost(target.round.costUsd, currency)}</b></div>
              </div>

              <section className="drill-section">
                <h3 className="drill-section-title">
                  模型输出
                  <button type="button" className="drill-copy" onClick={() => copy(target.round.outputText)}>复制</button>
                </h3>
                <pre className="drill-text">{target.round.outputText || '（本回合没有可见输出 delta）'}</pre>
              </section>

              <section className="drill-section">
                <h3 className="drill-section-title">
                  思考过程
                  <button type="button" className="drill-copy" onClick={() => copy(target.round.reasoningText)}>复制</button>
                </h3>
                <pre className="drill-text">{target.round.reasoningText || '（该 runtime 未透出 reasoning）'}</pre>
              </section>

              {target.round.contextSegments && (
                <section className="drill-section">
                  <h3 className="drill-section-title">上下文构成</h3>
                  <ul className="drill-segments">
                    {target.round.contextSegments.map((segment) => (
                      <li key={segment.key}>
                        <span>{SEGMENT_LABEL[segment.key] ?? segment.key}</span>
                        <b className="num">{formatTokens(segment.tokens)}</b>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {target.round.tools.length > 0 && (
                <section className="drill-section">
                  <h3 className="drill-section-title">本回合的工具调用</h3>
                  <div className="drill-tool-list">
                    {insight.tools
                      .filter((tool) => tool.roundIndex === target.round.index)
                      .map((tool) => (
                        <button
                          key={tool.id}
                          type="button"
                          className="drill-tool-chip"
                          data-sev={tool.severity}
                          onClick={() => onSelectStep(tool.id)}
                        >
                          {tool.name} · {formatMs(tool.durationMs)}
                        </button>
                      ))}
                  </div>
                </section>
              )}
            </>
          )}

          {rawEvents.length > 0 && (
            <section className="drill-section">
              <button type="button" className="drill-raw-toggle" onClick={() => setRawOpen((open) => !open)} aria-expanded={rawOpen}>
                {rawOpen ? '收起原始事件' : `查看原始事件（${rawEvents.length} 条）`}
              </button>
              {rawOpen && (
                <ul className="drill-raw-list">
                  {rawEvents.slice(0, 40).map((event) => (
                    <li key={event.seq}>
                      <div className="drill-raw-head">
                        <span className="num">#{event.seq}</span>
                        <span>{event.type}</span>
                        <span className="num drill-raw-time">{formatOffset(Date.parse(event.occurredAt) - insight.startWallMs)}</span>
                      </div>
                      <JsonBlock value={event.payload} maxHeight={140} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </aside>
    </>
  )
}

function statusText(tool: ToolCall): string {
  if (tool.status === 'ok') return '成功'
  if (tool.status === 'timeout') return '超时'
  if (tool.status === 'failed') return '失败'
  if (tool.status === 'cancelled') return '已取消'
  if (tool.status === 'running') return '进行中'
  return '未知'
}
