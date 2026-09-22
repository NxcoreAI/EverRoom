/** Agent 生成 Office 文件的主进程 → 渲染层事件（channel office:agent-file）。 */
export type OfficeAgentFileFormat = 'docx' | 'pptx' | 'xlsx'

export interface OfficeAgentFileEvent {
  type: 'phase' | 'done' | 'error' | 'edited'
  title: string
  /** 缺省 docx（旧事件无此字段）。 */
  format?: OfficeAgentFileFormat
  phase?: 'rendering' | 'saved' | 'importing'
  /** done：fileEntryId，渲染层用它自动打开预览。 */
  fileId?: string
  originalName?: string
  roomId?: string | null
  message?: string
}
