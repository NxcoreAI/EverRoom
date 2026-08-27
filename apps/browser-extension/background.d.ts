export interface BrowserImageAsset {
  id?: string;
  originalUrl: string;
}

export type BrowserImageReadResult =
  | { ok: true; data: string; byteSize: number }
  | { ok: false; code: string };

export function assetOriginPattern(asset: BrowserImageAsset): string | null;
export function requestImageHostPermissions(assets: BrowserImageAsset[]): Promise<Set<string>>;
export function readAssetInBackground(
  asset: BrowserImageAsset,
  permittedOrigins: Set<string>,
  pageUrl: string,
): Promise<BrowserImageReadResult>;
export function uploadPendingAssets(
  tabId: number,
  capture: { captureId: string; url?: string; canonicalUrl?: string; assets?: Array<BrowserImageAsset & { id: string }> },
  accessToken: string,
  result: { pendingAssetIds?: string[]; capture?: Record<string, unknown> },
  permittedOrigins?: Set<string>,
): Promise<{ ok: boolean; code?: string; capture?: Record<string, unknown> }>;
