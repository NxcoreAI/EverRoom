import type {
  DataSourceSummary,
  EvidenceParseStatus,
  SourceFileStatus,
  SyncResult,
} from '../../../../../shared/sources'
import type { AppLocale, Translate } from '@/i18n/LocaleContext'

export const SOURCE_STATUS_LABELS: Record<DataSourceSummary['status'], string> = {
  connected: '已同步',
  syncing: '同步中',
  paused: '已暂停',
  disconnected: '已断开',
  error: '同步失败',
}

export const FILE_STATUS_LABELS: Record<SourceFileStatus, string> = {
  added: '新增',
  updated: '已修改',
  renamed: '已重命名',
  moved: '已移动',
  restored: '已恢复',
  unchanged: '未变化',
  missing: '已删除',
  error: '读取失败',
}

export const EVIDENCE_STATUS_LABELS: Record<EvidenceParseStatus, string> = {
  pending: '待解析',
  running: '解析中',
  success: '已解析',
  failed: '解析失败',
  unsupported: '暂不支持',
}

export function formatDate(value: string | null, locale: AppLocale = 'zh-CN', t: Translate = (message) => message): string {
  if (!value) return t('尚未同步')
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
  return t('发现 {discovered} 个文件，新增 {added}，更新 {updated}，移动 {moved}，未变化 {unchanged}。', {
    discovered: result.discovered,
    added: result.added,
    updated: result.updated,
    moved: result.moved,
    unchanged: result.unchanged,
  })
}
