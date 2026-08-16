import { describe, expect, it } from "vitest";
import {
  bigramDiceSimilarity,
  documentTerms,
  roomTerms,
  scoreEntityMatches,
  tokenize,
} from "../src/modules/knowledge/entity-index.js";
import {
  advanceCentroid,
  blendCentroid,
  cosineSimilarity,
  decodeCentroid,
  encodeCentroid,
  rankByCentroids,
} from "../src/modules/knowledge/embedding.js";
import { parseArbitrationResponse, type ArbitrationDossier } from "../src/modules/knowledge/llm.js";
import { fallbackSummary } from "../src/modules/knowledge/router.js";

describe("③ entity layer", () => {
  it("tokenizes CJK into bigrams and latin into lowercase words, dropping stopwords", () => {
    const tokens = tokenize("Q3 营销方案评审 the 以及项目排期");
    expect(tokens).toContain("营销");
    expect(tokens).toContain("销方");
    expect(tokens).toContain("q3");
    expect(tokens).toContain("以及项目排期"); // ≥3 字整段词也入表（⑤ 卷宗可读性）
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("以及");
  });

  it("weights title tokens double and keeps first-seen body tokens once", () => {
    const terms = documentTerms("发布会", "发布会纪要与答疑");
    expect(terms.get("发布")).toBe(2);
    expect(terms.get("纪要")).toBe(1);
  });

  it("scores rooms by IDF: an exclusive token outweighs a token every room has", () => {
    // Room A 独占"卫星"，A/B 共享"评审"
    const sets = new Map([
      ["a", roomTerms(["卫星评审", "轨道计算"])],
      ["b", roomTerms(["评审流程", "发布节奏"])],
    ]);
    const terms = documentTerms("卫星评审", "");
    const scores = scoreEntityMatches(terms, sets, 5);
    const roomA = scores.find((score) => score.roomId === "a")!;
    const matchedA = new Map(roomA.matched.map((match) => [match.token, match.weight]));
    expect(matchedA.get("卫星")!).toBeGreaterThan(matchedA.get("评审")!);
    expect(scores[0]!.roomId).toBe("a");
  });

  it("caps results at topN sorted descending", () => {
    const sets = new Map([
      ["a", roomTerms(["阿尔法"])],
      ["b", roomTerms(["贝塔"])],
      ["c", roomTerms(["伽马"])],
    ]);
    const scores = scoreEntityMatches(documentTerms("阿尔法 贝塔 伽马", ""), sets, 2);
    expect(scores).toHaveLength(2);
    expect(scores[0]!.score).toBeGreaterThanOrEqual(scores[1]!.score);
  });

  it("detects near-duplicate room names via bigram Dice while ignoring order/case", () => {
    expect(bigramDiceSimilarity("Q3 营销复盘", "q3营销复盘")).toBeGreaterThan(0.9);
    expect(bigramDiceSimilarity("营销复盘", "服务器扩容")).toBeLessThan(0.3);
  });
});

describe("④ vector layer", () => {
  it("round-trips centroids through base64 float32", () => {
    const vector = [0.1, -0.2, 0.3];
    expect(decodeCentroid(encodeCentroid(vector))).toHaveLength(3);
    expect(decodeCentroid(encodeCentroid(vector))[0]).toBeCloseTo(0.1, 6);
  });

  it("computes cosine similarity and rejects dimension mismatches", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("blends centroids with EMA and normalizes to unit length", () => {
    const blended = blendCentroid([1, 0], [0, 1], 0.25);
    const norm = Math.sqrt(blended.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1);
    expect(blended[0]).toBeCloseTo(0.75 / Math.hypot(0.75, 0.25), 6);
  });

  it("rebuilds from the incoming vector when the model changed", () => {
    const previous = { roomId: "r", knowledgeId: "k", centroid: encodeCentroid([1, 1]), centroidDocs: 9, centroidModel: "old-model" };
    const advanced = advanceCentroid(previous, [3, 4], "new-model");
    expect(advanced.centroidModel).toBe("new-model");
    expect(advanced.centroidDocs).toBe(1);
    const decoded = decodeCentroid(advanced.centroid);
    expect(decoded[0]).toBeCloseTo(0.6, 6); // 归一化后的 [3,4]
  });

  it("skips cold-start rooms and model mismatches when ranking", () => {
    const warm = { roomId: "warm", knowledgeId: "k1", centroid: encodeCentroid([1, 0]), centroidDocs: 5, centroidModel: "m" };
    const cold = { roomId: "cold", knowledgeId: "k2", centroid: encodeCentroid([0, 1]), centroidDocs: 2, centroidModel: "m" };
    const stale = { roomId: "stale", knowledgeId: "k3", centroid: encodeCentroid([0, 1]), centroidDocs: 9, centroidModel: "other" };
    const ranked = rankByCentroids([1, 0], [warm, cold, stale], "m");
    expect(ranked.map((score) => score.roomId)).toEqual(["warm"]);
    expect(ranked[0]!.similarity).toBeCloseTo(1);
  });
});

describe("⑤ arbitration parsing", () => {
  const dossier: ArbitrationDossier = {
    documentTitle: "会议纪要",
    documentSummary: "讨论了卫星轨道",
    candidates: [
      { roomId: "a", title: "卫星项目", summary: null, pageTitles: [] },
      { roomId: "b", title: "营销", summary: null, pageTitles: [] },
    ],
  };

  it("parses a clean JSON verdict", () => {
    const verdict = parseArbitrationResponse(
      '{"action":"existing","room_ids":["a","b"],"new_room":{"name":"","summary":""},"confidence":0.85,"reason":"主题匹配"}',
      dossier,
    );
    expect(verdict.action).toBe("existing");
    expect(verdict.roomIds).toEqual(["a", "b"]);
    expect(verdict.confidence).toBe(0.85);
  });

  it("unwraps markdown-fenced JSON", () => {
    const verdict = parseArbitrationResponse(
      '```json\n{"action":"existing","room_ids":["a"],"new_room":{"name":"","summary":""},"confidence":0.7,"reason":"ok"}\n```',
      dossier,
    );
    expect(verdict.roomIds).toEqual(["a"]);
  });

  it("filters room_ids down to actual candidates and dedupes", () => {
    const verdict = parseArbitrationResponse(
      '{"action":"existing","room_ids":["zzz","a","a"],"new_room":{"name":"","summary":""},"confidence":0.9,"reason":""}',
      dossier,
    );
    expect(verdict.roomIds).toEqual(["a"]);
  });

  it("rejects create_new without a name and clamps confidence", () => {
    expect(() =>
      parseArbitrationResponse('{"action":"create_new","room_ids":[],"new_room":{"summary":"x"},"confidence":0.9,"reason":""}', dossier),
    ).toThrow();
    const verdict = parseArbitrationResponse(
      '{"action":"create_new","room_ids":[],"new_room":{"name":"新主题","summary":"s","kind":"项目"},"confidence":1.7,"reason":""}',
      dossier,
    );
    expect(verdict.confidence).toBe(1);
    expect(verdict.newRoom.kind).toBe("项目");
  });

  it("downgrades existing-without-valid-rooms to a zero-confidence verdict", () => {
    const verdict = parseArbitrationResponse(
      '{"action":"existing","room_ids":["ghost"],"new_room":{"name":"","summary":""},"confidence":0.9,"reason":"猜的"}',
      dossier,
    );
    expect(verdict.roomIds).toEqual([]);
    expect(verdict.confidence).toBe(0);
  });

  it("throws on non-JSON or invalid action", () => {
    expect(() => parseArbitrationResponse("我觉得应该放到卫星项目", dossier)).toThrow();
    expect(() =>
      parseArbitrationResponse('{"action":"maybe","room_ids":[],"new_room":{"name":"","summary":""},"confidence":0.5,"reason":""}', dossier),
    ).toThrow();
  });
});

describe("router helpers", () => {
  it("fallbackSummary strips frontmatter and markdown syntax", () => {
    const markdown = "---\ntitle: x\nversion: 3\n---\n\n## 结论\n\n- 卫星**轨道**确认";
    const summary = fallbackSummary(markdown);
    expect(summary).not.toContain("---");
    expect(summary).not.toContain("##");
    expect(summary).not.toContain("**");
    expect(summary).toContain("卫星");
    expect(summary).toContain("轨道");
  });
});
