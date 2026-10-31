import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchRealFiles, type RealOfficeFile } from '@/office-proto/data'

/**
 * 文件库单次拉取上限。
 *
 * `files.list(limit, offset)` 单页最多 200 条（网关硬限制），资料库/产物页都只拉
 * 「最近更新的一页」，搜索/筛选全部在前端做（与已删除的 FileLibraryList 同口径）。
 * 超过一页时页面会如实提示「还有更早的文件未加载」，不伪造全量。
 */
export const FILE_LIBRARY_LIMIT = 200

export type FileLibraryState = 'loading' | 'ready' | 'unavailable'

/** 导入结果摘要（pickAndImport 的逐文件结果归一）。 */
export type FileImportSummary =
  /** 用户取消选择（或没有选中任何文件）。 */
  | { kind: 'cancelled' }
  | { kind: 'done'; imported: number; failed: number; skipped: number }

export interface FileLibrary {
  state: FileLibraryState
  items: RealOfficeFile[]
  /** 文件库全量计数（分页语义，不受 limit 影响）。 */
  total: number
  /** 刷新中（保留旧列表，只转刷新图标）。 */
  refreshing: boolean
  /** 导入进行中（导入按钮禁用）。 */
  importing: boolean
  refresh(): void
  /**
   * 打开系统选择框导入文件，完成后自动刷新列表。
   * 返回 null 表示桌面端没有文件库桥（浏览器预览/网关不可用）。
   * 导入调用本身异常时抛出，由页面转成 toast。
   */
  importFiles(): Promise<FileImportSummary | null>
}

function sortByUpdatedDesc(items: readonly RealOfficeFile[]): RealOfficeFile[] {
  return [...items].sort((left, right) => {
    const leftAt = Date.parse(left.catalog.updatedAt)
    const rightAt = Date.parse(right.catalog.updatedAt)
    if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return 0
    return rightAt - leftAt
  })
}

/**
 * 真实文件库数据源：读 `window.nxcore.files.list`。
 * workspaceId = 按工作空间过滤（资料库/产物库独立）；未传/为空拉全库
 * （主页「所有文件」等全局入口用）。工作空间变化时自动重拉。
 */
export function useFileLibrary(workspaceId?: string): FileLibrary {
  const [state, setState] = useState<FileLibraryState>('loading')
  const [items, setItems] = useState<RealOfficeFile[]>([])
  const [total, setTotal] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [importing, setImporting] = useState(false)
  const requestSeq = useRef(0)
  // 以 workspaceId 为请求键：切换空间时旧响应直接作废，不回写新空间列表。
  const scope = workspaceId?.trim() || null

  const load = useCallback(async (initial: boolean) => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    if (initial) setState('loading')
    else setRefreshing(true)
    const result = await fetchRealFiles(FILE_LIBRARY_LIMIT, scope ? { workspaceId: scope } : undefined)
    // 并发刷新时只认最后一次请求，避免旧响应回写。
    if (seq !== requestSeq.current) return
    if (!result) {
      setItems([])
      setTotal(0)
      setState('unavailable')
    } else {
      setItems(sortByUpdatedDesc(result.items))
      setTotal(result.total)
      setState('ready')
    }
    setRefreshing(false)
  }, [scope])

  useEffect(() => {
    void load(true)
  }, [load])

  // 新文件落库（Agent 生成、论文排版成品…）→ 自动重拉当前空间第一页。
  // 主进程已经广播 office:agent-file；这里消费它，用户不必再手动点刷新
  // ——排版完成后成品本来就在库里，只是列表没跟着更新，看起来像「没出效果」。
  useEffect(() => {
    const office = window.nxcore?.office
    if (typeof office?.onAgentFile !== 'function') return
    return office.onAgentFile((event) => {
      if (event.type !== 'done' && event.type !== 'edited') return
      // 事件带归属时只刷新对应空间：别的空间的成品不该打断当前列表。
      if (event.workspaceId && scope && event.workspaceId !== scope) return
      void load(false)
    })
  }, [load, scope])

  const refresh = useCallback(() => {
    void load(false)
  }, [load])

  const importFiles = useCallback(async (): Promise<FileImportSummary | null> => {
    const api = window.nxcore?.files
    if (!api?.pickAndImport) return null
    setImporting(true)
    try {
      const outcomes = await api.pickAndImport(scope ? { workspaceId: scope } : undefined)
      const list = Array.isArray(outcomes) ? outcomes : []
      if (list.length === 0) return { kind: 'cancelled' }
      let imported = 0
      let failed = 0
      let skipped = 0
      for (const outcome of list) {
        if (outcome.error) failed += 1
        else if (outcome.fileId) imported += 1
        else skipped += 1
      }
      // 导入后重新拉一页，让新文件立刻出现（排序本来就是最近更新在前）。
      await load(false)
      return { kind: 'done', imported, failed, skipped }
    } finally {
      setImporting(false)
    }
  }, [load, scope])

  return { state, items, total, refreshing, importing, refresh, importFiles }
}
