import { PANE_ITEMS } from './roomConfig'
import type { RoomPane } from './types'

export function PaneRail({
  activePane,
  onSelect,
}: {
  activePane: RoomPane
  onSelect: (pane: RoomPane) => void
}) {
  return (
    <nav className="cr-pane-rail" aria-label="Context Room 详情">
      {PANE_ITEMS.map(({ id, label, icon: Icon, tone }) => (
        <button
          key={id}
          type="button"
          data-icon-tone={tone}
          aria-label={label}
          title={label}
          aria-pressed={activePane === id}
          onClick={() => onSelect(id)}
        >
          <Icon aria-hidden="true" strokeWidth={1.8} />
        </button>
      ))}
    </nav>
  )
}
