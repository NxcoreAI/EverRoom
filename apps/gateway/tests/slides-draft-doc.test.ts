import { describe, expect, it } from "vitest";

import {
  parseDraftMarkdown,
  renderDraftMarkdown,
  slidesProgressPlanFrom,
  type SlidesProgressPlan,
} from "../src/modules/subagents/slides-draft-doc.js";
import { SlidesProgressTracker } from "../src/modules/subagents/slides-progress-tracker.js";

function planFixture(): SlidesProgressPlan {
  return {
    title: "季度经营复盘",
    narrative: "以增长主线回顾季度",
    pages: [
      { title: "Q3 增长超预期", points: ["营收同比 +38%", "新客破千"], data: "营收(万元): 1200, 1650", materialHints: "增长曲线示意", notes: "开场定调页" },
      { title: "渠道结构变化", role: "table", density: "dense", data: "渠道 | 占比\n线上 | 62%\n线下 | 38%" },
      { title: "下一步：聚焦大客户", density: "sparse" },
    ],
    warnings: ["竞品数据缺失"],
  };
}

describe("slidesProgressPlanFrom", () => {
  it("完整方案照常通过，字段截长与白名单按上限执行", () => {
    const plan = slidesProgressPlanFrom(planFixture());
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe("季度经营复盘");
    expect(plan?.pages).toHaveLength(3);
    expect(plan?.pages[1]?.density).toBe("dense");
    expect(plan?.pages[1]?.materials).toBeUndefined();
    expect(plan?.warnings).toEqual(["竞品数据缺失"]);
  });

  it("缺标题或页清单返回 null；非对象输入返回 null", () => {
    expect(slidesProgressPlanFrom({ pages: [{ title: "x" }] })).toBeNull();
    expect(slidesProgressPlanFrom({ title: "t", pages: [] })).toBeNull();
    expect(slidesProgressPlanFrom(null)).toBeNull();
    expect(slidesProgressPlanFrom("plan")).toBeNull();
  });

  it("非法 density 与非法素材链接被剔除，合法 everroom-material:// 保留", () => {
    const plan = slidesProgressPlanFrom({
      title: "t",
      pages: [{
        title: "p",
        density: "ultra",
        materials: [
          { url: "everroom-material://abc", desc: "本地图" },
          { url: "javascript:alert(1)" },
          { url: "https://example.com/a.png" },
        ],
      }],
    });
    expect(plan?.pages[0]?.density).toBeUndefined();
    expect(plan?.pages[0]?.materials).toHaveLength(2);
    expect(plan?.pages[0]?.materials?.[0]?.url).toBe("everroom-material://abc");
  });
});

describe("renderDraftMarkdown → parseDraftMarkdown 往返", () => {
  it("渲染出的草稿解析回原页结构（要点/数据/配图/备注逐页对齐）", () => {
    const original = planFixture();
    const markdown = renderDraftMarkdown(original);
    const parsed = parseDraftMarkdown(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(3);
    expect(parsed?.[0]?.title).toBe("Q3 增长超预期");
    expect(parsed?.[0]?.points).toEqual(["营收同比 +38%", "新客破千"]);
    expect(parsed?.[0]?.data).toBe("营收(万元): 1200, 1650");
    expect(parsed?.[0]?.materialHints).toBe("增长曲线示意");
    expect(parsed?.[0]?.notes).toBe("开场定调页");
    expect(parsed?.[1]?.data).toBe("渠道 | 占比\n线上 | 62%\n线下 | 38%");
    expect(parsed?.[2]?.title).toBe("下一步：聚焦大客户");
  });

  it("用户编辑不破坏解析：插页、删页、改字、调序都按新结构读回", () => {
    const markdown = renderDraftMarkdown(planFixture());
    const edited = [
      "# 无关大标题（不参与页结构）",
      "开头的游离段落会被丢弃",
      "## 新插入的封面页",
      "- 用户新写的要点",
      "",
      "## Q3 增长超预期",
      "- 营收同比 +38%（用户改过）",
      "数据：营收(万元): 1200, 1650",
      "",
      "## 下一步：聚焦大客户",
    ].join("\n");
    const parsed = parseDraftMarkdown(edited);
    expect(parsed).toHaveLength(3);
    expect(parsed?.[0]?.title).toBe("新插入的封面页");
    expect(parsed?.[1]?.points).toEqual(["营收同比 +38%（用户改过）"]);
    expect(parsed?.[2]?.title).toBe("下一步：聚焦大客户");
    expect(parsed?.[2]?.points).toBeUndefined();
  });

  it("表格行并入数据；无任何章节返回 null", () => {
    expect(parseDraftMarkdown("## 页\n| a | b |\n| 1 | 2 |")?.[0]?.data).toBe("| a | b |\n| 1 | 2 |");
    expect(parseDraftMarkdown("没有章节的普通文档")).toBeNull();
    expect(parseDraftMarkdown("")).toBeNull();
  });
});

describe("SlidesProgressTracker", () => {
  it("登记后逐页 notify 广播全量快照，doneCount 只进不退", () => {
    const tracker = new SlidesProgressTracker();
    const plan = planFixture();
    tracker.arm("run-1", plan);
    const events: Array<{ slideIndex: number; doneCount: number }> = [];
    tracker.setRelay("run-1", (event) => {
      expect(event.kind).toBe("page_applied");
      expect(event.snapshot.title).toBe(plan.title);
      expect(event.snapshot.totalPages).toBe(3);
      events.push({ slideIndex: event.slideIndex, doneCount: event.snapshot.doneCount });
    });
    tracker.notify("run-1", 0);
    tracker.notify("run-1", 1);
    // 乱序/重复回调（QA 自检回填旧页）不打退进度。
    tracker.notify("run-1", 0);
    tracker.notify("run-1", 2);
    expect(events.map((event) => event.doneCount)).toEqual([1, 2, 2, 3]);
    expect(events[3]?.slideIndex).toBe(2);
  });

  it("未登记的 run 静默忽略；disarm 后不再广播；dispose 清空全部", () => {
    const tracker = new SlidesProgressTracker();
    expect(() => tracker.notify(undefined, 0)).not.toThrow();
    expect(() => tracker.notify("ghost", 0)).not.toThrow();
    tracker.arm("run-2", planFixture());
    tracker.setRelay("run-2", () => {
      throw new Error("should not relay after disarm");
    });
    tracker.disarm("run-2");
    tracker.notify("run-2", 0);
    tracker.dispose();
    expect(() => tracker.notify("run-2", 1)).not.toThrow();
  });
});
