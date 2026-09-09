import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeGmailResume,
  gmailPace,
  gmailSyncProvider,
  parseGmailResume,
} from "@nxcore/connectors-module/sync-providers/gmail.js";

const dirs: string[] = [];
afterEach(async () => {
  dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }));
  gmailPace.minIntervalMs = 1400;
});

type Route = (url: URL) => unknown | undefined;

/** 脚本化 proxyGet：按路由顺序命中，未命中即抛错（暴露意外调用）。 */
function createCtx(routes: Route[], overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const ctx = {
    connectionId: "conn-1",
    configKey: "google-mail",
    providerScopeId: "me",
    sourceCursor: null as string | null,
    continuation: null as string | null,
    proxyPost: async () => ({}),
    normalizeCalendar: async () => ({ kind: "upsert", event: {} }),
    normalizeMail: async (raw: any) => ({ kind: "upsert", message: { providerMessageId: raw.id } }),
    async proxyGet(url: string) {
      calls.push(url);
      const parsed = new URL(url);
      for (const route of routes) {
        const out = route(parsed);
        if (out !== undefined) return out;
      }
      throw new Error(`unexpected_proxy_get: ${url}`);
    },
    ...overrides,
  };
  return { ctx: ctx as any, calls };
}

const callCount = (calls: string[], match: string) => calls.filter((c) => c.includes(match)).length;

describe("gmail resume cursor 编解码", () => {
  it("round-trips list and history phases and rejects garbage", () => {
    const list = encodeGmailResume({ phase: "list", anchor: "9001", pageToken: "t2" });
    expect(parseGmailResume(list)).toEqual({ phase: "list", anchor: "9001", pageToken: "t2" });
    const history = encodeGmailResume({ phase: "history", anchor: "9001", pageToken: "h2" });
    expect(parseGmailResume(history)).toEqual({ phase: "history", anchor: "9001", pageToken: "h2" });
    expect(parseGmailResume("raw-page-token")).toBeNull();
    expect(parseGmailResume("resume:not-json")).toBeNull();
    expect(parseGmailResume('resume:{"phase":"weird","anchor":"1"}')).toBeNull();
    expect(parseGmailResume(null)).toBeNull();
  });
});

describe("gmailSyncProvider 全量断点续传", () => {
  it("paginates full sync with resume cursors and a checkpoint page before history sweep", async () => {
    const listPages = [
      { messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "t2" },
      { messages: [{ id: "m3" }] },
    ];
    const historyPages = [
      { history: [{ messagesAdded: [{ message: { id: "m4" } }] }], historyId: "9050", nextPageToken: "h2" },
      { history: [{ messagesDeleted: [{ message: { id: "m9" } }] }], historyId: "9050" },
    ];
    let listCall = 0;
    let historyCall = 0;
    const { ctx, calls } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") return { historyId: "9001" };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") {
          const page = listPages[listCall++];
          if (!page) throw new Error("too many list calls");
          return page;
        }
      },
      (url) => {
        const m = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(url.pathname);
        if (m) return { id: decodeURIComponent(m[1]!), snippet: `body of ${m[1]}` };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") {
          const page = historyPages[historyCall++];
          if (!page) throw new Error("too many history calls");
          return page;
        }
      },
    ]);
    const pages: any[] = [];
    for await (const page of gmailSyncProvider.pull!(ctx, "full")) pages.push(page);

    expect(pages).toHaveLength(5);
    // 第 1 页带 list-phase 断点；页内逐封全文已取。
    expect(pages[0]!.changes.map((c: any) => c.message.providerMessageId)).toEqual(["m1", "m2"]);
    expect(parseGmailResume(pages[0]!.continuation)).toEqual({ phase: "list", anchor: "9001", pageToken: "t2" });
    // 第 2 页（末页）无断点。
    expect(pages[1]!.changes.map((c: any) => c.message.providerMessageId)).toEqual(["m3"]);
    expect(pages[1]!.continuation).toBeUndefined();
    // 列表拉尽 → history 尾扫前落检查点空页。
    expect(pages[2]).toEqual({ changes: [], continuation: encodeGmailResume({ phase: "history", anchor: "9001" }) });
    // 尾扫：第 1 页 upsert、第 2 页 tombstone + terminalCursor。
    expect(pages[3]!.changes.map((c: any) => c.message.providerMessageId)).toEqual(["m4"]);
    expect(parseGmailResume(pages[3]!.continuation)).toEqual({ phase: "history", anchor: "9001", pageToken: "h2" });
    expect(pages[4]!.changes[0]).toMatchObject({ kind: "tombstone", providerMessageId: "m9" });
    expect(pages[4]!.terminalCursor).toBe("9050");
    expect(pages[4]!.continuation).toBeUndefined();

    // 锚定只发生一次；翻页 token 正确接续。
    expect(callCount(calls, "/profile")).toBe(1);
    const listUrls = calls.filter((c) => /\/messages\?/.test(c));
    expect(listUrls[0]).not.toContain("pageToken");
    expect(listUrls[1]).toContain("pageToken=t2");
    const historyUrls = calls.filter((c) => c.includes("/history?"));
    expect(historyUrls[0]).toContain("startHistoryId=9001");
    expect(historyUrls[1]).toContain("startHistoryId=9001");
    expect(historyUrls[1]).toContain("pageToken=h2");
  });

  it("resumes from a list-phase cursor without re-anchoring the profile", async () => {
    const { ctx, calls } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") throw new Error("profile must not be fetched on resume");
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") {
          if (!url.searchParams.get("pageToken")) throw new Error("resume must start at the saved pageToken");
          return { messages: [{ id: "m3" }] };
        }
      },
      (url) => {
        const m = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(url.pathname);
        if (m) return { id: decodeURIComponent(m[1]!) };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") {
          return { history: [], historyId: "9050" };
        }
      },
    ]);
    ctx.continuation = encodeGmailResume({ phase: "list", anchor: "7777", pageToken: "t2" });
    const pages: any[] = [];
    for await (const page of gmailSyncProvider.pull!(ctx, "full")) pages.push(page);

    expect(callCount(calls, "/profile")).toBe(0);
    expect(pages[0]!.changes.map((c: any) => c.message.providerMessageId)).toEqual(["m3"]);
    // 续跑必须沿用原 anchor（history 尾扫窗口基准），不能重新锚定。
    expect(parseGmailResume(pages.find((p) => p.changes.length === 0)?.continuation))
      .toEqual({ phase: "history", anchor: "7777" });
    expect(callCount(calls, "/history?")).toBe(1);
    expect(calls.find((c) => c.includes("/history?"))).toContain("startHistoryId=7777");
    expect(pages.at(-1)!.terminalCursor).toBe("9050");
  });

  it("resumes from a history-phase cursor straight into the tail sweep", async () => {
    const { ctx, calls } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") throw new Error("profile must not be fetched on resume");
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") throw new Error("list must not be refetched on history resume");
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") {
          return { history: [{ labelsAdded: [{ message: { id: "m5" } }] }], historyId: "9050" };
        }
      },
      (url) => {
        const m = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(url.pathname);
        if (m) return { id: decodeURIComponent(m[1]!) };
      },
    ]);
    ctx.continuation = encodeGmailResume({ phase: "history", anchor: "8888", pageToken: "h9" });
    const pages: any[] = [];
    for await (const page of gmailSyncProvider.pull!(ctx, "full")) pages.push(page);

    expect(callCount(calls, "/profile")).toBe(0);
    expect(callCount(calls, "/messages?")).toBe(0);
    expect(calls.find((c) => c.includes("/history?"))).toContain("startHistoryId=8888");
    expect(calls.find((c) => c.includes("/history?"))).toContain("pageToken=h9");
    expect(pages.at(-1)!.terminalCursor).toBe("9050");
  });

  it("ignores resume cursors in rebuild mode and re-anchors the profile", async () => {
    const { ctx, calls } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") return { historyId: "9001" };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [] };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") return { history: [], historyId: "9001" };
      },
    ]);
    ctx.continuation = encodeGmailResume({ phase: "list", anchor: "7777", pageToken: "t2" });
    for await (const _page of gmailSyncProvider.pull!(ctx, "rebuild")) void _page;
    expect(callCount(calls, "/profile")).toBe(1);
  });

  it("incremental mode goes straight to history sweep from the source cursor", async () => {
    const { ctx, calls } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") throw new Error("incremental must not fetch profile");
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") throw new Error("incremental must not list messages");
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") {
          return { history: [], historyId: "9060" };
        }
      },
    ]);
    ctx.sourceCursor = "5000";
    const pages: any[] = [];
    for await (const page of gmailSyncProvider.pull!(ctx, "incremental")) pages.push(page);
    expect(callCount(calls, "/profile")).toBe(0);
    expect(callCount(calls, "/messages?")).toBe(0);
    expect(calls.find((c) => c.includes("/history?"))).toContain("startHistoryId=5000");
    expect(pages).toEqual([{ changes: [], terminalCursor: "9060" }]);
  });

  it("paces per-message proxy gets by gmailPace.minIntervalMs", async () => {
    const { ctx } = createCtx([
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/profile") return { historyId: "9001" };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/messages") return { messages: [{ id: "m1" }, { id: "m2" }] };
      },
      (url) => {
        const m = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(url.pathname);
        if (m) return { id: decodeURIComponent(m[1]!) };
      },
      (url) => {
        if (url.pathname === "/gmail/v1/users/me/history") return { history: [], historyId: "9001" };
      },
    ]);
    gmailPace.minIntervalMs = 25;
    const startedAt = Date.now();
    for await (const _page of gmailSyncProvider.pull!(ctx, "full")) void _page;
    const elapsed = Date.now() - startedAt;
    // 2 封消息 → 第 2 次 get 须等待一个间隔（首封无等待）。
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });
});
