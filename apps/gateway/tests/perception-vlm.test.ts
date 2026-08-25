import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleVlmClient,
  parseClipImageAnalysis,
  parseDocumentOcr,
  parseVisualInference,
} from "../src/modules/perception/vlm-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("visual inference parser", () => {
  it("accepts the strict local perception shape", () => {
    expect(parseVisualInference({
      eventType: "WORK", title: "工作", summary: "在处理任务", keyPoints: ["任务"],
      representativeTags: [
        { kind: "entity", label: "EverRoom", entityType: "project", confidence: 0.9, evidence: "EverRoom" },
        { kind: "fact", label: "正在编辑日记", subject: "用户", predicate: "正在编辑", object: "日记", confidence: 0.8, evidence: "日记" },
      ], confidence: 0.8,
    })).toMatchObject({
      title: "工作",
      confidence: 0.8,
      representativeTags: [
        expect.objectContaining({ kind: "entity", label: "EverRoom" }),
        expect.objectContaining({ kind: "fact", predicate: "正在编辑" }),
      ],
    });
  });

  it("converts legacy string tags without losing old results", () => {
    expect(parseVisualInference({
      eventType: "WORK", title: "工作", summary: "在处理任务", keyPoints: [],
      representativeTags: ["旧项目标签"], confidence: 0.7,
    }).representativeTags).toEqual([
      { kind: "entity", label: "旧项目标签", entityType: "other" },
    ]);
  });

  it("rejects invalid JSON-compatible output fields", () => {
    expect(() => parseVisualInference({
      eventType: "WORK", title: "工作", summary: "总结", keyPoints: "not-array",
      representativeTags: [], confidence: 2,
    })).toThrow();
  });

  it("validates normalized document OCR blocks", () => {
    expect(parseDocumentOcr({
      text: "Invoice 42",
      blocks: [{
        type: "paragraph",
        text: "Invoice 42",
        bbox: [0.1, 0.2, 0.8, 0.3],
        confidence: 0.95,
      }],
    })).toMatchObject({
      text: "Invoice 42",
      blocks: [{ type: "paragraph", bbox: [0.1, 0.2, 0.8, 0.3] }],
    });
    expect(() => parseDocumentOcr({
      text: "bad",
      blocks: [{ type: "paragraph", text: "bad", bbox: [0.2, 0.2, 1.2, 0.3], confidence: 1 }],
    })).toThrow("normalized");
  });

  it("validates blog image roles and their noise reasons", () => {
    const base = {
      kind: "other", summary: "可见一个关注二维码", ocrText: "关注公众号", keyPoints: [], entities: [],
      relevance: 0.1, quality: 0.8,
    };
    expect(parseClipImageAnalysis({ ...base, contentRole: "noise", noiseReason: "qr_code" }))
      .toMatchObject({ contentRole: "noise", noiseReason: "qr_code" });
    expect(() => parseClipImageAnalysis({ ...base, contentRole: "noise", noiseReason: "none" }))
      .toThrow("match contentRole");
    expect(() => parseClipImageAnalysis({ ...base, contentRole: "primary", noiseReason: "advertisement" }))
      .toThrow("match contentRole");
  });

  it("uses one non-stored multimodal request without leaking local paths", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        eventType: "WORK", title: "工作", summary: "处理任务", keyPoints: [],
        representativeTags: [{
          kind: "entity", label: "文档", entityType: "other", confidence: 0.7, evidence: "编辑器窗口",
        }], confidence: 0.7,
      }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", request);
    const client = new OpenAiCompatibleVlmClient({
      baseUrl: "https://vlm.example/v1", apiKey: "secret", model: "vision-model",
    });

    await client.infer({ buffer: Buffer.from("image"), mime: "image/jpeg" });

    const init = request.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "vision-model", store: false });
    expect(String(init.body)).toContain("data:image/jpeg;base64,");
    expect(String(init.body)).not.toContain("/Users/");
    expect(JSON.stringify(init.headers)).not.toContain("image");
  });
});
