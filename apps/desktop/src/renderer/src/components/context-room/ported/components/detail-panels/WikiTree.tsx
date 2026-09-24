import { BookOpen, ChevronDown, ChevronRight, Folder, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { KnowledgeWikiPageDto } from '../../../../../../../shared/knowledge';

interface WikiTreeNode {
  name: string;
  /** 目录路径以 / 结尾，页面路径为 KS path 原样。 */
  path: string;
  isDirectory: boolean;
  page: KnowledgeWikiPageDto | null;
  children: Map<string, WikiTreeNode>;
}

/** 导读置顶页（wiki 脚手架里的"人话"文件）；按文件名识别，不依赖目录层级。 */
const PINNED_FILE_NAMES = new Set(['overview.md', 'purpose.md']);

/** 机器脚手架文件：读者不需要第一眼看到，折叠进「系统文件」（不删，仍可展开访问）。 */
const SYSTEM_FILE_NAMES = new Set(['index.md', 'log.md', 'schema.md']);

/** KS 侧固定分桶目录 → i18n 标签；未知目录回退原名。 */
const FOLDER_LABEL_KEYS: Record<string, string> = {
  concepts: 'surface:wiki.folderConcepts',
  entities: 'surface:wiki.folderEntities',
  sources: 'surface:wiki.folderSources',
  other: 'surface:wiki.folderOther',
};

/** 纯包装目录（所有页面共享的前缀壳），树里不占一级。 */
const WRAPPER_DIR_NAMES = new Set(['wiki', 'pages']);

/** 按 page.path 的 / 段递归建目录树（文档栏式；目录在页面间共享前缀）。 */
function buildWikiTree(pages: KnowledgeWikiPageDto[]): WikiTreeNode {
  const root: WikiTreeNode = { name: '', path: '', isDirectory: true, page: null, children: new Map() };
  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const isLeaf = index === segments.length - 1;
      let child = node.children.get(name);
      if (!child) {
        child = {
          name,
          path: isLeaf ? page.path : `${segments.slice(0, index + 1).join('/')}/`,
          isDirectory: !isLeaf,
          page: isLeaf ? page : null,
          children: new Map(),
        };
        node.children.set(name, child);
      }
      node = child;
    }
  }
  return root;
}

function sortNodes(nodes: WikiTreeNode[], locale: string): WikiTreeNode[] {
  return [...nodes.values()].sort((a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, locale));
}

/** 目录内叶子页计数（递归）；文件夹标题后的 `(n)`，读者先知道哪里厚。 */
function countPages(node: WikiTreeNode): number {
  if (!node.isDirectory) return 1;
  let total = 0;
  for (const child of node.children.values()) total += countPages(child);
  return total;
}

function WikiTreeItem({ node, depth, selectedPath, onSelect, locale }: {
  node: WikiTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (page: KnowledgeWikiPageDto) => void;
  locale: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const { t } = useLocale();
  const children = sortNodes([...node.children.values()], locale);
  return (
    <li>
      <button
        type="button"
        className="context-room-wiki-tree-node"
        style={{ paddingLeft: 6 + depth * 14 }}
        data-selected={node.page ? node.page.path === selectedPath : undefined}
        data-directory={node.isDirectory}
        title={node.isDirectory ? node.path : node.page?.description || node.page?.title || node.path}
        onClick={() => {
          if (node.isDirectory) setOpen((value) => !value);
          else if (node.page) onSelect(node.page);
        }}
      >
        {node.isDirectory ? (
          <>
            {open
              ? <ChevronDown aria-hidden="true" strokeWidth={1.8} className="context-room-wiki-tree-caret" />
              : <ChevronRight aria-hidden="true" strokeWidth={1.8} className="context-room-wiki-tree-caret" />}
            <Folder aria-hidden="true" strokeWidth={1.7} />
          </>
        ) : (
          <BookOpen aria-hidden="true" strokeWidth={1.7} />
        )}
        <span className="context-room-wiki-tree-name">
          {node.isDirectory ? t(FOLDER_LABEL_KEYS[node.name] ?? node.name) : node.name}
        </span>
        {node.isDirectory ? (
          <span className="context-room-wiki-tree-count">{countPages(node)}</span>
        ) : null}
      </button>
      {node.isDirectory && open ? (
        <ul className="context-room-wiki-tree-children">
          {children.map((child) => (
            <WikiTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              locale={locale}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function fileName(page: KnowledgeWikiPageDto): string {
  return page.path.split('/').pop() ?? page.path;
}

/** 平铺页行（置顶概览/系统文件/搜索结果共用），样式与树节点一致。 */
function WikiFlatPageRow({ page, selectedPath, onSelect }: {
  page: KnowledgeWikiPageDto;
  selectedPath: string | null;
  onSelect: (page: KnowledgeWikiPageDto) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="context-room-wiki-tree-node"
        data-selected={page.path === selectedPath || undefined}
        title={page.description || page.title || page.path}
        onClick={() => onSelect(page)}
      >
        <BookOpen aria-hidden="true" strokeWidth={1.7} />
        <span className="context-room-wiki-tree-name">{page.title || fileName(page)}</span>
      </button>
    </li>
  );
}

/**
 * wiki 页面目录（room-wiki 方案 M3c）：导读优先——置顶概览页、分桶目录带计数、
 * 机器脚手架（index/log/schema）折叠进「系统文件」。页面按 path 分层，点击交给阅读区。
 */
export function WikiTree({ pages, selectedPath, onSelect }: {
  pages: KnowledgeWikiPageDto[];
  selectedPath: string | null;
  onSelect: (page: KnowledgeWikiPageDto) => void;
}) {
  const { t, locale } = useLocale();
  const [systemOpen, setSystemOpen] = useState(false);
  const { pinned, system, rest } = useMemo(() => {
    const pinned: KnowledgeWikiPageDto[] = [];
    const system: KnowledgeWikiPageDto[] = [];
    const rest: KnowledgeWikiPageDto[] = [];
    for (const page of pages) {
      const name = fileName(page);
      if (PINNED_FILE_NAMES.has(name)) pinned.push(page);
      else if (SYSTEM_FILE_NAMES.has(name)) system.push(page);
      else rest.push(page);
    }
    return { pinned, system, rest };
  }, [pages]);
  const root = useMemo(() => {
    let node = buildWikiTree(rest);
    // 全部页面共享同一前缀目录（KS 的 wiki/…）时下钻剥掉，别让包装层占一级
    while (node.children.size === 1) {
      const only = [...node.children.values()][0];
      if (!only || !only.isDirectory || !WRAPPER_DIR_NAMES.has(only.name)) break;
      node = only;
    }
    return node;
  }, [rest]);
  const treeChildren = sortNodes([...root.children.values()], locale);
  return (
    <div className="wiki-tree-sections">
      {pinned.length > 0 ? (
        <section className="wiki-tree-section">
          <div className="wiki-tree-section-header">{t('surface:wiki.sectionOverview')}</div>
          <ul className="context-room-wiki-tree">
            {[...pinned]
              .sort((a, b) => fileName(a).localeCompare(fileName(b), locale))
              .map((page) => (
                <WikiFlatPageRow key={page.path} page={page} selectedPath={selectedPath} onSelect={onSelect} />
              ))}
          </ul>
        </section>
      ) : null}
      {treeChildren.length > 0 ? (
        <ul className="context-room-wiki-tree">
          {treeChildren.map((child) => (
            <WikiTreeItem
              key={child.path}
              node={child}
              depth={0}
              selectedPath={selectedPath}
              onSelect={onSelect}
              locale={locale}
            />
          ))}
        </ul>
      ) : null}
      {system.length > 0 ? (
        <section className="wiki-tree-section wiki-tree-system">
          <button
            type="button"
            className="wiki-tree-section-header wiki-tree-system-toggle"
            aria-expanded={systemOpen}
            onClick={() => setSystemOpen((value) => !value)}
          >
            {systemOpen
              ? <ChevronDown aria-hidden="true" strokeWidth={1.8} className="context-room-wiki-tree-caret" />
              : <ChevronRight aria-hidden="true" strokeWidth={1.8} className="context-room-wiki-tree-caret" />}
            <Wrench aria-hidden="true" strokeWidth={1.7} />
            <span>{t('surface:wiki.sectionSystem')}</span>
            <span className="context-room-wiki-tree-count">{system.length}</span>
          </button>
          {systemOpen ? (
            <ul className="context-room-wiki-tree">
              {[...system]
                .sort((a, b) => fileName(a).localeCompare(fileName(b), locale))
                .map((page) => (
                  <WikiFlatPageRow key={page.path} page={page} selectedPath={selectedPath} onSelect={onSelect} />
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
