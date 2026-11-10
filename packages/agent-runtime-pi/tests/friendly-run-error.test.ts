import { describe, expect, it } from "vitest";

import { friendlyRunError } from "../src/index.js";

describe("friendlyRunError", () => {
  it("上游 404 model_not_found 的原始 JSON 串翻成可读提示", () => {
    const raw = '404: {"message":"Model not exist.","type":"invalid_request_error","param":"","code":"model_not_found"}';
    expect(friendlyRunError(raw)).toContain("模型在服务端不可用");
    expect(friendlyRunError(raw)).not.toContain("Model not exist");
    expect(friendlyRunError('404: {"code":"model_not_found"}')).toContain("模型在服务端不可用");
  });

  it("未识别的错误保持原文", () => {
    expect(friendlyRunError("HTTP 502 upstream error")).toBe("HTTP 502 upstream error");
    expect(friendlyRunError("")).toBe("");
  });
});
