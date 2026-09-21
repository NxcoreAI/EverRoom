/** Agent 生成 Office 文件的主进程 → 渲染层事件（channel office:agent-file）。 */
export interface OfficeAgentFileEvent {
  type: 'phase' | 'done' | 'error'
  title: string
  phase?: 'rendering' | 'saved' | 'importing'
  /** done：fileEntryId，渲染层用它自动打开预览。 */
  fileId?: string
  originalName?: string
  roomId?: string | null
  message?: string
}
