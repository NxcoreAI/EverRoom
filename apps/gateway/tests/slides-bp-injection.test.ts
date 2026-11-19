import { describe, expect, it } from "vitest";
import { validateSlidesDraftTaskParams } from "../src/modules/subagents/tools.js";

describe("slides_draft bpTemplate parameter validation", () => {
  it("accepts draft task with bpTemplate field", () => {
    expect(() =>
      validateSlidesDraftTaskParams({
        task: "draft",
        instruction: "为项目生成 BP",
        bpTemplate: {
          trackId: "T01",
          stage: "growth",
          keyJudgement: "客户会持续付费",
          addonIds: ["AI与数据能力"],
        },
      }),
    ).not.toThrow();
  });

  it("rejects bpTemplate on non-draft tasks (parameter gate)", () => {
    expect(() =>
      validateSlidesDraftTaskParams({
        task: "edit",
        instruction: "修改第三页",
        bpTemplate: { trackId: "T01", stage: "growth", keyJudgement: "x" },
      }),
    ).toThrow("slides_draft_parameter_not_allowed");
  });
});
