import JSZip from "jszip";

import { IngestError } from "./errors.js";

/**
 * 旧版 Office 文本抽取（进程内、零外部转换器）。
 *
 * 背景：入库解析曾把 .doc/.xls/.ppt 交给 LibreOffice 子进程转换后再抽文本。
 * 扫描本地文件夹时，每个旧格式文件都会冷启动一次 soffice；解析失败又没有
 * 负缓存，于是每次重扫都再起一遍。这里改成纯 JS 读取容器格式：
 *
 * - .doc/.dot：OLE/CFB → WordDocument 的分片表（piece table）
 * - .xls/.xlt/.xla/.xlsb：OLE/CFB → BIFF 记录（SST + 单元格）
 * - .ppt/.pot/.pps：OLE/CFB → PowerPoint 记录树里的文本 atom（仅 Slide）
 * - .rtf：控制字剥离
 * - .odt/.ods/.odp：ZIP 内 content.xml
 *
 * 只求「可读文本 + 基本结构」，不追求版式保真；渲染/预览仍走各自的查看器。
 * 任何解析失败都抛 IngestError，由调用方决定落库策略。
 */

// ---------------------------------------------------------------------------
// 通用：文本收尾
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function emptyText(filename: string): IngestError {
  return new IngestError(`${filename} 无可提取文本`, "empty_content");
}

// ---------------------------------------------------------------------------
// OLE / Compound File Binary（CFB）
// ---------------------------------------------------------------------------

const CFB_SIGNATURE_HI = 0xe011cfd0;
const CFB_SIGNATURE_LO = 0xe11ab1a1;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_FREE_SECTOR = 0xffffffff;
/** 防御性上限：损坏文件里的链式扇区不应让循环跑飞。 */
const CFB_MAX_CHAIN = 1_000_000;

interface CfbEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

/** 解析 CFB 容器，返回「流名 → 内容」。损坏/加密容器抛普通 Error。 */
export function readCompoundFile(buffer: Buffer): Map<string, Buffer> {
  if (
    buffer.length < 512 ||
    buffer.readUInt32LE(0) !== CFB_SIGNATURE_HI ||
    buffer.readUInt32LE(4) !== CFB_SIGNATURE_LO
  ) {
    throw new Error("not a compound file");
  }
  const sectorSize = 1 << buffer.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buffer.readUInt16LE(0x20);
  if (sectorSize < 128 || miniSectorSize < 8) throw new Error("unsupported compound file sector size");

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const sectorInBounds = (sector: number, length = sectorSize): boolean =>
    sector >= 0 && sectorOffset(sector) + length <= buffer.length;

  // 1) DIFAT → FAT 扇区列表（前 109 项在头部，其余在 DIFAT 扇区链里）。
  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const sector = buffer.readUInt32LE(0x4c + index * 4);
    if (sector !== CFB_FREE_SECTOR && sector !== CFB_END_OF_CHAIN) fatSectors.push(sector);
  }
  const difatCount = buffer.readUInt32LE(0x48);
  let difat = buffer.readUInt32LE(0x44);
  for (let step = 0; step < difatCount; step += 1) {
    if (difat === CFB_END_OF_CHAIN || difat === CFB_FREE_SECTOR || !sectorInBounds(difat)) break;
    const offset = sectorOffset(difat);
    const perSector = sectorSize / 4 - 1;
    for (let index = 0; index < perSector; index += 1) {
      const sector = buffer.readUInt32LE(offset + index * 4);
      if (sector !== CFB_FREE_SECTOR && sector !== CFB_END_OF_CHAIN) fatSectors.push(sector);
    }
    difat = buffer.readUInt32LE(offset + perSector * 4);
  }

  // 2) FAT 表。
  const fat: number[] = [];
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  for (const sector of fatSectors.slice(0, Math.max(1, fatSectorCount))) {
    if (!sectorInBounds(sector)) continue;
    const offset = sectorOffset(sector);
    for (let index = 0; index < sectorSize / 4; index += 1) {
      fat.push(buffer.readUInt32LE(offset + index * 4));
    }
  }

  // source 是链所在的字节空间：普通流是整份文件，mini 流是 mini stream 本身。
  const readChain = (
    source: Buffer,
    start: number,
    table: readonly number[],
    size: number | null,
    offsetOf: (sector: number) => number,
    chunk: number,
  ): Buffer => {
    const parts: Buffer[] = [];
    let sector = start;
    let total = 0;
    for (let guard = 0; guard < CFB_MAX_CHAIN; guard += 1) {
      if (sector === CFB_END_OF_CHAIN || sector === CFB_FREE_SECTOR) break;
      const offset = offsetOf(sector);
      if (offset < 0 || offset + chunk > source.length) break;
      parts.push(source.subarray(offset, offset + chunk));
      total += chunk;
      if (size !== null && total >= size) break;
      const next = table[sector];
      if (next === undefined) break;
      sector = next;
    }
    const joined = Buffer.concat(parts);
    return size === null ? joined : joined.subarray(0, Math.min(size, joined.length));
  };

  // 3) 目录项。
  const directory = readChain(
    buffer,
    buffer.readUInt32LE(0x30),
    fat,
    null,
    sectorOffset,
    sectorSize,
  );
  const entries: CfbEntry[] = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64);
    const type = directory.readUInt8(offset + 66);
    if (type !== 1 && type !== 2 && type !== 5) continue;
    let name = "";
    for (let index = 0; index < Math.max(0, nameLength - 2); index += 2) {
      name += String.fromCharCode(directory.readUInt16LE(offset + index));
    }
    entries.push({
      name,
      type,
      start: directory.readUInt32LE(offset + 116),
      size: directory.readUInt32LE(offset + 120),
    });
  }
  const root = entries.find((entry) => entry.type === 5);

  // 4) mini FAT + mini stream（小于 4096 字节的流走 mini 扇区）。
  const miniFat: number[] = [];
  let miniFatSector = buffer.readUInt32LE(0x3c);
  for (let guard = 0; guard < CFB_MAX_CHAIN; guard += 1) {
    if (
      miniFatSector === CFB_END_OF_CHAIN ||
      miniFatSector === CFB_FREE_SECTOR ||
      !sectorInBounds(miniFatSector)
    ) {
      break;
    }
    const offset = sectorOffset(miniFatSector);
    for (let index = 0; index < sectorSize / 4; index += 1) {
      miniFat.push(buffer.readUInt32LE(offset + index * 4));
    }
    const next = fat[miniFatSector];
    if (next === undefined) break;
    miniFatSector = next;
  }
  const miniStream = root
    ? readChain(buffer, root.start, fat, root.size, sectorOffset, sectorSize)
    : Buffer.alloc(0);
  const miniOffset = (sector: number): number => sector * miniSectorSize;

  // 5) 逐个流读出内容。
  const streams = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type !== 2 || entry.name.length === 0) continue;
    const data = entry.size < 4096
      ? readChain(miniStream, entry.start, miniFat, entry.size, miniOffset, miniSectorSize)
      : readChain(buffer, entry.start, fat, entry.size, sectorOffset, sectorSize);
    if (data.length > 0) streams.set(entry.name, data);
  }
  return streams;
}

// ---------------------------------------------------------------------------
// 字节 → 文本
// ---------------------------------------------------------------------------

/** Windows-1252 里与 latin1 不同的常见码位（未覆盖的按 latin1 处理）。 */
const CP1252_EXTRA: Readonly<Record<number, string>> = {
  0x80: "\u20ac",
  0x82: "\u201a",
  0x83: "\u0192",
  0x84: "\u201e",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02c6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017d",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02dc",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203a",
  0x9c: "\u0153",
  0x9e: "\u017e",
  0x9f: "\u0178",
};

function decodeSingleByte(bytes: Buffer): string {
  let text = "";
  for (const byte of bytes) text += CP1252_EXTRA[byte] ?? String.fromCharCode(byte);
  return text;
}

// ---------------------------------------------------------------------------
// .doc / .dot（Word 97-2003）
// ---------------------------------------------------------------------------

/** Word 正文里的控制字符：段落/单元格标记与控制符按换行处理。 */
function cleanWordText(raw: string): string {
  return normalizeText(
    raw
      .replace(/\u0000/g, "")
      .replace(/\u0007/g, "\n")
      .replace(/[\u000b\u000c\u000d]/g, "\n")
      .replace(/[\u0001-\u0006\u0008\u000e-\u001f]/g, ""),
  );
}

/** 从 WordDocument 的分片表（CLX/piece table）取正文；失败返回 null。 */
function docTextFromPieces(word: Buffer, table: Buffer): string | null {
  // FIB：fcClx/lcbClx 在 Word 97+ 固定在 0x01A2 / 0x01A6。
  const fcClx = word.readUInt32LE(0x01a2);
  const lcbClx = word.readUInt32LE(0x01a6);
  if (lcbClx === 0 || fcClx + lcbClx > table.length) return null;
  const clx = table.subarray(fcClx, fcClx + lcbClx);

  // Prc（0x01）块在前，Pcdt（0x02）是分片表本体。
  let position = 0;
  while (position < clx.length && clx[position] === 0x01) {
    if (position + 3 > clx.length) return null;
    const size = clx.readInt16LE(position + 1);
    if (size < 0) return null;
    position += 3 + size;
  }
  if (clx[position] !== 0x02 || position + 5 > clx.length) return null;
  const plcLength = clx.readUInt32LE(position + 1);
  const plc = clx.subarray(position + 5, position + 5 + plcLength);
  if (plcLength < 4 || (plcLength - 4) % 12 !== 0) return null;

  const pieceCount = (plcLength - 4) / 12;
  const cpCount = pieceCount + 1;
  const pieces: string[] = [];
  for (let index = 0; index < pieceCount; index += 1) {
    const cpStart = plc.readUInt32LE(index * 4);
    const cpEnd = plc.readUInt32LE((index + 1) * 4);
    if (cpEnd < cpStart) return null;
    const characterCount = cpEnd - cpStart;
    const pcd = cpCount * 4 + index * 8;
    if (pcd + 8 > plc.length) return null;
    let fc = plc.readUInt32LE(pcd + 2);
    if ((fc & 0x40000000) !== 0) {
      // 压缩片：CP1252 单字节。
      const offset = (fc & 0x3fffffff) >>> 1;
      if (offset + characterCount > word.length) return null;
      pieces.push(decodeSingleByte(word.subarray(offset, offset + characterCount)));
    } else {
      if (fc + characterCount * 2 > word.length) return null;
      pieces.push(word.subarray(fc, fc + characterCount * 2).toString("utf16le"));
    }
  }
  return cleanWordText(pieces.join(""));
}

/** Word 6/95：正文直接在 fcMin..fcMac，没有分片表（编码随文档代码页，尽力而为）。 */
function docTextFromRange(word: Buffer): string {
  const fcMin = word.readUInt32LE(0x18);
  const fcMac = Math.min(word.readUInt32LE(0x1c), word.length);
  if (fcMin >= fcMac) return "";
  const body = word.subarray(fcMin, fcMac);
  // Word 95 中文文档可能是双字节：两种解法的控制字符/NUL 少者胜出，
  // 没有代码页信息时这是最省事且不引入外部依赖的取舍。
  const utf16 = body.toString("utf16le");
  const singleByte = decodeSingleByte(body);
  const badness = (text: string): number => {
    let score = 0;
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0) score += 4;
      else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) score += 2;
      else if (code === 0xfffd) score += 4;
    }
    return score;
  };
  return cleanWordText(badness(utf16) <= badness(singleByte) ? utf16 : singleByte);
}

/** .doc/.dot → 正文纯文本。 */
export function docToText(buffer: Buffer, filename = "input.doc"): string {
  let streams: Map<string, Buffer>;
  try {
    streams = readCompoundFile(buffer);
  } catch {
    throw new IngestError(`${filename} 不是可识别的 Word 97-2003 文档`, "convert_failed");
  }
  const word = streams.get("WordDocument");
  if (!word) throw new IngestError(`${filename} 缺少 WordDocument 流`, "convert_failed");

  const nFib = word.readUInt16LE(2);
  const flags = word.readUInt16LE(0x0a);
  if (nFib >= 0x00c1) {
    // fWhichTblStm 决定正文分片表在 1Table 还是 0Table；另一个作为坏文件的兜底。
    const preferredName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
    const candidates = [
      streams.get(preferredName),
      streams.get(preferredName === "1Table" ? "0Table" : "1Table"),
    ].filter((value): value is Buffer => Boolean(value));
    for (const table of candidates) {
      const text = docTextFromPieces(word, table);
      if (text && text.length > 0) return text;
    }
  }
  const fallback = docTextFromRange(word);
  if (fallback.length === 0) throw emptyText(filename);
  return fallback;
}

// ---------------------------------------------------------------------------
// .ppt / .pot / .pps（PowerPoint 97-2003）
// ---------------------------------------------------------------------------

const PPT_SLIDE = 0x03ee;
const PPT_TEXT_CHARS = 0x0fa0;
const PPT_TEXT_BYTES = 0x0fa8;
const PPT_MAX_DEPTH = 32;

interface PptSlideText {
  lines: string[];
}

/** 遍历 PowerPoint 记录树：只收 Slide 容器里的文本 atom（跳过母版/备注）。 */
function collectSlideText(stream: Buffer): PptSlideText[] {
  const slides: PptSlideText[] = [];
  let current: PptSlideText | null = null;

  const walk = (start: number, end: number, inSlide: boolean, depth: number): void => {
    let position = start;
    while (position + 8 <= end) {
      const versionInstance = stream.readUInt16LE(position);
      const type = stream.readUInt16LE(position + 2);
      const length = stream.readUInt32LE(position + 4);
      const body = position + 8;
      if (body + length > end) break;
      const isContainer = (versionInstance & 0x000f) === 0x000f;

      if (type === PPT_SLIDE) {
        current = { lines: [] };
        slides.push(current);
      }
      const nowInSlide = inSlide || type === PPT_SLIDE;
      if (inSlide && current) {
        if (type === PPT_TEXT_CHARS) {
          current.lines.push(stream.subarray(body, body + length).toString("utf16le"));
        } else if (type === PPT_TEXT_BYTES) {
          current.lines.push(decodeSingleByte(stream.subarray(body, body + length)));
        }
      }
      if (isContainer && depth < PPT_MAX_DEPTH) walk(body, body + length, nowInSlide, depth + 1);
      position = body + length;
    }
  };

  walk(0, stream.length, false, 0);
  return slides.filter((slide) => slide.lines.some((line) => line.trim().length > 0));
}

/** 所有文本 atom（找不到 Slide 容器时的兜底）。 */
function collectAllText(stream: Buffer): string[] {
  const texts: string[] = [];
  const walk = (start: number, end: number, depth: number): void => {
    let position = start;
    while (position + 8 <= end) {
      const versionInstance = stream.readUInt16LE(position);
      const type = stream.readUInt16LE(position + 2);
      const length = stream.readUInt32LE(position + 4);
      const body = position + 8;
      if (body + length > end) break;
      if (type === PPT_TEXT_CHARS) texts.push(stream.subarray(body, body + length).toString("utf16le"));
      else if (type === PPT_TEXT_BYTES) texts.push(decodeSingleByte(stream.subarray(body, body + length)));
      if ((versionInstance & 0x000f) === 0x000f && depth < PPT_MAX_DEPTH) {
        walk(body, body + length, depth + 1);
      }
      position = body + length;
    }
  };
  walk(0, stream.length, 0);
  return texts;
}

function slideMarkdown(lines: readonly string[], page: number): string | null {
  const parts = lines
    .flatMap((line) => line.split(/\r\n?|\n/))
    .map((line) => line.replace(/\u000b/g, " ").trim())
    .filter((line) => line.length > 0);
  if (parts.length === 0) return null;
  const [title, ...bullets] = parts;
  return [
    `## 第 ${page} 页${title ? `：${title}` : ""}`,
    ...(bullets.length > 0 ? ["", ...bullets.map((text) => `- ${text}`)] : []),
  ].join("\n");
}

/** .ppt/.pot/.pps → 按页的 markdown。 */
export function pptToText(buffer: Buffer, filename = "input.ppt"): string {
  let stream: Buffer | undefined;
  try {
    stream = readCompoundFile(buffer).get("PowerPoint Document");
  } catch {
    throw new IngestError(`${filename} 不是可识别的 PowerPoint 97-2003 文档`, "convert_failed");
  }
  if (!stream) throw new IngestError(`${filename} 缺少 PowerPoint Document 流`, "convert_failed");

  const slides = collectSlideText(stream);
  if (slides.length > 0) {
    const pages = slides
      .map((slide, index) => slideMarkdown(slide.lines, index + 1))
      .filter((page): page is string => page !== null);
    if (pages.length > 0) return pages.join("\n\n");
  }

  // 兜底：记录树里没有 Slide 容器（旧版本/特殊导出）时，按文本 atom 顺序输出。
  const fallback = collectAllText(stream)
    .flatMap((text) => text.split(/\r\n?|\n/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (fallback.length === 0) throw emptyText(filename);
  return fallback.join("\n\n");
}

// ---------------------------------------------------------------------------
// .xls / .xlsb / .xlt / .xla（Excel 97-2003 BIFF）
// ---------------------------------------------------------------------------

const XLS_BOF = 0x0809;
const XLS_BOUNDSHEET = 0x0085;
const XLS_SST = 0x00fc;
const XLS_CONTINUE = 0x003c;
const XLS_LABELSST = 0x00fd;
const XLS_LABEL = 0x0204;
const XLS_NUMBER = 0x0203;
const XLS_RK = 0x027e;
const XLS_MULRK = 0x00bd;
const XLS_BOOLERR = 0x0205;
const XLS_FILEPASS = 0x002f;
const XLS_MAX_ROWS = 200_000;
const XLS_MAX_COLS = 2_000;

interface BiffRecord {
  type: number;
  start: number;
  length: number;
}

function biffRecords(buffer: Buffer): BiffRecord[] {
  const records: BiffRecord[] = [];
  let position = 0;
  while (position + 4 <= buffer.length) {
    const type = buffer.readUInt16LE(position);
    const length = buffer.readUInt16LE(position + 2);
    if (position + 4 + length > buffer.length) break;
    records.push({ type, start: position + 4, length });
    position += 4 + length;
  }
  return records;
}

/** BIFF 的 XLUnicodeString（cch + flags + 字符）；返回文本与新位置。 */
function readBiffString(
  buffer: Buffer,
  position: number,
  characterCount: number,
  highByte: boolean,
): { text: string; next: number } {
  const byteLength = highByte ? characterCount * 2 : characterCount;
  const end = Math.min(position + byteLength, buffer.length);
  const raw = buffer.subarray(position, end);
  return {
    text: highByte ? raw.toString("utf16le") : decodeSingleByte(raw),
    next: position + byteLength,
  };
}

/** SST（共享字符串表）；跨 CONTINUE 记录时按载荷顺序拼接（极少数超长串会轻微失真）。 */
function readSharedStrings(buffer: Buffer, records: readonly BiffRecord[]): string[] {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.type !== XLS_SST) continue;
    const chunks: Buffer[] = [buffer.subarray(record.start, record.start + record.length)];
    for (let next = index + 1; next < records.length && records[next]!.type === XLS_CONTINUE; next += 1) {
      const continuation = records[next]!;
      chunks.push(buffer.subarray(continuation.start, continuation.start + continuation.length));
    }
    const data = Buffer.concat(chunks);
    if (data.length < 8) return [];
    const uniqueCount = data.readUInt32LE(4);
    const strings: string[] = [];
    let position = 8;
    for (let index = 0; index < uniqueCount; index += 1) {
      if (position + 3 > data.length) break;
      const characterCount = data.readUInt16LE(position);
      const flags = data.readUInt8(position + 2);
      position += 3;
      const hasExtended = (flags & 0x04) !== 0;
      const hasRichText = (flags & 0x08) !== 0;
      let richRuns = 0;
      let extendedSize = 0;
      if (hasRichText) {
        if (position + 2 > data.length) break;
        richRuns = data.readUInt16LE(position);
        position += 2;
      }
      if (hasExtended) {
        if (position + 4 > data.length) break;
        extendedSize = data.readUInt32LE(position);
        position += 4;
      }
      const { text, next } = readBiffString(data, position, characterCount, (flags & 0x01) !== 0);
      position = next;
      position += richRuns * 4 + extendedSize;
      strings.push(text);
    }
    return strings;
  }
  return [];
}

/** RK 数值单元：bit0=×100，bit1=整数（30 位有符号），否则取高 30 位作为 double 的高位。 */
function decodeRkNumber(rk: number): number {
  const scaled = (rk & 1) !== 0;
  const integral = (rk & 2) !== 0;
  let value: number;
  if (integral) {
    value = rk >> 2;
  } else {
    const high = Buffer.alloc(8);
    high.writeUInt32LE(0, 0);
    // rk 是 32 位无符号；高 30 位作为 IEEE754 高位时符号位要保留。
    high.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = high.readDoubleLE(0);
  }
  return scaled ? value / 100 : value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

function cellText(value: string | number): string {
  return typeof value === "number"
    ? formatNumber(value)
    : value.replace(/\r\n?/g, " ").replace(/\s+/g, " ").trim();
}

/** .xls → 每个工作表一张 GFM 表。 */
export function xlsToText(buffer: Buffer, filename = "input.xls"): string {
  let workbook: Buffer | undefined;
  try {
    const streams = readCompoundFile(buffer);
    workbook = streams.get("Workbook") ?? streams.get("Book");
  } catch {
    throw new IngestError(`${filename} 不是可识别的 Excel 97-2003 工作簿`, "convert_failed");
  }
  if (!workbook) throw new IngestError(`${filename} 缺少 Workbook 流`, "convert_failed");

  const records = biffRecords(workbook);
  if (records.some((record) => record.type === XLS_FILEPASS)) {
    throw new IngestError(`${filename} 已加密，无法抽取文本`, "convert_failed");
  }
  const sharedStrings = readSharedStrings(workbook, records);

  // 工作表名（BOUNDSHEET，dt=0 才是普通工作表）。
  const sheetNames: string[] = [];
  for (const record of records) {
    if (record.type !== XLS_BOUNDSHEET || record.length < 8) continue;
    const offset = record.start;
    const sheetType = workbook.readUInt8(offset + 5);
    if (sheetType !== 0) continue;
    const nameLength = workbook.readUInt8(offset + 6);
    const highByte = workbook.readUInt8(offset + 7) === 1;
    const { text } = readBiffString(
      workbook,
      offset + 8,
      nameLength,
      highByte,
    );
    sheetNames.push(text);
  }

  interface Sheet {
    name: string;
    rows: Map<number, Map<number, string | number>>;
  }
  const sheets: Sheet[] = [];
  let current: Sheet | null = null;
  const setCell = (row: number, column: number, value: string | number): void => {
    if (!current || row > XLS_MAX_ROWS || column > XLS_MAX_COLS) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    let cells = current.rows.get(row);
    if (!cells) {
      cells = new Map();
      current.rows.set(row, cells);
    }
    cells.set(column, value);
  };

  for (const record of records) {
    const offset = record.start;
    if (record.type === XLS_BOF) {
      const documentType = record.length >= 4 ? workbook.readUInt16LE(offset + 2) : -1;
      if (documentType === 0x0010) {
        current = { name: sheetNames[sheets.length] ?? `Sheet${sheets.length + 1}`, rows: new Map() };
        sheets.push(current);
      }
      continue;
    }
    if (!current) continue;
    if (record.type === XLS_LABELSST) {
      if (record.length < 10) continue;
      setCell(workbook.readUInt16LE(offset), workbook.readUInt16LE(offset + 2), sharedStrings[workbook.readUInt32LE(offset + 6)] ?? "");
    } else if (record.type === XLS_LABEL) {
      if (record.length < 9) continue;
      const row = workbook.readUInt16LE(offset);
      const column = workbook.readUInt16LE(offset + 2);
      const characterCount = workbook.readUInt16LE(offset + 6);
      const flags = workbook.readUInt8(offset + 8);
      const { text } = readBiffString(workbook, offset + 9, characterCount, (flags & 0x01) !== 0);
      setCell(row, column, text);
    } else if (record.type === XLS_NUMBER) {
      if (record.length < 14) continue;
      setCell(workbook.readUInt16LE(offset), workbook.readUInt16LE(offset + 2), workbook.readDoubleLE(offset + 6));
    } else if (record.type === XLS_RK) {
      if (record.length < 10) continue;
      setCell(workbook.readUInt16LE(offset), workbook.readUInt16LE(offset + 2), decodeRkNumber(workbook.readUInt32LE(offset + 6)));
    } else if (record.type === XLS_MULRK) {
      if (record.length < 6) continue;
      const row = workbook.readUInt16LE(offset);
      const firstColumn = workbook.readUInt16LE(offset + 2);
      const count = Math.floor((record.length - 6) / 6);
      for (let index = 0; index < count; index += 1) {
        const cellOffset = offset + 4 + index * 6;
        if (cellOffset + 6 > offset + record.length) break;
        setCell(row, firstColumn + index, decodeRkNumber(workbook.readUInt32LE(cellOffset + 2)));
      }
    } else if (record.type === XLS_BOOLERR) {
      if (record.length < 8) continue;
      const isError = workbook.readUInt8(offset + 7) === 1;
      const value = workbook.readUInt8(offset + 6);
      setCell(workbook.readUInt16LE(offset), workbook.readUInt16LE(offset + 2), isError ? "" : value === 1 ? "TRUE" : "FALSE");
    }
  }

  const parts: string[] = [];
  for (const sheet of sheets) {
    if (sheet.rows.size === 0) continue;
    const rowIndexes = [...sheet.rows.keys()].sort((left, right) => left - right);
    const rows: string[][] = [];
    for (const rowIndex of rowIndexes) {
      const cells = sheet.rows.get(rowIndex)!;
      const columns = [...cells.keys()].sort((left, right) => left - right);
      const values: string[] = [];
      for (const column of columns) {
        while (values.length < column) values.push(" ");
        values.push(cellText(cells.get(column)!) || " ");
      }
      if (values.length > 0) rows.push(values);
    }
    if (rows.length === 0) continue;
    // GFM 表要求每行列数一致：先定宽，再把短行补齐（表头行往往只有一列标题）。
    const width = Math.max(...rows.map((row) => row.length));
    const lines = rows.map((row) => `| ${[...row, ...Array.from({ length: width - row.length }, () => " ")].join(" | ")} |`);
    parts.push([
      `## ${sheet.name}`,
      "",
      lines[0]!,
      `|${" --- |".repeat(width)}`,
      ...lines.slice(1),
    ].join("\n"));
  }
  if (parts.length > 0) return parts.join("\n\n");

  // 兜底：没有识别出工作表 BOF 的 BIFF 变体，至少把共享字符串按行输出。
  if (sharedStrings.length > 0) {
    return sharedStrings.filter((text) => text.trim().length > 0).join("\n\n");
  }
  throw emptyText(filename);
}

// ---------------------------------------------------------------------------
// .rtf
// ---------------------------------------------------------------------------

/** 只写文本的 RTF 目标组：整组跳过，避免字体表/样式表/图片二进制混进正文。 */
const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl",
  "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "footnote", "annotation",
  "fldinst", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "themedata",
  "colorschememapping", "latentstyles", "datastore", "mmathPr", "filetbl", "revtbl",
  "pnseclvl", "pn", "listtext",
]);

/** .rtf → 纯文本（控制字剥离）。 */
export function rtfToText(buffer: Buffer, filename = "input.rtf"): string {
  const source = buffer.toString("latin1");
  let text = "";
  let position = 0;
  let depth = 0;
  const skip: boolean[] = [false];

  const append = (value: string): void => {
    if (!skip[depth]) text += value;
  };

  while (position < source.length) {
    const character = source[position]!;
    if (character === "{") {
      depth += 1;
      skip[depth] = skip[depth - 1] ?? false;
      position += 1;
      continue;
    }
    if (character === "}") {
      if (depth > 0) depth -= 1;
      position += 1;
      continue;
    }
    if (character !== "\\") {
      if (character !== "\r" && character !== "\n") append(character);
      position += 1;
      continue;
    }

    position += 1;
    const next = source[position];
    if (next === undefined) break;
    if (next === "*") {
      skip[depth] = true;
      position += 1;
      continue;
    }
    if (next === "'") {
      const hex = source.slice(position + 1, position + 3);
      position += 3;
      const code = Number.parseInt(hex, 16);
      if (!Number.isNaN(code)) append(decodeSingleByte(Buffer.from([code])));
      continue;
    }
    if (next === "\\" || next === "{" || next === "}") {
      append(next);
      position += 1;
      continue;
    }
    if (next === "~") {
      append(" ");
      position += 1;
      continue;
    }
    if (next === "-" || next === "_") {
      position += 1;
      continue;
    }
    if (next === "\r" || next === "\n") {
      append("\n");
      position += 1;
      continue;
    }

    let cursor = position;
    while (cursor < source.length && /[a-zA-Z]/.test(source[cursor]!)) cursor += 1;
    const word = source.slice(position, cursor);
    let sign = 1;
    if (source[cursor] === "-") {
      sign = -1;
      cursor += 1;
    }
    const numberStart = cursor;
    while (cursor < source.length && /[0-9]/.test(source[cursor]!)) cursor += 1;
    const parameter = cursor > numberStart
      ? sign * Number(source.slice(numberStart, cursor))
      : null;
    if (source[cursor] === " ") cursor += 1;
    position = cursor;

    if (RTF_SKIP_DESTINATIONS.has(word)) {
      skip[depth] = true;
      continue;
    }
    if (word === "par" || word === "line" || word === "sect" || word === "page") {
      append("\n");
      continue;
    }
    if (word === "tab" || word === "cell" || word === "row") {
      append("\t");
      continue;
    }
    if (word === "u" && parameter !== null) {
      const code = parameter < 0 ? parameter + 0x10000 : parameter;
      append(String.fromCharCode(code));
      // \uN 后面的 ANSI 回退字符：可能是 ?，也可能是 \'hh。
      if (source[position] === "?") position += 1;
      else if (source[position] === "\\" && source[position + 1] === "'") position += 4;
      continue;
    }
  }

  const result = normalizeText(text.replace(/\t+\n/g, "\n"));
  if (result.length === 0) throw emptyText(filename);
  return result;
}

// ---------------------------------------------------------------------------
// .odt / .ods / .odp（OpenDocument）
// ---------------------------------------------------------------------------

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function stripXmlTags(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<text:s(?:\s[^>]*)?\/>/g, " ")
      .replace(/<[^>]+>/g, ""),
  );
}

async function readOdfContentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const content = zip.file("content.xml");
  if (!content) throw new Error("content.xml missing");
  return content.async("string");
}

/** ODF 表格（.ods）：每张表输出 GFM 表。 */
function odfTablesToMarkdown(xml: string): string {
  const parts: string[] = [];
  const tables = xml.matchAll(/<table:table\b[^>]*>[\s\S]*?<\/table:table>/g);
  for (const table of tables) {
    const block = table[0];
    const nameMatch = /table:name="([^"]*)"/.exec(block.slice(0, 200));
    const name = decodeXmlEntities(nameMatch?.[1] ?? "Sheet");
    const rows: string[][] = [];
    for (const rowMatch of block.matchAll(/<table:table-row\b[^>]*>[\s\S]*?<\/table:table-row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<table:table-cell\b[^>]*>[\s\S]*?<\/table:table-cell>/g)) {
        const text = stripXmlTags(cellMatch[0])
          .replace(/\s+/g, " ")
          .replace(/\|/g, "\\|")
          .trim();
        cells.push(text.length > 0 ? text : " ");
      }
      if (cells.some((cell) => cell.trim().length > 0)) rows.push(cells);
    }
    if (rows.length === 0) continue;
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => " ")]);
    parts.push([
      `## ${name}`,
      "",
      `| ${padded[0]!.join(" | ")} |`,
      `|${" --- |".repeat(width)}`,
      ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ].join("\n"));
  }
  return parts.join("\n\n");
}

/** ODF 文本（.odt/.odp）：段落换行、表格单元格制表符分隔。 */
function odfFlowToMarkdown(xml: string): string {
  const text = decodeXmlEntities(
    xml
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<text:s(?:\s[^>]*)?\/>/g, " ")
      .replace(/<\/text:(?:p|h)>/g, "\n")
      .replace(/<text:(?:p|h)(?:\s[^>]*)?>/g, "")
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<\/table:table-row>/g, "\n")
      .replace(/<text:list-item(?:\s[^>]*)?>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
  return normalizeText(text);
}

/**
 * .odt/.ods/.odp → markdown。kind 决定把 content.xml 当流式文本还是表格解析。
 */
export async function odfToMarkdown(
  buffer: Buffer,
  kind: "document" | "spreadsheet" | "presentation",
  filename = "input.odt",
): Promise<string> {
  let xml: string;
  try {
    xml = await readOdfContentXml(buffer);
  } catch {
    throw new IngestError(`${filename} 不是可识别的 OpenDocument 文件`, "convert_failed");
  }
  const result = kind === "spreadsheet" ? odfTablesToMarkdown(xml) : odfFlowToMarkdown(xml);
  if (result.length === 0) throw emptyText(filename);
  return result;
}

// ---------------------------------------------------------------------------
// 导出：按扩展名分派（converters.ts 使用）
// ---------------------------------------------------------------------------

/** 旧版 Word 文本（.doc/.dot/.rtf/.odt）→ markdown 段落。 */
export async function legacyWordToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "rtf") return rtfToText(buffer, filename);
  if (extension === "odt") return odfToMarkdown(buffer, "document", filename);
  return docToText(buffer, filename);
}

/** 旧版表格（.xls/.xlsb/.xlt/.xla/.ods）→ GFM 表。 */
export async function legacySpreadsheetToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "ods") return odfToMarkdown(buffer, "spreadsheet", filename);
  if (extension === "xlsb") {
    throw new IngestError(`${filename} 是二进制工作簿（.xlsb），暂不支持文本抽取`, "convert_failed");
  }
  return xlsToText(buffer, filename);
}

/** 旧版演示（.ppt/.pot/.pps/.odp）→ 按页 markdown。 */
export async function legacySlidesToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "odp") return odfToMarkdown(buffer, "presentation", filename);
  return pptToText(buffer, filename);
}
