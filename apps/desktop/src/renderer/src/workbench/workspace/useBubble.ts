import { useCallback, useEffect, useRef, useState } from 'react'

import type { OfficeFile } from '@/office-proto/data'

import { closeOfficeFile, registerTabCloser } from '../state/store'

export const BUBBLE_MIN_WIDTH = 360
export const BUBBLE_MAX_WIDTH = 720
export const BUBBLE_DEFAULT_WIDTH = 480

/** 退场动画时长（与 bubble.css 的 keyframes 对齐，留 20ms 余量后再卸载 DOM）。 */
const EXIT_MS = 240

export type BubbleExitKind = 'close' | 'minimize'

export interface BubbleState {
  mode: 'closed' | 'open' | 'minimized'
  width: number
  maximized: boolean
  files: OfficeFile[]
  /** null = 处于「浏览资料与文件」列表态（不挂载编辑器）。 */
  activeFileId: string | null
}

const CLOSED: BubbleState = {
  mode: 'closed',
  width: BUBBLE_DEFAULT_WIDTH,
  maximized: false,
  files: [],
  activeFileId: null,
}

/**
 * 工作空间文件面板的状态机（组件级，一个工作空间标签一套，多开天然隔离）。
 *
 * 关键点：可见性 / 退场动画在这里统一管理，宿主只按 visible + exitKind 渲染，
 * 避免「收起 → 长条把手 → 再展开」两套 UI 切换造成的闪烁：
 * - 打开/还原：面板挂载，宽度从 0 动画到目标宽度，内容区同步让位；
 * - 收起（minimize）/关闭（close）：面板宽度动画收到 0，结束后直接卸载；
 *   收起后对话区右上角的入口按钮重新出现（外观与首次完全一致，没有长条）；
 * - 最大化/还原也走宽度过渡（面板始终在 flex 布局里），对话区逐帧跟着变。
 */
export function useWorkspaceBubble(tabId: string) {
  const [bubble, setBubble] = useState<BubbleState>(CLOSED)
  const [visible, setVisible] = useState(false)
  const [exitKind, setExitKind] = useState<BubbleExitKind | null>(null)
  const bubbleRef = useRef(bubble)
  bubbleRef.current = bubble
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const exitKindRef = useRef(exitKind)
  exitKindRef.current = exitKind
  const exitTimer = useRef<number | null>(null)

  const clearExitTimer = useCallback(() => {
    if (exitTimer.current !== null) {
      window.clearTimeout(exitTimer.current)
      exitTimer.current = null
    }
  }, [])

  useEffect(() => clearExitTimer, [clearExitTimer])

  /** 显示面板（取消进行中的退场）：mode 统一回 open。 */
  const show = useCallback((patch: (current: BubbleState) => Partial<BubbleState>) => {
    clearExitTimer()
    // 关闭动画还没结束时又打开：关闭前已确认过的文件已经关掉，这里清掉它们的标签。
    const wasClosing = exitKindRef.current === 'close'
    setExitKind(null)
    setVisible(true)
    setBubble((current) => {
      const base = wasClosing ? { ...current, files: [], activeFileId: null } : current
      return { ...base, ...patch(base), mode: 'open' }
    })
  }, [clearExitTimer])

  const openFile = useCallback((file: OfficeFile) => {
    show((current) => ({
      files: current.files.some((item) => item.id === file.id)
        ? current.files.map((item) => (item.id === file.id ? file : item))
        : [...current.files, file],
      activeFileId: file.id,
    }))
  }, [show])

  /** 打开「资料与文件」浏览态；已打开的文件标签保留。 */
  const openBrowser = useCallback(() => {
    show(() => ({ activeFileId: null }))
  }, [show])

  const restore = useCallback(() => {
    show(() => ({}))
  }, [show])

  const activateFile = useCallback((fileId: string) => {
    if (!bubbleRef.current.files.some((item) => item.id === fileId)) return
    show(() => ({ activeFileId: fileId }))
  }, [show])

  const beginExit = useCallback((kind: BubbleExitKind) => {
    clearExitTimer()
    setExitKind(kind)
    // 注意：退场期间保留 maximized 状态——最大化面板的宽度是 CSS clamp 值，
    // 提前改成 false 会让退场动画从 480px 起点开始跳一下。
    setBubble((current) => ({
      ...current,
      mode: kind === 'minimize' ? 'minimized' : 'closed',
    }))
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null
      // 关闭：退场动画期间保留内容，结束后再清空标签（避免文档瞬间变成文件列表）。
      if (kind === 'close') {
        setBubble((current) => ({ ...current, files: [], activeFileId: null, maximized: false }))
      }
      setVisible(false)
      setExitKind(null)
    }, EXIT_MS)
  }, [clearExitTimer])

  const minimize = useCallback(() => {
    if (!visibleRef.current) return
    beginExit('minimize')
  }, [beginExit])

  const closeFile = useCallback(async (fileId: string): Promise<boolean> => {
    const file = bubbleRef.current.files.find((item) => item.id === fileId)
    if (!file) return true
    if (!(await closeOfficeFile(file))) return false
    setBubble((current) => {
      const index = current.files.findIndex((item) => item.id === fileId)
      const files = current.files.filter((item) => item.id !== fileId)
      const activeFileId = current.activeFileId === fileId
        ? (files[Math.min(index, files.length - 1)]?.id ?? null)
        : current.activeFileId
      // 关掉最后一个文件后回浏览列表，面板不收起。
      return { ...current, files, activeFileId }
    })
    return true
  }, [])

  const closeAll = useCallback(async (): Promise<boolean> => {
    for (const file of [...bubbleRef.current.files]) {
      if (!(await closeOfficeFile(file))) return false
    }
    beginExit('close')
    return true
  }, [beginExit])

  const close = useCallback(() => {
    void closeAll()
  }, [closeAll])

  const toggleMaximize = useCallback(() => {
    setBubble((current) => ({ ...current, maximized: !current.maximized }))
  }, [])

  const setWidth = useCallback((width: number) => {
    setBubble((current) => ({
      ...current,
      width: Math.min(BUBBLE_MAX_WIDTH, Math.max(BUBBLE_MIN_WIDTH, width)),
    }))
  }, [])

  useEffect(() => registerTabCloser(tabId, async () => {
    if (!visibleRef.current) return true
    return closeAll()
  }), [closeAll, tabId])

  return {
    bubble,
    visible,
    exitKind,
    openBrowser,
    openFile,
    activateFile,
    closeFile,
    closeAll,
    close,
    minimize,
    restore,
    toggleMaximize,
    setWidth,
  }
}
