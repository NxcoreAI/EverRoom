import React, { useState } from 'react'
import {
  ChevronDown, FileText, Files, Import, LayoutGrid, List, MoreHorizontal, Search, X,
} from 'lucide-react'

import { blankFile, type FileKind, type OfficeFile, kindMeta } from '../data'

/* ───────────── WPS 风格文件类型图标（自 everoffice 原型 `pages/parts.tsx`） ─────────────
   渐变圆角方块（squircle）+ 白色类型字母 + 顶部高光，
   配色与「新建」tiles 一致：W=文档 S=表格 P=演示，PDF / MD 小尺寸收成单字母。 */

const ftThemes: Record<FileKind, { from: string; to: string; letters: string }> = {
  docx: { from: '#4aa3ff', to: '#0a6fe8', letters: 'W' },
  xlsx: { from: '#4cc478', to: '#1f9450', letters: 'S' },
  pptx: { from: '#ffb340', to: '#ef7d0e', letters: 'P' },
  pdf: { from: '#ff6f61', to: '#e0362a', letters: 'PDF' },
  md: { from: '#b9bbc2', to: '#83868f', letters: 'MD' },
}

/** office 五类之外、材料库等处用到的扩展类型主题（原型同款）。 */
const extraGlyphThemes = {
  image: { from: '#b78aff', to: '#7d3fe0', letters: 'IMG' },
  txt: { from: '#4ec3d4', to: '#0f92a3', letters: 'TXT' },
  other: { from: '#b9bbc2', to: '#83868f', letters: 'FILE' },
} as const

const allGlyphThemes: Record<string, { from: string; to: string; letters: string }> = {
  ...ftThemes,
  ...extraGlyphThemes,
}

/** 彩色 squircle 类型图标（通用版）：kind 取 FileKind 或扩展类型（image/txt/other），未知回落 other。 */
export function FileGlyphIcon({
  kind, size = 28, className,
}: {
  kind: string
  size?: number
  className?: string
}) {
  const th = allGlyphThemes[kind] ?? allGlyphThemes.other
  // 渐变 id 每实例唯一：url(#id) 会解析到文档序第一个同名 def，
  // 若它挂在 display:none 的标签页里，所有引用处一起变透明
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '')
  const gid = `ftg-${kind}-${uid}`
  // 小尺寸（标签栏）下多字母会糊成一片，收成首字母靠颜色区分
  const letters = size < 24 && th.letters.length > 1 ? th.letters[0] : th.letters
  const fs = letters.length > 1 ? 12.5 : 20
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      className={className ? `op-ft-icon ${className}` : 'op-ft-icon'}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={th.from} />
          <stop offset="1" stopColor={th.to} />
        </linearGradient>
        <linearGradient id={`${gid}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="11.5" fill={`url(#${gid})`} />
      <path d="M1.5 13 A11.5 11.5 0 0 1 13 1.5 H35 A11.5 11.5 0 0 1 46.5 13 V21 H1.5 Z" fill={`url(#${gid}-g)`} />
      <text
        x="24" y="25.5" textAnchor="middle" dominantBaseline="central"
        fill="#fff" fontWeight="800" fontSize={fs}
        letterSpacing={letters.length > 1 ? 0.8 : 0}
        fontFamily="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
      >
        {letters}
      </text>
    </svg>
  )
}

export function FileTypeIcon({
  kind, size = 28, className,
}: {
  kind: FileKind
  size?: number
  className?: string
}) {
  return <FileGlyphIcon kind={kind} size={size} className={className} />
}

/** 资料库文件夹图标（原型同款）：macOS 风格蓝色文件夹（深色后片 + 渐变前片）。 */
export function FolderGlyphIcon({
  size = 32, className,
}: {
  size?: number
  className?: string
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '')
  const gid = `wfolder-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      className={className ? `op-ft-icon ${className}` : 'op-ft-icon'}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ec6ff" />
          <stop offset="1" stopColor="#1e8fe8" />
        </linearGradient>
      </defs>
      <path d="M4 13c0-2.2 1.8-4 4-4h9.5c1.1 0 2.2.47 3 1.3L24 14.5h16c2.2 0 4 1.8 4 4V21H4z" fill="#1479cf" />
      <path d="M4 18.5h40v16.5c0 2.2-1.8 4-4 4H8c-2.2 0-4-1.8-4-4z" fill={`url(#${gid})`} />
      <path d="M4 18.5h40v2H4z" fill="#fff" opacity="0.2" />
    </svg>
  )
}

/** 文件行（表格式单行）：图标 + 文件名 + 修改时间 + 大小 + 悬停更多。 */
export function FileRow({
  file, onOpen, onMore,
}: {
  file: OfficeFile
  onOpen: () => void
  onMore?: () => void
}) {
  return (
    <div
      className="op-file-grid op-file-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <FileTypeIcon kind={file.kind} size={34} />
      <span className="op-file-name">{file.name}</span>
      <span className="op-file-time">{file.updatedLabel}</span>
      <span className="op-file-size">{file.sizeLabel}</span>
      {onMore && (
        <button
          className="op-file-more"
          type="button"
          title="更多操作"
          onClick={(e) => { e.stopPropagation(); onMore() }}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    </div>
  )
}

/** 文件列表卡：筛选标签 + 搜索 + 视图切换 + 表头 + 行；空态给导入/新建两个动作。 */
export function FileTable({
  files, onOpenFile, onToast,
}: {
  files: OfficeFile[]
  onOpenFile: (f: OfficeFile) => void
  onToast?: (msg: string) => void
}) {
  const [kindFilter, setKindFilter] = useState<FileKind | 'all'>('all')
  const [q, setQ] = useState('')

  const shown = files.filter((f) => {
    if (kindFilter !== 'all' && f.kind !== kindFilter) return false
    if (q && !f.name.toLowerCase().includes(q.trim().toLowerCase())) return false
    return true
  })

  const tabs: { key: FileKind | 'all'; label: string }[] = [
    { key: 'all', label: '全部' },
    ...(['docx', 'xlsx', 'pptx', 'pdf', 'md'] as FileKind[]).map(
      (k) => ({ key: k, label: kindMeta[k].label }),
    ),
  ]

  return (
    <div className="op-file-list">
      <div className="op-ft-bar">
        <Seg items={tabs} value={kindFilter} onChange={setKindFilter} />
        <div className="op-ft-search">
          <Search size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索文件名…"
            aria-label="搜索文件名"
          />
          {q && (
            <button className="op-ft-search-clear" type="button" title="清空" onClick={() => setQ('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="op-ft-views" role="group" aria-label="视图切换">
          <button
            className="active"
            type="button"
            title="列表视图"
            aria-pressed="true"
          >
            <List size={15} />
          </button>
          <button
            type="button"
            title="网格视图（原型暂未开放）"
            aria-pressed="false"
            onClick={() => onToast?.('网格视图（原型暂未开放）')}
          >
            <LayoutGrid size={15} />
          </button>
        </div>
      </div>

      <div className="op-file-card">
        <div className="op-file-grid op-file-head">
          <span />
          <span>文件名</span>
          <span className="op-file-sort">修改时间 <ChevronDown size={11} /></span>
          <span>大小</span>
          <span />
        </div>

        {shown.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            onOpen={() => onOpenFile(f)}
            onMore={onToast ? () => onToast('文件菜单：重命名 / 移动 / 分享（原型）') : undefined}
          />
        ))}

        {shown.length === 0 && (files.length === 0 ? (
          <div className="op-empty-state">
            <span className="op-empty-icon"><Files size={21} /></span>
            <div className="op-empty-title">还没有文件</div>
            <p className="op-empty-text">
              导入一份文件，或从空白文档开始。之后它就会出现在记忆里，随时可以调用。
            </p>
            <div className="op-empty-actions">
              <button
                className="op-primary-btn"
                type="button"
                onClick={() => onToast?.('导入文件（原型占位）')}
              >
                <Import size={14} /> 导入文件
              </button>
              <button
                className="op-ghost-btn"
                type="button"
                onClick={() => onOpenFile(blankFile('docx'))}
              >
                <FileText size={14} /> 新建文档
              </button>
            </div>
          </div>
        ) : (
          <div className="op-empty">没有匹配的文件</div>
        ))}
      </div>
    </div>
  )
}

export function PageHead({
  title, hint, icon, children,
}: {
  title: string
  hint?: string
  icon?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <header className="op-page-head">
      {icon && <span className="op-page-head-icon" aria-hidden>{icon}</span>}
      <div className="op-page-head-text">
        <h1>{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
      {children && <div className="op-page-head-actions">{children}</div>}
    </header>
  )
}

/** 页内标签栏（类型筛选 / Agent 六标签 / 连接器分类共用，样式统一）。 */
export function Seg<T extends string>({
  items, value, onChange,
}: {
  items: { key: T; label: string }[]
  value: T
  onChange: (k: T) => void
}) {
  return (
    <div className="op-seg" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={value === it.key}
          className={`op-seg-btn${value === it.key ? ' active' : ''}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
