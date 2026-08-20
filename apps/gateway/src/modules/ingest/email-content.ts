import EmailReplyParser from "email-reply-parser";
import { htmlToText } from "html-to-text";
import type { Element, Parent, Root, RootContent } from "hast";
import { simpleParser } from "mailparser";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

export interface EmailBodyInput {
  text?: string | null | undefined;
  html?: string | null | undefined;
}

export interface EmailBodyConversion {
  markdown: string;
  source: "plain" | "html" | "raw-mime" | "fallback";
  notes: string[];
}

export const EMAIL_CONTENT_LIMITS = {
  htmlAstBytes: 512 * 1024,
  htmlFallbackCharacters: 1024 * 1024,
  plainReplyParserBytes: 256 * 1024,
  rawMimeBytes: 16 * 1024 * 1024,
  outputCharacters: 1024 * 1024,
} as const;

const HARD_DROP_TAGS = new Set([
  "applet", "audio", "button", "canvas", "embed", "form", "head", "iframe", "input",
  "link", "meta", "noscript", "object", "script", "style", "svg", "template", "video",
]);

const DROP_CONTAINER = /(?:^|[\s_-])(?:gmail[-_]signature|moz[-_]signature|protonmail[-_]signature|yahoo[-_]signature|email[-_]signature|mailsignature)(?:$|[\s_-])/i;
const THREAD_CONTAINER = /(?:^|[\s_-])(?:gmail[-_]quote|gmail[-_]extra|yahoo[-_]quoted|protonmail[-_]quote|moz[-_]cite[-_]prefix|outlookmessageheader|replyforwardmessage|quoted[-_]reply|quoted[-_]text)(?:$|[\s_-])/i;
const TRACKING_PARAMETERS = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|mkt_tok|vero_conv|vero_id|oly_anon_id|oly_enc_id|_hsenc|_hsmi)$/i;
const REPLY_BOUNDARY = /^(?:on\s.{1,500}\swrote:|le\s.{1,500}\sa [eé]crit\s?:|am\s.{1,500}\sschrieb\s.{0,20}:|el\s.{1,500}\sescribi[oó]\s?:|em\s.{1,500}\sescreveu\s?:|il\s.{1,500}\sha scritto:|在\s*.{1,500}\s*(?:写道|说道)[：:]|.{1,500}\s*于\s*.{1,200}\s*(?:写道|说道)[：:]|[-_]{2,}\s*(?:original message|forwarded message|原始邮件|转发的邮件)\s*[-_]{2,})$/isu;
const OUTLOOK_HEADER = /^(?:from|发件人)[：:].{0,1000}(?:sent|发送时间|日期)[：:].{0,1000}(?:to|收件人)[：:]/isu;
const SIGNATURE_LINE = /^(?:--\s*|sent from my .+|从我的.+发送|best(?: wishes| regards)?[,!]?|kind regards[,!]?|regards[,!]?|此致\s*[敬敬]?礼?)$/iu;
const CSS_RULE_START = /(?:@media[^{}]{0,180}|(?:[#.*][\w-][^{}]{0,180}|(?:body|html|table|td|th|p|a|img|sup|sub)(?:[\s,.\[#:+>~][^{}]{0,180})?))\s*\{(?=\s*(?:--[\w-]+|[-a-z][\w-]*)\s*:)/iu;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function propertyText(element: Element, key: string): string {
  const value = element.properties[key];
  return Array.isArray(value) ? value.join(" ") : typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function elementIdentity(element: Element): string {
  return `${propertyText(element, "id")} ${propertyText(element, "className")}`.trim();
}

function nodeText(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (!("children" in node)) return "";
  return node.children.map((child) => nodeText(child as RootContent)).join(" ").replace(/\s+/g, " ").trim();
}

function numericDimension(element: Element, key: "width" | "height"): number | null {
  const property = propertyText(element, key);
  const direct = Number(property.replace(/px$/i, ""));
  if (property && Number.isFinite(direct) && direct >= 0) return direct;
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i")
    .exec(propertyText(element, "style"));
  return match ? Number(match[1]) : null;
}

function isHidden(element: Element): boolean {
  if (element.properties.hidden === true || propertyText(element, "ariaHidden").toLowerCase() === "true") return true;
  const style = propertyText(element, "style");
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?)\s*(?:!important\s*)?(?:;|$)/i.test(style);
}

function isTrackingImage(element: Element): boolean {
  if (element.tagName !== "img") return false;
  const width = numericDimension(element, "width");
  const height = numericDimension(element, "height");
  return (width !== null && width <= 1) || (height !== null && height <= 1);
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "www.google.com" && url.pathname === "/url" && url.searchParams.get("q")) {
      return normalizedUrl(url.searchParams.get("q")!);
    }
    if (host.endsWith("safelinks.protection.outlook.com") && url.searchParams.get("url")) {
      return normalizedUrl(url.searchParams.get("url")!);
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeElement(element: Element): void {
  const href = propertyText(element, "href");
  if (href) element.properties.href = normalizedUrl(href);
  const src = propertyText(element, "src");
  if (src) element.properties.src = normalizedUrl(src);
  delete element.properties.style;
  delete element.properties.className;
  delete element.properties.id;
}

function isLayoutTable(element: Element): boolean {
  if (element.tagName !== "table") return false;
  if (propertyText(element, "role").toLowerCase() === "presentation") return true;
  const rows: Element[] = [];
  const visit = (node: RootContent): void => {
    if (node.type === "element" && node.tagName === "tr") rows.push(node);
    if ("children" in node) node.children.forEach((child) => visit(child as RootContent));
  };
  element.children.forEach((child) => visit(child as RootContent));
  const hasHeader = rows.some((row) => row.children.some((child) => child.type === "element" && child.tagName === "th"));
  const multiColumnRows = rows.filter((row) => row.children.filter((child) =>
    child.type === "element" && (child.tagName === "td" || child.tagName === "th")).length >= 2);
  return !hasHeader && (rows.length < 2 || multiColumnRows.length < 2);
}

function shouldStopAt(element: Element): boolean {
  const identity = elementIdentity(element);
  if (THREAD_CONTAINER.test(identity) || /^divrplyfwdmsg$/i.test(propertyText(element, "id"))) return true;
  if (element.tagName === "blockquote" && propertyText(element, "type").toLowerCase() === "cite") return true;
  const text = nodeText(element);
  return text.length <= 2500 && (REPLY_BOUNDARY.test(text) || OUTLOOK_HEADER.test(text));
}

function cleanParent(parent: Parent): void {
  const cleaned: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    if (child.type !== "element") {
      cleaned.push(child);
      continue;
    }
    if (shouldStopAt(child)) break;
    const identity = elementIdentity(child);
    if (HARD_DROP_TAGS.has(child.tagName)
      || DROP_CONTAINER.test(identity)
      || propertyText(child, "dataSmartmail").toLowerCase() === "gmail_signature"
      || isHidden(child)
      || isTrackingImage(child)) {
      continue;
    }
    cleanParent(child);
    if (isLayoutTable(child)) {
      cleaned.push(...child.children as RootContent[]);
      continue;
    }
    normalizeElement(child);
    cleaned.push(child);
  }
  parent.children = cleaned;
}

function cleanEmailHtml() {
  return (tree: Root): void => cleanParent(tree);
}

const htmlProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(cleanEmailHtml)
  .use(rehypeSanitize, defaultSchema)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    fences: true,
    rule: "-",
  });

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundOutput(value: string, notes: string[]): string {
  if (value.length <= EMAIL_CONTENT_LIMITS.outputCharacters) return value;
  notes.push("output_truncated");
  return `${value.slice(0, EMAIL_CONTENT_LIMITS.outputCharacters).trimEnd()}\n\n[正文因长度限制已截断]`;
}

function normalizeLongLines(value: string): string {
  const maximum = 8 * 1024;
  return value.split("\n").flatMap((line) => {
    if (line.length <= maximum) return [line];
    const chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += maximum) chunks.push(line.slice(offset, offset + maximum));
    return chunks;
  }).join("\n");
}

function stripPlainCssBlocks(value: string): string {
  let result = value;
  for (let removed = 0; removed < 10_000; removed += 1) {
    const match = CSS_RULE_START.exec(result);
    if (!match || match.index === undefined) break;
    const openingBrace = result.indexOf("{", match.index);
    let depth = 0;
    let closingBrace = -1;
    for (let index = openingBrace; index < result.length; index += 1) {
      if (result[index] === "{") depth += 1;
      else if (result[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          closingBrace = index;
          break;
        }
      }
    }
    if (closingBrace < 0) break;
    result = `${result.slice(0, match.index)} ${result.slice(closingBrace + 1)}`;
  }
  return result.replace(/@media[^{}\n]{0,200}\{\s*\}/giu, " ");
}

function deterministicReplyCleanup(value: string): string {
  const lines = value.split("\n");
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (REPLY_BOUNDARY.test(line) || OUTLOOK_HEADER.test(lines.slice(index, index + 8).join(" "))) {
      end = index;
      break;
    }
    const followingQuoteLines = lines.slice(index, Math.min(index + 5, lines.length))
      .filter((item) => /^\s*>/.test(item)).length;
    if (followingQuoteLines >= 2 && index > 0) {
      end = index;
      break;
    }
    if (SIGNATURE_LINE.test(line) && index > 0 && lines.length - index <= 20) {
      end = index;
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

function convertPlain(text: string, notes: string[], source: EmailBodyConversion["source"] = "plain"): EmailBodyConversion {
  const normalized = normalizeLongLines(stripPlainCssBlocks(
    text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\u0000/g, ""),
  ));
  let visible: string;
  if (byteLength(normalized) <= EMAIL_CONTENT_LIMITS.plainReplyParserBytes) {
    try {
      visible = new EmailReplyParser().parseReply(normalized);
      notes.push("reply_parser");
    } catch {
      visible = deterministicReplyCleanup(normalized);
      notes.push("reply_parser_failed");
    }
  } else {
    visible = deterministicReplyCleanup(normalized);
    notes.push("reply_parser_skipped_size");
  }
  return { markdown: boundOutput(normalizeMarkdown(visible), notes), source, notes };
}

function htmlFallback(html: string, notes: string[]): EmailBodyConversion {
  const text = htmlToText(html, {
    wordwrap: false,
    limits: {
      maxInputLength: EMAIL_CONTENT_LIMITS.htmlFallbackCharacters,
      maxChildNodes: 10_000,
      maxDepth: 40,
    },
    selectors: [
      { selector: "head", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "svg", format: "skip" },
      { selector: "form", format: "skip" },
      { selector: ".gmail_quote", format: "skip" },
      { selector: ".gmail_signature", format: "skip" },
      { selector: ".yahoo_quoted", format: "skip" },
      { selector: ".protonmail_quote", format: "skip" },
      { selector: ".moz-signature", format: "skip" },
      { selector: "blockquote[type=cite]", format: "skip" },
    ],
  });
  return convertPlain(text, notes, "fallback");
}

function looksLikeHtml(value: string): boolean {
  return /<(?:!doctype|html|head|body|div|p|table|style|script|br|blockquote)\b/i.test(value);
}

export function convertEmailBody(input: EmailBodyInput): EmailBodyConversion {
  const notes: string[] = [];
  const html = input.html?.trim() || (input.text && looksLikeHtml(input.text) ? input.text.trim() : "");
  const text = input.text?.trim() && !looksLikeHtml(input.text) ? input.text : "";
  if (html) {
    if (byteLength(html) > EMAIL_CONTENT_LIMITS.htmlAstBytes) {
      notes.push("html_ast_skipped_size");
      return htmlFallback(html, notes);
    }
    try {
      const markdown = normalizeMarkdown(String(htmlProcessor.processSync(html)));
      if (markdown) return { markdown: boundOutput(markdown, notes), source: "html", notes };
      notes.push("html_empty_after_cleaning");
    } catch {
      notes.push("html_conversion_failed");
      return htmlFallback(html, notes);
    }
  }
  if (text) return convertPlain(text, notes);
  return { markdown: "", source: html ? "html" : "plain", notes };
}

export async function convertRawEmailToMarkdown(source: Buffer | string): Promise<EmailBodyConversion> {
  const sourceBytes = typeof source === "string" ? byteLength(source) : source.length;
  if (sourceBytes > EMAIL_CONTENT_LIMITS.rawMimeBytes) {
    throw new Error(`Raw email exceeds ${EMAIL_CONTENT_LIMITS.rawMimeBytes} bytes`);
  }
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    maxHtmlLengthToParse: EMAIL_CONTENT_LIMITS.htmlFallbackCharacters,
  });
  const converted = convertEmailBody({
    text: parsed.text,
    html: typeof parsed.html === "string" ? parsed.html : null,
  });
  return {
    ...converted,
    source: "raw-mime",
    notes: ["mime_parsed", `mime_body_${converted.source}`, ...converted.notes],
  };
}
