import React, { useState } from 'react'
import {
  ChevronDown, FileText, Files, Import, LayoutGrid, List, MoreHorizontal, Search, X,
} from 'lucide-react'

import { blankFile, type FileKind, type OfficeFile, kindMeta } from '../data'

/* ───────────── 文件类型图标 ─────────────
   暖纸体系下的统一文件图标：低透明度色块 + 同色墨字。
   色相全部取自 --ui-icon-* token，同一套比例从 15px（标签栏）缩放到 46px（新建卡），
   不再用高饱和渐变，免得在暖纸底上抢戏。 */

const ftThemes: Record<FileKind, { ink: string; letters: string }> = {
  docx: { ink: 'var(--ui-icon-doc)', letters: 'W' },
  xlsx: { ink: 'var(--ui-icon-sheet)', letters: 'S' },
  pptx: { ink: 'var(--ui-icon-slide)', letters: 'P' },
  pdf: { ink: 'var(--ui-icon-pdf)', letters: 'PDF' },
  md: { ink: 'var(--ui-icon-md)', letters: 'MD' },
}

export function FileTypeIcon({
  kind, size = 28, className,
}: {
  kind: FileKind
  size?: number
  className?: string
}) {
  const th = ftThemes[kind]
  // 小尺寸（标签栏）下多字母会糊成一片，收成首字母靠颜色区分
  const letters = size < 24 && th.letters.length > 1 ? th.letters[0] : th.letters
  const fs = letters.length > 1 ? 13 : 20
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      className={className ? `op-ft-icon ${className}` : 'op-ft-icon'}
    >
      <rect
        x="1.25"
        y="1.25"
        width="45.5"
        height="45.5"
        rx="12"
        strokeWidth="1.5"
        style={{ fill: th.ink, fillOpacity: 0.12, stroke: th.ink, strokeOpacity: 0.18 }}
      />
      <text
        x="24"
        y="25"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fs}
        fontWeight="650"
        letterSpacing={letters.length > 1 ? 0.6 : 0}
        fontFamily="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
        style={{ fill: th.ink }}
      >
        {letters}
      </text>
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
