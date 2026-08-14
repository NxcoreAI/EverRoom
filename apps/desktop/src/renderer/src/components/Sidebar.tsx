import { ChevronDown, CircleUserRound, CloudOff } from 'lucide-react'
import { useState } from 'react'

import { navigationSections, type PageId } from '@/data/navigation'

export function Sidebar({
  activePage,
  onNavigate,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label="主导航">
        {navigationSections.map((section) => (
          <section
            key={section.id}
            className="nav-section"
            data-collapsed={String(collapsedSections.has(section.id))}
          >
            <button
              type="button"
              className="nav-section-title"
              aria-expanded={!collapsedSections.has(section.id)}
              onClick={() => toggleSection(section.id)}
            >
              <ChevronDown aria-hidden="true" />
              <span>{section.label}</span>
            </button>
            <div className="nav-items" hidden={collapsedSections.has(section.id)}>
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
