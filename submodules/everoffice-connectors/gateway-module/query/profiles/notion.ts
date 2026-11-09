import type { ProfileHit, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoTime, snippet, text } from "./shared.js";

/**
 * Notion 的 properties 结构因页面而异：逐个属性找 type === "title"，
 * 把 title 数组里的 plain_text 拼起来。找不到就退回 "Untitled"。
 */
function notionTitle(page: Record<string, unknown>): string {
  const properties = asRecord(page.properties);
  for (const raw of Object.values(properties)) {
    const property = asRecord(raw);
    if (property.type !== "title") continue;
    const value = arrayOf(property.title)
      .map((item) => text(asRecord(item).plain_text))
      .join("")
      .trim();
    if (value) return value;
  }
  return "";
}

function notionMarkdown(data: unknown): string {
  const record = asRecord(data);
  // retrieve_page_markdown 的输出形状随 oo 版本可能是 {markdown} / {content} / {data:{markdown}}。
  const candidates = [
    text(record.markdown),
    text(record.content),
    text(asRecord(record.data).markdown),
  ];
  return candidates.find((value) => value.trim().length > 0)?.trim() ?? "";
}

/**
 * Notion：search 搜页面，retrieve_page_markdown 读正文。
 * data_source 结果先跳过（本期只把页面当文档）。
 */
export const notionQueryProfile: QueryProfile = {
  service: "notion",
  dataTypes: ["document"],
  buildQueries(ctx) {
    return [
      {
        action: "search",
        input: {
          query: (ctx.terms.length > 0 ? ctx.terms.join(" ") : ctx.concept).trim(),
          pageSize: ctx.limit,
          filter: { property: "object", value: "page" },
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.results)) {
      const page = asRecord(item);
      if (text(page.object) !== "page") continue;
      const id = text(page.id).trim();
      if (!id) continue;
      const title = notionTitle(page);
      const url = text(page.url).trim();
      hits.push({
        kind: "document",
        id,
        title: title || "Untitled",
        snippet: snippet(`${text(page.object)} · ${title || "Untitled"}`),
        time: isoTime(page.last_edited_time),
        ...(url ? { url } : {}),
      });
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "document") return null;
    return { action: "retrieve_page_markdown", input: { pageId: ref.id } };
  },
  renderRead(data) {
    const markdown = notionMarkdown(data);
    if (!markdown) return null;
    const record = asRecord(data);
    const title = text(record.title).trim();
    const url = text(record.url).trim();
    return {
      markdown,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
  },
};
