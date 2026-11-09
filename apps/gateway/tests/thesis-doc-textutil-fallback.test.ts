import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { normalizeMembersToDocx } from "../src/modules/thesis-format/normalize.js";

/**
 * .doc 模版归一化兜底（macOS textutil）：
 * 未安装 LibreOffice 的机器上，convertDocToDocx 原先只会返回 null——模版卡
 * 因此丢掉全部 OOXML 版式事实，排版只能「照内容重建」，用户看到目录/封面全变。
 * 修复：soffice 全部候选不可用时，darwin 上用系统 textutil 把 .doc 转 docx，
 * 模版卡重新带上版式事实。
 *
 * 测试构造真实 .doc（textutil 由 HTML 生成），并临时隐藏 soffice 候选
 * （EVERROOM_SOFFICE_PATH 置空 + PATH 里没有 soffice 的环境不可移植，
 * 因此本测试只在「本机没有 soffice」时验证兜底分支；装了 soffice 的环境
 * 走主路径同样返回 docx，断言不变）。
 */

const scratch = await mkdtemp(join(tmpdir(), "everroom-doc-normalize-"));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

describe("normalizeMembersToDocx（.doc 兜底）", () => {
  it.skipIf(process.platform !== "darwin")("soffice 不可用时 .doc 仍能归一化出 docx 成员", { timeout: 60_000 }, async () => {
    // 用文件方式构造 .doc（textutil 不支持 /dev/stdin）
    const { writeFile, readFile } = await import("node:fs/promises");
    const htmlPath = join(scratch, "seed.html");
    const docPath = join(scratch, "seed.doc");
    await writeFile(htmlPath, "<html><body><p>EverRoom doc normalize fallback</p></body></html>");
    execFileSync("/usr/bin/textutil", ["-convert", "doc", "-output", docPath, htmlPath]);
    const bytes = await readFile(docPath);

    const members = await normalizeMembersToDocx(
      [{ name: "模版.doc", ext: ".doc", bytes } as never],
      scratch,
    );
    const docx = members.find((m) => m.ext === ".docx");
    expect(docx).toBeTruthy();
    // 真是 zip 容器（textutil 产物），不是把 OLE 字节原样透传
    expect(docx!.bytes.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  });
});
