import type { NormalizedDocument } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

function notionMarkdown(blocks: any[]): string {
  return blocks.map((block) => {
    const data = block[block.type] ?? {};
    const value = (data.rich_text ?? []).map((item: any) => item.plain_text ?? '').join('');
    if (block.type === 'heading_1') return `# ${value}`;
    if (block.type === 'heading_2') return `## ${value}`;
    if (block.type === 'heading_3') return `### ${value}`;
    if (block.type === 'bulleted_list_item') return `- ${value}`;
    if (block.type === 'numbered_list_item') return `1. ${value}`;
    if (block.type === 'to_do') return `- [${data.checked ? 'x' : ' '}] ${value}`;
    if (block.type === 'quote') return `> ${value}`;
    if (block.type === 'divider') return '---';
    return value;
  }).filter(Boolean).join('\n\n');
}

/** Notion pages（search + blocks children）：无游标全量拉。 */
export const notionSyncProvider: SyncProviderDefinition = {
  provider: "notion",
  engine: "nango",
  dataTypes: ["document"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_NOTION_CONFIG_KEY"],
      configKeyDefault: "notion",
      integrationProvider: "notion",
      credential: "notion",
    },
  },
  defaultScopes: [{ providerScopeId: "pages", displayName: "Notion pages" }],
  ui: { label: "Notion", category: "docs", iconKey: "notion" },
  async *pull(ctx) {
    const search = await ctx.proxyPost('https://api.notion.com/v1/search', { page_size: 100, filter: { property: 'object', value: 'page' } });
    const documents: NormalizedDocument[] = [];
    for (const page of search.results ?? []) {
      const title = Object.values(page.properties ?? {}).find((property: any) => property.type === 'title') as any;
      const name = (title?.title ?? []).map((item: any) => item.plain_text ?? '').join('') || page.id;
      const children = await ctx.proxyGet(`https://api.notion.com/v1/blocks/${page.id.replace(/-/g, '')}/children?page_size=100`);
      documents.push({ providerDocumentId: String(page.id), title: name, markdown: `# ${name}\n\n${notionMarkdown(children.results ?? [])}`, providerRevision: String(page.last_edited_time ?? ''), ...(page.url ? { sourceUrl: String(page.url) } : {}) });
    }
    yield { changes: [], documents };
  },
};
