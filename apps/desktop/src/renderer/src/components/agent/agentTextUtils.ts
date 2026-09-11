/** 供标题生成等场景使用的 markdown → 纯文本提取。 */
export function plainTextFromMarkdown(value: string, maxLength = 4_000): string {
  const text = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLength ? text.slice(0, maxLength) : text
}
