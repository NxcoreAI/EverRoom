import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { MailPane, SchedulePane, TasksPane } from './ActivityPanes';
import type { WorkspaceObjectPreview } from './index';

type RoomUpdater = (room: ContextRoomRecord) => ContextRoomRecord;

/**
 * 工作 / 待办：日历、邮件、任务三个分区纵向聚合在同一个扫描视图里；
 * 会议/任务/邮件详情仍在本视图内打开（按归属分区承接）。
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
  onOpen: (target: WorkspaceObjectPreview) => void;
  onSelect: (taskId: string) => void;
  onToggle: (taskId: string) => void;
  /** 受控详情态：会议归日历区，邮件归邮件区，任务归任务区。 */
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="context-room-todo-pane">
      <section className="context-room-todo-section" aria-label={t('contextRoom:todoPane.scheduleSection')}>
        <SchedulePane
          room={room}
          onOpen={onOpen}
          detail={detail?.kind === 'meeting' ? detail : null}
          onCloseDetail={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </section>
      <section className="context-room-todo-section" aria-label={t('contextRoom:todoPane.mailSection')}>
        <MailPane
          room={room}
          onOpen={onOpen}
          detail={detail?.kind === 'mail' || detail?.kind === 'connector-mail' ? detail : null}
          onCloseDetail={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </section>
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
    </div>
  );
}
