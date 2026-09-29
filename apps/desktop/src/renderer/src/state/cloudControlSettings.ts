import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_CLOUD_CONTROL_SETTINGS, type CloudControlSettings } from '../../../shared/sources'

export interface CloudControlState {
  settings: CloudControlSettings
  ready: boolean
  update(patch: Partial<CloudControlSettings>): Promise<void>
}

/** 主进程为权威存储；renderer 经 IPC 读改，变更经 cloud-control:changed 推回。 */
export function useCloudControlSettings(): CloudControlState {
  const [settings, setSettings] = useState<CloudControlSettings>(DEFAULT_CLOUD_CONTROL_SETTINGS)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const api = window.nxcore?.cloudControl
    if (!api) return
    let alive = true
    void api.settings().then((value) => {
      if (!alive) return
      setSettings(value)
      setReady(true)
    })
    const off = api.onChanged((value) => setSettings(value))
    return () => {
      alive = false
      off()
    }
  }, [])
  const update = useCallback(async (patch: Partial<CloudControlSettings>) => {
    const next = await window.nxcore?.cloudControl?.update(patch)
    if (next) setSettings(next)
  }, [])
  return { settings, ready, update }
}
