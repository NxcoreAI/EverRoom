import { useCallback, useEffect, useState } from 'react'
import type { NxcoreDesktopApi } from '../../../shared/sources'
import type { AppPrefs } from '../../../main/settings/app-prefs-store'

/** preload 桥形状（NxcoreDesktopApi 的 appPrefs 字段由主会话补进 shared；过渡期本地声明，结构一致）。 */
export interface AppPrefsBridge {
  settings(): Promise<AppPrefs>
  update(input: Partial<AppPrefs>): Promise<AppPrefs>
  onChanged(listener: (prefs: AppPrefs) => void): () => void
}

type NxcoreWithAppPrefs = NxcoreDesktopApi & { appPrefs?: AppPrefsBridge }

export interface AppPrefsState {
  prefs: AppPrefs
  ready: boolean
  update(patch: Partial<AppPrefs>): Promise<void>
}

/** 主进程为权威存储；renderer 经 IPC 读改，变更经 app-prefs:changed 推回。 */
export function useAppPrefs(): AppPrefsState {  const [prefs, setPrefs] = useState<AppPrefs>({ saasBaseUrl: null, updateFeedUrl: null, crashReporting: true })
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const api = (window.nxcore as NxcoreWithAppPrefs | undefined)?.appPrefs
    if (!api) return
    let alive = true
    void api.settings().then((value) => {
      if (!alive) return
      setPrefs(value)
      setReady(true)
    })
    const off = api.onChanged((value) => setPrefs(value))
    return () => {
      alive = false
      off()
    }
  }, [])
  const update = useCallback(async (patch: Partial<AppPrefs>) => {
    const next = await (window.nxcore as NxcoreWithAppPrefs | undefined)?.appPrefs?.update(patch)
    if (next) setPrefs(next)
  }, [])
  return { prefs, ready, update }
}
