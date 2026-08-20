import type { DiaryPayload } from "../../infrastructure/database/schema.js";
import type { DiarySource } from "./types.js";
import { iso } from "./utils.js";

export function validateDiaryPayload(
  payload: DiaryPayload,
  range: { windowStart: Date; windowEnd: Date },
  manifest: Map<string, DiarySource>,
): void {
  if (!payload || typeof payload.headline !== "string" || typeof payload.summary !== "string"
    || typeof payload.reflection !== "string" || typeof payload.closing !== "string"
    || !payload.range || !Array.isArray(payload.events)) throw new Error("invalid_diary_payload");
  if (payload.range.start !== iso(range.windowStart) || payload.range.end !== iso(range.windowEnd)) {
    throw new Error("invalid_diary_range");
  }
  for (const event of payload.events) {
    if (!event || typeof event.time !== "string" || (event.endTime !== undefined && typeof event.endTime !== "string")
      || typeof event.title !== "string" || typeof event.summary !== "string"
      || !Array.isArray(event.sourceRefs) || event.sourceRefs.length === 0
      || event.sourceRefs.some((ref) => typeof ref !== "string" || !manifest.has(ref))
      || (event.tags !== undefined && (!Array.isArray(event.tags) || event.tags.some((tag) => typeof tag !== "string")))) {
      throw new Error("invalid_diary_event");
    }
    const time = new Date(event.time);
    if (Number.isNaN(time.getTime()) || time < range.windowStart || time >= range.windowEnd) {
      throw new Error("event_outside_window");
    }
    if (event.endTime !== undefined) {
      const endTime = new Date(event.endTime);
      if (Number.isNaN(endTime.getTime()) || endTime < time || endTime > range.windowEnd) {
        throw new Error("invalid_diary_event_range");
      }
    }
  }
}

export function alignDiaryEventTimes(payload: DiaryPayload, manifest: Map<string, DiarySource>): number {
  let corrected = 0;
  for (const event of payload.events) {
    const sources = event.sourceRefs.map((ref) => manifest.get(ref)).filter((source): source is DiarySource => Boolean(source));
    const start = new Date(Math.min(...sources.map((source) => new Date(source.occurredAt).getTime())));
    const end = new Date(Math.max(...sources.map((source) => new Date(source.endedAt ?? source.occurredAt).getTime())));
    const alignedTime = iso(start);
    const spansMultipleMinutes = Math.floor(end.getTime() / 60_000) > Math.floor(start.getTime() / 60_000);
    const alignedEndTime = spansMultipleMinutes ? iso(end) : undefined;
    if (event.time !== alignedTime || event.endTime !== alignedEndTime) corrected += 1;
    event.time = alignedTime;
    if (alignedEndTime) event.endTime = alignedEndTime;
    else delete event.endTime;
  }
  return corrected;
}
