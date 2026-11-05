import { useState } from 'react'

import type { PlanItem, PlanStatus } from '@nxcore/agent-contract'

import { PLAN_COLUMNS } from './planDrag'
import { PlanColumn } from './PlanColumn'

export interface PlanBoardProps {
  groups: Record<PlanStatus, PlanItem[]>
  sessionTitles: Map<string, string>
  blockedTitles: Map<string, string[]>
  selectMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onDrop: (dragId: string, column: PlanStatus, index: number) => void
  onCreate: (title: string, status: PlanStatus) => void
  onOpenCard: (id: string) => void
}

/** 四列看板：拖拽状态只在这里（dragId），列与卡片都是纯展示。 */
export function PlanBoard({
  groups,
  sessionTitles,
  blockedTitles,
  selectMode,
  selectedIds,
  onToggleSelect,
  onDrop,
  onCreate,
  onOpenCard,
}: PlanBoardProps) {
  const [dragId, setDragId] = useState<string | null>(null)

  return (
    <div className="wb-plan-board wb-plan-board--tools wb-plan-board--tasks">
      {PLAN_COLUMNS.map((column) => (
        <PlanColumn
          key={column.status}
          status={column.status}
          label={column.label}
          hint={column.hint}
          items={groups[column.status]}
          dragId={dragId}
          sessionTitles={sessionTitles}
          blockedTitles={blockedTitles}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onDragStart={setDragId}
          onDragEnd={() => setDragId(null)}
          onDropAt={(index) => {
            if (!dragId) return
            const moving = dragId
            setDragId(null)
            onDrop(moving, column.status, index)
          }}
          onCreate={(title) => onCreate(title, column.status)}
          onOpenCard={onOpenCard}
        />
      ))}
    </div>
  )
}
