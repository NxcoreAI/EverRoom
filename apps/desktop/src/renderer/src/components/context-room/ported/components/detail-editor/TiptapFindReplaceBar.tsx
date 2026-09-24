import { CaseSensitive, ChevronDown, ChevronUp, Replace, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useLocale } from '../../../../../i18n/LocaleContext'
import { EditorIconButton } from './EditorIconButton'
import {
  closeFindReplace,
  findNextMatch,
  findPreviousMatch,
  replaceAllMatches,
  replaceCurrentMatch,
  setFindCaseSensitive,
  setFindQuery,
  setFindReplaceText,
  setFindScopeToAll,
  toggleFindReplaceRow,
  type FindReplaceStats,
} from './TiptapFindReplaceExtension'
import type { Editor } from '@tiptap/react'

/** 文档内查找替换条（PRD 6.7）：悬浮于编辑器右上，
 * 命中数/上一个/下一个、大小写开关、全文/选区范围、逐项与全部替换。
 * 匹配与高亮逻辑在 TiptapFindReplaceExtension（ProseMirror 装饰）。 */
export function TiptapFindReplaceBar({
  editor,
  stats,
}: {
  editor: Editor
  stats: FindReplaceStats
}) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const replaceVisible = stats.replaceVisible

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // 已打开时再按 Cmd/Ctrl+F：焦点拉回查找输入框（父层的 open 分发为幂等空操作）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 当前命中滚动跟随：装饰类名 is-current 由扩展维护。
  useEffect(() => {
    if (!stats.open || stats.index < 0) return
    const scroll = editor.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
    scroll?.querySelector('.context-room-find-match.is-current')
      ?.scrollIntoView({ block: 'nearest' })
  }, [editor, stats.index, stats.open])

  const editable = editor.isEditable

  return (
    <div className="context-room-find-bar" role="search" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeFindReplace(editor)
        editor.commands.focus()
      }
    }}>
      <div className="context-room-find-bar-row">
        <input
          ref={inputRef}
          className="context-room-find-bar-input"
          type="text"
          value={query}
          placeholder={t('contextRoom:tiptapFindReplace.findPlaceholder')}
          aria-label={t('contextRoom:tiptapFindReplace.findPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value)
            setFindQuery(editor, event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (event.shiftKey) findPreviousMatch(editor)
              else findNextMatch(editor)
            }
          }}
        />
        <span className="context-room-find-bar-count" data-empty={String(stats.count === 0)}>
          {stats.count === 0
            ? t('contextRoom:tiptapFindReplace.noMatches')
            : `${stats.index + 1} / ${stats.count}`}
        </span>
        <EditorIconButton label={t('contextRoom:tiptapFindReplace.previousMatch')} disabled={stats.count === 0} onClick={() => findPreviousMatch(editor)}>
          <ChevronUp />
        </EditorIconButton>
        <EditorIconButton label={t('contextRoom:tiptapFindReplace.nextMatch')} disabled={stats.count === 0} onClick={() => findNextMatch(editor)}>
          <ChevronDown />
        </EditorIconButton>
        <EditorIconButton
          label={t('contextRoom:tiptapFindReplace.matchCase')}
          active={stats.caseSensitive}
          onClick={() => setFindCaseSensitive(editor, !stats.caseSensitive)}
        >
          <CaseSensitive />
        </EditorIconButton>
        <EditorIconButton
          label={t('contextRoom:tiptapFindReplace.toggleReplace')}
          active={replaceVisible}
          onClick={() => toggleFindReplaceRow(editor)}
        >
          <Replace />
        </EditorIconButton>
        {stats.scope === 'selection' ? (
          <button
            type="button"
            className="context-room-find-bar-scope"
            title={t('contextRoom:tiptapFindReplace.switchToWhole')}
            onClick={() => setFindScopeToAll(editor)}
          >
            {t('contextRoom:tiptapFindReplace.scopeSelection')}
            <X aria-hidden="true" />
          </button>
        ) : null}
        <EditorIconButton label={t('contextRoom:tiptapFindReplace.close')} onClick={() => {
          closeFindReplace(editor)
          editor.commands.focus()
        }}>
          <X />
        </EditorIconButton>
      </div>
      {replaceVisible ? (
        <div className="context-room-find-bar-row">
          <input
            ref={replaceInputRef}
            className="context-room-find-bar-input"
            type="text"
            value={replaceText}
            placeholder={t('contextRoom:tiptapFindReplace.replacePlaceholder')}
            aria-label={t('contextRoom:tiptapFindReplace.replacePlaceholder')}
            onChange={(event) => {
              setReplaceText(event.target.value)
              setFindReplaceText(editor, event.target.value)
            }}
          />
          <button
            type="button"
            className="context-room-find-bar-action"
            disabled={stats.count === 0 || !editable}
            title={t('contextRoom:tiptapFindReplace.replaceCurrent')}
            onClick={() => replaceCurrentMatch(editor)}
          >
            {t('contextRoom:tiptapFindReplace.replaceCurrent')}
          </button>
          <button
            type="button"
            className="context-room-find-bar-action"
            disabled={stats.count === 0 || !editable}
            title={t('contextRoom:tiptapFindReplace.replaceAll')}
            onClick={() => replaceAllMatches(editor)}
          >
            {t('contextRoom:tiptapFindReplace.replaceAll')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
