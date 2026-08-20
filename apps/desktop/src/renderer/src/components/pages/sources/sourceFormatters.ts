import type {
  DataSourceSummary,
  EvidenceParseStatus,
  SourceFileStatus,
  SyncResult,
} from '../../../../../shared/sources'
import type { AppLocale, Translate } from '@/i18n/LocaleContext'

export const SOURCE_STATUS_LABELS: Record<DataSourceSummary['status'], string> = {
  connected: 'surface:sourceTable.synced',
  syncing: 'surface:sourceTable.syncing',
  paused: 'surface:sourceTable.paused',
  disconnected: 'surface:sourceTable.disconnected',
  error: 'surface:sourceTable.syncFailed',
}

export const FILE_STATUS_LABELS: Record<SourceFileStatus, string> = {
  added: 'surface:sourceTable.added',
  updated: 'surface:sourceTable.updated',
  renamed: 'surface:sourceTable.renamed',
  moved: 'surface:sourceTable.moved',
  restored: 'surface:sourceTable.restored',
  unchanged: 'surface:sourceTable.unchanged',
  missing: 'surface:sourceTable.deleted',
  error: 'surface:sourceTable.readFailed',
}

export const EVIDENCE_STATUS_LABELS: Record<EvidenceParseStatus, string> = {
  pending: 'surface:sourceTable.pendingParse',
  running: 'surface:sourceTable.parsing',
  success: 'surface:sourceTable.parsed',
  failed: 'surface:sourceTable.parseFailed',
  unsupported: 'surface:sourceTable.unsupported',
}

export function formatDate(value: string | null, locale: AppLocale, t: Translate): string {
  if (!value) return t('surface:sourceFormatters.notSyncedYet')
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

export function describeSync(result: SyncResult, t: Translate = (message) => message): string {
  return t('surface:sourceFormatters.foundDiscoveredFilesAddedAddedUpdatedUpdatedMoved', {
    discovered: result.discovered,
    added: result.added,
    updated: result.updated,
    moved: result.moved,
    unchanged: result.unchanged,
  })
}
