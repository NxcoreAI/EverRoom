import type { ProfileHit, QueryProfile } from "../types.js";
import { arrayOf, asRecord, isoTime, snippet, text } from "./shared.js";

function driveQuery(ctx: { concept: string; terms: string[] }): string {
  const terms = (ctx.terms.length > 0 ? ctx.terms : [ctx.concept])
    .map((term) => term.replaceAll("'", "\\'"))
    .filter(Boolean);
  return terms.map((term) => `fullText contains '${term}'`).join(" or ");
}

/**
 * Google Drive：files.list 的全文查询；详情用 files.export 生成可下载的
 * 临时文件（Drive 只给 transit URL，不直接回正文）。
 */
export const googleDriveQueryProfile: QueryProfile = {
  service: "googledrive",
  dataTypes: ["document"],
  buildQueries(ctx) {
    return [
      {
        action: "files.list",
        input: {
          q: driveQuery(ctx),
          pageSize: ctx.limit,
          orderBy: "modifiedTime desc",
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        },
      },
    ];
  },
  parseHits(data): ProfileHit[] {
    const root = asRecord(data);
    const hits: ProfileHit[] = [];
    for (const item of arrayOf(root.files)) {
      const file = asRecord(item);
      const id = text(file.id).trim();
      if (!id) continue;
      const url = text(file.webViewLink).trim();
      hits.push({
        kind: "document",
        id,
        title: text(file.name).trim() || "Untitled",
        snippet: snippet(text(file.mimeType)),
        time: isoTime(file.modifiedTime),
        ...(url ? { url } : {}),
      });
    }
    return hits;
  },
  buildRead(ref) {
    if (ref.kind !== "document") return null;
    return { action: "files.export", input: { fileId: ref.id, mimeType: "text/plain" } };
  },
  renderRead(data) {
    const root = asRecord(data);
    const file = asRecord(root.file);
    const name = text(root.name).trim() || text(file.name).trim() || "Drive file";
    const url = text(file.downloadUrl).trim();
    const markdown = [
      `# ${name}`,
      "",
      `- MIME: ${text(root.mimeType) || text(file.mimeType) || "—"}`,
      `- Size: ${String(root.sizeBytes ?? file.sizeBytes ?? "—")}`,
      url ? `- Download: ${url}` : null,
      "",
      "内容已由 Drive 导出为临时文件；Agent 可把下载链接交给用户，或按需继续导出为其他 MIME。",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return { markdown, title: name, ...(url ? { url } : {}) };
  },
};
