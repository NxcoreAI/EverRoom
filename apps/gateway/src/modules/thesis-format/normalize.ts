/**
 * 模版归一化：zip/doc/docx/dotx/pdf 输入 → 统一成员清单 → ThesisTemplateFacts。
 *
 * zip 不进文件库（桌面侧直传字节）；.doc 走 soffice 转 docx（转后 sectPr 可能
 * 失真，事实层如实上报，解析代理按「条文为主、版式为辅」纪律裁决）。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import JSZip from "jszip";
import type { ThesisTemplateFacts } from "./types.js";
import { extractOoxmlFactsAsync as extractOoxmlFacts } from "./ooxml-facts.js";
import { parsePdfNative } from "../document-understanding/pdf.js";

export interface TemplateMember {
  name: string;
  ext: string;
  bytes: Buffer;
}

const MEMBER_EXTENSIONS = new Set([".docx", ".doc", ".dotx", ".pdf"]);

/** 解 zip（GBK 文件名修复）或单文件 → 模版成员清单（跳过 __MACOSX 与超大成员）。 */
export async function unpackTemplateInput(bytes: Buffer, name: string): Promise<TemplateMember[]> {
  const ext = extname(name).toLowerCase();
  if (ext !== ".zip") {
    if (!MEMBER_EXTENSIONS.has(ext)) throw new Error(`thesis_template_unsupported_extension:${ext || "(none)"}`);
    return [{ name, ext, bytes }];
  }
  const zip = await JSZip.loadAsync(bytes);
  const members: TemplateMember[] = [];
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const fileName = file.name;
    const base = fileName.split("/").pop() ?? fileName;
    if (fileName.includes("__MACOSX") || base.startsWith("._")) continue;
    const memberExt = extname(base).toLowerCase();
    if (!MEMBER_EXTENSIONS.has(memberExt)) continue;
    const memberBytes = await file.async("nodebuffer");
    if (memberBytes.length > 60 * 1024 * 1024) continue;
    members.push({ name: base, ext: memberExt, bytes: memberBytes });
  }
  if (members.length === 0) throw new Error("thesis_template_zip_empty");
  return members;
}

/** .doc → .docx（soffice headless）。dotx 本就是 zip OOXML，仅改扩展名。 */
export async function normalizeMembersToDocx(members: TemplateMember[]): Promise<TemplateMember[]> {
  const out: TemplateMember[] = [];
  for (const member of members) {
    if (member.ext === ".doc") {
      const converted = await convertDocToDocx(member.bytes, member.name);
      if (converted) {
        out.push({ name: member.name.replace(/\.doc$/i, ".docx"), ext: ".docx", bytes: converted });
        continue;
      }
    }
    if (member.ext === ".dotx") {
      out.push({ name: member.name.replace(/\.dotx$/i, ".docx"), ext: ".docx", bytes: member.bytes });
      continue;
    }
    out.push(member);
  }
  return out;
}

async function convertDocToDocx(bytes: Buffer, filename: string): Promise<Buffer | null> {
  const workDirectory = await mkdtemp(join(tmpdir(), "everroom-thesis-"));
  try {
    const inputBase = `input${extname(filename).toLowerCase() || ".bin"}`;
    const inputPath = join(workDirectory, inputBase);
    const profilePath = join(workDirectory, "profile");
    await writeFile(inputPath, bytes);
    const candidates = [
      ...(process.env.EVERROOM_SOFFICE_PATH ? [process.env.EVERROOM_SOFFICE_PATH] : []),
      "soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/usr/bin/soffice",
      "/usr/bin/libreoffice",
    ];
    const args = [
      "--headless", "--nologo", "--nodefault", "--norestore", "--nolockcheck",
      `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
      "--convert-to", "docx", "--outdir", workDirectory, inputPath,
    ];
    for (const candidate of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(candidate, args, { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
      if (!ok) continue;
      // soffice 产物与输入同名换扩展名：input.doc → input.docx
      const produced = `${inputBase.replace(/\.[^.]+$/, "")}.docx`;
      const files = await readdir(workDirectory);
      const target = files.find((f) => f === produced) ?? files.find((f) => f.toLowerCase().endsWith(".docx") && f !== inputBase);
      if (target) return readFile(join(workDirectory, target));
    }
    return null;
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 汇总模版事实：docx/dotx 成员抽 OOXML 版式 + 正文文本（含批注）；
 * pdf 成员抽文本；doc 成员（soffice 失败时兜底）按文本处理。
 */
export async function buildTemplateFacts(members: TemplateMember[]): Promise<ThesisTemplateFacts> {
  const ooxml: ThesisTemplateFacts["ooxml"] = [];
  const documentsText: ThesisTemplateFacts["documentsText"] = [];
  for (const member of members) {
    if (member.ext === ".pdf") {
      try {
        const parsed = await parsePdfNative(member.bytes);
        if (parsed.markdown.trim()) documentsText.push({ name: member.name, text: parsed.markdown.slice(0, 60_000) });
      } catch { /* 单个成员失败不阻断 */ }
      continue;
    }
    if (member.ext === ".docx") {
      try {
        const facts = await extractOoxmlFacts(member.bytes);
        ooxml.push({ name: member.name, ...facts });
      } catch { /* 版式抽取失败不阻断 */ }
      try {
        const text = await docxPlainText(member.bytes);
        if (text.trim()) documentsText.push({ name: member.name, text: text.slice(0, 60_000) });
      } catch { /* 同上 */ }
      continue;
    }
    if (member.ext === ".doc") {
      documentsText.push({ name: member.name, text: "(旧 .doc 格式，未能转换；请以其他成员与规范条文为准)" });
    }
  }
  if (ooxml.length === 0 && documentsText.length === 0) throw new Error("thesis_template_no_readable_member");
  return { ooxml, documentsText };
}

/** docx 正文 + 批注纯文本（w:t 拼接，段落断行）。 */
export async function docxPlainText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const chunks: string[] = [];
  for (const part of ["word/document.xml", "word/comments.xml"]) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async("string");
    const paragraphs = xml.split(/<\/w:p>/);
    const lines = paragraphs.map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
      .map((t) => t.replace(/<[^>]+>/g, ""))
      .join(""));
    chunks.push(lines.join("\n"));
  }
  return chunks.join("\n");
}
