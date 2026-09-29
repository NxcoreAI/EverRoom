import { app, ipcMain, webContents } from 'electron'
import { join } from 'node:path'
import {
  getCloudControlSettings,
  initCloudControlStore,
  onCloudControlSettingsChanged,
  pickCloudControlPatch,
  updateCloudControlSettings,
} from './cloud-control-store'

export function registerCloudControlIpc(): void {
  initCloudControlStore(join(app.getPath('userData'), 'cloud-control.json'))
  ipcMain.handle('cloud-control:settings', () => getCloudControlSettings())
  ipcMain.handle('cloud-control:update-settings', (_event, input: unknown) => {
    updateCloudControlSettings(pickCloudControlPatch(input))
  })
  onCloudControlSettingsChanged((settings) => {
    for (const contents of webContents.getAllWebContents()) contents.send('cloud-control:changed', settings)
  })
}
