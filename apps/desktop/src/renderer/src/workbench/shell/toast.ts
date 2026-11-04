/** 工作台内的轻量 toast：页面组件沿用 office-proto 的 onToast(msg) 形态，
 *  外壳用事件桥统一展示，避免每个页面各挂一个 toast 容器。 */

const TOAST_EVENT = 'everroom:workbench-toast'

export function workbenchToast(message: string): void {
  if (!message) return
  window.dispatchEvent(new CustomEvent<string>(TOAST_EVENT, { detail: message }))
}

export function onWorkbenchToast(listener: (message: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail)
  window.addEventListener(TOAST_EVENT, handler)
  return () => window.removeEventListener(TOAST_EVENT, handler)
}