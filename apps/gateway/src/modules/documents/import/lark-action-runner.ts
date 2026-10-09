import { LarkCliError, runLarkCli, type LarkCliConfig } from "../agent-export/lark-cli.js";
import { ImportConnectorError, type ImportConnectorActionCall } from "./oo-runner.js";
import type { ImportActionFn } from "./providers.js";

/**
 * 导入链路的飞书 lark-cli 调用层（oo-runner 的换轨版）：把适配器发出的
 * OpenConnector action 调用翻译成 lark-cli 命令，并把 CLI 信封归一化成
 * 适配器已消费的 oo 形状（providers.ts 的解析逻辑零改动）。CLI 错误统一
 * 分类成 ImportConnectorError，授权缺失经 service 映射为 422 引导授权。
 */

export function larkErrorToImportConnectorError(error: LarkCliError): ImportConnectorError {
  switch (error.kind) {
    case "auth_required":
      return new ImportConnectorError("authentication_required", error.detail);
    case "app_setup_required":
      return new ImportConnectorError("no_connection", error.detail);
    case "environment":
      return new ImportConnectorError("connector_unavailable", error.detail);
    case "timeout":
      return new ImportConnectorError("timeout", error.detail);
    default:
      return new ImportConnectorError("connector_error", error.detail);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Search v2 高亮标签（<h>/<b>/<em> 等）剥除，与导出侧同用通用去标签。 */
function stripHighlightTags(value: string | null): string | null {
  return value ? value.replace(/<[^>]+>/g, "").trim() || null : null;
}

/** `docs +search` 结果条目拍平：token/url/时间/作者在嵌套 result_meta，标题带高亮标签。 */
function flattenSearchItem(record: Record<string, unknown>): Record<string, unknown> {
  const meta = objectValue(record.result_meta);
  const token = textValue(meta.token) ?? textValue(meta.doc_token);
  return {
    url: textValue(meta.url),
    token,
    doc_token: token,
    title: stripHighlightTags(textValue(record.title_highlighted)) ?? textValue(record.title),
    owner_name: textValue(meta.owner_name),
    update_time: textValue(meta.update_time),
  };
}

const TITLE_TAG_PATTERN = /^<title\b[^>]*>([\s\S]*?)<\/title>/;

/** markdown 正文首部的 <title> 标签提取标题（+fetch 信封无 title 字段）。 */
function extractTitleFromContent(content: string | null): string | null {
  if (!content) return null;
  const match = TITLE_TAG_PATTERN.exec(content);
  if (!match?.[1]) return null;
  return match[1].replace(/<[^>]+>/g, "").trim() || null;
}

function pagedOf(data: unknown, itemsKey: string): { items: unknown[]; hasMore: boolean; pageToken: string | null } {
  const root = objectValue(data);
  return {
    items: Array.isArray(root[itemsKey]) ? root[itemsKey] as unknown[] : [],
    hasMore: root.has_more === true,
    pageToken: textValue(root.page_token) ?? textValue(root.next_page_token),
  };
}

async function runCli(config: LarkCliConfig, args: string[], timeoutMs?: number): Promise<Record<string, unknown>> {
  try {
    const { data } = await runLarkCli(config, args, timeoutMs === undefined ? {} : { timeoutMs });
    return objectValue(data);
  } catch (error) {
    if (error instanceof LarkCliError) throw larkErrorToImportConnectorError(error);
    throw error;
  }
}

function requireInputText(input: Record<string, unknown>, key: string, action: string): string {
  const value = textValue(input[key]);
  if (!value) {
    throw new ImportConnectorError("invalid_input", `feishu.${action} 缺少参数 ${key}`);
  }
  return value;
}

async function dispatchAction(config: LarkCliConfig, call: ImportConnectorActionCall): Promise<unknown> {
  if (call.service !== "feishu") {
    throw new ImportConnectorError("action_not_found", `lark-cli 通道不支持 service "${call.service}"`);
  }
  const input = call.input;
  switch (call.action) {
    case "list_drive_files": {
      const data = await runCli(config, [
        "drive", "files", "list",
        "--page-size", textValue(input.pageSize) ?? "200",
        ...(textValue(input.folderToken) ? ["--folder-token", textValue(input.folderToken)!] : []),
        ...(textValue(input.pageToken) ? ["--page-token", textValue(input.pageToken)!] : []),
      ]);
      // {files, next_page_token, has_more} → 适配器消费的 {items, pageToken, hasMore}。
      const root = objectValue(data);
      return {
        items: Array.isArray(root.files) ? root.files : [],
        pageToken: textValue(root.next_page_token),
        hasMore: root.has_more === true,
      };
    }
    case "search_documents": {
      const data = await runCli(config, [
        "docs", "+search",
        "--query", typeof input.query === "string" ? input.query : "",
        "--page-size", String(Math.min(Number(textValue(input.pageSize) ?? 20), 20)),
        ...(textValue(input.pageToken) ? ["--page-token", textValue(input.pageToken)!] : []),
      ]);
      const root = objectValue(data);
      return {
        results: (Array.isArray(root.results) ? root.results : []).map((record) => flattenSearchItem(objectValue(record))),
        pageToken: textValue(root.page_token),
        hasMore: root.has_more === true,
      };
    }
    case "list_wiki_spaces": {
      const data = await runCli(config, [
        "wiki", "+space-list",
        "--page-size", textValue(input.pageSize) ?? "50",
        ...(textValue(input.pageToken) ? ["--page-token", textValue(input.pageToken)!] : []),
      ]);
      return pagedOf(data, "items");
    }
    case "list_wiki_nodes": {
      const data = await runCli(config, [
        "wiki", "+node-list",
        "--space-id", requireInputText(input, "spaceId", "list_wiki_nodes"),
        "--page-size", textValue(input.pageSize) ?? "50",
        ...(textValue(input.parentNodeToken) ? ["--parent-node-token", textValue(input.parentNodeToken)!] : []),
        ...(textValue(input.pageToken) ? ["--page-token", textValue(input.pageToken)!] : []),
      ]);
      return pagedOf(data, "items");
    }
    case "get_document":
      // +fetch 信封已带 title/revision（title 从正文 <title> 提取），元数据无
      // 独立命令——短路空对象，适配器 meta 步零告警跳过。
      return {};
    case "fetch_document": {
      const data = await runCli(config, [
        "docs", "+fetch",
        "--doc", requireInputText(input, "documentId", "fetch_document"),
        "--scope", "full",
        "--doc-format", "markdown",
      ]);
      const document = objectValue(data.document);
      const content = textValue(document.content);
      return {
        document: {
          content,
          document_id: textValue(document.document_id),
          revision_id: textValue(document.revision_id),
          title: extractTitleFromContent(content),
        },
      };
    }
    case "list_drive_comments": {
      const data = await runCli(config, [
        "drive", "+list-comments",
        "--token", requireInputText(input, "fileToken", "list_drive_comments"),
        "--type", textValue(input.fileType) ?? "docx",
        "--page-size", textValue(input.pageSize) ?? "100",
        "--solved-status", "all",
        "--comment-scope", "all",
        ...(textValue(input.pageToken) ? ["--page-token", textValue(input.pageToken)!] : []),
      ]);
      return pagedOf(data, "items");
    }
    default:
      throw new ImportConnectorError(
        "action_not_found",
        `lark-cli 通道不支持 feishu action "${call.action}"`,
      );
  }
}

export function createLarkImportActionRunner(
  config: LarkCliConfig,
  options: { ensureAuth?: () => Promise<void> } = {},
): ImportActionFn {
  return async (call, _signal) => {
    // get_document 短路不 spawn，无需鉴权检查。
    if (!(call.service === "feishu" && call.action === "get_document")) {
      await options.ensureAuth?.();
    }
    return dispatchAction(config, call);
  };
}

/** 图片物化专用：媒体下载到本地文件（outputPath 必须带扩展名，否则 CLI 会按
 * Content-Type 自动补扩展名导致路径漂移）；返回实际落盘路径。 */
export async function downloadLarkMediaToFile(
  config: LarkCliConfig,
  token: string,
  outputPath: string,
): Promise<string> {
  const { data } = await runLarkCli(config, [
    "docs", "+media-download",
    "--token", token,
    "--type", "media",
    "--output", outputPath,
    "--overwrite",
  ]);
  const envelope = objectValue(data);
  const written = textValue(envelope.output) ?? textValue(envelope.path);
  return written ?? outputPath;
}
