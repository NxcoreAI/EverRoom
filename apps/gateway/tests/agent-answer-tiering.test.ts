import { describe, expect, it } from "vitest";
import { splitAgentAnswer } from "../src/modules/agent/answer-tiering.js";

describe("splitAgentAnswer（[[details]] 分级解析）", () => {
  it("无标记：hasDetails=false，display 与 content 同源（display 为 trim 后）", () => {
    const raw = "已生成《报告.docx》。结论一句话。";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(false);
    expect(out.displayContent).toBe(raw);
    expect(out.content).toBe(raw);
  });

  it("标准标记：display=标记前，content=去标记行、前后拼接保留", () => {
    const raw = "已生成《报告.docx》。\n\n结论：两家公司无关联。\n\n[[details]]\n报告分七章：\n1. 核心结论\n2. 基本情况";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(true);
    expect(out.displayContent).toBe("已生成《报告.docx》。\n\n结论：两家公司无关联。");
    expect(out.content).toBe("已生成《报告.docx》。\n\n结论：两家公司无关联。\n\n报告分七章：\n1. 核心结论\n2. 基本情况");
  });

  it("标记行容忍前后空白与 CRLF", () => {
    const raw = "正文一句。\r\n  [[details]]  \r\n细节 A。";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(true);
    expect(out.displayContent).toBe("正文一句。");
    expect(out.content).toContain("细节 A。");
    expect(out.content).not.toContain("[[details]]");
  });

  it("标记后为空：content 就是正文，不残留空段", () => {
    const raw = "只有正文。\n[[details]]\n";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(true);
    expect(out.displayContent).toBe("只有正文。");
    expect(out.content).toBe("只有正文。");
  });

  it("只取第一个标记：正文里出现两次标记时，第二次视为详情内容", () => {
    const raw = "正文。\n[[details]]\n详情一。\n[[details]]\n详情二。";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(true);
    expect(out.displayContent).toBe("正文。");
    expect(out.content).toContain("[[details]]");
    expect(out.content).toContain("详情二。");
  });

  it("行内出现的标记词（不在独立行）不触发分级", () => {
    const raw = "参见 [[details]] 说明。";
    const out = splitAgentAnswer(raw);
    expect(out.hasDetails).toBe(false);
  });

  it("空串与脏输入安全退化", () => {
    expect(splitAgentAnswer("").hasDetails).toBe(false);
    expect(splitAgentAnswer("").displayContent).toBe("");
    // @ts-expect-error 防御非字符串
    expect(splitAgentAnswer(null).hasDetails).toBe(false);
  });
});
