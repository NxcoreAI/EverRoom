import { ArrowLeftRight, ExternalLink, Eraser, Eye, File, FolderOpen, Import, Pause, Play, RefreshCw, Trash2, Unplug, Wrench, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { DataSourceSummary, SourceFileSummary } from '../../../../../shared/sources'
import type { ConnectorConnection, SyncRun, SyncScope } from '@nxcore/connector-contract'
import type { ObsidianVaultBinding, ObsidianVaultCandidate } from '../../../../../shared/obsidian'
import { EVIDENCE_STATUS_LABELS, FILE_STATUS_LABELS, formatBytes, formatDate } from './sourceFormatters'
import { SourceIcon, type SourceIconKind } from './SourceIcon'
import { providerIconKind, providerLabel, SOURCE_STATUS_TONES, type StateTone } from './sourceKinds'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

export type DrawerTarget =
  | { type: 'local'; source: DataSourceSummary }
  | { type: 'obsidian' }
  | { type: 'cloud'; connection: ConnectorConnection }

/** connector 状态/模式 → 既有 i18n key。 */
const CONNECTOR_STATUS_KEYS: Record<string, string> = {
  active: 'surface:connector.active',
  disabled: 'surface:connector.statusDisabled',
  error: 'surface:connector.reauthorizationRequired',
  running: 'surface:connector.statusRunning',
  queued: 'surface:connector.statusPending',
  completed: 'surface:connector.statusCompleted',
  failed: 'surface:connector.statusFailed',
  interrupted: 'surface:connector.statusFailed',
  idle: 'surface:connector.statusIdle',
  resync_required: 'surface:connector.statusResyncRequired',
  incremental: 'surface:connector.modeIncremental',
  full: 'surface:connector.modeFull',
  rebuild: 'surface:connector.modeRebuild',
}

function statusTone(value: string): StateTone {
  if (value === 'active' || value === 'completed' || value === 'idle') return 'ok'
  if (value === 'running' || value === 'queued') return 'run'
  if (value === 'disabled') return 'paused'
  return 'danger'
}

/**
 * run 展示态：失败不直接报红。有进度=部分同步；瞬时网络错误=自动重试；
 * 格式映射未就绪=准备中（后台生成后自动续传）；其余才报失败。原始错误留 title。
 */
function runPresentation(run: SyncRun, t: Translate): { tone: StateTone; label: string } {
  if (run.status === 'running' || run.status === 'queued') return { tone: 'run', label: t('surface:connector.statusRunning') }
  if (run.status === 'completed') return { tone: 'ok', label: t('surface:connector.statusCompleted') }
  if (run.status === 'interrupted') return { tone: 'paused', label: t('surface:connector.statusPartial') }
  const error = run.error ?? ''
  if (run.processed > 0) return { tone: 'paused', label: t('surface:connector.statusPartial') }
  if (error.includes('format_mapping_pending')) return { tone: 'run', label: t('surface:connector.mappingPreparing') }
  if (/timed out|econn|network|http response|socket/i.test(error)) return { tone: 'paused', label: t('surface:connector.runRetrySoon') }
  return { tone: 'danger', label: t('surface:connector.statusFailed') }
}

function StatePill({ tone, label }: { tone: StateTone; label: string }) {
  return (
    <span className="src-state" data-tone={tone}>
      <i className="dot" aria-hidden="true" />
      {label}
    </span>
  )
}

function StateDot({ value, t }: { value: string; t: Translate }) {
  return <StatePill tone={statusTone(value)} label={t(CONNECTOR_STATUS_KEYS[value] ?? value)} />
}

/** 文件徽标色调：文件状态 → new/mod/中性/err。 */
function fileBadgeTone(status: SourceFileSummary['status']): string {
  if (status === 'added' || status === 'restored') return 'new'
  if (status === 'updated' || status === 'renamed' || status === 'moved') return 'mod'
  if (status === 'missing' || status === 'error') return 'err'
  return ''
}

export function SourceDrawer({
  target,
  open,
  files,
  filesLoading,
  vaults,
  obsidianCandidates,
  scopes,
  runs,
  busyId,
  onClose,
  onSync,
  onTogglePaused,
  onClear,
  onOpenEvidence,
  onPreviewFile,
  onShowFile,
  onRescanObsidian,
  onOpenVaultRoom,
  onDisconnectVault,
  onImportObsidianCandidate,
  onScopeSync,
  onToggleEnabled,
  onPurge,
  onReplaceAccount,
}: {
  target: DrawerTarget
  open: boolean
  files: SourceFileSummary[]
  filesLoading: boolean
  vaults: ObsidianVaultBinding[]
  obsidianCandidates: ObsidianVaultCandidate[]
  scopes: SyncScope[]
  runs: SyncRun[]
  busyId: string | null
  onClose: () => void
  onSync: () => void
  onTogglePaused: () => void
  onClear: () => void
  onOpenEvidence: (sourceId: string, fileId: string) => void
  onPreviewFile: (sourceId: string, fileId: string) => void
  onShowFile: (sourceId: string, fileId: string) => void
  onRescanObsidian: () => void
  onOpenVaultRoom: (vault: ObsidianVaultBinding) => void
  onDisconnectVault: (vault: ObsidianVaultBinding) => void
  onImportObsidianCandidate: (candidate: ObsidianVaultCandidate) => void
  onScopeSync: (scope: SyncScope) => void
  onToggleEnabled: (connection: ConnectorConnection) => void
  onPurge: (connection: ConnectorConnection) => void
  /** 云抽屉：重新授权同一 provider（单槽位:新账号顶替现有连接）；缺省不显示。 */
  onReplaceAccount?: () => void
}) {
  const { locale, t } = useLocale()
  const logo = (kind: SourceIconKind, glyph = false) => (
    <span className="src-card-logo"><SourceIcon kind={kind} className={glyph ? 'glyph' : ''} /></span>
  )
  const head = (logoNode: ReactNode, name: string, sub: string, meta: ReactNode, actions: ReactNode) => (
    <div className="src-drawer-head">
      <div className="top">
        {logoNode}
        <h3>{name}</h3>
        <button type="button" className="src-drawer-close" aria-label={t('surface:sourceCard.drawerClose')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
      </div>
      <div className="src-drawer-sub">{sub}</div>
      <div className="src-drawer-meta">{meta}</div>
      <div className="src-drawer-actions">{actions}</div>
    </div>
  )
  const stats = (items: Array<{ value: string; label: string }>) => (
    <div className="src-drawer-stats">
      {items.map((item) => <div key={item.label}><b>{item.value}</b><small>{item.label}</small></div>)}
    </div>
  )

  let content: ReactNode = null
  if (target.type === 'local') {
    const { source } = target
    const busy = busyId === source.id
    const resumable = source.status === 'paused' || source.status === 'disconnected' || source.status === 'error'
    content = (
      <>
        {head(
          logo(source.kind as SourceIconKind, source.kind === 'local-folder'),
          source.name,
          source.rootPath,
          <>
            <StatePill tone={SOURCE_STATUS_TONES[source.status]} label={t(`surface:sourceTable.${source.status === 'connected' ? 'synced' : source.status === 'syncing' ? 'syncing' : source.status === 'paused' ? 'paused' : source.status === 'disconnected' ? 'disconnected' : 'syncFailed'}`)} />
            <span>{formatDate(source.lastSyncedAt, locale, t)}</span>
            {source.lastError ? <span className="src-meta-error" title={source.lastError}>{source.lastError}</span> : null}
          </>,
          <>
            {source.status === 'connected' ? <button type="button" className="src-mini-btn" disabled={busy} onClick={onSync}><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:sourceCard.syncNow')}</button> : null}
            <button type="button" className="src-mini-btn" disabled={busy} onClick={onTogglePaused}>{resumable ? <Play aria-hidden="true" strokeWidth={1.8} /> : <Pause aria-hidden="true" strokeWidth={1.8} />}{t(resumable ? 'surface:sourceTable.resumeSync' : 'surface:sourceTable.pauseSync')}</button>
            <button type="button" className="src-mini-btn danger" disabled={busy} onClick={onClear}><Eraser aria-hidden="true" strokeWidth={1.8} />{t('surface:sourceTable.clearDataKeepFolder')}</button>
          </>,
        )}
        {stats([
          { value: source.fileCount.toLocaleString(), label: t('surface:sourceTable.files') },
          { value: formatBytes(source.totalBytes), label: t('surface:sourceTable.size') },
          { value: source.versionCount.toLocaleString(), label: t('surface:sourceCard.versions') },
        ])}
        <div className="src-drawer-list">
          <div className="src-list-head"><h4>{t('surface:sourceTable.files')} · {source.fileCount.toLocaleString()}</h4></div>
          {filesLoading ? <div className="src-feed-empty">{t('surface:sourceTable.loadingFiles')}</div> : null}
          {!filesLoading && files.length === 0 ? <div className="src-feed-empty">{t('surface:sourceTable.noSupportedFiles')}</div> : null}
          {files.map((file) => (
            <div key={file.id} className="src-file-row">
              <span className="src-file-glyph"><File aria-hidden="true" strokeWidth={1.8} /></span>
              <span className="src-file-copy">
                <strong>{file.name}</strong>
                <small title={file.originalPath}>{file.previousRelativePath ? `${file.previousRelativePath} → ${file.relativePath}` : file.relativePath}</small>
              </span>
              <span className="src-file-badge" data-tone={fileBadgeTone(file.status)}>{t(FILE_STATUS_LABELS[file.status])}</span>
              <button type="button" className="src-file-badge" data-tone={file.parseStatus === 'success' ? 'evidence' : ''} title={file.parseStatus === 'success' ? t('surface:sourceTable.countEvidenceParagraphs', { count: file.evidenceCount }) : t(EVIDENCE_STATUS_LABELS[file.parseStatus])} onClick={() => onOpenEvidence(source.id, file.id)}>
                {file.parseStatus === 'success' ? t('surface:sourceTable.countSegments', { count: file.evidenceCount }) : t(EVIDENCE_STATUS_LABELS[file.parseStatus])}
              </button>
              <span className="src-file-meta">{formatDate(file.modifiedAt, locale, t)}<br />{formatBytes(file.size)}</span>
              <span className="src-file-actions">
                {['.md', '.mdx', '.markdown'].includes(file.extension.toLowerCase()) ? <button type="button" className="icon-button" aria-label={t('surface:sourceTable.previewName', { name: file.name })} title={t('surface:sourceTable.previewMarkdown')} disabled={!file.exists} onClick={() => onPreviewFile(source.id, file.id)}><Eye aria-hidden="true" strokeWidth={1.8} /></button> : null}
                <button type="button" className="icon-button" aria-label={t('surface:sourceTable.openSourceForName', { name: file.name })} title={t(file.exists ? 'surface:sourceTable.openSource' : 'surface:sourceTable.originalFileMissing')} disabled={!file.exists} onClick={() => onShowFile(source.id, file.id)}><FolderOpen aria-hidden="true" strokeWidth={1.8} /></button>
              </span>
            </div>
          ))}
        </div>
      </>
    )
  }

  if (target.type === 'obsidian') {
    const pending = obsidianCandidates.filter((candidate) => !candidate.mountedVaultId)
    const partlyOffline = vaults.some((vault) => vault.status !== 'connected')
    const updatedAt = vaults.reduce<string | null>((latest, vault) => !latest || vault.updatedAt > latest ? vault.updatedAt : latest, null)
    const fileCount = [...vaults, ...pending].reduce((total, item) => total + item.noteCount + item.attachmentCount, 0)
    const noteCount = [...vaults, ...pending].reduce((total, item) => total + item.noteCount, 0)
    content = (
      <>
        {head(
          logo('obsidian-vault'),
          'Obsidian',
          pending.length > 0
            ? t('surface:sources.obsidianProjectsWithPending', { watched: vaults.length, pending: pending.length })
            : t('surface:sources.obsidianWatchedProjects', { count: vaults.length }),
          <>
            <StatePill tone={partlyOffline ? 'danger' : pending.length > 0 ? 'paused' : 'ok'} label={t(partlyOffline ? 'surface:sources.partlyOffline' : pending.length > 0 ? 'surface:sources.pendingImport' : 'surface:sourceTable.synced')} />
            {updatedAt ? <span>{formatDate(updatedAt, locale, t)}</span> : null}
          </>,
          <button type="button" className="src-mini-btn" disabled={busyId === 'obsidian'} onClick={onRescanObsidian}><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.rescanObsidian')}</button>,
        )}
        {stats([
          { value: fileCount.toLocaleString(), label: t('surface:sourceTable.files') },
          { value: noteCount.toLocaleString(), label: t('surface:sourceCard.notes') },
          { value: (vaults.length + pending.length).toLocaleString(), label: t('surface:sourceCard.projects') },
        ])}
        <div className="src-drawer-list">
          <div className="src-list-head"><h4>{t('surface:sources.obsidianProject')} · {(vaults.length + pending.length).toLocaleString()}</h4></div>
          {vaults.map((vault) => (
            <div key={vault.id} className="src-vault-row">
              <span className="src-file-glyph"><SourceIcon kind="obsidian-vault" /></span>
              <span className="src-file-copy">
                <strong>{vault.name}</strong>
                <small>{t('surface:sources.obsidianNotesAndProjects', { notes: vault.noteCount, projects: 1 })}</small>
              </span>
              <span className="src-file-badge">{t(vault.mountMode === 'memory' ? 'surface:sources.obsidianMemory' : vault.mountMode === 'embedded' ? 'surface:sources.obsidianRoomPart' : 'surface:sources.obsidianProjectRoom')}</span>
              <StatePill tone={vault.status === 'connected' ? 'ok' : 'danger'} label={t(vault.status === 'connected' ? 'surface:obsidian.connected' : 'surface:obsidian.offline')} />
              <span className="src-file-actions">
                {vault.mountMode !== 'memory' ? <button type="button" className="icon-button" aria-label={t('surface:sources.openRoom')} title={t('surface:sources.openRoom')} onClick={() => onOpenVaultRoom(vault)}><ExternalLink aria-hidden="true" strokeWidth={1.8} /></button> : null}
                <button type="button" className="icon-button" aria-label={t('surface:obsidian.disconnect')} title={t('surface:obsidian.disconnect')} disabled={busyId === vault.id} onClick={() => onDisconnectVault(vault)}><Unplug aria-hidden="true" strokeWidth={1.8} /></button>
              </span>
            </div>
          ))}
          {pending.map((candidate) => (
            <div key={candidate.id} className="src-vault-row">
              <span className="src-file-glyph"><SourceIcon kind="obsidian-vault" /></span>
              <span className="src-file-copy">
                <strong>{candidate.name}</strong>
                <small>{t('surface:sources.obsidianNotesAndProjects', { notes: candidate.noteCount, projects: 1 })}</small>
              </span>
              <span className="src-file-badge" data-tone="new">{t('surface:sources.pendingImport')}</span>
              <span className="src-file-actions">
                <button type="button" className="icon-button" aria-label={t('surface:sources.importObsidianProject', { name: candidate.name })} title={t('surface:sources.importIntoMemory')} disabled={busyId === candidate.id} onClick={() => onImportObsidianCandidate(candidate)}><Import className={busyId === candidate.id ? 'is-spinning' : undefined} aria-hidden="true" strokeWidth={1.8} /></button>
              </span>
            </div>
          ))}
        </div>
      </>
    )
  }

  if (target.type === 'cloud') {
    const { connection } = target
    const busy = busyId === connection.id
    const active = connection.status === 'active'
    // 邮箱是单槽位 OAuth（一个 token 一个邮箱），"同步范围"对用户无意义；
    // 日历类按"每个日历"建 scope，保留展示。
    const mailbox = connection.provider === 'gmail' || connection.provider === 'outlook'
    const lastRun = runs.length ? runs.reduce((latest, run) => (run.startedAt > latest.startedAt ? run : latest)) : null
    const running = runs.some((run) => run.status === 'running' || run.status === 'queued')
    content = (
      <>
        {head(
          logo(providerIconKind(connection.provider)),
          providerLabel(connection.provider),
          connection.connectionName,
          <>
            <StateDot value={running ? 'running' : connection.status} t={t} />
            <span>{formatDate(connection.updatedAt, locale, t)}</span>
          </>,
          <>
            {active ? <button type="button" className="src-mini-btn" disabled={busy || !scopes.length} onClick={onSync}><RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('surface:connector.incrementalSync')}</button> : null}
            {onReplaceAccount ? <button type="button" className="src-mini-btn" disabled={busy} onClick={onReplaceAccount}><ArrowLeftRight aria-hidden="true" strokeWidth={1.8} />{t('surface:sources.replaceAccount')}</button> : null}
            <button type="button" className="src-mini-btn" disabled={busy} onClick={() => onToggleEnabled(connection)}>{active ? <Pause aria-hidden="true" strokeWidth={1.8} /> : <Play aria-hidden="true" strokeWidth={1.8} />}{t(active ? 'surface:connector.disableConnection' : 'surface:sourceCard.enableConnection')}</button>
            <button type="button" className="src-mini-btn danger" disabled={busy} onClick={() => onPurge(connection)}><Trash2 aria-hidden="true" strokeWidth={1.8} />{t('surface:connector.clearLocalData')}</button>
          </>,
        )}
        {stats([
          ...(!mailbox ? [{ value: scopes.length.toLocaleString(), label: t('surface:sourceCard.scopes') }] : []),
          ...(lastRun ? [{ value: lastRun.processed.toLocaleString(), label: t('surface:sourceCard.lastSynced') }] : []),
        ])}
        <div className="src-drawer-list">
          {!mailbox ? (
            <>
              <div className="src-list-head"><h4>{t('surface:sourceCard.scopes')} · {scopes.length.toLocaleString()}</h4></div>
              {scopes.length === 0 ? <div className="src-feed-empty">{t('surface:sourceCard.noScopes')}</div> : null}
              {scopes.map((scope) => (
                <div key={scope.id} className="src-scope-row">
                  <span className="src-file-copy">
                    <strong>{scope.displayName}</strong>
                    <small>{formatDate(scope.updatedAt, locale, t)}</small>
                  </span>
                  <StateDot value={scope.state} t={t} />
                  <span className="src-file-actions">
                    <button type="button" className="icon-button" aria-label={t(scope.state === 'resync_required' ? 'surface:connector.rebuildScope' : 'surface:connector.incrementalSync')} title={t(scope.state === 'resync_required' ? 'surface:connector.rebuildScope' : 'surface:connector.incrementalSync')} disabled={busy || scope.state === 'running' || scope.state === 'disabled'} onClick={() => onScopeSync(scope)}>
                      {scope.state === 'resync_required' ? <Wrench aria-hidden="true" strokeWidth={1.8} /> : <Play aria-hidden="true" strokeWidth={1.8} />}
                    </button>
                  </span>
                </div>
              ))}
            </>
          ) : null}
          <div className="src-list-head"><h4>{t('surface:sourceCard.runs')} · {runs.length.toLocaleString()}</h4></div>
          {runs.length === 0 ? <div className="src-feed-empty">{t('surface:sourceCard.noRuns')}</div> : null}
          {runs.map((run) => {
            const shown = runPresentation(run, t)
            return (
              <div key={run.id} className="src-run-row" title={run.error || undefined}>
                <span className="src-file-copy">
                  <strong>{t(CONNECTOR_STATUS_KEYS[run.mode] ?? run.mode)} · {t('surface:connector.countRecords', { count: run.processed.toLocaleString() })}{run.failed > 0 ? ` · ${t('surface:connector.countFailed', { count: run.failed.toLocaleString() })}` : ''}</strong>
                  <small>{formatDate(run.finishedAt ?? run.startedAt, locale, t)}</small>
                </span>
                <StatePill tone={shown.tone} label={shown.label} />
              </div>
            )
          })}
        </div>
      </>
    )
  }

  // Portal 到 body：抽屉/遮罩是 fixed 定位,必须脱离 .page（滚动容器 +
  // workspace-content-enter 入场动画会在挂载瞬间建立包含块/位移,造成显示异常）。
  // node 测试环境没有 document——直接返回子树（react-test-renderer 里等价）。
  if (typeof document === 'undefined') return content
  return createPortal(
    <>
      <div className="src-scrim" data-open={String(open)} onClick={onClose} />
      <aside className="src-drawer" data-open={String(open)} role="dialog" aria-modal="true" aria-label={t('surface:sourceCard.sourceDetails')}>
        {content}
      </aside>
    </>,
    document.body,
  )
}

