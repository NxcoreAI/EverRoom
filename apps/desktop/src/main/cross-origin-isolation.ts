import type { Session } from 'electron'

export const CROSS_ORIGIN_ISOLATION_HEADERS: Record<string, string[]> = {
  'Cross-Origin-Embedder-Policy': ['require-corp'],
  'Cross-Origin-Opener-Policy': ['same-origin'],
}

export function isRendererResourceUrl(url: string, rendererUrl?: string): boolean {
  if (!rendererUrl) return url.startsWith('file://')
  try {
    return new URL(url).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

export function installCrossOriginIsolation(session: Session, rendererUrl?: string): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!isRendererResourceUrl(details.url, rendererUrl)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...CROSS_ORIGIN_ISOLATION_HEADERS,
      },
    })
  })
}
