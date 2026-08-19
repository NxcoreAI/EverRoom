import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MemoryMarkdown({
  markdown,
  compact = false,
  className = '',
}: {
  markdown: string
  compact?: boolean
  className?: string
}) {
  const classes = [
    'mem-markdown-body',
    compact ? 'is-compact' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
