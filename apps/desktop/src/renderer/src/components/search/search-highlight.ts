export interface HighlightSegment {
  text: string
  hit: boolean
}

/**
 * 应用层高亮：按查询词（空白分隔）对文本做大小写不敏感分段。
 * 与 FTS bigram 无关——拿原始查询子串在摘要/标题上标亮。
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0 || !text) return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const marks = new Array<boolean>(lower.length).fill(false);
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      marks.fill(true, index, index + term.length);
      index = lower.indexOf(term, index + term.length);
    }
  }

  const segments: HighlightSegment[] = [];
  let start = 0;
  for (let i = 1; i <= marks.length; i += 1) {
    const boundary = i === marks.length || marks[i] !== marks[start];
    if (boundary) {
      segments.push({ text: text.slice(start, i), hit: marks[start] });
      start = i;
    }
  }
  return segments;
}
