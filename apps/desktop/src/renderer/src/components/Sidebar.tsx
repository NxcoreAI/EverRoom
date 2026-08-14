import { ChevronDown, Server } from 'lucide-react'
import { useEffect, useState } from 'react'

import { navigationSections, type PageId } from '@/data/navigation'
import { ProductBrand } from '@/components/ui/ProductBrand'
import type { GatewayStatus } from '../../../shared/sources'

const INITIAL_GATEWAY_STATUS: GatewayStatus = {
  state: 'starting',
  pid: null,
  baseUrl: null,
  version: null,
  message: null,
}

function gatewayStatusLabel(status: GatewayStatus): string {
  switch (status.state) {
    case 'ready':
      return status.pid ? `运行中 · PID ${status.pid}` : '运行中'
    case 'starting':
      return '正在启动'
    case 'error':
      return '连接异常'
    case 'stopped':
      return '未运行'
  }
}

export function Sidebar({
  activePage,
  onNavigate,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>(INITIAL_GATEWAY_STATUS)

  useEffect(() => {
    let disposed = false

    const refreshGatewayStatus = async () => {
      if (!window.nxcore) {
        if (!disposed) {
          setGatewayStatus({
            state: 'stopped',
            pid: null,
            baseUrl: null,
            version: null,
            message: 'Gateway 仅在 Everroom 桌面版中运行',
          })
        }
        return
      }
      try {
        const status = await window.nxcore.gateway.status()
        if (!disposed) setGatewayStatus(status)
      } catch (error) {
        if (!disposed) {
          setGatewayStatus({
            state: 'error',
            pid: null,
            baseUrl: null,
            version: null,
            message: error instanceof Error ? error.message : '无法获取 Gateway 状态',
          })
        }
      }
    }

    void refreshGatewayStatus()
    const interval = window.setInterval(() => void refreshGatewayStatus(), 3_000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

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
      <ProductBrand className="sidebar-brand" />
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
                    data-nav-tone={item.tone}
                    aria-current={item.id === activePage ? 'page' : undefined}
                    onClick={() => onNavigate(item.id)}
                  >
                    <span className="nav-item-icon" aria-hidden="true">
                      <Icon strokeWidth={1.8} />
                    </span>
                    <span className="nav-item-label">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </nav>

      <div
        className="gateway-status"
        data-state={gatewayStatus.state}
        role="status"
        aria-live="polite"
        title={gatewayStatus.message ?? gatewayStatus.baseUrl ?? 'Everroom Gateway'}
      >
        <Server aria-hidden="true" />
        <span>
          <strong>Gateway</strong>
          <small>{gatewayStatusLabel(gatewayStatus)}</small>
        </span>
        <i className="gateway-status-dot" aria-hidden="true" />
      </div>
      <button type="button" className="account-row">
        <span className="account-avatar" aria-hidden="true">本</span>
        <span className="account-copy">
          <strong>本地用户</strong>
          <small>本地模式</small>
        </span>
      </button>
    </aside>
  )
}
