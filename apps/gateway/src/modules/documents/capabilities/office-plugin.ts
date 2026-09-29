import { createHash } from "node:crypto";

import { annotations, manifest } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool, type SlidesPageReviewGate } from "./types.js";
import type { OfficeBridgeClient, OfficeSheetBridgeInput } from "./office-bridge-client.js";

/**
 * Agent 写 Office：Word（受限 HTML）、PPT（两阶段：建文件 + 逐页生成）、Excel
 * （sheets→rows）三个工具，经桌面 office-bridge 生成真实文件并走
 * file-imports 入库，Room 产物库由路由决策自动投影展示。
 * - Word：隐藏 GenOffice docs view（HTML 子集与 vendored
 *   apps/docs/src/renderer/ai/protocol.ts 的 HTML_RULES 一致）。
 * - PPT：两阶段生成。create 只带 outline（页序蓝图：每页标题、长度即页数上限），
 *   桌面端只落 1 页骨架（fork buildAgentDeckPptx 生成）；文件入库后自动以可编辑
 *   方式打开，Agent 再用 set_page 一页一页生成（fork
 *   applyAgentDeckPage：与 regenerate_slide 相同的 insertSlidePptx 事务；
 *   slideIndex<页数原地替换，=页数末尾追加——文件页数随生成进度增长，失败不留空壳；
 *   实时重绘、每页独立失败重试）。单次输出一页，避免长输出结构漂移与黑盒等待。
 * - Excel：主进程直接拼标准 OOXML（jszip，inline string）。
 * 编辑：PPT 走 context_room_slides_read/edit（文件需在 Room 产物库打开为可编辑
 * 实例；编辑事务实时重绘在打开的视图上，保存自动回填版本链）。
 * Word/Excel 的编辑与离屏编辑留待后续迭代。
 */

const MAX_HTML_LENGTH = 400_000;
const MAX_SLIDES_PAGES = 24;
const MAX_PAGE_SPEC_LENGTH = 80_000;
const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLS = 50;
const MAX_CELL_LENGTH = 3000;

/** slides-builder 子代理独占的 4 个 PPT 工具名：主 Agent 工具面按此剔除（单一事实源）。 */
export const SLIDES_TOOL_NAMES = [
  "context_room_slides_create",
  "context_room_slides_set_page",
  "context_room_slides_read",
  "context_room_slides_edit",
] as const;

const HTML_GUIDE = "内容用受限 HTML 片段表达，只允许这些标签："
  + "h1 h2 h3 h4 h5 h6 p ul ol li strong em u s a br table thead tbody tr th td pre code blockquote。"
  + "表格首行用 th，单元格只放纯文本（可用 br 分行），不支持嵌套表格和合并单元格；"
  + "代码示例用 pre，引用用 blockquote；长内容用 h2/h3 分节组织。"
  + "不要包含 html/body 标签、markdown 代码围栏或任何解释性文字。";

const PAGESPEC_GUIDE = "每一页是一个 JSON 对象（PageSpec），画布固定 1280×720 像素、坐标原点左上，x/y/w/h 用整数像素："
  + '{"background":"#RRGGBB"(可选),"elements":[…按绘制顺序排列…]}。'
  + "元素按数组顺序绘制：背景/装饰形状在前、图片其次、文本最后（文本绝不能被形状盖住）。"
  + "元素六种："
  + "文本 {\"type\":\"text\",\"x\",\"y\",\"w\",\"h\",\"valign\":\"top|middle|bottom\",\"shadow\":\"soft|medium|strong\"(可选),\"paragraphs\":[{\"align\":\"left|center|right\",\"lineSpacingPct\":110,\"spaceAfterPt\":6,\"bullet\":true,\"runs\":[{\"text\",\"sizePt\",\"bold\",\"italic\",\"color\",\"font\"}]}]}；"
  + "形状 {\"type\":\"shape\",\"shape\":\"rect|roundRect|ellipse|triangle|rightArrow|leftArrow|upArrow|downArrow|chevron|diamond|parallelogram|trapezoid|hexagon|pentagon|pie|donut|star5|heart|cloud|line|lineArrow\",\"fill\":\"#RRGGBB 或 #RRGGBBAA（AA=透明度，00 全透明）\",\"gradient\":{\"stops\":[{\"pos\":0~1,\"color\":\"#RRGGBB\"},…恰好 2~3 个],\"angle\":90}(可选线性渐变，有 gradient 时忽略 fill),\"shadow\":\"soft|medium|strong\"(可选),\"stroke\":{\"color\",\"widthPt\"},\"paragraphs\":…(可选，形状内文字垂直居中)}；"
  + "图片 {\"type\":\"image\",\"x\",\"y\",\"w\",\"h\",\"url\":\"https://…\",\"fit\":\"cover|contain\",\"shadow\":\"soft|medium|strong\"(可选)}(仅 http(s)，每页最多 8 张；fit 默认 cover 居中裁剪填满框，主体可能被裁边；产品图等主体必须完整时用 contain 整图缩放居中留白)；"
  + "图表 {\"type\":\"chart\",\"chart\":\"bar|barStacked|line|pie|doughnut|scatter|comboBarLine\",\"title\":\"标题\"(可选≤80字符；页面已有大标题时留空，避免双标题),\"categories\":[\"Q1\",\"Q2\"…](2~24 个),\"series\":[{\"name\":\"系列名\",\"values\":[数字…]}](1~6 个；每个 values 长度必须等于 categories，全为有限数字，否则整页拒绝),\"colors\":[\"#RRGGBB\"…](可选，多系列按系列、饼/环按扇区；不传时用统一蓝灰板),\"legend\":true|false(可选；默认自动——多系列或饼/环显示、单系列不显示),\"dataLabels\":true(可选，仅当点数 ≤8 时才开),\"gridlines\":true(可选)}——scatter 是 XY 散点/定位图：categories 填 x 轴数值（数字字符串），series 的 values 是对应 y 值，点位标签用独立 text 元素叠在图上；"
  + "comboBarLine 是柱+折线双轴组合图（如收入+增长率）：除最后一个系列为折线走右轴外都是柱，必须 ≥2 个系列；"
  + "图标 {\"type\":\"icon\",\"icon\":\"<图标名>\",\"color\":\"#RRGGBB\",\"x\",\"y\",\"w\",\"h\"}(单色矢量图标；可用名："
  + "arrow-up arrow-down arrow-left arrow-right arrow-trending-up arrow-trending-down arrow-path arrow-top-right-on-square "
  + "check check-circle x-circle x-mark plus minus star heart bell calendar clock "
  + "user users building-office-2 home envelope phone chat-bubble-left-right magnifying-glass "
  + "cog-6-tooth lock-closed lock-open eye globe-alt map-pin shopping-cart credit-card "
  + "chart-bar chart-pie currency-dollar light-bulb rocket-launch flag trophy shield-check "
  + "cloud server-stack circle-stack device-phone-mobile computer-desktop wifi link paper-clip "
  + "trash pencil-square document-text folder photo play exclamation-triangle information-circle "
  + "question-mark-circle hand-thumb-up sparkles bolt sun moon key)。"
  + "表格 {\"type\":\"table\",\"x\",\"y\",\"w\",\"h\",\"rows\":[[单元格,…],…](1~12 行 × 1~8 列；单元格是字符串或 {\"text\",\"bold\",\"color\",\"fill\",\"align\":\"left|center|right\",\"span\":跨列数}；每行跨列总数必须一致，否则整页拒绝),\"colWidths\":[0.9,1,1,1](可选相对列宽),\"rowHeights\":[1.2,1,1](可选相对行高),\"fontSize\":13(可选 9~24,默认 13),\"borderColor\":\"#RRGGBB\",\"horizontalBordersOnly\":true(只画行间横线),\"verticalBordersOnly\":true(只画列间竖线),\"borderWidthPt\":0.5(可选 0.25~3),\"zebra\":\"#RRGGBB\"(可选隔行浅底,自动套在偶数数据行)}。"
  + "line/lineArrow 画的是所在盒子的对角线（水平分隔线 = 高 1px 的盒子加 stroke）。"
  + "限制：每页最多 48 个元素；sizePt 6~160；颜色只写 #RGB/#RRGGBB/#RRGGBBAA。"
  + "文本渲染事实（写 spec 前按此估算）：文本框零内边距，框左上角就是首字位置；一行高约 sizePt*1.8px（lineSpacingPct 110），"
  + "CJK 字宽约 sizePt*1.35px、拉丁字符约 sizePt*0.7px——按框宽估算折行数，框高按实际行数计算再加一行余量。"
  + "引擎硬校验（违规整页拒绝，报错回传后修正该页重试）：① 任何文本中出现 emoji（含变体选择符）直接拒绝——图标用 icon 元素；"
  + "② 任何两个「有文字的元素」（文本框或带文字的形状）的估算文字区域相交（留 6px 容差）直接拒绝；"
  + "③ 构建时按真实排版实测：单元格折行把表格撑得超出声明框高、或文本框实际高度伸出画布底边，整页拒绝——按报错里的实测数字砍行数、缩短单元格文字或加大框高，数据量大时拆成两页，不要缩字号硬塞。"
  + "示例页：{\"background\":\"#FFFFFF\",\"elements\":[{\"type\":\"text\",\"x\":80,\"y\":240,\"w\":1120,\"h\":120,\"paragraphs\":[{\"runs\":[{\"text\":\"季度回顾\",\"sizePt\":44,\"bold\":true,\"color\":\"#1A1A1A\"}],\"align\":\"center\"}]}]}";

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

/** PPT 大纲（每页一个标题，页序蓝图）；首版骨架页由此合成，模型不再整册输出 PageSpec。 */
function normalizeOutline(outline: unknown): string[] {
  if (!Array.isArray(outline) || outline.length === 0) {
    throw new Error("INVALID_REQUEST: outline 必须是非空字符串数组（每页一个标题，数组顺序即页序）");
  }
  if (outline.length > MAX_SLIDES_PAGES) {
    throw new Error(`INVALID_REQUEST: 页数超过上限（${MAX_SLIDES_PAGES}），请精简内容`);
  }
  return outline.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`INVALID_REQUEST: 第 ${index + 1} 页标题无效（必须是非空字符串）`);
    }
    return item.trim().slice(0, 80);
  });
}

/** 骨架页：中性占位版式（演示标题 + 首页标题），set_page slideIndex=0 时整页替换。 */
function skeletonPageSpec(deckTitle: string, pageTitle: string, index: number, total: number): string {
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
  /** PPT 逐页审阅闸门（用户决策：每页停下等确认）；未注入时逐页直通。 */
  slidesGate?: SlidesPageReviewGate | null,
): DocumentCapabilityPlugin {
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
    title: "创建 PPT 入 Room",
    description: "创建一份新 .pptx 演示文稿并加入当前 Room（产物库 Office 产物 + 文件库），"
      + "适合汇报、提案、培训等演示场景。只传 outline（每页一个标题，是页序蓝图：数组顺序即页序、"
      + `长度即页数上限，共 1~${MAX_SLIDES_PAGES} 页）；创建的文件初始只有 1 页骨架，页数随后续逐页生成增长。`
      + "第二步必须用 context_room_slides_set_page 一页一页生成——slideIndex=0 替换骨架页，"
      + "此后 slideIndex=当前页数 时自动在末尾追加新页；生成到第几页，文件就有几页完整成形的页，中途失败不会留空壳页。"
      + "title 用作默认文件名（<title>.pptx，可用 fileName 覆盖）。"
      + "不要在本工具里写任何页面内容——内容全部通过逐页生成完成。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "演示标题（同时是默认文件名）" },
        outline: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SLIDES_PAGES,
          description: "页序蓝图：每页的标题（数组顺序即页序；第 1 项是封面标题；长度即页数上限）。只要标题，不要写页面内容",
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
        fileName: { type: "string", minLength: 6, maxLength: 120, description: "可选文件名，必须以 .pptx 结尾" },
      },
      required: ["title", "outline"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const title = stringArg(args, "title").trim().slice(0, 120);
      const outline = normalizeOutline(args.outline);
      const fileName = optionalFileName(args, ".pptx");
      const pages = [skeletonPageSpec(title, outline[0]!, 0, outline.length)];
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
        pages: 1,
        outline,
        roomId: context.roomId,
        deduped: result.versionDeduped || result.blobDeduped,
        roomRoutingRequested: result.roomRequested,
        nextAction: "fill_pages",
        hint: `文件已创建并正在自动打开（初始只有 1 页骨架）；接下来用 context_room_slides_set_page（fileId=${result.fileEntryId} 或 \"active\"）一页一页生成：先填 slideIndex=0（替换骨架页），此后每页 slideIndex=当前页数，会自动在末尾追加新页；每页成功再继续下一页。`,
      });
    },
  };

  const slidesSetPage: DocumentCapabilityTool = {
    name: "context_room_slides_set_page",
    title: "逐页生成 PPT",
    description: "用一份完整 PageSpec 生成已打开 PPT 的一页：slideIndex 小于当前页数时原地替换该页（旧内容整体丢弃）；"
      + "slideIndex 等于当前页数时在末尾追加新页（页数 +1）。"
      + "这是 PPT 生成的第二步：context_room_slides_create 建好文件（1 页骨架）后，用本工具一页一页生成——"
      + "从 slideIndex=0 起按 0、1、2… 顺序推进，每页等成功结果（用户实时看到该页成形）再继续下一页；"
      + "某页失败只需重试该页，不影响已完成的页；生成到第几页，文件就有几页。"
      + "开启逐页审阅时，成功落页的返回会带 review 字段并以它为准：action=continue 照常填下一页；"
      + "action=revise（附 feedback）说明用户对刚落的这页有修改意见——带着 feedback 对同一 slideIndex 重落一版；"
      + "action=finish 说明用户要求到此为止——停止填页，跑完收尾自检后提交（summary 里如实说明提前收尾）。"
      + `${PAGESPEC_GUIDE}`
      + "刚创建的文件会自动打开，fileId 用 create 返回的 fileEntryId 或 \"active\"。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；\"active\" = 当前打开的那个 PPT" },
        slideIndex: { type: "integer", minimum: 0, maximum: MAX_SLIDES_PAGES - 1, description: "页序号，从 0 开始（第 1 页 = 0）；等于当前页数时表示追加新页" },
        spec: { type: "object", additionalProperties: true, description: "该页完整的 PageSpec 对象（整页替换；elements 按绘制顺序排列）" },
      },
      required: ["fileId", "slideIndex", "spec"],
    },
    annotations: annotations(false, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const fileId = stringArg(args, "fileId").trim();
      const slideIndex = args.slideIndex;
      if (typeof slideIndex !== "number" || !Number.isInteger(slideIndex) || slideIndex < 0) {
        throw new Error("INVALID_REQUEST: slideIndex 必须是非负整数（0 = 第 1 页）");
      }
      const spec = args.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("INVALID_REQUEST: spec 必须是该页完整的 PageSpec 对象");
      }
      const specJson = JSON.stringify(spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        throw new Error(`INVALID_REQUEST: 单页 PageSpec 超过长度上限（${MAX_PAGE_SPEC_LENGTH} 字符），请精简该页`);
      }
      const result = await bridge.fillPage({ fileId, slideIndex, specJson });
      if (!result.ok) throw new Error(`OFFICE_EDIT_FAILED: ${result.error ?? "桌面端填充失败"}`);
      // 逐页审阅闸门（用户决策：每页都停下等确认）：成功落页且闸门对该 run 生效时
      // 挂起等表态；QA 自检替换（回填旧页）在闸门内部直通。revise 时本页内容已在
      // 文件里（用户已实时看到），nextAction 指示 builder 按反馈对同一页重落一版。
      let review: {
        action: "continue" | "revise" | "finish";
        feedback?: string;
        timedOut?: boolean;
      } | null = null;
      if (result.applied === true && slidesGate?.isActive(context.runId)) {
        const decision = await slidesGate.awaitDecision(context.runId, slideIndex);
        review = {
          action: decision.action,
          ...(decision.feedback ? { feedback: decision.feedback } : {}),
          ...(decision.timedOut ? { timedOut: true } : {}),
        };
      }
      const reviewNextAction = review
        ? review.action === "revise"
          ? "regenerate_same_page_with_feedback"
          : review.action === "finish"
            ? "stop_and_submit"
            : "fill_next_page"
        : null;
      return success({
        fileId,
        slideIndex,
        applied: result.applied === true,
        ...(result.records ? { records: result.records } : {}),
        ...(result.failures?.length ? { failures: result.failures } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        ...(result.saved !== undefined ? { saved: result.saved } : {}),
        ...(result.saveError ? { saveError: result.saveError } : {}),
        ...(result.outline ? { outline: result.outline } : {}),
        ...(review ? { review } : {}),
        nextAction: reviewNextAction ?? (result.applied === true ? "fill_next_page" : "fix_spec_and_retry"),
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

  const slidesRead: DocumentCapabilityTool = {
    name: "context_room_slides_read",
    title: "读取 PPT 大纲与操作词汇",
    description: "读取一份已在 Room 产物库打开的 .pptx 产物的大纲与可编辑操作词汇表。"
      + "fileId 缺省（或 \"active\"）= 用户当前打开的那个 PPT，无需知道文件 id。"
      + "大纲列出每页的元素（id | 类型 | 文本摘要），是编辑时定位元素的唯一依据；"
      + "opVocabulary 列出 context_room_slides_edit 可用的全部操作及其签名。"
      + "文件未打开会报错并列出当前打开的 Office 文件；editable=false 表示只读打开（能读大纲，"
      + "要编辑需用户在产物库重新以可编辑方式打开）。"
      + "编辑前先读本工具，之后按大纲里的元素 id 发编辑事务。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；缺省或 \"active\" = 当前打开的那个 PPT" },
      },
      required: [],
    },
    annotations: annotations(true, false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
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
    name: "context_room_slides_edit",
    title: "编辑已打开的 PPT",
    description: "向一份已在 Room 产物库打开的 .pptx 产物应用一个操作事务（ops 数组，原子生效）。"
      + "常用操作：setText/setFont/setFill 改已有元素，addElement/addSlideWithLayout 新增，"
      + "deleteElement/deleteSlide 删除，moveSlide 调序，findReplace 全稿替换，setNotes 备注页；"
      + "完整词汇与签名见 context_room_slides_read 返回的 opVocabulary（每项自带用法，失败信息也会带用法提示）。"
      + "元素用 read 大纲里的 id 定位（target.slide 从 0 计）；一次事务 1~50 个 op。"
      + "编辑会实时显示在用户打开的视图上并自动保存（版本链 +1）。返回新 outline，可直接链式编辑。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileId: { type: "string", minLength: 1, description: "PPT 文件 id（fileEntryId）；\"active\" = 当前打开的那个 PPT" },
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
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
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

  return {
    manifest: manifest("office.create", "mutation", null, null, true, false),
    promptGuidelines: [
      "用户需要正式 Office 文档时按格式选工具：Word 报告/交付物用 context_room_office_create，"
      + "数据表格用 context_room_sheets_create；演示/汇报（PPT）不在本组工具内，一律经 slides_draft 调度 slides 子代理（create 先方案后落页，edit 直改）完成；"
      + "普通笔记、速记、随手总结用文档创建工具（markdown），不要用 Office 工具。",
      "Word 的 html 入参必须是受限 HTML 子集（仅标题/段落/列表/表格/链接/强调/pre/code/blockquote 标签）；"
      + "长文用 h2/h3 分节；表格首行用 th、单元格纯文本；不要输出 markdown 或解释性文字。",
      "Excel 的 sheets→rows 用 JSON 二维数组；数字必须是 JSON number；每个表首行放表头。",
      "生成成功后在回复中告知文件名；桌面端会自动打开预览，文档在 Room 产物库（Office 产物）和文件库可见。",
    ],
    tools: [officeCreate, slidesCreate, slidesSetPage, sheetsCreate, slidesRead, slidesEdit],
  };
}
