import { createHash, randomUUID } from "node:crypto";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import * as Y from "yjs";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentVersions,
  documentYjsCheckpoints,
  documentYjsUpdates,
  documentYjsVersions,
} from "../../../infrastructure/database/schema.js";

export type DiffBlockStatus = "added" | "removed" | "modified" | "unchanged";

export interface DocumentDiffSpan {
  type: "equal" | "insert" | "delete";
  text: string;
}

export interface DocumentDiffBlock {
  blockId: string;
  status: DiffBlockStatus;
  type: string;
  path: number[];
  before?: TiptapJsonContent;
  after?: TiptapJsonContent;
  textDiff: DocumentDiffSpan[];
  unstableMatch?: boolean;
}

export interface DocumentDiffResult {
  documentId: string;
  fromVersion: number | null;
  toVersion: number;
  blocks: DocumentDiffBlock[];
  yjsBackfilled: boolean;
  truncated?: boolean;
  truncatedReason?: "too_large";
}

interface StoredYjsState {
  doc: Y.Doc;
}

interface CommitHistoryInput {
  documentId: string;
  version: number;
  title: string;
  content: TiptapJsonContent;
  contentSchemaVersion: number;
  source?: string | null;
  now: Date;
  backfilled?: boolean;
}

const ROOT_KEY = "document";
const CHECKPOINT_EVERY_VERSIONS = 100;
const CHECKPOINT_MAX_UPDATE_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BLOCKS = 2_000;
const MAX_DIFF_LCS_CELLS = 250_000;

function toBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function toUint8Array(value: Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function contentHash(title: string, content: TiptapJsonContent, schemaVersion: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ title, content, schemaVersion }))
    .digest("hex");
}

function replaceText(text: Y.Text, next: string): void {
  const current = text.toString();
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < next.length - prefix
    && current[current.length - suffix - 1] === next[next.length - suffix - 1]
  ) suffix += 1;
  if (current.length > prefix + suffix) text.delete(prefix, current.length - prefix - suffix);
  if (next.length > prefix + suffix) text.insert(prefix, next.slice(prefix, next.length - suffix));
}

function setDocumentRoot(doc: Y.Doc, input: Pick<CommitHistoryInput, "title" | "content" | "contentSchemaVersion">): void {
  const root = doc.getMap<unknown>(ROOT_KEY);
  root.set("title", input.title);
  root.set("schemaVersion", String(input.contentSchemaVersion));
  const content = JSON.stringify(input.content);
  const existing = root.get("content");
  if (existing instanceof Y.Text) {
    replaceText(existing, content);
  } else {
    const text = new Y.Text();
    text.insert(0, content);
    root.set("content", text);
  }
}

function readDocumentRoot(doc: Y.Doc): { title: string; content: TiptapJsonContent; schemaVersion: number } | null {
  const root = doc.getMap<unknown>(ROOT_KEY);
  const rawContent = root.get("content");
  const contentText = rawContent instanceof Y.Text ? rawContent.toString() : rawContent;
  if (typeof contentText !== "string") return null;
  try {
    const parsed = JSON.parse(contentText) as TiptapJsonContent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    const rawSchemaVersion = root.get("schemaVersion");
    const schemaVersion = Number(rawSchemaVersion);
    return {
      title: typeof root.get("title") === "string" ? root.get("title") as string : "无标题文档",
      content: parsed,
      schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : 1,
    };
  } catch {
    return null;
  }
}

function textOfNode(node: TiptapJsonContent): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOfNode).join("");
}

function blocksOfDocument(content: TiptapJsonContent): Array<{
  blockId: string;
  stableId: boolean;
  type: string;
  path: number[];
  node: TiptapJsonContent;
  text: string;
}> {
  const blocks: Array<{
    blockId: string;
    stableId: boolean;
    type: string;
    path: number[];
    node: TiptapJsonContent;
    text: string;
  }> = [];
  // The editor presents document children as the diffable blocks. Matching
  // every descendant (including inline text nodes) inflates large-document
  // diffs and produces entries the renderer cannot display.
  (content.content ?? []).forEach((node, index) => {
    const path = [index];
    const explicitId = typeof node.attrs?.id === "string" ? node.attrs.id : null;
    blocks.push({
      blockId: explicitId ?? `path:${path.join(".")}`,
      stableId: explicitId !== null,
      type: node.type,
      path,
      node,
      text: textOfNode(node),
    });
  });
  return blocks;
}

type HistoryBlock = ReturnType<typeof blocksOfDocument>[number];

function blockKey(block: HistoryBlock): string {
  return `${block.type}\u0000${block.text}`;
}

function comparableBlockNode(node: TiptapJsonContent): TiptapJsonContent {
  const normalized: TiptapJsonContent = { ...node };
  if (node.attrs) {
    // Block ids and TableOfContents-generated ids are editor metadata. They
    // may be regenerated while saving without changing the document's
    // visible content and should not create a semantic history diff.
    const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([key]) => (
      key !== "id" && key !== "data-toc-id"
    )));
    if (Object.keys(attrs).length) normalized.attrs = attrs;
    else delete normalized.attrs;
  }
  if (node.content) normalized.content = node.content.map(comparableBlockNode);
  return normalized;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function sameBlockContent(left: TiptapJsonContent, right: TiptapJsonContent): boolean {
  return JSON.stringify(canonicalJson(comparableBlockNode(left)))
    === JSON.stringify(canonicalJson(comparableBlockNode(right)));
}

function lcsPairs(before: HistoryBlock[], after: HistoryBlock[]): Array<[number, number]> {
  const widths = after.length + 1;
  const table = Array.from({ length: before.length + 1 }, () => new Array<number>(widths).fill(0));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex]![afterIndex] = blockKey(before[beforeIndex]!) === blockKey(after[afterIndex]!)
        ? table[beforeIndex + 1]![afterIndex + 1]! + 1
        : Math.max(table[beforeIndex + 1]![afterIndex]!, table[beforeIndex]![afterIndex + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (blockKey(before[beforeIndex]!) === blockKey(after[afterIndex]!)
      && table[beforeIndex]![afterIndex] === table[beforeIndex + 1]![afterIndex + 1]! + 1) {
      pairs.push([beforeIndex, afterIndex]);
      beforeIndex += 1;
      afterIndex += 1;
    } else if (table[beforeIndex + 1]![afterIndex]! >= table[beforeIndex]![afterIndex + 1]!) {
      beforeIndex += 1;
    } else {
      afterIndex += 1;
    }
  }
  return pairs;
}

function inlineDiff(before: string, after: string): DocumentDiffSpan[] {
  if (before === after) return before ? [{ type: "equal", text: before }] : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix += 1;
  const spans: DocumentDiffSpan[] = [];
  if (prefix) spans.push({ type: "equal", text: before.slice(0, prefix) });
  if (before.length > prefix + suffix) spans.push({ type: "delete", text: before.slice(prefix, before.length - suffix) });
  if (after.length > prefix + suffix) spans.push({ type: "insert", text: after.slice(prefix, after.length - suffix) });
  if (suffix) spans.push({ type: "equal", text: after.slice(after.length - suffix) });
  return spans;
}

export class YjsHistoryService {
  writeCommit(tx: GatewayDatabase, input: CommitHistoryInput): void {
    let previous: StoredYjsState | null = null;
    let historyBroken = false;
    if (input.version > 0) {
      try {
        previous = this.loadState(tx, input.documentId, input.version - 1);
      } catch {
        historyBroken = true;
      }
    }
    const doc = previous?.doc ?? new Y.Doc();
    const previousStateVector = previous ? Y.encodeStateVector(previous.doc) : null;
    doc.transact(() => setDocumentRoot(doc, input));
    const update = Y.encodeStateAsUpdate(doc, previousStateVector ?? undefined);
    const updateId = randomUUID();
    const shouldCheckpoint = historyBroken
      || input.version === 1
      || input.version % CHECKPOINT_EVERY_VERSIONS === 0
      || update.byteLength >= CHECKPOINT_MAX_UPDATE_BYTES;
    let checkpointId: string | null = null;
    if (shouldCheckpoint) {
      checkpointId = randomUUID();
      const checkpointDoc = new Y.Doc();
      checkpointDoc.transact(() => setDocumentRoot(checkpointDoc, input));
      tx.insert(documentYjsCheckpoints).values({
        id: checkpointId,
        documentId: input.documentId,
        throughVersion: input.version,
        docState: toBuffer(Y.encodeStateAsUpdate(checkpointDoc)),
        schemaVersion: input.contentSchemaVersion,
        createdAt: input.now,
      }).run();
    }
    tx.insert(documentYjsUpdates).values({
      id: updateId,
      documentId: input.documentId,
      version: input.version,
      update: toBuffer(update),
      source: input.source ?? "commit",
      contentHash: contentHash(input.title, input.content, input.contentSchemaVersion),
      createdAt: input.now,
    }).run();
    tx.insert(documentYjsVersions).values({
      documentId: input.documentId,
      version: input.version,
      updateId,
      checkpointId,
      backfilled: input.backfilled ?? true,
      createdAt: input.now,
    }).run();
    // Keep the current version materialized for fast reads. Once a newer
    // version exists, release the previous non-checkpoint JSON snapshot; its
    // authoritative content remains available through the Yjs chain.
    if (input.version > 1) {
      const previousVersion = tx.select({ checkpointId: documentYjsVersions.checkpointId })
        .from(documentYjsVersions)
        .where(and(
          eq(documentYjsVersions.documentId, input.documentId),
          eq(documentYjsVersions.version, input.version - 1),
        )).get();
      const previousMaterialized = previousVersion && !previousVersion.checkpointId
        ? this.materialize(tx, input.documentId, input.version - 1)
        : null;
      if (previousVersion && !previousVersion.checkpointId && previousMaterialized?.yjsBackfilled) {
        tx.update(documentVersions).set({ contentJson: null }).where(and(
          eq(documentVersions.documentId, input.documentId),
          eq(documentVersions.version, input.version - 1),
        )).run();
      }
    }
  }

  materialize(db: GatewayDatabase, documentId: string, version: number): {
    title: string;
    content: TiptapJsonContent;
    schemaVersion: number;
    yjsBackfilled: boolean;
  } | null {
    const versionRow = db.select().from(documentVersions).where(and(
      eq(documentVersions.documentId, documentId),
      eq(documentVersions.version, version),
    )).get();
    if (!versionRow) return null;
    let state: StoredYjsState | null = null;
    try {
      state = this.loadState(db, documentId, version);
    } catch {
      // Retained JSON snapshots remain the recovery authority when an
      // incremental Yjs row is truncated or otherwise corrupt.
      state = null;
    }
    const materialized = state ? readDocumentRoot(state.doc) : null;
    if (!materialized) {
      if (versionRow.contentJson === null) return null;
      return {
        title: versionRow.title,
        content: versionRow.contentJson as TiptapJsonContent,
        schemaVersion: versionRow.contentSchemaVersion,
        yjsBackfilled: false,
      };
    }
    const mapping = db.select().from(documentYjsVersions).where(and(
      eq(documentYjsVersions.documentId, documentId),
      eq(documentYjsVersions.version, version),
    )).get();
    const updateRow = db.select({ contentHash: documentYjsUpdates.contentHash })
      .from(documentYjsUpdates)
      .where(and(
        eq(documentYjsUpdates.documentId, documentId),
        eq(documentYjsUpdates.version, version),
      )).get();
    const materializedHash = contentHash(materialized.title, materialized.content, materialized.schemaVersion);
    if (!updateRow
      || updateRow.contentHash !== materializedHash
      || (versionRow.contentJson !== null && materializedHash !== contentHash(
        versionRow.title,
        versionRow.contentJson as TiptapJsonContent,
        versionRow.contentSchemaVersion,
      ))) {
      if (versionRow.contentJson === null) return null;
      return {
        title: versionRow.title,
        content: versionRow.contentJson as TiptapJsonContent,
        schemaVersion: versionRow.contentSchemaVersion,
        yjsBackfilled: false,
      };
    }
    return { ...materialized, yjsBackfilled: mapping?.backfilled ?? false };
  }

  diff(db: GatewayDatabase, documentId: string, fromVersion: number | null, toVersion: number): DocumentDiffResult | null {
    const to = this.materialize(db, documentId, toVersion);
    if (!to) return null;
    const from = fromVersion === null ? null : this.materialize(db, documentId, fromVersion);
    const beforeBlocks = from ? blocksOfDocument(from.content) : [];
    const afterBlocks = blocksOfDocument(to.content);
    if (beforeBlocks.length > MAX_DIFF_BLOCKS
      || afterBlocks.length > MAX_DIFF_BLOCKS
      || beforeBlocks.length * afterBlocks.length > MAX_DIFF_LCS_CELLS) {
      return {
        documentId,
        fromVersion,
        toVersion,
        blocks: [{
          blockId: "document",
          status: "modified",
          type: "doc",
          path: [],
          ...(from ? { before: from.content } : {}),
          after: to.content,
          textDiff: inlineDiff(from ? textOfNode(from.content) : "", textOfNode(to.content)),
        }],
        yjsBackfilled: to.yjsBackfilled && (from?.yjsBackfilled ?? true),
        truncated: true,
        truncatedReason: "too_large",
      };
    }
    const beforeMatched = new Set<number>();
    const afterMatched = new Set<number>();
    const matches = new Map<number, { beforeIndex: number; unstable: boolean }>();

    // Explicit block IDs are authoritative and survive reordering or text edits.
    const beforeByStableId = new Map<string, number>();
    beforeBlocks.forEach((block, index) => {
      if (block.stableId && !beforeByStableId.has(block.blockId)) beforeByStableId.set(block.blockId, index);
    });
    afterBlocks.forEach((block, afterIndex) => {
      if (!block.stableId) return;
      const beforeIndex = beforeByStableId.get(block.blockId);
      if (beforeIndex === undefined || beforeMatched.has(beforeIndex)) return;
      beforeMatched.add(beforeIndex);
      afterMatched.add(afterIndex);
      matches.set(afterIndex, { beforeIndex, unstable: false });
    });

    // Path matches are safe only when the block content is unchanged. This
    // prevents inserting a block at the top from shifting every fallback ID.
    afterBlocks.forEach((block, afterIndex) => {
      if (afterMatched.has(afterIndex) || block.stableId) return;
      const beforeIndex = beforeBlocks.findIndex((candidate, index) => (
        !beforeMatched.has(index)
        && !candidate.stableId
        && candidate.blockId === block.blockId
        && sameBlockContent(candidate.node, block.node)
      ));
      if (beforeIndex < 0) return;
      beforeMatched.add(beforeIndex);
      afterMatched.add(afterIndex);
      matches.set(afterIndex, { beforeIndex, unstable: false });
    });

    // Match equal fallback blocks by order so moves are not rendered as edits.
    const remainingBefore = beforeBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !beforeMatched.has(index));
    const remainingAfter = afterBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !afterMatched.has(index));
    for (const [beforeOffset, afterOffset] of lcsPairs(
      remainingBefore.map(({ block }) => block),
      remainingAfter.map(({ block }) => block),
    )) {
      const beforeIndex = remainingBefore[beforeOffset]!.index;
      const afterIndex = remainingAfter[afterOffset]!.index;
      beforeMatched.add(beforeIndex);
      afterMatched.add(afterIndex);
      matches.set(afterIndex, { beforeIndex, unstable: true });
    }

    // Remaining same-position blocks are likely edits. Mark them unstable so
    // callers can distinguish the heuristic from an explicit block identity.
    const unmatchedBefore = beforeBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !beforeMatched.has(index));
    const unmatchedAfter = afterBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !afterMatched.has(index));
    for (let index = 0; index < Math.min(unmatchedBefore.length, unmatchedAfter.length); index += 1) {
      const before = unmatchedBefore[index]!;
      const after = unmatchedAfter[index]!;
      if (before.block.type !== after.block.type) continue;
      beforeMatched.add(before.index);
      afterMatched.add(after.index);
      matches.set(after.index, { beforeIndex: before.index, unstable: true });
    }

    const blocks: DocumentDiffBlock[] = [];
    afterBlocks.forEach((block, afterIndex) => {
      const match = matches.get(afterIndex);
      const previous = match ? beforeBlocks[match.beforeIndex] : undefined;
      if (!previous) {
        blocks.push({ blockId: block.blockId, status: "added", type: block.type, path: block.path, after: block.node, textDiff: [{ type: "insert", text: block.text }] });
      } else {
        const changed = !sameBlockContent(previous.node, block.node);
        blocks.push({
          blockId: block.blockId,
          status: changed ? "modified" : "unchanged",
          type: block.type,
          path: block.path,
          ...(changed ? { before: previous.node, after: block.node } : {}),
          ...(changed ? {} : { after: block.node }),
          textDiff: inlineDiff(previous.text, block.text),
          ...(match?.unstable ? { unstableMatch: true } : {}),
        });
      }
    });
    beforeBlocks.forEach((block, beforeIndex) => {
      if (!beforeMatched.has(beforeIndex)) {
        blocks.push({ blockId: block.blockId, status: "removed", type: block.type, path: block.path, before: block.node, textDiff: [{ type: "delete", text: block.text }] });
      }
    });
    return {
      documentId,
      fromVersion,
      toVersion,
      blocks,
      yjsBackfilled: to.yjsBackfilled && (from?.yjsBackfilled ?? true),
    };
  }

  backfillDocument(db: GatewayDatabase, documentId: string, maxVersions = 50): number {
    let count = 0;
    db.transaction((tx) => {
      const rows = tx.select().from(documentVersions)
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(asc(documentVersions.version)).all();
      let existingVersions = new Set(tx.select({ version: documentYjsVersions.version })
        .from(documentYjsVersions)
        .where(eq(documentYjsVersions.documentId, documentId))
        .all()
        .map((row) => row.version));
      const recovered = new Map<number, TiptapJsonContent>();
      for (const row of rows) {
        const materialized = this.materialize(tx, documentId, row.version);
        if (materialized?.content) recovered.set(row.version, materialized.content);
        else if (row.contentJson === null) {
          throw new Error(`Document history version ${row.version} cannot be reconstructed`);
        }
      }
      const hasCorruption = rows.some((row) => {
        if (!existingVersions.has(row.version)) return false;
        const materialized = this.materialize(tx, documentId, row.version);
        return !materialized?.yjsBackfilled;
      });
      if (hasCorruption) {
        tx.delete(documentYjsVersions).where(eq(documentYjsVersions.documentId, documentId)).run();
        tx.delete(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, documentId)).run();
        tx.delete(documentYjsCheckpoints).where(eq(documentYjsCheckpoints.documentId, documentId)).run();
        existingVersions = new Set();
      }
      for (const row of rows) {
        if (count >= maxVersions) break;
        if (existingVersions.has(row.version)) continue;
        this.writeCommit(tx, {
          documentId,
          version: row.version,
          title: row.title,
          content: recovered.get(row.version) ?? row.contentJson as TiptapJsonContent,
          contentSchemaVersion: row.contentSchemaVersion,
          source: row.sourceTransactionId,
          now: row.createdAt,
          backfilled: true,
        });
        existingVersions.add(row.version);
        count += 1;
      }
    });
    return count;
  }

  isHistoryComplete(db: GatewayDatabase, documentId: string): boolean {
    const versions = db.select({ version: documentVersions.version })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .all();
    return versions.every(({ version }) => this.materialize(db, documentId, version)?.yjsBackfilled === true);
  }

  rebuildDocument(db: GatewayDatabase, documentId: string): void {
    const snapshots = db.select().from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.version)).all()
      .map((row) => ({
        ...row,
        content: row.contentJson !== null
          ? row.contentJson as TiptapJsonContent
          : this.materialize(db, documentId, row.version)?.content ?? null,
      }));
    const unavailable = snapshots.find((row) => row.content === null);
    if (unavailable) {
      throw new Error(`Document history version ${unavailable.version} cannot be reconstructed`);
    }
    db.delete(documentYjsVersions).where(eq(documentYjsVersions.documentId, documentId)).run();
    db.delete(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, documentId)).run();
    db.delete(documentYjsCheckpoints).where(eq(documentYjsCheckpoints.documentId, documentId)).run();
    db.transaction((tx) => {
      for (const row of snapshots) {
        this.writeCommit(tx, {
          documentId,
          version: row.version,
          title: row.title,
          content: row.content as TiptapJsonContent,
          contentSchemaVersion: row.contentSchemaVersion,
          source: row.sourceTransactionId,
          now: row.createdAt,
          backfilled: true,
        });
      }
    });
  }

  private loadState(db: GatewayDatabase, documentId: string, version: number): StoredYjsState | null {
    if (version < 1) return null;
    const checkpoint = db.select().from(documentYjsCheckpoints).where(and(
      eq(documentYjsCheckpoints.documentId, documentId),
      lte(documentYjsCheckpoints.throughVersion, version),
    )).orderBy(desc(documentYjsCheckpoints.throughVersion)).get();
    const doc = new Y.Doc();
    let fromVersion = 0;
    if (checkpoint) {
      Y.applyUpdate(doc, toUint8Array(checkpoint.docState));
      fromVersion = checkpoint.throughVersion;
    }
    const updates = db.select().from(documentYjsUpdates).where(and(
      eq(documentYjsUpdates.documentId, documentId),
      gt(documentYjsUpdates.version, fromVersion),
      lte(documentYjsUpdates.version, version),
    )).orderBy(asc(documentYjsUpdates.version)).all();
    if (!checkpoint && updates.length === 0) return null;
    for (const row of updates) Y.applyUpdate(doc, toUint8Array(row.update));
    return { doc };
  }
}
