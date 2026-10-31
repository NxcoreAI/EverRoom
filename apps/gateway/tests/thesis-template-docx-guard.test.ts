import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { ThesisFormatService } from "../src/modules/thesis-format/service.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";

/**
 * 「改名的 .doc」回归：
 * 扩展名是 .docx、内容其实是老版 OLE 复合文档（Word 97）时，
 * 绝不能把它当骨架喂给渲染器——那会在装订阶段抛
 * `document.xml has no <w:body> element`，然后静默回落到「照内容重建」，
 * 用户看到的就是目录/结构全变，却不知道原因。
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })));
});

type Access = { readTemplateDocx(cardId: string, fileEntryId: string | null | undefined, name?: string): Promise<Buffer | null> };

describe("模版必须是真 docx", () => {
  it("OLE(.doc) 内容伪装成 .docx：缓存读取阶段就被挡掉，并删掉坏缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "everroom-docx-guard-"));
    dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const files = { dataDirectory: () => dir, catalogEntry: () => null, catalogStoragePathOf: () => null, catalogEntriesByName: () => [] } as never;
    const service = new ThesisFormatService({
      db: database.db,
      files,
      orchestrator: {} as unknown as SubagentOrchestrator,
      officeBridge: null,
    });
    const access = service as unknown as Access & { writeTemplateCache(id: string, bytes: Buffer): Promise<void> };

    // Word 97 复合文档的文件头（D0 CF 11 E0 A1 B1 1A E1）
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    await access.writeTemplateCache("card-ole", ole);

    expect(await access.readTemplateDocx("card-ole", null)).toBeNull();
    // 坏缓存被清掉：下次不会再在装订阶段炸一次
    const again = await access.readTemplateDocx("card-ole", null);
    expect(again).toBeNull();
  });

  it("回归：真正的 docx 缓存照常返回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "everroom-docx-guard-"));
    dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const source = join(dir, "real.docx");
    const files = {
      dataDirectory: () => dir,
      catalogEntry: () => ({ id: "f1", originalName: "real.docx" }),
      catalogStoragePathOf: () => source,
      catalogEntriesByName: () => [],
    } as never;
    await writeFile(source, Buffer.from("PK\u0003\u0004word/document.xml"));
    const service = new ThesisFormatService({
      db: database.db,
      files,
      orchestrator: {} as unknown as SubagentOrchestrator,
      officeBridge: null,
    });
    const access = service as unknown as Access & { writeTemplateCache(id: string, bytes: Buffer): Promise<void> };
    const docx = Buffer.from("PK\u0003\u0004word/document.xml");
    await access.writeTemplateCache("card-ok", docx);
    const read = await access.readTemplateDocx("card-ok", null);
    expect(read).not.toBeNull();
    expect(Buffer.compare(read!, docx)).toBe(0);
  });
});
