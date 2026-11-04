import React, { useState } from 'react'
import { Plus, X } from 'lucide-react'

import { type MaterialItem, type OfficeFile, defaultMaterials, fileMaterials, materialKindMeta } from './data'

/**
 * 材料面板：当前文件已添加材料的扁平卡片列表。卡片可删除；底部入口打开
 * 系统文件选择器（office:pick-materials IPC）从本地添加。
 */

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function MaterialsPanel({ file, onToast }: { file: OfficeFile; onToast: (msg: string) => void }) {
  const [items, setItems] = useState<MaterialItem[]>(() => fileMaterials[file.id] ?? defaultMaterials)
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)
    try {
      const picked = (await window.desktop?.office.pickMaterials()) ?? []
      if (picked.length === 0) return
      const added: MaterialItem[] = picked.map((p, i) => ({
        id: `local-${Date.now()}-${i}`,
        kind: 'file',
        title: p.name,
        excerpt: `本地文件 · ${formatSize(p.size)}`,
        meta: '本地文件',
        addedLabel: '刚刚添加',
      }))
      setItems((prev) => [...prev, ...added])
      onToast(`已添加 ${added.length} 份材料，Agent 可直接引用`)
    } finally {
      setAdding(false)
    }
  }

  const remove = (item: MaterialItem) => {
    setItems((prev) => prev.filter((m) => m.id !== item.id))
    onToast(`已移除材料「${item.title}」`)
  }

  return (
    <div className="op-materials">
      <div className="op-materials-list">
        <div className="op-materials-hint">Agent 处理这份文件时可以引用的材料</div>
        {items.length === 0 && <div className="op-empty">还没有材料，从底部添加一份试试</div>}
        {items.map((m) => {
          const meta = materialKindMeta[m.kind]
          return (
            <div key={m.id} className="op-material-card">
              <span className="op-material-icon">{meta.icon}</span>
              <div className="op-material-body">
                <div className="op-material-title">{m.title}</div>
                <div className="op-material-excerpt">「{m.excerpt}」</div>
                <div className="op-material-meta">{m.meta} · {m.addedLabel}</div>
              </div>
              <button type="button" className="op-material-del" title="移除材料" onClick={() => remove(m)}>
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="op-materials-foot">
        <button type="button" className="op-materials-add" disabled={adding} onClick={() => void add()}>
          <Plus size={14} /> {adding ? '选择文件…' : '添加材料（本地文件）'}
        </button>
      </div>
    </div>
  )
}
