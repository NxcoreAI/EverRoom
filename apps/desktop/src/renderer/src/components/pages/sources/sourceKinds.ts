import type { DataSourceSummary, ConnectorProviderSummary } from '../../../../../shared/sources'
import type { IngestEventDto } from '../../../../../shared/ingest'
import type { SourceIconKind } from './SourceIcon'

/** 本地卡片状态 → 卡片描边/顶条视觉态（ok | syncing | paused | attention）。 */
export type SourceCardTone = 'ok' | 'syncing' | 'paused' | 'attention'

export function localCardTone(status: DataSourceSummary['status']): SourceCardTone {
  switch (status) {
    case 'connected': return 'ok'
    case 'syncing': return 'syncing'
    case 'paused': return 'paused'
    default: return 'attention'
  }
}

/** 状态 pill 的色调（ok 绿 / run 蓝闪 / paused 灰 / danger 红）。 */
export type StateTone = 'ok' | 'run' | 'paused' | 'danger'

export const SOURCE_STATUS_TONES: Record<DataSourceSummary['status'], StateTone> = {
  connected: 'ok',
  syncing: 'run',
  paused: 'paused',
  disconnected: 'danger',
  error: 'danger',
}

export const CONNECTION_STATUS_TONES: Record<ConnectorProviderSummary['category'] | string, StateTone> = {
  active: 'ok',
  disabled: 'paused',
  error: 'danger',
}

/** provider 注册名 → 品牌图标。key 为归一化形式（小写、去 -_/ 等分隔符）：
 *  网关注册表用连字符（google-calendar），oo 同步链落库的 service 用无分隔符
 *  （googlecalendar），两套命名并存（详见 connector 命名分裂）。 */
const PROVIDER_ICON_KINDS: Record<string, SourceIconKind> = {
  gmail: 'gmail',
  outlook: 'outlook',
  googlecalendar: 'google-calendar',
  googledocs: 'google-docs',
  googledrive: 'google-docs',
  notion: 'notion',
  feishu: 'feishu',
  github: 'github',
  claude: 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  icscalendar: 'ics-calendar',
}
function normalizeProvider(provider: string): string {
  return provider.toLowerCase().replace(/[-_.\s/]+/g, '')
}
export function providerIconKind(provider: string): SourceIconKind {
  return PROVIDER_ICON_KINDS[normalizeProvider(provider)] ?? 'web-page'
}

export function providerLabel(provider: string): string {
  switch (normalizeProvider(provider)) {
    case 'gmail': return 'Gmail'
    case 'outlook': return 'Outlook'
    case 'googledocs': return 'Google Docs'
    case 'googlecalendar': return 'Google Calendar'
    case 'googledrive': return 'Google Drive'
    case 'notion': return 'Notion'
    case 'feishu': return 'Feishu'
    default: return provider
  }
}

/** 台账 sourceKind → 图标。 */
const KIND_ICONS: Record<string, SourceIconKind> = {
  file: 'local-folder',
  mail: 'gmail',
  'cloud-doc': 'google-docs',
  'calendar-event': 'ics-calendar',
  'connector-record': 'web-page',
  'everroom-doc': 'web-page',
  'reality-event': 'web-page',
  todo: 'web-page',
  'visual-event': 'web-page',
}
export function ingestKindIcon(kind: string): SourceIconKind {
  return KIND_ICONS[kind] ?? 'web-page'
}

/** 台账事件统一取时：updatedAt 更能反映"进入"时刻（filtered 误杀恢复后会被刷新）。 */
export function ingestEventTime(event: IngestEventDto): string {
  return event.updatedAt || event.createdAt
}

/** 相对时间（feed/卡片用）；超过 30 天回退绝对日期。 */
export function formatRelative(value: string | null, locale: string): string {
  if (!value) return ''
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  const diffSeconds = Math.round((time - Date.now()) / 1000)
  if (Math.abs(diffSeconds) >= 30 * 24 * 3600) {
    return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(new Date(value))
  }
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
  ]
  let amount = diffSeconds
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [nextUnit, size] of table) {
    if (Math.abs(amount) < size) { unit = nextUnit; break }
    amount = Math.trunc(amount / size)
    unit = nextUnit
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit)
}
