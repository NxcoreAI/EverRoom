import { Plus } from 'lucide-react'

import type { AgentSession } from '@nxcore/agent-contract'

import {
  type WorkSessionStatus,
  relativeTimeLabel,
  sessionDisplayTitle,
  workSessionStatus,
  WORK_SESSION_STATUS_META,
} from '../types'
import { Button, PageHeader } from '../ui/primitives'
import type { WorkspacePageProps } from './contracts'
import './tools.css'

/** 看板三列（与 session.status 的映射：closed/interrupted → 已结束）。 */
export const PLAN_COLUMNS: readonly WorkSessionStatus[] = ['running', 'idle', 'done']

/**
 * 把本空间会话按看板状态分列。
 *
 * 只做归类，不改顺序：WorkspaceTabHost 注入的 sessions 已按「运行中优先 + 更新时间倒序」
 * 排过，列内沿用该顺序，避免看板与侧栏工作列表的顺序打架。
 */
export function groupPlanColumns(sessions: readonly AgentSession[]): Record<WorkSessionStatus, AgentSession[]> {
  const groups: Record<WorkSessionStatus, AgentSession[]> = { running: [], idle: [], done: [] }
  for (const session of sessions) groups[workSessionStatus(session)].push(session)
  return groups
}

/**
 * 工作空间「计划」看板。
 *
 * 只读视图：状态来自 `AgentSession.status`，由网关 run 驱动；渲染层不提供拖拽改状态，
 * 以免做出后端并不存在的写操作。点卡片跳到对应工作会话继续对话。
 */
export function PlanPage({ sessions, onOpenSession, onNewWork }: WorkspacePageProps) {
  const groups = groupPlanColumns(sessions)

  return (
    <div className="wb-wspage wb-tools-page wb-plan-page">
      <PageHeader
        title="计划"
        actions={(
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={onNewWork}>
            新建工作
          </Button>
        )}
      />

      <div className="wb-plan-board wb-plan-board--tools">
        {PLAN_COLUMNS.map((key) => {
          const items = groups[key]
          return (
            <section key={key} className={`wb-plan-col wb-plan-col--${key}`}>
              <header className="wb-plan-col-head">
                <span className={`wb-status-dot is-${key}`} aria-hidden="true" />
                <strong>{WORK_SESSION_STATUS_META[key].label}</strong>
                <span className="wb-plan-col-count">{items.length}</span>
              </header>
              <div className="wb-plan-col-body">
                {items.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="wb-plan-card"
                    onClick={() => onOpenSession(session.id)}
                  >
                    <span className="wb-plan-card-title">{sessionDisplayTitle(session)}</span>
                    <span className="wb-plan-card-time">{relativeTimeLabel(session.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
