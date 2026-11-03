/** Agent 生成 Office 文件的主进程 → 渲染层事件（channel office:agent-file）。 */
export type OfficeAgentFileFormat = 'docx' | 'pptx' | 'xlsx'

export interface OfficeAgentFileEvent {
  type: 'phase' | 'done' | 'error' | 'edited' | 'open-edit' | 'write-back-failed'
  title: string
  /** 缺省 docx（旧事件无此字段）。 */
  format?: OfficeAgentFileFormat
  phase?: 'rendering' | 'saved' | 'importing'
  /** done：fileEntryId，渲染层用它自动打开预览。 */
  fileId?: string
  originalName?: string
  roomId?: string | null
  /** 产物归属工作区（资料库/产物库按空间隔离）；排版产物落在这份空间。 */
  workspaceId?: string
  message?: string
  /** done：部分完成（有页失败/退化）——不走「已生成」文案。 */
  partial?: boolean
  /** done：已落定的页数（pptx 逐页落页后的真完成载荷）。 */
  appliedPages?: number
  totalPages?: number
  /** done：失败/退化页 0 起页码。 */
  failedPages?: number[]
}

/**
 * 系统文件管理器（访达「打开方式」/ 资源管理器双击）打开文档 →
 * 主进程导入文件库后交给渲染层的打开请求（channel files:open-from-os）。
 */
export interface OsOpenedDocument {
  fileId: string
  originalName: string
}

/** Office「AI 修改」浮层转发的主进程 → 渲染层事件（channel office:agent-ask）。 */
export interface OfficeAgentAskEvent {
  /** 目标 Room（slides 分支沿用；Room 并入工作空间后可能为空）。 */
  roomId: string | null
  /** 目标工作空间：渲染层按它激活对应标签并注入对话框（缺省时回退 roomId）。 */
  workspaceId?: string
  /** 已组装好的用户消息（含文件/元素定位与工具提示），直接自动发送。 */
  message: string
  /** 给用户看的人话（聊天层只展示它，不再把内部指令渲染成用户气泡）。 */
  displayMessage?: string
  /**
   * 'queue' = 攒成批注，先不放出去（渲染层收进待发送清单，用户一次全发）；
   * 缺省 = 立即发送。
   */
  mode?: 'now' | 'queue'
  /** 目标文件标题与 id：批注清单里点名用。 */
  title?: string
  fileId?: string
}
