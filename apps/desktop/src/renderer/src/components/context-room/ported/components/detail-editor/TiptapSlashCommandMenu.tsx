import type { Editor } from '@tiptap/react'
import {
  CheckSquare2,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type SlashMatch = { from: number; to: number; query: string }
type SlashCommand = {
  label: string
  description: string
  keywords: string
  icon: LucideIcon
  run: (editor: Editor, range: Pick<SlashMatch, 'from' | 'to'>) => void
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
  { label: '正文', description: '普通文本块', keywords: 'text paragraph 正文 文本', icon: Pilcrow, run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run() },
  { label: '一级标题', description: '页面大标题', keywords: 'h1 heading title 一级 标题', icon: Heading1, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
  { label: '二级标题', description: '章节标题', keywords: 'h2 heading 二级 标题', icon: Heading2, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run() },
  { label: '三级标题', description: '小节标题', keywords: 'h3 heading 三级 标题', icon: Heading3, run: (editor, range) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run() },
  { label: '项目列表', description: '创建无序列表', keywords: 'bullet list 项目 无序 列表', icon: List, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { label: '编号列表', description: '创建有序列表', keywords: 'ordered number list 编号 有序 列表', icon: ListOrdered, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { label: '待办事项', description: '可勾选的任务块', keywords: 'todo task check 待办 任务', icon: CheckSquare2, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { label: '引用', description: '突出一段引用', keywords: 'quote blockquote 引用', icon: Quote, run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { label: '代码块', description: '等宽代码区域', keywords: 'code block 代码', icon: Code2, run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run() },
  { label: '分割线', description: '分隔内容区块', keywords: 'divider rule line 分割线', icon: Minus, run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
]

export function TiptapSlashCommandMenu({ editor }: { editor: Editor }) {
  const [match, setMatch] = useState<SlashMatch | null>(() => getSlashMatch(editor))
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    const update = () => setMatch(getSlashMatch(editor))
    editor.on('transaction', update)
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('transaction', update)
      editor.off('selectionUpdate', update)
    }
  }, [editor])

  const filteredCommands = useMemo(() => {
    const query = match?.query.toLocaleLowerCase() ?? ''
    return commands.filter((command) => `${command.label} ${command.keywords}`.toLocaleLowerCase().includes(query))
  }, [match?.query])

  useEffect(() => setSelectedIndex(0), [match?.query])

  useEffect(() => {
    if (!match || filteredCommands.length === 0) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setSelectedIndex((index) => (index + direction + filteredCommands.length) % filteredCommands.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        filteredCommands[selectedIndex]?.run(editor, match)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMatch(null)
      }
    }
    editor.view.dom.addEventListener('keydown', handleKeyDown)
    return () => editor.view.dom.removeEventListener('keydown', handleKeyDown)
  }, [editor, filteredCommands, match, selectedIndex])

  if (!match || filteredCommands.length === 0) return null

  const coords = editor.view.coordsAtPos(match.from)
  const menuHeight = Math.min(filteredCommands.length * 52 + 40, 356)
  const top = coords.bottom + menuHeight > window.innerHeight
    ? Math.max(8, coords.top - menuHeight - 8)
    : coords.bottom + 8
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - 292))

  return (
    <div className="context-room-tiptap-slash-menu" role="listbox" aria-label="插入内容" style={{ left, top }}>
      <div className="context-room-tiptap-slash-title">基础块</div>
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
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => command.run(editor, match)}
          >
            <span><Icon strokeWidth={1.8} /></span>
            <span><b>{command.label}</b><small>{command.description}</small></span>
          </button>
        )
      })}
    </div>
  )
}
