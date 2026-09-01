export interface DocumentCursorCompletionSettings {
  enabled: boolean
  /** 段落级续写档位（停顿升级 + Alt+\ 手动）；关闭后仅保留行内短补全。 */
  paragraphEnabled: boolean
}

const STORAGE_KEY = 'everroom:document-cursor-completion-settings:v1'
const CHANGE_EVENT = 'everroom:document-cursor-completion-settings-changed'

export const DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS: DocumentCursorCompletionSettings = {
  enabled: true,
  paragraphEnabled: true,
}

export function loadDocumentCursorCompletionSettings(): DocumentCursorCompletionSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      enabled?: unknown
      paragraphEnabled?: unknown
    }
    return {
      enabled: typeof stored.enabled === 'boolean'
        ? stored.enabled
        : DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS.enabled,
      paragraphEnabled: typeof stored.paragraphEnabled === 'boolean'
        ? stored.paragraphEnabled
        : DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS.paragraphEnabled,
    }
  } catch {
    return DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS
  }
}

export function saveDocumentCursorCompletionSettings(
  settings: DocumentCursorCompletionSettings,
): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent<DocumentCursorCompletionSettings>(CHANGE_EVENT, {
    detail: settings,
  }))
}

export function onDocumentCursorCompletionSettingsChanged(
  listener: (settings: DocumentCursorCompletionSettings) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<DocumentCursorCompletionSettings>).detail)
  }
  window.addEventListener(CHANGE_EVENT, handle)
  return () => window.removeEventListener(CHANGE_EVENT, handle)
}
