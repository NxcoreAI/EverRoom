import type { NormalizedCalendarChange, NormalizedAddress } from "@nxcore/connector-contract";

/**
 * 最小 ICS（RFC 5545）解析器——WebCal 订阅试点用。刻意不引第三方依赖。
 * 支持：行展开（续行）、VEVENT 的 UID/SUMMARY/DESCRIPTION/LOCATION/DTSTART/DTEND
 * （VALUE=DATE 全天 / TZID 时区 / UTC 'Z' / 浮点本地时间按本机时区）、
 * STATUS:CANCELLED → tombstone、ORGANIZER/ATTENDEE（mailto: 与 CN）、
 * DTSTAMP+SEQUENCE 作为 providerRevision。
 * 不支持（v1 已知边界）：RRULE 展开只取 VEVENT 本体一次（重复日程仅首次出现）；
 * VALARM/VTODO/X- 属性忽略。
 */

/** RFC5545 行展开：以空格/制表符起始的行是上一行的续行。 */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** "NAME;PARAM=V;PARAM2=\"quoted\":value" → { name, params, value }。 */
export function parseIcsLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = findUnquotedColon(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = splitUnquoted(head, ";");
  const name = (segments.shift() ?? "").toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq > 0) params[segment.slice(0, eq).toUpperCase()] = unescapeText(segment.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return { name, params, value };
}

function findUnquotedColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) return index;
  }
  return -1;
}

function splitUnquoted(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** RFC5545 文本转义：\\n 换行、\\, \\; \\\\。 */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

interface IcsDate {
  iso: string;
  allDay: boolean;
}

/** 目标时区在给定 UTC 时刻的偏移（ms）。Intl.formatToParts 法，与进程时区无关。 */
function timeZoneOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(utcMs));
    const valueOf = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    const asUtc = Date.UTC(valueOf("year"), valueOf("month") - 1, valueOf("day"), valueOf("hour") % 24, valueOf("minute"), valueOf("second"));
    return Number.isNaN(asUtc) ? null : asUtc - utcMs;
  } catch {
    return null;
  }
}

/** 墙钟时间（目标时区）→ UTC 时刻：两遍偏移法（吸收 DST 边界）。 */
function wallClockToUtc(wallMs: number, timeZone: string): string | null {
  const first = timeZoneOffsetMs(wallMs, timeZone);
  if (first === null) return null;
  const refined = timeZoneOffsetMs(wallMs - first, timeZone);
  if (refined === null) return null;
  return new Date(wallMs - refined).toISOString();
}

/** DTSTART/DTEND 解析：VALUE=DATE → 全天；带 Z → UTC；TZID → 指定时区换算；浮点 → 本机时区。 */
export function parseIcsDate(value: string, params: Record<string, string>): IcsDate | null {
  const raw = value.trim();
  if (!raw) return null;
  if (params.VALUE === "DATE" || /^\d{8}$/.test(raw)) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    return { iso: `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`, allDay: true };
  }
  const dateTime = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!dateTime) return null;
  const [, year, month, day, hour, minute, second, zulu] = dateTime;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (zulu) return { iso: `${local}.000Z`, allDay: false };
  const wallMs = new Date(`${local}Z`).getTime();
  if (params.TZID) {
    const converted = wallClockToUtc(wallMs, params.TZID);
    if (converted) return { iso: converted, allDay: false };
    // 未知时区：按浮点本地时间处理。
  }
  return { iso: new Date(local).toISOString(), allDay: false };
}

function addressOf(params: Record<string, string>, value: string, role: string): NormalizedAddress | undefined {
  const address = value.replace(/^mailto:/i, "").trim().toLowerCase();
  if (!address || !address.includes("@")) return undefined;
  return { role, ...(params.CN ? { displayName: unescapeText(params.CN) } : {}), address };
}

export interface IcsCalendarParseResult {
  events: NormalizedCalendarChange[];
  /** 解析失败（缺 UID/时间非法等）被跳过的事件数——sync_failures 汇总用。 */
  skipped: number;
}

export function parseIcsCalendar(text: string): IcsCalendarParseResult {
  const lines = unfoldIcsLines(text);
  const events: NormalizedCalendarChange[] = [];
  let skipped = 0;
  let index = 0;
  while (index < lines.length) {
    const begin = parseIcsLine(lines[index]!);
    if (!begin || begin.name !== "BEGIN" || begin.value.trim().toUpperCase() !== "VEVENT") {
      index += 1;
      continue;
    }
    index += 1;
    const properties: Array<{ name: string; params: Record<string, string>; value: string }> = [];
    while (index < lines.length) {
      const property = parseIcsLine(lines[index]!);
      if (!property) {
        index += 1;
        continue;
      }
      if (property.name === "END" && property.value.trim().toUpperCase() === "VEVENT") {
        index += 1;
        break;
      }
      properties.push(property);
      index += 1;
    }
    const change = eventOf(properties);
    if (change) events.push(change);
    else skipped += 1;
  }
  return { events, skipped };
}

function eventOf(properties: Array<{ name: string; params: Record<string, string>; value: string }>): NormalizedCalendarChange | null {
  const valueOf = (name: string) => properties.find((property) => property.name === name)?.value ?? "";
  const propertyOf = (name: string) => properties.find((property) => property.name === name);
  const uid = valueOf("UID").trim();
  if (!uid) return null;
  if (valueOf("STATUS").trim().toUpperCase() === "CANCELLED")
    return { kind: "tombstone", providerEventId: uid };
  const start = parseIcsDate(valueOf("DTSTART"), propertyOf("DTSTART")?.params ?? {});
  if (!start) return null;
  const endProperty = propertyOf("DTEND");
  const parsedEnd = endProperty
    ? parseIcsDate(endProperty.value, endProperty.params ?? {})
    : null;
  const end = parsedEnd
    ?? (start.allDay
      ? { iso: new Date(new Date(start.iso).getTime() + 86_400_000).toISOString(), allDay: true }
      : { iso: start.iso, allDay: false });
  const organizerProperty = propertyOf("ORGANIZER");
  const organizerAddress = organizerProperty
    ? addressOf(organizerProperty.params, organizerProperty.value, "organizer")
    : undefined;
  const attendees = properties
    .filter((property) => property.name === "ATTENDEE")
    .map((property) => addressOf(property.params, property.value, "attendee"))
    .filter((address): address is NormalizedAddress => address !== undefined);
  const title = unescapeText(valueOf("SUMMARY")).trim() || "（无标题）";
  const description = unescapeText(valueOf("DESCRIPTION")).trim();
  const location = unescapeText(valueOf("LOCATION")).trim();
  const stamp = valueOf("DTSTAMP").trim();
  const sequence = valueOf("SEQUENCE").trim();
  const recurrence = valueOf("RRULE").trim();
  const status = valueOf("STATUS").trim().toLowerCase();
  return {
    kind: "upsert",
    event: {
      providerEventId: uid,
      title,
      ...(description ? { description } : {}),
      startsAt: start.iso,
      endsAt: end.iso,
      // 全天语义透传（M1 已知限制就此对 ICS 路径关闭）。
      ...(start.allDay ? { allDay: true } : {}),
      ...(location ? { location } : {}),
      ...(status ? { status } : {}),
      ...(organizerAddress ? { organizer: organizerAddress } : {}),
      ...(attendees.length > 0 ? { attendees } : {}),
      // RRULE 未展开（只取首次出现）——以 recurrence 原文标记，供投影/展示侧提示。
      ...(recurrence ? { recurrence: { rules: [recurrence] } } : {}),
      ...(stamp || sequence ? { providerRevision: `${stamp}#${sequence || "0"}${recurrence ? "#rrule" : ""}` } : {}),
    },
  };
}
