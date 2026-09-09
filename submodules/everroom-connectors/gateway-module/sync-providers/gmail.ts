import type { NormalizedMailChange } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

/** Gmail history → 待取消息 id 路由（结构路由，非字段映射——留在 provider 代码）。 */
export function gmailHistoryChanges(raw: any): Array<{ id: string; removed: boolean }> {
  const map = new Map<string, boolean>();
  for (const h of raw.history ?? []) {
    for (const x of h.messagesAdded ?? []) map.set(String(x.message.id), false);
    for (const x of h.labelsAdded ?? []) map.set(String(x.message.id), false);
    for (const x of h.labelsRemoved ?? []) map.set(String(x.message.id), false);
    for (const x of h.messagesDeleted ?? []) map.set(String(x.message.id), true);
  }
  return [...map].map(([id, removed]) => ({ id, removed }));
}

/** 全量断点续传游标：`resume:` 前缀 + JSON。manager 视为不透明串存取，仅本 provider 解析。 */
export interface GmailResumeCursor {
  phase: "list" | "history";
  /** 全量起始时锚定的 profile.historyId（history 尾扫窗口基准，续跑必须复用原值）。 */
  anchor: string;
  /** 下一页 pageToken（history 阶段可缺省=从头扫）。 */
  pageToken?: string;
}

export function encodeGmailResume(cursor: GmailResumeCursor): string {
  return `resume:${JSON.stringify(cursor)}`;
}

export function parseGmailResume(raw: string | null | undefined): GmailResumeCursor | null {
  if (!raw?.startsWith("resume:")) return null;
  try {
    const parsed = JSON.parse(raw.slice("resume:".length)) as GmailResumeCursor;
    if ((parsed.phase !== "list" && parsed.phase !== "history") || typeof parsed.anchor !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 配额节奏：Gmail 每用户配额是 250 units/秒（messages.get=5 units），串行逐封
 * 请求被网络往返自然压在个位数封/秒，远低于配额；quota 403 由 HttpClient
 * 滚动退避兜底，因此默认不限速。
 */
export const gmailPace: { minIntervalMs: number } = { minIntervalMs: 0 };

function createPacer() {
  let lastAt = 0;
  return async () => {
    const wait = gmailPace.minIntervalMs - (Date.now() - lastAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
  };
}

/** Gmail：游标 = historyId；全量先锚定 profile.historyId 再扫列表，最后补扫锚点后的增量。
 * 失败可从 run 落下的 resume 游标续跑（list 断点续拉、history 直入尾扫），避免整轮重头烧配额。 */
export const gmailSyncProvider: SyncProviderDefinition = {
  provider: "gmail",
  engine: "nango",
  dataTypes: ["mail"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_GMAIL_CONFIG_KEY", "NXCORE_NANGO_GMAIL_CONFIG_KEY"],
      configKeyDefault: "google-mail",
      integrationProvider: "google-mail",
      credential: "google",
      oauthScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
    },
  },
  defaultScopes: [{ providerScopeId: "me", displayName: "Mailbox" }],
  ui: { label: "Gmail", category: "mail", iconKey: "gmail" },
  async *pull(ctx, mode) {
    const pace = createPacer();
    if (mode === "incremental" && ctx.sourceCursor) {
      yield* gmailHistory(ctx, ctx.sourceCursor, undefined, pace);
      return;
    }
    // full / rebuild：rebuild 不续传（410 重建语义 = 推倒重来）。
    const resume = mode === "rebuild" ? null : parseGmailResume(ctx.continuation);
    const anchor = resume?.anchor
      ?? String((await ctx.proxyGet("https://gmail.googleapis.com/gmail/v1/users/me/profile")).historyId);
    if (resume?.phase === "history") {
      yield* gmailHistory(ctx, anchor, resume.pageToken, pace);
      return;
    }
    let token: string | undefined = resume?.pageToken;
    do {
      const query = new URLSearchParams({ maxResults: "100", q: "-in:spam -in:trash" });
      if (token) query.set("pageToken", token);
      const list = await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`);
      const changes: NormalizedMailChange[] = [];
      for (const item of list.messages ?? []) {
        await pace();
        changes.push(
          await ctx.normalizeMail(
            await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`),
          ),
        );
      }
      token = list.nextPageToken;
      yield {
        changes,
        ...(token ? { continuation: encodeGmailResume({ phase: "list", anchor, pageToken: token }) } : {}),
      };
    } while (token);
    // 列表拉尽 → history 尾扫前先落检查点页：此处崩溃可直入尾扫，不重跑整轮列表。
    yield { changes: [], continuation: encodeGmailResume({ phase: "history", anchor }) };
    yield* gmailHistory(ctx, anchor, undefined, pace);
  },
};

async function* gmailHistory(
  ctx: { proxyGet(url: string): Promise<any>; normalizeMail(raw: unknown): Promise<NormalizedMailChange> },
  startHistoryId: string,
  resumePageToken: string | undefined,
  pace: () => Promise<void>,
) {
  let token: string | undefined = resumePageToken;
  do {
    const query = new URLSearchParams({ startHistoryId });
    if (token) query.set("pageToken", token);
    const data = await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`);
    const changes: NormalizedMailChange[] = [];
    for (const hint of gmailHistoryChanges(data)) {
      if (hint.removed) changes.push({ kind: "tombstone", providerMessageId: hint.id });
      else {
        await pace();
        changes.push(
          await ctx.normalizeMail(
            await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${hint.id}?format=full`),
          ),
        );
      }
    }
    token = data.nextPageToken;
    yield {
      changes,
      ...(token
        ? { continuation: encodeGmailResume({ phase: "history", anchor: startHistoryId, pageToken: token }) }
        : { terminalCursor: String(data.historyId ?? startHistoryId) }),
    };
  } while (token);
}
