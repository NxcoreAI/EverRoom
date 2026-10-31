import React, { useEffect, useState } from 'react'
import {
  Clock, FolderOpen, Bot, Library, Plug, Settings, X, Home, Plus,
} from 'lucide-react'

import everroomAppIcon from '@/assets/everroom-app-icon.png'
import { useOptionalAccount } from '@/state/AccountContext'

import { type MenuKey, type OfficeFile, blankFile } from './data'
import { FileTypeIcon } from './pages/parts'
import { RecentView } from './pages/RecentView'
import { AllFilesView } from './pages/AllFilesView'
import { AgentView } from './pages/AgentView'
import { KnowledgeView } from './pages/KnowledgeView'
import { ConnectorsView } from './pages/ConnectorsView'
import { EditorView } from './EditorView'
import { SettingsView } from './SettingsView'

export function OfficeProto() {
  // 标签栏状态：activeId 为 null 表示停在主页 tab。
  const [tabs, setTabs] = useState<OfficeFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // 设置页：侧栏账户栏的齿轮打开（覆盖整个窗口，含账号/登录、模型、连接器等）。
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  const openFile = (file: OfficeFile) => {
    setTabs((prev) => (prev.some((t) => t.id === file.id) ? prev : [...prev, file]))
    setActiveId(file.id)
  }

  const closeTab = (id: string) => {
    const target = tabs.find((t) => t.id === id)
    // 真实文件走文件库预览实例（脏关闭守卫在 officePreviewRegistry），mock 文件走原型桥。
    const closing = target?.realCatalog
      ? window.nxcore?.office.closeInstance(target.realCatalog.id)
      : window.desktop?.office.close(id)
    // 先过主进程的脏关闭守卫（GenOffice 保存对话框里点取消 → 保留标签）。
    void Promise.resolve(closing)
      .then((closed) => {
        if (closed === false) return
        setTabs((prev) => {
          const idx = prev.findIndex((t) => t.id === id)
          const next = prev.filter((t) => t.id !== id)
          if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null)
          return next
        })
      })
      // 关闭失败（主窗口不可用等）保留标签页，别让 rejection 冒成全局错误。
      .catch(() => undefined)
  }

  return (
    <div className="op-root">
      {/* 标签栏是窗口级最顶层；侧边栏属于「主页」标签页内部 */}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onHome={() => setActiveId(null)}
        onActivate={setActiveId}
        onClose={closeTab}
        onAdd={() => openFile(blankFile('docx'))}
      />
      <div className="op-window-body">
        <div className={activeId === null ? 'op-tabpane active' : 'op-tabpane'}>
          <HomeView
            onOpenFile={openFile}
            onToast={setToast}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
        {tabs.map((t) => (
          <div key={t.id} className={t.id === activeId ? 'op-tabpane active' : 'op-tabpane'}>
            <EditorView file={t} onToast={setToast} />
          </div>
        ))}
      </div>
      {toast && <div className="op-toast">{toast}</div>}
      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function TabBar({
  tabs, activeId, onHome, onActivate, onClose, onAdd,
}: {
  tabs: OfficeFile[]
  activeId: string | null
  onHome: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div className="op-tabbar">
      <div className="op-win-dots" aria-hidden>
        <span className="red" /><span className="yellow" /><span className="green" />
      </div>
      <button
        className={`op-tab home${activeId === null ? ' active' : ''}`}
        type="button"
        onClick={onHome}
        title="主页"
      >
        <Home size={15} />
        <span>主页</span>
      </button>
      <div className="op-tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`op-tab${activeId === t.id ? ' active' : ''}`}
            onClick={() => onActivate(t.id)}
            title={t.name}
          >
            <span className="op-tab-icon">
              <FileTypeIcon kind={t.kind} size={15} />
            </span>
            <span className="op-tab-name">{t.name}</span>
            <button
              className="op-tab-close"
              type="button"
              title="关闭标签"
              onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button className="op-tab-add" type="button" title="新建文字文档" onClick={onAdd}>
        <Plus size={15} />
      </button>
    </div>
  )
}

/** 主页标签页内部的侧边栏（品牌 + 五个一级菜单 + 账户），不分组。 */
function Sidebar({
  active, onSelect, onOpenSettings,
}: {
  active: MenuKey
  onSelect: (k: MenuKey) => void
  onOpenSettings: () => void
}) {
  // 真实登录态（Electron 里由 AccountProvider 提供）；无 provider（浏览器预览/单测）
  // 时退回登录入口文案，齿轮始终可点开设置页。
  const accountState = useOptionalAccount()
  const account = accountState?.account ?? null
  const accountName = account?.user?.name || account?.user?.email || account?.user?.phone || null
  const signedIn = account?.authenticated === true
  const userbarName = signedIn && accountName ? accountName : signedIn ? '已登录' : '登录 / 设置'
  const avatarText = signedIn && accountName ? accountName.trim().slice(0, 1).toUpperCase() : '登'
  const menus: { key: MenuKey; label: string; icon: React.ReactNode }[] = [
    { key: 'recent', label: '最近', icon: <Clock size={18} /> },
    { key: 'files', label: '所有文件', icon: <FolderOpen size={18} /> },
    { key: 'agent', label: 'Agent', icon: <Bot size={18} /> },
    { key: 'kb', label: '知识库', icon: <Library size={18} /> },
    { key: 'connectors', label: '连接器', icon: <Plug size={18} /> },
  ]
  return (
    <aside className="op-sidebar">
      <div className="op-brand">
        {/* EverRoomMac 品牌标：项目原有 app 图标（原型占位 "E" 字方块已替换） */}
        <img className="op-brand-mark" src={everroomAppIcon} alt="" aria-hidden="true" draggable={false} />
        <div className="op-brand-text">
          <span className="op-brand-name">EverRoom</span>
          <span className="op-brand-sub">Office</span>
        </div>
      </div>

      <nav className="op-nav">
        <div className="op-nav-section">
          {menus.map((m) => (
            <NavItem
              key={m.key}
              icon={m.icon}
              label={m.label}
              active={active === m.key}
              onClick={() => onSelect(m.key)}
            />
          ))}
        </div>
      </nav>
      <div className="op-sidebar-foot">
        <button
          className="op-userbar"
          type="button"
          title="账户与设置"
          aria-label="账户与设置"
          aria-haspopup="dialog"
          onClick={onOpenSettings}
        >
          <div className="op-avatar" aria-hidden="true">{avatarText}</div>
          <span className="op-userbar-name">{userbarName}</span>
          <span className="op-userbar-gear"><Settings size={15} /></span>
        </button>
      </div>
    </aside>
  )
}

function NavItem({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button className={`op-nav-item${active ? ' active' : ''}`} type="button" onClick={onClick}>
      <span className="op-nav-icon">{icon}</span>
      <span className="op-nav-label">{label}</span>
    </button>
  )
}

function HomeView({
  onOpenFile, onToast, onOpenSettings,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
  onOpenSettings: () => void
}) {
  const [view, setView] = useState<MenuKey>('recent')

  return (
    <div className="op-home">
      <Sidebar active={view} onSelect={setView} onOpenSettings={onOpenSettings} />
      <div className="op-home-main">
        <div className="op-scroll">
          {view === 'recent' && (
            <RecentView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'files' && (
            <AllFilesView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'agent' && (
            <AgentView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'kb' && (
            <KnowledgeView onOpenFile={onOpenFile} onToast={onToast} />
          )}
          {view === 'connectors' && (
            <ConnectorsView onToast={onToast} />
          )}
        </div>
      </div>
    </div>
  )
}
