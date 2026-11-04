import { RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import type { JournalActionDto } from '@/shared/sources'

import { Button } from '../ui/primitives'
import { useDailyJournal } from './useDailyJournal'

/**
 * 「今日洞察」卡片（最近页顶部）：当天日记的 headline / summary / 要点 / 动作。
 *
 * 全部文案来自 `window.nxcore.journal.today()`（见 `useDailyJournal`）：
 * 没有桥、网关失败、当天还没生成时各自给一个诚实的空态，**不垫任何 mock 文案**。
 * 动作不自己落地：`onAction` 抛给页面（文件用哪个标签打开、会话开在哪里是页面的事）。
 */

/** 摘要的逐字出现节奏：与 `office-proto/pages/RecentView.tsx` 的 `useTypewriter` 一致。 */
const TYPE_INTERVAL_MS = 24
const TYPE_STEP = 2

function prefersReducedMotion(): boolean {
  // 单测/预览环境可能没有 matchMedia：没有就按「没开减少动效」处理。
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 打字机：`nonce` 变化（换了版本）就从头再打一遍；减少动效偏好下直接全文。 */
function useTypewriter(text: string, nonce: string): string {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setCount(text.length)
      return
    }
    setCount(0)
    const id = window.setInterval(() => {
      setCount((current) => {
        if (current >= text.length) {
          window.clearInterval(id)
          return current
        }
        return Math.min(current + TYPE_STEP, text.length)
      })
    }, TYPE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [text, nonce])

  return text.slice(0, count)
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export interface DailyJournalCardProps {
  /** 动作按钮的回调：`open-file` / `ask-agent` 的落地在页面里。 */
  onAction?: (action: JournalActionDto) => void
}

export function DailyJournalCard({ onAction }: DailyJournalCardProps) {
  const journal = useDailyJournal()
  const titleId = useId()
  const entry = journal.entry
  const summary = entry?.summary ?? ''
  // 版本号进 nonce：网关重写当天后（version+1）摘要重新逐字出现。
  const shown = useTypewriter(summary, entry ? `${entry.id}#${entry.version}` : '')
  const typing = shown.length < summary.length

  // 副标题：条数 + 更新时间。没读到数据时不编数字。
  const subtitle = [
    journal.state === 'ready' || journal.state === 'empty' || journal.state === 'failed'
      ? `基于 ${journal.signalCount} 条记忆`
      : null,
    journal.fetchedAt ? `更新于 ${timeLabel(journal.fetchedAt)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <section className="wb-journal-card" aria-labelledby={titleId}>
      <header className="wb-journal-head">
        <span className="wb-journal-icon" aria-hidden="true"><Sparkles size={14} /></span>
        {/* 用 div 而不是 span 包 h2：h2 是流内容，塞进 span 里是非法嵌套。 */}
        <div className="wb-journal-title">
          <h2 className="wb-journal-name" id={titleId}>今日洞察</h2>
          {subtitle ? <span className="wb-journal-sub">{subtitle}</span> : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="wb-journal-refresh"
          title="重新整理今天的记忆"
          disabled={journal.refreshing}
          onClick={journal.refresh}
          icon={<RefreshCw size={12} className={journal.refreshing ? 'ui-spin' : undefined} aria-hidden="true" />}
        >
          {journal.refreshing ? '整理中' : '刷新'}
        </Button>
      </header>

      {journal.state === 'loading' ? (
        <div className="wb-journal-state">
          <span className="wb-journal-skel" aria-hidden="true" />
          正在整理今天的记忆…
        </div>
      ) : null}

      {journal.state === 'unavailable' ? (
        <div className="wb-journal-state">
          今日洞察暂时读不到（桌面服务未就绪）。
          <Button variant="ghost" size="sm" onClick={journal.reload}>重试</Button>
        </div>
      ) : null}

      {journal.state === 'failed' ? (
        <div className="wb-journal-state">
          {journal.lastError ?? '今天这次整理没成功。'}
          <Button variant="ghost" size="sm" onClick={journal.reload}>重试</Button>
        </div>
      ) : null}

      {journal.state === 'empty' ? (
        <p className="wb-journal-empty">今天还没有新的动静。跟我聊几句，我边听边记。</p>
      ) : null}

      {journal.state === 'ready' && entry ? (
        <>
          <p className="wb-journal-headline">{entry.headline}</p>
          <p className="wb-journal-body">
            {shown}
            {typing ? <span className="wb-journal-caret" aria-hidden="true" /> : null}
          </p>
          {entry.bullets.length > 0 ? (
            <ul className="wb-journal-bullets">
              {entry.bullets.map((bullet, index) => (
                // title 留全文：以后做可追溯来源时，仍需在不解析 sourceIds 的前提下能看全。
                <li key={`${index}:${bullet.text}`} title={bullet.text}>
                  <span className="wb-journal-bullet-dot" aria-hidden="true" />
                  {bullet.text}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.advice && entry.advice.length > 0 ? (
            <ul className="wb-journal-advice" aria-label="下一步建议">
              {entry.advice.map((line, index) => (
                <li key={`${index}:${line}`}>
                  <span className="wb-journal-advice-tag" aria-hidden="true">建议</span>
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {journal.refreshError ? <p className="wb-journal-hint">{journal.refreshError}</p> : null}

      <footer className="wb-journal-foot">
        {entry && entry.actions.length > 0 ? (
          <span className="wb-journal-actions">
            {entry.actions.map((action, index) => (
              <button
                key={`${action.kind}:${action.targetId}:${index}`}
                type="button"
                className="wb-journal-act"
                title={action.label}
                onClick={() => onAction?.(action)}
              >
                {action.label}
              </button>
            ))}
          </span>
        ) : null}
        <span className="wb-journal-sign">—— 小 E · 你的工作台助理</span>
      </footer>
    </section>
  )
}
