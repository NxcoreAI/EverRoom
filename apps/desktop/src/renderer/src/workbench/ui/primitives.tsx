import * as Tooltip from '@radix-ui/react-tooltip'
import { Loader2 } from 'lucide-react'
import React from 'react'

import { cn } from './cn'

/* ───────────────── 按钮 ───────────────── */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 左侧图标（lucide 组件元素）。 */
  icon?: React.ReactNode
  /** 右侧内容（kbd / 计数）。 */
  trailing?: React.ReactNode
  block?: boolean
}

/**
 * 注意：必须 forwardRef —— Radix 的 Tooltip/DropdownMenu/Modal 都用 asChild + Slot
 * 往触发元素上挂 ref 与事件；函数组件不转发 ref 会警告且定位/交互不可靠。
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailing,
  block,
  className,
  children,
  type = 'button',
  ...rest
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', className)}
      {...rest}
    >
      {icon ? <span className="ui-btn-icon" aria-hidden="true">{icon}</span> : null}
      {children !== undefined ? <span className="ui-btn-label">{children}</span> : null}
      {trailing ? <span className="ui-btn-trailing">{trailing}</span> : null}
    </button>
  )
})

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：图标按钮必须有可读标签。 */
  label: string
  size?: 'sm' | 'md'
  icon: React.ReactNode
  active?: boolean
  tone?: 'default' | 'danger'
}

/** 同 Button：必须 forwardRef，否则 Radix asChild 触发器的 tooltip/键盘交互会失灵。 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label, size = 'md', icon, active, tone = 'default', className, type = 'button', ...rest
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn('ui-iconbtn', `ui-iconbtn--${size}`, active && 'is-active', tone === 'danger' && 'is-danger', className)}
      {...rest}
    >
      {icon}
    </button>
  )
})

/* ───────────────── 提示 ───────────────── */

/** Radix tooltip 薄封装；不传 label 时直接渲染 children。 */
export function Hint({ label, children, side = 'top' }: {
  label: string | null | undefined
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  if (!label) return <>{children}</>
  return (
    <Tooltip.Provider delayDuration={320}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ui-tooltip" side={side} sideOffset={6}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

/* ───────────────── 状态 ───────────────── */

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('ui-spin', className)} aria-hidden="true" />
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'running'

export function Badge({ tone = 'neutral', dot = false, children, className }: {
  tone?: BadgeTone
  dot?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn('ui-badge', `ui-badge--${tone}`, className)}>
      {dot ? <i className="ui-badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

export function EmptyState({ icon, title, description, action, className }: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('ui-empty', className)}>
      {icon ? <div className="ui-empty-icon" aria-hidden="true">{icon}</div> : null}
      <div className="ui-empty-title">{title}</div>
      {description ? <div className="ui-empty-desc">{description}</div> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  )
}

/* ───────────────── 页头 ───────────────── */

export function PageHeader({ title, subtitle, actions, eyebrow }: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  eyebrow?: React.ReactNode
}) {
  return (
    <header className="ui-pagehead">
      <div className="ui-pagehead-text">
        {eyebrow ? <div className="ui-pagehead-eyebrow">{eyebrow}</div> : null}
        <h1 className="ui-pagehead-title">{title}</h1>
        {subtitle ? <p className="ui-pagehead-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ui-pagehead-actions">{actions}</div> : null}
    </header>
  )
}

/* ───────────────── 分段切换 ───────────────── */

export interface SegmentedItem<T extends string> {
  key: T
  label: React.ReactNode
  icon?: React.ReactNode
  count?: number
}

export function Segmented<T extends string>({ items, value, onChange, ariaLabel }: {
  items: ReadonlyArray<SegmentedItem<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="ui-segmented" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn('ui-segmented-item', active && 'is-active')}
            onClick={() => onChange(item.key)}
          >
            {item.icon ? <span className="ui-segmented-icon" aria-hidden="true">{item.icon}</span> : null}
            {item.label}
            {typeof item.count === 'number' ? <span className="ui-segmented-count">{item.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/* ───────────────── 表单 ───────────────── */

export interface FieldProps {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  htmlFor?: string
}

export function Field({ label, hint, error, children, htmlFor }: FieldProps) {
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="ui-field-error" role="alert">{error}</div> : null}
      {!error && hint ? <div className="ui-field-hint">{hint}</div> : null}
    </div>
  )
}

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cn('ui-input', className)} {...rest} />
  },
)

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn('ui-input', 'ui-textarea', className)} {...rest} />
  },
)
