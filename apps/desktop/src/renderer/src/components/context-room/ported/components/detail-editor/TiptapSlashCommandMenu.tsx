import type { Editor } from '@tiptap/react'
import {
  CheckSquare2,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Table2,
  Link2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import { showToast } from '../../../../../state/toast'
import {
  DOCUMENT_IMAGE_ACCEPT,
  storeDocumentImageFile,
} from './documentImageAssets'

type SlashMatch = { from: number; to: number; query: string }
const SLASH_MENU_WIDTH = 284
const TABLE_GRID_MENU_WIDTH = 252
const TABLE_GRID_MENU_HEIGHT = 286

type SlashCommand = {
  label: string
  description: string
  keywords: string
  icon: LucideIcon
  run: (
    editor: Editor,
    range: Pick<SlashMatch, 'from' | 'to'>,
    actions?: {
      requestImage: (range: Pick<SlashMatch, 'from' | 'to'>) => void
      requestTable: (range: Pick<SlashMatch, 'from' | 'to'>) => void
    },
  ) => void
}

function getSlashMatch(editor: Editor): SlashMatch | null {
  const { selection } = editor.state
  if (!selection.empty) return null

  const { $from } = selection
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const slashIndex = before.lastIndexOf('/')
  if (slashIndex < 0 || (slashIndex > 0 && !/\s/.test(before[slashIndex - 1]))) return null

  const query = before.slice(slashIndex + 1)
  if (/\s/.test(query)) return null
  return { from: selection.from - query.length - 1, to: selection.from, query }
}

const commands: SlashCommand[] = [
  { label: 'contextRoom:slashCommand.paragraph', description: 'contextRoom:slashCommand.paragraphDescription', keywords: 'text paragraph 正文 文本', icon: Pilcrow, run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run() },
  { label: 'contextRoom:slashCommand.headingOne', description: 'contextRoom:slashCommand.headingOneDescription', keywords: 'h1 heading title 一级 标题', icon: Heading1, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
  { label: 'contextRoom:slashCommand.headingTwo', description: 'contextRoom:slashCommand.headingTwoDescription', keywords: 'h2 heading 二级 标题', icon: Heading2, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run() },
  { label: 'contextRoom:slashCommand.headingThree', description: 'contextRoom:slashCommand.headingThreeDescription', keywords: 'h3 heading 三级 标题', icon: Heading3, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run() },
  { label: 'contextRoom:slashCommand.bulletList', description: 'contextRoom:slashCommand.bulletListDescription', keywords: 'bullet list 项目 无序 列表', icon: List, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { label: 'contextRoom:slashCommand.numberedList', description: 'contextRoom:slashCommand.numberedListDescription', keywords: 'ordered number list 编号 有序 列表', icon: ListOrdered, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { label: 'contextRoom:slashCommand.taskList', description: 'contextRoom:slashCommand.taskListDescription', keywords: 'todo task check 待办 任务', icon: CheckSquare2, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { label: 'contextRoom:slashCommand.quote', description: 'contextRoom:slashCommand.quoteDescription', keywords: 'quote blockquote 引用', icon: Quote, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { label: 'contextRoom:slashCommand.codeBlock', description: 'contextRoom:slashCommand.codeBlockDescription', keywords: 'code block 代码', icon: Code2, run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run() },
  { label: 'contextRoom:slashCommand.divider', description: 'contextRoom:slashCommand.dividerDescription', keywords: 'divider rule line 分割线', icon: Minus, run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  { label: 'contextRoom:slashCommand.table', description: 'contextRoom:slashCommand.tableDescription', keywords: 'table grid 表格 网格', icon: Table2, run: (_editor, range, actions) => actions?.requestTable(range) },
  {
    label: 'contextRoom:slashCommand.image',
    description: 'contextRoom:slashCommand.imageDescription',
    keywords: 'image picture 图片 图像',
    icon: ImagePlus,
    run: (_editor, range, actions) => actions?.requestImage(range),
  },
]

export function TiptapSlashCommandMenu({
  editor,
  documentId,
  onRequestBlockReference,
}: {
  editor: Editor
  documentId: string
  onRequestBlockReference?: () => void
}) {
  const { t } = useLocale()
  const [match, setMatch] = useState<SlashMatch | null>(() => getSlashMatch(editor))
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const [tableRequest, setTableRequest] = useState<{
    range: Pick<SlashMatch, 'from' | 'to'>
    rows: number
    cols: number
  } | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageRangeRef = useRef<Pick<SlashMatch, 'from' | 'to'> | null>(null)

  const requestImage = (range: Pick<SlashMatch, 'from' | 'to'>) => {
    imageRangeRef.current = { from: range.from, to: range.to }
    imageInputRef.current?.click()
  }
  const requestTable = (range: Pick<SlashMatch, 'from' | 'to'>) => {
    setTableRequest({
      range: { from: range.from, to: range.to },
      rows: 3,
      cols: 3,
    })
  }

  useEffect(() => {
    const update = () => {
      const nextMatch = getSlashMatch(editor)
      setMatch(nextMatch)
      if (!nextMatch) setTableRequest(null)
    }
    editor.on('transaction', update)
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('transaction', update)
      editor.off('selectionUpdate', update)
    }
  }, [editor])

  const availableCommands = useMemo<SlashCommand[]>(() => onRequestBlockReference
    ? [...commands, {
      label: 'contextRoom:slashCommand.documentBlockReference',
      description: 'contextRoom:slashCommand.documentBlockReferenceDescription',
      keywords: 'reference link block 引用 文档 块',
      icon: Link2,
      run: (currentEditor, range) => {
        currentEditor.chain().focus().deleteRange(range).run()
        onRequestBlockReference()
      },
    }]
    : commands, [onRequestBlockReference])

  const filteredCommands = useMemo(() => {
    const query = match?.query.toLocaleLowerCase() ?? ''
    return availableCommands.filter((command) => `${t(command.label)} ${command.keywords}`.toLocaleLowerCase().includes(query))
  }, [availableCommands, match?.query, t])

  useEffect(() => {
    selectedIndexRef.current = 0
    setSelectedIndex(0)
  }, [match?.query])

  useEffect(() => {
    if (!match || filteredCommands.length === 0) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (
          selectedIndexRef.current + direction + filteredCommands.length
        ) % filteredCommands.length
        selectedIndexRef.current = nextIndex
        setSelectedIndex(nextIndex)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        const command = filteredCommands[selectedIndexRef.current] ?? filteredCommands[0]
        command?.run(editor, match, { requestImage, requestTable })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setTableRequest(null)
        setMatch(null)
      }
    }
    editor.view.dom.addEventListener('keydown', handleKeyDown, true)
    return () => editor.view.dom.removeEventListener('keydown', handleKeyDown, true)
  }, [editor, filteredCommands, match])

  if (!match || filteredCommands.length === 0) return null

  const coords = editor.view.coordsAtPos(match.from)
  const menuHeight = tableRequest
    ? TABLE_GRID_MENU_HEIGHT
    : Math.min(filteredCommands.length * 52 + 40, 356)
  const menuWidth = tableRequest ? TABLE_GRID_MENU_WIDTH : SLASH_MENU_WIDTH
  const top = coords.bottom + menuHeight > window.innerHeight
    ? Math.max(8, coords.top - menuHeight - 8)
    : coords.bottom + 8
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - menuWidth - 8))

  if (tableRequest) {
    return (
      <div
        className="context-room-tiptap-slash-menu context-room-tiptap-table-grid-menu"
        role="dialog"
        aria-label={t('contextRoom:tiptapSlashCommandMenu.chooseTableSize')}
        style={{ left, top }}
      >
        <div className="context-room-tiptap-table-grid-title">
          <strong>{t('contextRoom:tiptapSlashCommandMenu.insertTable')}</strong>
          <span>{tableRequest.rows} × {tableRequest.cols}</span>
        </div>
        <div className="context-room-tiptap-table-grid" role="grid" aria-label={t('contextRoom:tiptapSlashCommandMenu.tableSize')}>
          {Array.from({ length: 64 }, (_, index) => {
            const row = Math.floor(index / 8) + 1
            const col = index % 8 + 1
            const selected = row <= tableRequest.rows && col <= tableRequest.cols
            return (
              <button
                type="button"
                key={`${row}-${col}`}
                role="gridcell"
                aria-label={t('contextRoom:tiptapSlashCommandMenu.rowRowsColColumns', { row, col })}
                aria-selected={selected}
                data-selected={String(selected)}
                onMouseEnter={() => setTableRequest((current) => current ? { ...current, rows: row, cols: col } : current)}
                onFocus={() => setTableRequest((current) => current ? { ...current, rows: row, cols: col } : current)}
                onClick={() => {
                  editor.chain().focus().deleteRange(tableRequest.range).insertTable({
                    rows: row,
                    cols: col,
                    withHeaderRow: true,
                  }).run()
                  setTableRequest(null)
                  setMatch(null)
                }}
              />
            )
          })}
        </div>
        <button type="button" className="context-room-tiptap-table-grid-cancel" onClick={() => setTableRequest(null)}>{t('contextRoom:tiptapSlashCommandMenu.cancel')}</button>
      </div>
    )
  }

  return (
    <div className="context-room-tiptap-slash-menu" role="listbox" aria-label={t('contextRoom:tiptapSlashCommandMenu.insertContent')} style={{ left, top }}>
      <input
        ref={imageInputRef}
        type="file"
        accept={DOCUMENT_IMAGE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.currentTarget.value = ''
          if (!file) {
            imageRangeRef.current = null
            return
          }
          const range = imageRangeRef.current
          if (!range) return
          imageRangeRef.current = null
          const documents = window.nxcore?.documents
          if (!documents) {
            showToast({ title: t('contextRoom:tiptapSlashCommandMenu.unableToInsertImage'), message: t('contextRoom:tiptapSlashCommandMenu.theLocalImageServiceIsUnavailable') })
            return
          }
          void storeDocumentImageFile(file, documentId, documents.storeImage).then((stored) => {
            editor.chain().focus().deleteRange(range).setImage({
              src: stored.src,
              alt: file.name.replace(/\.[^.]+$/, ''),
            }).run()
            setMatch(null)
          }).catch((error: unknown) => {
            showToast({
              title: t('contextRoom:tiptapSlashCommandMenu.unableToInsertImage'),
              message: error instanceof Error ? error.message : t('contextRoom:tiptapSlashCommandMenu.unableToReadTheImageTryAgain'),
            })
            console.error('Failed to store document image', error)
          })
        }}
      />
      <div className="context-room-tiptap-slash-title">{t('contextRoom:tiptapSlashCommandMenu.basicBlocks')}</div>
      {filteredCommands.map((command, index) => {
        const Icon = command.icon
        return (
          <button
            type="button"
            key={command.label}
            role="option"
            aria-selected={index === selectedIndex}
            data-selected={String(index === selectedIndex)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => {
              selectedIndexRef.current = index
              setSelectedIndex(index)
            }}
            onClick={() => command.run(editor, match, { requestImage, requestTable })}
          >
            <span><Icon strokeWidth={1.8} /></span>
            <span><b>{t(command.label)}</b><small>{t(command.description)}</small></span>
          </button>
        )
      })}
    </div>
  )
}
