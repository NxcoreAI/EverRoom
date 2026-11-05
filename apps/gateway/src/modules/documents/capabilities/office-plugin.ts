import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { annotations, manifest } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool, type SlidesPageProgressReporter } from "./types.js";
import { bundledAgentDefinitionsDir } from "../../../config.js";
import type {
  OfficeAgentToolCall,
  OfficeAgentToolsResult,
  OfficeApplyBytesResult,
  OfficeBridgeClient,
  OfficeSheetBridgeInput,
} from "./office-bridge-client.js";
import { applyDocxOps, DocxEditError, readDocxParagraphs, type DocxEditOp } from "../../files/docx-edit.js";
import { applyXlsxOps, readXlsx, XlsxEditError, type XlsxEditOp } from "../../files/xlsx-edit.js";
import {
  compareParagraphs,
  summarizeParagraphCompare,
  type ParagraphCompareEntry,
} from "../../files/paragraph-compare.js";
import {
  resolveAgentImageInput,
  sniffImageMime,
  type AgentImageDeps,
  type ResolvedAgentImageInput,
} from "./agent-image-input.js";
import {
  SlidesVisualReviewer,
} from "../../slides-visual-review/review.js";

/**
 * Agent 写 Office：Word（受限 HTML）、PPT（pptx skill 脚本一次性整册生成）、Excel
 * （sheets→rows）三个工具，经桌面 office-bridge 生成真实文件并走
 * file-imports 入库，产物在文件库可见（Room 已删除，不再有 Room 投影）。
 * - Word：隐藏 GenOffice docs view（HTML 子集与 vendored
 *   apps/docs/src/renderer/ai/protocol.ts 的 HTML_RULES 一致）。
 * - PPT：slides_create 带整册 pptxgenjs 脚本（设计方法以主 Agent 系统提示词内联的
 *   pptx skill 为准），桌面 vm 沙箱执行产出 .pptx（apply_theme.js 由网关从 agents
 *   目录读取随请求带下）。文件入库后自动打开；修订重走 slides_create（同 runId 进
 *   同一文件版本链）。
 * - Excel：主进程直接拼标准 OOXML（jszip，inline string）。
 * 编辑：PPT 走 slides_read/edit（文件需在 Room 产物库打开为可编辑实例；
 * 编辑事务实时重绘在打开的视图上，保存自动回填版本链）。
 * Word/Excel 走 office_edit / sheets_read+sheets_edit（文本级/单元格级修改）：
 * 网关读当前版本字节 → 改字节 → 桌面端覆盖工作副本、回填版本链并重开视图。
 * 只支持用户已经以可编辑方式打开的文件；有未保存修改时拒绝写回。
 * - Word 活文档通道（word_agent_read/edit/ops/illustration）：按 fileId 直通
 *   桌面端的 GenOffice docs 编辑器，不需要文件已在界面上打开（主进程用隐藏
 *   编辑器 headless 打开并静默保存）；网关只传元数据/工具调用，不搬 docx 字节。
 * - Excel 活工作簿通道（sheets_agent_read/edit）：同样按 fileId 直通桌面端的
 *   GenOffice sheets 编辑器，不需要文件已在界面上打开（桌面端用隐藏工作簿
 *   headless 打开并静默保存）；网关只传元数据/工具调用，不搬 xlsx 字节。
 */

const MAX_HTML_LENGTH = 400_000;
const MAX_SLIDES_PAGES = 24;
export const MAX_PAGE_SPEC_LENGTH = 80_000;
const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLS = 50;
const MAX_CELL_LENGTH = 3000;
/** 单次 Agent 编辑接受的源文件上限：再大就不适合走 base64 桥，直接拒绝。 */
const MAX_EDIT_BYTES = 25 * 1024 * 1024;
/** word_agent_ops 单次事务的 op 数上限（与 word_agent_edit 的 calls 上限一致）。 */
const MAX_AGENT_OPS = 50;
/** word_compare：LCS 对齐单元上限（左段数 × 右段数），超出直接拒绝，别把网关内存打满。 */
const MAX_COMPARE_CELLS = 4_000_000;
/** word_compare 单次返回的差异条目上限与默认值。 */
const MAX_COMPARE_ENTRIES = 500;
const DEFAULT_COMPARE_ENTRIES = 200;
/** 对比条目单侧文本截断（上下文预算）；summary 计数不受截断影响。 */
const MAX_COMPARE_TEXT = 1_500;

/** `office_edit`/`sheets_edit` 需要的最小文件访问面（FilesService 的结构子集）。 */
export interface OfficeFileAccess {
  catalogEntry(fileEntryId: string): {
    id: string;
    originalName: string;
    displayName: string | null;
    currentVersionId: string | null;
    contentHash: string;
  } | null;
  catalogContentOf(fileEntryId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null>;
}

/**
 * 宿主生图/读图端口（word_agent_illustration 用）：生成走 ai-relay 生图中转，
 * 字节按内容哈希进图片对象库（与 PPT 配图同一套 CAS）。未注入时工具不暴露。
 */
export interface DocumentIllustrationPorts {
  generate(prompt: string): Promise<{ contentHash: string }>;
  read(contentHash: string): Promise<{ buffer: Buffer; mime: string } | null>;
}

type OfficeAgentToolResultRow = NonNullable<OfficeAgentToolsResult["results"]>[number];

/**
 * word_agent_edit 的图片入参预处理：insert_image_base64 的 path/url 由网关
 * 读成字节（模型只给路径/链接，不搬 base64）。单条解析失败只生成该调用的
 * 错误结果，不拖垮同批其他调用。
 */
async function prepareWordAgentToolCalls(
  calls: OfficeAgentToolCall[],
  imageDeps?: AgentImageDeps,
): Promise<{
  forwarded: OfficeAgentToolCall[];
  failures: Map<string, OfficeAgentToolResultRow>;
}> {
  const forwarded: OfficeAgentToolCall[] = [];
  const failures = new Map<string, OfficeAgentToolResultRow>();
  for (const call of calls) {
    if (call.name !== "insert_image_base64") {
      forwarded.push(call);
      continue;
    }
    try {
      const resolved: ResolvedAgentImageInput = await resolveAgentImageInput(call.input ?? {}, imageDeps);
      forwarded.push({ ...call, input: { ...resolved } });
    } catch (error) {
      failures.set(call.id, {
        id: call.id,
        name: call.name,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }
  return { forwarded, failures };
}

/** 按原始调用顺序合并网关侧失败行与 bridge 执行结果。 */
function mergeAgentToolResults(
  calls: OfficeAgentToolCall[],
  failures: Map<string, OfficeAgentToolResultRow>,
  bridgeResults: OfficeAgentToolResultRow[],
): OfficeAgentToolResultRow[] {
  const byId = new Map(bridgeResults.map((row) => [row.id, row]));
  const merged: OfficeAgentToolResultRow[] = [];
  for (const call of calls) {
    const failure = failures.get(call.id);
    if (failure) {
      merged.push(failure);
      continue;
    }
    const row = byId.get(call.id);
    if (row) merged.push(row);
  }
  return merged;
}

/**
 * apply_operations 的 output 是渲染层拼好的逐条结果文本；若是 JSON，额外以结构化
 * `result` 透传，模型不必自己解析字符串（不是 JSON 就原样只给 output）。
 */
function parseAgentOpsOutput(output: string | undefined): unknown {
  if (!output) return null;
  const text = output.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** word_agent_ops 里需要宿主取图片字节的 op（与 word_agent_edit 的 insert_image_base64 同一取图入口）。 */
const AGENT_OPS_IMAGE_SOURCE_OPS = new Set([
  "object.image.replace",
  "headerFooter.insertImage",
]);

/**
 * word_agent_ops 的图片入参预处理：`object.image.replace` 允许模型给
 * path（本地图片绝对路径）/ url（公网图片）/ base64，网关统一解析成渲染端契约的
 * `{base64, mime}` 并删掉 path/url —— 模型永远不必把图片字节抄进 ops。
 *
 * 解析失败时返回一条 per-call 失败结果（整批不下发/不落盘），而不是把未解析的
 * path 转发给渲染端（渲染端只认 base64）。dryRun 同样解析：坏来源在计划阶段就该暴露。
 */
async function prepareWordAgentOps(
  ops: unknown[],
  imageDeps?: AgentImageDeps,
): Promise<{
  forwarded: unknown[];
  failure: OfficeAgentToolResultRow | null;
}> {
  const forwarded: unknown[] = [];
  for (const [index, op] of ops.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      forwarded.push(op);
      continue;
    }
    const record = op as Record<string, unknown>;
    const opName = typeof record.op === "string" ? record.op : "";
    const carriesSource = AGENT_OPS_IMAGE_SOURCE_OPS.has(opName)
      && (record.path !== undefined
        || record.url !== undefined
        || record.base64 !== undefined
        || record.fileId !== undefined);
    if (!carriesSource) {
      forwarded.push(op);
      continue;
    }
    const source: Record<string, unknown> = {};
    if (record.path !== undefined) source.path = record.path;
    if (record.url !== undefined) source.url = record.url;
    if (record.fileId !== undefined) source.fileId = record.fileId;
    if (record.base64 !== undefined) source.base64 = record.base64;
    try {
      const resolved: ResolvedAgentImageInput = await resolveAgentImageInput(source, imageDeps);
      const { path: _path, url: _url, base64: _base64, mime: _mime, fileId: _fileId, ...rest } = record;
      forwarded.push({ ...rest, base64: resolved.base64, mime: resolved.mime });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        forwarded: [],
        failure: {
          id: "ops-1",
          name: "apply_operations",
          output: `ops[${index}] ${opName} 的图片来源无法解析：${message}`,
          isError: true,
        },
      };
    }
  }
  return { forwarded, failure: null };
}

/** slides-builder 子代理独占的 4 个 PPT 工具名：主 Agent 工具面按此剔除（单一事实源）。 */
export const SLIDES_TOOL_NAMES = [
  "slides_create",
  "slides_read",
  "slides_edit",
] as const;

const HTML_GUIDE = "内容用受限 HTML 片段表达，只允许这些标签："
  + "h1 h2 h3 h4 h5 h6 p ul ol li strong em u s a br table thead tbody tr th td pre code blockquote。"
  + "表格首行用 th，单元格只放纯文本（可用 br 分行），不支持嵌套表格和合并单元格；"
  + "代码示例用 pre，引用用 blockquote；长内容用 h2/h3 分节组织。"
  + "不要包含 html/body 标签、markdown 代码围栏或任何解释性文字。";

/** Word 配图风格提示：报告内嵌示意图，扁平干净、无文字（生图模型画中文标签常出乱码）。 */
const ILLUSTRATION_PROMPT_SUFFIX = "。画面风格：扁平化矢量示意图/插画，简洁干净，主体清晰，画面中不要出现任何文字或字母";

/**
 * pptx skill 的 apply_theme.js 源码：随 agents 目录打包分发（copy-migrations.mjs 拷到
 * dist/agents），网关读取后随生成请求带给桌面执行器——桌面不感知 agents 目录布局，单一事实源。
 */
let applyThemeJsCache: string | null | undefined;
function applyThemeJsSource(): string | null {
  if (applyThemeJsCache === undefined) {
    try {
      applyThemeJsCache = readFileSync(
        join(bundledAgentDefinitionsDir(), "main", "skills", "pptx", "scripts", "apply_theme.js"),
        "utf8",
      );
    } catch {
      applyThemeJsCache = null;
    }
  }
  return applyThemeJsCache;
}

const SHEETS_GUIDE = "数据用 sheets→rows 的二维数组表达：每个工作表 {\"name\":\"表名(可选,≤31字符)\",\"rows\":[[单元格…],…]}，"
  + `单元格是 string | number | boolean | null（数字用 JSON number，不要写成带引号的字符串；null/缺省留空）。`
  + "每个表的首行会被当作表头（自动加粗、冻结、列宽自适应）。"
  + `限制：最多 ${MAX_SHEETS} 个表、每表 ${MAX_ROWS} 行 × ${MAX_COLS} 列、单元格文本 ≤ ${MAX_CELL_LENGTH} 字符。`
  + "不要输出 markdown 表格；一个主题一张表，列名放首行。";

function idempotencyKey(prefix: string, runId: string, title: string): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify([runId, title]), "utf8").digest("hex")}`;
}

function optionalFileName(args: Record<string, unknown>, extension: string): string | null {
  const raw = args.fileName;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const fileName = raw.trim().slice(0, 120);
  if (!fileName.toLowerCase().endsWith(extension)) {
    throw new Error(`INVALID_REQUEST: fileName 必须以 ${extension} 结尾`);
  }
  return fileName;
}

/** 骨架页：中性占位版式（演示标题 + 首页标题），旧 slides_draft 子代理管线仍消费。 */
export function skeletonPageSpec(deckTitle: string, pageTitle: string, index: number, total: number): string {
  return JSON.stringify({
    background: "#F5F6F8",
    elements: [
      { type: "shape", shape: "rect", x: 80, y: 64, w: 48, h: 6, fill: "#C6CBD4" },
      {
        type: "text", x: 80, y: 96, w: 1120, h: 40,
        paragraphs: [{ runs: [{ text: deckTitle, sizePt: 16, bold: true, color: "#6B7280" }] }],
      },
      {
        type: "text", x: 80, y: 300, w: 1120, h: 84,
        paragraphs: [{ runs: [{ text: pageTitle, sizePt: 40, bold: true, color: "#1F2937" }] }],
      },
      {
        type: "text", x: 80, y: 622, w: 1120, h: 24,
        paragraphs: [{ runs: [{ text: `第 ${index + 1} / ${total} 页 · 待填充`, sizePt: 12, color: "#9CA3AF" }] }],
      },
    ],
  });
}

function normalizeSheets(sheets: unknown): OfficeSheetBridgeInput[] {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error("INVALID_REQUEST: sheets 必须是非空数组");
  }
  if (sheets.length > MAX_SHEETS) throw new Error(`INVALID_REQUEST: 工作表数量超过上限（${MAX_SHEETS}）`);
  return sheets.map((sheet, index) => {
    if (!sheet || typeof sheet !== "object" || !Array.isArray((sheet as { rows?: unknown }).rows)) {
      throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表缺少 rows 二维数组`);
    }
    const rows = (sheet as { rows: unknown[] }).rows;
    if (rows.length === 0) throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表 rows 为空`);
    if (rows.length > MAX_ROWS) throw new Error(`INVALID_REQUEST: 第 ${index + 1} 个工作表行数超过上限（${MAX_ROWS}）`);
    const normalized = rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) throw new Error(`INVALID_REQUEST: 第 ${rowIndex + 1} 行不是数组`);
      if (row.length > MAX_COLS) throw new Error(`INVALID_REQUEST: 第 ${rowIndex + 1} 行列数超过上限（${MAX_COLS}）`);
      return row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
        if (typeof cell === "boolean") return cell;
        if (typeof cell === "string") return cell.slice(0, MAX_CELL_LENGTH);
        return String(cell).slice(0, MAX_CELL_LENGTH);
      });
    });
    const rawName = (sheet as { name?: unknown }).name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 31) : null;
    return { name, rows: normalized };
  });
}

export function officePlugin(
  bridge: OfficeBridgeClient,
  /** PPT 逐页进度上报器（只报不定）：未注入时落页无进度广播。 */
  slidesProgress?: SlidesPageProgressReporter | null,
  /** 落页视觉复检（preset 形态）：未注入或 VLM 未配置时复检整体跳过。 */
  visualReviewer?: SlidesVisualReviewer | null,
  /** 文件库访问（惰性）：注入后才暴露 office_edit / sheets_read / sheets_edit。 */
  files?: () => OfficeFileAccess | null,
  /** 宿主生图端口：注入后才暴露 word_agent_illustration。 */
  illustration?: DocumentIllustrationPorts | null,
): DocumentCapabilityPlugin {
  const officeCreate: DocumentCapabilityTool = {
    name: "office_create",
    title: "生成 Word 文档",
    description: "用本地 Word 引擎生成一份新的 .docx 文档并保存到文件库，"
      + "生成的是真实 Word 排版（表格、列表、代码块、引用），适合正式报告、交付文档、需要 Word 排版的内容。"
      + "普通速记、笔记、随手总结仍用文档创建工具（markdown），不要用本工具。"
      + `title 用作文档标题与默认文件名（<title>.docx，可用 fileName 覆盖）。${HTML_GUIDE}`
      + "生成完成后桌面端会自动打开预览；在回复中告知文件名即可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "文档标题（同时是默认文件名）" },
        html: { type: "string", minLength: 1, maxLength: MAX_HTML_LENGTH, description: "文档正文（受限 HTML 片段）" },
        fileName: { type: "string", minLength: 5, maxLength: 120, description: "可选文件名，必须以 .docx 结尾" },
        format: { type: "string", enum: ["docx"], description: "文档格式，当前仅支持 docx" },
      },
      required: ["title", "html"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const html = stringArg(args, "html");
      if (html.length > MAX_HTML_LENGTH) {
        throw new Error(`INVALID_REQUEST: html 超过长度上限（${MAX_HTML_LENGTH} 字符），请拆分内容`);
      }
      const format = args.format === undefined ? "docx" : args.format;
      if (format !== "docx") throw new Error("INVALID_REQUEST: 目前仅支持 docx 格式");
      const fileName = optionalFileName(args, ".docx");
      // 同 run 同标题幂等：桌面侧以 sourceKey=agent:word:<key> 去重/续版本链。
      const result = await bridge.generate({
        title,
        html,
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-word", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "docx",
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        // Room 已删除：roomId 恒为空、roomRoutingRequested 恒为 false，字段保留兼容旧消费方。
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const slidesCreate: DocumentCapabilityTool = {
    name: "slides_create",
    title: "创建 PPT",
    description: "按系统提示词内联 pptx skill（<skill name=\"pptx\">）的方法，写一个完整的 pptxgenjs 构建脚本，一次性生成整册 .pptx 并保存到文件库。"
      + "写脚本前必须先调用 workspace_files_list(kind=image) 查看工作区图片素材：有与主题相关的图就用其 materialRef（everroom-material://…）作为 addImage 的 path，不要凭空不配图。"
      + "脚本硬约定（其余设计规范一律以 skill 全文为准）：CommonJS 写法（require()，不要 import 语法，环境不装包）；"
      + "require 白名单只有 'pptxgenjs' 与 'pptx/apply_theme.js'（需要结构化 deck 主题色时用后者，路径相对当前目录写 \"deck.pptx\"）；"
      + "先设 pres.layout = \"LAYOUT_WIDE\"（13.33×7.5 英寸），最后一步必须 await pres.writeFile({ fileName: \"deck.pptx\" })；"
      + "页数 1~" + MAX_SLIDES_PAGES + "；图片 path 用 http(s) 直链或 everroom-material://（workspace_files_list 返回的 materialRef），无素材不硬凑图。"
      + "本环境没有命令行与 python：skill 的 QA 章节里脚本化校验/渲染不可用——生成结果带 warnings，内容核查用 slides_read，局部修改用 slides_edit。"
      + "title 用作默认文件名（<title>.pptx，可用 fileName 覆盖）。同一会话内修订脚本重新调用本工具：同内容去重、新内容进同一文件的版本链（不产生新文件）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "演示标题（同时是默认文件名）" },
        script: {
          type: "string",
          minLength: 10,
          maxLength: 500_000,
          description: "整册 pptxgenjs 构建脚本（CommonJS require 写法）：从 new pptxgen() 到 await pres.writeFile({ fileName: \"deck.pptx\" }) 的完整生成代码，设计遵循内联 pptx skill",
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .pptx 结尾" },
      },
      required: ["title", "script"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const script = stringArg(args, "script");
      if (!script.includes("writeFile")) {
        throw new Error("INVALID_REQUEST: 脚本最后一步必须 await pres.writeFile({ fileName: \"deck.pptx\" })");
      }
      const fileName = optionalFileName(args, ".pptx");
      const result = await bridge.generate({
        title,
        format: "pptx",
        script,
        applyThemeJs: applyThemeJsSource(),
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-slides", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      visualReviewer?.forgetDeck(result.fileEntryId);
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "pptx",
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
        hint: "文件已生成并自动打开。核查内容用 slides_read（fileId=" + result.fileEntryId + " 或 \"active\"）；局部修改用 slides_edit；结构性问题修订脚本后重新调用 slides_create（同一会话会进同一文件的版本链，不产生新文件）。",
      });
    },
  };

  const sheetsCreate: DocumentCapabilityTool = {
    name: "sheets_create",
    title: "生成 Excel 表格",
    description: "生成本地排版的一份新 .xlsx 电子表格并保存到文件库，"
      + "适合数据清单、预算、对比表、统计汇总等结构化数据。title 用作默认文件名（<title>.xlsx，可用 fileName 覆盖）。"
      + `sheets 是工作表数组。${SHEETS_GUIDE}`
      + "生成完成后桌面端会自动打开预览；在回复中告知文件名与表结构即可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "表格标题（同时是默认文件名）" },
        sheets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SHEETS,
          description: "工作表数组，每项 {name?, rows}",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 31, description: "工作表名（可选）" },
              rows: {
                type: "array",
                minItems: 1,
                description: "二维数组；每行是单元格数组（string|number|boolean|null）；首行视为表头",
                items: { type: "array", items: {} },
              },
            },
            required: ["rows"],
          },
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .xlsx 结尾" },
      },
      required: ["title", "sheets"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const title = stringArg(args, "title").trim().slice(0, 120);
      const sheets = normalizeSheets(args.sheets);
      const fileName = optionalFileName(args, ".xlsx");
      const result = await bridge.generate({
        title,
        format: "xlsx",
        sheets,
        roomId: context.roomId,
        workspaceId: context.workspaceId ?? null,
        fileName,
        idempotencyKey: idempotencyKey("agent-sheets", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "xlsx",
        sheets: sheets.length,
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const slidesRead: DocumentCapabilityTool = {
    name: "slides_read",
    title: "读取 PPT 大纲与操作词汇",
    description: "读取一份文件库中的 .pptx 产物的大纲与可编辑操作词汇表。"
      + "fileId 缺省（或 \"active\"）= 用户当前打开的那个 PPT；传显式 fileEntryId 时未打开的 PPT 会自动以可编辑方式打开（应用重启后同会话也能继续改）。"
      + "大纲列出每页的元素（id | 类型 | 文本摘要），是编辑时定位元素的唯一依据；"
      + "opVocabulary 列出 slides_edit 可用的全部操作及其签名。"
      + "文件不存在会报错并列出当前打开的 Office 文件；editable=false 表示只读打开（能读大纲，"
      + "要编辑需用户在文件库重新以可编辑方式打开）。"
      + "编辑前先读本工具，之后按大纲里的元素 id 发编辑事务。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；缺省或 \"active\" = 当前打开的那个 PPT；显式 id 未打开会自动打开" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const rawFileId = args.fileId;
      const fileId = typeof rawFileId === "string" && rawFileId.trim() ? rawFileId.trim() : "active";
      const info = await bridge.readDeck(fileId);
      if (!info.outline) throw new Error("OFFICE_EDIT_FAILED: 桌面端未返回大纲");
      return success({
        fileId,
        outline: info.outline,
        opVocabulary: info.opVocabulary,
        ...(info.editable !== undefined ? { editable: info.editable } : {}),
        nextAction: info.editable === false ? "guide_reopen_editable" : "edit",
      });
    },
  };

  const slidesEdit: DocumentCapabilityTool = {
    name: "slides_edit",
    title: "编辑已打开的 PPT",
    description: "向一份文件库中的 .pptx 产物应用一个操作事务（ops 数组，原子生效）。"
      + "fileId 可用 \"active\"（当前打开的那个）或显式 fileEntryId（未打开会自动以可编辑方式打开）。"
      + "常用操作：setText/setFont/setFill 改已有元素，addElement/addSlideWithLayout 新增，"
      + "deleteElement/deleteSlide 删除，moveSlide 调序，findReplace 全稿替换，setNotes 备注页；"
      + "完整词汇与签名见 slides_read 返回的 opVocabulary（每项自带用法，失败信息也会带用法提示）。"
      + "元素用 read 大纲里的 id 定位（target.slide 从 0 计）；一次事务 1~50 个 op。"
      + "编辑会实时显示在打开的视图上并自动保存（版本链 +1）。返回新 outline，可直接链式编辑。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；\"active\" = 当前打开的那个 PPT；显式 id 未打开会自动打开" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "操作数组，每项 {op, target?, …字段}；默认整体原子（任一失败全部不生效），isolation=per_op 可放开",
          items: { type: "object", additionalProperties: true },
        },
        isolation: { type: "string", enum: ["atomic", "per_op"], description: "atomic（默认）：任一失败全部回滚；per_op：成功的保留" },
        dryRun: { type: "boolean", description: "true 只校验并返回计划，不落盘" },
      },
      required: ["fileId", "ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const fileId = stringArg(args, "fileId").trim();
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组（每项一个操作对象）");
      }
      const isolation =
        args.isolation === "per_op" ? "per_op" : args.isolation === "atomic" ? "atomic" : undefined;
      const result = await bridge.editDeck({
        fileId,
        ops: args.ops,
        ...(isolation ? { isolation } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun === true } : {}),
      });
      if (!result.ok) throw new Error(`OFFICE_EDIT_FAILED: ${result.error ?? "桌面端编辑失败"}`);
      return success({
        fileId,
        applied: result.applied === true,
        ...(result.dryRun ? { dryRun: true, plan: result.plan ?? [] } : {}),
        ...(result.records ? { records: result.records } : {}),
        ...(result.failures?.length ? { failures: result.failures } : {}),
        ...(result.saved !== undefined ? { saved: result.saved } : {}),
        ...(result.saveError ? { saveError: result.saveError } : {}),
        ...(result.outline ? { outline: result.outline } : {}),
        nextAction: result.applied === true ? "report_result" : "fix_ops_and_retry",
      });
    },
  };

  // ── 改写「用户正开着的那份」Word/Excel ────────────────────────

  type OfficeCatalogEntry = NonNullable<ReturnType<OfficeFileAccess["catalogEntry"]>>;

  /**
   * 元数据级目标解析（不读文件字节）：word_agent_* 走桌面端隐藏编辑器，
   * 只需要 fileId + 类型校验，把整份 docx 读进网关既慢又没必要（大文档 base64
   * 白耗内存，且 headless 编辑根本不经过字节通道）。字节级编辑（office_edit /
   * sheets_*）仍用下面的 resolveEditableTarget。
   */
  async function resolveOfficeTarget(
    args: Record<string, unknown>,
    context: { activeFile?: { fileId: string } },
  ): Promise<{ fileId: string; entry: OfficeCatalogEntry; access: OfficeFileAccess }> {
    const access = files?.();
    if (!access) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");
    const explicit = typeof args.fileId === "string" ? args.fileId.trim() : "";
    const fileId = explicit || context.activeFile?.fileId || "";
    if (!fileId) {
      throw new Error("NO_ACTIVE_FILE: 当前没有指定文件；请显式传 fileId（可用 file_search 按文件名查找）");
    }
    const entry = access.catalogEntry(fileId);
    if (!entry) {
      throw new Error(`FILE_NOT_FOUND: ${fileId} 不在文件库中（可能仍在导入或已被删除）`);
    }
    if (!entry.contentHash) {
      throw new Error(`FILE_CONTENT_UNAVAILABLE: 《${entry.displayName ?? entry.originalName}》还没有可用的文件版本`);
    }
    return { fileId, entry, access };
  }

  /**
   * 图片来源解析端口：模型说“刚上传的 logo / 之前生成的那张图”时只拿得到
   * fileId，宿主按 fileId 取文件库当前版本字节（非图片/不存在返回 null）。
   */
  const agentImageDepsFor = (access: OfficeFileAccess): AgentImageDeps => ({
    readLibraryFile: async (fileId) => (await access.catalogContentOf(fileId))?.buffer ?? null,
  })

  /** 字节级目标解析：读当前版本字节，供 office_edit / sheets_* 在网关侧改字节。 */
  async function resolveEditableTarget(
    args: Record<string, unknown>,
    context: { activeFile?: { fileId: string } },
  ): Promise<{
    fileId: string;
    entry: OfficeCatalogEntry;
    buffer: Buffer;
  }> {
    const target = await resolveOfficeTarget(args, context);
    const content = await target.access.catalogContentOf(target.fileId);
    if (!content) throw new Error(`FILE_CONTENT_UNAVAILABLE: 读取《${target.entry.originalName}》失败`);
    if (content.buffer.byteLength > MAX_EDIT_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: 文件 ${(content.buffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过单次编辑上限（25MB）`,
      );
    }
    return { fileId: target.fileId, entry: target.entry, buffer: content.buffer };
  }

  /** 对比/导出用的字节读取：只要大小上限与可读错误，不要求文件已在界面上打开。 */
  async function readTargetBuffer(
    access: OfficeFileAccess,
    fileId: string,
    entry: OfficeCatalogEntry,
  ): Promise<Buffer> {
    const content = await access.catalogContentOf(fileId);
    if (!content) throw new Error(`FILE_CONTENT_UNAVAILABLE: 读取《${entry.originalName}》失败`);
    if (content.buffer.byteLength > MAX_EDIT_BYTES) {
      throw new Error(
        `FILE_TOO_LARGE: 《${entry.originalName}》${(content.buffer.byteLength / 1024 / 1024).toFixed(1)}MB`
        + " 超过处理上限（25MB）",
      );
    }
    return content.buffer;
  }

  function applyFailureMessage(title: string, result: OfficeApplyBytesResult): string {
    switch (result.reason) {
      case "not_open":
        return `FILE_NOT_OPEN: 《${title}》没有以可编辑方式打开。请用户在文件页打开它后再让我修改（不要假装已经改好）。`;
      case "not_editable":
        return `FILE_READONLY: 《${title}》是只读打开的，或该格式不支持在线编辑。请用户以可编辑方式重新打开。`;
      case "unsaved":
        return `FILE_UNSAVED: 《${title}》里有未保存的修改。请用户先保存（⌘S），保存后再重试这次修改。`;
      case "conflict":
        return `FILE_CONFLICT: 《${title}》在生成修改期间又被保存过，本次修改没有落盘。重新读取文档后再改一次。`;
      default:
        return `FILE_APPLY_FAILED: ${result.message ?? "桌面端写回失败"}`;
    }
  }

  const officeRead: DocumentCapabilityTool = {
    name: "office_read",
    title: "读取当前打开的 Word 段落",
    description: "按文档顺序列出 .docx 的段落纯文本（0 基序号 + 段落样式），fileId 省略 = 用户当前浏览的文件。"
      + "office_edit 的 find 必须照抄这里的段落原文：file_read 返回的是 Markdown（带 # 与 ** 标记），"
      + "直接拿 Markdown 文本去 find 会匹配不上。写之前先 office_read。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        maxParagraphs: { type: "integer", minimum: 1, maximum: 1000, description: "最多返回多少段（默认 300）" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: office_read 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      const paragraphs = await readDocxParagraphs(target.buffer);
      const limit = typeof args.maxParagraphs === "number"
        ? Math.min(Math.max(args.maxParagraphs, 1), 1000)
        : 300;
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        totalParagraphs: paragraphs.length,
        paragraphs: paragraphs.slice(0, limit).map((paragraph) => ({
          index: paragraph.index,
          text: paragraph.text.slice(0, 2_000),
          ...(paragraph.style ? { style: paragraph.style } : {}),
        })),
        truncated: paragraphs.length > limit,
      });
    },
  };

  const officeEdit: DocumentCapabilityTool = {
    name: "office_edit",
    title: "修改当前打开的 Word 文档",
    description: "直接修改用户当前浏览的 .docx（或显式 fileId 指定的 .docx），改完立即落盘并重开预览。"
      + "按段落文本定位，不要求 blockId：先用 office_read 看段落原文（不要用 file_read 的 Markdown 标记），再按原文片段构造 ops。"
      + "只支持文本级编辑，保留原有段落样式/编号/分页："
      + "replace_text（{find, replace, all?} 段内子串替换，all=true 替换全文所有匹配）；"
      + "replace_paragraph（{find, text} 整段替换，find 必须唯一命中一个段落）；"
      + "insert_paragraph_after（{find, text} 在锚点段后插入新段落，沿用锚点段格式）；"
      + "append_paragraph（{text} 文末追加）；delete_paragraph（{find} 删除整段）。"
      + "一次最多 20 条，按数组顺序执行；任一条失败整批不落盘。"
      + "不支持跨段落查找、改图片/表格结构/页眉页脚；整段替换后段内混合格式会统一。"
      + "文件必须已经由用户以可编辑方式打开，且有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id（fileEntryId）；省略 = 用户当前正在浏览的文件" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "编辑操作数组（replace_text / replace_paragraph / insert_paragraph_after / append_paragraph / delete_paragraph）",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["type"],
            properties: { type: { type: "string" } },
          },
        },
      },
      required: ["ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(
          `INVALID_TARGET: office_edit 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`
          + (/\.(xlsx)$/i.test(target.entry.originalName) ? "。表格请改用 sheets_edit" : ""),
        );
      }
      let outcome: Awaited<ReturnType<typeof applyDocxOps>>;
      try {
        outcome = await applyDocxOps(target.buffer, args.ops as DocxEditOp[]);
      } catch (error) {
        if (error instanceof DocxEditError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const applied = await bridge.applyFileBytes({
        fileId: target.fileId,
        bytesBase64: outcome.buffer.toString("base64"),
        expectedContentHash: target.entry.contentHash,
      });
      if (!applied.ok) {
        throw new Error(applyFailureMessage(target.entry.displayName ?? target.entry.originalName, applied));
      }
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        applied: true,
        changes: outcome.changes,
        ...(applied.version !== undefined ? { version: applied.version } : {}),
        nextAction: "report_result",
        hint: "修改已写入文件并更新版本；回复里只说明改了什么，不要复述整段正文。",
      });
    },
  };

  const sheetsRead: DocumentCapabilityTool = {
    name: "sheets_read",
    title: "读取当前打开的 Excel 表格",
    description: "读取 .xlsx 的工作表清单、单元格值与公式（fileId 省略 = 用户当前浏览的文件）。"
      + "先读再改：sheets_edit 的单元格地址、行号都以这里返回的结构为准。"
      + "range 用 A1 或 A1:D20；缺省读已用区域的前 200 行 × 50 列。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        sheet: { type: "string", minLength: 1, description: "工作表名；省略读汇总 + 第一个工作表" },
        range: { type: "string", minLength: 1, description: "A1 或 A1:D20；省略读已用区域" },
        maxRows: { type: "integer", minimum: 1, maximum: 5000, description: "最多返回多少行（默认 200）" },
        maxColumns: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少列（默认 50）" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_read 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      const read = await readXlsx(target.buffer, {
        ...(typeof args.sheet === "string" && args.sheet.trim() ? { sheet: args.sheet.trim() } : {}),
        ...(typeof args.range === "string" && args.range.trim() ? { range: args.range.trim() } : {}),
        ...(typeof args.maxRows === "number" ? { maxRows: args.maxRows } : {}),
        ...(typeof args.maxColumns === "number" ? { maxColumns: args.maxColumns } : {}),
      });
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        ...read,
      });
    },
  };

  const sheetsEdit: DocumentCapabilityTool = {
    name: "sheets_edit",
    title: "修改当前打开的 Excel 表格",
    description: "直接修改用户当前浏览的 .xlsx（或显式 fileId），改完立即落盘并重开预览。"
      + "先用 sheets_read 确认工作表名、单元格地址与现有数据，再构造 ops（按数组顺序执行，最多 50 条，任一条失败整批不落盘）："
      + "set_cells（{sheet?, cells:[{address, value?, formula?, numberFormat?}]}，formula 不带等号）；"
      + "set_range（{sheet?, start, rows: [[...]]}，从 start 向右/向下铺开）；"
      + "insert_rows / delete_rows（{sheet?, start, count?}，行号从 1 起）；"
      + "add_sheet / rename_sheet / delete_sheet。"
      + "写入会保留大多数样式、合并单元格、列宽与公式，但图表/图片等对象可能退化；"
      + "文件必须有未保存修改时会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "编辑操作数组（set_cells / set_range / insert_rows / delete_rows / add_sheet / rename_sheet / delete_sheet）",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["type"],
            properties: { type: { type: "string" } },
          },
        },
      },
      required: ["ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组");
      }
      const target = await resolveEditableTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(
          `INVALID_TARGET: sheets_edit 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`
          + (/\.docx$/i.test(target.entry.originalName) ? "。Word 文档请改用 office_edit" : ""),
        );
      }
      let outcome: Awaited<ReturnType<typeof applyXlsxOps>>;
      try {
        outcome = await applyXlsxOps(target.buffer, args.ops as XlsxEditOp[]);
      } catch (error) {
        if (error instanceof XlsxEditError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const applied = await bridge.applyFileBytes({
        fileId: target.fileId,
        bytesBase64: outcome.buffer.toString("base64"),
        expectedContentHash: target.entry.contentHash,
      });
      if (!applied.ok) {
        throw new Error(applyFailureMessage(target.entry.displayName ?? target.entry.originalName, applied));
      }
      return success({
        fileId: target.fileId,
        title: target.entry.displayName ?? target.entry.originalName,
        applied: true,
        changes: outcome.changes,
        ...(applied.version !== undefined ? { version: applied.version } : {}),
        nextAction: "report_result",
        hint: "修改已写入文件并更新版本；回复里只说明改了哪些单元格/工作表。",
      });
    },
  };

  // ── 活 Word/Excel 宿主执行器（渲染层 AI 工具直通：块级/富文本编辑 + propose_operations DSL）──

  const agentToolsFailureMessage = (title: string, message: string): string =>
    `《${title}》无法执行：${message}`;

  const wordAgentRead: DocumentCapabilityTool = {
    name: "word_agent_read",
    title: "读取任意 Word 的块结构与工具指南",
    description: "按 fileId 读取任意已入库 .docx 的活文档状态（不需要文件在界面上打开，后台编辑器可 headless 打开）："
      + "块列表（index|type|内容预览）、全文统计、文档状态（章节/页眉页脚/批注/域/引用等 documentState），"
      + "以及可用的编辑工具词汇表（insert_content/replace_blocks/apply_commands 等）、HTML 片段规则、命令指南与结构化操作指南（operationsGuide）。"
      + "块索引是 word_agent_edit / word_agent_ops 的定位依据：每次编辑后索引会变，需要最新索引时重新调用本工具。"
      + "只读打开的文件也能读。比 office_read 的段落列表更精确（含块类型/预览截断标记）。"
      + "fileId 省略 = 用户当前浏览的文件；要改的文件没打开时先用 file_search 按文件名定位 fileId。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveOfficeTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_read 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      try {
        const described = await bridge.describeAgentArtifact({
          kind: "docx",
          fileId: target.fileId,
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
        });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...described,
          hint: "用 context 里的块索引驱动 word_agent_edit 的工具调用；replace_blocks/insert_content 的 html 遵循 htmlRules。"
            + "表格/页面/批注/域/引用/修订等结构化操作按 operationsGuide 构造 ops，交给 word_agent_ops。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  const wordAgentEdit: DocumentCapabilityTool = {
    name: "word_agent_edit",
    title: "用文档 AI 工具链编辑任意 Word",
    description: "把 GenOffice Docs 的编辑器 AI 工具调用直接作用到任意已入库 .docx 上（按 fileId；不需要文件在界面上打开，"
      + "后台编辑器 headless 打开，编辑后静默保存并更新版本）。"
      + "先 word_agent_read 拿块索引与规则。可用工具（本环境不支持联网类工具）："
      + "get_document_context（刷新块列表）、read_blocks（读块全文）、"
      + "insert_content（{afterBlockIndex?, html} 插入）、replace_blocks（{startBlockIndex, endBlockIndex, html} 区间替换）、"
      + "apply_commands（格式/结构/查找替换/批处理，命令见 word_agent_read 返回的 commandsGuide）、"
      + "read_revisions / read_comments / reply_comment / resolve_comment（修订与评论）、"
      + "insert_chart / edit_chart（图表）、set_header_footer（页眉页脚，text 里 {PAGE}/{NUMPAGES} 是页码/总页数域，\n 分行）、"
      + "set_watermark（{text} 设置文字水印如 机密/草稿，text:null 移除；当前水印见 word_agent_read 的 watermark 字段）、"
      + "set_page_setup（{orientation/paperSize/margins(单位 twip, 1cm=567)/columns/pageColor/theme} 页面设置与主题；当前值见 pageSetup 字段）、"
      + "insert_image_base64（{fileId|path|url|base64, afterIndex?, maxWidthPx?, label?} 插图：文件库里的图片（用户刚上传/之前生成的）传 fileId（先用 file_search 定位），"
      + "本轮自己生成或用户给的本地文件传 path，公网图片传 url；网关直接读字节后注入，不需要也不允许把 base64 抄进工具参数）、"
      + "add_comment（{startIndex, endIndex?, text} 在块上建批注）、delete_comment（{id} 删整个批注线程）、"
      + "insert_shape（{prst, widthEmu?, heightEmu?, afterIndex?} 插入形状，prst 如 rect/roundRect/ellipse/triangle/star5/lineArrow）、"
      + "update_toc（{} 重建目录并回填真实页码）、"
      + "set_table_width（{blockIndex, widthPercent?/autoFit?} 调整表格宽度：widthPercent 10-100 按文本栏百分比收窄，"
      + "autoFit 'window' 撑满栏、'contents' 收缩到内容宽；用户说“表格太宽了/调窄一点”就用它）。"
      + "一次最多 50 条，按序执行；结果逐条返回（isError=true 表示该条失败，不影响已执行的其他条）。"
      + "表格/页面设置/批注/域/引用/修订等结构化操作用 word_agent_ops（ops DSL）更稳，本工具更适合块级内容与格式命令。"
      + "只有界面里正开着这份文档且有未保存修改时才会被拒绝（提示用户先保存）；没打开或 UI 隐藏时网关会在后台编辑器里打开它，"
      + "不需要请用户先打开或先保存。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "工具调用数组（{id, name, input}），name 必须是 word_agent_read 返回的 tools 之一",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name", "input"],
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
            },
          },
        },
      },
      required: ["calls"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.calls) || args.calls.length === 0) {
        throw new Error("INVALID_REQUEST: calls 必须是非空数组");
      }
      const target = await resolveOfficeTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_edit 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      try {
        const calls = args.calls as OfficeAgentToolCall[];
        // insert_image_base64 的 fileId/path/url 先由网关读成字节：模型只传来源。
        const prepared = await prepareWordAgentToolCalls(calls, agentImageDepsFor(target.access));
        const applied: OfficeAgentToolsResult = prepared.forwarded.length > 0
          ? await bridge.applyAgentArtifactTools({
            kind: "docx",
            fileId: target.fileId,
            roomId: context.roomId,
            workspaceId: context.workspaceId ?? null,
            calls: prepared.forwarded,
          })
          : { ok: true };
        const results = mergeAgentToolResults(calls, prepared.failures, applied.results ?? []);
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...applied,
          results,
          nextAction: "report_result",
          hint: results.some((row) => row.isError)
            ? "部分调用失败：读每条 output 修正后重试失败的调用；成功条目已生效，不要重复执行。"
            : "修改已生效并保存；回复里只说明改了什么。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  /**
   * 结构化操作通道：ops DSL 交给渲染层 `apply_operations` 统一执行（逐条隔离失败）。
   * 网关只做目标校验与转发，不解析 op 语义——op 词汇表由 word_agent_read 的
   * operationsGuide 下发（渲染层是唯一事实源，避免网关和编辑器双份定义漂移）。
   */
  const wordAgentOps: DocumentCapabilityTool = {
    name: "word_agent_ops",
    title: "对任意 Word 执行结构化操作（表格/页面/注释/域/引用/修订）",
    description: "把一组结构化操作（ops）作用到任意已入库 .docx 上（按 fileId；不需要文件在界面上打开，"
      + "后台编辑器 headless 打开，编辑后静默保存并更新版本）。"
      + "先 word_agent_read 读 operationsGuide（完整 op 列表与字段）和 documentState（章节/页眉页脚/批注/脚注/域/引用/修订现状），"
      + "按块索引定位对象。覆盖：表格（增删表格/行列/单元格、合并拆分、单元格内容与底色、列宽行高、边框、自适应）、"
      + "分页与页面设置、脚注与尾注、页码与域、行内/对象格式（字符样式、制表位、换行/分栏符、文本框/WordArt/公式/符号、图片环绕）、"
      + "对象操作（图片替换 object.image.replace / 裁剪 object.image.crop / 去背景 object.image.removeBackground、"
      + "形状层级 object.shape.zOrder、公式转换 object.equation.convert）、"
      + "页眉页脚图片（headerFooter.insertImage/removeImage/replaceImage）、程序化手绘（object.ink.add / object.ink.mark 画直线标注）、新建字符样式（format.createCharacterStyle）、"
      + "参考文献与交叉引用、修订接受/拒绝。op 词汇共 69 项 / 10 个域，以 word_agent_read 的 operationsGuide 为准。"
      + "图片类 op（object.image.replace / headerFooter.insertImage / replaceImage）的来源用 fileId（文件库图片，用户刚上传/之前生成的）、"
      + "本地 path 或公网 url；网关负责取字节，不要把 base64 写进 ops。"
      + "ops 1-50 条，按序执行、逐条隔离（一条失败不影响其他条）；dryRun=true 只校验并返回计划，不落盘。"
      + "高风险 op（review.accept/reject 全部修订、review.protect、review.encrypt）必须带 confirm: true，"
      + "调用前先向用户说明影响并取得明确同意；逐条修订 id 用 read_revisions 返回的 [rN]。"
      + "纯文字/段落/格式/插图仍可用 word_agent_edit。只有界面里正开着这份文档且有未保存修改时才会被拒绝（提示用户先保存）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: MAX_AGENT_OPS,
          description: "结构化操作数组，每项 {op, ...}；op 名称与字段见 word_agent_read 返回的 operationsGuide",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["op"],
            properties: { op: { type: "string", minLength: 1 } },
          },
        },
        dryRun: { type: "boolean", description: "true 只校验并返回计划，不落盘" },
      },
      required: ["ops"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        throw new Error("INVALID_REQUEST: ops 必须是非空数组（每项一个操作对象）");
      }
      if (args.ops.length > MAX_AGENT_OPS) {
        throw new Error(`INVALID_REQUEST: ops 一次最多 ${MAX_AGENT_OPS} 条，请分批执行`);
      }
      const invalidIndex = args.ops.findIndex((op) => !op || typeof op !== "object" || Array.isArray(op));
      if (invalidIndex >= 0) {
        throw new Error(
          `INVALID_REQUEST: ops[${invalidIndex}] 不是操作对象（每项应形如 {"op":"table.insertRow", …}）`,
        );
      }
      const target = await resolveOfficeTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_ops 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      const title = target.entry.displayName ?? target.entry.originalName;
      const dryRun = args.dryRun === true;
      // op 里的图片来源（fileId/path/url/base64）先由网关解析成字节：渲染端只认 {base64, mime}。
      const prepared = await prepareWordAgentOps(args.ops as unknown[], agentImageDepsFor(target.access));
      if (prepared.failure) {
        return success({
          fileId: target.fileId,
          title,
          ok: false,
          ...(dryRun ? { dryRun: true } : {}),
          ...prepared.failure,
          error: prepared.failure.output,
          nextAction: "fix_and_retry",
          hint: "ops 里有图片 op 的来源（path/url）无法读取：整批未下发也未落盘；"
            + "改用本地图片绝对路径 path 或公网图片 url 修正该 op 后重试。",
        });
      }
      try {
        const applied = await bridge.applyAgentArtifactTools({
          kind: "docx",
          fileId: target.fileId,
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
          calls: [{
            id: "ops-1",
            name: "apply_operations",
            input: { ops: prepared.forwarded, ...(dryRun ? { dryRun: true } : {}) },
          }],
        });
        const row = applied.results?.[0];
        // 单条 apply_operations 的成败：宿主级 error 或该调用 isError 都算失败；
        // 逐条 op 的失败明细在 output/result 里（渲染层已按 op 索引列出）。
        const failed = row?.isError === true || applied.ok === false;
        const failure = failed ? (row?.output || applied.error || "桌面端执行失败") : applied.error;
        const parsed = parseAgentOpsOutput(row?.output);
        return success({
          fileId: target.fileId,
          title,
          ok: !failed,
          ...(dryRun ? { dryRun: true } : {}),
          // 原样透传渲染层的单条结果（id/name/output/isError/mutated/summary，以及端侧附加字段）。
          ...(row ?? {}),
          // output 是 JSON 时再给一份结构化结果，模型不必自己解析字符串。
          ...(parsed !== null ? { result: parsed } : {}),
          ...(applied.version ? { version: applied.version } : {}),
          ...(failure ? { error: failure } : {}),
          nextAction: failed ? "fix_and_retry" : "report_result",
          hint: failed
            ? "读 error/output 里的逐条失败原因（含 op 索引/op 名），只重试失败的操作；已成功的操作已生效，不要重复执行。"
            : dryRun
              ? "这是 dryRun 计划，尚未落盘；确认无误后同参数去掉 dryRun 再调用一次。"
              : "操作已生效并保存；回复里只说明改了哪些对象。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(title, error instanceof Error ? error.message : String(error)));
      }
    },
  };

  /**
   * 段落级对比：纯网关侧读文件库当前版本（不依赖桌面端打开状态），
   * LCS 对齐语义与 GenOffice docs 的「审阅 → 比较」一致（同一位置删+增合并成 changed）。
   */
  const wordCompare: DocumentCapabilityTool = {
    name: "word_compare",
    title: "对比两份 Word 文档的段落差异",
    description: "逐段对比两份已入库 .docx 的当前版本（按段落纯文本做 LCS 对齐；同一位置的删除+新增合并为 changed），"
      + "回答“这两版改了什么 / 和模板差多少”。left = fileId（省略 = 用户当前浏览的文件），right = otherFileId（必填，"
      + "可用 file_search 按文件名查找）。不需要文件在界面上打开，也不经过桌面编辑器，纯文件库读取。"
      + "返回 summary（same/changed/added/removed/total 条目计数）与 entries（kind + left/right 文本）；"
      + "entries 默认最多 200 条、可调至 500，超出时 truncated=true（完整计数看 summary.total）。"
      + "只比较段落文本，不比较表格结构/图片/格式/页眉页脚；两份都必须是 .docx。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "左侧/基准文档 id；省略 = 当前正在浏览的文件" },
        otherFileId: { type: "string", minLength: 1, description: "右侧/对比文档 id（必填；可用 file_search 查找）" },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COMPARE_ENTRIES,
          description: `最多返回多少条差异（默认 ${DEFAULT_COMPARE_ENTRIES}，上限 ${MAX_COMPARE_ENTRIES}）`,
        },
      },
      required: ["otherFileId"],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const otherFileId = typeof args.otherFileId === "string" ? args.otherFileId.trim() : "";
      if (!otherFileId) {
        throw new Error("INVALID_REQUEST: otherFileId 必填（要对比的另一份 .docx 的 fileId，可先用 file_search 查找）");
      }
      const target = await resolveOfficeTarget(args, context);
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(
          `INVALID_TARGET: word_compare 左侧文档只支持 .docx；《${target.entry.originalName}》不是 Word 文档`,
        );
      }
      if (target.fileId === otherFileId) {
        throw new Error("INVALID_REQUEST: fileId 与 otherFileId 是同一个文件，无法和自己对比");
      }
      const otherEntry = target.access.catalogEntry(otherFileId);
      if (!otherEntry) {
        throw new Error(`FILE_NOT_FOUND: 对比文件 ${otherFileId} 不在文件库中（可能仍在导入或已被删除）`);
      }
      if (!otherEntry.contentHash) {
        throw new Error(
          `FILE_CONTENT_UNAVAILABLE: 《${otherEntry.displayName ?? otherEntry.originalName}》还没有可用的文件版本`,
        );
      }
      if (!/\.docx$/i.test(otherEntry.originalName)) {
        throw new Error(
          `INVALID_TARGET: word_compare 对比文档只支持 .docx；《${otherEntry.originalName}》不是 Word 文档`,
        );
      }

      let leftTexts: string[];
      let rightTexts: string[];
      try {
        const [leftBuffer, rightBuffer] = await Promise.all([
          readTargetBuffer(target.access, target.fileId, target.entry),
          readTargetBuffer(target.access, otherFileId, otherEntry),
        ]);
        const [leftParagraphs, rightParagraphs] = await Promise.all([
          readDocxParagraphs(leftBuffer),
          readDocxParagraphs(rightBuffer),
        ]);
        leftTexts = leftParagraphs.map((paragraph) => paragraph.text);
        rightTexts = rightParagraphs.map((paragraph) => paragraph.text);
      } catch (error) {
        if (error instanceof DocxEditError) {
          throw new Error(`INVALID_TARGET: word_compare 需要两份有效的 .docx（${error.message}）`);
        }
        throw error;
      }

      const cells = leftTexts.length * rightTexts.length;
      if (cells > MAX_COMPARE_CELLS) {
        throw new Error(
          `FILE_TOO_LARGE: 两份文档段落数过多（左 ${leftTexts.length} 段 × 右 ${rightTexts.length} 段），`
          + `超出逐段对比上限（${MAX_COMPARE_CELLS} 个对齐单元）；请先拆分章节或用 file_read 分节对比`,
        );
      }

      const entries = compareParagraphs(leftTexts, rightTexts);
      const summary = summarizeParagraphCompare(entries);
      const rawMax = Number(args.maxEntries ?? DEFAULT_COMPARE_ENTRIES);
      const maxEntries = Number.isFinite(rawMax)
        ? Math.min(MAX_COMPARE_ENTRIES, Math.max(1, Math.trunc(rawMax)))
        : DEFAULT_COMPARE_ENTRIES;
      const clip = (text: string): string =>
        text.length > MAX_COMPARE_TEXT ? `${text.slice(0, MAX_COMPARE_TEXT)}…` : text;
      const visibleEntries = entries.slice(0, maxEntries).map((entry: ParagraphCompareEntry) => ({
        kind: entry.kind,
        ...(entry.left !== undefined ? { left: clip(entry.left) } : {}),
        ...(entry.right !== undefined ? { right: clip(entry.right) } : {}),
      }));
      const identical = summary.changed + summary.added + summary.removed === 0;
      return success({
        fileId: target.fileId,
        otherFileId,
        title: target.entry.displayName ?? target.entry.originalName,
        otherTitle: otherEntry.displayName ?? otherEntry.originalName,
        summary,
        entries: visibleEntries,
        truncated: entries.length > visibleEntries.length,
        identical,
        nextAction: "report_result",
        hint: identical
          ? "两份文档段落文本完全一致（word_compare 只比段落文本，不比格式/表格结构/图片）。"
          : "left = 基准文档、right = 对比文档；回复只说明关键差异（改了什么/新增/删除了什么），"
            + "不要罗列全部 same 条目；entries 被截断时按 summary 的计数说明总量。",
      });
    },
  };

  /**
   * Word → PDF：桌面端 LibreOffice 转换并入库；网关只传 fileId/命名/归属，
   * 不搬文档字节（PDF 由桌面端 import 进文件库后返回新 fileId）。
   */
  const wordExportPdf: DocumentCapabilityTool = {
    name: "word_export_pdf",
    title: "把 Word 导出为 PDF 并加入文件库",
    description: "把任意已入库 .docx 导出为 PDF（桌面端用 LibreOffice 转换，作为新文件加入文件库），"
      + "适合“导出 PDF / 发我一份 PDF / 转成 PDF”这类请求。fileId 省略 = 用户当前浏览的文件；"
      + "不需要文件已经在界面上打开。返回新 PDF 的 fileId 与 originalName（原 .docx 不受影响、不会改版本）。"
      + "fileName 可选，必须以 .pdf 结尾（默认沿用原文件名）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "要导出的 Word 文件 id；省略 = 当前正在浏览的文件" },
        fileName: {
          type: "string",
          minLength: 6,
          maxLength: 120,
          description: "可选输出文件名，必须以 .pdf 结尾（默认取原文件名）",
        },
      },
      required: [],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const target = await resolveOfficeTarget(args, context);
      const title = target.entry.displayName ?? target.entry.originalName;
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_export_pdf 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      const fileName = optionalFileName(args, ".pdf");
      let exported: Awaited<ReturnType<OfficeBridgeClient["exportPdf"]>>;
      try {
        exported = await bridge.exportPdf({
          fileId: target.fileId,
          ...(fileName ? { fileName } : {}),
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
        });
      } catch (error) {
        throw new Error(
          `EXPORT_PDF_FAILED: 《${title}》导出 PDF 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!exported.fileId) throw new Error("EXPORT_PDF_FAILED: 桌面端未返回 PDF 文件条目");
      return success({
        fileId: exported.fileId,
        sourceFileId: target.fileId,
        originalName: exported.originalName,
        ...(exported.contentHash ? { contentHash: exported.contentHash } : {}),
        nextAction: "report_result",
        hint: "PDF 已生成并加入文件库（原 Word 未改动）；回复里告知 PDF 文件名即可，不要重复导出。",
      });
    },
  };

  /** 宿主生图 + 插入：prompt → ai-relay 生图中转 → 图片对象库字节 → 渲染层插入。
   *  未注入 illustration 端口时不暴露（测试/无生图配置的部署）。 */
  const wordAgentIllustration: DocumentCapabilityTool | null = illustration ? {
    name: "word_agent_illustration",
    title: "为任意 Word 生成并插入配图",
    description: "按文字描述生成一张示意图并插入任意已入库 .docx（按 fileId；不需要文件在界面上打开，"
      + "后台编辑器 headless 打开后写入并静默保存）。宿主完成生图与落盘："
      + "经生图中转出图后直接写入文档，模型不需要也不允许搬运图片字节。"
      + "先 word_agent_read 拿块索引，再用 afterIndex 指定插在哪一块之后（-1/省略 = 文末）。"
      + "生成通常需要 60-120 秒；失败会返回可读原因，不要反复重试生图。"
      + "已存在本地图片文件时改用 word_agent_edit 的 insert_image_base64 {path}；用户给了图片链接时用 {url}。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件" },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 1200,
          description: "画面描述（主题/构图/风格，写给生图模型；英文通常更稳）。不要把正文长句原样丢进去。",
        },
        afterIndex: {
          type: "integer",
          minimum: -1,
          description: "插在该块之后（块索引来自 word_agent_read）；-1/省略 = 文末",
        },
        maxWidthPx: {
          type: "integer",
          minimum: 16,
          maximum: 1200,
          description: "插入目标宽度（px）；默认 480，实际不超过渲染端上限 620",
        },
        label: { type: "string", maxLength: 80, description: "图片替代文字/标签" },
      },
      required: ["prompt"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      const target = await resolveOfficeTarget(args, context);
      const title = target.entry.displayName ?? target.entry.originalName;
      if (!/\.docx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: word_agent_illustration 只支持 .docx；《${target.entry.originalName}》不是 Word 文档`);
      }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new Error("INVALID_REQUEST: prompt 不能为空");
      const afterIndexRaw = Number(args.afterIndex ?? -1);
      const afterIndex = Number.isInteger(afterIndexRaw) ? afterIndexRaw : -1;
      const widthRaw = Number(args.maxWidthPx ?? 480);
      const maxWidthPx = Number.isFinite(widthRaw) ? Math.min(1200, Math.max(16, Math.trunc(widthRaw))) : 480;
      const rawLabel = typeof args.label === "string" ? args.label.trim() : "";
      const label = (rawLabel || "Illustration").slice(0, 80);

      let generated: { contentHash: string };
      try {
        generated = await illustration.generate(`${prompt}${ILLUSTRATION_PROMPT_SUFFIX}`);
      } catch (error) {
        throw new Error(
          `ILLUSTRATION_UNAVAILABLE: 生图失败（${error instanceof Error ? error.message : String(error)}）。`
          + "可以改用本地图片：word_agent_edit 的 insert_image_base64 {path}（例如你自己生成/用户提供的 PNG 绝对路径），"
          + "或请用户提供图片；不要反复重试生图。",
        );
      }
      const bytes = await illustration.read(generated.contentHash);
      if (!bytes) {
        throw new Error("ILLUSTRATION_UNAVAILABLE: 生图产物读取失败（图片对象库未命中）；请改用本地图片 path 插入。");
      }
      const mime = sniffImageMime(bytes.buffer);
      if (!mime) throw new Error("ILLUSTRATION_UNAVAILABLE: 生图返回的格式不受支持（只支持 PNG/JPEG/GIF）。");
      try {
        const applied = await bridge.applyAgentArtifactTools({
          kind: "docx",
          fileId: target.fileId,
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
          calls: [{
            id: "illustration-1",
            name: "insert_image_base64",
            input: {
              base64: bytes.buffer.toString("base64"),
              mime,
              afterIndex,
              maxWidthPx,
              label,
            },
          }],
        });
        const row = applied.results?.[0];
        if (row?.isError) throw new Error(`INSERT_IMAGE_FAILED: ${row.output}`);
        return success({
          fileId: target.fileId,
          title,
          contentHash: generated.contentHash,
          applied: true,
          ...applied,
          nextAction: "report_result",
          hint: "配图已生成并插入；回复里说明插到了哪一节，不要重复生成。",
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("INSERT_IMAGE_FAILED:")) throw error;
        throw new Error(agentToolsFailureMessage(title, error instanceof Error ? error.message : String(error)));
      }
    },
  } : null;

  const sheetsAgentRead: DocumentCapabilityTool = {
    name: "sheets_agent_read",
    title: "读取任意 Excel 的工作簿上下文与操作指南",
    description: "按 fileId 读取任意已入库 .xlsx 的活工作簿状态（不需要文件在界面上打开，后台编辑器可 headless 打开）："
      + "工作表清单（sheetId/名称/数据范围）、当前选区、已知非空单元格，"
      + "以及 propose_operations DSL 的工具词汇表与全部操作指南（writing/formatting/layout/structure/charts/…）。"
      + "sheetId 是 sheets_agent_edit 里操作的定位依据（不是工作表名）。"
      + "只读打开的文件也能读。fileId 省略 = 用户当前浏览的文件；要改的表格没打开时先用 file_search 按文件名定位 fileId。"
      + "比 sheets_read 更适合作为 propose_operations 的前置。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件（可用 file_search 查找）" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      const target = await resolveOfficeTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_agent_read 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      try {
        const described = await bridge.describeAgentArtifact({
          kind: "spreadsheet",
          fileId: target.fileId,
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
        });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...described,
          hint: "读单元格用 read_range/read_cells；写改动用 propose_operations（op 字段定义在 guides 里，先查再写）。"
            + "修改不需要这份表格已经打开：后台会 headless 打开一份隐藏工作簿，编辑静默保存并更新版本。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  const sheetsAgentEdit: DocumentCapabilityTool = {
    name: "sheets_agent_edit",
    title: "用表格 AI 工具链编辑任意 Excel",
    description: "把 GenOffice Sheets 的编辑器 AI 工具调用直接作用到任意已入库 .xlsx 上（按 fileId；不需要文件在界面上打开，"
      + "桌面端在后台以隐藏工作簿 headless 打开，编辑自动保存并更新文件版本）。"
      + "先 sheets_agent_read 拿工作簿上下文与指南。常用工具："
      + "read_range / read_cells（读值与公式）、find_cells（全簿搜索）、select_range（选区定位）、"
      + "aggregate_range（大批量统计）、propose_operations（{operations, summary} 唯一的写路径，op 定义见指南）、"
      + "trace_precedents / trace_dependents（公式审计）。"
      + "打印控制走 set_page_setup（含 printArea/printTitles/header/footer（&P 页码 &N 总页数 &D 日期 &A 表名）/rowBreaks/colBreaks）、"
      + "条件格式支持 iconSet 图标集。"
      + "calls 1-50 条，按序执行；结果逐条返回（isError=true 表示该条失败，不影响已执行的其他条）。"
      + "本环境不支持 dry-run：不要传 dryRun，也不要说“先生成预览再执行”。"
      + "只有界面里正开着这份表格且有未保存修改时才会被拒绝（FILE_UNSAVED：请用户先保存再重试）；"
      + "没打开或 UI 隐藏（没有页签）时网关会在后台 headless 打开它，不需要请用户先打开、先另存或先切页签。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "文件 id；省略 = 当前正在浏览的文件（可用 file_search 查找）" },
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "工具调用数组（{id, name, input}），name 必须是 sheets_agent_read 返回的 tools 之一",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name", "input"],
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
            },
          },
        },
      },
      required: ["calls"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!Array.isArray(args.calls) || args.calls.length === 0) {
        throw new Error("INVALID_REQUEST: calls 必须是非空数组");
      }
      const target = await resolveOfficeTarget(args, context);
      if (!/\.xlsx$/i.test(target.entry.originalName)) {
        throw new Error(`INVALID_TARGET: sheets_agent_edit 只支持 .xlsx；《${target.entry.originalName}》不是 Excel 表格`);
      }
      try {
        const applied = await bridge.applyAgentArtifactTools({
          kind: "spreadsheet",
          fileId: target.fileId,
          roomId: context.roomId,
          workspaceId: context.workspaceId ?? null,
          calls: args.calls as OfficeAgentToolCall[],
        });
        return success({
          fileId: target.fileId,
          title: target.entry.displayName ?? target.entry.originalName,
          ...applied,
          nextAction: "report_result",
          hint: applied.results?.some((r) => r.isError)
            ? "部分调用失败：读每条 output 修正后重试失败的调用；成功条目已生效，不要重复执行。"
            : "修改已生效并保存（文件版本 +1）；回复里只说明改了哪些单元格/工作表。",
        });
      } catch (error) {
        throw new Error(agentToolsFailureMessage(
          target.entry.displayName ?? target.entry.originalName,
          error instanceof Error ? error.message : String(error),
        ));
      }
    },
  };

  return {
    manifest: manifest("office.create", "mutation", null, null, false),
    promptGuidelines: [
      "用户需要正式 Office 文档时按格式选工具：Word 报告/交付物用 office_create，"
      + "数据表格用 sheets_create；演示/汇报（PPT）不在本组工具内，走 slides_create 按内联 pptx skill 写整册 pptxgenjs 脚本生成，修改用 slides_read + slides_edit 直改；"
      + "普通笔记、速记、随手总结用文档创建工具（markdown），不要用 Office 工具。",
      "Word 的 html 入参必须是受限 HTML 子集（仅标题/段落/列表/表格/链接/强调/pre/code/blockquote 标签）；"
      + "长文用 h2/h3 分节；表格首行用 th、单元格纯文本；不要输出 markdown 或解释性文字。",
      "Excel 的 sheets→rows 用 JSON 二维数组；数字必须是 JSON number；每个表首行放表头。",
      "生成成功后在回复中告知文件名；桌面端会自动打开预览，文档在文件库可见。",
      "用户要求修改“我正开着的/这份 Word 或 Excel”时：Word 先 office_read 拿段落原文、Excel 先 sheets_read 看结构，"
      + "再用 office_edit / sheets_edit 按原文片段或单元格地址改；不要用 office_create/sheets_create 重建一份新文件。"
      + "office_edit 是字节级兜底（要求文件已打开）；Word/Excel 能用 word_agent_* / sheets_agent_* 时优先走 headless 通道路线。"
      + "被 FILE_UNSAVED 拒绝时先把“先保存再改”告诉用户，保存后重试；只有走 office_edit 兜底被 FILE_NOT_OPEN 拒绝时，才请用户先以可编辑方式打开。",
      "修改任意 Word（用户提到的那份 .docx 不必已经打开，UI 里看不到页签也能改）：先 word_agent_read（要现成 fileId 就先用 file_search 按文件名找），"
      + "再按任务选 word_agent_edit（块级内容/格式/插图/水印/页眉页脚等工具调用）或 word_agent_ops（表格/分页与页面设置/批注/脚注/域/引用/修订等结构化 ops）。"
      + "后台编辑器会按 fileId headless 打开并静默保存，不要要求用户先打开、先另存或先切到那个页签；"
      + "只有该文件正开着且有未保存修改时才需要用户先保存（FILE_UNSAVED）。",
      "修改任意 Excel（用户提到的那份 .xlsx 不必已经打开，UI 里看不到页签也能改）：先 sheets_agent_read"
      + "（要现成 fileId 就先用 file_search 按文件名找），再用 sheets_agent_edit 下发 read_range/propose_operations 等工具调用；"
      + "propose_operations 是唯一写路径，一次 1-50 条，本环境不支持 dry-run（不要传 dryRun、不要说“先生成预览”）。"
      + "后台会按 fileId headless 打开一份隐藏工作簿并静默保存（文件版本 +1），不要要求用户先打开、先另存或先切到那个页签，"
      + "也不要用 sheets_create 重建一份；只有该文件正开着且有未保存修改时才需要用户先保存（FILE_UNSAVED）。",
      "用户要求在 Word 里配图/插图时：先 word_agent_read 拿块索引，再调用 word_agent_illustration 生成并插入"
      + "（prompt 只描述画面，不要把正文长句原样丢给生图模型）；不要用 bash/matplotlib 现画图再想办法把 base64 传进工具参数。"
      + "已有本地图片（用户给的路径或你自己生成的 PNG）用 word_agent_edit 的 insert_image_base64 {path}；"
      + "用户给了图片 URL 用 {url}。绝不要把 base64 字节写进工具参数。",
      "用户问“这两份 / 两个版本 / 和模板比改了什么”时用 word_compare："
      + "left 用 fileId（省略 = 当前文件），right 用 otherFileId（没给 fileId 就用 file_search 按文件名找）；"
      + "回复只讲关键差异（改了什么/新增/删除了什么），不要罗列 same 条目，entries 截断时以 summary 计数说明总量。"
      + "只比段落文本；格式/表格结构差异要如实说明该工具看不到。",
      "用户要把 Word 转成 PDF（“导出 PDF / 给我一份 PDF”）时用 word_export_pdf（先 file_search 拿 fileId，省略 fileId 即当前文件）；"
      + "导出后告知新 PDF 文件名即可，不要用 office_create 重建一份、也不要假装改动原 .docx。",
      "word_agent_ops 的 object.image.replace 图片来源只写本地图片绝对路径 path 或公网图片 url"
      + "（网关读字节后注入 base64/mime，模型不必也不许把 base64 抄进 ops）；来源解析失败会整批拒绝，先修正 path/url 再重试。",
    ],
    tools: [
      officeCreate,
      slidesCreate,
      sheetsCreate,
      slidesRead,
      slidesEdit,
      ...(files ? [officeRead, officeEdit, sheetsRead, sheetsEdit] : []),
      ...(files
        ? [wordAgentRead, wordAgentEdit, wordAgentOps, wordCompare, wordExportPdf, sheetsAgentRead, sheetsAgentEdit]
        : []),
      ...(files && wordAgentIllustration ? [wordAgentIllustration] : []),
    ],
  };
}
