import { ArrowUp, Sparkles } from 'lucide-react'
import { forwardRef } from 'react'

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  value: string
  onChange: (value: string) => void
}>(function AgentComposer({ contextSummary, value, onChange }, ref) {
  return (
    <footer className="agent-composer-shell">
      <div className="agent-composer-context">{contextSummary}</div>
      <div className="agent-prompt">
        <textarea
          ref={ref}
          aria-label="桌面 AI 工作台输入框"
          placeholder="问 Agent，或基于当前上下文继续…"
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="agent-prompt-actions">
          <button type="button" className="agent-prompt-tool" title="打开输入工具" aria-label="打开输入工具">
            <Sparkles aria-hidden="true" />
          </button>
          <button
            type="button"
            className="agent-prompt-submit"
            title="提交桌面 AI 工作台输入"
            aria-label="提交桌面 AI 工作台输入"
            disabled={!value.trim()}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
    </footer>
  )
})
