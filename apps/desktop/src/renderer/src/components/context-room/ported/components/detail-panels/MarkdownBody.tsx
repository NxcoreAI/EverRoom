import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 剥 KS 页面 frontmatter（--- 包围的元数据块）。 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  return end >= 0 ? markdown.slice(end + 4).replace(/^\s*\n/, '') : markdown;
}

/** wiki 页面/文件 markdown 的只读渲染（WikiPane 阅读区与编辑栏 WikiPageReader 共用）。 */
export function MarkdownBody({ markdown }: { markdown: string }) {
  return (
    <div className="context-room-wiki-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Wiki 正文位于页面标题之下，延续原有的视觉标题层级。
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h5>{children}</h5>,
          h4: ({ children }) => <h6>{children}</h6>,
          h5: ({ children }) => <h6>{children}</h6>,
          h6: ({ children }) => <h6>{children}</h6>,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {stripFrontmatter(markdown)}
      </ReactMarkdown>
    </div>
  );
}
