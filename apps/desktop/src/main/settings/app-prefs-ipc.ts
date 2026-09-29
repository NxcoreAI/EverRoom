import { app, ipcMain, webContents } from 'electron'
import { join } from 'node:path'
import {
  getAppPrefs,
  initAppPrefsStore,
  onAppPrefsChanged,
  pickAppPrefsPatch,
  updateAppPrefs,
} from './app-prefs-store'

export function registerAppPrefsIpc(): void {
  initAppPrefsStore(join(app.getPath('userData'), 'app-prefs.json'))
  ipcMain.handle('app-prefs:settings', () => getAppPrefs())
  ipcMain.handle('app-prefs:update-settings', (_event, input: unknown) => {
    updateAppPrefs(pickAppPrefsPatch(input))
  })
  onAppPrefsChanged((prefs) => {
    for (const contents of webContents.getAllWebContents()) contents.send('app-prefs:changed', prefs)
  })
}
