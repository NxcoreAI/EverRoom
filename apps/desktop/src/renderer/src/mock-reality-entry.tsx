// 临时入口：纯浏览器单挂 RealityPage，验证事件卡实时转写
// （window.__live.push(...) 脚本化驱动 onSegmentTranscription 推送）。
import React from 'react'
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { AccountProvider } from './state/AccountContext'
import { RealityPage } from './components/reality/RealityPage'
import type { RealityEvent } from '../../shared/sources'
import '@/styles/tokens.css'
import './styles.css'

const startedAt = new Date(Date.now() - 40_000).toISOString()

const ongoing: RealityEvent = {
  id: 'rec-live-1',
  title: '桌面感知 14:00',
  status: 'ongoing',
  processingState: 'capturing',
  captureDevice: { id: 'desktop-local', name: '这台 Mac', kind: 'desktop' },
  processingDevice: 'desktop',
  audioSource: 'microphone',
  audioFileName: null,
  audioMimeType: 'audio/webm',
  durationMs: 40_000,
  currentTopic: null,
  transcript: '',
  transcriptSegments: [],
  transcriptEditedAt: null,
  insights: {
    currentTopic: null,
    summary: null,
    keyPoints: [],
    decisions: [],
    actionItems: [],
    people: [],
    projects: [],
    unresolvedQuestions: [],
  },
  markers: [],
  important: false,
  asrJobId: null,
  asrSource: null,
  error: null,
  version: 1,
  startedAt,
  endedAt: null,
  createdAt: startedAt,
  updatedAt: startedAt,
}

const liveListeners: Array<(event: { recordingId: string; index: number; result: { transcript: string; segments: unknown[] } }) => void> = []

window.__live = {
  push(recordingId: string, index: number, texts: string[]) {
    const base = index * 15_000
    const segments = texts.map((text, i) => ({
      text,
      beginTime: base + i * 4_000,
      endTime: base + (i + 1) * 4_000,
      speakerId: 1,
      speakerName: null,
    }))
    for (const listener of liveListeners) {
      listener({ recordingId, index, result: { transcript: texts.join(' '), segments } })
    }
  },
}

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'reality') {
      return {
        ...((target.reality as object) ?? {}),
        listEvents: async () => [ongoing],
        getEvent: async () => ongoing,
        onEvent: () => () => undefined,
        subscribe: async () => undefined,
        unsubscribe: async () => undefined,
      }
    }
    if (prop === 'screenCapture') {
      return {
        ...((target.screenCapture as object) ?? {}),
        listPerceptionNodes: async () => ({ items: [], nextCursor: null }),
      }
    }
    if (prop === 'asr') {
      return {
        ...((target.asr as object) ?? {}),
        onSegmentTranscription: (listener: (event: { recordingId: string; index: number; result: { transcript: string; segments: unknown[] } }) => void) => {
          liveListeners.push(listener)
          return () => {
            const at = liveListeners.indexOf(listener)
            if (at >= 0) liveListeners.splice(at, 1)
          }
        },
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

declare global {
  interface Window {
    __live?: { push(recordingId: string, index: number, texts: string[]): void }
  }
}

function App() {
  return (
    <LocaleProvider>
      <AccountProvider>
        <RealityPage onOpenSettings={() => undefined} />
      </AccountProvider>
    </LocaleProvider>
  )
}

createRoot(document.getElementById('mock-root')!).render(<App />)
