import { ArrowLeft, FileImage, FilePlus2, FileText, FolderInput, Link2Off, LoaderCircle, Paperclip, RefreshCw, Save, Trash2, Unplug } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { ObsidianVaultBinding, ObsidianVaultResource, VaultNoteSnapshot } from '../../../../../shared/obsidian'
import type { ContextRoomRecord } from '../ported/types'
import { useLocale } from '../../../i18n/LocaleContext'
import './ObsidianVaultRoom.css'

const MarkdownEditor = lazy(() => import('./ObsidianMarkdownEditor').then((module) => ({ default: module.ObsidianMarkdownEditor })))

function previewSource(markdown: string, resources: ObsidianVaultResource[]): string {
  const byName = new Map<string, ObsidianVaultResource>()
  for (const resource of resources) {
    byName.set(resource.relativePath.replace(/\.(md|markdown)$/i, '').toLowerCase(), resource)
    byName.set(resource.name.replace(/\.(md|markdown)$/i, '').toLowerCase(), resource)
  }
  let source = markdown.replace(/^---\n([\s\S]*?)\n---\n?/, (_match, body: string) => `> **Frontmatter**\n> ${body.replaceAll('\n', '\n> ')}\n\n`)
  source = source.replace(/!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g, (match, target: string) => {
    const resource = byName.get(target.trim().toLowerCase())
    if (!resource?.assetUrl) return `\`${match}\``
    return resource.kind === 'image' ? `![${resource.name}](${resource.assetUrl})` : `[${resource.name}](${resource.assetUrl})`
  })
  return source.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => {
    const resource = byName.get(target.trim().toLowerCase())
    return resource?.kind === 'note'
      ? `[${label || target}](obsidian-note:${resource.id})`
      : `[${label || target}](obsidian-unresolved:${encodeURIComponent(target)})`
  }).replace(/^> \[!([^\]]+)\](.*)$/gm, '> **$1$2**')
}

export function ObsidianVaultRoom({ room, vault, onBack, onDisconnect }: {
  room: ContextRoomRecord
  vault: ObsidianVaultBinding
  onBack: () => void
  onDisconnect: (vaultId: string) => Promise<void>
}) {
  const { t } = useLocale()
  const api = window.nxcore?.obsidian
  const [resources, setResources] = useState<ObsidianVaultResource[]>([])
  const [selected, setSelected] = useState<VaultNoteSnapshot | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<VaultNoteSnapshot | null>(null)
  const dirty = Boolean(selected && draft !== selected.markdown)

  const loadTree = useCallback(async () => {
    if (!api) return
    try {
      const tree = await api.tree(vault.id)
      setResources(tree.resources)
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.readVaultFailed')) }
    finally { setLoading(false) }
  }, [api, t, vault.id])

  const openNote = useCallback(async (resourceId: string, force = false) => {
    if (!api || (!force && dirty && !window.confirm(t('surface:obsidian.unsavedConfirm')))) return
    try {
      const snapshot = await api.readNote(vault.id, resourceId)
      setSelected(snapshot); setDraft(snapshot.markdown); setConflict(null); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.readNoteFailed')) }
  }, [api, dirty, t, vault.id])

  useEffect(() => { void loadTree() }, [loadTree])
  useEffect(() => api?.onChanged((event) => {
    if (event.vaultId !== vault.id) return
    void loadTree()
    if (selected && !dirty) void openNote(selected.resource.id, true)
  }), [api, dirty, loadTree, openNote, selected, vault.id])

  const notes = useMemo(() => resources.filter((item) => item.kind === 'note'), [resources])
  const save = async () => {
    if (!api || !selected) return
    setSaving(true)
    try {
      const result = await api.saveNote(vault.id, selected.resource.id, draft, selected.sourceHash)
      if (result.status === 'conflict') setConflict(result.snapshot)
      else { setSelected(result.snapshot); setDraft(result.snapshot.markdown); setConflict(null); await loadTree() }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.saveFailed')) }
    finally { setSaving(false) }
  }
  const createNote = async () => {
    if (!api) return
    const path = window.prompt(t('surface:obsidian.newNotePrompt'))?.trim()
    if (!path) return
    try { const snapshot = await api.createNote(vault.id, path); await loadTree(); setSelected(snapshot); setDraft(snapshot.markdown); setMode('edit') }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.createFailed')) }
  }
  const moveNote = async () => {
    if (!api || !selected) return
    const path = window.prompt(t('surface:obsidian.movePrompt'), selected.resource.relativePath)?.trim()
    if (!path || path === selected.resource.relativePath) return
    try { const snapshot = await api.moveNote(vault.id, selected.resource.id, path, selected.sourceHash); await loadTree(); setSelected(snapshot); setDraft(snapshot.markdown) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.moveFailed')) }
  }
  const trashNote = async () => {
    if (!api || !selected || !window.confirm(t('surface:obsidian.trashConfirm', { name: selected.resource.name }))) return
    try { await api.trashNote(vault.id, selected.resource.id, selected.sourceHash); setSelected(null); setDraft(''); await loadTree() }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('surface:obsidian.deleteFailed')) }
  }

  return <div className="context-room-app obsidian-room">
    <header className="obsidian-room-toolbar">
      <button type="button" title={t('surface:obsidian.back')} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      <div className="obsidian-room-title"><strong>{room.title}</strong><span data-status={vault.status}>{t(`surface:obsidian.${vault.status === 'connected' ? 'connected' : 'offline'}`)} · {vault.noteCount} {t('surface:obsidian.notes')} · {vault.attachmentCount} {t('surface:obsidian.attachments')}</span></div>
      <div className="obsidian-room-actions">
        <button type="button" title={t('surface:obsidian.newNote')} onClick={() => void createNote()}><FilePlus2 aria-hidden="true" /></button>
        <button type="button" title={t('surface:obsidian.addAttachment')} onClick={() => void api?.addAttachment(vault.id, selected?.resource.relativePath).then(() => loadTree())}><Paperclip aria-hidden="true" /></button>
        <button type="button" title={t('surface:obsidian.disconnect')} onClick={() => window.confirm(t('surface:obsidian.disconnectConfirm')) && void onDisconnect(vault.id)}><Unplug aria-hidden="true" /></button>
      </div>
    </header>
    {error ? <div className="obsidian-room-error" role="alert">{error}<button type="button" onClick={() => setError('')}>{t('surface:obsidian.close')}</button></div> : null}
    <div className="obsidian-room-layout">
      <aside className="obsidian-resource-tree">
        <div className="obsidian-tree-heading"><span>{t('surface:obsidian.resourceTree')}</span><button type="button" title={t('surface:inspiration.retry')} onClick={() => void loadTree()}><RefreshCw aria-hidden="true" /></button></div>
        {loading ? <div className="obsidian-tree-empty"><LoaderCircle className="is-spinning" /></div> : notes.map((resource) => {
          const depth = resource.relativePath.split('/').length - 1
          return <button key={resource.id} type="button" className={selected?.resource.id === resource.id ? 'is-active' : ''} style={{ paddingLeft: `${12 + depth * 14}px` }} onClick={() => void openNote(resource.id)} title={resource.relativePath}><FileText aria-hidden="true" /><span>{resource.name.replace(/\.(md|markdown)$/i, '')}</span></button>
        })}
        {resources.filter((item) => item.kind !== 'note').length ? <div className="obsidian-tree-group">{t('surface:obsidian.attachmentsGroup')}</div> : null}
        {resources.filter((item) => item.kind !== 'note').map((resource) => <a key={resource.id} href={resource.assetUrl ?? undefined} target="_blank" rel="noreferrer" title={resource.relativePath}><FileImage aria-hidden="true" /><span>{resource.name}</span></a>)}
      </aside>
      <main className="obsidian-note-workspace">
        {!selected ? <div className="obsidian-note-empty"><FileText aria-hidden="true" /><h2>{t('surface:obsidian.selectNote')}</h2><p>{t('surface:obsidian.sourceHint')}</p></div> : <>
          <header className="obsidian-note-toolbar"><div><strong>{selected.resource.name}</strong><span>{selected.resource.relativePath}</span></div><div className="obsidian-note-controls"><span className="obsidian-mode"><button className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>{t('surface:obsidian.edit')}</button><button className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}>{t('surface:obsidian.preview')}</button></span><button title={t('surface:obsidian.moveOrRename')} onClick={() => void moveNote()}><FolderInput /></button><button title={t('surface:obsidian.moveToTrash')} onClick={() => void trashNote()}><Trash2 /></button><button className="is-primary" disabled={!dirty || saving || vault.status !== 'connected'} onClick={() => void save()}>{saving ? <LoaderCircle className="is-spinning" /> : <Save />}<span>{t('surface:obsidian.save')}</span></button></div></header>
          <div className="obsidian-note-content">{mode === 'edit' ? <Suspense fallback={<div className="obsidian-note-empty"><LoaderCircle className="is-spinning" /></div>}><MarkdownEditor value={draft} onChange={setDraft} readOnly={vault.status !== 'connected'} /></Suspense> : <div className="obsidian-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url.startsWith('obsidian-') || url.startsWith('nxcore-vault-asset:') ? url : defaultUrlTransform(url)} components={{ a: ({ href, children }) => href?.startsWith('obsidian-note:') ? <button className="obsidian-wikilink" onClick={() => void openNote(href.slice('obsidian-note:'.length))}>{children}</button> : href?.startsWith('obsidian-unresolved:') ? <span className="obsidian-unresolved" title={t('surface:obsidian.unresolvedWikilink')}><Link2Off />{children}</span> : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{previewSource(draft, resources)}</ReactMarkdown></div>}</div>
        </>}
      </main>
    </div>
    {conflict ? <div className="obsidian-conflict-overlay" role="dialog" aria-modal="true"><div className="obsidian-conflict-dialog"><header><div><strong>{t('surface:obsidian.conflictTitle')}</strong><p>{t('surface:obsidian.conflictDescription')}</p></div><button onClick={() => setConflict(null)}>{t('surface:obsidian.close')}</button></header><div className="obsidian-conflict-columns"><section><h3>{t('surface:obsidian.currentDraft')}</h3><pre>{draft}</pre></section><section><h3>{t('surface:obsidian.diskVersion')}</h3><pre>{conflict.markdown}</pre></section></div><footer><button onClick={() => { setSelected(conflict); setDraft(conflict.markdown); setConflict(null) }}>{t('surface:obsidian.useDisk')}</button><button className="is-primary" onClick={() => setConflict(null)}>{t('surface:obsidian.keepDraft')}</button></footer></div></div> : null}
  </div>
}
