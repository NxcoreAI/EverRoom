import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import React from 'react'

import { cn } from './cn'

/** Radix 下拉菜单薄封装：外壳/页面统一用这一组，保证圆角/阴影/危险项一致。 */
export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger

export function MenuContent({
  children, align = 'end', side = 'bottom', className, sideOffset = 6,
}: {
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
  sideOffset?: number
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={cn('ui-menu', className)}
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function MenuItem({
  children, icon, danger, disabled, onSelect, shortcut,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
  shortcut?: string
}) {
  return (
    <DropdownMenu.Item
      className={cn('ui-menu-item', danger && 'is-danger')}
      disabled={disabled}
      onSelect={() => onSelect?.()}
    >
      {icon ? <span className="ui-menu-icon" aria-hidden="true">{icon}</span> : null}
      <span className="ui-menu-label">{children}</span>
      {shortcut ? <kbd className="ui-menu-kbd">{shortcut}</kbd> : null}
    </DropdownMenu.Item>
  )
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="ui-menu-sep" />
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DropdownMenu.Label className="ui-menu-label-text">{children}</DropdownMenu.Label>
}
