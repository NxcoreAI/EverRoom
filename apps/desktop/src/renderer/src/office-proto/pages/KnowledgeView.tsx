import React, { useState } from 'react'
import {
  BookOpen, Building2, ChevronLeft, ChevronRight, FolderKanban, Notebook, Plus, Users,
  type LucideIcon,
} from 'lucide-react'

import {
  type OfficeFile, files, knowledgeBases, sourceMeta,
} from '../data'
import { PageHead } from './parts'

/* 知识库图标：按库 id 映射到 lucide 图标（不再用 emoji），
 * 统一放进淡色圆角方块里；未收录的库退回 BookOpen。 */
const KB_ICONS: Record<string, LucideIcon> = {
  'kb-connector': FolderKanban,
  'kb-visual': BookOpen,
  'kb-buy': Building2,
  'kb-meet': Users,
  'kb-personal': Notebook,
}

function kbIcon(id: string): LucideIcon {
  return KB_ICONS[id] ?? BookOpen
}

export function KnowledgeView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [kbId, setKbId] = useState<string | null>(null)
  const kb = knowledgeBases.find((k) => k.id === kbId)

  if (!kb) {
    return (
      <>
        <PageHead title="知识库" hint="把邮件、会议、网页与文档汇成可引用的记忆">
          <button
            className="op-primary-btn"
            type="button"
            onClick={() => onToast('新建知识库（原型占位）')}
          >
            <Plus size={14} /> 新建知识库
          </button>
        </PageHead>
        {knowledgeBases.length === 0 ? (
          <div className="op-empty-state op-empty-state--page">
            <span className="op-empty-icon"><BookOpen size={21} /></span>
            <div className="op-empty-title">还没有知识库</div>
            <p className="op-empty-text">
              把邮件、会议、网页与文档汇成一个库，Agent 起草时就能引用其中的记忆。
            </p>
            <div className="op-empty-actions">
              <button
                className="op-primary-btn"
                type="button"
                onClick={() => onToast('新建知识库（原型占位）')}
              >
                <Plus size={14} /> 新建知识库
              </button>
            </div>
          </div>
        ) : (
          <div className="op-room-row">
            {knowledgeBases.map((k) => {
              const Icon = kbIcon(k.id)
              return (
                <button key={k.id} type="button" className="op-room-card" onClick={() => setKbId(k.id)}>
                  <span className="op-room-icon"><Icon size={20} strokeWidth={1.8} /></span>
                  <span className="op-room-title">{k.title}</span>
                  <span className="op-room-meta">
                    <span className="op-room-sources">{k.sources.length} 个来源</span>
                    <span className="op-room-updated">更新于 {k.updatedLabel}</span>
                  </span>
                  <ChevronRight size={15} className="op-room-go" aria-hidden />
                </button>
              )
            })}
          </div>
        )}
      </>
    )
  }

  const Icon = kbIcon(kb.id)
  const docSources = kb.sources.filter((s) => s.fileId)
  const memoryTotal = docSources.reduce((sum, s) => {
    const f = files.find((x) => x.id === s.fileId)
    return sum + (f?.memoryCount ?? 0)
  }, 0)

  return (
    <>
      <div className="op-kb-back">
        <button type="button" onClick={() => setKbId(null)}>
          <ChevronLeft size={14} /> 返回知识库
        </button>
      </div>
      <PageHead
        icon={<Icon size={19} strokeWidth={1.8} />}
        title={kb.title}
        hint={`来源 ${kb.sources.length} · 文档 ${docSources.length} · 记忆 ${memoryTotal} 条`}
      />
      <div className="op-list-card">
        {kb.sources.map((s) => {
          const meta = sourceMeta[s.kind]
          return (
            <button
              key={s.id}
              type="button"
              className="op-src-row"
              onClick={() => {
                const f = s.fileId ? files.find((x) => x.id === s.fileId) : undefined
                if (f) onOpenFile(f)
                else onToast('该来源暂不支持预览（原型）')
              }}
            >
              <span className={`op-mem-kind op-mem-kind--${s.kind}`}>{meta.label}</span>
              <span className="op-src-title">{s.title}</span>
              <span className="op-src-time">{s.timeLabel}</span>
              <span className={`op-src-status${s.status === 'syncing' ? ' syncing' : ''}`}>
                {s.status === 'indexed' ? '已索引' : '同步中'}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}
