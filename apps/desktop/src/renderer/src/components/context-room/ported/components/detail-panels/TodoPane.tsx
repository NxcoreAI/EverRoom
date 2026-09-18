import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { SchedulePane, TasksPane } from './ActivityPanes';
import type { WorkspaceObjectPreview } from './index';

type RoomUpdater = (room: ContextRoomRecord) => ContextRoomRecord;

/**
 * 工作 / 待办（PRD L3.2.3 + L3.2.4）：日程与会议（时间视图）和任务聚合在同一个
 * 扫描视图里，从邮件/会议提取的行动项随任务列表展示；会议/任务详情仍在本视图内打开。
 */
export function TodoPane({
  room,
  onOpen,
  onSelect,
  onToggle,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onOpen: (target: { kind: 'meeting' | 'task'; id: string }) => void;
  onSelect: (taskId: string) => void;
  onToggle: (taskId: string) => void;
  /** 受控详情态：会议详情归日程区，任务详情归任务区。 */
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="context-room-todo-pane">
      <section className="context-room-todo-section" aria-label={t('contextRoom:todoPane.tasksSection')}>
        <TasksPane
          room={room}
          onSelect={onSelect}
          onToggle={onToggle}
          detail={detail?.kind === 'task' ? detail : null}
          onCloseDetail={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </section>
      <section className="context-room-todo-section" aria-label={t('contextRoom:todoPane.scheduleSection')}>
        <SchedulePane
          room={room}
          onOpen={onOpen}
          detail={detail?.kind === 'meeting' ? detail : null}
          onCloseDetail={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </section>
    </div>
  );
}
