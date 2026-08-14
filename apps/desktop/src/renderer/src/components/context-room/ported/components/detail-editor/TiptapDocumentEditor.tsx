import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'

import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { TiptapBlockHandle } from './TiptapBlockHandle'
import { TiptapBubbleToolbar } from './TiptapBubbleToolbar'
import { TiptapContentScale } from './TiptapContentScale'
import { TiptapSlashCommandMenu } from './TiptapSlashCommandMenu'
import {
  createRoomDocumentContent,
  readDocumentDraft,
  writeDocumentDraft,
} from './documentDraftStorage'
import './TiptapDocumentEditor.css'

export function TiptapDocumentEditor({
  room,
  resource,
}: {
  room: ContextRoomRecord
  resource?: ContextRoomResource | null
}) {
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  const documentName = resource?.name ?? room.cloudDoc.title ?? room.title
  const version = resource?.kind === 'cloud-doc' ? resource.version : 'V1.0'
  const initialContent = useState<JSONContent>(() => (
    readDocumentDraft(documentId) ?? createRoomDocumentContent(room, documentName)
  ))[0]
  const saveTimer = useRef<number | null>(null)
  const [saveState, setSaveState] = useState('已保存')
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableOfContents.configure({
        scrollParent: () => document.querySelector<HTMLElement>('.context-room-tiptap-scroll') ?? window,
        onUpdate: setTableOfContents,
      }),
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === 'heading' ? '标题' : "输入 '/' 插入内容",
        includeChildren: true,
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'context-room-tiptap-content',
        'aria-label': 'Room 文档编辑器',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      setSaveState('正在保存…')
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        setSaveState(writeDocumentDraft(documentId, currentEditor.getJSON()) ? '已保存' : '仅本次会话')
      }, 300)
    },
  }, [documentId])

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    if (editor) writeDocumentDraft(documentId, editor.getJSON())
  }, [documentId, editor])

  return (
    <div className="context-room-embedded-cloud-doc context-room-tiptap-editor">
      <div className="context-room-embedded-doc-status">
        <span>{version}</span>
        <b>{saveState}</b>
        <em>{documentName}</em>
      </div>
      <div className="context-room-tiptap-scroll">
        <EditorContent editor={editor} />
      </div>
      {editor ? (
        <>
          <TiptapBubbleToolbar editor={editor} />
          <TiptapBlockHandle editor={editor} />
          <TiptapContentScale items={tableOfContents} />
          <TiptapSlashCommandMenu editor={editor} />
        </>
      ) : null}
    </div>
  )
}
