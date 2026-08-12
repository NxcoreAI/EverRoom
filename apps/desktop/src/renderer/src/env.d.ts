/// <reference types="vite/client" />

import type { NexcoreDesktopApi } from '../../shared/sources'

declare global {
  interface Window {
    nexcore?: NexcoreDesktopApi
  }
}

export {}
