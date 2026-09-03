import type {
  AgentDocumentExportRunView,
  DocumentVersionSummary,
  ExternalDocumentProvider,
  RoomDocument,
} from '@nxcore/agent-contract'
import { ExternalLink, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'
import './ExternalDocumentDialogs.css'

/**
 * "导出到飞书 / Notion" 面板（文档 ··· 菜单入口）。与 Agent 智能区导出共用
 * 网关的 Agent 导出链路：固定版本 → 预检/授权 → 确认（update）→ 一次性写入。
 * awaiting_auth 时把授权交给 Agent 智能区的步骤卡片（agent-auth IPC）。
 */
export function ExternalExportDialog({
  open,
  onClose,
  provider,
  roomId,
  documentId,
  documentName,
  currentVersion,
  backendDocument,
}: {
  open: boolean
  onClose: () => void
  provider: ExternalDocumentProvider
  roomId: string
  documentId: string
  documentName: string
  currentVersion: number
  backendDocument: RoomDocument | null
}) {
  const { t } = useLocale()
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([])
  const [version, setVersion] = useState<number>(currentVersion)
  const [mode, setMode] = useState<'create' | 'update' | 'export_file'>('create')
  const [writeScope, setWriteScope] = useState<'append' | 'replace_document'>('append')
  const [targetUrl, setTargetUrl] = useState('')
  const [parentUrl, setParentUrl] = useState('')
  const [run, setRun] = useState<AgentDocumentExportRunView | null>(null)
  const [busy, setBusy] = useState(false)

  const external = window.nxcore?.externalDocuments
  const providerLabel = provider === 'feishu'
    ? t('contextRoom:externalExportDialog.feishu')
    : t('contextRoom:externalExportDialog.notion')

  const TERMINAL_STATUSES = ['succeeded', 'failed', 'needs_review', 'cancelled', 'environment_not_ready']
  const authStartedRef = useRef(false)
  const prevStatusRef = useRef<string | null>(null)
  const runRef = useRef<AgentDocumentExportRunView | null>(null)
  runRef.current = run
  const retriedRunIdRef = useRef<string | null>(null)

  // 授权成功事件 → 自动恢复原任务（重新预检并继续，方案 §4.3）。
  useEffect(() => {
    const api = window.nxcore?.agentAuth
    if (!api) return
    return api.onEvent((frame) => {
      if (frame.type !== 'challenge.updated') return
      const challengeFrame = frame.challenge
      if (challengeFrame.status !== 'authorized' || challengeFrame.provider !== provider) return
      const current = runRef.current
      if (!current || current.status !== 'awaiting_auth') return
      if (retriedRunIdRef.current === current.id) return
      retriedRunIdRef.current = current.id
      void external?.retryExport(current.id)
        .then((next) => setRun(next))
        .catch(() => undefined)
    })
  }, [provider, external])

  // 导出任务是网关后台异步驱动的：创建接口立即返回 preparing，这里轮询真实状态，
  // 进度条按各阶段推进（授权 35% / 确认 55% / 写入 85% / 完成 100%）。
  useEffect(() => {
    if (!run || TERMINAL_STATUSES.includes(run.status)) return
    const exportId = run.id
    const timer = window.setInterval(() => {
      void external?.getExport(exportId).then((next) => {
        setRun(next)
        if (next.status === 'awaiting_auth' && next.challenge && !authStartedRef.current) {
          authStartedRef.current = true
          void window.nxcore?.agentAuth.start({
            provider: next.provider,
            phase: next.challenge.phase === 'app_setup' ? 'app_setup' : 'user_auth',
            exportRunId: next.id,
          }).catch(() => undefined)
        }
        if (prevStatusRef.current !== 'succeeded' && next.status === 'succeeded') {
          showToast({ title: t('contextRoom:externalExportDialog.exportSucceeded') })
        }
        prevStatusRef.current = next.status
      }).catch(() => undefined)
    }, 600)
    return () => window.clearInterval(timer)
  }, [run?.id, run?.status, external, t])

  useEffect(() => {
    if (!open) return
    setRun(null)
    setBusy(false)
    setVersion(currentVersion)
    setMode('create')
    setWriteScope('append')
    setTargetUrl('')
    setParentUrl('')
    void window.nxcore?.documents.listVersions(documentId, { limit: 30 })
      .then((items) => setVersions(items))
      .catch(() => setVersions([]))
  }, [open, currentVersion, documentId])

  const confirmation = run?.confirmation ?? null
  const challenge = run?.challenge ?? null

  const startExport = async (confirmedInput?: { exportId: string }) => {
    if (!external) return
    setBusy(true)
    try {
      const next = confirmedInput
        ? await external.confirmExport(confirmedInput.exportId)
        : await external.createExport({
          roomId,
          documentId,
          version,
          provider,
          mode,
          target: mode === 'update'
            ? { remoteUrl: targetUrl.trim() || undefined, writeScope }
            : { parentUrl: parentUrl.trim() || undefined },
        })
      setRun(next)
      prevStatusRef.current = next.status
      if (next.status === 'awaiting_auth' && next.challenge) {
        authStartedRef.current = true
        void window.nxcore?.agentAuth.start({
          provider: next.provider,
          phase: next.challenge.phase === 'app_setup' ? 'app_setup' : 'user_auth',
          exportRunId: next.id,
        }).catch(() => undefined)
      }
    } catch (error) {
      showToast({
        title: t('contextRoom:externalExportDialog.exportFailed'),
        message: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const cancelExport = async () => {
    if (!external || !run) return
    setBusy(true)
    try {
      const next = await external.cancelExport(run.id)
      setRun(next)
    } catch {
      // 取消失败不阻塞关闭。
    } finally {
      setBusy(false)
    }
  }

  const statusText = useMemo(() => {
    if (!run) return null
    const keyByStatus: Record<string, string> = {
      preparing: 'statusPreparing',
      environment_not_ready: 'statusEnvironmentNotReady',
      awaiting_auth: 'statusAwaitingAuth',
      awaiting_confirmation: 'statusAwaitingConfirmation',
      running: 'statusRunning',
      succeeded: 'statusSucceeded',
      failed: 'statusFailed',
      needs_review: 'statusNeedsReview',
      cancelled: 'statusCancelled',
    }
    const key = keyByStatus[run.status] ?? 'statusPreparing'
    return t(`contextRoom:externalExportDialog.${key}`)
  }, [run, t])

  /** 横向进度条 0-100%：目标值按导出执行阶段推进，滑块 rAF 缓动逼近目标。 */
  const progress = useMemo(() => {
    if (!run) return { percent: busy ? 90 : 0, error: false }
    const byStatus: Record<string, { percent: number; error?: boolean }> = {
      preparing: { percent: 15 },
      environment_not_ready: { percent: 15, error: true },
      awaiting_auth: { percent: 35 },
      awaiting_confirmation: { percent: 55 },
      running: { percent: 85 },
      succeeded: { percent: 100 },
      failed: { percent: 85, error: true },
      needs_review: { percent: 100, error: true },
      cancelled: { percent: 0, error: true },
    }
    return byStatus[run.status] ?? { percent: 15 }
  }, [run, busy])

  const [displayPercent, setDisplayPercent] = useState(0)
  const targetPercent = progress.percent
  useEffect(() => {
    let raf = 0
    const step = () => {
      setDisplayPercent((current) => {
        const diff = targetPercent - current
        if (Math.abs(diff) < 0.4) return targetPercent
        return current + diff * 0.035 + Math.sign(diff) * 0.12
      })
      raf = window.requestAnimationFrame(step)
    }
    raf = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(raf)
  }, [targetPercent])

  if (!open) return null

  return (
    <div className="evidence-dialog-backdrop" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="context-room-external-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('contextRoom:externalExportDialog.title', { provider: providerLabel })}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{t('contextRoom:externalExportDialog.title', { provider: providerLabel })}</h2>
          <button type="button" className="dialog-close" aria-label={t('contextRoom:externalExportDialog.close')} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="context-room-external-export-body">
          <p className="context-room-external-export-doc">
            {documentName}
            {backendDocument ? ` · V${String(currentVersion)}` : ''}
            <span className="context-room-external-export-hint">
              {t('contextRoom:externalExportDialog.fixedVersionHint')}
            </span>
          </p>
          {(busy || run) && (
            <div className="context-room-external-export-progress-group">
              <div
                className="context-room-external-export-progress"
                data-status={run?.status ?? 'preparing'}
                data-active={String(!progress.error && progress.percent < 100)}
              >
                <span style={{ width: `${String(Math.min(displayPercent, 100))}%` }} />
              </div>
              <p
                className="context-room-external-export-progress-label"
                data-status={run?.status ?? 'preparing'}
              >
                {`${String(Math.round(Math.min(displayPercent, 100)))}% · ${statusText ?? t('contextRoom:externalExportDialog.statusPreparing')}`}
              </p>
            </div>
          )}
          {!run && (
            <>
              <label>
                <span>{t('contextRoom:externalExportDialog.versionLabel')}</span>
                <select value={version} onChange={(event) => setVersion(Number(event.target.value))}>
                  {versions.map((item) => (
                    <option key={item.version} value={item.version}>V{String(item.version)}</option>
                  ))}
                </select>
              </label>
              <div className="context-room-external-export-mode">
                <label className="context-room-external-export-mode-option">
                  <input
                    type="radio"
                    name={`export-mode-${provider}`}
                    checked={mode === 'create'}
                    onChange={() => setMode('create')}
                  />
                  <span>{t('contextRoom:externalExportDialog.modeCreate')}</span>
                </label>
                <label className="context-room-external-export-mode-option">
                  <input
                    type="radio"
                    name={`export-mode-${provider}`}
                    checked={mode === 'update'}
                    onChange={() => setMode('update')}
                  />
                  <span>{t('contextRoom:externalExportDialog.modeUpdate')}</span>
                </label>
                {provider === 'feishu' && (
                  <label className="context-room-external-export-mode-option">
                    <input
                      type="radio"
                      name={`export-mode-${provider}`}
                      checked={mode === 'export_file'}
                      onChange={() => setMode('export_file')}
                    />
                    <span>{t('contextRoom:externalExportDialog.modeExportFile')}</span>
                  </label>
                )}
              </div>
              {mode === 'update' && (
                <>
                  <label>
                    <span>{t('contextRoom:externalExportDialog.targetUrlLabel')}</span>
                    <input
                      type="text"
                      value={targetUrl}
                      placeholder={provider === 'feishu'
                        ? t('contextRoom:externalExportDialog.feishuUrlPlaceholder')
                        : t('contextRoom:externalExportDialog.notionUrlPlaceholder')}
                      onChange={(event) => setTargetUrl(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t('contextRoom:externalExportDialog.writeScopeLabel')}</span>
                    <select value={writeScope} onChange={(event) => setWriteScope(event.target.value as 'append' | 'replace_document')}>
                      <option value="append">{t('contextRoom:externalExportDialog.writeScopeAppend')}</option>
                      <option value="replace_document">{t('contextRoom:externalExportDialog.writeScopeReplace')}</option>
                    </select>
                  </label>
                </>
              )}
              {mode !== 'update' && (
                <label>
                  <span>{t('contextRoom:externalExportDialog.parentUrlLabel')}</span>
                  <input
                    type="text"
                    value={parentUrl}
                    placeholder={t('contextRoom:externalExportDialog.parentUrlPlaceholder')}
                    onChange={(event) => setParentUrl(event.target.value)}
                  />
                </label>
              )}
              <p className="context-room-external-export-hint">
                {t('contextRoom:externalExportDialog.oneShotHint')}
              </p>
              <footer>
                <button type="button" className="secondary" onClick={onClose}>
                  {t('contextRoom:externalExportDialog.cancel')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || (mode === 'update' && !targetUrl.trim())}
                  onClick={() => void startExport()}
                >
                  {busy && <Loader2 className="spin" aria-hidden="true" />}
                  {t('contextRoom:externalExportDialog.start')}
                </button>
              </footer>
            </>
          )}
          {run && (
            <div className="context-room-external-export-run">
              {confirmation && (
                <div className="context-room-external-export-confirmation">
                  <p>{t('contextRoom:externalExportDialog.confirmTarget')}: {confirmation.targetTitle}</p>
                  <p className="context-room-external-export-hint">
                    <a href={confirmation.targetUrl} target="_blank" rel="noreferrer">
                      {t('contextRoom:externalExportDialog.viewTargetDocument')} <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </p>
                  <p>{t('contextRoom:externalExportDialog.confirmScope')}: {confirmation.writeScope}</p>
                  {confirmation.warnings.map((warning) => (
                    <p key={warning.code} className="context-room-external-export-warning">⚠ {warning.message}</p>
                  ))}
                </div>
              )}
              {challenge && (
                <p className="context-room-external-export-hint">
                  {t('contextRoom:externalExportDialog.authHint')}
                </p>
              )}
              {run.status === 'environment_not_ready' && (
                <p className="context-room-external-export-warning">
                  {run.errorMessage ?? t('contextRoom:externalExportDialog.environmentNotReady')}
                </p>
              )}
              {run.status === 'failed' && run.errorMessage && (
                <p className="context-room-external-export-warning">{run.errorMessage}</p>
              )}
              {run.remoteUrl && (
                <p>
                  <a href={run.remoteUrl} target="_blank" rel="noreferrer">
                    {t('contextRoom:externalExportDialog.openExportedDocument')} <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </p>
              )}
              {(busy || run.status === 'running' || run.status === 'preparing') && (
                <p className="context-room-external-export-hint">
                  {t('contextRoom:externalExportDialog.closeWhileRunningHint')}
                </p>
              )}
              <footer>
                {run.status === 'awaiting_confirmation' && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void startExport({ exportId: run.id })}
                  >
                    {busy && <Loader2 className="spin" aria-hidden="true" />}
                    {t('contextRoom:externalExportDialog.confirmAndWrite')}
                  </button>
                )}
                {(run.status === 'awaiting_confirmation' || run.status === 'awaiting_auth'
                  || run.status === 'environment_not_ready' || run.status === 'failed') && (
                  <button type="button" className="secondary" disabled={busy} onClick={() => setRun(null)}>
                    {t('contextRoom:externalExportDialog.backToEdit')}
                  </button>
                )}
                {(['preparing', 'running'].includes(run.status)) && (
                  <button type="button" className="secondary" disabled={busy} onClick={() => void cancelExport()}>
                    {t('contextRoom:externalExportDialog.cancelRun')}
                  </button>
                )}
                <button type="button" className="secondary" onClick={onClose}>
                  {t('contextRoom:externalExportDialog.close')}
                </button>
              </footer>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
