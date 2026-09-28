export interface ConversationSuggestionSettings {
  /** 对话输入框空态补全（推断下一个提问，Tab/Enter 采纳）。 */
  completionEnabled: boolean
  /** 新对话开场推荐提问（按最近活动生成）。 */
  starterPromptsEnabled: boolean
}

const STORAGE_KEY = 'everroom:conversation-suggestion-settings:v1'
const CHANGE_EVENT = 'everroom:conversation-suggestion-settings-changed'

export const DEFAULT_CONVERSATION_SUGGESTION_SETTINGS: ConversationSuggestionSettings = {
  completionEnabled: true,
  starterPromptsEnabled: true,
}

export function loadConversationSuggestionSettings(): ConversationSuggestionSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      completionEnabled?: unknown
      starterPromptsEnabled?: unknown
    }
    return {
      completionEnabled: typeof stored.completionEnabled === 'boolean'
        ? stored.completionEnabled
        : DEFAULT_CONVERSATION_SUGGESTION_SETTINGS.completionEnabled,
      starterPromptsEnabled: typeof stored.starterPromptsEnabled === 'boolean'
        ? stored.starterPromptsEnabled
        : DEFAULT_CONVERSATION_SUGGESTION_SETTINGS.starterPromptsEnabled,
    }
  } catch {
    return DEFAULT_CONVERSATION_SUGGESTION_SETTINGS
  }
}

export function saveConversationSuggestionSettings(
  settings: ConversationSuggestionSettings,
): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent<ConversationSuggestionSettings>(CHANGE_EVENT, {
    detail: settings,
  }))
}

export function onConversationSuggestionSettingsChanged(
  listener: (settings: ConversationSuggestionSettings) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<ConversationSuggestionSettings>).detail)
  }
  window.addEventListener(CHANGE_EVENT, handle)
  return () => window.removeEventListener(CHANGE_EVENT, handle)
}
