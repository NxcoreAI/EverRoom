/**
 * PPT 草稿文档（2026-09 生成流程重设计，替换「逐页审阅闸门」）：
 *
 * 草稿阶段 planner 产出的内容方案 JSON → 渲染成一份可编辑的 Room 文档；
 * 用户在文档里确认/修改内容；generate 阶段把用户改完的文档解析回页结构，
 * 交给 planner arrange 重排。
 *
 * 渲染/解析是一对纯函数。格式约定（同时是用户在编辑器里看到的样子）：
 * - 每个 `## ` 章节 = 一页，章节顺序即页序（不编号，插页删页不破坏解析）
 * - `- ` 列表 = 该页要点
 * - `数据：` 开头的行 = 该页要呈现的数据（后续普通文本行并入）
 * - `|…|` 表格行并入数据
 * - `配图：` 开头的行 = 素材检索提示（arrange 阶段按它检索配图）
 * - 其余普通段落 = 给落页代理的方向备注
 */

/** 单页草稿。 */
export interface SlidesProgressPage {
  /** 页标题（行动标题，即该页结论）。 */
  title: string;
  /** 内容角色提示（cover/data/table/flow…）；仅 arrange 后的方案携带。 */
  role?: string;
  /** 信息密度档：疏=一页一句话大字；中=常规；密=满页数据。仅 arrange 后携带。 */
  density?: "sparse" | "standard" | "dense";
  /** 该页要点。 */
  points?: string[];
  /** 该页要呈现的真实数据。 */
  data?: string;
  /** 素材检索提示（草稿阶段）。 */
  materialHints?: string;
  /** 配图直链/素材引用（arrange 阶段检索后携带）。 */
  materials?: Array<{ url: string; desc?: string }>;
  /** 给落页代理的方向备注。 */
  notes?: string;
}

export interface SlidesProgressPlan {
  title: string;
  narrative?: string;
  pages: SlidesProgressPage[];
  warnings?: string[];
}

/** 渲染/解析上限（与 planner 输出 schema 同口径的防爆量截断）。 */
const MAX_PAGES = 24;
const MAX_POINTS = 8;
const MAX_POINT_CHARS = 200;
const MAX_DATA_CHARS = 2000;
const MAX_HINTS_CHARS = 300;
const MAX_TITLE_CHARS = 80;

/** 方案结构化输出 → 展示载荷（纯函数）：缺标题或页清单视为无效，字段截长防爆量。 */
export function slidesProgressPlanFrom(output: unknown): SlidesProgressPlan | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const plan = output as Record<string, unknown>;
  const title = typeof plan.title === "string" ? plan.title.trim().slice(0, 120) : "";
  const rawPages = Array.isArray(plan.pages) ? plan.pages : [];
  if (!title || rawPages.length === 0) return null;
  const pages = rawPages.slice(0, MAX_PAGES).map((raw): SlidesProgressPage => {
    const page = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const title = typeof page.title === "string" ? page.title.trim().slice(0, MAX_TITLE_CHARS) : "";
    const role = typeof page.role === "string" ? page.role.trim().slice(0, 20) : "";
    const densityOk = page.density === "sparse" || page.density === "standard" || page.density === "dense";
    const density = densityOk ? page.density as SlidesProgressPage["density"] : undefined;
    const points = Array.isArray(page.points)
      ? page.points
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .slice(0, MAX_POINTS)
        .map((item) => item.trim().slice(0, MAX_POINT_CHARS))
      : [];
    const data = typeof page.data === "string" ? page.data.trim().slice(0, MAX_DATA_CHARS) : "";
    const hints = typeof page.materialHints === "string" ? page.materialHints.trim().slice(0, MAX_HINTS_CHARS) : "";
    const rawMaterials = Array.isArray(page.materials) ? page.materials : [];
    const materials = rawMaterials
      .map((raw): { url: string; desc?: string } | null => {
        const material = raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
        const url = typeof material.url === "string" ? material.url.trim().slice(0, 500) : "";
        const desc = typeof material.desc === "string" ? material.desc.trim().slice(0, 200) : "";
        const ok = /^(https?:\/\/|everroom-material:\/\/)/.test(url);
        return ok ? { url, ...(desc ? { desc } : {}) } : null;
      })
      .filter((material): material is { url: string; desc?: string } => material !== null)
      .slice(0, 8);
    const notes = typeof page.notes === "string" ? page.notes.trim().slice(0, 300) : "";
    return {
      title,
      ...(role ? { role } : {}),
      ...(density ? { density } : {}),
      ...(points.length ? { points } : {}),
      ...(data ? { data } : {}),
      ...(hints ? { materialHints: hints } : {}),
      ...(materials.length ? { materials } : {}),
      ...(notes ? { notes } : {}),
    };
  });
  const narrative = typeof plan.narrative === "string" ? plan.narrative.trim().slice(0, 200) : "";
  const warnings = Array.isArray(plan.warnings)
    ? plan.warnings
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .slice(0, 6)
      .map((item) => item.trim().slice(0, 300))
    : [];
  return {
    title,
    pages,
    ...(narrative ? { narrative } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * 方案 JSON → 草稿文档 markdown（build 载荷：服务端 normalize 后落成 Room 文档）。
 * 首章节为封面页；要点行承载页文案，数据/配图行给 arrange 阶段当检索与编排输入。
 */
export function renderDraftMarkdown(plan: SlidesProgressPlan): string {
  const lines: string[] = [];
  for (const page of plan.pages) {
    lines.push(`## ${page.title.trim()}`, "");
    for (const point of page.points ?? []) {
      lines.push(`- ${point}`);
    }
    if (page.points?.length) lines.push("");
    if (page.data) {
      // 每行都带「数据：」前缀，与解析侧对称（逐行匹配合并）。
      for (const row of page.data.split("\n").filter((row) => row.trim())) {
        lines.push(`数据：${row}`);
      }
      lines.push("");
    }
    if (page.materialHints) {
      lines.push(`配图：${page.materialHints}`, "");
    }
    if (page.notes) {
      lines.push(page.notes, "");
    }
    if (lines[lines.length - 1] !== "") lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

interface ParsedPageAccumulator {
  title: string;
  points: string[];
  dataLines: string[];
  hints: string[];
  notes: string[];
}

/**
 * 草稿文档 markdown → 页结构（generate 阶段读回用户确认的草稿）。
 * 容忍用户编辑：无编号页序、插页删页改字都不破坏；无任何 `## ` 章节返回 null。
 */
export function parseDraftMarkdown(markdown: string): SlidesProgressPage[] | null {
  const pages: SlidesProgressPage[] = [];
  const collect = (page: ParsedPageAccumulator): SlidesProgressPage => ({
    title: page.title.slice(0, MAX_TITLE_CHARS),
    ...(page.points.length ? { points: page.points.slice(0, MAX_POINTS).map((p) => p.slice(0, MAX_POINT_CHARS)) } : {}),
    ...(page.dataLines.length ? { data: page.dataLines.join("\n").slice(0, MAX_DATA_CHARS) } : {}),
    ...(page.hints.length ? { materialHints: page.hints.join("；").slice(0, MAX_HINTS_CHARS) } : {}),
    ...(page.notes.length ? { notes: page.notes.join("\n").slice(0, 300) } : {}),
  });
  // current 只在循环体内直接赋值（不经闭包），TS 控制流才能正确收窄。
  let current: ParsedPageAccumulator = { title: "", points: [], dataLines: [], hints: [], notes: [] };
  let hasPage = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("##") && !line.startsWith("###")) {
      if (hasPage) pages.push(collect(current));
      current = { title: line.replace(/^#+\s*/, "").trim(), points: [], dataLines: [], hints: [], notes: [] };
      hasPage = true;
      continue;
    }
    if (line.startsWith("#")) continue; // H1/H3+ 不参与页结构（正文约定从 ## 起）
    if (!hasPage) continue; // 首个章节前的游离内容丢弃
    if (line.startsWith("- ") || line.startsWith("* ")) {
      current.points.push(line.slice(2).trim());
      continue;
    }
    const dataMatch = line.match(/^(?:数据|DATA)[:：]\s*(.*)$/);
    if (dataMatch) {
      const rest = dataMatch[1]?.trim() ?? "";
      if (rest) current.dataLines.push(rest);
      continue;
    }
    const hintMatch = line.match(/^(?:配图|素材|MATERIAL)[:：]\s*(.*)$/);
    if (hintMatch) {
      const rest = hintMatch[1]?.trim() ?? "";
      if (rest) current.hints.push(rest);
      continue;
    }
    if (line.startsWith("|")) {
      current.dataLines.push(line);
      continue;
    }
    current.notes.push(line);
  }
  if (hasPage) pages.push(collect(current));
  return pages.length > 0 ? pages.slice(0, MAX_PAGES) : null;
}
