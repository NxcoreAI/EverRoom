import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { forwardRef, type FormEvent, type KeyboardEvent } from 'react'

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  hasSelectedText: boolean
  value: string
  active: boolean
  loading: boolean
  onChange: (value: string) => void
  onClearContext: () => void
  onStop: () => void
  onSubmit: () => void
}>(function AgentComposer({
  active,
  contextSummary,
  hasSelectedText,
  loading,
  value,
  onChange,
  onClearContext,
  onStop,
  onSubmit,
}, ref) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <form className="agent-composer-shell" onSubmit={submit}>
      <div className="agent-prompt">
        <textarea
          ref={ref}
          aria-label="桌面 AI 工作台输入框"
          placeholder={active ? 'Agent 正在处理...' : '基于当前 Room 提问，或描述要执行的动作'}
          rows={2}
          value={value}
          disabled={active}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="agent-prompt-actions">
          <button type="button" className="agent-prompt-tool" title="打开输入工具" aria-label="打开输入工具">
            <Plus aria-hidden="true" />
          </button>
          <span className="agent-composer-context" title={contextSummary}>
            <span>{contextSummary}</span>
            {hasSelectedText ? (
              <button type="button" aria-label="移除选中文字" title="移除选中文字" onClick={onClearContext}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </span>
          {active ? (
            <button type="button" className="agent-prompt-submit is-stop" title="停止" aria-label="停止" onClick={onStop}>
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-prompt-submit" title="发送" aria-label="发送" disabled={!value.trim() || loading}>
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
})
