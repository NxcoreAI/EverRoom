/// <reference types="vite/client" />

import type { NxcoreDesktopApi } from '../../shared/sources'

// everoffice UI 迁移：window.desktop 是 office-proto 的 GenOffice 编辑器桥
interface DesktopOfficeBridge {
  open: (request: { fileId: string; title: string; spec: unknown }) => Promise<{ ok: boolean; error?: string }>
  activate: (fileId: string | null) => Promise<boolean>
  close: (fileId: string) => Promise<boolean>
  dirty: (fileId: string) => Promise<boolean>
  sendBounds: (bounds: { x: number; width: number; height: number; y?: number }) => void
  pickMaterials: () => Promise<Array<{ name: string; size: number }>>
}

interface DesktopBridge {
  platform: string
  versions: { electron: string; chrome: string }
  office: DesktopOfficeBridge
}

declare global {
  interface Window {
    desktop?: DesktopBridge
    nxcore?: NxcoreDesktopApi
  }
}

export {}
