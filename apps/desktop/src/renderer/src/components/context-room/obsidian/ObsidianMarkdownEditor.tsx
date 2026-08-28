import { useEffect, useRef } from 'react'

export function ObsidianMarkdownEditor({ value, onChange, readOnly }: {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<import('@codemirror/view').EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    let disposed = false
    void Promise.all([
      import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/lang-markdown'), import('@codemirror/commands'),
    ]).then(([state, view, markdown, commands]) => {
      if (disposed || !host.current) return
      const editor = new view.EditorView({
        parent: host.current,
        state: state.EditorState.create({
          doc: value,
          extensions: [
            markdown.markdown(), commands.history(), view.keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
            state.EditorState.readOnly.of(Boolean(readOnly)),
            view.EditorView.lineWrapping,
            view.EditorView.updateListener.of((update) => {
              if (update.docChanged) onChangeRef.current(update.state.doc.toString())
            }),
            view.EditorView.theme({
              '&': { height: '100%', fontSize: '13px', backgroundColor: '#fff' },
              '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, monospace', lineHeight: '1.65', padding: '18px 20px' },
              '.cm-content': { caretColor: '#3d6ff6' },
              '&.cm-focused': { outline: 'none' },
              '.cm-gutters': { backgroundColor: '#f7f8fa', color: '#9aa4b1', borderRight: '1px solid #e1e5eb' },
              '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#f4f7ff' },
            }),
          ],
        }),
      })
      viewRef.current = editor
    })
    return () => { disposed = true; viewRef.current?.destroy(); viewRef.current = null }
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div className="obsidian-editor-host" ref={host} />
}
