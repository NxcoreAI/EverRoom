import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { KnowledgeWikiPageDto } from '../../../../../../../shared/knowledge';
import { MarkdownBody, decodeWikiHref, normalizeWikiLinkTarget, resolveWikiLinkTarget } from './MarkdownBody';

const page = (id: string, title: string, path: string): KnowledgeWikiPageDto => ({ id, title, type: 'doc', path });

const pages = [
  page('p1', '排障指南', 'ops/troubleshooting.md'),
  page('p2', '连接器调研', 'research/connector.md'),
  page('p3', '同名页', 'a/overview.md'),
  page('p4', '同名页', 'b/overview.md'),
];

describe('normalizeWikiLinkTarget', () => {
  it('去锚点、./ 前缀、首尾斜杠与 md 扩展名', () => {
    expect(normalizeWikiLinkTarget('./ops/troubleshooting.md#section')).toBe('ops/troubleshooting');
    expect(normalizeWikiLinkTarget('/research/connector.markdown/')).toBe('research/connector');
    expect(normalizeWikiLinkTarget(' 排障指南 ')).toBe('排障指南');
  });
});

describe('resolveWikiLinkTarget', () => {
  it('按精确 path 命中', () => {
    expect(resolveWikiLinkTarget('ops/troubleshooting.md', pages)?.id).toBe('p1');
  });

  it('根相对链接补 wiki/ 前缀命中（KS 内链写作 /sources/x.md，页面 path 为 wiki/sources/x.md）', () => {
    expect(resolveWikiLinkTarget('/sources/connector.md', pages)?.id).toBe('p2');
  });

  it('按标题命中', () => {
    expect(resolveWikiLinkTarget('连接器调研', pages)?.id).toBe('p2');
  });

  it('path > 标题 > 末段，末段歧义时取先出现者', () => {
    expect(resolveWikiLinkTarget('overview', pages)?.id).toBe('p3');
    expect(resolveWikiLinkTarget('同名页', pages)?.id).toBe('p3');
  });

  it('未命中返回 null（锚点不参与比对）', () => {
    expect(resolveWikiLinkTarget('不存在', pages)).toBeNull();
    expect(resolveWikiLinkTarget('ops/troubleshooting#faq', pages)?.id).toBe('p1');
  });
});

describe('decodeWikiHref', () => {
  it('还原 react-markdown 对相对链接中文的百分号编码（含已编码 % 不受影响）', () => {
    expect(decodeWikiHref('/sources/ai-%E7%A1%AC%E4%BB%B6-2026-08.md')).toBe('/sources/ai-硬件-2026-08.md');
    expect(decodeWikiHref('/sources/plain.md')).toBe('/sources/plain.md');
    expect(decodeWikiHref('/bad/%E0%A4%A')).toBe('/bad/%E0%A4%A');
  });

  it('编码串经解码后能按 wiki/ 前缀规则解析到页面', () => {
    const encoded = '/sources/ai-%E7%A1%AC%E4%BB%B6-2026-08.md';
    const withPrefix = [
      page('px', 'AI硬件', 'wiki/sources/ai-硬件-2026-08.md'),
    ];
    expect(resolveWikiLinkTarget(decodeWikiHref(encoded), withPrefix)?.id).toBe('px');
  });
});

describe('MarkdownBody 渲染', () => {
  it('[[双链]] 渲染为可点 wikilink，外链仍走 target=_blank', () => {
    const html = renderToStaticMarkup(
      <MarkdownBody
        markdown={'参见 [[连接器调研|调研结论]] 与 [[排障指南]]，外部见 [官网](https://example.com)。'}
        onWikiLink={vi.fn()}
      />,
    );
    expect(html).toContain('context-room-wikilink');
    expect(html).toContain('调研结论');
    expect(html).toContain('排障指南');
    expect(html.match(/target="_blank"/g)).toHaveLength(1);
    expect(html).not.toContain('everroom-wiki:');
  });

  it('无 onWikiLink 时双链退化为纯文本 span（不产生站内 scheme 残留）', () => {
    const html = renderToStaticMarkup(
      <MarkdownBody markdown={'参见 [[排障指南]]。'} />,
    );
    expect(html).not.toContain('everroom-wiki:');
    expect(html).toContain('<span class="context-room-wikilink is-unlinked">排障指南</span>');
  });
});
