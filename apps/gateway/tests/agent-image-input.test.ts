import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  isPublicImageUrl,
  resolveAgentImageInput,
  sniffImageMime,
} from "../src/modules/documents/capabilities/agent-image-input.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture-png-body"),
]);
const PNG_BASE64 = PNG_BYTES.toString("base64");
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34" }];

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agent-image-input-"));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function imageResponse(bytes: Buffer, init: ResponseInit = {}): Response {
  return new Response(bytes, init);
}

describe("agent 图片入参：mime 嗅探", () => {
  it("识别 png / jpeg / gif，拒绝 webp 与 svg", () => {
    expect(sniffImageMime(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a......", "latin1"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBeNull();
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
});

describe("agent 图片入参：base64 来源（兼容旧契约）", () => {
  it("直接 base64：嗅探 mime，参数归一化（默认 afterIndex=-1、480px、Illustration）", async () => {
    const resolved = await resolveAgentImageInput({ base64: PNG_BASE64 });
    expect(resolved).toEqual({
      base64: PNG_BASE64,
      mime: "image/png",
      afterIndex: -1,
      maxWidthPx: 480,
      label: "Illustration",
    });
  });

  it("data URL 前缀会被剥掉，maxWidthPx 夹到 16..1200、label 截断 80", async () => {
    const resolved = await resolveAgentImageInput({
      base64: `data:image/png;base64,${PNG_BASE64}`,
      afterIndex: 7,
      maxWidthPx: 9999,
      label: "图".repeat(120),
    });
    expect(resolved.base64).toBe(PNG_BASE64);
    expect(resolved.afterIndex).toBe(7);
    expect(resolved.maxWidthPx).toBe(1200);
    expect(resolved.label).toHaveLength(80);
    expect((await resolveAgentImageInput({ base64: PNG_BASE64, maxWidthPx: 1 })).maxWidthPx).toBe(16);
  });

  it("非法 base64 / 不支持的格式 / 空字节都报 INVALID_REQUEST", async () => {
    await expect(resolveAgentImageInput({ base64: "%%%not-base64%%%" })).rejects.toThrow(/标准 base64/);
    await expect(
      resolveAgentImageInput({ base64: Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1").toString("base64") }),
    ).rejects.toThrow(/不支持的图片格式/);
    await expect(resolveAgentImageInput({ base64: "" })).rejects.toThrow(/path（本地图片绝对路径）/);
  });
});

describe("agent 图片入参：path 来源（agent 自己生成/用户给的本地图）", () => {
  it("读本地绝对路径并转成 base64 + 嗅探 mime", async () => {
    const path = join(workDir, "scene.png");
    await writeFile(path, PNG_BYTES);
    const resolved = await resolveAgentImageInput({ path, afterIndex: 3, maxWidthPx: 900, label: "场景" });
    expect(resolved).toEqual({
      base64: PNG_BASE64,
      mime: "image/png",
      afterIndex: 3,
      maxWidthPx: 900,
      label: "场景",
    });
  });

  it("相对路径、文件不存在、超过大小上限都给出可读错误", async () => {
    await expect(resolveAgentImageInput({ path: "tmp/scene.png" })).rejects.toThrow(/绝对路径/);
    await expect(resolveAgentImageInput({ path: join(workDir, "missing.png") })).rejects.toThrow(/找不到图片文件/);
    const bigPath = join(workDir, "big.png");
    await writeFile(bigPath, Buffer.concat([PNG_BYTES, Buffer.alloc(64)]));
    await expect(resolveAgentImageInput({ path: bigPath }, { maxBytes: 8 })).rejects.toThrow(/超过上限/);
  });
});

describe("agent 图片入参：url 来源（公网 http(s)）", () => {
  it("下载公网图片；重定向逐跳校验后仍能拿到字节", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string) => {
      calls.push(input);
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/scene.png" } });
      }
      return imageResponse(PNG_BYTES);
    };
    const resolved = await resolveAgentImageInput(
      { url: "https://images.example.com/scene.png", afterIndex: 2 },
      { fetchImpl, lookupImpl: PUBLIC_LOOKUP },
    );
    expect(calls).toHaveLength(2);
    expect(resolved.base64).toBe(PNG_BASE64);
    expect(resolved.mime).toBe("image/png");
    expect(resolved.afterIndex).toBe(2);
  });

  it("内网/环回/本机域名/带账号密码的 URL 一律拒绝", async () => {
    const fetchImpl = async () => imageResponse(PNG_BYTES);
    const privateLookup = async () => [{ address: "10.0.0.5" }];
    await expect(resolveAgentImageInput({ url: "http://127.0.0.1/a.png" }, { fetchImpl })).rejects.toThrow(/公网/);
    await expect(
      resolveAgentImageInput({ url: "http://intranet.example.com/a.png" }, { fetchImpl, lookupImpl: privateLookup }),
    ).rejects.toThrow(/公网/);
    await expect(
      resolveAgentImageInput({ url: "http://localhost/a.png" }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow(/公网/);
    await expect(
      resolveAgentImageInput({ url: "https://user:pass@example.com/a.png" }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow(/公网/);
    expect(await isPublicImageUrl("ftp://example.com/a.png", PUBLIC_LOOKUP)).toBe(false);
  });

  it("HTTP 失败、非图片内容、超过大小上限都报可读错误", async () => {
    await expect(resolveAgentImageInput(
      { url: "https://example.com/404.png" },
      { fetchImpl: async () => new Response("not found", { status: 404 }), lookupImpl: PUBLIC_LOOKUP },
    )).rejects.toThrow(/HTTP 404/);
    await expect(resolveAgentImageInput(
      { url: "https://example.com/a.svg" },
      { fetchImpl: async () => imageResponse(Buffer.from("<svg/>")), lookupImpl: PUBLIC_LOOKUP },
    )).rejects.toThrow(/不支持的图片格式/);
    await expect(resolveAgentImageInput(
      { url: "https://example.com/a.png" },
      { fetchImpl: async () => imageResponse(PNG_BYTES), lookupImpl: PUBLIC_LOOKUP, maxBytes: 8 },
    )).rejects.toThrow(/超过上限/);
  });
});
describe("agent 图片入参：fileId 来源（文件库图片）", () => {
  it("按 fileId 读宿主字节并嗅探 mime（用户说“刚上传的 logo”的场景）", async () => {
    const readLibraryFile = vi.fn(async (fileId: string) => (fileId === "file-logo" ? PNG_BYTES : null));
    const resolved = await resolveAgentImageInput(
      { fileId: "file-logo", maxWidthPx: 120 },
      { readLibraryFile },
    );
    expect(readLibraryFile).toHaveBeenCalledWith("file-logo");
    expect(resolved).toMatchObject({ base64: PNG_BASE64, mime: "image/png", maxWidthPx: 120 });
  });

  it("fileId 不存在 / 空字节 → FILE_NOT_FOUND；未注入端口 → INVALID_REQUEST", async () => {
    await expect(resolveAgentImageInput(
      { fileId: "file-missing" },
      { readLibraryFile: async () => null },
    )).rejects.toThrow(/FILE_NOT_FOUND/);
    await expect(resolveAgentImageInput({ fileId: "file-x" }))
      .rejects.toThrow(/不支持 fileId/);
  });
});
