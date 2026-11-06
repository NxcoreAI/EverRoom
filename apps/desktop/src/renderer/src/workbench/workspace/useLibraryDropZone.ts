import { useCallback, useState } from 'react'

/**
 * 资料库页的访达拖放落点：包装 dragenter/dragleave 计数与 drop 分发。
 *
 * - 落点挂在页面根节点（.wb-library-page），空库/加载/不可用态也能拖进来；
 * - dragenter/dragleave 用计数而不是布尔：经过子元素时 leave 先于 enter 触发，
 *   布尔会在交界处闪一下「未悬停」；
 * - 只认 Files 类型（应用内拖动文件夹瓦片/计划卡片不是文件拖放，不拦截）；
 * - dataTransfer 可能为 undefined（合成事件/异常环境），防御式读取。
 */
export interface LibraryDropZone {
  /** 有文件正悬停在落点上（渲染高亮 + 提示覆盖层）。 */
  dragActive: boolean
  dragProps: {
    onDragOver: (event: React.DragEvent) => void
    onDragEnter: (event: React.DragEvent) => void
    onDragLeave: (event: React.DragEvent) => void
    onDrop: (event: React.DragEvent) => void
  }
}

export function useLibraryDropZone(onDropFiles: (files: File[]) => void): LibraryDropZone {
  const [depth, setDepth] = useState(0)

  const hasFiles = (event: React.DragEvent): boolean => {
    const types = event.dataTransfer?.types
    return Array.isArray(types) && types.includes('Files')
  }

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDepth((value) => value + 1)
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!hasFiles(event)) return
    setDepth((value) => Math.max(0, value - 1))
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDepth(0)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) onDropFiles(files)
  }, [onDropFiles])

  return {
    dragActive: depth > 0,
    dragProps: { onDragOver, onDragEnter, onDragLeave, onDrop },
  }
}
