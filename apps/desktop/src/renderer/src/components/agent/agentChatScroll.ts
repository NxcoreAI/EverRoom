export const AGENT_CHAT_PIN_THRESHOLD_PX = 32

export function isScrolledToBottom(
  element: HTMLElement,
  threshold: number = AGENT_CHAT_PIN_THRESHOLD_PX,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
