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
  // 外层行不带 tablist 角色：伴随思路的动作行（portal）会挂在页签右侧，不能进 tablist 树。
  return (
    <div className="context-room-board-tabs" data-board-id={board}>
      <div className="context-room-board-tabs-list" role="tablist">
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
    </div>
  );
}
