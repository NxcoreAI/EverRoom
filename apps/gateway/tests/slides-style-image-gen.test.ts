import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRelaySessionStore } from "../src/modules/ai-relay/session.js";
import { SlidesStyleImageGenerator } from "../src/modules/slides-style/image-gen.js";

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => {
      const item = (body as { data?: Array<{ b64_json?: string }> }).data?.[0];
      return Buffer.from(item?.b64_json ?? "", "base64");
    },
  } as unknown as Response;
}

function setupStore(active: boolean, imageModel: string | null = "qwen-image-3.0"): AiRelaySessionStore {
  const store = new AiRelaySessionStore();
  if (active) {
    store.set({
      baseUrl: "https://ai.example.com",
      token: "tok",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proxyOrigin: "http://127.0.0.1:1",
      ...(imageModel === null ? {} : { models: { image: imageModel } }),
    });
  }
  return store;
}

function setupFiles() {
  const imports: Array<{ buffer: Buffer; mime: string }> = [];
  const saver = {
    saveImageBlob: vi.fn(async (buffer: Buffer, mime: string) => {
      imports.push({ buffer, mime });
      return { contentHash: `hash-${String(imports.length)}` };
    }),
  };
  return { files: saver, imports };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlidesStyleImageGenerator", () => {
  it("generates one image per candidate prompt in parallel and imports each", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const calls: string[] = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.body) bodies.push(JSON.parse(String(init.body)).prompt as string);
      // 第一张走 b64、第二张走 url 下载，两条路径都覆盖。
      if (url.endsWith("/images/generations")) {
        return fakeResponse({ data: [{ b64_json: Buffer.from("png-bytes-1").toString("base64") }] });
      }
      return fakeResponse({ data: [{ b64_json: Buffer.from("png-bytes-2").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    const results = await generator.generateOverviewImages({
      candidates: [
        { label: "深空科技", prompt: "深色科技风 PPT 样张" },
        { label: "冷灰商务", prompt: "浅色商务风 PPT 样张" },
      ],
      idempotencyKey: "run-1",
    });

    expect(results).toHaveLength(2);
    expect(calls[0]).toBe("https://ai.example.com/v1/images/generations");
    // 每条候选各用自己的提示词——差异化候选的机制保证。
    expect(bodies).toEqual(["深色科技风 PPT 样张", "浅色商务风 PPT 样张"]);
    expect(imports).toHaveLength(2);
    expect(imports.every((item) => item.mime === "image/png" && item.buffer.byteLength > 0)).toBe(true);
  });

  it("names jpeg results by magic bytes", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const fetchImpl = vi.fn(async () => fakeResponse({ data: [{ b64_json: jpegHeader.toString("base64") }] }));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    await generator.generateOverviewImages({ candidates: [{ prompt: "p" }], idempotencyKey: "k" });

    expect(imports[0]?.mime).toBe("image/jpeg");
  });

  it("rejects when the relay session is absent", async () => {
    const store = setupStore(false);
    const { files } = setupFiles();
    const generator = new SlidesStyleImageGenerator(store, files, vi.fn() as unknown as typeof fetch);
    await expect(generator.generateOverviewImages({ candidates: [{ prompt: "p" }], idempotencyKey: "k" }))
      .rejects.toThrow(/中转会话不可用/);
  });

  it("surfaces generation HTTP failures after retries when nothing succeeds", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    // 504 属可重试瞬时错误：三次尝试后仍失败才向上抛（快退避注入防测试等待）。
    const fetchImpl = vi.fn(async () => fakeResponse({ error: "boom" }, false, 504));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0, 1, 1],
    });
    await expect(generator.generateOverviewImages({ candidates: [{ prompt: "p" }], idempotencyKey: "k" }))
      .rejects.toThrow(/HTTP 504/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("clamps candidate count into 1..4 and drops empty prompts", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    const fetchImpl = vi.fn(async () => fakeResponse({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);
    await generator.generateOverviewImages({
      candidates: Array.from({ length: 6 }, (_, i) => ({ prompt: i === 2 ? "  " : `p${String(i)}` })),
      idempotencyKey: "k",
    });
    // 6 条候选钳到上限 4，其中 1 条空提示词被丢弃：5 → 4 次生图调用。
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("falls back to url download when b64_json is an empty string (real API shape)", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/images/generations")) {
        // 实测形状：b64_json 是空串 + 有效 url。
        return fakeResponse({ data: [{ b64_json: "", url: "https://oss.example.com/img.png" }] });
      }
      return fakeResponse({ data: [{ b64_json: Buffer.from("downloaded-bytes").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    const results = await generator.generateOverviewImages({ candidates: [{ prompt: "p" }], idempotencyKey: "k" });

    expect(calls).toEqual(["https://ai.example.com/v1/images/generations", "https://oss.example.com/img.png"]);
    expect(results).toHaveLength(1);
    expect(imports[0]?.buffer.toString()).toBe("downloaded-bytes");
  });

  it("retries 429s with backoff and keeps partial success", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    // 脚本化响应队列：第 0 张一次成功；第 1 张前两次 429、第三次成功。
    const script: Array<"ok" | "rate"> = ["ok", "rate", "rate", "ok"];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const step = script[call] ?? "ok";
      call += 1;
      if (step === "rate") return fakeResponse({ error: "rate limited" }, false, 429);
      return fakeResponse({ data: [{ b64_json: Buffer.from(`img-${String(call)}`).toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0, 1, 1],
    });

    const results = await generator.generateOverviewImages({ candidates: [{ prompt: "p1" }, { prompt: "p2" }], idempotencyKey: "k" });

    expect(results).toHaveLength(2);
    expect(imports).toHaveLength(2);
    expect(call).toBe(4);
  });

  it("returns the survivors when only some candidates get through the rate limit", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    // 调用顺序确定（allSettled 按序起跑、重试定时器按注册序触发）：
    // 1=图0首试、2=图1首试、3=图0二试、4=图0三试。图0三次全 429，图1一次成功。
    const script: Array<"ok" | "rate"> = ["rate", "ok", "rate", "rate"];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const step = script[call] ?? "ok";
      call += 1;
      if (step === "rate") return fakeResponse({ error: "rate limited" }, false, 429);
      return fakeResponse({ data: [{ b64_json: Buffer.from("survivor").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0, 1, 1],
    });

    const results = await generator.generateOverviewImages({ candidates: [{ prompt: "p1" }, { prompt: "p2" }], idempotencyKey: "k" });

    expect(results).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(call).toBe(4);
  });

  it("does not retry non-retryable failures and surfaces the error when all candidates fail", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    const fetchImpl = vi.fn(async () => fakeResponse({ error: "bad request" }, false, 400));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0, 1, 1],
    });
    await expect(generator.generateOverviewImages({ candidates: [{ prompt: "p1" }, { prompt: "p2" }], idempotencyKey: "k" }))
      .rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("generateImage 生成单张并按调用方收紧的重试梯退避 429", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const script: Array<"ok" | "rate"> = ["rate", "ok"];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const step = script[call] ?? "ok";
      call += 1;
      if (step === "rate") return fakeResponse({ error: "rate limited" }, false, 429);
      return fakeResponse({ data: [{ b64_json: Buffer.from("page-img").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0, 1, 1],
    });

    const result = await generator.generateImage({ prompt: "正文页配图", retryDelaysMs: [0, 1] });

    expect(result.contentHash).toBe("hash-1");
    expect(imports).toHaveLength(1);
    // 实例梯是三试，单图调用按传入两试就停：此处恰好二试成功，证明用的是传入梯。
    expect(call).toBe(2);
  });

  it("generateImage 单张走 url 下载路径（实测空 b64 + 有效 url 形状）", async () => {
    const store = setupStore(true);
    const { files, imports } = setupFiles();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/images/generations")) {
        return fakeResponse({ data: [{ b64_json: "", url: "https://oss.example.com/page.png" }] });
      }
      return fakeResponse({ data: [{ b64_json: Buffer.from("downloaded-page").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    const result = await generator.generateImage({ prompt: "p" });

    expect(result.contentHash).toBe("hash-1");
    expect(imports[0]?.buffer.toString()).toBe("downloaded-page");
  });

  it("generateImage 无中转会话直接拒绝", async () => {
    const store = setupStore(false);
    const { files } = setupFiles();
    const generator = new SlidesStyleImageGenerator(store, files, vi.fn() as unknown as typeof fetch);
    await expect(generator.generateImage({ prompt: "p" })).rejects.toThrow(/中转会话不可用/);
  });

  it("上游 404 model_not_found 翻成可读提示，不带原始 JSON", async () => {
    const store = setupStore(true);
    const { files } = setupFiles();
    const fetchImpl = vi.fn(async () => fakeResponse({
      message: "Model not exist.",
      type: "invalid_request_error",
      code: "model_not_found",
    }, false, 404));
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch, {
      retryDelaysMs: [0],
    });
    await expect(generator.generateImage({ prompt: "p" }))
      .rejects.toThrow("生图模型在服务端不可用（可能已被上游下架，或渠道未配置）。请联系管理员检查生图模型配置后重试。");
  });

  it("套餐未下发生图模型（无 models）时拒绝且不请求中转", async () => {
    const store = setupStore(true, null);
    const { files } = setupFiles();
    const fetchImpl = vi.fn();
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);
    await expect(generator.generateOverviewImages({ candidates: [{ prompt: "p" }], idempotencyKey: "k" }))
      .rejects.toThrow(/生图模型未在套餐中配置/);
    await expect(generator.generateImage({ prompt: "p" })).rejects.toThrow(/生图模型未在套餐中配置/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("套餐下发生图模型为空串视为未配置", async () => {
    const store = setupStore(true, "");
    const { files } = setupFiles();
    const fetchImpl = vi.fn();
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);
    await expect(generator.generateImage({ prompt: "p" })).rejects.toThrow(/生图模型未在套餐中配置/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("生图模型名取自套餐下发并进请求体", async () => {
    const store = setupStore(true, "mimage-v2");
    const { files } = setupFiles();
    let bodyModel = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodyModel = JSON.parse(String(init?.body)).model as string;
      return fakeResponse({ data: [{ b64_json: Buffer.from("x").toString("base64") }] });
    });
    const generator = new SlidesStyleImageGenerator(store, files, fetchImpl as unknown as typeof fetch);

    await generator.generateImage({ prompt: "p" });

    expect(bodyModel).toBe("mimage-v2");
  });
});
