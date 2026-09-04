import { AlertTriangle, Eraser, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
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

type CardProps = { busy: boolean; onOpen: () => void }

/** 状态 pill（色点 + 文案）。 */
function StatePill({ tone, label }: { tone: StateTone; label: string }) {
  return (
    <span className="src-state" data-tone={tone}>
      <i className="dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/** 卡片骨架：头（logo/名称/状态）+ 内容 + 底部时间。 */
function CardShell({
  tone,
  logo,
  name,
  subtitle,
  state,
  children,
  time,
  actions,
  busy,
  onOpen,
}: CardProps & {
  tone: 'ok' | 'syncing' | 'paused' | 'attention'
  logo: ReactNode
  name: string
  subtitle: string
  state: ReactNode
  children?: ReactNode
  time?: ReactNode
  actions?: ReactNode
}) {
  return (
    <article className="src-card" data-tone={tone} role="button" tabIndex={0} aria-haspopup="dialog"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }}
    >
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
      {actions ? <span className="src-card-actions" onClick={(event) => event.stopPropagation()}>{actions}</span> : null}
    </article>
  )
}

/** 统计三连：数字 + 单位（单位是数据标签,非功能说明）。 */
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
  busy,
  onOpen,
  onSync,
  onTogglePaused,
  onClear,
}: CardProps & {
  source: DataSourceSummary
  onSync: () => void
  onTogglePaused: () => void
  onClear: () => void
}) {
  const { locale, t } = useLocale()
  const busyAction = busy || source.status === 'syncing'
  const resumable = source.status === 'paused' || source.status === 'disconnected' || source.status === 'error'
  const syncable = source.status === 'connected'
  return (
    <CardShell
      tone={localCardTone(source.status)}
      logo={<SourceIcon kind={source.kind as SourceIconKind} className={source.kind === 'local-folder' ? 'glyph' : ''} />}
      name={source.name}
      subtitle={source.rootPath}
      state={<StatePill tone={SOURCE_STATUS_TONES[source.status]} label={t(`surface:sourceTable.${source.status === 'connected' ? 'synced' : source.status === 'syncing' ? 'syncing' : source.status === 'paused' ? 'paused' : source.status === 'disconnected' ? 'disconnected' : 'syncFailed'}`)} />}
      time={source.lastSyncedAt ? t('surface:sourceCard.syncedAtTime', { time: formatDate(source.lastSyncedAt, locale, t) }) : t('surface:sourceFormatters.notSyncedYet')}
      busy={busy}
      onOpen={onOpen}
      actions={
        <>
          {syncable ? <button type="button" className="src-mini-btn" disabled={busyAction} onClick={onSync}><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:sourceCard.syncNow')}</button> : null}
          <button type="button" className="src-mini-btn" aria-label={t(resumable ? 'surface:sourceTable.resumeSync' : 'surface:sourceTable.pauseSync')} title={t(resumable ? 'surface:sourceTable.resumeSync' : 'surface:sourceTable.pauseSync')} disabled={busy} onClick={onTogglePaused}>
            {resumable ? <Play aria-hidden="true" strokeWidth={1.8} /> : <Pause aria-hidden="true" strokeWidth={1.8} />}
          </button>
          <button type="button" className="src-mini-btn danger" aria-label={t('surface:sourceTable.clearDataName', { name: source.name })} title={t('surface:sourceTable.clearDataKeepFolder')} disabled={busy} onClick={onClear}>
            <Eraser aria-hidden="true" strokeWidth={1.8} />
          </button>
        </>
      }
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
  busy,
  onOpen,
  onRescan,
}: CardProps & {
  vaults: ObsidianVaultBinding[]
  candidates: ObsidianVaultCandidate[]
  onRescan: () => void
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
      busy={busy}
      onOpen={onOpen}
      actions={
        <button type="button" className="src-mini-btn" disabled={busy} onClick={onRescan}>
          <RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.rescanObsidian')}
        </button>
      }
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
  busy,
  onOpen,
  onSync,
  onToggleEnabled,
  onPurge,
}: CardProps & {
  connection: ConnectorConnection
  scopes: SyncScope[]
  runs: SyncRun[]
  onSync: () => void
  onToggleEnabled: () => void
  onPurge: () => void
}) {
  const { locale, t } = useLocale()
  const active = connection.status === 'active'
  const lastRun = runs.length ? runs.reduce((latest, run) => (run.startedAt > latest.startedAt ? run : latest)) : null
  const running = scopes.some((scope) => scope.state === 'running')
    || runs.some((run) => run.status === 'running' || run.status === 'queued')
  const tone = connection.status === 'error' ? 'attention' : running ? 'syncing' : active ? 'ok' : 'paused'
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
      busy={busy}
      onOpen={onOpen}
      actions={
        <>
          {active ? <button type="button" className="src-mini-btn" disabled={busy || !scopes.length} onClick={onSync}><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:connector.incrementalSync')}</button> : null}
          <button type="button" className="src-mini-btn" aria-label={t(active ? 'surface:connector.disableConnection' : 'surface:sourceCard.enableConnection')} title={t(active ? 'surface:connector.disableConnection' : 'surface:sourceCard.enableConnection')} disabled={busy} onClick={onToggleEnabled}>
            {active ? <Pause aria-hidden="true" strokeWidth={1.8} /> : <Play aria-hidden="true" strokeWidth={1.8} />}
          </button>
          <button type="button" className="src-mini-btn danger" aria-label={t('surface:connector.clearLocalData')} title={t('surface:connector.clearLocalData')} disabled={busy} onClick={onPurge}>
            <Trash2 aria-hidden="true" strokeWidth={1.8} />
          </button>
        </>
      }
    >
      {connection.status === 'error' && connection.updatedAt ? (
        <div className="src-card-error"><AlertTriangle aria-hidden="true" strokeWidth={1.8} />{t('surface:connector.reauthorizationRequired')}</div>
      ) : null}
      <Stats items={[
        { value: scopes.length.toLocaleString(), label: t('surface:sourceCard.scopes') },
        ...(lastRun ? [{ value: `${lastRun.processed.toLocaleString()}${lastRun.failed ? ` / ${lastRun.failed}` : ''}`, label: t('surface:sourceCard.lastSynced') }] : []),
      ]} />
    </CardShell>
  )
}
