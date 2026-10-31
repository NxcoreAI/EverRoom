import { useCallback, useEffect, useState } from 'react'

import { fetchRealFiles, type RealOfficeFile } from '@/office-proto/data'

export type FileLibraryState = 'loading' | 'ready' | 'unavailable'

export interface FileLibrarySnapshot {
  state: FileLibraryState
  /** 只包含可打开文档（docx/xlsx/pptx/pdf/md）的文件库条目。 */
  items: RealOfficeFile[]
  /** 文件库全量条目数（分页语义，不受 limit 影响）。 */
  total: number
}

export interface FileLibrary extends FileLibrarySnapshot {
  reload(): void
}

/**
 * 真实文件库快照（`window.nxcore.files.list` → `fetchRealFiles`）。
 *
 * - 无 preload 桥或网关失败：`state === 'unavailable'`，页面显示不可用态，**不回退 mock 文件**。
 * - `reload` 用于导入文件后刷新；已有数据时保留旧列表，避免整页闪空。
 */
export function useFileLibrary(limit: number): FileLibrary {
  const [snapshot, setSnapshot] = useState<FileLibrarySnapshot>({ state: 'loading', items: [], total: 0 })
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => {
    setSnapshot((current) => current.state === 'ready' ? current : { state: 'loading', items: [], total: 0 })
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchRealFiles(limit).then((result) => {
      if (cancelled) return
      if (!result) {
        setSnapshot({ state: 'unavailable', items: [], total: 0 })
        return
      }
      setSnapshot({ state: 'ready', items: result.items, total: result.total })
    })
    return () => { cancelled = true }
  }, [limit, nonce])

  return { ...snapshot, reload }
}
