export const CLIPPER_ASSET_SCHEME = 'nxcore-clipper-asset'

export type BrowserExtensionConnectionState =
  | 'unavailable'
  | 'idle'
  | 'waiting-for-extension'
  | 'paired'
  | 'error'

export interface BrowserExtensionPairing {
  id: string
  status: 'pending' | 'paired'
  expiresAt: string
  extensionId: string | null
  extensionName: string | null
}

export interface BrowserExtensionMessage {
  type: string
  payload: Record<string, unknown>
  receivedAt: string
}

export interface BrowserExtensionCapture {
  captureId: string
  url: string
  canonicalUrl: string
  title: string
  author?: string
  publishedAt?: string
  extractionMode: 'selection' | 'article' | 'full-page'
  markdown: string
  capturedAt: string
  extractorVersion: string
  assets: BrowserExtensionCaptureAsset[]
}

export interface BrowserExtensionCaptureAsset {
  id: string
  referenceKey: string
  originalUrl: string
  altText?: string
  width?: number
  height?: number
}

export interface BrowserExtensionCaptureResult {
  fileEntryId: string
  fileVersionId: string
  jobId: string
  contentHash: string
  blobDeduped: boolean
  versionDeduped: boolean
  pendingAssetIds: string[]
  capture: BrowserExtensionClipperCapture
}

export interface BrowserExtensionClipperCapture {
  id: string
  fileEntryId: string | null
  fileVersionId: string | null
  sourceUrl: string
  canonicalUrl: string
  title: string
  author: string | null
  publishedAt: string | null
  capturedAt: string
  extractionMode: 'selection' | 'article' | 'full-page'
  status: 'storing' | 'assets_pending' | 'ready' | 'ready_with_missing_assets' | 'failed'
  assetCount: number
  storedAssetCount: number
  failedAssetCount: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  artifact: {
    schemaVersion: number
    excerpt: string
    coverAssetId: string | null
    coverUrl: string | null
    displayMarkdown?: string
  } | null
  understanding: {
    parse: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
    visual: 'pending' | 'processing' | 'ready' | 'partial' | 'skipped' | 'failed' | 'unavailable'
    memory: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
    entities: 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable'
  }
  entities: Array<{
    id: string
    name: string
    kind: string
    status: string
    role: 'primary' | 'mention' | 'manual'
    salience: number
    evidence: string | null
  }>
  assets: Array<{
    id: string
    referenceKey: string
    originalUrl: string
    localUrl: string
    mime: string | null
    byteSize: number | null
    altText: string | null
    width: number | null
    height: number | null
    status: 'pending' | 'stored' | 'failed'
    errorCode: string | null
    visualStatus: 'pending' | 'processing' | 'ready' | 'skipped' | 'failed'
    visualKind: string | null
    visualSummary: string | null
    visualOcrText: string | null
    visualKeyPoints: string[]
    visualEntities: Array<{ name: string; kind: string; evidence: string }>
    visualRelevance: number | null
    visualQuality: number | null
    visualContentRole: 'primary' | 'supporting' | 'noise' | null
    visualNoiseReason: string | null
    coverScore: number | null
  }>
}

export interface BrowserExtensionStatus {
  mode: 'development' | 'production'
  state: BrowserExtensionConnectionState
  bridgeUrl: string | null
  storeUrl: string
  extensionDirectory: string | null
  pairing: BrowserExtensionPairing | null
  pairedExtensionId: string | null
  pairedAt: string | null
  lastMessage: BrowserExtensionMessage | null
  error: string | null
}
