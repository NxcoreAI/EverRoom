export type DesktopPageMode = 'sources' | 'connectors'

export const DESKTOP_PAGE_MODE_ENV = 'NXCORE_DESKTOP_PAGE_MODE'

/** Resolve the one enabled source/connector experience for this desktop build. */
export function resolveDesktopPageMode(value: string | undefined): DesktopPageMode {
  return value?.trim().toLowerCase() === 'connectors' ? 'connectors' : 'sources'
}
