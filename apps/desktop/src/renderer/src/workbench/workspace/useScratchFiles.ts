import { useCallback, useEffect, useState } from 'react'

import type { AgentScratchListing } from '@nxcore/agent-contract'

/**
 * `.tmp/`（Agent 过程缓存）只读清单。
 *
 * 网关刻意不把 scratch 入资料库索引（随时会被 GC，进索引只产生 missing 噪音），
 * 这里走独立的 `/cache/scratch` 只读清单，在「资料」页目录树里挂成 `.tmp` 目录。
 * 桥不存在 / 网关未就绪时视为「没有临时文件」，不阻塞资料页。
 */
export interface ScratchFiles {
  state: 'loading' | 'ready' | 'unavailable'
  listing: AgentScratchListing | null
  refresh(): void
}

export function useScratchFiles(workspaceId?: string): ScratchFiles {
  const scope = workspaceId?.trim() || null
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [listing, setListing] = useState<AgentScratchListing | null>(null)

  const load = useCallback(async () => {
    const bridge = window.nxcore?.workspace
    if (!scope || typeof bridge?.scratchFiles !== 'function') {
      setListing(null)
      setState('unavailable')
      return
    }
    try {
      const result = await bridge.scratchFiles(scope)
      setListing(result)
      setState('ready')
    } catch {
      // 空间未绑定目录等业务空态：清单置空即可，不把资料页整体拖进错误态。
      setListing(null)
      setState('ready')
    }
  }, [scope])

  useEffect(() => {
    setState('loading')
    void load()
  }, [load])

  const refresh = useCallback(() => {
    void load()
  }, [load])

  return { state, listing, refresh }
}
