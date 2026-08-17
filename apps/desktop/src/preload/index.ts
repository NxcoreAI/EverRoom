import '@sentry/electron/preload'

import { contextBridge, ipcRenderer } from 'electron'

import type {
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
  MemoryDocumentRewriteInput,
} from '../shared/memory'
import type { DesktopRequestError, NxcoreDesktopApi } from '../shared/sources'

const requestErrorListeners = new Set<(error: DesktopRequestError) => void>()
let pendingRequestError: DesktopRequestError | null = null

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '请求失败，请稍后重试。'
  return error.message
    .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z][A-Za-z0-9]*Error|Error):\s*/, '')
    .replace(/^Error:\s*/, '')
}

function requestError(channel: string, error: unknown): DesktopRequestError {
  const message = errorMessage(error)
  if (message.includes('请求过于频繁')) {
    return { channel, severity: 'notice', title: '操作稍后继续', message }
  }
  return { channel, severity: 'error', message }
}

function reportRequestError(detail: DesktopRequestError): void {
  ipcRenderer.send('app:request-error', detail)
  if (requestErrorListeners.size === 0) pendingRequestError = detail
  else for (const listener of requestErrorListeners) listener(detail)
}

function rateLimitNotice(value: unknown): DesktopRequestError | null {
  if (!value || typeof value !== 'object') return null
  const result = value as { __everroomRateLimited?: unknown; message?: unknown }
  if (result.__everroomRateLimited !== true || typeof result.message !== 'string') return null
  return { channel: '', severity: 'notice', title: '操作稍后继续', message: result.message }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(channel, ...args) as T
    const notice = rateLimitNotice(result)
    if (!notice) return result
    notice.channel = channel
    reportRequestError(notice)
    throw new Error(notice.message)
  } catch (error) {
    if (error instanceof Error && error.message === '请求过于频繁，请稍后重试。') throw error
    const detail = requestError(channel, error)
    reportRequestError(detail)
    throw new Error(detail.message)
  }
}

async function invokeQuietly<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(channel, ...args) as T
    const notice = rateLimitNotice(result)
    if (!notice) return result
    throw new Error(notice.message)
  } catch (error) {
    throw new Error(errorMessage(error))
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
  contextRooms: {
    list: () => invokeQuietly('context-rooms:list'),
    syncSnapshot: (input: SaveContextRoomSnapshotInput) =>
      invokeQuietly('context-rooms:sync-snapshot', input),
  },
  account: {
    status: (options) => options?.quiet ? invokeQuietly('account:status', false) : invoke('account:status', true),
    devices: (options) => options?.quiet ? invokeQuietly('account:devices') : invoke('account:devices'),
    login: (input) => invoke('account:login', input),
    loginWithOidc: (provider) => invoke('account:oidc-login', provider),
    cancelOidcLogin: () => invoke('account:oidc-cancel'),
    logout: () => invoke('account:logout'),
    keyringStatus: (options) => options?.quiet ? invokeQuietly('account:keyring-status') : invoke('account:keyring-status'),
    createPairingSession: () => invoke('account:create-pairing-session'),
    getPairingSession: (id, options) => options?.quiet ? invokeQuietly('account:get-pairing-session', id) : invoke('account:get-pairing-session', id),
    approvePairingSession: (id) => invoke('account:approve-pairing-session', id),
  },
  asr: {
    requestMicrophoneAccess: () => invoke('asr:request-microphone-access'),
    openMicrophoneSettings: () => invoke('asr:open-microphone-settings'),
    openSystemAudioSettings: () => invoke('asr:open-system-audio-settings'),
    beginRecording: (mimeType) => invoke('asr:begin-recording', mimeType),
    appendRecording: (id, chunk) => invoke('asr:append-recording', id, chunk),
    finishRecording: (id) => invoke('asr:finish-recording', id),
    cancelRecording: (id) => invoke('asr:cancel-recording', id),
    createJob: (input) => invoke('asr:create-job', input),
    getJob: (id) => invoke('asr:get-job', id),
  },
  privateAudio: {
    list: (cursor?: number) => invoke('private-audio:list', cursor ?? 0),
    download: (assetId: string, outputPath: string) => invoke('private-audio:download', assetId, outputPath),
    read: (assetId: string) => invoke('private-audio:read', assetId),
  },
  transcriptions: {
    syncPrivate: (options) => options?.quiet ? invokeQuietly('transcription:sync-private') : invoke('transcription:sync-private'),
    listPrivate: () => invoke('transcription:list-private'),
    listTags: () => invoke('transcription:list-tags'),
    replaceSummaryTags: (summaryRecordId, tags) => invoke('transcription:replace-summary-tags', summaryRecordId, tags),
    renameTag: (tagId, label) => invoke('transcription:rename-tag', tagId, label),
    mergeTag: (targetTagId, sourceTagId) => invoke('transcription:merge-tag', targetTagId, sourceTagId),
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
    captureDocumentRewrite: (input: MemoryDocumentRewriteInput) =>
      invoke('memory:capture-document-rewrite', input),
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
    createSessionLink: (input) => invoke('agent:create-session-link', input),
    listSessionLinks: (sessionId) => invoke('agent:list-session-links', sessionId),
    markSessionLinkReturned: (linkId) => invoke('agent:mark-session-link-returned', linkId),
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
    list: (roomId) => invoke('documents:list', roomId),
    listTrash: (roomId) => invoke('documents:list-trash', roomId),
    get: (documentId) => invoke('documents:get', documentId),
    import: (input) => invoke('documents:import', input),
    save: (documentId, input) => invoke('documents:save', documentId, input),
    delete: (documentId) => invoke('documents:delete', documentId),
    restore: (documentId) => invoke('documents:restore', documentId),
    deletePermanently: (documentId) => invoke('documents:delete-permanently', documentId),
    emptyTrash: (roomId) => invoke('documents:empty-trash', roomId),
    acknowledge: (transactionId, input) => invoke('documents:acknowledge', transactionId, input),
    subscribe: (roomId) => invoke('documents:subscribe', roomId),
    unsubscribe: (roomId) => invoke('documents:unsubscribe', roomId),
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
