import {
  ArrowLeft,
  BarChart3,
  Bold,
  Bookmark,
  CalendarDays,
  Check,
  CheckSquare2,
  ChevronRight,
  Clock3,
  File,
  FileText,
  Flag,
  FolderOpen,
  Italic,
  Layers3,
  Link2,
  Mail,
  Maximize2,
  MoreHorizontal,
  Network,
  PanelLeft,
  Plus,
  Redo2,
  Search,
  Share2,
  Sparkles,
  Target,
  Trash2,
  Undo2,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { ContextGraphCanvas, type ContextGraphCanvasHandle } from './ContextGraphCanvas'
import {
  createMemoryGraphData,
  createRoomGraphData,
  INITIAL_ROOMS,
  ROOM_RECOMMENDATIONS,
} from './data'
import type {
  ContextGraphData,
  ContextRoomRecord,
  RoomKind,
  RoomPane,
  RoomRecommendation,
} from './types'

import './ContextRoomPage.css'

const ROOM_KIND_ICONS: Record<RoomKind, LucideIcon> = {
  项目: Layers3,
  主题: Network,
  人物: UserRound,
  长期目标: Target,
  议题: Flag,
  事件: CalendarDays,
}

const PANE_ITEMS: Array<{ id: RoomPane; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'documents', label: '云文档', icon: FileText },
  { id: 'relations', label: '关系', icon: Share2 },
  { id: 'memories', label: '记忆', icon: Bookmark },
  { id: 'schedule', label: '日程', icon: CalendarDays },
  { id: 'tasks', label: '任务', icon: CheckSquare2 },
  { id: 'mails', label: '邮件', icon: Mail },
]

function RoomIcon({ kind }: { kind: RoomKind }) {
  const Icon = ROOM_KIND_ICONS[kind]
  return <span className="cr-room-icon" data-kind={kind}><Icon aria-hidden="true" /></span>
}

function SectionTitle({ label, title }: { label: string; title: string }) {
  return <div className="cr-section-title"><span>{label}</span><h2>{title}</h2></div>
}

function RoomCard({ room, onOpen, onDelete }: { room: ContextRoomRecord; onOpen: () => void; onDelete: () => void }) {
  return (
    <article className="cr-room-card">
      <button type="button" className="cr-room-card-main" onClick={onOpen}>
        <RoomIcon kind={room.kind} />
        <span className="cr-room-card-copy">
          <strong>{room.title}</strong>
          <span>{room.description}</span>
          <small><Clock3 aria-hidden="true" />{room.updated}</small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
      <details className="cr-room-menu">
        <summary aria-label={`${room.title} 更多操作`}><MoreHorizontal aria-hidden="true" /></summary>
        <div><button type="button" onClick={onDelete}><Trash2 aria-hidden="true" />删除</button></div>
      </details>
    </article>
  )
}

function NewRoomDialog({
  recommendation,
  onClose,
  onCreate,
}: {
  recommendation: RoomRecommendation | null
  onClose: () => void
  onCreate: (input: { title: string; kind: RoomKind; description: string }) => void
}) {
  return (
    <div className="cr-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <form className="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-new-room-title" onSubmit={(event) => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        onCreate({
          title: String(values.get('title') ?? '').trim(),
          kind: String(values.get('kind') ?? '项目') as RoomKind,
          description: String(values.get('description') ?? '').trim(),
        })
      }}>
        <header><div><span>工作边界</span><h2 id="cr-new-room-title">新建 Context Room</h2></div><button type="button" aria-label="关闭" onClick={onClose}><X aria-hidden="true" /></button></header>
        <label><span>名称</span><input name="title" required maxLength={40} autoFocus defaultValue={recommendation?.title} /></label>
        <label><span>类型</span><select name="kind" defaultValue={recommendation?.kind ?? '项目'}>{Object.keys(ROOM_KIND_ICONS).map((kind) => <option key={kind}>{kind}</option>)}</select></label>
        <label><span>初始说明</span><textarea name="description" rows={4} defaultValue={recommendation?.reason} placeholder="描述目标、范围或需要聚合的资料" /></label>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button"><Plus aria-hidden="true" />创建 Room</button></footer>
      </form>
    </div>
  )
}

function GraphWorkspace({
  data,
  rooms,
  selectedId,
  onSelect,
  onOpen,
  compact = false,
}: {
  data: ContextGraphData
  rooms?: ContextRoomRecord[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpen?: (id: string) => void
  compact?: boolean
}) {
  const graphRef = useRef<ContextGraphCanvasHandle>(null)
  const selected = data.nodes.find((node) => node.id === selectedId) ?? null
  const selectedRoom = rooms?.find((room) => room.id === selectedId)
  return (
    <div className={`cr-graph-workspace${selected ? ' is-selected' : ''}`}>
      <div className="cr-graph-stage">
        <ContextGraphCanvas ref={graphRef} data={data} selectedId={selectedId} compact={compact} onSelect={onSelect} onOpen={onOpen} />
        <button type="button" className="cr-fit-button" aria-label="适应图谱画布" title="适应画布" onClick={() => void graphRef.current?.fitView()}><Maximize2 aria-hidden="true" /></button>
      </div>
      {selected ? (
        <aside className="cr-graph-inspector">
          <header><span>节点详情</span><button type="button" aria-label="关闭节点详情" onClick={() => onSelect(null)}><X aria-hidden="true" /></button></header>
          {selected.kind === 'fact' ? <span className="cr-node-badge">事实</span> : <RoomIcon kind={selected.kind} />}
          <h3>{selected.label}</h3>
          <p>{selected.description}</p>
          {selectedRoom ? <dl><div><dt>关联人物</dt><dd>{selectedRoom.people.join('、') || '暂无'}</dd></div><div><dt>相关资料</dt><dd>{selectedRoom.materials.length} 项</dd></div><div><dt>已沉淀记忆</dt><dd>{selectedRoom.memories.length} 条</dd></div></dl> : null}
          {selectedRoom && onOpen ? <button type="button" className="primary-button" onClick={() => onOpen(selectedRoom.id)}>打开 Room</button> : null}
        </aside>
      ) : null}
    </div>
  )
}

function ContextRoomHome({
  rooms,
  onOpen,
  onCreate,
  onDelete,
}: {
  rooms: ContextRoomRecord[]
  onOpen: (id: string) => void
  onCreate: (recommendation?: RoomRecommendation) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null)
  const graphData = useMemo(() => createRoomGraphData(rooms), [rooms])
  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? rooms.filter((room) => room.title.toLocaleLowerCase().includes(normalized)) : rooms
  }, [query, rooms])

  return (
    <div className="cr-page cr-home" data-testid="context-room-page">
      <div className="cr-home-layout">
        <section className="cr-section">
          <SectionTitle label="推荐" title="推荐的 Room" />
          <div className="cr-recommendation-grid">
            {ROOM_RECOMMENDATIONS.map((item) => (
              <button key={item.id} type="button" className="cr-recommendation" onClick={() => onCreate(item)}>
                <RoomIcon kind={item.kind} />
                <span><strong>{item.title}</strong><small>{item.reason}</small></span>
                <span className="cr-count"><Layers3 aria-hidden="true" />{item.materialCount}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="cr-section">
          <div className="cr-room-toolbar">
            <div><SectionTitle label="我的" title="我的 Room" /><button type="button" className="cr-icon-button" aria-label="新建 Room" title="新建 Room" onClick={() => onCreate()}><Plus aria-hidden="true" /></button></div>
            <label className="cr-search"><Search aria-hidden="true" /><input type="search" aria-label="搜索我的 Room" placeholder="搜索我的 Room" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          </div>
          <div className="cr-room-grid">
            {visibleRooms.map((room) => <RoomCard key={room.id} room={room} onOpen={() => onOpen(room.id)} onDelete={() => onDelete(room.id)} />)}
            {!visibleRooms.length ? <div className="cr-empty"><Layers3 aria-hidden="true" /><h3>没有匹配的 Room</h3><p>调整关键词，或创建一个新 Room。</p></div> : null}
          </div>
        </section>

        <section className="cr-section cr-graph-section">
          <SectionTitle label="关系" title="Room 关系图谱" />
          <GraphWorkspace data={graphData} rooms={rooms} selectedId={selectedGraphId} onSelect={setSelectedGraphId} onOpen={onOpen} />
        </section>
      </div>
    </div>
  )
}

function PaneRail({ activePane, onSelect }: { activePane: RoomPane; onSelect: (pane: RoomPane) => void }) {
  return (
    <nav className="cr-pane-rail" aria-label="Context Room 详情">
      {PANE_ITEMS.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" aria-label={label} title={label} aria-pressed={activePane === id} onClick={() => onSelect(id)}><Icon aria-hidden="true" /></button>
      ))}
    </nav>
  )
}

function OverviewPane({ room, onSelect }: { room: ContextRoomRecord; onSelect: (pane: RoomPane) => void }) {
  return (
    <div className="cr-overview">
      <section className="cr-overview-summary">
        <div><span>当前目标</span><h2>{room.description}</h2><p>已聚合 {room.materials.length} 项资料，所有 Agent 输出将保留到原始来源的引用。</p></div>
        <span className="cr-health"><Check aria-hidden="true" />上下文完整</span>
      </section>
      <div className="cr-metrics">
        <button type="button" onClick={() => onSelect('documents')}><FileText aria-hidden="true" /><span><strong>{room.materials.length}</strong><small>资料</small></span><ChevronRight aria-hidden="true" /></button>
        <button type="button" onClick={() => onSelect('memories')}><Bookmark aria-hidden="true" /><span><strong>{room.memories.length}</strong><small>记忆</small></span><ChevronRight aria-hidden="true" /></button>
        <button type="button" onClick={() => onSelect('tasks')}><CheckSquare2 aria-hidden="true" /><span><strong>{room.tasks.filter((task) => !task.done).length}</strong><small>待办</small></span><ChevronRight aria-hidden="true" /></button>
      </div>
      <div className="cr-overview-columns">
        <section className="cr-panel">
          <header><h2>最近资料</h2><button type="button" onClick={() => onSelect('documents')}>全部<ChevronRight aria-hidden="true" /></button></header>
          <div className="cr-resource-list">{room.materials.map((material) => <button type="button" key={material.id} onClick={() => onSelect('documents')}><span className="cr-file-icon"><FileText aria-hidden="true" /></span><span><strong>{material.title}</strong><small>{material.type} / {material.updated}</small></span><ChevronRight aria-hidden="true" /></button>)}</div>
        </section>
        <section className="cr-panel">
          <header><h2>参与人物</h2><Users aria-hidden="true" /></header>
          <div className="cr-people-list">{room.people.map((person, index) => <div key={person}><span>{person.slice(0, 1)}</span><div><strong>{person}</strong><small>{index === 0 ? 'Room 负责人' : '参与者'}</small></div></div>)}</div>
          <div className="cr-tags">{room.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
        </section>
      </div>
    </div>
  )
}

function CloudDocumentPane({ room }: { room: ContextRoomRecord }) {
  const [documentId, setDocumentId] = useState(room.materials[0]?.id ?? 'new')
  const activeDocument = room.materials.find((material) => material.id === documentId) ?? room.materials[0]
  const [saveState, setSaveState] = useState('已保存')
  return (
    <div className="cr-doc-workspace">
      <aside className="cr-doc-sidebar">
        <header><div><strong>云文档</strong><small>{room.title}</small></div><button type="button" aria-label="新建文档" title="新建文档"><Plus aria-hidden="true" /></button></header>
        <label><Search aria-hidden="true" /><input aria-label="搜索文档" placeholder="搜索文档" /></label>
        <div className="cr-doc-tree"><span><FolderOpen aria-hidden="true" />Room 文档</span>{room.materials.filter((item) => item.type === '文档').map((item) => <button key={item.id} type="button" aria-pressed={documentId === item.id} onClick={() => setDocumentId(item.id)}><FileText aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.updated}</small></span></button>)}<button type="button" aria-pressed={documentId === 'new'} onClick={() => setDocumentId('new')}><File aria-hidden="true" /><span><strong>未命名文档</strong><small>草稿</small></span></button></div>
      </aside>
      <section className="cr-doc-editor">
        <header className="cr-doc-topbar"><div><PanelLeft aria-hidden="true" /><span>{activeDocument?.title ?? '未命名文档'}</span><small>{saveState}</small></div><div><button type="button" title="复制链接" aria-label="复制链接"><Link2 aria-hidden="true" /></button><button type="button" className="cr-doc-share"><Share2 aria-hidden="true" />分享</button></div></header>
        <div className="cr-doc-toolbar" aria-label="文档工具栏"><button type="button" title="撤销" aria-label="撤销"><Undo2 aria-hidden="true" /></button><button type="button" title="重做" aria-label="重做"><Redo2 aria-hidden="true" /></button><span /><button type="button" title="粗体" aria-label="粗体"><Bold aria-hidden="true" /></button><button type="button" title="斜体" aria-label="斜体"><Italic aria-hidden="true" /></button><button type="button" title="插入链接" aria-label="插入链接"><Link2 aria-hidden="true" /></button><span /><button type="button" className="cr-ai-action"><Sparkles aria-hidden="true" />Ask Nex</button></div>
        <div className="cr-doc-scroll">
          <article className="cr-document-page" contentEditable suppressContentEditableWarning onInput={() => {
            setSaveState('正在保存')
            window.setTimeout(() => setSaveState('已保存'), 500)
          }}>
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

function RelationsPane({ room, rooms, onOpenRoom }: { room: ContextRoomRecord; rooms: ContextRoomRecord[]; onOpenRoom: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(room.id)
  const graphData = useMemo(() => createRoomGraphData([room, ...rooms.filter((item) => item.id !== room.id)]), [room, rooms])
  return <div className="cr-full-graph"><header><div><h2>Room 关系图谱</h2><span>单击查看节点，双击打开 Room</span></div></header><GraphWorkspace data={graphData} rooms={rooms} selectedId={selectedId} onSelect={setSelectedId} onOpen={onOpenRoom} /></div>
}

function MemoriesPane({ room }: { room: ContextRoomRecord }) {
  const data = useMemo(() => createMemoryGraphData(room), [room])
  const [selectedId, setSelectedId] = useState<string | null>(data.nodes[0]?.id ?? null)
  return <div className="cr-memory-pane"><div className="cr-memory-head"><div><h2>实体与事实</h2><span>{room.memories.length} 条 Room 记忆</span></div><div className="segmented-control"><button type="button">列表</button><button type="button" data-active="true">图谱</button></div></div><GraphWorkspace data={data} selectedId={selectedId} onSelect={setSelectedId} /><section className="cr-memory-list">{room.memories.map((memory) => <article key={memory.id}><Bookmark aria-hidden="true" /><div><strong>{memory.title}</strong><p>{memory.detail}</p></div><span data-status={memory.status}>{memory.status}</span></article>)}</section></div>
}

function ActivityPane({ room, pane, onToggleTask }: { room: ContextRoomRecord; pane: 'schedule' | 'tasks' | 'mails'; onToggleTask: (id: string) => void }) {
  if (pane === 'tasks') return <div className="cr-activity-pane"><header><div><h2>任务</h2><span>{room.tasks.filter((task) => !task.done).length} 项待办</span></div><button type="button" className="primary-button"><Plus aria-hidden="true" />新建任务</button></header><div className="cr-task-list">{room.tasks.map((task) => <button type="button" key={task.id} onClick={() => onToggleTask(task.id)}><span className="cr-task-check" data-done={String(task.done)}>{task.done ? <Check aria-hidden="true" /> : null}</span><span><strong>{task.title}</strong><small>{task.owner} / 当前 Room</small></span><span>{task.done ? '已完成' : '进行中'}</span></button>)}</div></div>
  const items = pane === 'schedule'
    ? [['产品范围评审', '今天 14:30', '林薇、陆远、周明'], ['连接器技术对齐', '明天 10:00', '陆远、周明']]
    : [['开源版内测清单确认', '刚刚', '林薇'], ['Re: Connector 边界与后续计划', '昨天', '周明'], ['本周产品进展', '8 月 12 日', '极核团队']]
  const Icon = pane === 'schedule' ? CalendarDays : Mail
  return <div className="cr-activity-pane"><header><div><h2>{pane === 'schedule' ? '日程与会议' : '相关邮件'}</h2><span>{items.length} 项与当前 Room 关联</span></div></header><div className="cr-activity-list">{items.map(([title, time, meta]) => <button type="button" key={title}><span className="cr-file-icon"><Icon aria-hidden="true" /></span><span><strong>{title}</strong><small>{meta}</small></span><time>{time}</time><ChevronRight aria-hidden="true" /></button>)}</div></div>
}

function ContextRoomDetail({
  room,
  rooms,
  onBack,
  onOpenRoom,
  onUpdateRoom,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  onBack: () => void
  onOpenRoom: (id: string) => void
  onUpdateRoom: (room: ContextRoomRecord) => void
}) {
  const [activePane, setActivePane] = useState<RoomPane>('overview')
  const paneTitle = PANE_ITEMS.find((item) => item.id === activePane)?.label ?? '概览'
  return (
    <div className="cr-detail">
      <header className="cr-detail-header">
        <button type="button" className="cr-back" aria-label="返回 Context Room" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
        <RoomIcon kind={room.kind} />
        <div><span>{room.kind} Room</span><h1>{room.title}</h1></div>
        <span className="cr-detail-location">{paneTitle}</span>
        <button type="button" className="cr-icon-button" aria-label="Room 更多操作"><MoreHorizontal aria-hidden="true" /></button>
      </header>
      <div className="cr-detail-body">
        <PaneRail activePane={activePane} onSelect={setActivePane} />
        <main className="cr-pane-content">
          {activePane === 'overview' ? <OverviewPane room={room} onSelect={setActivePane} /> : null}
          {activePane === 'documents' ? <CloudDocumentPane key={room.id} room={room} /> : null}
          {activePane === 'relations' ? <RelationsPane room={room} rooms={rooms} onOpenRoom={onOpenRoom} /> : null}
          {activePane === 'memories' ? <MemoriesPane room={room} /> : null}
          {activePane === 'schedule' || activePane === 'tasks' || activePane === 'mails' ? <ActivityPane room={room} pane={activePane} onToggleTask={(id) => onUpdateRoom({ ...room, tasks: room.tasks.map((task) => task.id === id ? { ...task, done: !task.done } : task) })} /> : null}
        </main>
      </div>
    </div>
  )
}

export function ContextRoomPage() {
  const [rooms, setRooms] = useState(INITIAL_ROOMS)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const [newRoomRecommendation, setNewRoomRecommendation] = useState<RoomRecommendation | null | undefined>(undefined)
  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null

  if (activeRoom) {
    return <ContextRoomDetail room={activeRoom} rooms={rooms} onBack={() => setActiveRoomId(null)} onOpenRoom={setActiveRoomId} onUpdateRoom={(nextRoom) => setRooms((current) => current.map((room) => room.id === nextRoom.id ? nextRoom : room))} />
  }

  return (
    <>
      <ContextRoomHome rooms={rooms} onOpen={setActiveRoomId} onCreate={(recommendation) => setNewRoomRecommendation(recommendation ?? null)} onDelete={(id) => setRooms((current) => current.filter((room) => room.id !== id))} />
      {newRoomRecommendation !== undefined ? <NewRoomDialog recommendation={newRoomRecommendation} onClose={() => setNewRoomRecommendation(undefined)} onCreate={(input) => {
        const room: ContextRoomRecord = {
          id: `room-${Date.now()}`,
          title: input.title,
          kind: input.kind,
          description: input.description || '待补充 Room 的目标与资料范围。',
          updated: '刚刚',
          people: [],
          tags: [],
          materials: [],
          memories: [],
          tasks: [],
        }
        setRooms((current) => [room, ...current])
        setNewRoomRecommendation(undefined)
        setActiveRoomId(room.id)
      }} /> : null}
    </>
  )
}
