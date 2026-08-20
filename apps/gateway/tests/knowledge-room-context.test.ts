import { describe, expect, it } from "vitest";

import { parseRoomContextResponse } from "../src/modules/knowledge/llm.js";

describe("Room context synthesis", () => {
  it("keeps explicit structured details and drops incomplete tasks or meetings", () => {
    const result = parseRoomContextResponse(JSON.stringify({
      overview: "该 Room 聚焦星港项目的方案评审与交付。",
      status: "方案已进入评审阶段。",
      nextSteps: ["确认评审意见", "确认评审意见", 42],
      entities: [{ name: "星港项目", kind: "项目", description: "当前交付项目" }],
      actionItems: [
        { title: "周五前提交修改稿", owner: "林薇", dueDate: "周五", sourceTitle: "评审纪要" },
        { title: "缺少来源", owner: null, dueDate: null },
      ],
      meetings: [
        { title: "复盘会", when: "2026-08-21 10:30", participants: ["林薇"], sourceTitle: "评审纪要" },
        { title: "没有明确时间", when: "", participants: [], sourceTitle: "评审纪要" },
      ],
    }));

    expect(result.overview).toBe("该 Room 聚焦星港项目的方案评审与交付。")
    expect(result.status).toBe("方案已进入评审阶段。")
    expect(result.nextSteps).toEqual(["确认评审意见"])
    expect(result.actionItems).toHaveLength(1)
    expect(result.meetings).toHaveLength(1)
    expect(result.entities[0]).toMatchObject({ name: "星港项目", kind: "项目" })
  });
});
