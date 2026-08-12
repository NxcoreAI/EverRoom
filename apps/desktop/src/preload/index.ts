import { contextBridge, ipcRenderer } from 'electron'

import type { NexcoreDesktopApi } from '../shared/sources'

const api: NexcoreDesktopApi = {
  platform: process.platform,
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    listFiles: (id) => ipcRenderer.invoke('sources:list-files', id),
    showFile: (id, fileId) => ipcRenderer.invoke('sources:show-file', id, fileId),
    addLocalFolder: () => ipcRenderer.invoke('sources:add-local-folder'),
    sync: (id) => ipcRenderer.invoke('sources:sync', id),
    setPaused: (id, paused) => ipcRenderer.invoke('sources:set-paused', id, paused),
    disconnect: (id, deleteLocalData) =>
      ipcRenderer.invoke('sources:disconnect', id, deleteLocalData),
  },
}

contextBridge.exposeInMainWorld('nexcore', api)
