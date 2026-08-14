import type { ReactNode } from 'react'

export function EditorIconButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-active={String(active)}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
