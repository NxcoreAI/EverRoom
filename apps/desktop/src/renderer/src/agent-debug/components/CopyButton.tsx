import { useCallback, useEffect, useRef, useState } from 'react'

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API 不可用时退回 textarea。
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

/** 纯文字复制按钮（成功态显示「已复制」）。 */
export function CopyButton({ text, label = '复制', className }: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  const onClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1400)
    })
  }, [text])

  return (
    <button
      type="button"
      className={`text-btn copy-btn${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={copied ? '已复制' : label}
    >
      {copied ? '已复制' : label}
    </button>
  )
}
