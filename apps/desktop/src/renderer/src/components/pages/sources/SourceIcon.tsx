import { CalendarDays, FolderOpen, Globe } from 'lucide-react'

import feishuLogo from '@/assets/source-icons/feishu.svg'
import githubLogo from '@/assets/source-icons/github.svg'
import gmailLogo from '@/assets/source-icons/gmail.svg'
import googleCalendarLogo from '@/assets/source-icons/google-calendar.svg'
import googleDocsLogo from '@/assets/source-icons/google-docs.svg'
import notionLogo from '@/assets/source-icons/notion.svg'
import openClawLogo from '@/assets/source-icons/openclaw.svg'
import outlookLogo from '@/assets/source-icons/outlook.svg'
import claudeLogo from '@/assets/source-icons/claude.svg'
import codexLogo from '@/assets/source-icons/codex.svg'
import obsidianLogo from '@/assets/obsidian.svg'

export type SourceIconKind =
  | 'local-folder'
  | 'obsidian-vault'
  | 'github'
  | 'google-docs'
  | 'notion'
  | 'gmail'
  | 'outlook'
  | 'google-calendar'
  | 'openclaw'
  | 'claude'
  | 'codex'
  | 'feishu'
  | 'web-page'
  | 'ics-calendar'

type BrandedSourceIconKind = Exclude<SourceIconKind, 'local-folder' | 'web-page' | 'ics-calendar'>

const SOURCE_LOGOS: Record<BrandedSourceIconKind, string> = {
  'obsidian-vault': obsidianLogo,
  github: githubLogo,
  'google-docs': googleDocsLogo,
  notion: notionLogo,
  gmail: gmailLogo,
  outlook: outlookLogo,
  'google-calendar': googleCalendarLogo,
  openclaw: openClawLogo,
  claude: claudeLogo,
  codex: codexLogo,
  feishu: feishuLogo,
}

/** 素材自带底板（深色圆角块/白色圆/PNG 图）——可 100% 填满容器；其余是裸标,需留边防顶角。 */
const TILE_ICON_KINDS = new Set<SourceIconKind>(['github', 'notion', 'claude', 'codex', 'openclaw', 'feishu'])

export function SourceIcon({ kind, className = '' }: { kind: SourceIconKind; className?: string }) {
  const classes = `source-icon ${className}`.trim()
  if (kind === 'local-folder') return <FolderOpen className={classes} aria-hidden="true" strokeWidth={1.8} />
  if (kind === 'web-page') return <Globe className={classes} aria-hidden="true" strokeWidth={1.8} />
  if (kind === 'ics-calendar') return <CalendarDays className={classes} aria-hidden="true" strokeWidth={1.8} />

  return <img className={classes} data-fill={TILE_ICON_KINDS.has(kind) ? 'tile' : 'mark'} src={SOURCE_LOGOS[kind]} alt="" aria-hidden="true" />
}
