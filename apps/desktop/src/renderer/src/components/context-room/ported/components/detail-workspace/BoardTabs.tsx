import { useLocale } from '../../../../../i18n/LocaleContext';

import {
  BOARD_SUBTABS,
  type BoardId,
  type BoardSubtab,
} from '../RoomIconSidebar';

export function BoardTabs({
  board,
  activeSubtab,
  onSelectSubtab,
}: {
  board: BoardId;
  activeSubtab: BoardSubtab | null;
  onSelectSubtab: (subtab: BoardSubtab) => void;
}) {
  const { t } = useLocale();
  const subtabs = BOARD_SUBTABS[board];
  if (subtabs.length <= 1) return null;
  return (
    <div className="context-room-board-tabs" role="tablist" data-board-id={board}>
      {subtabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeSubtab === id}
          className={activeSubtab === id ? 'is-active' : ''}
          onClick={() => onSelectSubtab(id)}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}
