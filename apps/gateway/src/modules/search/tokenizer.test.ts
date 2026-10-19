import { describe, expect, it } from "vitest";
import { isSingleCharQuery, tokenize, tokenizeJoined } from "./tokenizer.js";

describe("tokenize", () => {
  it("中文连续段切两字滑窗", () => {
    expect(tokenize("定价方案")).toEqual(["定价", "价方", "方案"]);
  });

  it("两字词就是单个 token", () => {
    expect(tokenize("会议")).toEqual(["会议"]);
  });

  it("单字成 token", () => {
    expect(tokenize("图")).toEqual(["图"]);
  });

  it("英文词保留整词并补字符 bigram", () => {
    const tokens = tokenize("EverRoom");
    expect(tokens[0]).toBe("everroom");
    expect(tokens).toContain("ev");
    expect(tokens).toContain("om");
  });

  it("两字母英文词不补 bigram", () => {
    expect(tokenize("ai")).toEqual(["ai"]);
  });

  it("数字串保整串", () => {
    expect(tokenize("v2.0.1")).toEqual(["v2", "0", "1"]);
    expect(tokenize("13700001111")).toEqual(["13700001111"]);
  });

  it("中英混排分段处理", () => {
    const tokens = tokenize("PPT模板定价");
    expect(tokens).toContain("ppt");
    expect(tokens).toContain("模板");
    expect(tokens).toContain("板定");
    expect(tokens).toContain("定价");
  });

  it("标点切断分段、不产生跨标点 bigram", () => {
    expect(tokenize("你好，世界！")).toEqual(["你好", "世界"]);
  });

  it("全大写归小写", () => {
    expect(tokenize("OKR")).toEqual(["okr", "ok", "kr"]);
  });

  it("tokenizeJoined 去重合并", () => {
    expect(tokenizeJoined("定价 定价")).toBe("定价");
  });

  it("空输入返回空串", () => {
    expect(tokenizeJoined("  ，。 ")).toBe("");
  });
});

describe("isSingleCharQuery", () => {
  it("单字为 true", () => {
    expect(isSingleCharQuery(" 定 ")).toBe(true);
  });

  it("两字为 false", () => {
    expect(isSingleCharQuery("定价")).toBe(false);
  });

  it("英文单词为 false", () => {
    expect(isSingleCharQuery("plan")).toBe(false);
  });
});
