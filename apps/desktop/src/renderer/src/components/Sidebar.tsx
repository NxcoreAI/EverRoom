import { ChevronDown, CircleUserRound, CloudOff } from 'lucide-react'

import { navigationSections, type PageId } from '@/data/navigation'

export function Sidebar({
  activePage,
  onNavigate,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
}) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label="主导航">
        {navigationSections.map((section) => (
          <section key={section.id} className="nav-section">
            <div className="nav-section-title">
              <ChevronDown aria-hidden="true" />
              <span>{section.label}</span>
            </div>
            <div className="nav-items">
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="nav-item"
                    data-active={String(item.id === activePage)}
                    aria-current={item.id === activePage ? 'page' : undefined}
                    onClick={() => onNavigate(item.id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </nav>

      <div className="sidebar-status">
        <CloudOff aria-hidden="true" />
        <span>
          <strong>本地模式</strong>
          <small>数据保存在这台 Mac</small>
        </span>
      </div>

      <button type="button" className="account-row">
        <CircleUserRound aria-hidden="true" />
        <span>
          <strong>本地用户</strong>
          <small>NexCore CE</small>
        </span>
      </button>
    </aside>
  )
}
