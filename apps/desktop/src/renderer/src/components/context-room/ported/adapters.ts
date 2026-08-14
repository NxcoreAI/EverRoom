type ClassValue = string | false | null | undefined | Record<string, boolean>

export function cn(...values: ClassValue[]) {
  return values
    .flatMap((value) => {
      if (!value) return []
      if (typeof value === 'string') return [value]
      return Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name)
    })
    .join(' ')
}

export function uiText(value?: string | null) {
  return value ?? ''
}
