import type {
  DocumentDiffBlock,
  DocumentDiffResult,
  DocumentDiffSpan,
  DocumentVersionSnapshot,
  TiptapJsonContent,
} from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { useEffect, useRef } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

interface TextRange {
  start: number
  end: number
}

function comparableBlockStructure(node: TiptapJsonContent): unknown {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {})
      .filter(([key]) => key !== 'id' && key !== 'data-toc-id')
      .sort(([left], [right]) => left.localeCompare(right)),
  )
  return {
    type: node.type,
    ...(Object.keys(attrs).length ? { attrs } : {}),
    content: (node.content ?? [])
      .filter((child) => child.type !== 'text')
      .map(comparableBlockStructure),
  }
}

function supportsInlineDiff(before: TiptapJsonContent, after: TiptapJsonContent): boolean {
  return JSON.stringify(comparableBlockStructure(before)) === JSON.stringify(comparableBlockStructure(after))
}

function diffTextNodes(root: Node): Text[] {
  const result: Text[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) result.push(node as Text)
      return
    }
    if (node instanceof HTMLElement && node.dataset.diffType === 'delete') return
    node.childNodes.forEach(visit)
  }
  visit(root)
  return result
}

function createInlineChange(type: 'insert' | 'delete', text: string): HTMLElement {
  const element = document.createElement(type === 'insert' ? 'ins' : 'del')
  element.className = `document-history-diff-inline is-${type === 'insert' ? 'inserted' : 'deleted'}`
  element.dataset.diffType = type
  element.textContent = text
  return element
}

function inlineChangeHost(root: Node): HTMLElement | null {
  const element = root instanceof HTMLElement ? root : root.parentElement
  return element?.querySelector<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre')
    ?? element
}

function insertDeletedChanges(root: Node, deleted: Map<number, string>): boolean {
  const textNodes = diffTextNodes(root)
  const changes = [...deleted.entries()].sort(([left], [right]) => left - right)
  const placements: Array<{ node: Text | null; offset: number; text: string }> = []
  let textIndex = 0
  let consumed = 0
  for (const [offset, text] of changes) {
    let placed = false
    while (textIndex < textNodes.length) {
      const textNode = textNodes[textIndex]!
      const end = consumed + textNode.data.length
      if (offset < end || offset === consumed || (offset === end && textIndex === textNodes.length - 1)) {
        placements.push({ node: textNode, offset: Math.max(0, Math.min(textNode.data.length, offset - consumed)), text })
        placed = true
        break
      }
      consumed = end
      textIndex += 1
    }
    if (!placed) placements.push({ node: textNodes.at(-1) ?? null, offset: textNodes.at(-1)?.data.length ?? 0, text })
  }

  let inserted = false
  for (const placement of placements.reverse()) {
    const change = createInlineChange('delete', placement.text)
    const parent = placement.node?.parentNode
    if (placement.node && parent) {
      if (placement.offset === 0) parent.insertBefore(change, placement.node)
      else if (placement.offset === placement.node.data.length) parent.insertBefore(change, placement.node.nextSibling)
      else parent.insertBefore(change, placement.node.splitText(placement.offset))
      inserted = true
      continue
    }
    const host = inlineChangeHost(root)
    if (host) {
      host.append(change)
      inserted = true
    }
  }
  return inserted
}

function highlightRanges(root: Node, ranges: TextRange[]): void {
  if (!ranges.length) return
  let consumed = 0
  let rangeIndex = 0
  for (const textNode of diffTextNodes(root)) {
    const start = consumed
    const end = start + textNode.data.length
    while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= start) rangeIndex += 1
    const intersections: TextRange[] = []
    for (let index = rangeIndex; ranges[index] && ranges[index]!.start < end; index += 1) {
      const range = ranges[index]!
      intersections.push({ start: Math.max(start, range.start), end: Math.min(end, range.end) })
    }
    consumed = end
    if (!intersections.length || !textNode.parentNode) continue

    const fragment = document.createDocumentFragment()
    let localOffset = 0
    for (const intersection of intersections) {
      const localStart = intersection.start - start
      const localEnd = intersection.end - start
      if (localStart > localOffset) fragment.append(textNode.data.slice(localOffset, localStart))
      fragment.append(createInlineChange('insert', textNode.data.slice(localStart, localEnd)))
      localOffset = localEnd
    }
    if (localOffset < textNode.data.length) fragment.append(textNode.data.slice(localOffset))
    textNode.parentNode.replaceChild(fragment, textNode)
  }
}

export function applyDocumentHistoryInlineDiff(root: Node, spans: DocumentDiffSpan[]): boolean {
  const inserted: TextRange[] = []
  const deleted = new Map<number, string>()
  let afterOffset = 0
  for (const span of spans) {
    if (span.type === 'delete') {
      deleted.set(afterOffset, `${deleted.get(afterOffset) ?? ''}${span.text}`)
      continue
    }
    if (span.type === 'insert') inserted.push({ start: afterOffset, end: afterOffset + span.text.length })
    afterOffset += span.text.length
  }

  const decorated = insertDeletedChanges(root, deleted)
  highlightRanges(root, inserted)
  return decorated || inserted.length > 0
}

function appendSerializedBlock(
  container: HTMLElement,
  editor: Editor,
  block: TiptapJsonContent | undefined,
  status: DocumentDiffBlock['status'] | 'empty',
  textDiff?: DocumentDiffSpan[],
): void {
  if (!block) {
    const empty = document.createElement('div')
    empty.className = 'context-room-history-diff-empty'
    empty.textContent = ' '
    container.append(empty)
    return
  }
  const schemaNode: ProseMirrorNode = editor.schema.nodeFromJSON(block)
  const dom = DOMSerializer.fromSchema(editor.schema).serializeNode(schemaNode)
  const wrapper = document.createElement('div')
  // Reuse the editor's content scope so headings, lists, tables, code and
  // embeds keep the same rich-text presentation in the read-only diff.
  wrapper.className = `context-room-history-diff-block context-room-tiptap-content is-${status}`
  wrapper.dataset.diffStatus = status
  if (status === 'modified' && textDiff) applyDocumentHistoryInlineDiff(dom, textDiff)
  wrapper.append(dom)
  container.append(wrapper)
}

export function DocumentHistoryDiffView({
  editor,
  snapshot,
  diff,
  currentTitle,
  currentContent,
}: {
  editor: Editor
  snapshot: DocumentVersionSnapshot
  diff: DocumentDiffResult
  currentTitle: string
  currentContent?: TiptapJsonContent
}) {
  const { t } = useLocale()
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contentRef.current || editor.isDestroyed) return
    // Diff against the authoritative version returned by Gateway. The live
    // editor may contain an unsaved local draft and must not change history
    // coloring or block placement.
    const afterContent = currentContent ?? editor.getJSON() as TiptapJsonContent
    if (diff.truncated) {
      contentRef.current.replaceChildren()
      appendSerializedBlock(contentRef.current, editor, afterContent, 'modified')
      return
    }
    const output: Array<{
      node: TiptapJsonContent
      status: DocumentDiffBlock['status']
      textDiff?: DocumentDiffSpan[]
    }> = []
    // Gateway owns block identity and ordering. Re-matching by path here
    // breaks reorder and insertion diffs, especially for legacy documents.
    for (const block of diff.blocks.filter((candidate) => candidate.path.length === 1)) {
      if (block.status === 'removed') {
        if (block.before) output.push({ node: block.before, status: 'removed' })
        continue
      }
      if (block.status === 'modified') {
        if (block.before && block.after && supportsInlineDiff(block.before, block.after)) {
          output.push({ node: block.after, status: 'modified', textDiff: block.textDiff })
        } else {
          if (block.before) output.push({ node: block.before, status: 'removed' })
          if (block.after) output.push({ node: block.after, status: 'added' })
        }
        continue
      }
      // Older Gateway responses omitted `after` for unchanged blocks. Keep
      // those histories readable while the current contract supplies it.
      const visibleNode = block.after ?? block.before
      if (visibleNode) output.push({ node: visibleNode, status: block.status })
    }

    contentRef.current.replaceChildren()
    for (const block of output) {
      appendSerializedBlock(contentRef.current, editor, block.node, block.status, block.textDiff)
    }
    if (!output.length) appendSerializedBlock(contentRef.current, editor, afterContent, 'unchanged')
  }, [currentContent, diff, editor, snapshot])

  const titleChanged = snapshot.title !== currentTitle

  return (
    <div className="context-room-history-diff-view" role="region" aria-label={t('contextRoom:documentHistory.diffAria')}>
      <div className="context-room-history-diff-column-header">
        {t('contextRoom:documentHistory.diffRange', { fromVersion: snapshot.version, toVersion: diff.toVersion })}
        {diff.truncated ? ` · ${t('contextRoom:documentHistory.truncated')}` : ''}
      </div>
      <div className="context-room-history-diff-title-block">
        <h1 className={titleChanged ? 'is-removed' : 'is-unchanged'}>{snapshot.title}</h1>
        {titleChanged ? <h1 className="is-added">{currentTitle}</h1> : null}
      </div>
      <div ref={contentRef} className="context-room-history-diff-content" />
    </div>
  )
}
