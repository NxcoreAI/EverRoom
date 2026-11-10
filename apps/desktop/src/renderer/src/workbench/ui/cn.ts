import React from 'react'

/** 轻量 className 拼接（项目没有 Tailwind，保持零依赖）。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const UI_ICON_STROKE = 1.7
