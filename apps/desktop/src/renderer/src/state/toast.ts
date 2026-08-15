export interface AppToastDetail {
  title: string
  message?: string
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
