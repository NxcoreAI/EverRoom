import { ChevronLeft, PanelRightClose, PanelRightOpen, Plus, RotateCcw, X } from 'lucide-react'

import type { PageId } from '@/data/navigation'
import { pageLabels } from '@/data/navigation'
import { ThemeSwitcher, type ThemeId } from '@/components/ThemeSwitcher'

export function TopBar({
  activePage,
  tabs,
  agentOpen,
  theme,
  onActivate,
  onClose,
  onToggleAgent,
  onThemeChange,
}: {
  activePage: PageId
  tabs: PageId[]
  agentOpen: boolean
  theme: ThemeId
  onActivate: (page: PageId) => void
  onClose: (page: PageId) => void
  onToggleAgent: () => void
  onThemeChange: (theme: ThemeId) => void
}) {
  return (
    <header className="topbar">
      <div className="brand-area">
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        <strong>极核</strong>
        <button className="icon-button no-drag nav-collapse" type="button" title="收起导航">
          <ChevronLeft aria-hidden="true" />
        </button>
      </div>

      <div className="tabs no-drag" role="tablist" aria-label="打开的页面">
        {tabs.map((tab) => (
          <div key={tab} className="tab" data-active={String(tab === activePage)} role="tab">
            <button type="button" onClick={() => onActivate(tab)}>
              {pageLabels[tab]}
            </button>
            {tab !== 'home' ? (
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭${pageLabels[tab]}`}
                onClick={() => onClose(tab)}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="top-actions no-drag">
        <button type="button" className="icon-button" title="新建标签" aria-label="新建标签">
          <Plus aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" title="恢复已关闭" aria-label="恢复已关闭">
          <RotateCcw aria-hidden="true" />
        </button>
        <ThemeSwitcher theme={theme} onChange={onThemeChange} />
        <button
          type="button"
          className="icon-button"
          title={agentOpen ? '收起 Agent' : '展开 Agent'}
          aria-label={agentOpen ? '收起 Agent' : '展开 Agent'}
          onClick={onToggleAgent}
        >
          {agentOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
        </button>
      </div>
    </header>
  )
}
