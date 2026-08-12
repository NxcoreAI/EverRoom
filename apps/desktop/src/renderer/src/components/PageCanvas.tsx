import {
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  FileText,
  FolderSync,
  Github,
  Globe2,
  HardDrive,
  ListChecks,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react'

import type { PageId } from '@/data/navigation'

function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: string
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? (
        <button type="button" className="primary-button">
          <Plus aria-hidden="true" />
          {action}
        </button>
      ) : null}
    </header>
  )
}

function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  return (
    <div className="page page-home">
      <header className="home-heading">
        <span>2026 年 8 月 11 日 · 上海</span>
        <h1>晚上好</h1>
        <p>继续最近的工作，或从新的上下文开始。</p>
      </header>

      <section className="home-band">
        <div className="section-heading">
          <h2>继续工作</h2>
          <button type="button" className="text-button" onClick={() => onNavigate('rooms')}>
            查看全部 <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="recent-grid">
          <button type="button" className="recent-item" onClick={() => onNavigate('rooms')}>
            <span className="item-icon"><BookOpen aria-hidden="true" /></span>
            <span className="recent-copy">
              <strong>极核开源 PC 版</strong>
              <small>Context Room · 12 分钟前</small>
            </span>
            <ArrowUpRight aria-hidden="true" />
          </button>
          <button type="button" className="recent-item" onClick={() => onNavigate('docs')}>
            <span className="item-icon"><FileText aria-hidden="true" /></span>
            <span className="recent-copy">
              <strong>开源版工程基线</strong>
              <small>Context Doc · 昨天</small>
            </span>
            <ArrowUpRight aria-hidden="true" />
          </button>
        </div>
      </section>

      <div className="home-columns">
        <section className="home-band">
          <div className="section-heading">
            <h2>今天</h2>
            <span className="quiet-label">3 项</span>
          </div>
          <div className="simple-list">
            {[
              ['确认开源版界面骨架', '进行中'],
              ['检查首批数据连接范围', '待处理'],
              ['审阅记忆治理规则', '待处理'],
            ].map(([title, status], index) => (
              <div key={title} className="simple-row">
                <span className={index === 0 ? 'status-dot active' : 'status-dot'} />
                <strong>{title}</strong>
                <small>{status}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="home-band">
          <div className="section-heading">
            <h2>系统状态</h2>
            <span className="status-ok"><Check aria-hidden="true" />正常</span>
          </div>
          <div className="metric-grid">
            <div><strong>4</strong><span>数据源</span></div>
            <div><strong>128</strong><span>记忆</span></div>
            <div><strong>2</strong><span>运行任务</span></div>
          </div>
        </section>
      </div>
    </div>
  )
}

function RoomsPage() {
  const rooms = [
    { title: '极核开源 PC 版', meta: '项目', updated: '12 分钟前', sources: 18, memories: 46 },
    { title: '连接器架构研究', meta: '议题', updated: '昨天', sources: 9, memories: 21 },
    { title: '个人上下文产品设计', meta: '长期目标', updated: '3 天前', sources: 27, memories: 61 },
  ]

  return (
    <div className="page">
      <PageHeader title="Context Room" description="围绕项目、人物或目标组织动态上下文。" action="新建 Room" />
      <div className="toolbar-row">
        <label className="search-field">
          <Search aria-hidden="true" />
          <input aria-label="搜索 Room" placeholder="搜索 Room" />
        </label>
        <div className="segmented-control" aria-label="Room 筛选">
          <button type="button" data-active="true">全部</button>
          <button type="button">项目</button>
          <button type="button">人物</button>
          <button type="button">目标</button>
        </div>
      </div>
      <div className="room-grid">
        {rooms.map((room, index) => (
          <article key={room.title} className="room-card">
            <div className="room-card-top">
              <span className="room-glyph" data-index={index}><BookOpen aria-hidden="true" /></span>
              <button type="button" className="icon-button" aria-label="更多操作"><MoreHorizontal aria-hidden="true" /></button>
            </div>
            <div className="room-meta"><span>{room.meta}</span><span>{room.updated}</span></div>
            <h2>{room.title}</h2>
            <p>恢复目标、进展、关键决策和待解决问题。</p>
            <div className="room-stats"><span>{room.sources} 个来源</span><span>{room.memories} 条记忆</span></div>
          </article>
        ))}
      </div>
    </div>
  )
}

function DocsPage() {
  return (
    <div className="page doc-page">
      <PageHeader title="文档" description="在原生写作空间中使用 Room、来源与 Agent。" action="新建文档" />
      <div className="doc-list">
        {[
          ['开源版工程基线', '极核开源 PC 版', '刚刚'],
          ['Context Room 产品说明', '个人上下文产品设计', '昨天'],
          ['连接器技术调研', '连接器架构研究', '8 月 9 日'],
        ].map(([title, room, time]) => (
          <button key={title} type="button" className="doc-row">
            <span className="item-icon"><FileText aria-hidden="true" /></span>
            <span><strong>{title}</strong><small>{room}</small></span>
            <time>{time}</time>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

function SourcesPage() {
  const sources = [
    { name: '本地文件夹', type: '本地', icon: HardDrive, status: '已同步', updated: '刚刚' },
    { name: 'GitHub', type: '连接器', icon: Github, status: '已同步', updated: '18 分钟前' },
    { name: '飞书文档', type: '连接器', icon: FolderSync, status: '等待连接', updated: '未连接' },
    { name: '网页导入', type: '手动', icon: Globe2, status: '可用', updated: '随时导入' },
  ]

  return (
    <div className="page">
      <PageHeader title="数据源" description="管理进入极核的文件、应用和网页资料。" action="添加数据源" />
      <div className="data-table">
        <div className="table-head"><span>名称</span><span>类型</span><span>状态</span><span>最近同步</span><span /></div>
        {sources.map((source) => {
          const Icon = source.icon
          return (
            <div key={source.name} className="table-row">
              <span className="name-cell"><span className="item-icon"><Icon aria-hidden="true" /></span><strong>{source.name}</strong></span>
              <span>{source.type}</span>
              <span className="status-cell"><span className="status-dot active" />{source.status}</span>
              <span>{source.updated}</span>
              <button type="button" className="icon-button" aria-label="更多操作"><MoreHorizontal aria-hidden="true" /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MemoryPage() {
  return (
    <div className="page">
      <PageHeader title="记忆" description="查看 AI 记住了什么，并决定哪些内容可以继续使用。" />
      <div className="memory-layout">
        <aside className="memory-filters">
          <button type="button" data-active="true">全部记忆 <span>128</span></button>
          <button type="button">已确认 <span>96</span></button>
          <button type="button">待确认 <span>24</span></button>
          <button type="button">冲突 <span>8</span></button>
        </aside>
        <section className="memory-feed">
          {[
            ['开源版首发平台只支持 macOS', '已确认', '来自产品 PRD · 2 个证据'],
            ['连接器优先于虚拟机能力', '已确认', '来自产品讨论 · 1 个证据'],
            ['用户偏好中性黑白灰界面', '待确认', '来自当前会话 · 1 个证据'],
          ].map(([title, status, source]) => (
            <article key={title} className="memory-row">
              <span className="memory-symbol"><Brain aria-hidden="true" /></span>
              <div><strong>{title}</strong><small>{source}</small></div>
              <span className="memory-status">{status}</span>
              <ChevronRight aria-hidden="true" />
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}

function TasksPage() {
  return (
    <div className="page">
      <PageHeader title="任务" description="查看 Agent 的执行范围、进度与产物。" action="新建任务" />
      <div className="task-board">
        {[
          ['进行中', '搭建前端样式框架', 'Nex', '当前'],
          ['待开始', '接入本地文件连接器', '未分配', 'P0'],
          ['已完成', '确定开源版工程边界', 'Codex', '今天'],
        ].map(([status, title, owner, time], index) => (
          <article key={title} className="task-row">
            <span className="task-state">{index === 0 ? <CircleDashed aria-hidden="true" /> : index === 2 ? <Check aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span>
            <div><strong>{title}</strong><small>{owner}</small></div>
            <span className="quiet-label">{status}</span>
            <time>{time}</time>
            <ChevronRight aria-hidden="true" />
          </article>
        ))}
      </div>
    </div>
  )
}

function SettingsPage() {
  return (
    <div className="page settings-page">
      <PageHeader title="设置" description="管理本地工作区、模型和数据边界。" />
      <div className="settings-list">
        {[
          [HardDrive, '本地数据', '数据目录、备份与保留策略'],
          [Brain, '模型与记忆', '模型供应商、Embedding 与记忆治理'],
          [ShieldCheck, '隐私与权限', '外发范围、审批和审计记录'],
          [Settings, '通用', '语言、启动行为与界面偏好'],
        ].map(([Icon, title, description]) => {
          const ItemIcon = Icon as typeof Settings
          return (
            <button key={String(title)} type="button" className="settings-row">
              <span className="item-icon"><ItemIcon aria-hidden="true" /></span>
              <span><strong>{String(title)}</strong><small>{String(description)}</small></span>
              <ChevronRight aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function PageCanvas({ page, onNavigate }: { page: PageId; onNavigate: (page: PageId) => void }) {
  if (page === 'home') return <HomePage onNavigate={onNavigate} />
  if (page === 'rooms') return <RoomsPage />
  if (page === 'docs') return <DocsPage />
  if (page === 'sources') return <SourcesPage />
  if (page === 'memory') return <MemoryPage />
  if (page === 'tasks') return <TasksPage />
  return <SettingsPage />
}
