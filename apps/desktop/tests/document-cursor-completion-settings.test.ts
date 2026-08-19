import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  loadDocumentCursorCompletionSettings,
  onDocumentCursorCompletionSettingsChanged,
  saveDocumentCursorCompletionSettings,
} from '../src/renderer/src/state/documentCursorCompletionSettings'

function installWindow(storedValue: string | null = null) {
  const values = new Map<string, string>()
  if (storedValue !== null) {
    values.set('everroom:document-cursor-completion-settings:v1', storedValue)
  }
  const target = new EventTarget()
  Object.defineProperty(target, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  vi.stubGlobal('window', target)
  return values
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('document cursor completion settings', () => {
  it('defaults to enabled and preserves an explicit disabled preference', () => {
    installWindow()
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true })

    const values = installWindow(JSON.stringify({ enabled: false }))
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: false })
    expect(values.size).toBe(1)
  })

  it('notifies mounted editors immediately when the setting changes', () => {
    const values = installWindow()
    const changes: boolean[] = []
    const unsubscribe = onDocumentCursorCompletionSettingsChanged((settings) => {
      changes.push(settings.enabled)
    })

    saveDocumentCursorCompletionSettings({ enabled: false })

    expect(changes).toEqual([false])
    expect([...values.values()]).toEqual([JSON.stringify({ enabled: false })])
    unsubscribe()
  })

  it('falls back to enabled when stored data is malformed', () => {
    installWindow('{broken')
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true })
  })
})
