import { describe, expect, it } from "vitest";
import {
  describeVisualReview,
  SlidesVisualReviewer,
  visualReviewToolPayload,
  type VisualReviewOutcome,
} from "./review.js";
import type { VlmPromptAnalyzer } from "../perception/vlm-client.js";

function fakeVlm(reply: () => unknown): VlmPromptAnalyzer & { calls: number } {
  const analyzer = {
    calls: 0,
    async analyze(): Promise<unknown> {
      analyzer.calls += 1;
      return reply();
    },
  };
  return analyzer as unknown as VlmPromptAnalyzer & { calls: number };
}

const png = (): Promise<Buffer> => Promise.resolve(Buffer.from("fake-png-bytes"));

describe("SlidesVisualReviewer", () => {
  it("vlm 未配置时整体跳过", async () => {
    const reviewer = new SlidesVisualReviewer({ vlm: null });
    const outcome = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(outcome).toEqual({ status: "skipped", reason: "vlm 未配置" });
  });

  it("截图失败降级为 error（放行语义）", async () => {
    const reviewer = new SlidesVisualReviewer({ vlm: fakeVlm(() => ({ pass: true })) });
    const outcome = await reviewer.reviewPage({
      fileId: "f",
      slideIndex: 0,
      fetchPng: () => Promise.reject(new Error("view gone")),
    });
    expect(outcome.status).toBe("error");
  });

  it("verdict pass 直通；VLM 只被调用一次", async () => {
    const vlm = fakeVlm(() => ({ pass: true }));
    const reviewer = new SlidesVisualReviewer({ vlm });
    const outcome = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(outcome).toEqual({ status: "pass" });
    expect(vlm.calls).toBe(1);
  });

  it("首次不通过 retriesExhausted=false；同页第二次仍不通过才置 true", async () => {
    const verdict = () => ({
      pass: false,
      issues: [{ item: "text_overlap", where: "标题与副标题之间", severity: "major" }],
    });
    const reviewer = new SlidesVisualReviewer({ vlm: fakeVlm(verdict) });
    const first = await reviewer.reviewPage({ fileId: "f", slideIndex: 2, fetchPng: png });
    expect(first).toMatchObject({ status: "fail", retriesExhausted: false });
    const second = await reviewer.reviewPage({ fileId: "f", slideIndex: 2, fetchPng: png });
    expect(second).toMatchObject({ status: "fail", retriesExhausted: true });
    // 不同页互不影响。
    const other = await reviewer.reviewPage({ fileId: "f", slideIndex: 3, fetchPng: png });
    expect(other).toMatchObject({ status: "fail", retriesExhausted: false });
  });

  it("forgetDeck 清空该文件计数；重落后再次失败仍给一次重试窗口", async () => {
    const verdict = () => ({ pass: false, issues: [{ item: "low_contrast", where: "右下角", severity: "minor" }] });
    const reviewer = new SlidesVisualReviewer({ vlm: fakeVlm(verdict) });
    await reviewer.reviewPage({ fileId: "deck-1", slideIndex: 0, fetchPng: png });
    await reviewer.reviewPage({ fileId: "deck-1", slideIndex: 0, fetchPng: png });
    reviewer.forgetDeck("deck-1");
    const after = await reviewer.reviewPage({ fileId: "deck-1", slideIndex: 0, fetchPng: png });
    expect(after).toMatchObject({ status: "fail", retriesExhausted: false });
  });

  it("词表外的 item 被过滤；全部无效时按解析失败降级", async () => {
    const reviewer = new SlidesVisualReviewer({
      vlm: fakeVlm(() => ({ pass: false, issues: [{ item: "ugly_font", where: "标题", severity: "major" }] })),
    });
    const outcome = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(outcome.status).toBe("error");
  });

  it("VLM 抛错降级为 error", async () => {
    const reviewer = new SlidesVisualReviewer({
      vlm: fakeVlm(() => {
        throw new Error("HTTP 429");
      }),
    });
    const outcome = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(outcome.status).toBe("error");
  });

  it("惰性解析：函数形态在每次复检时取值，配置后无需重启", async () => {
    let current: ReturnType<typeof fakeVlm> | null = null;
    const reviewer = new SlidesVisualReviewer({ vlm: () => current });
    const before = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(before).toMatchObject({ status: "skipped" });
    current = fakeVlm(() => ({ pass: true }));
    const after = await reviewer.reviewPage({ fileId: "f", slideIndex: 0, fetchPng: png });
    expect(after).toEqual({ status: "pass" });
  });
});

describe("describeVisualReview / visualReviewToolPayload", () => {
  it("pass 与 error 文案", () => {
    expect(describeVisualReview({ status: "pass" })).toBeNull();
    expect(describeVisualReview({ status: "skipped", reason: "vlm 未配置" })).toContain("未启用");
    expect(describeVisualReview({ status: "error", reason: "boom" })).toContain("未完成");
  });

  it("fail 文案含中文问题与位置；超限带放行说明", () => {
    const fail: VisualReviewOutcome = {
      status: "fail",
      retriesExhausted: false,
      issues: [{ item: "text_clipped", where: "底部第三张卡片", severity: "major" }],
    };
    const text = describeVisualReview(fail) ?? "";
    expect(text).toContain("文字被裁");
    expect(text).toContain("底部第三张卡片");
    expect(text).not.toContain("放行");
    expect(describeVisualReview({ ...fail, retriesExhausted: true })).toContain("放行");
  });

  it("工具载荷把 issue 映射为中文键值", () => {
    const payload = visualReviewToolPayload({
      status: "fail",
      retriesExhausted: true,
      issues: [{ item: "text_overlap", where: "标题区", severity: "major" }],
    });
    expect(payload.status).toBe("fail");
    expect(payload.retriesExhausted).toBe(true);
    expect(payload.issues).toEqual([{ 问题: "文字互相重叠", 位置: "标题区" }]);
    expect(visualReviewToolPayload({ status: "pass" })).toEqual({ status: "pass" });
    expect(visualReviewToolPayload({ status: "error", reason: "x" })).toEqual({ status: "error", reason: "x" });
  });
});
