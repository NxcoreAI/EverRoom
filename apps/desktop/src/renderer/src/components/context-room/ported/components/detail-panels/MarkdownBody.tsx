/** 剥 KS 页面 frontmatter（--- 包围的元数据块）。 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  return end >= 0 ? markdown.slice(end + 4).replace(/^\s*\n/, '') : markdown;
}

interface MarkdownBlock {
  key: number;
  kind: 'h1' | 'h2' | 'h3' | 'li' | 'p';
  text: string;
}

/** 轻量 markdown 分块：标题/列表/段落（wiki 页面以这三种为主，够用且零依赖）。 */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = stripFrontmatter(markdown).split('\n');
  let paragraph: string[] = [];
  let key = 0;
  const flush = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) blocks.push({ key: key++, kind: 'p', text });
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      blocks.push({ key: key++, kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: heading[2]! });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ key: key++, kind: 'li', text: bullet[1]! });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** wiki 页面/文件 markdown 的只读渲染（WikiPane 阅读区与编辑栏 WikiPageReader 共用）。 */
export function MarkdownBody({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <div className="context-room-wiki-markdown">
      {blocks.map((block) => {
        if (block.kind === 'h1') return <h3 key={block.key}>{block.text}</h3>;
        if (block.kind === 'h2') return <h4 key={block.key}>{block.text}</h4>;
        if (block.kind === 'h3') return <h5 key={block.key}>{block.text}</h5>;
        if (block.kind === 'li') return <li key={block.key}>{block.text}</li>;
        return <p key={block.key}>{block.text}</p>;
      })}
    </div>
  );
}
