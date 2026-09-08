import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

import type { DataSourceSummary } from '../../../../../shared/sources'
import type { ConnectorConnection, SyncRun, SyncScope } from '@nxcore/connector-contract'
import type { ObsidianVaultBinding, ObsidianVaultCandidate } from '../../../../../shared/obsidian'
import { formatBytes, formatDate } from './sourceFormatters'
import { SourceIcon, type SourceIconKind } from './SourceIcon'
import {
  CONNECTION_STATUS_TONES,
  localCardTone,
  providerIconKind,
  providerLabel,
  SOURCE_STATUS_TONES,
  type StateTone,
} from './sourceKinds'
import { useLocale } from '@/i18n/LocaleContext'

/** 状态 pill（色点 + 文案）。 */
function StatePill({ tone, label }: { tone: StateTone; label: string }) {
  return (
    <span className="src-state" data-tone={tone}>
      <i className="dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/** 卡片骨架：头（logo/名称/状态）+ 内容 + 底部时间。操作一律进抽屉，卡面不放按钮。 */
function CardShell({
  tone,
  logo,
  name,
  subtitle,
  state,
  children,
  time,
  onOpen,
}: {
  tone: 'ok' | 'syncing' | 'paused' | 'attention'
  logo: ReactNode
  name: string
  subtitle: string
  state: ReactNode
  children?: ReactNode
  time?: ReactNode
  onOpen: () => void
}) {
  return (
    <article className="src-card" data-tone={tone} role="button" tabIndex={0} aria-haspopup="dialog"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }}
    >
      {tone === 'syncing' ? (
        <svg className="src-card-ring" aria-hidden="true" focusable="false">
          <rect pathLength="100" />
          <rect pathLength="100" />
          <rect pathLength="100" />
        </svg>
      ) : null}
      <header className="src-card-head">
        <span className="src-card-logo">{logo}</span>
        <div className="src-card-title">
          <h3>{name}</h3>
          <small title={subtitle}>{subtitle}</small>
        </div>
        {state}
      </header>
      {children}
      <footer className="src-card-foot">
        <span className="src-card-time">{time}</span>
      </footer>
    </article>
  )
}

/** 统计行：安静的内联「数字 + 单位」，读起来像一句话而非仪表盘。 */
function Stats({ items }: { items: Array<{ value: string; label: string }> }) {
  return (
    <div className="src-card-stats">
      {items.map((item) => (
        <div key={item.label}><b>{item.value}</b><small>{item.label}</small></div>
      ))}
    </div>
  )
}

/** 本地来源卡（识别文件夹/GitHub 等本地数据源）。 */
export function LocalSourceCard({
  source,
  onOpen,
}: {
  source: DataSourceSummary
  onOpen: () => void
}) {
  const { locale, t } = useLocale()
  return (
    <CardShell
      tone={localCardTone(source.status)}
      logo={<SourceIcon kind={source.kind as SourceIconKind} className={source.kind === 'local-folder' ? 'glyph' : ''} />}
      name={source.name}
      subtitle={source.rootPath}
      state={<StatePill tone={SOURCE_STATUS_TONES[source.status]} label={t(`surface:sourceTable.${source.status === 'connected' ? 'synced' : source.status === 'syncing' ? 'syncing' : source.status === 'paused' ? 'paused' : source.status === 'disconnected' ? 'disconnected' : 'syncFailed'}`)} />}
      time={source.lastSyncedAt ? t('surface:sourceCard.syncedAtTime', { time: formatDate(source.lastSyncedAt, locale, t) }) : t('surface:sourceFormatters.notSyncedYet')}
      onOpen={onOpen}
    >
      <Stats items={[
        { value: source.fileCount.toLocaleString(), label: t('surface:sourceTable.files') },
        { value: formatBytes(source.totalBytes), label: t('surface:sourceTable.size') },
        { value: source.versionCount.toLocaleString(), label: t('surface:sourceCard.versions') },
      ]} />
    </CardShell>
  )
}

/** Obsidian 聚合卡（全部 vault + 待导入候选）。 */
export function ObsidianSourceCard({
  vaults,
  candidates,
  onOpen,
}: {
  vaults: ObsidianVaultBinding[]
  candidates: ObsidianVaultCandidate[]
  onOpen: () => void
}) {
  const { locale, t } = useLocale()
  const pending = candidates.filter((candidate) => !candidate.mountedVaultId)
  const projectCount = vaults.length + pending.length
  const fileCount = [...vaults, ...pending].reduce((total, item) => total + item.noteCount + item.attachmentCount, 0)
  const noteCount = [...vaults, ...pending].reduce((total, item) => total + item.noteCount, 0)
  const partlyOffline = vaults.some((vault) => vault.status !== 'connected')
  const tone = partlyOffline ? 'attention' : pending.length > 0 ? 'paused' : 'ok'
  const updatedAt = vaults.reduce<string | null>((latest, vault) => !latest || vault.updatedAt > latest ? vault.updatedAt : latest, null)
  return (
    <CardShell
      tone={tone}
      logo={<SourceIcon kind="obsidian-vault" />}
      name="Obsidian"
      subtitle={pending.length > 0
        ? t('surface:sources.obsidianProjectsWithPending', { watched: vaults.length, pending: pending.length })
        : t('surface:sources.obsidianWatchedProjects', { count: vaults.length })}
      state={<StatePill tone={partlyOffline ? 'danger' : pending.length > 0 ? 'paused' : 'ok'} label={t(partlyOffline ? 'surface:sources.partlyOffline' : pending.length > 0 ? 'surface:sources.pendingImport' : 'surface:sourceTable.synced')} />}
      time={updatedAt ? t('surface:sourceCard.syncedAtTime', { time: formatDate(updatedAt, locale, t) }) : undefined}
      onOpen={onOpen}
    >
      <Stats items={[
        { value: fileCount.toLocaleString(), label: t('surface:sourceTable.files') },
        { value: noteCount.toLocaleString(), label: t('surface:sourceCard.notes') },
        { value: projectCount.toLocaleString(), label: t('surface:sourceCard.projects') },
      ]} />
      {pending.length > 0 ? <span className="src-card-chip">{t('surface:sourceCard.pendingProjects', { count: pending.length })}</span> : null}
    </CardShell>
  )
}

/** 云服务卡（mail/calendar/docs 连接器连接）。 */
export function CloudSourceCard({
  connection,
  scopes,
  runs,
  totals,
  onOpen,
}: {
  connection: ConnectorConnection
  scopes: SyncScope[]
  runs: SyncRun[]
  /** 连接已同步记录总数（mail/calendar）；缺省隐藏对应统计。 */
  totals?: { mail: number; calendar: number }
  onOpen: () => void
}) {
  const { locale, t } = useLocale()
  const mailbox = connection.provider === 'gmail' || connection.provider === 'outlook'
  const calendarScopes = connection.provider === 'google-calendar'
  const lastRun = runs.length ? runs.reduce((latest, run) => (run.startedAt > latest.startedAt ? run : latest)) : null
  const running = scopes.some((scope) => scope.state === 'running')
    || runs.some((run) => run.status === 'running' || run.status === 'queued')
  const tone = connection.status === 'error' ? 'attention' : running ? 'syncing' : connection.status === 'active' ? 'ok' : 'paused'
  const stateLabel = running
    ? t('surface:sourceTable.syncing')
    : t(`surface:connector.${connection.status === 'active' ? 'active' : connection.status === 'disabled' ? 'statusDisabled' : 'reauthorizationRequired'}`)
  return (
    <CardShell
      tone={tone}
      logo={<SourceIcon kind={providerIconKind(connection.provider)} />}
      name={providerLabel(connection.provider)}
      subtitle={connection.connectionName}
      state={<StatePill tone={running ? 'run' : CONNECTION_STATUS_TONES[connection.status]} label={stateLabel} />}
      time={lastRun?.finishedAt || lastRun?.startedAt ? t('surface:sourceCard.syncedAtTime', { time: formatDate(lastRun.finishedAt ?? lastRun.startedAt, locale, t) }) : t('surface:connector.notSyncedYet')}
      onOpen={onOpen}
    >
      {connection.status === 'error' && connection.updatedAt ? (
        <div className="src-card-error"><AlertTriangle aria-hidden="true" strokeWidth={1.8} />{t('surface:connector.reauthorizationRequired')}</div>
      ) : null}
      <Stats items={[
        ...(calendarScopes ? [
          ...(totals ? [{ value: totals.calendar.toLocaleString(), label: t('surface:connector.calendar') }] : []),
          { value: scopes.length.toLocaleString(), label: t('surface:connector.calendars') },
        ] : [
          ...(mailbox && totals ? [{ value: totals.mail.toLocaleString(), label: t('surface:sourceCard.syncedItems') }] : []),
          ...(!mailbox && lastRun ? [{ value: `${lastRun.processed.toLocaleString()}${lastRun.failed ? ` / ${lastRun.failed}` : ''}`, label: t('surface:sourceCard.lastSynced') }] : []),
        ]),
      ]} />
    </CardShell>
  )
}
