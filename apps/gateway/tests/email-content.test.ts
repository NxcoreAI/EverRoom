import { describe, expect, it } from "vitest";
import {
  convertEmailBody,
  convertRawEmailToMarkdown,
  EMAIL_CONTENT_LIMITS,
} from "../src/modules/ingest/email-content.js";

describe("email content conversion", () => {
  it("removes CSS, scripts, tracking pixels, Gmail quotes, and signatures while preserving GFM", () => {
    const result = convertEmailBody({
      text: "A lossy plain-text alternative",
      html: `
        <head><style>.notice { color: red }</style><script>steal()</script></head>
        <p>Hello <strong>team</strong>, see
          <a href="https://example.com/plan?utm_source=newsletter&amp;keep=yes">the plan</a>.
        </p>
        <ul><li>Review</li><li>Approve</li></ul>
        <table><tr><th>Owner</th><th>Status</th></tr><tr><td>Lin</td><td>Ready</td></tr></table>
        <img src="https://tracker.example/pixel.gif" width="1" height="1" alt="tracker">
        <div data-smartmail="gmail_signature">Private signature</div>
        <div class="gmail_quote">Old quoted message</div>
      `,
    });

    expect(result).toMatchObject({ source: "html", notes: [] });
    expect(result.markdown).toContain("Hello **team**");
    expect(result.markdown).toContain("- Review\n- Approve");
    expect(result.markdown).toContain("| Owner | Status |");
    expect(result.markdown).toContain("https://example.com/plan?keep=yes");
    expect(result.markdown).not.toMatch(/notice|color: red|steal|tracker|signature|quoted message|utm_source/i);
  });

  it("cuts Outlook, Apple Mail, Thunderbird, Yahoo, and Proton reply containers", () => {
    const samples = [
      '<p>Current Outlook reply</p><div id="divRplyFwdMsg">From: old@example.com Sent: yesterday To: me@example.com</div><p>Old body</p>',
      '<p>Current Apple reply</p><blockquote type="cite"><p>Old body</p></blockquote><p>Older body</p>',
      '<p>Current Thunderbird reply</p><div class="moz-cite-prefix">On yesterday, A wrote:</div><blockquote>Old body</blockquote>',
      '<p>Current Yahoo reply</p><div class="yahoo_quoted">Old body</div>',
      '<p>Current Proton reply</p><div class="protonmail_quote">Old body</div>',
    ];

    for (const html of samples) {
      const result = convertEmailBody({ html });
      expect(result.markdown).toContain("Current");
      expect(result.markdown).not.toMatch(/Old body|Older body|old@example/i);
    }
  });

  it("extracts the visible Chinese plain-text reply and removes the signature", () => {
    const result = convertEmailBody({
      text: `收到，我今天处理。\n\n谢谢\n王明\n\n在 2026年8月19日，李四写道：\n> 原邮件第一行\n> 原邮件第二行`,
    });

    expect(result.source).toBe("plain");
    expect(result.notes).toContain("reply_parser");
    expect(result.markdown).toBe("收到，我今天处理。\n\n谢谢\n王明");
  });

  it("removes CSS rules leaked into a plain-text alternative", () => {
    const result = convertEmailBody({
      text: "Visible intro #outlook a { padding:0; } body { margin:0; color:red; } Actual message",
    });

    expect(result.markdown).toContain("Visible intro");
    expect(result.markdown).toContain("Actual message");
    expect(result.markdown).not.toMatch(/#outlook|padding:0|margin:0|color:red/);
  });

  it("bounds pathological plain text without invoking the reply parser", () => {
    const text = `Keep this content\n${"x".repeat(EMAIL_CONTENT_LIMITS.plainReplyParserBytes + 1)}`;
    const result = convertEmailBody({ text });

    expect(result.notes).toContain("reply_parser_skipped_size");
    expect(result.markdown).toContain("Keep this content");
  });

  it("uses the bounded fallback for oversized HTML", () => {
    const html = `<style>.noise { display: none }</style><p>Visible</p><div>${"x".repeat(EMAIL_CONTENT_LIMITS.htmlAstBytes)}</div>`;
    const result = convertEmailBody({ html });

    expect(result.source).toBe("fallback");
    expect(result.notes).toContain("html_ast_skipped_size");
    expect(result.markdown).toContain("Visible");
    expect(result.markdown).not.toContain("display: none");
  });

  it("parses raw MIME and runs the selected body through the same cleaner", async () => {
    const result = await convertRawEmailToMarkdown([
      "From: Sender <sender@example.com>",
      "To: Receiver <receiver@example.com>",
      "Subject: Test",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<style>.noise{color:red}</style><p>Hello <b>Receiver</b></p>",
    ].join("\r\n"));

    expect(result.source).toBe("raw-mime");
    expect(result.notes).toEqual(expect.arrayContaining(["mime_parsed", "mime_body_html"]));
    expect(result.markdown).toBe("Hello **Receiver**");
  });
});
