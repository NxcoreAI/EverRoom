export type RealityTranscriptionMode = 'auto' | 'local' | 'cloud'
export type RealityAudioSource = 'microphone' | 'system'

export interface RealitySettings {
  mode: RealityTranscriptionMode
  audioSource: RealityAudioSource
  languages: string[]
}

const STORAGE_KEY = 'everroom:reality-settings:v1'
const CHANGE_EVENT = 'everroom:reality-settings-changed'

export const DEFAULT_REALITY_SETTINGS: RealitySettings = {
  mode: 'auto',
  audioSource: 'microphone',
  languages: ['zh', 'en'],
}

export function loadRealitySettings(): RealitySettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<RealitySettings>
    const storedLanguages = Array.isArray(stored.languages)
      ? stored.languages.filter((value): value is string => value === 'zh' || value === 'en')
      : []
    return {
      mode: stored.mode === 'local' || stored.mode === 'cloud' ? stored.mode : 'auto',
      audioSource: stored.audioSource === 'system' ? 'system' : 'microphone',
      languages: storedLanguages.length > 0 ? storedLanguages : DEFAULT_REALITY_SETTINGS.languages,
    }
  } catch {
    return DEFAULT_REALITY_SETTINGS
  }
}

export function saveRealitySettings(settings: RealitySettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent<RealitySettings>(CHANGE_EVENT, { detail: settings }))
}

export function onRealitySettingsChanged(listener: (settings: RealitySettings) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<RealitySettings>).detail)
  window.addEventListener(CHANGE_EVENT, handle)
  return () => window.removeEventListener(CHANGE_EVENT, handle)
}
