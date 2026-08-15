import { contextBridge, ipcRenderer } from 'electron'

import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
} from '../shared/memory'
import type { DesktopRequestError, NxcoreDesktopApi } from '../shared/sources'

const requestErrorListeners = new Set<(error: DesktopRequestError) => void>()
let pendingRequestError: DesktopRequestError | null = null

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '请求失败，请稍后重试。'
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .replace(/^Error:\s*/, '')
}

function reportRequestError(detail: DesktopRequestError): void {
  console.error('[desktop-request] failed', detail)
  ipcRenderer.send('app:request-error', detail)
  if (requestErrorListeners.size === 0) pendingRequestError = detail
  else for (const listener of requestErrorListeners) listener(detail)
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const detail = { channel, message: errorMessage(error) }
    reportRequestError(detail)
    throw error
  }
}

const api: NxcoreDesktopApi = {
  platform: process.platform,
  errors: {
    onRequestError: (listener) => {
      requestErrorListeners.add(listener)
      if (pendingRequestError) {
        listener(pendingRequestError)
        pendingRequestError = null
      }
      return () => requestErrorListeners.delete(listener)
    },
    report: reportRequestError,
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
  },
  account: {
    status: () => invoke('account:status'),
    login: (input) => invoke('account:login', input),
    loginWithOidc: (provider) => invoke('account:oidc-login', provider),
    cancelOidcLogin: () => invoke('account:oidc-cancel'),
    logout: () => invoke('account:logout'),
  },
  asr: {
    openSystemAudioSettings: () => invoke('asr:open-system-audio-settings'),
    beginRecording: (mimeType) => invoke('asr:begin-recording', mimeType),
    appendRecording: (id, chunk) => invoke('asr:append-recording', id, chunk),
    finishRecording: (id) => invoke('asr:finish-recording', id),
    cancelRecording: (id) => invoke('asr:cancel-recording', id),
    createJob: (input) => invoke('asr:create-job', input),
    getJob: (id) => invoke('asr:get-job', id),
  },
  memory: {
    overview: () => invoke('memory:overview'),
    listAtomic: (options: MemoryAtomicListOptions) => invoke('memory:list-atomic', options),
    searchAtomic: (query: string, limit?: number) => invoke('memory:search-atomic', query, limit),
    updateAtomic: (id: string, content: string, background?: string) =>
      invoke('memory:update-atomic', id, content, background),
    deleteAtomic: (ids: string[]) => invoke('memory:delete-atomic', ids),
    listScenarios: (pathPrefix?: string) => invoke('memory:list-scenarios', pathPrefix),
    readScenario: (path: string) => invoke('memory:read-scenario', path),
    readCore: () => invoke('memory:read-core'),
    writeCore: (content: string) => invoke('memory:write-core', content),
    listConversations: (options: MemoryConversationListOptions) =>
      invoke('memory:list-conversations', options),
    searchConversations: (query: string, limit?: number, sessionId?: string) =>
      invoke('memory:search-conversations', query, limit, sessionId),
    deleteConversations: (target: { sessionIds?: string[]; messageIds?: string[] }) =>
      invoke('memory:delete-conversations', target),
  },
  reality: {
    listEvents: (filters) => invoke('reality:list-events', filters),
    getEvent: (id) => invoke('reality:get-event', id),
    createEvent: (input) => invoke('reality:create-event', input),
    finishCapture: (id, input) => invoke('reality:finish-capture', id, input),
    updateTranscript: (id, input) => invoke('reality:update-transcript', id, input),
    addMarker: (id, input) => invoke('reality:add-marker', id, input),
    confirm: (id) => invoke('reality:confirm', id),
    discard: (id) => invoke('reality:discard', id),
    fail: (id, error) => invoke('reality:fail', id, error),
    readAudio: (id) => invoke('reality:read-audio', id),
    subscribe: () => invoke('reality:subscribe'),
    unsubscribe: () => invoke('reality:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('reality:event', handleEvent)
      return () => ipcRenderer.removeListener('reality:event', handleEvent)
    },
  },
  agent: {
    listSessions: (pageLabel, roomId) => invoke('agent:list-sessions', pageLabel, roomId),
    createSession: (input) => invoke('agent:create-session', input),
    updateSession: (sessionId, input) => invoke('agent:update-session', sessionId, input),
    deleteSession: (sessionId) => invoke('agent:delete-session', sessionId),
    getSession: (sessionId) => invoke('agent:get-session', sessionId),
    getEvents: (sessionId, runId, afterSeq) =>
      invoke('agent:get-events', sessionId, runId, afterSeq),
    startRun: (sessionId, input) => invoke('agent:start-run', sessionId, input),
    cancelRun: (runId) => invoke('agent:cancel-run', runId),
    subscribe: (sessionId) => invoke('agent:subscribe', sessionId),
    unsubscribe: () => invoke('agent:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('agent:event', handleEvent)
      return () => ipcRenderer.removeListener('agent:event', handleEvent)
    },
  },
  documents: {
    list: (roomId) => ipcRenderer.invoke('documents:list', roomId),
    get: (documentId) => ipcRenderer.invoke('documents:get', documentId),
    import: (input) => ipcRenderer.invoke('documents:import', input),
    save: (documentId, input) => ipcRenderer.invoke('documents:save', documentId, input),
    delete: (documentId) => ipcRenderer.invoke('documents:delete', documentId),
    acknowledge: (transactionId, input) => ipcRenderer.invoke('documents:acknowledge', transactionId, input),
    subscribe: (roomId) => ipcRenderer.invoke('documents:subscribe', roomId),
    unsubscribe: (roomId) => ipcRenderer.invoke('documents:unsubscribe', roomId),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('documents:event', handleEvent)
      return () => ipcRenderer.removeListener('documents:event', handleEvent)
    },
  },
  sources: {
    list: () => invoke('sources:list'),
    listFiles: (id) => invoke('sources:list-files', id),
    listEvidence: (id, fileId) => invoke('sources:list-evidence', id, fileId),
    searchEvidence: (query, id) => invoke('sources:search-evidence', query, id),
    onChanged: (listener) => {
      const handleChanged = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => {
        listener(payload)
      }
      ipcRenderer.on('sources:changed', handleChanged)
      return () => ipcRenderer.removeListener('sources:changed', handleChanged)
    },
    showFile: (id, fileId) => invoke('sources:show-file', id, fileId),
    addLocalFolder: () => invoke('sources:add-local-folder'),
    addGitHub: (input) => invoke('sources:add-github', input),
    sync: (id) => invoke('sources:sync', id),
    setPaused: (id, paused) => invoke('sources:set-paused', id, paused),
    disconnect: (id, deleteLocalData) =>
      invoke('sources:disconnect', id, deleteLocalData),
  },
}

contextBridge.exposeInMainWorld('nxcore', api)
