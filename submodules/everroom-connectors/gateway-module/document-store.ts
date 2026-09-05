import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConnectorProvider, NormalizedDocument, WikiDocumentPreview, WikiDocumentSummary } from "@nxcore/connector-contract";

const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function safeSegment(value: string): string {
  const result = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return result || "document";
}

export class ConnectorDocumentStore {
  constructor(private readonly rootDirectory: string) {}

  async write(provider: ConnectorProvider, connectionId: string, document: NormalizedDocument): Promise<string> {
    const directory = join(this.rootDirectory, safeSegment(provider), safeSegment(connectionId));
    const destination = join(directory, `${safeSegment(document.providerDocumentId)}.md`);
    const temporary = join(directory, `.${safeSegment(document.providerDocumentId)}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, document.markdown, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    return destination;
  }

  async list(provider: ConnectorProvider, connectionId: string): Promise<WikiDocumentSummary[]> {
    const directory = this.connectionDirectory(provider, connectionId);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const documents = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        const [metadata, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
        return {
          id: entry.name.slice(0, -3),
          fileName: entry.name,
          title: this.title(content, entry.name),
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        };
      }));
    return documents.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async read(provider: ConnectorProvider, connectionId: string, documentId: string): Promise<WikiDocumentPreview> {
    if (!DOCUMENT_ID_PATTERN.test(documentId)) throw new Error("invalid_document_id");
    const fileName = `${documentId}.md`;
    const path = join(this.connectionDirectory(provider, connectionId), fileName);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("document_not_found");
    if (metadata.size > MAX_PREVIEW_BYTES) throw new Error("document_too_large");
    const content = await readFile(path, "utf8");
    return { id: documentId, fileName, title: this.title(content, fileName), size: metadata.size, modifiedAt: metadata.mtime.toISOString(), content };
  }

  private connectionDirectory(provider: ConnectorProvider, connectionId: string): string {
    return join(this.rootDirectory, safeSegment(provider), safeSegment(connectionId));
  }

  private title(content: string, fallback: string): string {
    return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback.replace(/\.md$/i, "");
  }
}
