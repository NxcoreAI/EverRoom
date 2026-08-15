import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Inbox,
  Mic,
  Paperclip,
  Pencil,
  Send,
  Slash,
  Sparkles,
  Star,
  User,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { cn, uiText } from '../adapters';
import type {
  ContextRoomActionItem,
  ContextRoomFileItem,
  ContextRoomMemoryItem,
  ContextRoomMaterial,
  ContextRoomRecord,
} from '../types';
import { ActionConfirmDialog, Panel, Tag } from './shared';

export type DetailObject =
  | { kind: 'file'; value: ContextRoomFileItem }
  | { kind: 'task'; value: ContextRoomActionItem }
  | { kind: 'mail'; value: ContextRoomMaterial }
  | { kind: 'meeting'; value: ContextRoomMaterial }
  | { kind: 'material'; value: ContextRoomMaterial }
  | { kind: 'memory'; value: ContextRoomMemoryItem };

function statusVariant(status: string): 'default' | 'info' | 'ai' | 'warn' | 'success' | 'danger' {
  if (status === '候选' || status === '待确认') return 'warn';
  if (status === '已完成' || status === '已确认' || status === '已归档') return 'success';
  if (status === '已禁用') return 'danger';
  if (status === 'AI 处理过') return 'ai';
  if (status === '进行中') return 'info';
  return 'default';
}

function ObjectTopbar({
  label,
  onBack,
  children,
}: {
  label: string;
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="context-room-object-topbar">
      <button
        type="button"
        aria-label="Back to Context Room detail"
        className="context-room-ghost context-room-object-back"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        <span>{uiText(label)}</span>
      </button>
      <div className="context-room-page-actions">{children}</div>
    </div>
  );
}

type RoomUpdater = (room: ContextRoomRecord) => ContextRoomRecord;

function TaskFact({
  icon: Icon,
  label,
  value,
  wide = false,
}: {
  icon: typeof User;
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={cn('context-room-task-fact', wide && 'context-room-task-fact-wide')}>
      <span className="context-room-task-fact-icon" aria-hidden="true">
        <Icon />
      </span>
      <div>
        <dt>{uiText(label)}</dt>
        <dd>{value}</dd>
      </div>
    </div>
  );
}

function ExternalObjectState({ kind }: { kind: 'file' | 'mail' | 'meeting' }) {
  const values =
    kind === 'file'
      ? ['本地文件夹', 'lu.yuan@everroom.local', '已同步', '可写', '已解析']
      : kind === 'meeting'
        ? ['会议纪要', 'lu.yuan@everroom.local', '已同步', '可写', '已转写']
        : ['Gmail', 'lu.yuan@everroom.local', '已同步', '可写', '已解析'];

  return (
    <section className="context-room-external-state" aria-label={uiText('外部对象状态')}>
      {[
        uiText('来源服务'),
        uiText('账号'),
        uiText('同步状态'),
        uiText('写入权限'),
        uiText('解析状态'),
      ].map((label, index) => (
        <span key={uiText(label)}>
          <small>{uiText(label)}</small>
          <b>{values[index]}</b>
        </span>
      ))}
      <button type="button" className="context-room-link">
        {uiText('打开原对象 ')}
      </button>
    </section>
  );
}

function FileDetail({
  room,
  file,
  onBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  file: ContextRoomFileItem;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const [notice, setNotice] = useState('');
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const updateFile = (patch: Partial<ContextRoomFileItem>) =>
    onUpdateRoom((current) => ({
      ...current,
      fileItems: current.fileItems.map((item) =>
        item.id === file.id ? { ...item, ...patch } : item
      ),
    }));
  return (
    <>
      <ObjectTopbar label={uiText('文件')} onBack={onBack}>
        <Tag>{file.extension}</Tag>
        <Tag variant="success">{uiText('已索引')}</Tag>
        <span className="context-room-object-meta">{file.time}</span>
        <button
          type="button"
          className="context-room-ghost context-room-small"
          onClick={() => setNotice(`已定位来源：${file.source ?? '本地文件夹'}`)}
        >
          打开来源
        </button>
        <button
          type="button"
          className="context-room-secondary context-room-small"
          onClick={onBack}
        >
          查看关联 Room
        </button>
        <button
          type="button"
          className="context-room-primary context-room-small"
          onClick={() => setNotice('已将文件与摘要发送给 Agent')}
        >
          让 Agent 分析
        </button>
      </ObjectTopbar>
      <div className="context-room-object-shell">
        <header className="context-room-object-header">
          <span className="context-room-object-icon" data-icon-tone="document">
            <FileText className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="context-room-page-title">{file.name}</h1>
            <p className="context-room-page-subtitle">
              {file.source ?? room.title} · {file.size ?? file.time}
            </p>
          </div>
        </header>
        <section className="context-room-object-summary">
          <div>
            <span>{uiText('AI 内容摘要')}</span>
            <p>{file.summary}</p>
          </div>
          <span className="context-room-source-health">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {uiText('来源可追溯 ')}
          </span>
        </section>
        <ExternalObjectState kind="file" />
        <Panel title={uiText('内容预览')} className="context-room-preview-panel">
          <div className="context-room-preview-sections">
            {[['01', uiText('资料概览'), file.summary]].map(([index, title, text]) => (
              <section key={index} className="context-room-preview-section">
                <span>{index}</span>
                <div>
                  <h2>{title}</h2>
                  <p>{text}</p>
                </div>
              </section>
            ))}
          </div>
        </Panel>
        {notice ? (
          <div className="context-room-inline-notice" role="status">
            {notice}
          </div>
        ) : null}
        <div className="context-room-object-lifecycle">
          <button
            type="button"
            className="context-room-secondary"
            onClick={() =>
              updateFile({ lifecycle: file.lifecycle === '已归档' ? '活跃' : '已归档' })
            }
          >
            <Archive className="size-4" aria-hidden="true" />
            {file.lifecycle === '已归档' ? '恢复文件' : '归档'}
          </button>
          <button
            type="button"
            className="context-room-ghost"
            onClick={() => setTrashConfirmOpen(true)}
          >
            移至回收站
          </button>
        </div>
      </div>
      <ActionConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title="移至回收站"
        summary={`将“${file.name}”移至回收站。`}
        rows={[
          { label: '所属 Room', value: room.title },
          { label: '文件位置', value: file.source ?? '本地文件夹' },
        ]}
        sources={[{ type: '文件', name: file.name }]}
        risk="文件将从当前 Room 的活跃资料中移除，可在回收站恢复。"
        confirmLabel="移至回收站"
        danger
        onConfirm={() => updateFile({ lifecycle: '回收站' })}
      />
    </>
  );
}

function TaskDetail({
  room,
  task,
  onBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  task: ContextRoomActionItem;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const progress =
    task.completed || task.status === '已完成' ? 100 : task.status === '进行中' ? 45 : 0;
  const progressLabel = `${String(progress)}%`;
  const SourceIcon = task.source?.type === '会议' ? Mic : task.source?.type === '邮件' ? Inbox : Sparkles;
  const sourceType = task.source?.type ?? 'Context Room';
  const sourceName = task.source?.name ?? room.title;

  return (
    <section className="context-room-task-reference" data-testid="context-room-task-reference">
      <header className="context-room-page-header context-room-object-reference-header">
        <div className="context-room-object-reference-titles">
          <button
            type="button"
            aria-label="Back to Context Room detail"
            className="context-room-ghost context-room-small context-room-object-back"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {uiText('返回任务列表 ')}
          </button>
          <h1 className="context-room-page-title">{task.title}</h1>
        </div>
        <div className="context-room-page-actions">
          <button
            type="button"
            className="context-room-secondary"
            onClick={() =>
              onUpdateRoom((current) => ({
                ...current,
                actionItems: current.actionItems.map((item) =>
                  item.id === task.id
                    ? { ...item, owner: item.owner === '待确认' ? '陆远' : item.owner }
                    : item
                ),
              }))
            }
          >
            <Pencil aria-hidden="true" />
            编辑
          </button>
          <button
            type="button"
            className={progress === 100 ? 'context-room-secondary' : 'context-room-primary'}
            onClick={() =>
              onUpdateRoom((current) => ({
                ...current,
                actionItems: current.actionItems.map((item) =>
                  item.id === task.id
                    ? {
                        ...item,
                        completed: progress !== 100,
                        status: progress === 100 ? '进行中' : '已完成',
                      }
                    : item
                ),
              }))
            }
          >
            <CheckCircle2 aria-hidden="true" />
            {progress === 100 ? uiText('重新打开') : uiText('标记完成')}
          </button>
        </div>
      </header>
      <div className="context-room-object-detail-grid">
        <Panel
          title={uiText('执行状态')}
          action={<Tag variant={statusVariant(task.status)}>{task.status}</Tag>}
          className="context-room-task-status-panel"
        >
          <div className="context-room-task-progress-overview">
            <div>
              <span>{uiText('当前进度')}</span>
              <strong>{progressLabel}</strong>
            </div>
            <div className="context-room-progress" aria-label={`任务进度 ${progressLabel}`}>
              <span style={{ width: progressLabel }} />
            </div>
          </div>
          <dl className="context-room-task-facts">
            <TaskFact icon={User} label="负责人" value={task.owner} />
            <TaskFact icon={Clock3} label="截止日期" value={task.deadline} />
            <TaskFact icon={GitBranch} label="关联 Room" value={room.title} wide />
          </dl>
          <div className="context-room-subsection-heading">
            <h2>{uiText('进展记录')}<span>2</span></h2>
          </div>
          <div className="context-room-timeline">
            <div
              className={cn(
                'context-room-timeline-item',
                progress === 100 ? 'context-room-timeline-done' : 'context-room-timeline-info'
              )}
            >
              <div className="context-room-timeline-time">{uiText('当前')}</div>
              <div className="context-room-task-timeline-copy">
                <b>{task.status}</b>
                <span>任务进度已更新至 {progressLabel}</span>
              </div>
            </div>
            <div className="context-room-timeline-item context-room-timeline-done">
              <div className="context-room-timeline-time">{uiText('创建时')}</div>
              <div className="context-room-task-timeline-copy">
                <b>{uiText('任务已建立')}</b>
                <span>来源：{sourceName}</span>
              </div>
            </div>
          </div>
        </Panel>
        <aside>
          <Panel title="来源与上下文" className="context-room-task-context-panel">
            <span className="context-room-task-context-label">原始来源</span>
            <div className="context-room-source-card" data-icon-tone="ai">
              <SourceIcon className="size-4" aria-hidden="true" />
              <div>
                <b>{sourceType}</b>
                <span>{sourceName}</span>
              </div>
            </div>
            <div className="context-room-task-room-context">
              <GitBranch aria-hidden="true" />
              <div>
                <span>关联 Room</span>
                <b>{room.title}</b>
              </div>
            </div>
            <div className="context-room-object-lifecycle">
              <button
                type="button"
                className="context-room-secondary context-room-small"
                onClick={() => task.source?.objectId && onBack()}
              >
                <ExternalLink aria-hidden="true" />
                打开原始来源
              </button>
              <button
                type="button"
                className="context-room-secondary context-room-small"
                onClick={onBack}
              >
                <FolderOpen aria-hidden="true" />
                {uiText('打开 Room ')}
              </button>
            </div>
            <button type="button" className="context-room-primary context-room-agent-action">
              <Sparkles aria-hidden="true" />
              {uiText('让 Agent 协助推进 ')}
            </button>
          </Panel>
        </aside>
      </div>
    </section>
  );
}

function MeetingDetail({
  room,
  meeting,
  onBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  meeting: ContextRoomMaterial;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const [tab, setTab] = useState<'summary' | 'actions' | 'transcript'>('summary');
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const actions = meeting.meetingActions ?? [];
  const confirmAction = (actionId: string) =>
    onUpdateRoom((current) => {
      const action = actions.find((item) => item.id === actionId);
      if (!action) return current;
      return {
        ...current,
        materials: current.materials.map((item) =>
          item.id === meeting.id
            ? {
                ...item,
                meetingActions: item.meetingActions?.map((candidate) =>
                  candidate.id === actionId ? { ...candidate, confirmed: true } : candidate
                ),
              }
            : item
        ),
        actionItems: current.actionItems.some((task) => task.id === actionId)
          ? current.actionItems
          : [
              ...current.actionItems,
              {
                id: actionId,
                title: action.title,
                status: '未开始',
                owner: action.owner,
                deadline: '待排期',
                source: { type: '会议', name: meeting.title, objectId: meeting.id },
              },
            ],
      };
    });
  return (
    <section
      className="context-room-meeting-reference"
      data-testid="context-room-meeting-reference"
    >
      <ObjectTopbar label="会议纪要" onBack={onBack}>
        <Tag variant="success">已转写</Tag>
        <span className="context-room-object-meta">{meeting.time}</span>
      </ObjectTopbar>
      <header className="context-room-meeting-hero">
        <span data-icon-tone="calendar">
          <Mic aria-hidden="true" />
        </span>
        <div>
          <h1>{meeting.title}</h1>
          <p>
            {meeting.attendees?.join('、') || '未记录参与人'} · {meeting.duration ?? '时长未记录'}
          </p>
        </div>
      </header>
      <ExternalObjectState kind="meeting" />
      <div className="context-room-meeting-tabs" role="tablist" aria-label="会议详情">
        {(
          [
            ['summary', 'AI 纪要'],
            ['actions', `行动项 ${String(actions.length)}`],
            ['transcript', '转写原文'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'summary' ? (
        <Panel title="AI 纪要" className="context-room-meeting-panel">
          <p className="context-room-memory-content">{meeting.summary}</p>
          <div className="context-room-meeting-facts">
            <span>
              <small>时间</small>
              <b>{meeting.time}</b>
            </span>
            <span>
              <small>地点</small>
              <b>{meeting.location ?? '线上会议'}</b>
            </span>
            <span>
              <small>所属 Room</small>
              <b>{room.title}</b>
            </span>
          </div>
        </Panel>
      ) : tab === 'actions' ? (
        <section className="context-room-panel context-room-meeting-actions">
          {actions.map((action) => (
            <article key={action.id}>
              <div>
                <b>{action.title}</b>
                <span>负责人 {action.owner}</span>
              </div>
              <button
                type="button"
                className={action.confirmed ? 'context-room-secondary' : 'context-room-primary'}
                disabled={action.confirmed}
                onClick={() => setPendingActionId(action.id)}
              >
                {action.confirmed ? '已加入任务' : '加入任务'}
              </button>
            </article>
          ))}
        </section>
      ) : (
        <section className="context-room-panel context-room-transcript-list">
          {(meeting.transcript ?? []).map((line) => (
            <article key={`${line.time}-${line.speaker}`}>
              <time>{line.time}</time>
              <b>{line.speaker}</b>
              <p>{line.text}</p>
            </article>
          ))}
        </section>
      )}
      <ActionConfirmDialog
        open={Boolean(pendingActionId)}
        onOpenChange={(open) => !open && setPendingActionId(null)}
        title="写入任务"
        summary="将把该会议行动项写入当前 Room 的正式任务列表。"
        rows={[
          {
            label: '行动项',
            value: actions.find((action) => action.id === pendingActionId)?.title ?? '',
          },
          {
            label: '负责人',
            value: actions.find((action) => action.id === pendingActionId)?.owner ?? '待补充',
          },
        ]}
        sources={[{ type: '会议', name: meeting.title }]}
        risk="写入后会进入任务列表与 Room 活动记录。"
        confirmLabel="确认写入"
        onConfirm={() => pendingActionId && confirmAction(pendingActionId)}
      />
    </section>
  );
}

function MailDetail({
  room,
  mail,
  onBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  mail: ContextRoomMaterial;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  type MailFolder = 'inbox' | 'starred' | 'sent' | 'archive';
  const [folder, setFolder] = useState<MailFolder>(mail.folder ?? 'inbox');
  const [selectedMailId, setSelectedMailId] = useState(mail.id);
  const [confirmAction, setConfirmAction] = useState<'send' | 'task' | null>(null);
  const mailItems = useMemo(
    () => [
      {
        id: mail.id,
        folder: mail.folder ?? ('inbox' as const),
        sender: '张总 · 星港科技',
        title: mail.title,
        summary: mail.summary,
        time: mail.time,
        unread: mail.unread ?? true,
        starred: mail.starred ?? false,
      },
      {
        id: `${mail.id}-scope`,
        folder: 'inbox' as const,
        sender: '王敏 · 交付团队',
        title: `Re: ${room.title} 范围确认`,
        summary: '交付范围已补充桌面端安装、权限说明和来源追溯验收项。',
        time: '昨天 16:40',
        unread: false,
        starred: false,
      },
      {
        id: `${mail.id}-sent`,
        folder: 'sent' as const,
        sender: '发送至：项目协作组',
        title: `${room.title} 阶段同步`,
        summary: '已同步当前进度、阻塞项和下一轮评审时间。',
        time: '07-21 10:20',
        unread: false,
        starred: false,
      },
      {
        id: `${mail.id}-archive`,
        folder: 'archive' as const,
        sender: 'Everroom 系统通知',
        title: '历史资料索引完成',
        summary: '归档邮件和附件已完成索引，可在 Context Room 中追溯。',
        time: '07-18 09:12',
        unread: false,
        starred: false,
      },
    ],
    [
      mail.folder,
      mail.id,
      mail.starred,
      mail.summary,
      mail.time,
      mail.title,
      mail.unread,
      room.title,
    ]
  );
  const visibleMails = mailItems.filter((item) =>
    folder === 'starred' ? item.starred : item.folder === folder
  );
  const activeMail = visibleMails.find((item) => item.id === selectedMailId) ?? mailItems[0];
  const folders: Array<{
    icon: typeof Inbox;
    id: MailFolder;
    label: string;
  }> = [
    { id: 'inbox', label: '收件箱', icon: Inbox },
    { id: 'starred', label: '星标', icon: Star },
    { id: 'sent', label: '已发送', icon: Send },
    { id: 'archive', label: '归档', icon: Archive },
  ];
  const updateMail = (patch: Partial<ContextRoomMaterial>) =>
    onUpdateRoom((current) => ({
      ...current,
      materials: current.materials.map((item) =>
        item.id === mail.id ? { ...item, ...patch } : item
      ),
    }));
  const addTaskCandidate = () =>
    onUpdateRoom((current) => ({
      ...current,
      actionItems: current.actionItems.some((item) => item.id === `${mail.id}-task`)
        ? current.actionItems
        : [
            ...current.actionItems,
            {
              id: `${mail.id}-task`,
              title: '补充正式报价函和交付范围',
              status: '未开始',
              owner: '陆远',
              deadline: '07-24',
              source: { type: '邮件', name: mail.title, objectId: mail.id },
            },
          ],
    }));

  return (
    <section className="context-room-mail-reference" data-testid="context-room-mail-reference">
      <button
        type="button"
        aria-label="Back to Context Room detail"
        className="context-room-visually-hidden"
        onClick={onBack}
      >
        {uiText('返回 Room ')}
      </button>
      <header className="context-room-page-header context-room-object-app-header">
        <div>
          <h1 className="context-room-page-title">{uiText('邮件')}</h1>
        </div>
        <div className="context-room-page-actions">
          <button
            type="button"
            className="context-room-secondary"
            onClick={() => updateMail({ unread: false })}
          >
            同步
          </button>
        </div>
      </header>
      <div className="context-room-mail-layout" data-testid="context-room-mail-layout">
        <nav
          className="context-room-side-tabs context-room-mail-folders"
          aria-label={uiText('邮件文件夹')}
        >
          {folders.map(({ id, label, icon: FolderIcon }) => {
            const count = mailItems.filter((item) =>
              id === 'starred' ? item.starred : item.folder === id
            ).length;
            return (
              <button
                key={id}
                type="button"
                className="context-room-side-tab"
                data-icon-tone="communication"
                aria-pressed={folder === id}
                onClick={() => {
                  setFolder(id);
                  const next = mailItems.find((item) =>
                    id === 'starred' ? item.starred : item.folder === id
                  );
                  if (next) setSelectedMailId(next.id);
                }}
              >
                <FolderIcon className="size-4" aria-hidden="true" />
                <span>{uiText(label)}</span>
                <span className="context-room-nav-count">{count}</span>
              </button>
            );
          })}
        </nav>
        <section
          className="context-room-panel context-room-mail-list-pane"
          aria-label={uiText('邮件列表')}
        >
          {visibleMails.length ? (
            visibleMails.map((item) => (
              <button
                key={item.id}
                type="button"
                className="context-room-mail-list-item"
                aria-pressed={activeMail.id === item.id}
                onClick={() => setSelectedMailId(item.id)}
              >
                <span className="context-room-mail-list-meta">
                  <b>{item.sender}</b>
                  {item.unread ? <Tag variant="info">{uiText('未读')}</Tag> : null}
                  <time>{item.time}</time>
                </span>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
              </button>
            ))
          ) : (
            <div className="context-room-empty">{uiText('这里还没有邮件')}</div>
          )}
        </section>
        <section className="context-room-mail-detail">
          <header className="context-room-mail-header">
            <div className="min-w-0">
              <h2 className="context-room-mail-subject">{activeMail.title}</h2>
              <p className="context-room-page-subtitle">
                {activeMail.sender} · demo@everroom.local · {activeMail.time}
              </p>
            </div>
            <div className="context-room-mail-detail-actions">
              <button
                type="button"
                className="context-room-ghost context-room-small"
                aria-label="添加星标"
                onClick={() => updateMail({ starred: !mail.starred })}
              >
                <Star className="size-4" aria-hidden="true" />
                {mail.starred ? '已星标' : '星标'}
              </button>
              <button
                type="button"
                className="context-room-ghost context-room-small"
                onClick={() =>
                  updateMail({ folder: mail.folder === 'archive' ? 'inbox' : 'archive' })
                }
              >
                <Archive className="size-4" aria-hidden="true" />
                {mail.folder === 'archive' ? '移回收件箱' : '归档'}
              </button>
            </div>
          </header>
          <ExternalObjectState kind="mail" />
          <Panel title="AI 摘要" className="context-room-mail-summary">
            <div
              className="flex items-start gap-2 text-sm leading-6 text-zinc-700 text-pretty"
              data-icon-tone="ai"
            >
              <Sparkles className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <p>{activeMail.summary}</p>
            </div>
          </Panel>
          <section className="context-room-mail-body">
            <div className="context-room-object-label">邮件正文</div>
            <p>{mail.body ?? activeMail.summary}</p>
            <div className="context-room-mail-attachment">
              <Paperclip className="size-4" aria-hidden="true" />
              <span>{uiText('关联 Room 资料摘要')}</span>
            </div>
          </section>
          <section className="context-room-mail-derived-section">
            <h3>{uiText('需要回复的问题')}</h3>
            <article className="context-room-mail-suggestion">
              <b>{uiText('请确认最终报价是否包含部署与首月支持？')}</b>
            </article>
          </section>
          <section className="context-room-mail-derived-section">
            <h3>{uiText('任务候选')}</h3>
            <article className="context-room-mail-suggestion context-room-mail-task-candidate">
              <div>
                <b>{uiText('补充正式报价函和交付范围')}</b>
                <span>{uiText('截止 07-24')}</span>
              </div>
              <button
                type="button"
                className="context-room-primary context-room-small"
                onClick={() => setConfirmAction('task')}
              >
                {room.actionItems.some((item) => item.id === `${mail.id}-task`)
                  ? '已加入任务'
                  : '加入任务'}
              </button>
            </article>
          </section>
          <Panel
            title={uiText('回复草案')}
            action={<Tag variant="info">{uiText('待确认')}</Tag>}
            className="context-room-mail-reply"
          >
            <textarea
              aria-label="回复草案"
              value={
                mail.replyDraft ?? `已收到，关于「${room.title}」的补充信息会同步到下一版方案中。`
              }
              onChange={(event) => updateMail({ replyDraft: event.target.value })}
            />
            <div className="context-room-object-lifecycle">
              <button
                type="button"
                className="context-room-primary"
                disabled={mail.sent}
                onClick={() => setConfirmAction('send')}
              >
                {mail.sent ? '已发送' : '确认发送'}
              </button>
              <button
                type="button"
                className="context-room-secondary"
                onClick={() => updateMail({ draftSaved: true })}
              >
                {mail.draftSaved ? '已保存' : '保存草稿'}
              </button>
              <button type="button" className="context-room-ghost" onClick={onBack}>
                {uiText('返回 Room ')}
              </button>
            </div>
          </Panel>
        </section>
      </div>
      <ActionConfirmDialog
        open={confirmAction === 'task'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="加入任务"
        summary="将把邮件中的任务候选加入当前 Room。"
        rows={[
          { label: '任务', value: '补充正式报价函和交付范围' },
          { label: '截止时间', value: '07-24' },
        ]}
        sources={[{ type: '邮件', name: mail.title }]}
        confirmLabel="加入"
        onConfirm={addTaskCandidate}
      />
      <ActionConfirmDialog
        open={confirmAction === 'send'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="发送邮件"
        summary="将向外发送当前回复草案。"
        rows={[
          { label: '收件人', value: '张总 · 星港科技' },
          { label: '主题', value: mail.title },
        ]}
        sources={[{ type: '邮件', name: mail.title }]}
        risk="向外发送邮件属于高风险动作，发送后会进入活动记录。"
        confirmLabel="确认发送"
        onConfirm={() => updateMail({ sent: true, folder: 'sent', unread: false })}
      />
    </section>
  );
}

function MaterialDetail({
  room,
  material,
  onBack,
}: {
  room: ContextRoomRecord;
  material: ContextRoomMaterial;
  onBack: () => void;
}) {
  return (
    <section className="context-room-object-detail">
      <ObjectTopbar label={material.type} onBack={onBack}>
        <Tag>{material.type}</Tag>
        <span className="context-room-object-meta">{material.time}</span>
      </ObjectTopbar>
      <header className="context-room-page-header">
        <div>
          <h1 className="context-room-page-title">{material.title}</h1>
          <p className="context-room-page-subtitle">
            {room.title} · {material.time}
          </p>
        </div>
      </header>
      <div className="context-room-object-content-grid">
        <Panel title="资料摘要">
          <p className="text-sm leading-6 text-zinc-700">{material.summary}</p>
        </Panel>
        <Panel title="Room 上下文">
          <div className="context-room-object-facts">
            <span>
              <small>所属 Room</small>
              <b>{room.title}</b>
            </span>
            <span>
              <small>资料类型</small>
              <b>{material.type}</b>
            </span>
            <span>
              <small>状态</small>
              <b>{material.status ?? '已索引'}</b>
            </span>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function MemoryDetail({
  room,
  memory,
  onBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  memory: ContextRoomMemoryItem;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const [filter, setFilter] = useState(memory.status);
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');
  const [selectedMemoryId, setSelectedMemoryId] = useState(memory.id);
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false);
  const visibleMemories = room.memoryItems.filter((item) =>
    ['待确认', '已确认', '已禁用'].includes(filter) ? item.status === filter : item.type === filter
  );
  const activeMemory = visibleMemories.find((item) => item.id === selectedMemoryId) ?? memory;
  const memoryFilters = [
    { label: '待确认', icon: Clock3 },
    { label: '已确认', icon: CheckCircle2 },
    { label: '已禁用', icon: Slash },
    { label: '人物偏好', icon: User },
    { label: '项目结论', icon: GitBranch },
    { label: '表达偏好', icon: FileText },
  ];

  return (
    <section className="context-room-memory-reference" data-testid="context-room-memory-reference">
      <button
        type="button"
        aria-label="Back to Context Room detail"
        className="context-room-visually-hidden"
        onClick={onBack}
      >
        {uiText('返回 Room ')}
      </button>
      <header className="context-room-page-header context-room-object-app-header">
        <div>
          <h1 className="context-room-page-title">{uiText('记忆')}</h1>
        </div>
        <div className="context-room-segmented" aria-label="记忆视图">
          <button
            type="button"
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            列表
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
          >
            图谱
          </button>
        </div>
      </header>
      {viewMode === 'graph' ? (
        <div className="context-room-memory-detail-graph" data-icon-tone="memory">
          <span>{room.title}</span>
          {room.memoryItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setSelectedMemoryId(item.id);
                setViewMode('list');
              }}
            >
              {item.type}
            </button>
          ))}
        </div>
      ) : (
        <div className="context-room-memory-layout">
          <nav className="context-room-side-tabs context-room-memory-filters" aria-label="记忆筛选">
            {memoryFilters.map(({ label, icon: FilterIcon }, index) => (
              <button
                key={label}
                type="button"
                className="context-room-side-tab"
                data-icon-tone="memory"
                aria-pressed={filter === label}
                onClick={() => {
                  setFilter(label);
                  const next = room.memoryItems.find((item) =>
                    index < 3 ? item.status === label : item.type === label
                  );
                  if (next) setSelectedMemoryId(next.id);
                }}
              >
                <FilterIcon className="size-4" aria-hidden="true" />
                <span>{label}</span>
                {index < 3 ? (
                  <span className="context-room-nav-count">
                    {room.memoryItems.filter((item) => item.status === label).length}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <section className="context-room-panel context-room-memory-list-pane">
            <div className="context-room-panel-head">
              <h2>记忆列表</h2>
            </div>
            <div className="context-room-memory-list">
              {visibleMemories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={activeMemory.id === item.id}
                  onClick={() => setSelectedMemoryId(item.id)}
                >
                  <b>{item.content}</b>
                  <span>
                    {item.type} · {room.title}
                  </span>
                  <Tag variant={statusVariant(item.status)}>{item.status}</Tag>
                </button>
              ))}
            </div>
          </section>
          <Panel
            title={activeMemory.content}
            action={<Tag variant={statusVariant(activeMemory.status)}>{activeMemory.status}</Tag>}
            className="context-room-memory-detail-panel"
          >
            <p className="context-room-memory-content">{activeMemory.content}</p>
            <div className="context-room-object-label context-room-memory-source-label">来源</div>
            <div className="context-room-source-card" data-icon-tone="ai">
              <Sparkles className="size-4" aria-hidden="true" />
              <div>
                <b>{room.recentSource?.name ?? room.title}</b>
                <span>{room.recentSource?.type ?? 'Room'}</span>
              </div>
            </div>
            <div className="context-room-memory-meta">
              <span>类型</span>
              <b>{activeMemory.type}</b>
              <span>作用范围</span>
              <b>{room.title}</b>
            </div>
            <div className="context-room-object-lifecycle">
              {activeMemory.status === '待确认' ? (
                <button
                  type="button"
                  className="context-room-primary"
                  onClick={() =>
                    onUpdateRoom((current) => ({
                      ...current,
                      memoryItems: current.memoryItems.map((item) =>
                        item.id === activeMemory.id ? { ...item, status: '已确认' } : item
                      ),
                    }))
                  }
                >
                  确认记忆
                </button>
              ) : null}
              <button
                type="button"
                className="context-room-secondary"
                onClick={() =>
                  onUpdateRoom((current) => ({
                    ...current,
                    memoryItems: current.memoryItems.map((item) =>
                      item.id === activeMemory.id
                        ? { ...item, content: `${item.content}（已编辑）` }
                        : item
                    ),
                  }))
                }
              >
                编辑
              </button>
              <button
                type="button"
                className="context-room-ghost"
                disabled={activeMemory.status === '已禁用'}
                onClick={() => setDisableConfirmOpen(true)}
              >
                {activeMemory.status === '已禁用' ? '已禁用' : '禁用'}
              </button>
            </div>
          </Panel>
        </div>
      )}
      <ActionConfirmDialog
        open={disableConfirmOpen}
        onOpenChange={setDisableConfirmOpen}
        title="禁用记忆"
        summary="Agent 将不再使用这条记忆参与回答和执行。"
        rows={[
          { label: '记忆类型', value: activeMemory.type },
          { label: '作用范围', value: room.title },
        ]}
        sources={activeMemory.sources ?? []}
        risk="禁用不会删除原始资料，可稍后重新启用或继续编辑。"
        confirmLabel="确认禁用"
        danger
        onConfirm={() =>
          onUpdateRoom((current) => ({
            ...current,
            memoryItems: current.memoryItems.map((item) =>
              item.id === activeMemory.id ? { ...item, status: '已禁用' } : item
            ),
          }))
        }
      />
    </section>
  );
}

export function ObjectDetailView({
  room,
  object,
  onBack,
  onUpdateRoom,
  embedded = false,
}: {
  room: ContextRoomRecord;
  object: DetailObject;
  onBack: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
  embedded?: boolean;
}) {
  const content = (
    <>
        {object.kind === 'file' ? (
          <FileDetail room={room} file={object.value} onBack={onBack} onUpdateRoom={onUpdateRoom} />
        ) : null}
        {object.kind === 'task' ? (
          <TaskDetail room={room} task={object.value} onBack={onBack} onUpdateRoom={onUpdateRoom} />
        ) : null}
        {object.kind === 'mail' ? (
          <MailDetail room={room} mail={object.value} onBack={onBack} onUpdateRoom={onUpdateRoom} />
        ) : null}
        {object.kind === 'meeting' ? (
          <MeetingDetail
            room={room}
            meeting={object.value}
            onBack={onBack}
            onUpdateRoom={onUpdateRoom}
          />
        ) : null}
        {object.kind === 'material' ? (
          <MaterialDetail room={room} material={object.value} onBack={onBack} />
        ) : null}
        {object.kind === 'memory' ? (
          <MemoryDetail
            room={room}
            memory={object.value}
            onBack={onBack}
            onUpdateRoom={onUpdateRoom}
          />
        ) : null}
    </>
  );
  return embedded ? (
    <div className="context-room-page context-room-object-page">{content}</div>
  ) : (
    <div className="context-room-app">
      <main className="context-room-page context-room-object-page">{content}</main>
    </div>
  );
}
