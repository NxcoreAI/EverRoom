import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleVlmClient, parseVisualInference } from "../src/modules/perception/vlm-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("visual inference parser", () => {
  it("accepts the strict local perception shape", () => {
    expect(parseVisualInference({
      eventType: "WORK", title: "工作", summary: "在处理任务", keyPoints: ["任务"],
      representativeTags: ["项目"], confidence: 0.8,
    })).toMatchObject({ title: "工作", confidence: 0.8 });
  });

  it("rejects invalid JSON-compatible output fields", () => {
    expect(() => parseVisualInference({
      eventType: "WORK", title: "工作", summary: "总结", keyPoints: "not-array",
      representativeTags: [], confidence: 2,
    })).toThrow();
  });

  it("uses one non-stored multimodal request without leaking local paths", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        eventType: "WORK", title: "工作", summary: "处理任务", keyPoints: [],
        representativeTags: [], confidence: 0.7,
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
