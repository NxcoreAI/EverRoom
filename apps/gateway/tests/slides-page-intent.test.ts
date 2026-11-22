import { describe, expect, it } from "vitest";
import { instructionPageIntent } from "../src/modules/subagents/tools.js";

describe("instructionPageIntent：指令里的显式页数", () => {
  it.each([
    ["严格一页：把四段草稿合并为一张投资人速览页", 1],
    ["生成单页速览", 1],
    ["做成两页", 2],
    ["展开为 3 页", 3],
    ["目标 12 页", 12],
    ["把 20 页内容压到 8 页", 8],
  ])("%s → %i", (instruction, expected) => {
    expect(instructionPageIntent(instruction)).toBe(expected);
  });

  it.each([
    ["根据已确认的内容稿生成演示文稿"],
    ["每页要点不超过 3 条"],
    ["参考 BP 第 26 页的数据"],
    ["四十页的详细版"], // 复合中文数字不识别，宁缺勿错
  ])("%s → undefined", (instruction) => {
    expect(instructionPageIntent(instruction)).toBeUndefined();
  });
});
