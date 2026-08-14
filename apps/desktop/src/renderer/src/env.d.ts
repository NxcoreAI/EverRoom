/// <reference types="vite/client" />

import type { NxcoreDesktopApi } from '../../shared/sources'

declare global {
  interface Window {
    nxcore?: NxcoreDesktopApi
  }
}

export {}
