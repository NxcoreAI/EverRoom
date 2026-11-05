/**
 * pptx skill 执行器：把 slides-layouter 交回的 pptxgenjs 页面规格（operations 指令序列，
 * 见 agents/slides-layouter/SYSTEM.md「页面规格」）转换成引擎 PageSpec——fillPage /
 * renderPptx / checkSemanticRendered 全部按 PageSpec 消费，落页与自审链路因此原样复用。
 *
 * 坐标口径：operations 用英寸（pptxgenjs LAYOUT_WIDE 13.33×7.5），PageSpec 用画布像素
 * （CANVAS_W×CANVAS_H = 1280×720，即 96dpi）。色号反向：operations 是 6 位裸 hex，
 * PageSpec 带 `#` 前缀（透明度 8 位后缀）。
 */
import type {
  PageSpec,
  SpecElement,
  SpecParagraph,
  SpecRun,
  TableCell,
} from "../slides-layout/elements.js";
import { CANVAS_H, CANVAS_W } from "../slides-layout/grid.js";

export interface PptxGenJsPage {
  kind: "pptxgenjs-page";
  layout?: string;
  background?: string;
  operations: Array<Record<string, unknown>>;
}

export function isPptxGenJsPage(value: unknown): value is PptxGenJsPage {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "pptxgenjs-page"
    && Array.isArray((value as Record<string, unknown>).operations);
}

const PX_PER_IN = CANVAS_W / 13.33;

/** 像素取整并夹在画布内（越界在校验期已拒；这里兜底防 1px 舍入溢出）。 */
function px(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(max, Math.round(n * PX_PER_IN)));
}

/** 6 位裸 hex → `#RRGGBB`；transparency(0-100) → `#RRGGBBAA`。 */
function hashColor(color: unknown, transparency?: unknown): string | undefined {
  if (typeof color !== "string" || !/^[0-9A-Fa-f]{6}$/.test(color)) return undefined;
  const alpha = typeof transparency === "number" && Number.isFinite(transparency)
    ? Math.round((1 - Math.min(1, Math.max(0, transparency / 100))) * 255)
    : null;
  return `#${color.toUpperCase()}${alpha === null ? "" : alpha.toString(16).padStart(2, "0")}`;
}

/** operations 的 options.fill 兼容 pptxgenjs 两种写法：字符串或 { color, transparency }。 */
function fillOf(options: Record<string, unknown>): string | undefined {
  const fill = options.fill;
  if (typeof fill === "string") return hashColor(fill);
  if (fill !== null && typeof fill === "object") {
    const f = fill as Record<string, unknown>;
    return hashColor(f.color, f.transparency);
  }
  return undefined;
}

function frameOf(options: Record<string, unknown>): { x: number; y: number; w: number; h: number } {
  return {
    x: px(options.x, CANVAS_W),
    y: px(options.y, CANVAS_H),
    w: px(options.w, CANVAS_W),
    h: px(options.h, CANVAS_H),
  };
}

/** addText 的 runs（pptxgenjs 行内混排 [{ text, options }]）→ SpecRun[]。 */
function runsOf(op: Record<string, unknown>): SpecRun[] {
  const options = (op.options ?? {}) as Record<string, unknown>;
  const flat = (text: string, o: Record<string, unknown>): SpecRun => ({
    text,
    ...(typeof o.fontSize === "number" ? { sizePt: o.fontSize } : {}),
    ...(o.bold === true ? { bold: true } : {}),
    ...(o.italic === true ? { italic: true } : {}),
    ...(hashColor(o.color) !== undefined ? { color: hashColor(o.color)! } : {}),
    ...(typeof o.fontFace === "string" ? { font: o.fontFace } : {}),
  });
  if (Array.isArray(op.runs)) {
    return (op.runs as Array<Record<string, unknown>>).flatMap((run) => {
      const text = typeof run.text === "string" ? run.text : "";
      return text ? [flat(text, (run.options ?? {}) as Record<string, unknown>)] : [];
    });
  }
  const text = typeof op.text === "string" ? op.text : "";
  return text ? [flat(text, options)] : [];
}

const SHAPE_MAP: Record<string, string> = {
  rect: "rect",
  rectangle: "rect",
  roundRect: "roundRect",
  ellipse: "ellipse",
  oval: "ellipse",
  circle: "ellipse",
  line: "line",
  lineArrow: "lineArrow",
  rightArrow: "rightArrow",
  chevron: "chevron",
  triangle: "triangle",
  diamond: "diamond",
};

const CHART_MAP: Record<string, string> = {
  bar: "bar",
  bar3d: "bar",
  horizontalBar: "bar",
  line: "line",
  area: "area",
  pie: "pie",
  doughnut: "doughnut",
  scatter: "scatter",
  radar: "bar",
};

export interface PptxExecResult {
  spec: PageSpec;
  /** 无法映射的指令/字段：不阻塞落页，随页 warnings 上报。 */
  warnings: string[];
}

/** 一页 operations → PageSpec。指令已在提交校验过白名单，这里只做忠实映射。 */
export function pageSpecFromOperations(page: PptxGenJsPage): PptxExecResult {
  const warnings: string[] = [];
  const elements: SpecElement[] = [];
  let notes: string | undefined;

  for (const [index, raw] of page.operations.entries()) {
    const op = raw as Record<string, unknown>;
    const options = (op.options ?? {}) as Record<string, unknown>;
    switch (op.op) {
      case "addText": {
        const runs = runsOf(op);
        if (runs.length === 0) { warnings.push(`operations[${index}] addText 无有效文本，已跳过`); break; }
        const paragraph: SpecParagraph = {
          runs,
          align: options.align === "center" || options.align === "right" ? options.align : "left",
          ...(options.bullet === true ? { bullet: true } : {}),
        };
        elements.push({
          type: "text",
          ...frameOf(options),
          paragraphs: [paragraph],
          valign: options.valign === "middle" || options.valign === "bottom" ? options.valign : "top",
        });
        break;
      }
      case "addShape": {
        const shape = SHAPE_MAP[String(op.shapeType ?? "")];
        if (!shape) { warnings.push(`operations[${index}] shapeType "${String(op.shapeType)}" 无映射，已跳过`); break; }
        const line = options.line as Record<string, unknown> | undefined;
        const stroke = line && typeof line === "object" && typeof line.color === "string"
          ? { color: hashColor(line.color) ?? "#000000", widthPt: typeof line.width === "number" ? line.width : 1 }
          : undefined;
        const frame = frameOf(options);
        // roundRect 圆角：rectRadius（英寸）→ OOXML adj（短边百分比 ×1000，50000=短边一半）。
        const radius = typeof options.rectRadius === "number" ? options.rectRadius : undefined;
        const shortSide = Math.min(frame.w, frame.h);
        const adj = shape === "roundRect" && radius !== undefined && shortSide > 0
          ? Math.max(0, Math.min(50000, Math.round((radius * PX_PER_IN) / shortSide * 100000)))
          : undefined;
        elements.push({
          type: "shape",
          shape,
          ...frame,
          ...(fillOf(options) !== undefined ? { fill: fillOf(options)! } : {}),
          ...(stroke !== undefined ? { stroke } : {}),
          ...(adj !== undefined ? { adj } : {}),
        });
        break;
      }
      case "addChart": {
        const chart = CHART_MAP[String(op.chartType ?? "")];
        const data = Array.isArray(op.data) ? (op.data as Array<Record<string, unknown>>) : [];
        const first = data[0];
        if (!chart || !first || !Array.isArray(first.labels)) {
          warnings.push(`operations[${index}] addChart 缺少可映射数据，已跳过`);
          break;
        }
        const series = data.flatMap((s) => {
          const name = typeof s.name === "string" ? s.name : "";
          const values = Array.isArray(s.values) ? s.values.map(Number) : [];
          return name && values.length ? [{ name, values }] : [];
        });
        if (series.length === 0) { warnings.push(`operations[${index}] addChart 无有效系列，已跳过`); break; }
        const colors = Array.isArray(options.chartColors)
          ? (options.chartColors as unknown[]).flatMap(c => { const h = hashColor(c); return h ? [h] : []; })
          : undefined;
        const axis = {
          ...(typeof options.catAxisLabelColor === "string" && hashColor(options.catAxisLabelColor) !== undefined ? { labelColor: hashColor(options.catAxisLabelColor)! } : {}),
          ...(typeof options.catAxisLabelFontSize === "number" ? { labelSizePt: options.catAxisLabelFontSize } : {}),
          ...(typeof options.valAxisLabelColor === "string" && hashColor(options.valAxisLabelColor) !== undefined ? { gridColor: hashColor(options.valAxisLabelColor)! } : {}),
          ...(typeof options.dataLabelColor === "string" && hashColor(options.dataLabelColor) !== undefined ? { dataLabelColor: hashColor(options.dataLabelColor)! } : {}),
          ...(typeof options.dataLabelFontSize === "number" ? { dataLabelSizePt: options.dataLabelFontSize } : {}),
          ...(typeof options.legendColor === "string" && hashColor(options.legendColor) !== undefined ? { legendColor: hashColor(options.legendColor)! } : {}),
          ...(typeof options.legendFontSize === "number" ? { legendSizePt: options.legendFontSize } : {}),
        };
        elements.push({
          type: "chart",
          chart,
          ...frameOf(options),
          categories: (first.labels as unknown[]).map(String),
          series,
          ...(colors !== undefined && colors.length > 0 ? { colors } : {}),
          ...(options.showValue === true ? { dataLabels: true } : {}),
          ...(options.showLegend === true ? { legend: true } : {}),
          ...(Object.keys(axis).length > 0 ? { axis } : {}),
        });
        break;
      }
      case "addTable": {
        if (!Array.isArray(op.rows) || op.rows.length === 0) { warnings.push(`operations[${index}] addTable 无行，已跳过`); break; }
        const rows: TableCell[][] = (op.rows as unknown[]).map((row) =>
          Array.isArray(row)
            ? (row as unknown[]).map((cell): TableCell => {
              if (typeof cell === "string" || typeof cell === "number") return String(cell);
              const c = cell as Record<string, unknown>;
              const co = (c.options ?? {}) as Record<string, unknown>;
              const text = typeof c.text === "string" ? c.text : "";
              const fill = fillOf(co);
              return {
                text,
                ...(co.bold === true ? { bold: true } : {}),
                ...(hashColor(co.color) !== undefined ? { color: hashColor(co.color)! } : {}),
                ...(fill !== undefined ? { fill } : {}),
                align: co.align === "center" || co.align === "right" ? co.align : "left",
                ...(typeof co.span === "number" ? { span: co.span } : {}),
              };
            })
            : [],
        );
        elements.push({
          type: "table",
          ...frameOf(options),
          rows: rows.filter(r => r.length > 0),
          ...(Array.isArray(options.colW) ? { colWidths: (options.colW as unknown[]).map(Number) } : {}),
          ...(typeof options.fontSize === "number" ? { fontSize: options.fontSize } : {}),
        });
        break;
      }
      case "addImage": {
        const url = typeof options.path === "string" ? options.path
          : typeof options.url === "string" ? options.url
          : typeof op.url === "string" ? op.url : undefined;
        if (!url) { warnings.push(`operations[${index}] addImage 无 url/path，已跳过`); break; }
        const sizing = options.sizing as Record<string, unknown> | undefined;
        elements.push({
          type: "image",
          ...frameOf(options),
          url,
          fit: sizing?.type === "contain" ? "contain" : "cover",
        });
        break;
      }
      case "addNotes": {
        notes = typeof op.notes === "string" ? op.notes : notes;
        break;
      }
      default:
        warnings.push(`operations[${index}] op "${String(op.op)}" 不在执行器映射内，已跳过`);
        break;
    }
  }

  const background = hashColor(page.background);
  const spec: PageSpec = {
    ...(background !== undefined ? { background } : {}),
    ...(notes !== undefined && notes.trim() ? { notes } : {}),
    elements,
  };
  return { spec, warnings };
}
