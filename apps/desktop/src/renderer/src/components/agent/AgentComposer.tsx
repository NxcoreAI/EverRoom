import { ArrowUp, Sparkles, Square } from 'lucide-react'
import { forwardRef, type FormEvent, type KeyboardEvent } from 'react'

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  value: string
  active: boolean
  loading: boolean
  onChange: (value: string) => void
  onStop: () => void
  onSubmit: () => void
}>(function AgentComposer({ active, contextSummary, loading, value, onChange, onStop, onSubmit }, ref) {
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
      <div className="agent-composer-context">{contextSummary}</div>
      <div className="agent-prompt">
        <textarea
          ref={ref}
          aria-label="桌面 AI 工作台输入框"
          placeholder={active ? 'Agent 正在处理…' : '问 Agent，或基于当前上下文继续…'}
          rows={2}
          value={value}
          disabled={active}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="agent-prompt-actions">
          <button type="button" className="agent-prompt-tool" title="打开输入工具" aria-label="打开输入工具">
            <Sparkles aria-hidden="true" />
          </button>
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
