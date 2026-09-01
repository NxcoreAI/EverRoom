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
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: true })

    const values = installWindow(JSON.stringify({ enabled: false, paragraphEnabled: true }))
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: false, paragraphEnabled: true })
    expect(values.size).toBe(1)
  })

  it('notifies mounted editors immediately when the setting changes', () => {
    const values = installWindow()
    const changes: boolean[] = []
    const unsubscribe = onDocumentCursorCompletionSettingsChanged((settings) => {
      changes.push(settings.enabled)
    })

    saveDocumentCursorCompletionSettings({ enabled: false, paragraphEnabled: true })

    expect(changes).toEqual([false])
    expect([...values.values()]).toEqual([JSON.stringify({ enabled: false, paragraphEnabled: true })])
    unsubscribe()
  })

  it('falls back to enabled when stored data is malformed', () => {
    installWindow('{broken')
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: true })
  })

  it('defaults the paragraph tier on and preserves an explicit opt-out independently', () => {
    installWindow()
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: true })

    // 旧版本存储（无 paragraphEnabled 字段）→ 段落档回退默认开
    installWindow(JSON.stringify({ enabled: true }))
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: true })

    const values = installWindow(JSON.stringify({ enabled: true, paragraphEnabled: false }))
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: false })

    // 字段类型异常时按默认值处理，不抛错
    installWindow(JSON.stringify({ enabled: true, paragraphEnabled: 'off' }))
    expect(loadDocumentCursorCompletionSettings()).toEqual({ enabled: true, paragraphEnabled: true })
    expect(values.size).toBe(1)
  })
})
