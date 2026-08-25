const EXTRACTOR_VERSION = 'readability-0.6.0+everroom-2';
const MAX_ASSETS = 20;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

if (location.origin === 'http://127.0.0.1:47831' && location.pathname === '/v1/browser/pair/connect') {
  chrome.runtime.sendMessage({ type: 'everroom:connect' }, (result) => {
    const updateStatus = () => {
      const status = document.querySelector('#everroom-pairing-status');
      if (!status) return;
      const chinese = document.documentElement.lang.toLowerCase().startsWith('zh');
      status.textContent = result?.status === 'paired'
        ? chinese ? '已连接，可以关闭此页面并返回 EverRoom。' : 'Connected. You can close this page and return to EverRoom.'
        : chinese ? '连接失败，请确认 EverRoom 应用正在运行。' : 'Connection failed. Make sure EverRoom is running.';
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateStatus, { once: true });
    else updateStatus();
  });
}

function preferredImageUrl(node) {
  const candidates = [node.getAttribute('data-src'), node.getAttribute('data-lazy-src'), node.getAttribute('data-original'), node.currentSrc, node.getAttribute('src')];
  const srcset = node.getAttribute('srcset') || node.getAttribute('data-srcset');
  if (srcset) candidates.unshift(srcset.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop());
  for (const value of candidates) {
    if (!value || /^(data|blob|javascript|vbscript):/i.test(value.trim())) continue;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {}
  }
  return null;
}

function cleanRoot(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,iframe,form,canvas,template,svg').forEach((node) => node.remove());
  clone.querySelectorAll('img').forEach((node) => {
    const source = preferredImageUrl(node);
    if (source) node.setAttribute('src', source);
    else node.removeAttribute('src');
  });
  clone.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name === 'style' || attribute.name === 'srcset' || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
    });
    for (const name of ['href', 'src']) {
      const value = node.getAttribute(name);
      if (value && /^(javascript|vbscript|data):/i.test(value.trim())) node.removeAttribute(name);
      else if (value) {
        try { node.setAttribute(name, new URL(value, location.href).href); } catch { node.removeAttribute(name); }
      }
    }
  });
  return clone;
}

function inlineText(node) { return (node.textContent || '').replace(/\s+/g, ' ').trim(); }
function escapeInline(value) { return value.replace(/([\\`*_[\]<>])/g, '\\$1'); }

function tableMarkdown(table) {
  const rows = [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll(':scope > th, :scope > td')]
    .map((cell) => inlineText(cell).replace(/\|/g, '\\|'))).filter((row) => row.length > 0);
  if (rows.length === 0) return '';
  const columns = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(columns - row.length).fill('')]);
  const header = normalized[0];
  return `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |${normalized.slice(1).map((row) => `\n| ${row.join(' | ')} |`).join('')}`;
}

function stableAssetReference(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const hex = (number) => (number >>> 0).toString(16).padStart(8, '0');
  return `ref-${hex(first)}${hex(second)}`;
}

function toMarkdown(root, captureId) {
  const assets = [];
  const assetByUrl = new Map();
  const registerAsset = (node) => {
    const source = preferredImageUrl(node);
    if (!source || assets.length >= MAX_ASSETS) return null;
    const width = Number(node.getAttribute('width') || node.naturalWidth || 0);
    const height = Number(node.getAttribute('height') || node.naturalHeight || 0);
    if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return null;
    const known = assetByUrl.get(source);
    if (known) return known;
    const asset = {
      id: `asset-${captureId}-${assets.length + 1}`,
      referenceKey: stableAssetReference(source),
      originalUrl: source,
      altText: (node.getAttribute('alt') || '').trim().slice(0, 1000),
      ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width) } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height: Math.round(height) } : {}),
    };
    assets.push(asset);
    assetByUrl.set(source, asset);
    return asset;
  };
  const render = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const children = [...node.childNodes].map((child) => render(child, depth)).join('');
    if (/^(script|style|noscript|iframe|form|canvas|template|svg)$/.test(tag)) return '';
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${escapeInline(inlineText(node))}\n\n`;
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'figure') return `\n\n${children.trim()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${children.trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${children.trim()}*`;
    if (tag === 'del' || tag === 's') return `~~${children.trim()}~~`;
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${inlineText(node).replace(/`/g, '\\`')}\``;
    if (tag === 'pre') {
      const language = node.querySelector('code')?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] || '';
      return `\n\n\`\`\`${language}\n${node.textContent.trim()}\n\`\`\`\n\n`;
    }
    if (tag === 'blockquote') return `\n\n${children.trim().split('\n').filter(Boolean).map((line) => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'a') { const href = node.getAttribute('href'); return href ? `[${inlineText(node) || href}](${href})` : children; }
    if (tag === 'img') {
      const asset = registerAsset(node);
      return asset ? `![${asset.altText.replace(/[\]]/g, '\\]')}](nxcore-clipper-asset://local/${asset.referenceKey})` : '';
    }
    if (tag === 'li') return `\n${'  '.repeat(Math.max(0, depth - 1))}- ${children.trim()}`;
    if (tag === 'ul') return `\n\n${[...node.children].map((child) => render(child, depth + 1)).join('')}\n\n`;
    if (tag === 'ol') return `\n\n${[...node.children].map((child, index) => `\n${'  '.repeat(Math.max(0, depth))}${index + 1}. ${render(child, depth + 1).trim().replace(/^-\s*/, '')}`).join('')}\n\n`;
    if (tag === 'table') return `\n\n${tableMarkdown(node)}\n\n`;
    return children;
  };
  return { markdown: render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), assets };
}

function canonicalUrl() {
  const value = document.querySelector('link[rel="canonical"]')?.href || location.href;
  try {
    const url = new URL(value);
    [...url.searchParams.keys()].filter((key) => /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)).forEach((key) => url.searchParams.delete(key));
    url.hash = '';
    return url.href;
  } catch { return location.href; }
}

function readabilityArticle() {
  try {
    const parsed = new Readability(document.cloneNode(true), { charThreshold: 140 }).parse();
    if (!parsed?.content || !parsed.textContent?.trim()) return null;
    const container = document.createElement('article');
    container.innerHTML = parsed.content;
    return { root: container, parsed };
  } catch { return null; }
}

function extractCapture() {
  const captureId = crypto.randomUUID();
  const selection = window.getSelection();
  const readable = selection?.toString().trim() ? null : readabilityArticle();
  let root = readable?.root || document.querySelector('article, main, [role="main"]') || document.body;
  let extractionMode = readable || document.querySelector('article, main, [role="main"]') ? 'article' : 'full-page';
  if (selection && selection.rangeCount && selection.toString().trim()) {
    const container = document.createElement('div');
    container.appendChild(selection.getRangeAt(0).cloneContents());
    root = container;
    extractionMode = 'selection';
  }
  const clean = cleanRoot(root);
  const title = readable?.parsed.title || document.querySelector('meta[property="og:title"]')?.content || document.title || 'Untitled page';
  const author = readable?.parsed.byline || document.querySelector('meta[name="author"], meta[property="article:author"]')?.content || '';
  const publishedAt = readable?.parsed.publishedTime || document.querySelector('meta[property="article:published_time"], meta[name="date"]')?.content || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  const converted = toMarkdown(clean, captureId);
  const canonical = canonicalUrl();
  const frontMatter = ['---', 'source: web-clipper', `url: ${JSON.stringify(location.href)}`, `canonical_url: ${JSON.stringify(canonical)}`, `title: ${JSON.stringify(title)}`, ...(author ? [`author: ${JSON.stringify(author)}`] : []), ...(publishedAt ? [`published_at: ${JSON.stringify(publishedAt)}`] : []), `extraction_mode: ${extractionMode}`, '---', ''].join('\n');
  return { captureId, url: location.href, canonicalUrl: canonical, title, author, publishedAt, extractionMode, markdown: `${frontMatter}\n# ${title.replace(/[#\n]/g, ' ').trim()}\n\n${converted.markdown}`.trim(), capturedAt: new Date().toISOString(), extractorVersion: EXTRACTOR_VERSION, assets: converted.assets };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function readAsset(asset) {
  try {
    const response = await fetch(asset.originalUrl, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false, code: `http_${response.status}` };
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_ASSET_BYTES) return { ok: false, code: 'asset_too_large' };
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_ASSET_BYTES) return { ok: false, code: 'asset_too_large' };
    return { ok: true, data: bytesToBase64(new Uint8Array(buffer)) };
  } catch (error) {
    return { ok: false, code: error?.name === 'TimeoutError' ? 'asset_timeout' : 'asset_fetch_failed' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'everroom:capture') {
    try { sendResponse(extractCapture()); } catch { sendResponse(null); }
    return true;
  }
  if (message?.type === 'everroom:read-asset') {
    void readAsset(message.asset).then(sendResponse);
    return true;
  }
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'everroom-page') return;
  void chrome.runtime.sendMessage({ type: 'everroom:send', eventType: event.data.type || 'page.message', payload: event.data.payload && typeof event.data.payload === 'object' ? event.data.payload : {} });
});
