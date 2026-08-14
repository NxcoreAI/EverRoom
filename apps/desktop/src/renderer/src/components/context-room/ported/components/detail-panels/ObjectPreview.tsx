import { CheckSquare2, ChevronRight, Mail, Mic } from 'lucide-react';

import type { ContextRoomRecord } from '../../types';
import { roomKindIcon, roomKindTone } from '../utils';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

export type WorkspaceObjectPreview =
  | { kind: 'task'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'related-room'; id: string };

export function ObjectPreview({
  room,
  rooms,
  selection,
  onOpenRoom,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  selection: WorkspaceObjectPreview;
  onOpenRoom: (roomId: string) => void;
}) {
  if (selection.kind === 'related-room') {
    const relatedRoom = rooms.find((item) => item.id === selection.id);
    if (!relatedRoom) return <EmptyState>关联 Room 不存在</EmptyState>;
    const people = new Set(room.people.map((person) => person.name));
    const sharedPeople = relatedRoom.people.filter((person) => people.has(person.name));
    const Icon = roomKindIcon(relatedRoom.kind);
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone={roomKindTone(relatedRoom.kind)}>
          <Icon aria-hidden="true" />
          <div>
            <span>关联 Room</span>
            <h1>{relatedRoom.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>关系依据</dt>
            <dd>
              {sharedPeople.length
                ? `共同人物：${sharedPeople.map((person) => person.name).join('、')}`
                : `同为${room.kind} Room`}
            </dd>
          </div>
          <div>
            <dt>当前状态</dt>
            <dd>{relatedRoom.status}</dd>
          </div>
          <div>
            <dt>资料范围</dt>
            <dd>{relatedRoom.materials.length + relatedRoom.fileItems.length} 项</dd>
          </div>
        </dl>
        <button
          type="button"
          className="context-room-primary context-room-object-preview-action"
          onClick={() => onOpenRoom(relatedRoom.id)}
        >
          打开 Room
          <ChevronRight aria-hidden="true" />
        </button>
      </article>
    );
  }

  if (selection.kind === 'task') {
    const task = room.actionItems.find((item) => item.id === selection.id);
    if (!task) return <EmptyState>任务不存在或不属于当前 Room</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header>
          <CheckSquare2 aria-hidden="true" />
          <div>
            <span>任务详情</span>
            <h1>{task.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>执行状态</dt>
            <dd>{task.status}</dd>
          </div>
          <div>
            <dt>负责人</dt>
            <dd>{task.owner}</dd>
          </div>
          <div>
            <dt>截止时间</dt>
            <dd>{task.deadline}</dd>
          </div>
        </dl>
      </article>
    );
  }

  if (selection.kind === 'meeting') {
    const meeting = room.materials.find((item) => item.id === selection.id && item.type === '会议');
    if (!meeting) return <EmptyState>会议不存在或不属于当前 Room</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone="calendar">
          <Mic aria-hidden="true" />
          <div>
            <span>会议详情</span>
            <h1>{meeting.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>时间</dt>
            <dd>{meeting.time}</dd>
          </div>
          <div>
            <dt>参与人</dt>
            <dd>{meeting.attendees?.join('、') || '未记录'}</dd>
          </div>
          <div>
            <dt>会议纪要</dt>
            <dd>{meeting.summary}</dd>
          </div>
        </dl>
      </article>
    );
  }

  const mail = room.materials.find((item) => item.id === selection.id && item.type === '邮件');
  if (!mail) return <EmptyState>邮件不存在或不属于当前 Room</EmptyState>;
  return (
    <article className="context-room-object-preview" data-testid="context-room-object-preview">
      <header>
        <Mail aria-hidden="true" />
        <div>
          <span>邮件预览</span>
          <h1>{mail.title}</h1>
        </div>
      </header>
      <dl>
        <div>
          <dt>更新时间</dt>
          <dd>{mail.time}</dd>
        </div>
        <div>
          <dt>邮件正文</dt>
          <dd>{mail.summary}</dd>
        </div>
      </dl>
    </article>
  );
}
