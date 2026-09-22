import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 双链拦截 scheme：[[目标]] 预处理产物，渲染层点击不走外链。 */
const WIKI_LINK_SCHEME = 'everroom-wiki:';

/** 剥 KS 页面 frontmatter（--- 包围的元数据块）。 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  return end >= 0 ? markdown.slice(end + 4).replace(/^\s*\n/, '') : markdown;
}

/** 链接目标归一化：去锚点、去 ./ 与首尾 /、去 md 扩展名（与服务端图谱解析同规则）。 */
export function normalizeWikiLinkTarget(target: string): string {
  let value = target.split('#')[0]!.trim();
  while (value.startsWith('./')) value = value.slice(2);
  return value.replace(/^\/+|\/+$/g, '').replace(/\.(md|markdown)$/i, '');
}

/** 内链目标 → 页面：精确 path > 补 wiki/ 前缀 path > 标题 > path 末段。
 *  KS wiki 的 md 链接写作根相对（/sources/x.md）而页面 path 带 wiki/ 前缀，故补一跳前缀比对。 */
export function resolveWikiLinkTarget<T extends { title: string; path: string }>(
  target: string,
  pages: T[],
): T | null {
  const normalized = normalizeWikiLinkTarget(target);
  if (!normalized) return null;
  return (
    pages.find((page) => normalizeWikiLinkTarget(page.path) === normalized)
    ?? pages.find((page) => normalizeWikiLinkTarget(page.path) === `wiki/${normalized}`)
    ?? pages.find((page) => page.title.trim() === target.trim())
    ?? pages.find((page) => normalizeWikiLinkTarget(page.path).split('/').pop() === normalized.split('/').pop())
    ?? null
  );
}

/** `[[目标]]` / `[[目标#锚]]` / `[[目标|别名]]` → everroom-wiki: 链接（点击由渲染层拦截跳转）。 */
function transformWikilinks(markdown: string): string {
  return markdown.replace(
    /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, _anchor: string | undefined, label: string | undefined) =>
      `[${(label ?? target).trim()}](${WIKI_LINK_SCHEME}${encodeURIComponent(target.trim())})`,
  );
}

const EXTERNAL_HREF = /^[a-z][a-z0-9+.-]*:/i;

/** react-markdown 会把相对链接里的非 ASCII 百分号编码（/sources/中文.md → /sources/%E4%B8%AD….md），
 *  解析前先还原，否则与页面 path/标题（原始中文）永远对不上。 */
export function decodeWikiHref(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** wiki 页面/文件 markdown 的只读渲染（WikiPane 阅读区与编辑栏 WikiPageReader 共用）。 */
export function MarkdownBody({ markdown, onWikiLink }: {
  markdown: string;
  /** 双链与相对 md 链接的点击跳转（目标解析由调用方负责）；不传则双链按纯文本渲染。 */
  onWikiLink?: (target: string) => void;
}) {
  return (
    <div className="context-room-wiki-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith(WIKI_LINK_SCHEME) ? url : defaultUrlTransform(url))}
        components={{
          // Wiki 正文位于页面标题之下，延续原有的视觉标题层级。
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h5>{children}</h5>,
          h4: ({ children }) => <h6>{children}</h6>,
          h5: ({ children }) => <h6>{children}</h6>,
          h6: ({ children }) => <h6>{children}</h6>,
          a: ({ children, href, node: _node, ...rest }) => {
            if (typeof href === 'string' && href.startsWith(WIKI_LINK_SCHEME)) {
              const target = decodeURIComponent(href.slice(WIKI_LINK_SCHEME.length));
              if (!onWikiLink) {
                return <span className="context-room-wikilink is-unlinked">{children}</span>;
              }
              return (
                <a
                  {...rest}
                  className="context-room-wikilink"
                  href="#"
                  onClick={(event) => { event.preventDefault(); onWikiLink(target); }}
                >
                  {children}
                </a>
              );
            }
            // 相对 md 链接也按站内双链处理（服务端图谱同规则计入内链）
            if (onWikiLink && typeof href === 'string' && href && !href.startsWith('#') && !href.startsWith('//') && !EXTERNAL_HREF.test(href)) {
              return (
                <a
                  {...rest}
                  className="context-room-wikilink"
                  href="#"
                  onClick={(event) => { event.preventDefault(); onWikiLink(decodeWikiHref(href)); }}
                >
                  {children}
                </a>
              );
            }
            return <a {...rest} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
        }}
      >
        {transformWikilinks(stripFrontmatter(markdown))}
      </ReactMarkdown>
    </div>
  );
}
