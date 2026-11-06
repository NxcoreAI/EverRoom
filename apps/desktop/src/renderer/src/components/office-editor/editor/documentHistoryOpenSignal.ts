/**
 * 跨组件打开文档历史面板的信号：动态时间轴的「查看版本」等外部入口使用。
 * 直接派发 window 事件在文档尚未挂载（切换中栏/右区）时会错过监听，
 * 因此附带一个待消费标记——目标文档的历史面板挂载时消费并展开。
 */
const OPEN_HISTORY_EVENT = 'everroom:document:open-history'

let pendingDocumentId: string | null = null

export function requestDocumentHistory(documentId: string): void {
  pendingDocumentId = documentId
  window.dispatchEvent(new CustomEvent(OPEN_HISTORY_EVENT, { detail: { documentId } }))
}

export function consumePendingDocumentHistory(documentId: string): boolean {
  if (pendingDocumentId !== documentId) return false
  pendingDocumentId = null
  return true
}

export function onDocumentHistoryOpen(
  documentId: string,
  listener: (documentId: string) => void,
): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ documentId?: string }>).detail
    if (detail?.documentId && detail.documentId === documentId) listener(detail.documentId)
  }
  window.addEventListener(OPEN_HISTORY_EVENT, handle)
  return () => window.removeEventListener(OPEN_HISTORY_EVENT, handle)
}
