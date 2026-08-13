import { contextBridge, ipcRenderer } from 'electron'

import type { NexcoreDesktopApi } from '../shared/sources'

const api: NexcoreDesktopApi = {
  platform: process.platform,
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
    sync: (id) => ipcRenderer.invoke('sources:sync', id),
    setPaused: (id, paused) => ipcRenderer.invoke('sources:set-paused', id, paused),
    disconnect: (id, deleteLocalData) =>
      ipcRenderer.invoke('sources:disconnect', id, deleteLocalData),
  },
}

contextBridge.exposeInMainWorld('nexcore', api)
