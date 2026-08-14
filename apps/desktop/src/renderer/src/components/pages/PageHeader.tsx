import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  action,
  actionDisabled = false,
  onAction,
  extraAction,
}: {
  title: string
  description: string
  action?: string
  actionDisabled?: boolean
  onAction?: () => void
  extraAction?: ReactNode
}) {
  return (
    <header className="page-header">
      <div><h1>{title}</h1><p>{description}</p></div>
      <span className="page-header-actions">
        {extraAction}
        {action ? (
          <button type="button" className="primary-button" disabled={actionDisabled} onClick={onAction}>
            <Plus aria-hidden="true" strokeWidth={1.8} />{action}
          </button>
        ) : null}
      </span>
    </header>
  )
}
