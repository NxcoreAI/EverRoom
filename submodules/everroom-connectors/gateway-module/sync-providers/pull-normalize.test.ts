import { describe, expect, it } from "vitest";
import type { NormalizedCalendarChange, NormalizedMailChange } from "@nxcore/connector-contract";
import { gmailSyncProvider } from "./gmail.js";
import { outlookSyncProvider } from "./outlook.js";
import { googleCalendarSyncProvider } from "./google-calendar.js";
import type { PullContext, SyncPullContext } from "./types.js";

/**
 * 格式映射体系缝隙契约：mail/calendar OAuth provider 不再内置归一化，
 * pull 生成器把 provider 原始记录交给 ctx.normalize*（FormatMapperPort），
 * 并原样透传归一化结果。原始样本形状 = executor 逆适配后的 REST 形状。
 */

function fakeCtx(overrides: Partial<PullContext> = {}) {
  const responses = new Map<string, unknown>();
  const ctx: PullContext & Partial<SyncPullContext> = {
    connectionId: "conn-1",
    configKey: "default",
    proxyGet: async <T = any>(url: string): Promise<T> => {
      if (!responses.has(url)) throw new Error(`unexpected GET: ${url}`);
      return responses.get(url) as T;
    },
    proxyPost: async () => {
      throw new Error("unexpected POST");
    },
    normalizeMail: async (raw: unknown): Promise<NormalizedMailChange> => ({ kind: "upsert", message: { providerMessageId: String((raw as { id: string }).id), subject: "via-mapper" } }),
    normalizeCalendar: async (raw: unknown): Promise<NormalizedCalendarChange> => ({ kind: "upsert", event: { providerEventId: String((raw as { id: string }).id), title: "via-mapper", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z" } }),
    ...overrides,
  };
  return { ctx: ctx as SyncPullContext, responses };
}

const gmailMessage = {
  id: "g1",
  threadId: "t1",
  snippet: "snip",
  internalDate: "1725530000000",
  historyId: "42",
  labelIds: ["INBOX"],
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: "a@x.com" }], body: { data: "aGk=" } },
};

describe("gmail pull 经 ctx.normalizeMail 归一化", () => {
  it("全量：逐条消息调用映射并透传结果", async () => {
    const { ctx, responses } = fakeCtx();
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/profile", { historyId: "100" });
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=-in%3Aspam+-in%3Atrash", { messages: [{ id: "g1" }, { id: "g2" }] });
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/messages/g1?format=full", gmailMessage);
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/messages/g2?format=full", { ...gmailMessage, id: "g2" });
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=100", { history: [], historyId: "100" });
    const seen: unknown[] = [];
    const pages = [];
    for await (const page of gmailSyncProvider.pull!({ ...ctx, normalizeMail: async (raw) => { seen.push(raw); return { kind: "upsert", message: { providerMessageId: String((raw as { id: string }).id) } }; } } as SyncPullContext, "full")) {
      pages.push(page);
    }
    expect(seen).toEqual([gmailMessage, { ...gmailMessage, id: "g2" }]);
    expect(pages[0]!.changes.map((c) => (c.kind === "upsert" ? c.message.providerMessageId : "tombstone"))).toEqual(["g1", "g2"]);
  });

  it("增量：history 路由决定取哪些消息，删除提示直接产出墓碑", async () => {
    const { ctx, responses } = fakeCtx();
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=100", {
      history: [
        { messagesAdded: [{ message: { id: "g9" } }] },
        { messagesDeleted: [{ message: { id: "g0" } }] },
      ],
      historyId: "120",
    });
    responses.set("https://gmail.googleapis.com/gmail/v1/users/me/messages/g9?format=full", { ...gmailMessage, id: "g9" });
    const pages = [];
    for await (const page of gmailSyncProvider.pull!({ ...ctx, sourceCursor: "100" } as SyncPullContext, "incremental")) {
      pages.push(page);
    }
    expect(pages[0]!.changes).toEqual([
      { kind: "upsert", message: { providerMessageId: "g9", subject: "via-mapper" } },
      { kind: "tombstone", providerMessageId: "g0" },
    ]);
    expect(pages[0]!.terminalCursor).toBe("120");
  });
});

describe("outlook pull 经 ctx.normalizeMail 归一化", () => {
  it("把 Graph 信封里的每条消息交给映射并透传", async () => {
    const { ctx, responses } = fakeCtx();
    const url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";
    responses.set(url, { value: [{ id: "o1" }, { id: "o2" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next" });
    const seen: unknown[] = [];
    const pages = [];
    const outlookCtx = {
      ...ctx,
      providerScopeId: "inbox",
      normalizeMail: async (raw: unknown) => {
        seen.push(raw);
        return { kind: "upsert", message: { providerMessageId: String((raw as { id: string }).id) } } as NormalizedMailChange;
      },
    };
    for await (const page of outlookSyncProvider.pull!(outlookCtx as SyncPullContext, "full")) {
      pages.push(page);
    }
    expect(seen).toEqual([{ id: "o1" }, { id: "o2" }]);
    expect(pages[0]!.changes.map((c) => (c.kind === "upsert" ? c.message.providerMessageId : "tombstone"))).toEqual(["o1", "o2"]);
    expect(pages[0]!.terminalCursor).toContain("deltatoken=next");
  });
});

describe("google-calendar pull 经 ctx.normalizeCalendar 归一化", () => {
  it("把每个 event 交给映射（含 cancelled → 映射层产出墓碑的输入）", async () => {
    const { ctx, responses } = fakeCtx();
    const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&showDeleted=true&maxResults=2500&timeMin=1970-01-01T00:00:00Z";
    responses.set(url, { items: [{ id: "e1", status: "confirmed" }, { id: "e2", status: "cancelled" }], nextSyncToken: "st1" });
    const seen: unknown[] = [];
    const pages = [];
    const calCtx = {
      ...ctx,
      providerScopeId: "primary",
      normalizeCalendar: async (raw: unknown) => {
        seen.push(raw);
        const id = String((raw as { id: string }).id);
        if ((raw as { status?: string }).status === "cancelled") return { kind: "tombstone", providerEventId: id } as NormalizedCalendarChange;
        return { kind: "upsert", event: { providerEventId: id, title: "t", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z" } } as NormalizedCalendarChange;
      },
    };
    for await (const page of googleCalendarSyncProvider.pull!(calCtx as SyncPullContext, "full")) {
      pages.push(page);
    }
    expect(seen).toEqual([{ id: "e1", status: "confirmed" }, { id: "e2", status: "cancelled" }]);
    expect(pages[0]!.calendarChanges).toEqual([
      { kind: "upsert", event: { providerEventId: "e1", title: "t", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z" } },
      { kind: "tombstone", providerEventId: "e2" },
    ]);
    expect(pages[0]!.terminalCursor).toBe("st1");
  });
});
