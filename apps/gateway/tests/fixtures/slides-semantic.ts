import { assignContentSources, type ContentSource, type SemanticPage } from "../../src/modules/subagents/slides-semantic-contract.js";
import { parseDraftMarkdown } from "../../src/modules/subagents/slides-draft-doc.js";

/** 单页最小语义页夹具：来源覆盖整页，一来源一 block、全部 mustShow。 */
export function semanticFixture(title: string, points: string[], relation?: string, role = "content", data?: string) {
  const draft = { title, points, ...(data ? { data } : {}) };
  const sources = assignContentSources([draft], title);
  const page: SemanticPage = {
    id: sources[0]!.pageId, sourceRefs: sources.map(s => s.id), role, message: title,
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text", text: s.value, sourceRefs: [s.id], priority: i === 0 ? "primary" : "supporting", mustShow: true })),
    relations: relation ? [{ type: relation, refs: ["block-1", "block-2"], basis: "来源明确说明的内容关系" }] : [],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  };
  return { name: title, draft, sources, page };
}

/**
 * 给 planner arrange 方案的每页补上合法的语义 content（网关恒走 semantic-v3，
 * 无 content 的 arrange 会被内容契约拒收）。
 *
 * 来源必须与网关用同一份草稿算（pageId 是 documentId+页序+整页内容的 hash），
 * 所以这里从草稿 markdown 解析出 draftPages 再 assignContentSources——与
 * tools.ts 的真实路径同构；测试改草稿正文时 content 自动跟随。
 */
export function withSemanticContent(
  planOrMarkdown: { pages?: Array<Record<string, unknown>> } | string,
  documentId: string,
  overrides?: Array<(page: Record<string, unknown>) => Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const markdown = typeof planOrMarkdown === "string" ? planOrMarkdown : markdownFromPlan(planOrMarkdown);
  const pages = parseDraftMarkdown(markdown, { preserveContent: true }) ?? [];
  const sources = assignContentSources(pages as never, documentId);
  const byPage = new Map<string, ContentSource[]>();
  for (const source of sources) {
    const list = byPage.get(source.pageId) ?? [];
    list.push(source);
    byPage.set(source.pageId, list);
  }
  const pageIds = [...byPage.keys()];
  return pages.map((page, index) => {
    const pageSources = byPage.get(pageIds[index] ?? "") ?? [];
    const content: SemanticPage = {
      id: pageSources[0]?.pageId ?? `page-${index}`,
      sourceRefs: pageSources.map(s => s.id),
      role: index === 0 ? "cover" : (page.data ? "data" : "content"),
      message: typeof page.title === "string" ? page.title : `第 ${index + 1} 页`,
      blocks: pageSources.map((s, i) => ({
        id: `block-${index}-${i}`, type: "text", text: s.value, sourceRefs: [s.id],
        priority: i === 0 ? "primary" as const : "supporting" as const, mustShow: true,
      })),
      relations: [], focusRefs: pageSources.length ? [`block-${index}-0`] : [],
      constraints: { verbatimRefs: [] }, notes: "", omissions: [],
    };
    const base = { title: page.title, ...(page.points ? { points: page.points } : {}), ...(page.data ? { data: page.data } : {}), content };
    return overrides?.[index] ? overrides[index](base) : base;
  });
}

/** 从 plan 形状还原等价 markdown（标题/要点/数据行），保证来源 hash 与网关一致。 */
function markdownFromPlan(plan: { pages?: Array<Record<string, unknown>> }): string {
  return (plan.pages ?? []).map((page) => {
    const lines = [`## ${String(page.title ?? "")}`];
    const points = Array.isArray(page.points) ? (page.points as unknown[]) : [];
    for (const point of points) lines.push(`- ${String(point ?? "")}`);
    if (typeof page.data === "string" && page.data) lines.push(`数据：${page.data}`);
    if (typeof page.materialHints === "string" && page.materialHints) lines.push(`配图：${page.materialHints}`);
    return lines.join("\n");
  }).join("\n\n");
}

function semanticCase(
  name: string,
  draft: Record<string, unknown>,
  build: (sources: ContentSource[], pageId: string) => SemanticPage,
) {
  const sources = assignContentSources([draft] as never, "draft-doc");
  const pageId = sources[0]!.pageId;
  return { name, draft, sources, page: build(sources, pageId) };
}

/**
 * 语义契约样例集（索引在测试中被点名使用）：
 * 0 并列收益 / 1 对照指标 / 6 表格 / 7 单位 / 11 引用。
 */
export const semanticCases = [
  // 0：两个等权要点 → parallel
  semanticCase("并列收益", { title: "平台收益", points: ["部署更快", "维护更简单"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "content" as const, message: "平台收益",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "text" as const, text: sources[1]!.value, sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
      { id: "block-2", type: "text" as const, text: sources[2]!.value, sourceRefs: [sources[2]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [{ type: "parallel" as const, refs: ["block-1", "block-2"], basis: "来源把两项列为等价收益" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 1：两个数据要点 → compares（含数字，数值校验有料）
  semanticCase("交付对照", { title: "交付效率", points: ["交付时间为 90 天", "交付质量为 99.9%"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "content" as const, message: "交付效率",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "text" as const, text: sources[1]!.value, sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
      { id: "block-2", type: "text" as const, text: sources[2]!.value, sourceRefs: [sources[2]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [{ type: "compares" as const, refs: ["block-1", "block-2"], basis: "来源把两项列为对照指标" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 2：流程要点 → precedes
  semanticCase("实施步骤", { title: "实施路径", points: ["第一步盘点资产", "第二步迁移数据", "第三步上线验收"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "flow" as const, message: "实施路径",
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text" as const, text: s.value, sourceRefs: [s.id], priority: i === 0 ? ("primary" as const) : ("supporting" as const), mustShow: true })),
    relations: [{ type: "precedes" as const, refs: ["block-1", "block-2", "block-3"], basis: "来源给出先后顺序" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 3：层级拆解 → contains
  semanticCase("能力分层", { title: "能力结构", points: ["平台层提供编排", "模型层提供推理", "数据层提供素材"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "content" as const, message: "能力结构",
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text" as const, text: s.value, sourceRefs: [s.id], priority: i === 0 ? ("primary" as const) : ("supporting" as const), mustShow: true })),
    relations: [{ type: "contains" as const, refs: ["block-0", "block-1", "block-2", "block-3"], basis: "来源是分层说明" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 4：因果链 → causes
  semanticCase("增长归因", { title: "增长原因", points: ["获客成本下降", "转化率提升"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "content" as const, message: "增长原因",
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text" as const, text: s.value, sourceRefs: [s.id], priority: i === 0 ? ("primary" as const) : ("supporting" as const), mustShow: true })),
    relations: [{ type: "causes" as const, refs: ["block-1", "block-2"], basis: "来源说明两项共同促成增长" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 5：目录 → navigates
  semanticCase("内容目录", { title: "目录", points: ["市场与客户", "产品与交付", "财务与路线"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "toc" as const, message: "目录",
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text" as const, text: s.value, sourceRefs: [s.id], priority: i === 0 ? ("primary" as const) : ("supporting" as const), mustShow: true })),
    relations: [{ type: "navigates" as const, refs: ["block-1", "block-2", "block-3"], basis: "目录给出阅读顺序" }],
    focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 6：结构化表格页（保留全部行列与数值）
  semanticCase("竞品对照表", { title: "竞品对照", points: ["价格 99 元", "竞品 A 价格 129 元"], data: "维度 | 本品 | 竞品A | 竞品B\n价格 | 99 | 129 | 149\n部署 | 3 天 | 14 天 | 7 天" }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "table" as const, message: "竞品对照",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "table" as const, headers: ["维度", "本品", "竞品A", "竞品B"], rows: [["价格", "99", "129", "149"], ["部署", "3 天", "14 天", "7 天"]], sourceRefs: [sources[1]!.id, sources[2]!.id, sources[3]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [{ type: "compares" as const, refs: ["block-0", "block-1"], basis: "表格承载对照关系" }],
    focusRefs: ["block-1"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 7：指标卡（数值+单位与来源逐字一致）
  semanticCase("核心指标", { title: "核心指标", points: ["月活 3200 万", "留存 45%"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "data" as const, message: "核心指标",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "metric" as const, label: "月活", value: 3200, unit: "万", sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
      { id: "block-2", type: "metric" as const, label: "留存", value: "45%", sourceRefs: [sources[2]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [{ type: "supports" as const, refs: ["block-1", "block-2"], basis: "两个指标共同支撑结论" }],
    focusRefs: ["block-1"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 8：图表页（labels/series 与来源数值一致）
  semanticCase("季度营收", { title: "季度营收", points: ["三年连续增长"], data: "2023: 1.2, 2024: 1.8, 2025: 2.6" }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "data" as const, message: "季度营收",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "text" as const, text: sources[1]!.value, sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
      { id: "block-2", type: "chart" as const, labels: ["2023", "2024", "2025"], series: [{ name: "营收", values: [1.2, 1.8, 2.6] }], sourceRefs: [sources[2]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [], focusRefs: ["block-2"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 9：可选 notes 来源 → 移进讲稿并用 omissions 交代
  semanticCase("可选背景", { title: "背景补充", points: ["主要结论一"], notes: "这句话是可以放进讲稿的背景补充" }, (sources, pageId) => ({
    id: pageId, sourceRefs: [sources[0]!.id, sources[1]!.id, sources[2]!.id], role: "content" as const, message: "背景补充",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "text" as const, text: sources[1]!.value, sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [], focusRefs: ["block-0"],
    constraints: { verbatimRefs: [] },
    notes: "这句话是可以放进讲稿的背景补充",
    omissions: [{ sourceRef: sources[2]!.id, reason: "背景说明进讲稿", disposition: "notes" as const }],
  })),
  // 10：封面页
  semanticCase("封面", { title: "季度汇报", points: ["2026 年第三季度"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "cover" as const, message: "季度汇报",
    blocks: sources.map((s, i) => ({ id: `block-${i}`, type: "text" as const, text: s.value, sourceRefs: [s.id], priority: i === 0 ? ("primary" as const) : ("supporting" as const), mustShow: true })),
    relations: [], focusRefs: ["block-0"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  })),
  // 11：引用页（quotation 文本必须与来源原文一致）
  semanticCase("质量引用", { title: "质量主张", points: ["质量是产品的一部分。"] }, (sources, pageId) => ({
    id: pageId, sourceRefs: sources.map(s => s.id), role: "quote" as const, message: "质量主张",
    blocks: [
      { id: "block-0", type: "text" as const, text: sources[0]!.value, sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true },
      { id: "block-1", type: "quotation" as const, text: sources[1]!.value, sourceRefs: [sources[1]!.id], priority: "supporting" as const, mustShow: true },
    ],
    relations: [{ type: "supports" as const, refs: ["block-0", "block-1"], basis: "引用支撑标题主张" }],
    focusRefs: ["block-1"], constraints: { verbatimRefs: [sources[1]!.id] }, notes: "", omissions: [],
  })),
] as const;

/** 端到端评估用的完整草稿（含多行 data 与 materialHints）。 */
export const semanticDrafts = [
  {
    name: "BP 竞品与财务",
    pages: [
      { title: "封面", points: ["智能空间操作系统"] },
      { title: "竞品对照", points: ["价格 99 元", "竞品 A 价格 129 元"], data: "维度 | 本品 | 竞品A\n价格 | 99 | 129\n部署 | 3 天 | 14 天" },
      { title: "财务预测", points: ["三年营收预测"], data: "营收(亿元): 1.2, 1.8, 2.6" },
    ],
  },
  {
    name: "发布会叙事",
    pages: [
      { title: "开场", points: ["让空间理解人"] },
      { title: "三个能力", points: ["感知", "编排", "生成"], materialHints: "三联图标示意，亮色背景" },
      { title: "收尾", points: ["即刻体验"] },
    ],
  },
];
