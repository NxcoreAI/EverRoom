import { describe, expect, it } from "vitest";
import {
  analyzeWritingStyle,
  deriveWritingStyleProfile,
  freshAggregate,
  meetsSupport,
  mergeSketchStats,
} from "../src/modules/writing-style/analyzer.js";

function paragraph(text: string): unknown {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function doc(...blocks: unknown[]): unknown {
  return { type: "doc", content: blocks };
}

/** 稳定篇幅的中文语料（≥500 字符以满足资格门槛的量级；seed 加倍提高词频区分度）。 */
function chineseBody(seed: string, sentences = 40): unknown {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    parts.push(`${seed}${seed}模块的接口设计遵循渐进披露原则，先给出最小可用集合，再按需补充高级选项。`);
  }
  return doc(paragraph(parts.join("")));
}

describe("analyzeWritingStyle", () => {
  it("统计句长分桶、问句与感叹句", () => {
    const stats = analyzeWritingStyle(doc(
      paragraph("短句。这里是一个明显偏长的句子，用来验证分桶逻辑能够正确落到中部与尾部的桶里，同时也顺带验证标点统计。真的吗？太好了！"),
    ));
    expect(stats.sentences.count).toBeGreaterThanOrEqual(3);
    expect(stats.sentences.question).toBe(1);
    expect(stats.sentences.exclamation).toBe(1);
    expect(stats.sentences.lengthBuckets.reduce((sum, value) => sum + value, 0)).toBe(stats.sentences.count);
  });

  it("统计顿号/逗号标点", () => {
    const stats = analyzeWritingStyle(doc(paragraph("列表甲、列表乙、列表丙，以及半角,逗号。")));
    expect(stats.punctuation.dun).toBe(2);
    expect(stats.punctuation.commaFull).toBe(1);
    expect(stats.punctuation.commaHalf).toBe(1);
  });

  it("统计结构块与开篇/收尾模式", () => {
    const stats = analyzeWritingStyle(doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
      paragraph("以下是本篇的概要说明。"),
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("跟进事项")] }] },
    ));
    expect(stats.structure.blockCounts.heading2).toBe(1);
    expect(stats.structure.blockCounts.listTask).toBe(1);
    expect(stats.structure.opening.heading).toBe(1);
    expect(stats.structure.closing.listTask).toBe(1);
    expect(stats.structure.closing.closingActionItems).toBe(1);
  });

  it("中文 2-gram 提取且过滤停用字", () => {
    const stats = analyzeWritingStyle(chineseBody("风控"));
    const tokens = new Map(stats.tokens);
    expect(tokens.get("风控")).toBeGreaterThan(0);
    expect(tokens.get("的接")).toBeUndefined();
  });

  it("连接词命中", () => {
    const stats = analyzeWritingStyle(doc(paragraph("因此先做一期。所以砍掉范围。不过文档里已经写了。然而没人看。综上收工。")));
    expect(stats.sentences.connectives.因此).toBe(1);
    expect(stats.sentences.connectives.综上).toBe(1);
  });

  it("字数统计", () => {
    const stats = analyzeWritingStyle(chineseBody("风控", 40));
    expect(stats.charCount).toBeGreaterThanOrEqual(500);
  });
});

describe("merge 与派生", () => {
  it("合并满足交换律", () => {
    const a = analyzeWritingStyle(chineseBody("风控", 30));
    const b = analyzeWritingStyle(chineseBody("网关", 30));
    const ab = mergeSketchStats(mergeSketchStats(freshAggregate(), a), b);
    const ba = mergeSketchStats(mergeSketchStats(freshAggregate(), b), a);
    expect(ab).toEqual(ba);
  });

  it("单篇高频词不满足支持度，两篇同词才进摘要", () => {
    const a = analyzeWritingStyle(chineseBody("风控", 30));
    const b = analyzeWritingStyle(chineseBody("风控", 30));
    const aggregate = mergeSketchStats(mergeSketchStats(freshAggregate(), a), b);
    const derived = deriveWritingStyleProfile(aggregate);
    expect(meetsSupport(1, 1)).toBe(false);
    expect(meetsSupport(2, 2)).toBe(true);
    expect(derived.supportedTokens.some((entry) => entry.token === "风控")).toBe(true);

    const single = deriveWritingStyleProfile(mergeSketchStats(freshAggregate(), a));
    expect(single.supportedTokens.some((entry) => entry.token === "风控")).toBe(false);
  });

  it("置信分层：0 篇 empty、<3 篇 sparse、≥10 篇且字数充足 mature", () => {
    expect(deriveWritingStyleProfile(freshAggregate()).confidenceTier).toBe("empty");
    const one = mergeSketchStats(freshAggregate(), analyzeWritingStyle(chineseBody("甲", 40)));
    expect(deriveWritingStyleProfile(one).confidenceTier).toBe("sparse");
    let many = freshAggregate();
    for (let i = 0; i < 12; i += 1) {
      many = mergeSketchStats(many, analyzeWritingStyle(chineseBody(`词${i}`, 60)));
    }
    expect(deriveWritingStyleProfile(many).confidenceTier).toBe("mature");
  });

  it("sections 三维度在大语料下有产出", () => {
    let aggregate = freshAggregate();
    for (let i = 0; i < 10; i += 1) {
      aggregate = mergeSketchStats(aggregate, analyzeWritingStyle(chineseBody(`领域${i}`, 80)));
    }
    const derived = deriveWritingStyleProfile(aggregate);
    expect(derived.sections.vocabulary.length + derived.sections.sentence.length + derived.sections.structure.length).toBeGreaterThan(0);
    expect(derived.supportedTokens.length).toBeGreaterThan(0);
  });
});
