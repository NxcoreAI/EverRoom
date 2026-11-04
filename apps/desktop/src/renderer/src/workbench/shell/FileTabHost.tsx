import { EditorView } from '@/office-proto/EditorView'

import type { FileTab } from '../types'
import { workbenchToast } from './toast'

/**
 * 文件标签：全宽编辑器 + 右侧 Agent 停靠栏（复用 office-proto 的 EditorView）。
 * 原生编辑器实例同一时刻只能有一个可见：只在激活标签挂载 EditorView，
 * 切走时宿主卸载 → 矩形归零 → 主进程隐藏实例；切回来重新 open（幂等）并重报矩形。
 */
export function FileTabHost({ tab }: { tab: FileTab }) {
  return (
    <div className="wb-filetab">
      <EditorView
        key={tab.file.id}
        file={tab.file}
        onToast={workbenchToast}
      />
    </div>
  )
}
