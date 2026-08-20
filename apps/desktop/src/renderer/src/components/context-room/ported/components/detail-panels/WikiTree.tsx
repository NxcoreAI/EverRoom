import { BookOpen, ChevronDown, ChevronRight, Folder } from 'lucide-react';
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

function WikiTreeItem({ node, depth, selectedPath, onSelect, locale }: {
  node: WikiTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (page: KnowledgeWikiPageDto) => void;
  locale: string;
}) {
  const [open, setOpen] = useState(depth < 1);
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
        <span className="context-room-wiki-tree-name">{node.name}</span>
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

/** wiki 页面目录树（room-wiki 方案 M3c）：页面按 path 分层展示，点击交给编辑栏。 */
export function WikiTree({ pages, selectedPath, onSelect }: {
  pages: KnowledgeWikiPageDto[];
  selectedPath: string | null;
  onSelect: (page: KnowledgeWikiPageDto) => void;
}) {
  const { locale } = useLocale();
  const root = useMemo(() => buildWikiTree(pages), [pages]);
  return (
    <ul className="context-room-wiki-tree">
      {sortNodes([...root.children.values()], locale).map((child) => (
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
  );
}
