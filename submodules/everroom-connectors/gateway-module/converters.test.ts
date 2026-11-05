import { describe, expect, it } from "vitest";

import { converterOfExtension } from "./converters.js";

describe("converterOfExtension：纯文本家族", () => {
  it("md/markdown/txt 直通返回正文（去 BOM），其余未知扩展仍为 null", () => {
    for (const ext of ["md", "markdown", "txt", "MD", "Txt"]) {
      const converter = converterOfExtension(ext);
      expect(converter, ext).toBeTypeOf("function");
    }
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 标题\n\n正文", "utf8")]);
    expect(converterOfExtension("md")!(withBom, "a.md")).toBe("# 标题\n\n正文");
    expect(converterOfExtension("txt")!(Buffer.from("纯文本"), "a.txt")).toBe("纯文本");
    expect(converterOfExtension("exe")).toBeNull();
  });
});
