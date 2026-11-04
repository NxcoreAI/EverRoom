import { describe, expect, it } from "vitest";

import type { SlidesProgressPage } from "../src/modules/subagents/slides-draft-doc.js";
import {
  arrangeBatchCheckpointKey,
  arrangeBatchMeta,
  arrangePageIds,
  mergeArrangeBatchPlans,
  planArrangeBatches,
  validateArrangeBatchPlan,
  type ArrangeBatch,
} from "../src/modules/subagents/slides-arrange-batches.js";
import { assignContentSources } from "../src/modules/subagents/slides-semantic-contract.js";

function pagesOf(count: number): SlidesProgressPage[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `第${index + 1}页`,
    points: [`要点${index + 1}`],
  }));
}

function sourcesOf(pages: SlidesProgressPage[], documentId = "doc-1") {
  return assignContentSources(pages, documentId);
}

function batchPlan(batch: ArrangeBatch, overrides: { id?: string; crossPage?: boolean } = {}): Record<string, unknown> {
  const pageIds = arrangePageIds(batch.sources);
  const sourcesByPage = new Map<string, typeof batch.sources>();
  for (const source of batch.sources) {
    const list = sourcesByPage.get(source.pageId) ?? [];
    list.push(source);
    sourcesByPage.set(source.pageId, list);
  }
  const allSourceIds = batch.sources.map((source) => source.id);
  return {
    phase: "arrange",
    title: "全册标题",
    narrative: `第 ${batch.index + 1} 批说明`,
    warnings: [`第 ${batch.index + 1} 批告警`],
    summary: `第 ${batch.index + 1} 批摘要`,
    pages: batch.pages.map((page, index) => {
      const pageSources = sourcesByPage.get(pageIds[index] ?? "") ?? [];
      const contentId = overrides.id && index === 0 ? overrides.id : pageIds[index];
      return {
        title: page.title,
        content: {
          id: contentId,
          sourceRefs: overrides.crossPage && index === 0
            ? [allSourceIds.at(-1)]
            : pageSources.map((source) => source.id),
          role: "content",
          message: page.title,
          blocks: pageSources.map((source, blockIndex) => ({
            id: `block-${index}-${blockIndex}`,
            type: "text",
            text: source.value,
            sourceRefs: [source.id],
            priority: "primary",
            mustShow: true,
          })),
          relations: [],
          focusRefs: pageSources.length > 0 ? [`block-${index}-0`] : [],
          constraints: { verbatimRefs: [] },
          notes: "",
          omissions: [],
        },
      };
    }),
  };
}

describe("planArrangeBatches（切批）", () => {
  it("27 页按 8 页切 → 4 批（7/7/7/6），批内来源与全局页序一一对应", () => {
    const pages = pagesOf(27);
    const sources = sourcesOf(pages);
    const batches = planArrangeBatches({ pages, sources, batchSize: 8 });
    expect(batches).toHaveLength(4);
    expect(batches.map((batch) => batch.pageCount)).toEqual([7, 7, 7, 6]);
    expect(batches.map((batch) => batch.startPageIndex)).toEqual([0, 7, 14, 21]);
    const globalPageIds = arrangePageIds(sources);
    for (const batch of batches) {
      expect(arrangePageIds(batch.sources)).toEqual(
        globalPageIds.slice(batch.startPageIndex, batch.startPageIndex + batch.pageCount),
      );
      expect(batch.pages).toHaveLength(batch.pageCount);
    }
  });

  it("8 页只切 1 批；9 页切 2 批（5/4），避免尾批只剩 1 页", () => {
    expect(planArrangeBatches({ pages: pagesOf(8), sources: sourcesOf(pagesOf(8)), batchSize: 8 })).toHaveLength(1);
    const batches = planArrangeBatches({ pages: pagesOf(9), sources: sourcesOf(pagesOf(9)), batchSize: 8 });
    expect(batches.map((batch) => batch.pageCount)).toEqual([5, 4]);
  });

  it("批次元信息带前后页标题，供模型做跨批承接", () => {
    const pages = pagesOf(10);
    const batches = planArrangeBatches({ pages, sources: sourcesOf(pages), batchSize: 8 });
    const second = arrangeBatchMeta(batches[1]!, pages, "全册标题");
    expect(second).toMatchObject({
      index: 1,
      total: 2,
      startPageIndex: 5,
      pageCount: 5,
      deckTitle: "全册标题",
      previousPageTitles: ["第4页", "第5页"],
    });
    expect(second.nextPageTitle).toBeUndefined();
    const first = arrangeBatchMeta(batches[0]!, pages, "全册标题");
    expect(first.previousPageTitles).toEqual([]);
    expect(first.nextPageTitle).toBe("第6页");
  });
});

describe("validateArrangeBatchPlan（批级确定性校验）", () => {
  const pages = pagesOf(6);
  const batches = planArrangeBatches({ pages, sources: sourcesOf(pages), batchSize: 8 });

  it("合法批结果零错误", () => {
    expect(validateArrangeBatchPlan(batches[0]!, batchPlan(batches[0]!))).toEqual([]);
  });

  it("页数不符 / 缺 content / 跨页来源 / 占用其他页 ID 都判错", () => {
    const plan = batchPlan(batches[0]!) as { pages: Array<Record<string, unknown>> };
    const short = { ...plan, pages: plan.pages.slice(0, 5) };
    expect(validateArrangeBatchPlan(batches[0]!, short).join("|")).toContain("页数不符");

    const missingContent = structuredClone(plan);
    delete missingContent.pages[0]!.content;
    expect(validateArrangeBatchPlan(batches[0]!, missingContent).join("|")).toContain("缺语义 content");

    const crossPage = batchPlan(batches[0]!, { crossPage: true });
    expect(validateArrangeBatchPlan(batches[0]!, crossPage).join("|")).toContain("来源不属于本页");

    const pageIds = arrangePageIds(batches[0]!.sources);
    const collided = batchPlan(batches[0]!, { id: pageIds[1]! });
    expect(validateArrangeBatchPlan(batches[0]!, collided).join("|")).toContain("占用了其他页的 ID");
  });
});

describe("mergeArrangeBatchPlans（确定性合并）", () => {
  it("按批序拼页、标题取确认稿标题、narrative/warnings/summary 去重限长", () => {
    const pages = pagesOf(9);
    const sources = sourcesOf(pages);
    const batches = planArrangeBatches({ pages, sources, batchSize: 8 });
    const results = new Map<number, Record<string, unknown>>([
      [0, batchPlan(batches[0]!)],
      [1, batchPlan(batches[1]!)],
    ]);
    const merged = mergeArrangeBatchPlans({ deckTitle: "确认稿标题", pages, sources, batches, results });
    expect(merged.plan.title).toBe("确认稿标题");
    expect((merged.plan.pages as Array<Record<string, unknown>>).map((page) => page.title)).toEqual(
      pages.map((page) => page.title),
    );
    expect(merged.plan.narrative).toBe("第 1 批说明；第 2 批说明");
    expect(merged.plan.warnings).toEqual(["第 1 批告警", "第 2 批告警"]);
    expect(merged.plan.summary).toBe("第 1 批摘要；第 2 批摘要");
  });

  it("模型写错 content.id 但来源全指向本页时按来源规范化，不升级成整册失败", () => {
    const pages = pagesOf(9);
    const sources = sourcesOf(pages);
    const batches = planArrangeBatches({ pages, sources, batchSize: 8 });
    const results = new Map<number, Record<string, unknown>>([
      [0, batchPlan(batches[0]!, { id: "invented-page-id" })],
      [1, batchPlan(batches[1]!)],
    ]);
    const merged = mergeArrangeBatchPlans({ deckTitle: "确认稿标题", pages, sources, batches, results });
    const first = (merged.plan.pages as Array<{ content: { id: string } }>)[0]!;
    expect(first.content.id).toBe(arrangePageIds(sources)[0]);
    expect(merged.warnings.some((warning) => warning.includes("规范页面 ID"))).toBe(true);
  });
});

describe("arrangeBatchCheckpointKey", () => {
  const base = {
    roomId: "room-1",
    draftDocumentId: "doc-1",
    instruction: "做一份汇报",
    sourcesHash: "hash-a",
    batchSize: 8,
  };

  it("草稿/指令/风格/来源任一变化都换 key；key 与对象键序无关", () => {
    expect(arrangeBatchCheckpointKey(base)).toBe(arrangeBatchCheckpointKey({ ...base }));
    expect(arrangeBatchCheckpointKey(base)).not.toBe(arrangeBatchCheckpointKey({ ...base, instruction: "改一版" }));
    expect(arrangeBatchCheckpointKey(base)).not.toBe(arrangeBatchCheckpointKey({ ...base, sourcesHash: "hash-b" }));
    expect(arrangeBatchCheckpointKey(base)).not.toBe(arrangeBatchCheckpointKey({ ...base, deckStyle: { palette: "dark" } }));
    expect(arrangeBatchCheckpointKey({ ...base, deckStyle: { a: 1, b: 2 } }))
      .toBe(arrangeBatchCheckpointKey({ ...base, deckStyle: { b: 2, a: 1 } }));
  });
});
