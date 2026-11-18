/**
 * 段落级文档对比（LCS 对齐），供 `word_compare` 工具使用。
 *
 * 语义与 GenOffice docs 渲染层 `apps/docs/src/renderer/editor/compare.ts` 的
 * `compareParagraphs` 保持一致：同一位置的「删一段 + 加一段」合并成 changed，
 * 这样回答「这两版改了什么」时不必让模型自己对齐两边的顺序。
 *
 * 纯函数、无 IO：调用方负责取段落文本与规模上限（大文档先拒，别把 O(n·m) 表撑爆）。
 */

export type ParagraphCompareKind = "same" | "removed" | "added" | "changed";

export interface ParagraphCompareEntry {
  kind: ParagraphCompareKind;
  /** 基准（左侧）文档的段落文本；added 时没有。 */
  left?: string;
  /** 对比（右侧）文档的段落文本；removed 时没有。 */
  right?: string;
}

export interface ParagraphCompareSummary {
  same: number;
  changed: number;
  added: number;
  removed: number;
  /** 对齐后的条目总数 = same + changed + added + removed。 */
  total: number;
}

/**
 * 段落级 LCS diff；removed 紧跟 added 时合并成 changed（与 UI 同一条规则）。
 *
 * `left` = 基准文档段落，`right` = 对比文档段落。顺序敏感的典型用法：
 * left 是旧版/模板，right 是新版/被对比文档。
 */
export function compareParagraphs(
  left: readonly string[],
  right: readonly string[],
): ParagraphCompareEntry[] {
  const n = left.length;
  const m = right.length;
  const width = m + 1;
  // lcs[i][j] = left[i:] 与 right[j:] 的 LCS 长度（后缀表，便于正向回溯）。
  // 扁平 Uint32Array：大文档下比 number[][] 省一个数量级的内存。
  const lcs = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = left[i] === right[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const raw: ParagraphCompareEntry[] = [];
  let i = 0;
  let j = 0;
  // 索引都在 n/m 边界内（循环条件保证），非空断言只为满足 noUncheckedIndexedAccess。
  while (i < n && j < m) {
    const leftText = left[i]!;
    const rightText = right[j]!;
    if (leftText === rightText) {
      raw.push({ kind: "same", left: leftText, right: rightText });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      raw.push({ kind: "removed", left: leftText });
      i += 1;
    } else {
      raw.push({ kind: "added", right: rightText });
      j += 1;
    }
  }
  while (i < n) {
    raw.push({ kind: "removed", left: left[i]! });
    i += 1;
  }
  while (j < m) {
    raw.push({ kind: "added", right: right[j]! });
    j += 1;
  }

  const out: ParagraphCompareEntry[] = [];
  for (const entry of raw) {
    const prev = out[out.length - 1];
    if (entry.kind === "added" && prev?.kind === "removed" && prev.right === undefined) {
      prev.kind = "changed";
      if (entry.right !== undefined) prev.right = entry.right;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** 计数统计（含 same/total：UI 侧只算增删改，Agent 侧需要完整分布判断“只是格式变了”）。 */
export function summarizeParagraphCompare(
  entries: readonly ParagraphCompareEntry[],
): ParagraphCompareSummary {
  let same = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "same": same += 1; break;
      case "changed": changed += 1; break;
      case "added": added += 1; break;
      case "removed": removed += 1; break;
    }
  }
  return { same, changed, added, removed, total: entries.length };
}