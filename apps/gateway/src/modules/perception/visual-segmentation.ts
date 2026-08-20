export const MAX_SCREENSHOT_SEGMENT_MS = 30 * 60 * 1_000;
export const SCREENSHOT_REANALYSIS_INTERVAL_MS = 15 * 60 * 1_000;

const MIN_CONTINUITY_MS = 10 * 60 * 1_000;
const MAX_CONTINUITY_MS = 2 * 60 * 60 * 1_000;
const MAX_PERCEPTUAL_DISTANCE = 6;

export function screenshotContinuityMs(captureIntervalSeconds: number): number {
  return Math.min(
    MAX_CONTINUITY_MS,
    Math.max(captureIntervalSeconds * 2_000, MIN_CONTINUITY_MS),
  );
}

export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 65;
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

export function shouldGroupScreenshot(input: {
  nodeStartAt: Date;
  nodeEndAt: Date;
  capturedAt: Date;
  previousHash: string | null;
  currentHash: string;
  continuityMs: number;
}): boolean {
  const gapMs = input.capturedAt.getTime() - input.nodeEndAt.getTime();
  const segmentDurationMs = input.capturedAt.getTime() - input.nodeStartAt.getTime();
  return gapMs >= 0
    && gapMs <= input.continuityMs
    && segmentDurationMs < MAX_SCREENSHOT_SEGMENT_MS
    && input.previousHash !== null
    && hammingDistance(input.previousHash, input.currentHash) <= MAX_PERCEPTUAL_DISTANCE;
}

export function shouldRefreshRepresentative(input: {
  capturedAt: Date;
  representativeCapturedAt: Date | null;
}): boolean {
  return input.representativeCapturedAt === null
    || input.capturedAt.getTime() - input.representativeCapturedAt.getTime() >= SCREENSHOT_REANALYSIS_INTERVAL_MS;
}
