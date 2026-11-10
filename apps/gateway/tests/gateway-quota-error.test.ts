import { describe, expect, it } from "vitest";
import { isAiQuotaError } from "../src/server/create-server.js";

describe("isAiQuotaError", () => {
  it("recognizes relay quota failures from their message text", () => {
    // new-api 中转的余额不足（真机日志原话）
    expect(isAiQuotaError(
      'OpenAI API error (403): {"message":"预扣费额度失败, 用户剩余额度: ＄0.000052, 需要预扣费额度: ＄0.000532","type":"new_api_error","code":"insufficient_user_quota"}',
    )).toBe(true);
    // OpenAI 官方 429 文案
    expect(isAiQuotaError(
      "OpenAI API error (429): You exceeded your current quota, please check your plan and billing details",
    )).toBe(true);
    expect(isAiQuotaError("insufficient quota")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isAiQuotaError("OpenAI API error (401): invalid api key")).toBe(false);
    expect(isAiQuotaError("fetch failed")).toBe(false);
    expect(isAiQuotaError("body/messages/1/text must NOT have fewer than 1 characters")).toBe(false);
  });
});
