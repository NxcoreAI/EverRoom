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
import { useLocale } from '../../../../i18n/LocaleContext';

import { cn, localizedUiText, uiText } from '../adapters';
import { dispatchRoomMemoryChanged } from '../../roomMemoryChange';
import { disableRoomMemoryItem, enableRoomMemoryItem } from '../roomMemoryItemActions';
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
  const { t } = useLocale();
  return (
    <div className="context-room-object-topbar">
      <button
        type="button"
        aria-label={t('contextRoom:objectDetail.backToContextRoomDetails')}
        className="context-room-ghost context-room-object-back"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        <span>{t(uiText(label))}</span>
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
  const { t } = useLocale();
  return (
    <div className={cn('context-room-task-fact', wide && 'context-room-task-fact-wide')}>
      <span className="context-room-task-fact-icon" aria-hidden="true">
        <Icon />
      </span>
      <div>
        <dt>{t(uiText(label))}</dt>
        <dd>{value}</dd>
      </div>
    </div>
  );
}

function ExternalObjectState({ kind }: { kind: 'file' | 'mail' | 'meeting' }) {
  const { t } = useLocale();
  const values =
    kind === 'file'
      ? ['本地文件夹', 'lu.yuan@everroom.local', '已同步', '可写', '已解析']
      : kind === 'meeting'
        ? ['会议纪要', 'lu.yuan@everroom.local', '已同步', '可写', '已转写']
        : ['Gmail', 'lu.yuan@everroom.local', '已同步', '可写', '已解析'];

  return (
    <section className="context-room-external-state" aria-label={t('contextRoom:objectDetail.externalObjectStatus')}>
      {[
        '来源服务',
        '账号',
        '同步状态',
        '写入权限',
        '解析状态',
      ].map((label, index) => (
        <span key={label}>
          <small>{t(uiText(label))}</small>
          <b>{t(uiText(values[index] ?? ''))}</b>
        </span>
      ))}
      <button type="button" className="context-room-link">
        {t('contextRoom:objectDetail.openOriginal')}
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
  const { t } = useLocale();
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
      <ObjectTopbar label="contextRoom:objectDetail.files" onBack={onBack}>
        <Tag>{file.extension}</Tag>
        <Tag variant="success">{t('contextRoom:objectDetail.indexed')}</Tag>
        <span className="context-room-object-meta">{file.time}</span>
        <button
          type="button"
          className="context-room-ghost context-room-small"
          onClick={() => setNotice(t('contextRoom:objectDetail.locatedSourceSource', { source: file.source ?? t('contextRoom:objectDetail.localFolder') }))}
        >
          {t('contextRoom:objectDetail.openSource')}
        </button>
        <button
          type="button"
          className="context-room-secondary context-room-small"
          onClick={onBack}
        >
          {t('contextRoom:objectDetail.viewRelatedRoom')}
        </button>
        <button
          type="button"
          className="context-room-primary context-room-small"
          onClick={() => setNotice(t('contextRoom:objectDetail.sentTheFileAndSummaryToAgent'))}
        >
          {t('contextRoom:objectDetail.askAgentToAnalyze')}
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
            <span>{t('contextRoom:objectDetail.aiSummary')}</span>
            <p>{file.summary}</p>
          </div>
          <span className="context-room-source-health">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {t('contextRoom:objectDetail.traceableSource')}
          </span>
        </section>
        <ExternalObjectState kind="file" />
        <Panel title={t('contextRoom:objectDetail.contentPreview')} className="context-room-preview-panel">
          <div className="context-room-preview-sections">
            {[['01', t('contextRoom:objectDetail.resourceOverview'), file.summary]].map(([index, title, text]) => (
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
            {t(file.lifecycle === '已归档' ? 'contextRoom:objectDetail.restoreFile' : 'contextRoom:objectDetail.archive')}
          </button>
          <button
            type="button"
            className="context-room-ghost"
            onClick={() => setTrashConfirmOpen(true)}
          >
            {t('contextRoom:objectDetail.moveToTrash')}
          </button>
        </div>
      </div>
      <ActionConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title={t('contextRoom:objectDetail.moveToTrash')}
        summary={t('contextRoom:objectDetail.moveNameToTrash', { name: file.name })}
        rows={[
          { label: t('contextRoom:objectDetail.room'), value: room.title },
          { label: t('contextRoom:objectDetail.fileLocation'), value: file.source ?? t('contextRoom:objectDetail.localFolder') },
        ]}
        sources={[{ type: t('contextRoom:objectDetail.files'), name: file.name }]}
        risk={t('contextRoom:objectDetail.theFileWillBeRemovedFromActiveRoom')}
        confirmLabel={t('contextRoom:objectDetail.moveToTrash')}
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
  const { t } = useLocale();
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
            aria-label={t('contextRoom:objectDetail.backToContextRoomDetails')}
            className="context-room-ghost context-room-small context-room-object-back"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t('contextRoom:objectDetail.backToTasks')}
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
            {t('contextRoom:objectDetail.edit')}
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
            {t(progress === 100 ? 'contextRoom:objectDetail.reopen' : 'contextRoom:objectDetail.markComplete')}
          </button>
        </div>
      </header>
      <div className="context-room-object-detail-grid">
        <Panel
          title={t('contextRoom:objectDetail.status')}
          action={<Tag variant={statusVariant(uiText(task.status))}>{t(uiText(task.status))}</Tag>}
          className="context-room-task-status-panel"
        >
          <div className="context-room-task-progress-overview">
            <div>
              <span>{t('contextRoom:objectDetail.currentProgress')}</span>
              <strong>{progressLabel}</strong>
            </div>
            <div className="context-room-progress" aria-label={t('contextRoom:objectDetail.taskProgressProgress', { progress: progressLabel })}>
              <span style={{ width: progressLabel }} />
            </div>
          </div>
          <dl className="context-room-task-facts">
            <TaskFact icon={User} label="contextRoom:objectDetail.owner" value={t(uiText(task.owner))} />
            <TaskFact icon={Clock3} label="contextRoom:objectDetail.dueDate" value={t(uiText(task.deadline))} />
            <TaskFact icon={GitBranch} label="contextRoom:objectDetail.relatedRoom" value={room.title} wide />
          </dl>
          <div className="context-room-subsection-heading">
            <h2>{t('contextRoom:objectDetail.progressHistory')}<span>2</span></h2>
          </div>
          <div className="context-room-timeline">
            <div
              className={cn(
                'context-room-timeline-item',
                progress === 100 ? 'context-room-timeline-done' : 'context-room-timeline-info'
              )}
            >
              <div className="context-room-timeline-time">{t('contextRoom:objectDetail.current')}</div>
              <div className="context-room-task-timeline-copy">
                <b>{t(uiText(task.status))}</b>
                <span>{t('contextRoom:objectDetail.taskProgressUpdatedToProgress', { progress: progressLabel })}</span>
              </div>
            </div>
            <div className="context-room-timeline-item context-room-timeline-done">
              <div className="context-room-timeline-time">{t('contextRoom:objectDetail.created')}</div>
              <div className="context-room-task-timeline-copy">
                <b>{t('contextRoom:objectDetail.taskCreated')}</b>
                <span>{t('contextRoom:objectDetail.sourceSource', { source: sourceName })}</span>
              </div>
            </div>
          </div>
        </Panel>
        <aside>
          <Panel title={t('contextRoom:objectDetail.sourceAndContext')} className="context-room-task-context-panel">
            <span className="context-room-task-context-label">{t('contextRoom:objectDetail.originalSource')}</span>
            <div className="context-room-source-card" data-icon-tone="ai">
              <SourceIcon className="size-4" aria-hidden="true" />
              <div>
                <b>{t(uiText(sourceType))}</b>
                <span>{sourceName}</span>
              </div>
            </div>
            <div className="context-room-task-room-context">
              <GitBranch aria-hidden="true" />
              <div>
                <span>{t('contextRoom:objectDetail.relatedRoom')}</span>
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
                {t('contextRoom:objectDetail.openOriginalSource')}
              </button>
              <button
                type="button"
                className="context-room-secondary context-room-small"
                onClick={onBack}
              >
                <FolderOpen aria-hidden="true" />
                {t('contextRoom:objectDetail.openRoom')}
              </button>
            </div>
            <button type="button" className="context-room-primary context-room-agent-action">
              <Sparkles aria-hidden="true" />
              {t('contextRoom:objectDetail.askAgentToHelp')}
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
  const { locale, t } = useLocale();
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
      <ObjectTopbar label="contextRoom:objectDetail.meetingNotes" onBack={onBack}>
        <Tag variant="success">{t('contextRoom:objectDetail.transcribed')}</Tag>
        <span className="context-room-object-meta">{meeting.time}</span>
      </ObjectTopbar>
      <header className="context-room-meeting-hero">
        <span data-icon-tone="calendar">
          <Mic aria-hidden="true" />
        </span>
        <div>
          <h1>{meeting.title}</h1>
          <p>
            {meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') || t('contextRoom:objectDetail.noAttendeesRecorded')} · {meeting.duration ?? t('contextRoom:objectDetail.durationNotRecorded')}
          </p>
        </div>
      </header>
      <ExternalObjectState kind="meeting" />
      <div className="context-room-meeting-tabs" role="tablist" aria-label={t('contextRoom:objectDetail.meetingDetails')}>
        {(
          [
            ['summary', t('contextRoom:objectDetail.aiMeetingNotes')],
            ['actions', t('contextRoom:objectDetail.countActionItems', { count: actions.length })],
            ['transcript', t('contextRoom:objectDetail.transcript')],
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
        <Panel title={t('contextRoom:objectDetail.aiNotes')} className="context-room-meeting-panel">
          <p className="context-room-memory-content">{localizedUiText(meeting.summary, t)}</p>
          <div className="context-room-meeting-facts">
            <span>
              <small>{t('contextRoom:objectDetail.time')}</small>
              <b>{meeting.time}</b>
            </span>
            <span>
              <small>{t('contextRoom:objectDetail.location')}</small>
              <b>{meeting.location ?? t('contextRoom:objectDetail.onlineMeeting')}</b>
            </span>
            <span>
              <small>{t('contextRoom:objectDetail.room')}</small>
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
                <span>{t('contextRoom:objectDetail.ownerOwner', { owner: t(uiText(action.owner)) })}</span>
              </div>
              <button
                type="button"
                className={action.confirmed ? 'context-room-secondary' : 'context-room-primary'}
                disabled={action.confirmed}
                onClick={() => setPendingActionId(action.id)}
              >
                {t(action.confirmed ? 'contextRoom:objectDetail.addedToTasks' : 'contextRoom:objectDetail.addToTasks')}
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
        title={t('contextRoom:objectDetail.addTask')}
        summary={t('contextRoom:objectDetail.thisMeetingActionItemWillBeAddedTo')}
        rows={[
          {
            label: t('contextRoom:objectDetail.actionItems'),
            value: actions.find((action) => action.id === pendingActionId)?.title ?? '',
          },
          {
            label: t('contextRoom:objectDetail.owner'),
            value: actions.find((action) => action.id === pendingActionId)?.owner ?? t('contextRoom:objectDetail.toBeAdded'),
          },
        ]}
        sources={[{ type: t('contextRoom:objectDetail.meeting'), name: meeting.title }]}
        risk={t('contextRoom:objectDetail.afterSavingItWillAppearInTheTask')}
        confirmLabel={t('contextRoom:objectDetail.confirmAddTask')}
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
  const { t } = useLocale();
  type MailFolder = 'inbox' | 'starred' | 'sent' | 'archive';
  const [folder, setFolder] = useState<MailFolder>(mail.folder ?? 'inbox');
  const [selectedMailId, setSelectedMailId] = useState(mail.id);
  const [confirmAction, setConfirmAction] = useState<'send' | 'task' | null>(null);
  const defaultSender = t('contextRoom:objectDetail.defaultSender');
  const formalQuoteTaskTitle = t('contextRoom:objectDetail.formalQuoteTask');
  const mailItems = useMemo(
    () => [
      {
        id: mail.id,
        folder: mail.folder ?? ('inbox' as const),
        sender: mail.sender ?? defaultSender,
        title: mail.title,
        summary: mail.summary,
        time: mail.time,
        unread: mail.unread ?? true,
        starred: mail.starred ?? false,
      },
      {
        id: `${mail.id}-scope`,
        folder: 'inbox' as const,
        sender: t('contextRoom:objectDetail.deliveryTeamSender'),
        title: t('contextRoom:objectDetail.scopeConfirmationTitle', { room: room.title }),
        summary: t('contextRoom:objectDetail.scopeConfirmationSummary'),
        time: t('contextRoom:objectDetail.yesterdayAt', { time: '16:40' }),
        unread: false,
        starred: false,
      },
      {
        id: `${mail.id}-sent`,
        folder: 'sent' as const,
        sender: t('contextRoom:objectDetail.sentToProjectCollaborationTeam'),
        title: t('contextRoom:objectDetail.phaseUpdateTitle', { room: room.title }),
        summary: t('contextRoom:objectDetail.phaseUpdateSummary'),
        time: '07-21 10:20',
        unread: false,
        starred: false,
      },
      {
        id: `${mail.id}-archive`,
        folder: 'archive' as const,
        sender: t('contextRoom:objectDetail.systemNotificationSender'),
        title: t('contextRoom:objectDetail.historicalDataIndexComplete'),
        summary: t('contextRoom:objectDetail.archivedEmailIndexSummary'),
        time: '07-18 09:12',
        unread: false,
        starred: false,
      },
    ],
    [
      mail.folder,
      mail.id,
      mail.sender,
      mail.starred,
      mail.summary,
      mail.time,
      mail.title,
      mail.unread,
      room.title,
      defaultSender,
      t,
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
              title: formalQuoteTaskTitle,
              status: '未开始',
              owner: t('contextRoom:objectDetail.defaultOwnerName'),
              deadline: '07-24',
              source: { type: '邮件', name: mail.title, objectId: mail.id },
            },
          ],
    }));

  return (
    <section className="context-room-mail-reference" data-testid="context-room-mail-reference">
      <button
        type="button"
        aria-label={t('contextRoom:objectDetail.backToContextRoomDetails')}
        className="context-room-visually-hidden"
        onClick={onBack}
      >
        {t('contextRoom:objectDetail.backToRoom')}
      </button>
      <header className="context-room-page-header context-room-object-app-header">
        <div>
          <h1 className="context-room-page-title">{t('contextRoom:objectDetail.email')}</h1>
        </div>
        <div className="context-room-page-actions">
          <button
            type="button"
            className="context-room-secondary"
            onClick={() => updateMail({ unread: false })}
          >
            {t('contextRoom:objectDetail.sync')}
          </button>
        </div>
      </header>
      <div className="context-room-mail-layout" data-testid="context-room-mail-layout">
        <nav
          className="context-room-side-tabs context-room-mail-folders"
          aria-label={t('contextRoom:objectDetail.emailFolders')}
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
                <span>{t(uiText(label))}</span>
                <span className="context-room-nav-count">{count}</span>
              </button>
            );
          })}
        </nav>
        <section
          className="context-room-panel context-room-mail-list-pane"
          aria-label={t('contextRoom:objectDetail.emailList')}
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
                  {item.unread ? <Tag variant="info">{t('contextRoom:objectDetail.unread')}</Tag> : null}
                  <time>{item.time}</time>
                </span>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
              </button>
            ))
          ) : (
            <div className="context-room-empty">{t('contextRoom:objectDetail.noEmailHere')}</div>
          )}
        </section>
        <section className="context-room-mail-detail">
          <header className="context-room-mail-header">
            <div className="min-w-0">
              <h2 className="context-room-mail-subject">{activeMail.title}</h2>
              <p className="context-room-page-subtitle">
                {activeMail.sender} · {activeMail.time}
              </p>
            </div>
            <div className="context-room-mail-detail-actions">
              <button
                type="button"
                className="context-room-ghost context-room-small"
                aria-label={t('contextRoom:objectDetail.addStar')}
                onClick={() => updateMail({ starred: !mail.starred })}
              >
                <Star className="size-4" aria-hidden="true" />
                {t(mail.starred ? 'contextRoom:objectDetail.starred' : 'contextRoom:objectDetail.starAction')}
              </button>
              <button
                type="button"
                className="context-room-ghost context-room-small"
                onClick={() =>
                  updateMail({ folder: mail.folder === 'archive' ? 'inbox' : 'archive' })
                }
              >
                <Archive className="size-4" aria-hidden="true" />
                {t(mail.folder === 'archive' ? 'contextRoom:objectDetail.moveToInbox' : 'contextRoom:objectDetail.archive')}
              </button>
            </div>
          </header>
          <ExternalObjectState kind="mail" />
          <Panel title={t('contextRoom:objectDetail.aiSummaryShort')} className="context-room-mail-summary">
            <div
              className="flex items-start gap-2 text-sm leading-6 text-zinc-700 text-pretty"
              data-icon-tone="ai"
            >
              <Sparkles className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <p>{activeMail.summary}</p>
            </div>
          </Panel>
          <section className="context-room-mail-body">
            <div className="context-room-object-label">{t('contextRoom:objectDetail.emailBody')}</div>
            <p>{mail.body ?? activeMail.summary}</p>
            <div className="context-room-mail-attachment">
              <Paperclip className="size-4" aria-hidden="true" />
              <span>{t('contextRoom:objectDetail.relatedRoomResourceSummary')}</span>
            </div>
          </section>
          <section className="context-room-mail-derived-section">
            <h3>{t('contextRoom:objectDetail.questionsToAnswer')}</h3>
            <article className="context-room-mail-suggestion">
              <b>{t('contextRoom:objectDetail.quoteConfirmationQuestion')}</b>
            </article>
          </section>
          <section className="context-room-mail-derived-section">
            <h3>{t('contextRoom:objectDetail.taskCandidate')}</h3>
            <article className="context-room-mail-suggestion context-room-mail-task-candidate">
              <div>
                <b>{formalQuoteTaskTitle}</b>
                <span>{t('contextRoom:objectDetail.dueDateValue', { date: '07-24' })}</span>
              </div>
              <button
                type="button"
                className="context-room-primary context-room-small"
                onClick={() => setConfirmAction('task')}
              >
                {room.actionItems.some((item) => item.id === `${mail.id}-task`)
                  ? t('contextRoom:objectDetail.addedToTasks')
                  : t('contextRoom:objectDetail.addToTasks')}
              </button>
            </article>
          </section>
          <Panel
            title={t('contextRoom:objectDetail.replyDraft')}
            action={<Tag variant="info">{t('contextRoom:objectDetail.needsConfirmation')}</Tag>}
            className="context-room-mail-reply"
          >
            <textarea
              aria-label={t('contextRoom:objectDetail.replyDraft')}
              value={
                mail.replyDraft ?? t('contextRoom:objectDetail.replyDraftForRoom', { room: room.title })
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
                {t(mail.sent ? 'contextRoom:objectDetail.sent' : 'contextRoom:objectDetail.send')}
              </button>
              <button
                type="button"
                className="context-room-secondary"
                onClick={() => updateMail({ draftSaved: true })}
              >
                {t(mail.draftSaved ? 'contextRoom:objectDetail.saved' : 'contextRoom:objectDetail.saveDraft')}
              </button>
              <button type="button" className="context-room-ghost" onClick={onBack}>
                {t('contextRoom:objectDetail.backToRoom')}
              </button>
            </div>
          </Panel>
        </section>
      </div>
      <ActionConfirmDialog
        open={confirmAction === 'task'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('contextRoom:objectDetail.addToTasks')}
        summary={t('contextRoom:objectDetail.theTaskCandidateFromThisEmailWillBe')}
        rows={[
          { label: t('contextRoom:objectDetail.tasks'), value: formalQuoteTaskTitle },
          { label: t('contextRoom:objectDetail.dueDate'), value: '07-24' },
        ]}
        sources={[{ type: t('contextRoom:objectDetail.email'), name: mail.title }]}
        confirmLabel={t('contextRoom:objectDetail.add')}
        onConfirm={addTaskCandidate}
      />
      <ActionConfirmDialog
        open={confirmAction === 'send'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('contextRoom:objectDetail.sendEmail')}
        summary={t('contextRoom:objectDetail.theCurrentReplyDraftWillBeSentExternally')}
        rows={[
          { label: t('contextRoom:objectDetail.to'), value: mail.sender ?? defaultSender },
          { label: t('contextRoom:objectDetail.topic'), value: mail.title },
        ]}
        sources={[{ type: t('contextRoom:objectDetail.email'), name: mail.title }]}
        risk={t('contextRoom:objectDetail.sendingExternalEmailIsAHighRiskAction')}
        confirmLabel={t('contextRoom:objectDetail.send')}
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
  const { t } = useLocale();
  return (
    <section className="context-room-object-detail">
      <ObjectTopbar label={material.type} onBack={onBack}>
        <Tag>{t(uiText(material.type))}</Tag>
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
        <Panel title={t('contextRoom:objectDetail.resourceSummary')}>
          <p className="text-sm leading-6 text-zinc-700">{localizedUiText(material.summary, t)}</p>
        </Panel>
        <Panel title={t('contextRoom:objectDetail.roomContext')}>
          <div className="context-room-object-facts">
            <span>
              <small>{t('contextRoom:objectDetail.room')}</small>
              <b>{room.title}</b>
            </span>
            <span>
              <small>{t('contextRoom:objectDetail.resourceType')}</small>
              <b>{t(uiText(material.type))}</b>
            </span>
            <span>
              <small>{t('contextRoom:objectDetail.statusLabel')}</small>
              <b>{t(uiText(material.status ?? '已索引'))}</b>
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
  const { t } = useLocale();
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
        aria-label={t('contextRoom:objectDetail.backToContextRoomDetails')}
        className="context-room-visually-hidden"
        onClick={onBack}
      >
        {t('contextRoom:objectDetail.backToRoom')}
      </button>
      <header className="context-room-page-header context-room-object-app-header">
        <div>
          <h1 className="context-room-page-title">{t('contextRoom:objectDetail.memory')}</h1>
        </div>
        <div className="context-room-segmented" aria-label={t('contextRoom:objectDetail.memoryView')}>
          <button
            type="button"
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            {t('contextRoom:objectDetail.list')}
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
          >
            {t('contextRoom:objectDetail.graph')}
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
              {t(uiText(item.type))}
            </button>
          ))}
        </div>
      ) : (
        <div className="context-room-memory-layout">
          <nav className="context-room-side-tabs context-room-memory-filters" aria-label={t('contextRoom:objectDetail.memoryFilters')}>
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
                <span>{t(uiText(label))}</span>
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
              <h2>{t('contextRoom:objectDetail.memoryList')}</h2>
            </div>
            <div className="context-room-memory-list">
              {visibleMemories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={activeMemory.id === item.id}
                  onClick={() => setSelectedMemoryId(item.id)}
                >
                  <b>{localizedUiText(item.content, t)}</b>
                  <span>
                    {t(uiText(item.type))} · {room.title}
                  </span>
                  <Tag variant={statusVariant(uiText(item.status))}>{t(uiText(item.status))}</Tag>
                </button>
              ))}
            </div>
          </section>
          <Panel
            title={localizedUiText(activeMemory.content, t)}
            action={<Tag variant={statusVariant(uiText(activeMemory.status))}>{t(uiText(activeMemory.status))}</Tag>}
            className="context-room-memory-detail-panel"
          >
            <p className="context-room-memory-content">{localizedUiText(activeMemory.content, t)}</p>
            <div className="context-room-object-label context-room-memory-source-label">{t('contextRoom:objectDetail.sources')}</div>
            <div className="context-room-source-card" data-icon-tone="ai">
              <Sparkles className="size-4" aria-hidden="true" />
              <div>
                <b>{room.recentSource?.name ?? room.title}</b>
                <span>{room.recentSource?.type ?? 'Room'}</span>
              </div>
            </div>
            <div className="context-room-memory-meta">
              <span>{t('contextRoom:objectDetail.type')}</span>
              <b>{t(uiText(activeMemory.type))}</b>
              <span>{t('contextRoom:objectDetail.scope')}</span>
              <b>{room.title}</b>
            </div>
            <div className="context-room-object-lifecycle">
              {activeMemory.status === '待确认' ? (
                <button
                  type="button"
                  className="context-room-primary"
                  onClick={() => {
                    const confirmStatus = () =>
                      onUpdateRoom((current) => ({
                        ...current,
                        memoryItems: current.memoryItems.map((item) =>
                          item.id === activeMemory.id ? { ...item, status: '已确认' } : item
                        ),
                      }));
                    // 晋升：经 gateway 合成会话交 MemoryCore 蒸馏（worker 回填归属与
                    // memoryId）。API 不可用/失败时退化为本地确认（不阻塞用户）。
                    if (!window.nxcore?.contextRooms?.promoteMemoryItem || activeMemory.memoryId) {
                      confirmStatus();
                      return;
                    }
                    void window.nxcore.contextRooms.promoteMemoryItem(room.id, activeMemory.id)
                      .then(() => {
                        confirmStatus();
                        dispatchRoomMemoryChanged();
                      })
                      .catch((error) => {
                        console.error('[room-memory] promote failed', error);
                        confirmStatus();
                      });
                  }}
                >
                  {t('contextRoom:objectDetail.confirmMemory')}
                </button>
              ) : null}
              {!activeMemory.attributed ? (
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
                  {t('contextRoom:objectDetail.edit')}
                </button>
              ) : null}
              {activeMemory.status === '已禁用' ? (
                <button
                  type="button"
                  className="context-room-secondary"
                  onClick={() => {
                    void enableRoomMemoryItem(room.id, activeMemory)
                      .then((mutator) => onUpdateRoom(mutator))
                      .catch((error) => console.error('[room-memory] enable failed', error));
                  }}
                >
                  {t('contextRoom:objectDetail.enable')}
                </button>
              ) : (
                <button
                  type="button"
                  className="context-room-secondary"
                  onClick={() => setDisableConfirmOpen(true)}
                >
                  {t('contextRoom:objectDetail.disable')}
                </button>
              )}
            </div>
          </Panel>
        </div>
      )}
      <ActionConfirmDialog
        open={disableConfirmOpen}
        onOpenChange={setDisableConfirmOpen}
        title={t('contextRoom:objectDetail.disableMemory')}
        summary={t('contextRoom:objectDetail.agentWillNoLongerUseThisMemoryIn')}
        rows={[
          { label: t('contextRoom:objectDetail.memoryType'), value: t(uiText(activeMemory.type)) },
          { label: t('contextRoom:objectDetail.scope'), value: room.title },
        ]}
        sources={activeMemory.sources ?? []}
        risk={t('contextRoom:objectDetail.disablingDoesNotDeleteTheSourceYouCan')}
        confirmLabel={t('contextRoom:objectDetail.confirmDisable')}
        danger
        onConfirm={() => {
          void disableRoomMemoryItem(activeMemory)
            .then((mutator) => onUpdateRoom(mutator))
            .catch((error) => console.error('[room-memory] disable failed', error));
        }}
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
