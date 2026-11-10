import { describe, expect, it } from "vitest";
import { pngBase64ToJpegBase64 } from "../src/modules/subagents/screenshot-jpeg.js";

/** 1x1 PNG（经典最小合法图）。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("screenshot-jpeg", () => {
  it("PNG base64 转 JPEG base64（sips）", { timeout: 20_000 }, async () => {
    const jpegBase64 = await pngBase64ToJpegBase64(TINY_PNG_BASE64, 82);
    const bytes = Buffer.from(jpegBase64, "base64");
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("非法输入抛错（调用方据此回退原图）", { timeout: 20_000 }, async () => {
    await expect(pngBase64ToJpegBase64(Buffer.from("not a png").toString("base64"))).rejects.toThrow();
  });
});
