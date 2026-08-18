export interface DocumentCursorCompletionSettings {
  enabled: boolean
}

const STORAGE_KEY = 'everroom:document-cursor-completion-settings:v1'
const CHANGE_EVENT = 'everroom:document-cursor-completion-settings-changed'

export const DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS: DocumentCursorCompletionSettings = {
  enabled: true,
}

export function loadDocumentCursorCompletionSettings(): DocumentCursorCompletionSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      enabled?: unknown
    }
    return {
      enabled: typeof stored.enabled === 'boolean'
        ? stored.enabled
        : DEFAULT_DOCUMENT_CURSOR_COMPLETION_SETTINGS.enabled,
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
