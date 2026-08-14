import {
  Bold,
  File,
  FileText,
  FolderOpen,
  Italic,
  Link2,
  PanelLeft,
  Plus,
  Redo2,
  Search,
  Share2,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { ContextRoomRecord } from '../types'

export function CloudDocumentPane({ room }: { room: ContextRoomRecord }) {
  const [documentId, setDocumentId] = useState(room.materials[0]?.id ?? 'new')
  const [saveState, setSaveState] = useState('已保存')
  const saveTimerRef = useRef<number | null>(null)
  const activeDocument = room.materials.find((material) => material.id === documentId) ?? room.materials[0]

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
  }, [])

  const markChanged = () => {
    setSaveState('正在保存')
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => setSaveState('已保存'), 500)
  }

  return (
    <div className="cr-doc-workspace">
      <aside className="cr-doc-sidebar">
        <header>
          <div><strong>云文档</strong><small>{room.title}</small></div>
          <button type="button" aria-label="新建文档" title="新建文档"><Plus aria-hidden="true" strokeWidth={1.8} /></button>
        </header>
        <label><Search aria-hidden="true" strokeWidth={1.8} /><input aria-label="搜索文档" placeholder="搜索文档" /></label>
        <div className="cr-doc-tree">
          <span><FolderOpen aria-hidden="true" strokeWidth={1.8} />Room 文档</span>
          {room.materials.filter((item) => item.type === '文档').map((item) => (
            <button key={item.id} type="button" aria-pressed={documentId === item.id} onClick={() => setDocumentId(item.id)}>
              <FileText aria-hidden="true" strokeWidth={1.8} />
              <span><strong>{item.title}</strong><small>{item.updated}</small></span>
            </button>
          ))}
          <button type="button" aria-pressed={documentId === 'new'} onClick={() => setDocumentId('new')}>
            <File aria-hidden="true" strokeWidth={1.8} />
            <span><strong>未命名文档</strong><small>草稿</small></span>
          </button>
        </div>
      </aside>

      <section className="cr-doc-editor">
        <header className="cr-doc-topbar">
          <div>
            <PanelLeft aria-hidden="true" strokeWidth={1.8} />
            <span>{activeDocument?.title ?? '未命名文档'}</span>
            <small>{saveState}</small>
          </div>
          <div>
            <button type="button" title="复制链接" aria-label="复制链接"><Link2 aria-hidden="true" strokeWidth={1.8} /></button>
            <button type="button" className="cr-doc-share"><Share2 aria-hidden="true" strokeWidth={1.8} />分享</button>
          </div>
        </header>
        <div className="cr-doc-toolbar" aria-label="文档工具栏">
          <button type="button" title="撤销" aria-label="撤销"><Undo2 aria-hidden="true" strokeWidth={1.8} /></button>
          <button type="button" title="重做" aria-label="重做"><Redo2 aria-hidden="true" strokeWidth={1.8} /></button>
          <span />
          <button type="button" title="粗体" aria-label="粗体"><Bold aria-hidden="true" strokeWidth={1.8} /></button>
          <button type="button" title="斜体" aria-label="斜体"><Italic aria-hidden="true" strokeWidth={1.8} /></button>
          <button type="button" title="插入链接" aria-label="插入链接"><Link2 aria-hidden="true" strokeWidth={1.8} /></button>
          <span />
          <button type="button" className="cr-ai-action"><Sparkles aria-hidden="true" strokeWidth={1.8} />Ask Nex</button>
        </div>
        <div className="cr-doc-scroll">
          <article className="cr-document-page" contentEditable suppressContentEditableWarning onInput={markChanged}>
            <h1>{activeDocument?.title ?? '未命名文档'}</h1>
            <p className="cr-doc-lead">{room.description}</p>
            <h2>当前进展</h2>
            <p>当前 Room 已聚合产品基线、技术方案和评审纪要。团队正在确认首发范围，并将关键决策沉淀为可追溯记忆。</p>
            <blockquote>来源：开源版产品基线 / 首批内测范围确认</blockquote>
            <h2>下一步</h2>
            <ul><li>完成 Context Room 工作台迁移</li><li>验证本地数据源的版本追踪</li><li>补充后端服务的启停和健康检查</li></ul>
          </article>
        </div>
      </section>
    </div>
  )
}
