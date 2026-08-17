import { FileText, Network, X } from 'lucide-react'
import type { FormEvent } from 'react'

export function MarkdownSourceDialog({ kind, value, busy, onChange, onClose, onSubmit }: { kind: 'google-docs' | 'notion'; value: { ids: string; token: string }; busy: boolean; onChange: (value: { ids: string; token: string }) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const google = kind === 'google-docs'
  return <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="source-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-source-dialog-title">
      <header className="evidence-dialog-head"><div><span>连接数据源</span><h2 id="markdown-source-dialog-title">{google ? 'Google Docs' : 'Notion'}</h2><small>只读同步为 Markdown，可在数据源中直接预览</small></div><button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button></header>
      <form className="source-connect-form" onSubmit={onSubmit}>
        <label>{google ? '文档 ID 或 URL（每行一个）' : '页面 ID 或 URL（每行一个）'}<textarea required rows={4} value={value.ids} placeholder={google ? 'https://docs.google.com/document/d/.../edit' : 'https://www.notion.so/...'} onChange={(event) => onChange({ ...value, ids: event.target.value })} /></label>
        <label>{google ? 'OAuth access token' : 'Notion integration token'}<input required type="password" value={value.token} onChange={(event) => onChange({ ...value, token: event.target.value })} /></label>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{google ? <FileText aria-hidden="true" strokeWidth={1.8} /> : <Network aria-hidden="true" strokeWidth={1.8} />}开始同步</button></footer>
      </form>
    </section>
  </div>
}
