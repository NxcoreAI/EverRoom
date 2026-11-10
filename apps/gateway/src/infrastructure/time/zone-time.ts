/**
 * 时区换算工具（Phase 1 迁出）：原生于 diary/utils，但日历调度器也需要它。
 * 放在 infrastructure 下，避免存活模块反向依赖将被删除的 diary 模块。
 */

function localParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function zonedTimeToUtc(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = new Date(target);
  for (let index = 0; index < 3; index += 1) {
    const parts = localParts(result, timezone);
    const observed = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    result = new Date(target + (target - observed));
  }
  return result;
}

export function dateInTimezone(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return `${String(parts.year!).padStart(4, "0")}-${String(parts.month!).padStart(2, "0")}-${String(parts.day!).padStart(2, "0")}`;
}

export function localDateTime(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return `${String(parts.year!).padStart(4, "0")}-${String(parts.month!).padStart(2, "0")}-${String(parts.day!).padStart(2, "0")} ${String(parts.hour!).padStart(2, "0")}:${String(parts.minute!).padStart(2, "0")}:${String(parts.second!).padStart(2, "0")}`;
}
