import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest"

import { sniffExt } from "../src/modules/subagents/slides-reference.js"

const dir = mkdtempSync(join(tmpdir(), "sniff-ext-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function sniffed(bytes: number[] | string): string {
  const path = join(dir, `f-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes))
  return sniffExt(path)
}

describe("sniffExt", () => {
  it("识别无扩展名上传件的真实格式", () => {
    expect(sniffed("%PDF-1.7 …")).toBe(".pdf")
    expect(sniffed([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toBe(".png")
    expect(sniffed([0xff, 0xd8, 0xff, 0xe0])).toBe(".jpg")
    expect(sniffed("RIFF\x00\x00\x00\x00WEBPVP8 ")).toBe(".webp")
    expect(sniffed("PK\x03\x04 rest of zip")).toBe(".pptx")
  })

  it("识别不出时返回空串（md 等纯文本）", () => {
    expect(sniffed("# 标题\n正文")).toBe("")
  })
})
