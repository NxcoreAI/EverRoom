import type { QueryProfile } from "../types.js";
import { gmailQueryProfile } from "./gmail.js";
import { notionQueryProfile } from "./notion.js";
import { googleDriveQueryProfile } from "./google-drive.js";
import { googleCalendarQueryProfile } from "./google-calendar.js";
import { outlookQueryProfile } from "./outlook.js";
import { slackQueryProfile } from "./slack.js";

/**
 * 首批查询档案。新增 provider = 一个文件 + 这里一行；
 * 未注册的 provider 在 query 结果里进 skipped.no_profile。
 */
export const defaultQueryProfiles: readonly QueryProfile[] = [
  gmailQueryProfile,
  notionQueryProfile,
  googleDriveQueryProfile,
  googleCalendarQueryProfile,
  outlookQueryProfile,
  slackQueryProfile,
];

export function queryProfileOf(
  service: string,
  profiles: readonly QueryProfile[] = defaultQueryProfiles,
): QueryProfile | null {
  return profiles.find((profile) => profile.service === service) ?? null;
}

export function queryProfileServices(
  profiles: readonly QueryProfile[] = defaultQueryProfiles,
): string[] {
  return profiles.map((profile) => profile.service);
}
