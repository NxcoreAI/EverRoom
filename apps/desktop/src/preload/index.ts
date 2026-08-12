import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('nexcore', {
  platform: process.platform,
})
