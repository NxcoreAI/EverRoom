import type {
  DocumentDiffBlock,
  DocumentDiffResult,
  DocumentVersionSnapshot,
  TiptapJsonContent,
} from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { useEffect, useRef } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

function appendSerializedBlock(
  container: HTMLElement,
  editor: Editor,
  block: TiptapJsonContent | undefined,
  status: DocumentDiffBlock['status'] | 'empty',
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
    const output: Array<{ node: TiptapJsonContent; status: DocumentDiffBlock['status'] }> = []
    // Gateway owns block identity and ordering. Re-matching by path here
    // breaks reorder and insertion diffs, especially for legacy documents.
    for (const block of diff.blocks.filter((candidate) => candidate.path.length === 1)) {
      if (block.status === 'removed') {
        if (block.before) output.push({ node: block.before, status: 'removed' })
        continue
      }
      if (block.status === 'modified') {
        if (block.before) output.push({ node: block.before, status: 'removed' })
        if (block.after) output.push({ node: block.after, status: 'added' })
        continue
      }
      // Older Gateway responses omitted `after` for unchanged blocks. Keep
      // those histories readable while the current contract supplies it.
      const visibleNode = block.after ?? block.before
      if (visibleNode) output.push({ node: visibleNode, status: block.status })
    }

    contentRef.current.replaceChildren()
    for (const block of output) appendSerializedBlock(contentRef.current, editor, block.node, block.status)
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
