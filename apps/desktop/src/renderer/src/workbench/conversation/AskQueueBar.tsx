/**
 * Office「AI 修改」待发送批注条（对话区）。
 *
 * 位置：工作会话标签的对话列里、对话面板**上方**（flow 布局），不依赖
 * AgentChatView 内部那套 absolute 定位的浮层输入框——那边的普通流元素会被
 * 输入框层盖住/挤偏，这是这条批注条之前"对话区看不见"的直接原因。
 *
 * 事实来源仍是 store.askDrafts（宿主唯一队列）；这里只负责展示与触发动作：
 * 移除/清空直接改 store，「全部发送」用 nonce 通知对话面板（真正的发送要 hook）。
 */
import { useWorkbenchStore } from '../state/store'
import './conversation.css'

export function AskQueueBar({ workspaceId }: { workspaceId: string | null }) {
  const askDrafts = useWorkbenchStore((state) => state.askDrafts)
  const removeAskDraft = useWorkbenchStore((state) => state.removeAskDraft)
  const clearAskDrafts = useWorkbenchStore((state) => state.clearAskDrafts)
  const requestAskQueueSend = useWorkbenchStore((state) => state.requestAskQueueSend)

  const drafts = workspaceId
    ? askDrafts.filter((draft) => draft.workspaceId === workspaceId)
    : []
  if (drafts.length === 0) return null

  return (
    <div className="wb-ask-drafts" role="group" aria-label="待发送批注">
      <div className="wb-ask-drafts-head">
        <span className="wb-ask-drafts-count">待发送批注 {drafts.length} 条</span>
        <button type="button" className="wb-ask-drafts-send" onClick={requestAskQueueSend}>
          全部发送
        </button>
        <button
          type="button"
          className="wb-ask-drafts-clear"
          onClick={() => { if (workspaceId) clearAskDrafts(workspaceId) }}
        >
          清空
        </button>
      </div>
      <ul className="wb-ask-drafts-list">
        {drafts.map((draft) => (
          <li key={draft.id} className="wb-ask-drafts-item">
            <span className="wb-ask-drafts-text">
              {draft.title ? <b>{draft.title}</b> : null}
              {draft.excerpt ? (
                <span className="wb-ask-drafts-excerpt">「{draft.excerpt}」</span>
              ) : null}
              <span className="wb-ask-drafts-note">
                {draft.instruction ?? draft.displayMessage ?? draft.message}
              </span>
            </span>
            <button
              type="button"
              className="wb-ask-drafts-remove"
              aria-label="移除这条批注"
              onClick={() => removeAskDraft(draft.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
