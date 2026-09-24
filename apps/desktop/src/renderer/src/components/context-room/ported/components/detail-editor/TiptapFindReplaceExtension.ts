import { Extension } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/react'

/** 文档内查找替换（PRD 6.7 / 6.5）：
 * - 命中数、上一个/下一个、当前高亮（装饰）；
 * - 替换范围全文/选区，逐项与全部替换；全部替换走单事务 = 单个撤销步骤。
 * React 侧状态经 onStats 回调桥接（TiptapFindReplaceBar）。 */

export interface FindReplaceStats {
  open: boolean
  count: number
  /** 0 基；无命中为 -1。 */
  index: number
  replaceVisible: boolean
  caseSensitive: boolean
  scope: 'all' | 'selection'
}

interface FindMatch {
  from: number
  to: number
}

interface FindReplaceState {
  open: boolean
  query: string
  caseSensitive: boolean
  replaceVisible: boolean
  replaceText: string
  scope: 'all' | 'selection'
  scopeFrom: number
  scopeTo: number
  matches: FindMatch[]
  index: number
  decorations: DecorationSet
}

type FindReplaceMeta =
  | { type: 'open'; scopeFrom: number | null; scopeTo: number | null }
  | { type: 'close' }
  | { type: 'query'; query: string }
  | { type: 'case'; caseSensitive: boolean }
  | { type: 'toggle-replace' }
  | { type: 'replace-text'; text: string }
  | { type: 'scope'; scopeFrom: number | null; scopeTo: number | null }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'replace-current' }
  | { type: 'replace-all' }

export const findReplacePluginKey = new PluginKey<FindReplaceState>('contextRoomFindReplace')

interface TextSegment {
  /** 拼接文本中的起点。 */
  start: number
  end: number
  /** 对应文档位置（文本节点起始 pos）。 */
  from: number
}

interface TextIndex {
  text: string
  segments: TextSegment[]
}

/** 拼接 [rangeFrom, rangeTo) 内的文本；块边界插入 \n，避免跨块匹配。 */
export function buildTextIndex(doc: ProseMirrorNode, rangeFrom: number, rangeTo: number): TextIndex {
  let text = ''
  const segments: TextSegment[] = []
  doc.nodesBetween(rangeFrom, rangeTo, (node, pos) => {
    if (node.isText && node.text) {
      segments.push({ start: text.length, end: text.length + node.text.length, from: pos })
      text += node.text
      return false
    }
    if (node.isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n'
    return true
  })
  return { text, segments }
}

function indexToDocPosition(segments: TextSegment[], index: number): number | null {
  for (const segment of segments) {
    if (index >= segment.start && index <= segment.end) return segment.from + (index - segment.start)
  }
  return null
}

/** 在拼接文本里找非重叠命中并换算成文档位置。 */
export function findMatchesInText(
  index: TextIndex,
  query: string,
  options: { caseSensitive: boolean; rangeFrom: number; rangeTo: number },
): FindMatch[] {
  if (!query) return []
  const haystack = options.caseSensitive ? index.text : index.text.toLowerCase()
  const needle = options.caseSensitive ? query : query.toLowerCase()
  if (!needle) return []
  const matches: FindMatch[] = []
  let cursor = haystack.indexOf(needle)
  while (cursor !== -1) {
    const from = indexToDocPosition(index.segments, cursor)
    const to = indexToDocPosition(index.segments, cursor + needle.length)
    if (from !== null && to !== null && from >= options.rangeFrom && to <= options.rangeTo) {
      matches.push({ from, to })
    }
    cursor = haystack.indexOf(needle, cursor + needle.length)
  }
  return matches
}

function buildDecorations(doc: ProseMirrorNode, matches: FindMatch[], index: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    matches.map((match, matchIndex) => Decoration.inline(match.from, match.to, {
      class: matchIndex === index
        ? 'context-room-find-match is-current'
        : 'context-room-find-match',
    })),
  )
}

function recompute(state: FindReplaceState, doc: ProseMirrorNode): FindReplaceState {
  const index = buildTextIndex(doc, state.scopeFrom, state.scopeTo)
  const matches = state.open && state.query
    ? findMatchesInText(index, state.query, {
        caseSensitive: state.caseSensitive,
        rangeFrom: state.scopeFrom,
        rangeTo: state.scopeTo,
      })
    : []
  const boundedIndex = matches.length > 0
    ? Math.min(state.index, matches.length - 1)
    : -1
  return { ...state, matches, index: boundedIndex, decorations: buildDecorations(doc, matches, boundedIndex) }
}

function clampScope(doc: ProseMirrorNode, from: number, to: number): { scopeFrom: number; scopeTo: number } {
  const max = doc.content.size
  const boundedFrom = Math.max(0, Math.min(from, max))
  const boundedTo = Math.max(boundedFrom, Math.min(to, max))
  return { scopeFrom: boundedFrom, scopeTo: boundedTo }
}

function applyMeta(state: FindReplaceState, doc: ProseMirrorNode, meta: FindReplaceMeta): FindReplaceState {
  switch (meta.type) {
    case 'open': {
      // 已打开时保持现场（查询/范围不重置），仅确保可见。
      if (state.open) return state
      const scope = meta.scopeFrom !== null && meta.scopeTo !== null
        ? { scope: 'selection' as const, ...clampScope(doc, meta.scopeFrom, meta.scopeTo) }
        : { scope: 'all' as const, scopeFrom: 0, scopeTo: doc.content.size }
      return recompute({ ...state, open: true, index: 0, ...scope }, doc)
    }
    case 'close':
      return {
        ...state,
        open: false,
        matches: [],
        index: -1,
        decorations: DecorationSet.empty,
      }
    case 'query':
      return recompute({ ...state, query: meta.query, index: 0 }, doc)
    case 'case':
      return recompute({ ...state, caseSensitive: meta.caseSensitive, index: 0 }, doc)
    case 'toggle-replace':
      return { ...state, replaceVisible: !state.replaceVisible }
    case 'replace-text':
      return { ...state, replaceText: meta.text }
    case 'scope': {
      if (meta.scopeFrom === null || meta.scopeTo === null) {
        return recompute({ ...state, scope: 'all', scopeFrom: 0, scopeTo: doc.content.size, index: 0 }, doc)
      }
      const scope = clampScope(doc, meta.scopeFrom, meta.scopeTo)
      return recompute({ ...state, scope: 'selection', ...scope, index: 0 }, doc)
    }
    case 'next': {
      if (state.matches.length === 0) return state
      const index = (state.index + 1) % state.matches.length
      return { ...state, index, decorations: buildDecorations(doc, state.matches, index) }
    }
    case 'prev': {
      if (state.matches.length === 0) return state
      const index = (state.index - 1 + state.matches.length) % state.matches.length
      return { ...state, index, decorations: buildDecorations(doc, state.matches, index) }
    }
    case 'replace-current':
    case 'replace-all':
      // 事务本身携带替换；这里在替换后重算并把游标推进到替换位置起的第一处命中。
      return recompute({ ...state, index: 0 }, doc)
    default:
      return state
  }
}

function apply(tr: Transaction, value: FindReplaceState): FindReplaceState {
  const meta = tr.getMeta(findReplacePluginKey) as FindReplaceMeta | undefined
  if (!meta && !tr.docChanged) return value

  // 文档变化：映射选区范围并保持游标序号（内容位移时序号仍是合理的近似）。
  let base = value
  if (tr.docChanged) {
    const scopeFrom = tr.mapping.map(value.scopeFrom)
    const scopeTo = tr.mapping.map(value.scopeTo, -1)
    base = { ...value, ...clampScope(tr.doc, scopeFrom, scopeTo) }
  }
  let next = meta ? applyMeta(base, tr.doc, meta) : base

  if (tr.docChanged) {
    const replacedFrom = meta && (meta.type === 'replace-current' || meta.type === 'replace-all')
      ? tr.mapping.map(base.matches[base.index]?.from ?? base.scopeFrom, -1)
      : null
    next = recompute(next, tr.doc)
    if (replacedFrom !== null && next.matches.length > 0) {
      // 替换后从替换点起继续（替换文本本身命中的情况不会原地打转）。
      const forward = next.matches.findIndex((match) => match.from >= replacedFrom)
      next = { ...next, index: forward === -1 ? 0 : forward }
    }
  }
  return next
}

function replaceMatchAt(view: EditorView, match: FindMatch, replacement: string, tr: Transaction): void {
  const marks = view.state.doc.resolve(match.from).marks()
  tr.replaceWith(match.from, match.to, view.state.schema.text(replacement, marks))
}

export const TiptapFindReplace = Extension.create<{
  onStats?: (stats: FindReplaceStats) => void
}>({
  name: 'contextRoomFindReplace',

  addOptions() {
    return { onStats: undefined }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        openFindReplace(this.editor)
        return true
      },
      Escape: () => {
        const state = findReplacePluginKey.getState(this.editor.state)
        if (!state?.open) return false
        closeFindReplace(this.editor)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin<FindReplaceState>({
        key: findReplacePluginKey,
        state: {
          // 初始 scopeTo 由 open 的 meta 依当前文档重设；此处无需读 doc。
          init: () => ({
            open: false,
            query: '',
            caseSensitive: false,
            replaceVisible: false,
            replaceText: '',
            scope: 'all',
            scopeFrom: 0,
            scopeTo: 0,
            matches: [],
            index: -1,
            decorations: DecorationSet.empty,
          }),
          apply,
        },
        view: (view) => {
          const publish = () => {
            const state = findReplacePluginKey.getState(view.state)
            if (!state) return
            options.onStats?.({
              open: state.open,
              count: state.matches.length,
              index: state.index,
              replaceVisible: state.replaceVisible,
              caseSensitive: state.caseSensitive,
              scope: state.scope,
            })
          }
          publish()
          return { update: publish }
        },
        props: {
          decorations: (state) => findReplacePluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ]
  },
})

/** 打开查找条：有选区时默认只搜选区（可一键切回全文）。已打开则保持现场。 */
export function openFindReplace(editor: Editor): void {
  const { from, to, empty } = editor.state.selection
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, {
    type: 'open',
    scopeFrom: empty ? null : from,
    scopeTo: empty ? null : to,
  }))
}

export function closeFindReplace(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'close' }))
}

export function setFindQuery(editor: Editor, query: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'query', query }))
}

export function setFindCaseSensitive(editor: Editor, caseSensitive: boolean): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'case', caseSensitive }))
}

export function setFindScopeToSelection(editor: Editor): void {
  const { from, to, empty } = editor.state.selection
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, {
    type: 'scope',
    scopeFrom: empty ? null : from,
    scopeTo: empty ? null : to,
  }))
}

export function setFindScopeToAll(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'scope', scopeFrom: null, scopeTo: null }))
}

export function toggleFindReplaceRow(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'toggle-replace' }))
}

export function setFindReplaceText(editor: Editor, text: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'replace-text', text }))
}

export function findNextMatch(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'next' }))
}

export function findPreviousMatch(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { type: 'prev' }))
}

function dispatchReplacement(editor: Editor, all: boolean): void {
  const state = findReplacePluginKey.getState(editor.state)
  if (!state || !state.open || state.matches.length === 0) return
  if (!editor.isEditable || editor.isDestroyed) return
  const view = editor.view
  const tr = editor.state.tr
  const targets = all ? [...state.matches].reverse() : [state.matches[state.index] ?? state.matches[0]]
  for (const match of targets) replaceMatchAt(view, match, state.replaceText, tr)
  tr.setMeta(findReplacePluginKey, { type: all ? 'replace-all' : 'replace-current' })
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(state.matches[state.index]?.from ?? state.scopeFrom)))
  view.dispatch(tr)
}

export function replaceCurrentMatch(editor: Editor): void {
  dispatchReplacement(editor, false)
}

export function replaceAllMatches(editor: Editor): void {
  dispatchReplacement(editor, true)
}
