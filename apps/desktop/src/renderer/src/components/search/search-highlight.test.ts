import { describe, expect, it } from "vitest";
import { splitHighlight } from "./search-highlight";

describe("splitHighlight", () => {
  it("无查询词整段不标亮", () => {
    expect(splitHighlight("定价方案", "")).toEqual([{ text: "定价方案", hit: false }]);
  });

  it("单命中词分三段", () => {
    expect(splitHighlight("我们的定价方案如下", "定价")).toEqual([
      { text: "我们的", hit: false },
      { text: "定价", hit: true },
      { text: "方案如下", hit: false },
    ]);
  });

  it("多词多次命中", () => {
    const segments = splitHighlight("定价与定价", "定价");
    expect(segments).toEqual([
      { text: "定价", hit: true },
      { text: "与", hit: false },
      { text: "定价", hit: true },
    ]);
  });

  it("大小写不敏感", () => {
    const segments = splitHighlight("EverRoom mac", "everroom");
    expect(segments[0]).toEqual({ text: "EverRoom", hit: true });
  });

  it("空文本返回空段", () => {
    expect(splitHighlight("", "定")).toEqual([{ text: "", hit: false }]);
  });
});
