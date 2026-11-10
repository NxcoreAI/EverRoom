import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { onWorkbenchToast } from './toast'

/** 单条 toast（后到覆盖先到），2.2s 自动消失。 */
export function Toaster() {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => onWorkbenchToast((next) => {
    setMessage(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setMessage(null), 2200)
  }), [])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  if (!message) return null
  return (
    <div className="wb-toast" role="status">
      <span className="wb-toast-icon" aria-hidden="true">
        <Check size={13} strokeWidth={2.6} />
      </span>
      <span className="wb-toast-text">{message}</span>
    </div>
  )
}
