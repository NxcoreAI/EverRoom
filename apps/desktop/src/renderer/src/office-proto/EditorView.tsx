import React, { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView as CmDomView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown as cmMarkdown } from '@codemirror/lang-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles } from 'lucide-react'

import { type OfficeFile } from './data'
import { NativeEditorHost, type NativeSpec } from './NativeEditorHost'
import { SideDock } from './SideDock'

interface EditorViewProps {
  file: OfficeFile
  onToast: (msg: string) => void
  /** 复用场景（如 WorkBuddy 式右侧产物面板）：不渲染 Agent/材料/历史记录停靠栏，
   *  对话已在主区。默认 false，保持旧调用（OfficeProto 标签页）行为不变。 */
  hideSideDock?: boolean
}

/** docx/xlsx/pptx/pdf 都由 GenOffice 原生编辑器承载；Markdown 保留原型编辑器。 */
export function EditorView({ file, onToast, hideSideDock = false }: EditorViewProps) {
  // 真实文件库文件没有 mock 内容，直接走文件库内置预览（不落到下面的 MdView）。
  if (file.realCatalog) return <NativeFileView file={file} onToast={onToast} hideSideDock={hideSideDock} />
  if (file.content.type === 'md') return <MdView file={file} onToast={onToast} hideSideDock={hideSideDock} />
  return <NativeFileView file={file} onToast={onToast} hideSideDock={hideSideDock} />
}

function nativeSpec(file: OfficeFile): NativeSpec {
  const content = file.content
  if (content.type === 'doc') {
    return {
      kind: 'docx',
      blocks: content.blocks.map((b) =>
        b.type === 'quote' && b.cite
          ? { type: 'quote' as const, text: b.text, cite: b.cite }
          : { type: b.type, text: b.text },
      ),
    }
  }
  if (content.type === 'sheet') return { kind: 'xlsx', columns: content.columns, rows: content.rows }
  if (content.type === 'slides') {
    return { kind: 'pptx', slides: content.slides.map((s) => ({ title: s.title, bullets: s.bullets })) }
  }
  if (content.type === 'pdf') return { kind: 'pdf', paragraphs: content.pages.flatMap((p) => p.paragraphs) }
  // md 在 EditorView 已分流到 MdView，不会到这里；给个安全兜底。
  return { kind: 'pdf', paragraphs: [] }
}

/** 原生编辑器只占左侧编辑区；停靠栏（Agent / 材料 / 历史记录）与 md 路径共用外壳层
 *  SideDock，Agent 面直接用主窗口 preload 的真实网关桥。GenOffice 自带的对话区/侧栏
 *  已从 vendor 源码删除（见 genoffice/bridge.ts），停靠栏只由外壳提供。
 *  真实文件库文件用 realCatalog 打开文件库内置预览，mock 文件才构造原型 spec。
 *  hideSideDock 由复用方（产物面板）传入，此时编辑区占满整行。 */
function NativeFileView({
  file, onToast, hideSideDock,
}: {
  file: OfficeFile
  onToast: (msg: string) => void
  hideSideDock: boolean
}) {
  const spec = file.realCatalog ? undefined : nativeSpec(file)
  const fromDraft = file.kind === 'docx' && file.name.includes('AI 起草')
  const citeCount =
    file.content.type === 'doc' ? file.content.blocks.filter((b) => b.cite).length : 0

  return (
    <div className="op-ed-dock-row">
      <div className="op-native-col">
        {fromDraft && (
          <div className="op-draft-banner">
            <Sparkles size={13} /> 由 Agent 依据你的 {citeCount} 条记忆起草 · 引用已锚定，点击锚点可回到原始材料
          </div>
        )}
        <NativeEditorHost fileId={file.id} title={file.name} spec={spec} realCatalog={file.realCatalog} />
      </div>
      {!hideSideDock && <SideDock file={file} onToast={onToast} />}
    </div>
  )
}

/* ───────────────────── Markdown（原型自带编辑器） ───────────────────── */

function MdView({
  file, onToast, hideSideDock,
}: {
  file: OfficeFile
  onToast: (msg: string) => void
  hideSideDock: boolean
}) {
  const initial = file.content.type === 'md' ? file.content.source : ''
  const [source, setSource] = useState(initial)
  const hostRef = useRef<HTMLDivElement>(null)
  // setSource 走 ref：CodeMirror 实例只建一次，不随每次输入重建。
  const onSource = useRef(setSource)
  onSource.current = setSource

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new CmDomView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          lineNumbers(),
          cmMarkdown(),
          CmDomView.lineWrapping,
          CmDomView.updateListener.of((v) => {
            if (v.docChanged) onSource.current(v.state.doc.toString())
          }),
        ],
      }),
      parent: host,
    })
    return () => { view.destroy() }
    // 编辑器只随文件建立一次（组件按 file.id 重新挂载）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="op-ed-dock-row">
      <div className="op-editor-layout">
        <div className="op-ed-body md-body">
          <div className="op-md-src" ref={hostRef} />
          <div className="op-md-preview">
            <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
          </div>
        </div>
      </div>
      {!hideSideDock && <SideDock file={file} onToast={onToast} />}
    </div>
  )
}
