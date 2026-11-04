/**
 * 检索洞察（RAG / 记忆召回）：首屏只放「一句结论 + 4 个指标 + 最近一次检索示例」，
 * 逐次检索与召回片段全部收进「展开明细」（默认收起）。
 *
 * 关键事实：本项目 runtime **不透出相似度**（score 常为 null），也常常没有结构化 chunk，
 * 所以 score 为 null 时显示「相似度未透出」并置灰——绝不用 0 冒充真实值。
 */
import { useState, type ReactNode } from 'react'

import { formatChars, formatMs, truncateText } from '../insight/format'
import { RETRIEVAL_TOOLS } from '../insight/retrieval'
import type { RetrievalRecord } from '../insight/types'
import { Metric, Panel } from './Panel'
import type { PanelProps } from './panelTypes'
import { isFuture } from './panelTypes'

import './rag-panel.css'

/** 明细默认展开几次检索，其余收进「显示全部」。 */
const LIST_ROWS = 8

function hitText(hitCount: number | null): string {
  if (hitCount === null || !Number.isFinite(hitCount)) return '命中数未透出'
  if (hitCount === 0) return '0 条命中'
  return `命中 ${hitCount} 条`
}

/** 相似度：只在真实存在时格式化；null 走「未透出」，不显示 0。 */
function scoreText(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '相似度未透出'
  return score <= 1 ? score.toFixed(3) : score.toFixed(2)
}

function fedMeta(fedToContext: boolean | null): { key: 'yes' | 'no' | 'unknown'; text: string } {
  if (fedToContext === true) return { key: 'yes', text: '已进入上下文' }
  if (fedToContext === false) return { key: 'no', text: '未进入上下文' }
  return { key: 'unknown', text: '注入未知' }
}

interface RetrievalBlockProps {
  record: RetrievalRecord
  future: boolean
  selected: boolean
  onSelectStep: (stepId: string) => void
}

/** 一次检索：块头（工具 · 回合 · 命中 · 延迟 · 是否进上下文）+ 紧凑两行片段。 */
function RetrievalBlock({ record, future, selected, onSelectStep }: RetrievalBlockProps) {
  const fed = fedMeta(record.fedToContext)
  return (
    <article className="rag-item" data-future={future || undefined} data-selected={selected || undefined}>
      <button
        type="button"
        className="rag-item-head"
        onClick={() => onSelectStep(record.toolCallId)}
        title="打开下钻看这次检索的完整返回值"
      >
        <span className="rag-item-tool">{record.toolName}</span>
        <span className="num rag-item-meta">
          R{record.roundIndex} · {hitText(record.hitCount)} · {formatMs(record.latencyMs)}
        </span>
        <span className="rag-fed" data-fed={fed.key}>{fed.text}</span>
      </button>

      {record.chunks.length === 0 ? (
        record.hitCount === 0 ? null : <p className="rag-item-empty">未透出结构化片段</p>
      ) : (
        <ul className="rag-chunks">
          {record.chunks.map((chunk) => (
            <li key={chunk.id}>
              <button
                type="button"
                className="rag-chunk"
                onClick={() => onSelectStep(record.toolCallId)}
                title={chunk.preview || chunk.source}
              >
                <span className="rag-chunk-top">
                  <span className="rag-chunk-source">{chunk.source}</span>
                  <span className="num rag-chunk-chars">{formatChars(chunk.chars)} 字</span>
                  <span
                    className={chunk.score === null ? 'rag-score' : 'num rag-score'}
                    data-absent={chunk.score === null || undefined}
                  >
                    {scoreText(chunk.score)}
                  </span>
                </span>
                <span className="rag-chunk-preview">{truncateText(chunk.preview, 120) || '（无预览文本）'}</span>
              </button>
            </li>
          ))}
          {record.hitCount !== null && record.hitCount > record.chunks.length && (
            <li className="rag-chunks-note">
              仅透出 {record.chunks.length} / {record.hitCount} 条片段
            </li>
          )}
        </ul>
      )}
    </article>
  )
}

export function RagPanel({ insight, cursorMs, selectedStepId, onSelectStep }: PanelProps) {
  const records = insight.retrievals
  const [showAll, setShowAll] = useState(false)

  if (records.length === 0) {
    return (
      <Panel
        title="检索洞察"
        conclusion={<>本 run 没有命中检索类工具（<b>0</b> 次召回）</>}
        collapsible
        expandLabel="识别范围"
      >
        <p className="num rag-tool-names">{[...RETRIEVAL_TOOLS].join(' · ')}</p>
      </Panel>
    )
  }

  const calls = records.length
  const chunkTotal = records.reduce((sum, record) => sum + record.chunks.length, 0)
  const fedCount = records.filter((record) => record.fedToContext === true).length
  const unknownCount = records.filter((record) => record.fedToContext === null).length
  const zeroHits = records.filter((record) => record.hitCount === 0).length
  const scoredCount = records.reduce(
    (sum, record) => sum + record.chunks.filter((chunk) => chunk.score !== null).length,
    0,
  )
  const latencySum = records.reduce(
    (sum, record) => sum + (Number.isFinite(record.latencyMs) ? record.latencyMs : 0),
    0,
  )
  const avgLatency = latencySum / calls

  let latest: RetrievalRecord = records[0]
  for (const record of records) {
    if (record.atMs > latest.atMs) latest = record
  }

  /** 「是否进了上下文」这半句：先看有没有片段，再区分全注入 / 部分 / 无法判定。 */
  const injectionClause: ReactNode =
    chunkTotal === 0 ? (
      <>，没有召回任何结构化片段</>
    ) : fedCount === calls ? (
      <>，全部进入下一轮上下文</>
    ) : fedCount === 0 && unknownCount === 0 ? (
      <>，都没有进入下一轮上下文</>
    ) : fedCount === 0 ? (
      <>，是否进入上下文无法判定</>
    ) : (
      <>
        ，其中 <b>{fedCount}</b> 次进入下一轮上下文
        {unknownCount > 0 && <>，{unknownCount} 次无法判定</>}
      </>
    )

  const conclusion = (
    <>
      <b>{calls}</b> 次检索共召回 <b>{chunkTotal}</b> 个片段
      {injectionClause}
      {scoredCount === 0 ? <>；runtime 不透出相似度得分</> : <>；<b>{scoredCount}</b> 条带相似度</>}
    </>
  )

  const detailConclusion = (
    <>
      <b>{calls}</b> 次检索里 <b>{zeroHits}</b> 次 0 命中、<b>{unknownCount}</b> 次注入状态未知；展开看每次的召回片段
    </>
  )

  const shown = showAll ? records : records.slice(0, LIST_ROWS)

  return (
    <>
      <Panel title="检索洞察" conclusion={conclusion} meta={`${calls} 次 · ${chunkTotal} 个片段`}>
        <div className="rag-hero">
          <div className="rag-stats">
            <Metric label="检索次数" value={calls} />
            <Metric label="召回片段数" value={chunkTotal} />
            <Metric label="平均延迟" value={formatMs(avgLatency)} />
            <Metric
              label="已注入次数"
              value={fedCount}
              tone={fedCount > 0 ? 'ok' : undefined}
              hint={unknownCount > 0 ? `${unknownCount} 次未判定` : undefined}
            />
          </div>
          <div className="rag-latest">
            <span className="rag-latest-label">最近一次</span>
            <span className="num rag-latest-query" title={latest.query || undefined}>
              {latest.query || '（未透出检索式）'}
            </span>
            <span className="num rag-latest-meta">
              {hitText(latest.hitCount)} · {formatMs(latest.latencyMs)}
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="逐次检索" conclusion={detailConclusion} collapsible expandLabel="展开明细">
        <div className="rag-items">
          {shown.map((record) => (
            <RetrievalBlock
              key={`${record.toolCallId}:${record.atMs}`}
              record={record}
              future={isFuture(record.atMs, cursorMs)}
              selected={selectedStepId === record.toolCallId}
              onSelectStep={onSelectStep}
            />
          ))}
        </div>
        {records.length > LIST_ROWS && !showAll && (
          <button type="button" className="rag-more" onClick={() => setShowAll(true)}>
            显示全部 {records.length}
          </button>
        )}
      </Panel>
    </>
  )
}
