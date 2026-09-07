import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenConnectorHttpClient } from "./open-connector-http-client.js";

const config = { baseUrl: "http://oo.test", runtimeToken: "secret-token" } as any;

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenConnectorHttpClient 配额错误重试", () => {
  it("retries quota errors with a 65s-window backoff and succeeds after the quota window", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls <= 2) {
        return jsonResponse(403, { success: false, message: "Gmail API error: quota exceeded for user", errorCode: "provider_error" });
      }
      return jsonResponse(200, { success: true, message: "OK", data: { messages: [] } });
    });
    const client = new OpenConnectorHttpClient(config);
    const pending = client.runAction("gmail", "fetch_emails", { detail: "ids" }, {});
    // 第 1、2 次退避分别 ≥65s/≥130s：推进配额窗口后请求才成功。
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(130_000);
    await expect(pending).resolves.toMatchObject({ success: true, data: { messages: [] } });
    expect(calls).toBe(3);
  });

  it("does not retry non-quota 403 errors", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return jsonResponse(403, { success: false, message: "permission denied for user", errorCode: "provider_error" });
    });
    const client = new OpenConnectorHttpClient(config);
    await expect(client.runAction("gmail", "fetch_emails", {}, {})).rejects.toThrow("permission denied");
    expect(calls).toBe(1);
  });

  it("exhausts retries when quota errors persist", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return jsonResponse(429, { success: false, message: "rate limit hit", errorCode: "rate_limited" });
    });
    const client = new OpenConnectorHttpClient(config);
    const pending = client.runAction("gmail", "fetch_emails", {}, {});
    // 先挂断言再推进时间：rejection 触发时已有 handler，避免 unhandled rejection。
    const assertion = expect(pending).rejects.toThrow("rate limit hit");
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    // 首次 + MAX_RETRIES(3) 次重试。
    expect(calls).toBe(4);
  });
});
