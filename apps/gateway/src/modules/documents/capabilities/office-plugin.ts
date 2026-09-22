import { createHash } from "node:crypto";

import { annotations, manifest } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";
import type { OfficeBridgeClient, OfficeSheetBridgeInput } from "./office-bridge-client.js";

/**
 * Agent 写 Office：Word（受限 HTML）、PPT（PageSpec 页描述）、Excel
 * （sheets→rows）三个工具，经桌面 office-bridge 生成真实文件并走
 * file-imports 入库，Room 产物库由路由决策自动投影展示。
 * - Word：隐藏 GenOffice docs view（HTML 子集与 vendored
 *   apps/docs/src/renderer/ai/protocol.ts 的 HTML_RULES 一致）。
 * - PPT：主进程本地拼装（fork 导出 buildAgentDeckPptx，页 spec 与 vendored
 *   apps/slides/src/main/page-spec.ts 的解析器一致）。
 * - Excel：主进程直接拼标准 OOXML（jszip，inline string）。
 * 编辑已有文档留待后续迭代。
 */

const MAX_HTML_LENGTH = 400_000;
const MAX_SLIDES_PAGES = 24;
const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLS = 50;
const MAX_CELL_LENGTH = 3000;

const HTML_GUIDE = "内容用受限 HTML 片段表达，只允许这些标签："
  + "h1 h2 h3 h4 h5 h6 p ul ol li strong em u s a br table thead tbody tr th td pre code blockquote。"
  + "表格首行用 th，单元格只放纯文本（可用 br 分行），不支持嵌套表格和合并单元格；"
  + "代码示例用 pre，引用用 blockquote；长内容用 h2/h3 分节组织。"
  + "不要包含 html/body 标签、markdown 代码围栏或任何解释性文字。";

const PAGESPEC_GUIDE = "每一页是一个 JSON 对象（PageSpec），画布固定 1280×720 像素、坐标原点左上："
  + '{"background":"#RRGGBB"(可选),"elements":[…按 z 顺序排列…]}。'
  + "元素三种：文本 {\"type\":\"text\",\"x\",\"y\",\"w\",\"h\",\"paragraphs\":[{\"runs\":[{\"text\",\"sizePt\",\"bold\",\"color\":\"#RRGGBB\",\"font\"}],\"align\":\"left|center|right\",\"bullet\":true}],\"valign\":\"top|middle|bottom\"}；"
  + "形状 {\"type\":\"shape\",\"shape\":\"rect|roundRect|ellipse|triangle|rightArrow|leftArrow|upArrow|downArrow|chevron|diamond|parallelogram|trapezoid|hexagon|pentagon|pie|donut|star5|heart|cloud|line|lineArrow\",\"fill\":\"#RRGGBB\",\"stroke\":{\"color\",\"widthPt\"},\"paragraphs\":…(可选),\"valign\":…}；"
  + "图片 {\"type\":\"image\",\"x\",\"y\",\"w\",\"h\",\"url\":\"https://…\"}(仅 http(s)，每页最多 8 张)。"
  + "限制：每页最多 48 个元素；sizePt 6~160；颜色只写 #RRGGBB。"
  + "版式建议：页边距≥60px；标题条 44~60pt，正文 18~24pt；同一份演示用统一的背景/主色/标题位置；"
  + "少字多留白，每页一个要点；封面页用大标题+副标题，内容页用标题条+内容区，结尾页致谢。"
  + '示例页：{"background":"#FFFFFF","elements":[{"type":"text","x":80,"y":240,"w":1120,"h":120,"paragraphs":[{"runs":[{"text":"季度回顾","sizePt":54,"bold":true,"color":"#1A1A1A"}],"align":"center"}]},{"type":"shape","shape":"rect","x":540,"y":400,"w":200,"h":6,"fill":"#2B6CB0"}]}';

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

/** PageSpec 页可以是对象或整段 JSON 字符串（模型偶发输出）；统一成字符串下发。 */
function normalizePageSpecs(pages: unknown): string[] {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("INVALID_REQUEST: pages 必须是非空数组（每页一个 PageSpec 对象）");
  }
  if (pages.length > MAX_SLIDES_PAGES) {
    throw new Error(`INVALID_REQUEST: 页数超过上限（${MAX_SLIDES_PAGES}），请精简内容`);
  }
  return pages.map((page, index) => {
    if (page && typeof page === "object") return JSON.stringify(page);
    if (typeof page === "string" && page.trim()) return page;
    throw new Error(`INVALID_REQUEST: 第 ${index + 1} 页不是有效的 PageSpec 对象`);
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

export function officePlugin(bridge: OfficeBridgeClient): DocumentCapabilityPlugin {
  const officeCreate: DocumentCapabilityTool = {
    name: "context_room_office_create",
    title: "生成 Word 文档入 Room",
    description: "用本地 Word 引擎生成一份新的 .docx 文档并加入当前 Room（产物库 Office 产物 + 文件库），"
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
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
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
        // Room 资料页投影由路由决策异步完成（知识路由关闭时会降级为仅入库）。
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const slidesCreate: DocumentCapabilityTool = {
    name: "context_room_slides_create",
    title: "生成 PPT 演示入 Room",
    description: "生成本地排版的一份新 .pptx 演示文稿并加入当前 Room（产物库 Office 产物 + 文件库），"
      + "适合汇报、提案、培训等演示场景。title 用作默认文件名（<title>.pptx，可用 fileName 覆盖）。"
      + `pages 是页描述数组（每页一个 PageSpec 对象，1~${MAX_SLIDES_PAGES} 页，数组顺序即页序）。${PAGESPEC_GUIDE}`
      + "生成完成后桌面端会自动打开预览；在回复中告知文件名与页数即可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "演示标题（同时是默认文件名）" },
        pages: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SLIDES_PAGES,
          description: "每页一个 PageSpec JSON 对象（1280×720 画布；elements 数组即 z 顺序）",
          items: { type: "object", additionalProperties: true },
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .pptx 结尾" },
      },
      required: ["title", "pages"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const title = stringArg(args, "title").trim().slice(0, 120);
      const pages = normalizePageSpecs(args.pages);
      const fileName = optionalFileName(args, ".pptx");
      const result = await bridge.generate({
        title,
        format: "pptx",
        pages,
        roomId: context.roomId,
        fileName,
        idempotencyKey: idempotencyKey("agent-slides", context.runId, title),
      });
      if (!result.fileEntryId) throw new Error("OFFICE_GENERATION_FAILED: 桌面端未返回文件条目");
      return success({
        fileEntryId: result.fileEntryId,
        fileVersionId: result.fileVersionId,
        jobId: result.jobId,
        contentHash: result.contentHash,
        originalName: result.originalName,
        format: "pptx",
        pages: pages.length,
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        roomRoutingRequested: result.roomRequested,
        nextAction: "report_result",
      });
    },
  };

  const sheetsCreate: DocumentCapabilityTool = {
    name: "context_room_sheets_create",
    title: "生成 Excel 表格入 Room",
    description: "生成本地排版的一份新 .xlsx 电子表格并加入当前 Room（产物库 Office 产物 + 文件库），"
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
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const title = stringArg(args, "title").trim().slice(0, 120);
      const sheets = normalizeSheets(args.sheets);
      const fileName = optionalFileName(args, ".xlsx");
      const result = await bridge.generate({
        title,
        format: "xlsx",
        sheets,
        roomId: context.roomId,
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

  return {
    manifest: manifest("office.create", "mutation", null, null, true, false),
    promptGuidelines: [
      "用户需要正式 Office 文档时按格式选工具：Word 报告/交付物用 context_room_office_create，"
      + "演示/汇报用 context_room_slides_create，数据表格用 context_room_sheets_create；"
      + "普通笔记、速记、随手总结用文档创建工具（markdown），不要用 Office 工具。",
      "Word 的 html 入参必须是受限 HTML 子集（仅标题/段落/列表/表格/链接/强调/pre/code/blockquote 标签）；"
      + "长文用 h2/h3 分节；表格首行用 th、单元格纯文本；不要输出 markdown 或解释性文字。",
      "PPT 的 pages 每页一个 PageSpec 对象（1280×720 画布绝对定位）；同一份演示保持统一版式与配色，"
      + "每页少字多留白；文本块用 runs 控制字号/加粗/颜色。",
      "Excel 的 sheets→rows 用 JSON 二维数组；数字必须是 JSON number；每个表首行放表头。",
      "生成成功后在回复中告知文件名；桌面端会自动打开预览，文档在 Room 产物库（Office 产物）和文件库可见。",
    ],
    tools: [officeCreate, slidesCreate, sheetsCreate],
  };
}
