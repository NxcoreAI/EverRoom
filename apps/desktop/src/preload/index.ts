import { contextBridge, ipcRenderer } from 'electron'

import type { NxcoreDesktopApi } from '../shared/sources'

const api: NxcoreDesktopApi = {
  platform: process.platform,
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
  },
  account: {
    status: () => ipcRenderer.invoke('account:status'),
    login: (input) => ipcRenderer.invoke('account:login', input),
    logout: () => ipcRenderer.invoke('account:logout'),
  },
  asr: {
    beginRecording: (mimeType) => ipcRenderer.invoke('asr:begin-recording', mimeType),
    appendRecording: (id, chunk) => ipcRenderer.invoke('asr:append-recording', id, chunk),
    finishRecording: (id) => ipcRenderer.invoke('asr:finish-recording', id),
    cancelRecording: (id) => ipcRenderer.invoke('asr:cancel-recording', id),
    createJob: (input) => ipcRenderer.invoke('asr:create-job', input),
    getJob: (id) => ipcRenderer.invoke('asr:get-job', id),
  },
  agent: {
    listSessions: (pageLabel) => ipcRenderer.invoke('agent:list-sessions', pageLabel),
    createSession: (input) => ipcRenderer.invoke('agent:create-session', input),
    updateSession: (sessionId, input) => ipcRenderer.invoke('agent:update-session', sessionId, input),
    deleteSession: (sessionId) => ipcRenderer.invoke('agent:delete-session', sessionId),
    getSession: (sessionId) => ipcRenderer.invoke('agent:get-session', sessionId),
    getEvents: (sessionId, runId, afterSeq) =>
      ipcRenderer.invoke('agent:get-events', sessionId, runId, afterSeq),
    startRun: (sessionId, input) => ipcRenderer.invoke('agent:start-run', sessionId, input),
    cancelRun: (runId) => ipcRenderer.invoke('agent:cancel-run', runId),
    subscribe: (sessionId) => ipcRenderer.invoke('agent:subscribe', sessionId),
    unsubscribe: () => ipcRenderer.invoke('agent:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('agent:event', handleEvent)
      return () => ipcRenderer.removeListener('agent:event', handleEvent)
    },
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    listFiles: (id) => ipcRenderer.invoke('sources:list-files', id),
    listEvidence: (id, fileId) => ipcRenderer.invoke('sources:list-evidence', id, fileId),
    searchEvidence: (query, id) => ipcRenderer.invoke('sources:search-evidence', query, id),
    onChanged: (listener) => {
      const handleChanged = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => {
        listener(payload)
      }
      ipcRenderer.on('sources:changed', handleChanged)
      return () => ipcRenderer.removeListener('sources:changed', handleChanged)
    },
    showFile: (id, fileId) => ipcRenderer.invoke('sources:show-file', id, fileId),
    addLocalFolder: () => ipcRenderer.invoke('sources:add-local-folder'),
    addGitHub: (input) => ipcRenderer.invoke('sources:add-github', input),
    sync: (id) => ipcRenderer.invoke('sources:sync', id),
    setPaused: (id, paused) => ipcRenderer.invoke('sources:set-paused', id, paused),
    disconnect: (id, deleteLocalData) =>
      ipcRenderer.invoke('sources:disconnect', id, deleteLocalData),
  },
}

contextBridge.exposeInMainWorld('nxcore', api)
