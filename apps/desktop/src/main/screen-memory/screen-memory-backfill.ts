import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { diffKeyframeText } from './text-diff'
import { blocksWithNewLines, clusterOcrLines } from './line-clustering'
import { IntervalTracker, type ClosedInterval } from './interval-tracker'
import { getScreenMemoryImagesDirectory } from './screen-memory-settings'
import type { VisionOcrResult } from '../vision-ocr/vision-ocr-client'

/** 历史补处理：网关截图资产按时间窗分批取回，本地走同一条 OCR+差异+区间管线，保留原始观察日期。 */
export interface ScreenMemoryBackfillDeps {
  ocr: {
    ocr(imagePath: string, options?: { level?: 'accurate' | 'fast'; compressOut?: string }): Promise<VisionOcrResult>
  }
  persist: { saveInterval(interval: ClosedInterval): Promise<void> }
  gatewayJson(path: string, init?: { method?: string; body?: unknown }): Promise<unknown>
  baseDirectory: string
  onError?: (message: string) => void
}

export interface ScreenMemoryBackfillInput {
  from: string
  to: string
  maxItems: number
}

export interface ScreenMemoryBackfillSummary {
  processed: number
  intervals: number
  keyframes: number
}

const BATCH_SIZE = 10
const INTERVAL_GAP_MS = 15 * 60_000

interface BackfillItem {
  id: string
  capturedAt: string
  bytesBase64: string
}

export async function runScreenMemoryBackfill(
  deps: ScreenMemoryBackfillDeps,
  input: ScreenMemoryBackfillInput,
): Promise<ScreenMemoryBackfillSummary> {
  const summary: ScreenMemoryBackfillSummary = { processed: 0, intervals: 0, keyframes: 0 }
  const inboxDirectory = join(deps.baseDirectory, 'inbox')
  await mkdir(inboxDirectory, { recursive: true })

  const tracker = new IntervalTracker({
    onIntervalClosed: (interval) => {
      summary.intervals += 1
      void deps.persist.saveInterval(interval).catch((error: unknown) => {
        deps.onError?.(`backfill interval save failed: ${String(error instanceof Error ? error.message : error)}`)
      })
    },
  })

  let afterCapturedAt: string | undefined
  let lastFrameAt: Date | null = null

  while (summary.processed < input.maxItems) {
    const batchResult = await deps.gatewayJson('/v1/screen-memory/backfill/batch', {
      method: 'POST',
      body: {
        from: input.from,
        to: input.to,
        ...(afterCapturedAt !== undefined ? { afterCapturedAt } : {}),
        limit: Math.min(BATCH_SIZE, input.maxItems - summary.processed),
      },
    }) as { items: BackfillItem[]; exhausted: boolean }

    for (const item of batchResult.items) {
      const capturedAt = new Date(item.capturedAt)
      afterCapturedAt = item.capturedAt
      if (lastFrameAt && capturedAt.getTime() - lastFrameAt.getTime() > INTERVAL_GAP_MS) {
        tracker.systemEvent('idle', lastFrameAt)
      }
      lastFrameAt = capturedAt
      summary.processed += 1

      const rawPath = join(inboxDirectory, `backfill-${randomUUID()}.jpg`)
      const month = `${String(capturedAt.getFullYear())}-${String(capturedAt.getMonth() + 1).padStart(2, '0')}`
      const imageDirectory = join(getScreenMemoryImagesDirectory(deps.baseDirectory), month)
      const compressedPath = join(imageDirectory, `SM-${capturedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.jpg`)
      try {
        await mkdir(imageDirectory, { recursive: true })
        await writeFile(rawPath, Buffer.from(item.bytesBase64, 'base64'))
        const result = await deps.ocr.ocr(rawPath, { compressOut: compressedPath })
        const clustered = clusterOcrLines(result.lines, { width: result.width, height: result.height })
        const decision = diffKeyframeText(tracker.lastStableLines(), clustered.orderedLines)
        if (!decision.changed) {
          await rm(compressedPath, { force: true }).catch(() => undefined)
          continue
        }
        tracker.acceptKeyframe({
          now: capturedAt,
          bundleId: 'history.screenshot',
          appName: '历史截图',
          windowTitle: null,
          keyframe: {
            capturedAt,
            imagePath: compressedPath,
            imageBytes: result.compressedBytes ?? 0,
            perceptualHash: 'history',
            width: result.width,
            height: result.height,
            lineCount: result.lines.length,
            elapsedMs: result.elapsedMs,
          },
          stableLines: decision.stableLines,
          newLines: decision.newLines,
          newBlocks: blocksWithNewLines(clustered.blocks, decision.newLines),
        })
        summary.keyframes += 1
      } catch (error) {
        deps.onError?.(`backfill ocr failed (${item.id}): ${String(error instanceof Error ? error.message : error)}`)
      } finally {
        await rm(rawPath, { force: true }).catch(() => undefined)
      }
    }

    if (batchResult.exhausted || batchResult.items.length === 0) break
  }

  tracker.stop(lastFrameAt ?? new Date())
  return summary
}
