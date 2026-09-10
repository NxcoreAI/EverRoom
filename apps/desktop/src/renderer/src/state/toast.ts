export interface AppToastDetail {
  title: string
  message?: string
  /** error：顶部居中红色横幅；缺省 info：右下角通知。 */
  variant?: 'error' | 'info'
  /** 附加操作（如打开系统设置）；带操作的 error 展示更久。 */
  actionLabel?: string
  onAction?: () => void
}

const TOAST_EVENT = 'everroom:toast'

export function showToast(detail: AppToastDetail): void {
  window.dispatchEvent(new CustomEvent<AppToastDetail>(TOAST_EVENT, { detail }))
}

export function onToast(listener: (detail: AppToastDetail) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<AppToastDetail>).detail)
  window.addEventListener(TOAST_EVENT, handle)
  return () => window.removeEventListener(TOAST_EVENT, handle)
}
