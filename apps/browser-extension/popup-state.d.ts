export function progressStates(stageNames: string[], active: string, state?: string): string[];
export function captureStatusKey(result: { ok?: boolean; capture?: { failedAssetCount?: number } } | null | undefined): 'saveFailed' | 'savedPartial' | 'saved';
export function retryStatusKey(result: { ok?: boolean } | null | undefined): 'retryFinished' | 'retryFailed';
