import type { EmergenceFocusChapter } from '../../../../../../../shared/knowledge';

/**
 * 焦点系统的章节信号（PRD 7.3 当前章节）：光标所在标题到下一个同级/更高级标题之间
 * 的整节内容。以结构化最小接口描述 ProseMirror 节点，保持纯函数可单测。
 */
interface SectionNodeLike {
  type: { name: string };
  attrs?: { level?: unknown } | null;
  textContent: string;
}

interface SectionDocLike {
  forEach: (callback: (node: SectionNodeLike, offset: number, index: number) => void) => void;
  textBetween: (from: number, to: number, blockSeparator?: string) => string;
  content: { size: number };
}

export function extractCurrentSection(doc: SectionDocLike, cursorPos: number): EmergenceFocusChapter | null {
  const headings: Array<{ offset: number; level: number; text: string }> = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return;
    const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
    headings.push({ offset, level, text: node.textContent.trim() });
  });
  let current: { offset: number; level: number; text: string } | null = null;
  for (const heading of headings) {
    if (heading.offset < cursorPos) current = heading;
    else break;
  }
  if (!current || !current.text) return null;
  const next = headings.find((heading) => heading.offset >= cursorPos && heading.level <= current!.level);
  const bodyText = doc.textBetween(current.offset, next?.offset ?? doc.content.size, '\n\n').trim();
  return { heading: current.text, bodyText };
}
