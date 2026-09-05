import TurndownService from "turndown";

export type ManagedDocumentSyncMode = "reconcile" | "incremental";

export const NOTION_INCREMENTAL_OVERLAP_MS = 2 * 60 * 1_000;
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

export interface CanonicalConnectorDocument {
  sourceRecordId: string;
  documentId: string;
  title: string;
  ownerName: string | null;
  documentType: string;
  bodyText: string;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
  extensionPayload: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

export function managedDocumentSyncMode(input: Record<string, unknown>): ManagedDocumentSyncMode | null {
  const mode = textValue(input.everroomDocumentSyncMode);
  return mode === "reconcile" || mode === "incremental" ? mode : null;
}

export function isNotionDocumentService(service: string): boolean {
  return service.trim().toLowerCase() === "notion";
}

export function isGoogleDocsService(service: string): boolean {
  return ["googledrive", "google_drive", "google_docs", "gdocs"].includes(service.trim().toLowerCase());
}

export function notionPageIsDeleted(value: unknown): boolean {
  const page = objectValue(value);
  return booleanValue(page.archived) || booleanValue(page.in_trash);
}

export function notionPageUpdatedAt(value: unknown): string | null {
  const page = objectValue(value);
  return textValue(page.last_edited_time) ?? textValue(page.lastEditedTime);
}

export function notionMarkdownFromResult(value: unknown): string {
  const result = objectValue(value);
  for (const key of ["markdown", "content", "text", "body"]) {
    const markdown = textValue(result[key]);
    if (markdown) return normalizeMarkdown(markdown);
  }
  const nested = objectValue(result.page);
  for (const key of ["markdown", "content", "text", "body"]) {
    const markdown = textValue(nested[key]);
    if (markdown) return normalizeMarkdown(markdown);
  }
  return "";
}

export function notionPageToDocument(value: unknown, markdown: string): CanonicalConnectorDocument {
  const page = objectValue(value);
  const id = textValue(page.id);
  if (!id) throw new Error("Notion page is missing id");
  const properties = objectValue(page.properties);
  return {
    sourceRecordId: id,
    documentId: id,
    title: notionPageTitle(properties) ?? "无标题 Notion 页面",
    ownerName: notionOwnerName(page),
    documentType: "notion-page",
    bodyText: normalizeMarkdown(markdown),
    sourceUrl: textValue(page.url),
    sourceUpdatedAt: notionPageUpdatedAt(page),
    extensionPayload: {
      sourceFormat: "notion-enhanced-markdown",
      parent: objectValue(page.parent),
      properties,
      archived: booleanValue(page.archived),
      inTrash: booleanValue(page.in_trash),
    },
  };
}

export function googleFileIsDeleted(value: unknown): boolean {
  const file = objectValue(value);
  return booleanValue(file.trashed);
}

export function googleFileIsDocument(value: unknown): boolean {
  return textValue(objectValue(value).mimeType) === GOOGLE_DOC_MIME_TYPE;
}

export function googleFileToDocument(value: unknown, markdown: string): CanonicalConnectorDocument {
  const file = objectValue(value);
  const id = textValue(file.id);
  if (!id) throw new Error("Google Drive file is missing id");
  const owners = Array.isArray(file.owners) ? file.owners.map(objectValue) : [];
  const owner = owners.map((item) => textValue(item.displayName) ?? textValue(item.emailAddress)).find(Boolean) ?? null;
  return {
    sourceRecordId: id,
    documentId: id,
    title: textValue(file.name) ?? "无标题 Google 文档",
    ownerName: owner,
    documentType: "google-doc",
    bodyText: normalizeMarkdown(markdown),
    sourceUrl: textValue(file.webViewLink),
    sourceUpdatedAt: textValue(file.modifiedTime),
    extensionPayload: {
      sourceFormat: "google-docs-html",
      mimeType: textValue(file.mimeType),
      driveId: textValue(file.driveId),
      parents: Array.isArray(file.parents) ? file.parents.filter((item): item is string => typeof item === "string") : [],
      owners,
      shared: booleanValue(file.shared),
      starred: booleanValue(file.starred),
      trashed: booleanValue(file.trashed),
    },
  };
}

export function googleDocsHtmlToMarkdown(bytes: Buffer): string {
  const html = bytes.toString("utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Raw HTML is the only lossless Markdown representation for merged cells and complex Docs tables.
  turndown.keep(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "sub", "sup"]);
  return normalizeMarkdown(turndown.turndown(html));
}

export function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function notionPageTitle(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    const property = objectValue(value);
    if (property.type !== "title" && !Array.isArray(property.title)) continue;
    const title = richText(property.title);
    if (title) return title;
  }
  for (const key of ["title", "Title", "name", "Name", "名称", "标题"]) {
    const property = objectValue(properties[key]);
    const title = richText(property.title ?? property.rich_text ?? properties[key]);
    if (title) return title;
  }
  return null;
}

function richText(value: unknown): string | null {
  if (typeof value === "string") return textValue(value);
  if (!Array.isArray(value)) return null;
  const text = value.map((item) => {
    const entry = objectValue(item);
    return textValue(entry.plain_text)
      ?? textValue(objectValue(entry.text).content)
      ?? textValue(entry.content)
      ?? "";
  }).join("").trim();
  return text || null;
}

function notionOwnerName(page: Record<string, unknown>): string | null {
  for (const key of ["last_edited_by", "created_by"]) {
    const person = objectValue(page[key]);
    const name = textValue(person.name) ?? textValue(objectValue(person.person).email);
    if (name) return name;
  }
  return null;
}
