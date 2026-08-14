import {
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Search,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  createContextRoomResourceLibrary,
  getContextRoomOfficeFormat,
} from '../../resources';
import type {
  ContextRoomOfficeResource,
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

export function OfficePreview({ resource }: { resource: ContextRoomOfficeResource }) {
  const preview = resource.preview;
  return (
    <div className="context-room-office-preview" data-testid="context-room-office-preview">
      <header>
        <span className="context-room-preview-icon">
          {resource.format === 'xlsx' ? <FileSpreadsheet aria-hidden="true" /> : <FileText aria-hidden="true" />}
        </span>
        <div>
          <h1>{preview.title}</h1>
          <p>{resource.format.toUpperCase()} · 只读预览 · {resource.updatedAt}</p>
        </div>
      </header>
      <section className="context-room-preview-summary">
        <span>内容摘要</span>
        <p>{preview.summary}</p>
      </section>
      {preview.columns && preview.rows ? (
        <div className="context-room-sheet-preview">
          <table>
            <thead>
              <tr>{preview.columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={`${String(rowIndex)}-${String(cellIndex)}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {preview.slides ? (
        <div className="context-room-slide-preview">
          {preview.slides.map((slide, index) => (
            <article key={slide.title}>
              <span>{index + 1}</span>
              <div><h2>{slide.title}</h2><p>{slide.body}</p></div>
            </article>
          ))}
        </div>
      ) : null}
      {preview.pages ? (
        <div className="context-room-page-preview">
          {preview.pages.map((page) => <article key={page.title}><h2>{page.title}</h2><p>{page.body}</p></article>)}
        </div>
      ) : null}
      {preview.paragraphs ? (
        <article className="context-room-document-preview">
          <h2>{preview.title}</h2>
          {preview.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </article>
      ) : null}
      {preview.metadata ? (
        <div className="context-room-metadata-preview">
          {preview.metadata.map((item) => <div key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}
        </div>
      ) : null}
    </div>
  );
}

const HOSTFS_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'pdf']);

export interface LocalOfficeFile {
  mimeType: string;
  modifiedAt: Date;
  name: string;
  path: string;
  size: number;
}

const LOCAL_OFFICE_FILES: LocalOfficeFile[] = [
  { name: 'V1 发布检查清单.xlsx', path: '/演示文件/V1 发布检查清单.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedAt: new Date(2026, 6, 9), size: 42_160 },
  { name: '客户沟通纪要.docx', path: '/演示文件/客户沟通纪要.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedAt: new Date(2026, 6, 8), size: 28_640 },
  { name: '阶段汇报.pptx', path: '/演示文件/阶段汇报.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', modifiedAt: new Date(2026, 6, 7), size: 184_320 },
];

function HostFSOfficePicker({ onAdd, onClose }: { onAdd: (file: LocalOfficeFile) => void; onClose: () => void }) {
  const [path, setPath] = useState('/');
  const folders = path === '/' ? [{ name: '演示文件', path: '/演示文件' }] : [];
  const officeFiles = path === '/演示文件'
    ? LOCAL_OFFICE_FILES.filter((entry) => HOSTFS_OFFICE_EXTENSIONS.has(entry.name.split('.').pop()?.toLowerCase() ?? ''))
    : [];
  const parent = path === '/' ? '/' : path.replace(/\/[^/]+$/, '') || '/';
  return (
    <div className="context-room-hostfs-picker" role="dialog" aria-label="从文件系统添加 Office 文件">
      <header><div><strong>文件系统</strong><span>{path}</span></div><button type="button" aria-label="关闭文件系统选择器" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="context-room-hostfs-picker-list">
        {path !== '/' ? <button type="button" onClick={() => setPath(parent)}><ChevronLeft aria-hidden="true" /> 返回上级</button> : null}
        {folders.map((folder) => <button type="button" key={folder.path} onClick={() => setPath(folder.path)}><Folder aria-hidden="true" /><span>{folder.name}</span><ChevronRight aria-hidden="true" /></button>)}
        {officeFiles.map((file) => <button type="button" key={file.path} onClick={() => onAdd(file)}><FileSpreadsheet aria-hidden="true" /><span>{file.name}</span><small>{getContextRoomOfficeFormat(file.name).toUpperCase()}</small></button>)}
        {!folders.length && !officeFiles.length ? <div className="context-room-hostfs-picker-state">当前目录没有可预览的 Office 文件</div> : null}
      </div>
    </div>
  );
}

export function ResourceTree({ room, selectedId, onSelect, onAddFile }: {
  room: ContextRoomRecord;
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onAddFile: (file: LocalOfficeFile) => void;
}) {
  const library = useMemo(() => createContextRoomResourceLibrary(room), [room]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(library.folders.map((folder) => folder.id)));
  const [showFilePicker, setShowFilePicker] = useState(false);
  const normalized = query.trim().toLowerCase();
  return (
    <div className="context-room-resource-tree">
      <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Room 内文档…" aria-label="搜索 Room 内文档" /></label>
      <button type="button" className="context-room-resource-add-file" onClick={() => setShowFilePicker((value) => !value)}><FolderOpen aria-hidden="true" />从文件系统添加 Office 文件</button>
      {showFilePicker ? <HostFSOfficePicker onAdd={(file) => { onAddFile(file); setShowFilePicker(false); }} onClose={() => setShowFilePicker(false)} /> : null}
      <div className="context-room-resource-scroll" role="tree" aria-label="Room 资源">
        {library.folders.map((folder) => {
          const resources = library.resources.filter((resource) => resource.folderId === folder.id && (!normalized || resource.name.toLowerCase().includes(normalized)));
          if (normalized && !resources.length) return null;
          const open = expanded.has(folder.id);
          return <section key={folder.id}><button type="button" className="context-room-resource-folder" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}><ChevronRight aria-hidden="true" className={open ? 'is-open' : ''} />{open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}<span>{folder.name}</span><small>{resources.length}</small></button>{open ? resources.map((resource) => <button type="button" role="treeitem" aria-selected={selectedId === resource.id} key={resource.id} className={`context-room-resource-item${selectedId === resource.id ? ' is-selected' : ''}`} onClick={() => onSelect(resource)}>{resource.kind === 'cloud-doc' ? <FileText aria-hidden="true" /> : resource.format === 'xlsx' ? <FileSpreadsheet aria-hidden="true" /> : <FileText aria-hidden="true" />}<span><b>{resource.name}</b><small>{resource.updatedAt}</small></span></button>) : null}</section>;
        })}
        {!library.resources.some((resource) => !normalized || resource.name.toLowerCase().includes(normalized)) ? <EmptyState>没有匹配的资源</EmptyState> : null}
      </div>
    </div>
  );
}
