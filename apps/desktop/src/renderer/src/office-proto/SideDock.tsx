import React, { useRef, useState } from 'react'
import { Bot, FolderOpen, History } from 'lucide-react'

import { type OfficeFile } from './data'
import { AgentChatDock } from './AgentChatDock'
import { MaterialsPanel } from './MaterialsPanel'
import { HistoryPanel } from './HistoryPanel'

/**
 * 编辑页右侧可伸缩停靠栏：WPS AI 式「内容 + 窗口边缘竖条图标切换」。
- 展开时内容区在左、图标条贴窗口右缘；点激活图标收起，收起态点任意图标展开
 - 左缘可拖拽调宽（280–560）；原生编辑器随 ResizeObserver 自动让位
 - 状态放在组件内：每个编辑标签页各自记忆展开状态与宽度
 */

type DockTab = 'agent' | 'materials' | 'history'

const TABS: Array<{ key: DockTab; label: string; icon: React.ReactNode }> = [
  { key: 'agent', label: 'Agent', icon: <Bot size={17} /> },
  { key: 'materials', label: '材料', icon: <FolderOpen size={17} /> },
  { key: 'history', label: '历史记录', icon: <History size={17} /> },
]

export function SideDock({ file, onToast }: { file: OfficeFile; onToast: (msg: string) => void }) {
  const [tab, setTab] = useState<DockTab>('agent')
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(360)
  const dragging = useRef(false)

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(560, Math.max(280, startWidth + (startX - ev.clientX)))
      setWidth(next)
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activate = (key: DockTab) => {
    if (!collapsed && tab === key) setCollapsed(true)
    else {
      setTab(key)
      setCollapsed(false)
    }
  }

  return (
    <div className={`op-dock${collapsed ? ' collapsed' : ''}`} style={collapsed ? undefined : { width }}>
      {!collapsed && (
        <>
          <div className="op-dock-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
          <div className="op-dock-body">
            {tab === 'agent' && <AgentChatDock file={file} onToast={onToast} />}
            {tab === 'materials' && <MaterialsPanel file={file} onToast={onToast} />}
            {tab === 'history' && <HistoryPanel file={file} onToast={onToast} />}
          </div>
        </>
      )}
      <div className="op-dock-strip">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`op-dock-strip-btn${!collapsed && tab === t.key ? ' active' : ''}`}
            title={t.label}
            onClick={() => activate(t.key)}
          >
            {t.icon}
          </button>
        ))}
      </div>
    </div>
  )
}
