const EXTRACTOR_VERSION = 'readability-0.6.0+everroom-10';
const MAX_ASSETS = 100;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MEDIA_CANDIDATE_SELECTOR = 'img, video[poster], [style*="background"], [data-src], [data-lazy-src], [data-original], [data-bg], [data-background], [data-background-image]';

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

function bestSrcsetUrl(value) {
  if (!value) return null;
  return value.split(',').map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop() || null;
}

function firstCssImageUrl(value) {
  if (!value || value === 'none') return null;
  const match = value.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
  return match?.[2] || null;
}

function preferredImageUrl(node) {
  const pictureSources = node.tagName?.toLowerCase() === 'img'
    ? [...(node.closest('picture')?.querySelectorAll('source') || [])].flatMap((source) => [
        bestSrcsetUrl(source.getAttribute('srcset')),
        bestSrcsetUrl(source.getAttribute('data-srcset')),
        source.getAttribute('src'),
      ])
    : [];
  const candidates = [
    node.getAttribute('data-src'),
    node.getAttribute('data-lazy-src'),
    node.getAttribute('data-original'),
    node.getAttribute('data-image'),
    node.getAttribute('data-bg'),
    node.getAttribute('data-background'),
    node.getAttribute('data-background-image'),
    bestSrcsetUrl(node.getAttribute('srcset') || node.getAttribute('data-srcset')),
    ...pictureSources,
    node.currentSrc,
    node.getAttribute('src'),
    node.getAttribute('poster'),
    firstCssImageUrl(node.style?.backgroundImage),
    firstCssImageUrl(node.getAttribute('content')),
    node.getAttribute('content'),
    node.getAttribute('href'),
  ];
  for (const value of candidates) {
    if (!value || /^(data|blob|javascript|vbscript):/i.test(value.trim())) continue;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {}
  }
  return null;
}

function imageDescriptor(node) {
  const source = preferredImageUrl(node);
  if (!source) return null;
  const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
  const width = Number(node.getAttribute('width') || node.naturalWidth || node.clientWidth || rect?.width || 0);
  const height = Number(node.getAttribute('height') || node.naturalHeight || node.clientHeight || rect?.height || 0);
  if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return null;
  const figureText = node.closest?.('figure')?.querySelector('figcaption')?.textContent || '';
  const altText = (node.getAttribute('alt') || node.getAttribute('aria-label') || node.getAttribute('title') || figureText)
    .replace(/\s+/g, ' ').trim().slice(0, 1000);
  return {
    source,
    altText,
    ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width) } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height: Math.round(height) } : {}),
  };
}

function topLevelTrackCount(value) {
  if (!value || value === 'none') return 0;
  const repeated = value.match(/^repeat\(\s*(\d+)\s*,/i);
  if (repeated) return Number(repeated[1]);
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  for (const character of value.trim()) {
    if (character === '(') { depth += 1; inTrack = true; }
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (/\s/.test(character) && depth === 0) {
      if (inTrack) tracks += 1;
      inTrack = false;
    } else inTrack = true;
  }
  return tracks + Number(inTrack);
}

function imageLayoutMap(root) {
  const layouts = new Map();
  let groupIndex = 0;
  const containers = [...root?.querySelectorAll?.('div, section, figure, ul, ol, p') || []].reverse();
  if (root?.nodeType === Node.ELEMENT_NODE) containers.push(root);

  for (const container of containers) {
    const items = [...container.children].flatMap((child) => {
      const images = child.matches('img') ? [child] : [...child.querySelectorAll('img')];
      if (images.length !== 1) return [];
      const content = child.cloneNode(true);
      content.querySelectorAll?.('img, picture, source, figcaption').forEach((node) => node.remove());
      if ((content.textContent || '').replace(/\s+/g, ' ').trim()) return [];
      return [{ child, image: images[0] }];
    });
    if (items.length < 2 || items.length > 24 || items.some(({ image }) => layouts.has(image))) continue;

    let computed;
    try { computed = container.isConnected ? getComputedStyle(container) : null; } catch { computed = null; }
    const display = computed?.display || container.style?.display || '';
    const flexDirection = computed?.flexDirection || container.style?.flexDirection || '';
    const gridColumns = computed?.gridTemplateColumns || container.style?.gridTemplateColumns || '';
    const columnCount = Number.parseInt(computed?.columnCount || container.style?.columnCount || '0', 10) || 0;
    const identity = `${container.id || ''} ${container.className || ''}`;
    const layoutStyle = `${container.getAttribute('style') || ''}`;
    const hasLayoutSignal = /^(?:inline-)?grid$/i.test(display)
      || (/^(?:inline-)?flex$/i.test(display) && flexDirection !== 'column')
      || columnCount > 1
      || /(?:^|[\s_-])(gallery|grid|row|columns?|tiles?|mosaic|photos?)(?:[\s_-]|$)/i.test(identity)
      || /display\s*:\s*(?:grid|flex)|grid-template-columns|column-count/i.test(layoutStyle);

    const rects = items.map(({ child }) => child.getBoundingClientRect?.()).filter((rect) => rect && rect.width > 0 && rect.height > 0);
    let geometricColumns = 0;
    for (const anchor of rects) {
      const tolerance = Math.max(8, Math.min(anchor.height * 0.35, 40));
      geometricColumns = Math.max(geometricColumns, rects.filter((rect) => Math.abs(rect.top - anchor.top) <= tolerance).length);
    }
    if (!hasLayoutSignal && geometricColumns < 2) continue;

    const classColumns = identity.match(/(?:cols?|columns?)[\s_-]?(\d+)/i)?.[1];
    const columns = Math.max(2, Math.min(6,
      geometricColumns
      || topLevelTrackCount(gridColumns)
      || columnCount
      || Number(classColumns)
      || items.length));
    const group = `image-grid-${++groupIndex}`;
    items.forEach(({ image }, order) => layouts.set(image, { group, columns, order }));
  }
  return layouts;
}

const NON_ARTICLE_MEDIA_SELECTOR = [
  'header', 'nav', 'aside', 'footer', 'form', 'dialog',
  '[role="navigation"]', '[role="complementary"]', '[role="contentinfo"]',
  '[aria-label*="comment" i]', '[aria-label*="share" i]', '[aria-label*="related" i]',
  '[data-dts-event-location*="recom" i]', '[data-dts-event-location*="related" i]',
].join(',');
const NON_ARTICLE_IDENTITY = /(?:^|[\s_-])(author|avatar|profile|byline|comment|related|recommend|popular|sidebar|share|social|follow|subscribe|newsletter|advert|ads?|promo|banner|sponsor|reward|donate|qrcode|qr-code|wechat|weixin|footer|header|nav|toolbar|breadcrumb)(?:[\s_-]|$)|作者|评论|推荐|广告|关注|赞赏|打赏|二维码|公众号/i;
const NON_ARTICLE_FILE = /(?:^|[\W_])(avatar|emoji|emoticon|sticker|qrcode|qr-code|wechat-qr|weixin|reward|donate|tracking|pixel|spacer|favicon|sprite)(?:[\W_]|$)/i;
const NON_ARTICLE_SECTION_LABEL = /^(?:推荐专题|专题推荐|相关推荐|相关阅读|延伸阅读|猜你喜欢|你可能(?:也)?喜欢|更多推荐|热门推荐|相关内容|更多文章|大家都在看|recommended(?:\s+(?:stories|articles|topics|reads|for you))?|related(?:\s+(?:posts|stories|articles|content|reads))?|you may also like|more from(?:\s+.+)?|read next|popular (?:stories|articles))\s*[：:]?$/i;

function normalizedLabel(node) {
  return (node?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function headingLevel(node) {
  const tagLevel = node?.tagName?.match?.(/^H([1-6])$/i)?.[1];
  return Number(tagLevel || node?.getAttribute?.('aria-level') || 6);
}

function nonArticleSectionNodes(root) {
  const excluded = new Set();
  const labels = root?.querySelectorAll?.('h2, h3, h4, h5, h6, [role="heading"], [class*="section-title" i], [class*="module-title" i], nav [class~="title"]') || [];
  for (const label of labels) {
    const text = normalizedLabel(label);
    if (!text || text.length > 80 || !NON_ARTICLE_SECTION_LABEL.test(text)) continue;
    let current = label.parentElement;
    let boundary = root;
    let module = null;
    while (current && current !== root) {
      if (current.matches?.('article, main, [role="main"], [itemprop~="articleBody"]')) {
        boundary = current;
        break;
      }
      const hasCards = current.querySelector?.(MEDIA_CANDIDATE_SELECTOR)
        || current.querySelectorAll?.('a[href]').length >= 2;
      if (hasCards) {
        module = current;
        break;
      }
      current = current.parentElement;
    }
    if (module) {
      excluded.add(module);
      continue;
    }

    let anchor = label;
    while (anchor.parentElement && anchor.parentElement !== boundary && anchor.parentElement !== root) anchor = anchor.parentElement;
    const level = headingLevel(label);
    for (let sibling = anchor; sibling; sibling = sibling.nextElementSibling) {
      if (sibling !== anchor) {
        const nextHeading = sibling.matches?.('h1, h2, h3, h4, h5, h6, [role="heading"]')
          ? sibling
          : sibling.querySelector?.('h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (nextHeading && headingLevel(nextHeading) <= level) break;
      }
      excluded.add(sibling);
    }
  }
  return excluded;
}

function pruneNonArticleSections(root) {
  const nodes = nonArticleSectionNodes(root);
  nodes.forEach((node) => node.remove());
  return root;
}

function isPrincipalMedia(node, root, excludedContainers = new Set()) {
  if (!node || !root?.contains?.(node)) return false;
  let current = node;
  while (current && current !== root) {
    if (excludedContainers.has(current)) return false;
    if (current.matches?.(NON_ARTICLE_MEDIA_SELECTOR)) return false;
    const identity = `${current.id || ''} ${current.className || ''} ${current.getAttribute?.('data-component') || ''} ${current.getAttribute?.('aria-label') || ''}`;
    if (NON_ARTICLE_IDENTITY.test(identity)) return false;
    current = current.parentElement;
  }

  const descriptor = imageDescriptor(node);
  if (!descriptor || NON_ARTICLE_FILE.test(`${descriptor.altText} ${descriptor.source}`)) return false;
  const width = descriptor.width || 0;
  const height = descriptor.height || 0;
  if ((width > 0 && width < 80) || (height > 0 && height < 48)) return false;
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (width * height < 20_000 || ratio > 6 || ratio < 1 / 6) return false;
  }
  if (node.getAttribute?.('role') === 'presentation' && !descriptor.altText) return false;
  if (node.tagName?.toLowerCase() !== 'img' && node.tagName?.toLowerCase() !== 'source') {
    if (!descriptor.altText || width < 160 || height < 90) return false;
  }
  const link = node.closest?.('a');
  if (link && NON_ARTICLE_IDENTITY.test(`${link.id || ''} ${link.className || ''} ${link.getAttribute('aria-label') || ''}`)) return false;
  return true;
}

function replaceElementTag(node, tagName) {
  const replacement = node.ownerDocument.createElement(tagName);
  [...node.attributes].forEach((attribute) => {
    if (attribute.name !== 'role') replacement.setAttribute(attribute.name, attribute.value);
  });
  while (node.firstChild) replacement.appendChild(node.firstChild);
  node.replaceWith(replacement);
  return replacement;
}

function normalizeStructuredContent(root) {
  const roleLists = [...root.querySelectorAll?.('[role="list"]') || []];
  const roleListItems = [...root.querySelectorAll?.('[role="listitem"]') || []];
  const orderedLists = new Set(roleLists.filter((list) => {
    const items = [...list.children].filter((child) => child.getAttribute('role') === 'listitem');
    return list.classList.contains('steps') || items.some((item) => item.querySelector('[data-component-part="step-number"]'));
  }));

  roleListItems.forEach((item) => {
    item.querySelectorAll([
      '[data-component-part="step-line"]',
      '[data-component-part="step-number"]',
      '[data-component-part="scroll-area-scrollbar"]',
      '[data-floating-buttons="true"]',
      '[data-fade-overlay="true"]',
    ].join(',')).forEach((node) => node.remove());
    [item, ...item.querySelectorAll('*')].forEach((node) => {
      const codeLanguage = node.getAttribute('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
      if (codeLanguage && !node.hasAttribute('language')) node.setAttribute('language', codeLanguage);
      [...node.attributes].forEach((attribute) => {
        if (['class', 'id', 'style', 'contenteditable', 'tabindex'].includes(attribute.name) || attribute.name.startsWith('data-')) {
          node.removeAttribute(attribute.name);
        }
      });
    });
  });

  roleListItems.reverse().forEach((item) => replaceElementTag(item, 'li'));
  roleLists.reverse().forEach((list) => {
    if (list.isConnected || list.parentNode) replaceElementTag(list, orderedLists.has(list) ? 'ol' : 'ul');
  });

  [...root.querySelectorAll?.('span[data-as="p"]') || []].reverse().forEach((paragraph) => replaceElementTag(paragraph, 'p'));
  [...root.querySelectorAll?.('[role="heading"][aria-level]') || []].reverse().forEach((heading) => {
    const level = Math.min(6, Math.max(1, Number(heading.getAttribute('aria-level')) || 2));
    replaceElementTag(heading, `h${level}`);
  });
  return root;
}

function discoverMedia(root) {
  const candidates = [];
  const seen = new Set();
  const layouts = imageLayoutMap(root);
  const excludedContainers = nonArticleSectionNodes(root);
  const add = (node) => {
    if (!isPrincipalMedia(node, root, excludedContainers)) return;
    const descriptor = imageDescriptor(node);
    if (!descriptor) return;
    const layout = layouts.get(node);
    if (layout) Object.assign(descriptor, { layoutGroup: layout.group, layoutColumns: layout.columns, layoutOrder: layout.order });
    if (seen.has(descriptor.source)) {
      if (layout) Object.assign(candidates.find((item) => item.source === descriptor.source), descriptor);
      return;
    }
    seen.add(descriptor.source);
    candidates.push(descriptor);
  };
  if (root?.nodeType === Node.ELEMENT_NODE && root.matches(MEDIA_CANDIDATE_SELECTOR)) add(root);
  root?.querySelectorAll?.(MEDIA_CANDIDATE_SELECTOR).forEach(add);
  return candidates;
}

function cleanRoot(root, media = []) {
  const clone = pruneNonArticleSections(root.cloneNode(true));
  const allowedMediaSources = new Set(media.map((item) => item.source));
  const layoutBySource = new Map(media.filter((item) => item.layoutGroup).map((item) => [item.source, item]));
  normalizeStructuredContent(clone);
  clone.querySelectorAll('script,style,noscript,iframe,form,canvas,template,svg').forEach((node) => node.remove());
  clone.querySelectorAll('img').forEach((node) => {
    const source = preferredImageUrl(node);
    if (source && allowedMediaSources.has(source)) {
      node.setAttribute('src', source);
      const layout = layoutBySource.get(source);
      if (layout) {
        node.setAttribute('data-everroom-image-group', layout.layoutGroup);
        node.setAttribute('data-everroom-image-columns', String(layout.layoutColumns));
        node.setAttribute('data-everroom-image-order', String(layout.layoutOrder));
      }
    }
    else node.remove();
  });
  clone.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name === 'style' || attribute.name === 'srcset'
        || (attribute.name.startsWith('data-') && !attribute.name.startsWith('data-everroom-image-'))) node.removeAttribute(attribute.name);
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

function inlineText(node) { return (node.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); }
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

function toMarkdown(root, captureId, supplementalMedia = []) {
  const assets = [];
  const assetByUrl = new Map();
  const inlineReferences = new Set();
  const descriptorByUrl = new Map(supplementalMedia.map((descriptor) => [descriptor.source, descriptor]));
  const registerAsset = (value) => {
    const extracted = value?.source ? value : imageDescriptor(value);
    const descriptor = extracted ? { ...descriptorByUrl.get(extracted.source), ...extracted } : null;
    if (!descriptor || assets.length >= MAX_ASSETS) return null;
    const known = assetByUrl.get(descriptor.source);
    if (known) return known;
    const asset = {
      id: `asset-${captureId}-${assets.length + 1}`,
      referenceKey: stableAssetReference(descriptor.source),
      originalUrl: descriptor.source,
      altText: descriptor.altText,
      ...(descriptor.width ? { width: descriptor.width } : {}),
      ...(descriptor.height ? { height: descriptor.height } : {}),
    };
    assets.push(asset);
    assetByUrl.set(descriptor.source, asset);
    return asset;
  };
  const renderImage = (node, preserveLink = false) => {
    const asset = registerAsset(node);
    if (asset) inlineReferences.add(asset.referenceKey);
    if (!asset) return '';
    const image = `![${asset.altText.replace(/[\]]/g, '\\]')}](nxcore-clipper-asset://local/${asset.referenceKey})`;
    const href = preserveLink ? node.closest('a')?.getAttribute('href') : null;
    return href ? `[${image}](${href})` : image;
  };
  const groupedImages = (node, group) => {
    const images = [];
    if (node.matches?.(`img[data-everroom-image-group="${group}"]`)) images.push(node);
    node.querySelectorAll?.('img[data-everroom-image-group]').forEach((image) => {
      if (image.getAttribute('data-everroom-image-group') === group) images.push(image);
    });
    return images;
  };
  const renderImageGroup = (node) => {
    const images = [...node.querySelectorAll?.('img[data-everroom-image-group]') || []];
    const groups = [...new Set(images.map((image) => image.getAttribute('data-everroom-image-group')).filter(Boolean))];
    if (groups.length !== 1) return '';
    const group = groups[0];
    const members = groupedImages(node, group);
    if (members.length < 2 || [...node.children].some((child) => groupedImages(child, group).length === members.length)) return '';
    const columns = Math.max(2, Math.min(6, Number(members[0].getAttribute('data-everroom-image-columns')) || members.length));
    const rendered = members.map((member) => renderImage(member, true)).filter(Boolean);
    if (rendered.length < 2) return '';
    return `\n\n<!-- everroom:image-grid:start columns=${columns} -->\n${rendered.join('\n')}\n<!-- everroom:image-grid:end -->\n\n`;
  };
  const render = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const imageGroup = renderImageGroup(node);
    if (imageGroup) return imageGroup;
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
      const code = node.querySelector('code');
      const language = code?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1]
        || code?.getAttribute('language')
        || node.getAttribute('language')
        || '';
      return `\n\n\`\`\`${language}\n${node.textContent.trim()}\n\`\`\`\n\n`;
    }
    if (tag === 'blockquote') return `\n\n${children.trim().split('\n').filter(Boolean).map((line) => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'a') {
      const href = node.getAttribute('href');
      const label = children.trim() || escapeInline(inlineText(node)) || href;
      return href ? `[${label}](${href})` : children;
    }
    if (tag === 'img') {
      return renderImage(node);
    }
    if (tag === 'li') return `\n${'  '.repeat(Math.max(0, depth - 1))}- ${children.trim()}`;
    if (tag === 'ul') return `\n\n${[...node.children].map((child) => render(child, depth + 1)).join('')}\n\n`;
    if (tag === 'ol') return `\n\n${[...node.children].map((child, index) => `\n${'  '.repeat(Math.max(0, depth))}${index + 1}. ${render(child, depth + 1).trim().replace(/^-\s*/, '')}`).join('')}\n\n`;
    if (tag === 'dl') return `\n\n${children.trim()}\n\n`;
    if (tag === 'dt') return `\n\n**${escapeInline(inlineText(node))}**\n\n`;
    if (tag === 'dd') return `\n${children.trim()}\n`;
    if (tag === 'table') return `\n\n${tableMarkdown(node)}\n\n`;
    return children;
  };
  const rendered = render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const recovered = [];
  for (const descriptor of supplementalMedia) {
    const asset = registerAsset(descriptor);
    if (!asset || inlineReferences.has(asset.referenceKey)) continue;
    inlineReferences.add(asset.referenceKey);
    recovered.push({ asset, descriptor });
  }
  const recoveredMarkdown = [];
  for (let index = 0; index < recovered.length;) {
    const current = recovered[index];
    const group = current.descriptor.layoutGroup;
    const members = group ? recovered.filter((item) => item.descriptor.layoutGroup === group) : [current];
    if (group && members.length >= 2) {
      const columns = Math.max(2, Math.min(6, Number(current.descriptor.layoutColumns) || members.length));
      recoveredMarkdown.push(`<!-- everroom:image-grid:start columns=${columns} -->\n${members.map(({ asset }) => `![${asset.altText.replace(/[\]]/g, '\\]')}](nxcore-clipper-asset://local/${asset.referenceKey})`).join('\n')}\n<!-- everroom:image-grid:end -->`);
      const memberAssets = new Set(members.map(({ asset }) => asset.id));
      while (index < recovered.length && memberAssets.has(recovered[index].asset.id)) index += 1;
      continue;
    }
    recoveredMarkdown.push(`![${current.asset.altText.replace(/[\]]/g, '\\]')}](nxcore-clipper-asset://local/${current.asset.referenceKey})`);
    index += 1;
  }
  return { markdown: [rendered, recoveredMarkdown.join('\n\n')].filter(Boolean).join('\n\n'), assets };
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
    const parsed = new Readability(normalizeStructuredContent(pruneNonArticleSections(document.cloneNode(true))), { charThreshold: 140 }).parse();
    if (!parsed?.content || !parsed.textContent?.trim()) return null;
    const container = document.createElement('article');
    container.innerHTML = parsed.content;
    return { root: container, parsed };
  } catch { return null; }
}

function principalContentRoot(parsed) {
  const normalize = (value) => (value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const target = normalize(parsed?.textContent);
  const semanticCandidates = [...document.querySelectorAll('[itemprop~="articleBody"], [data-testid*="article-body" i], article, main, [role="main"]')];
  if (!target) return semanticCandidates[0] || document.body;

  const anchorLength = Math.min(160, Math.max(60, Math.floor(target.length / 4)));
  const samples = target.length >= 120
    ? [target.slice(0, anchorLength), target.slice(-anchorLength)]
    : [target];
  const textMatchedCandidates = target.length >= 120
    ? [...document.body.querySelectorAll('*')].filter((candidate) => {
      if (candidate.matches('script, style, noscript, template, svg')) return false;
      const text = normalize(candidate.textContent);
      return text.length >= target.length * 0.5 && samples.every((sample) => text.includes(sample));
    })
    : [];
  const candidates = [...new Set([...semanticCandidates, ...textMatchedCandidates])];
  if (candidates.length === 0) return document.body;
  let best = null;
  for (const candidate of candidates) {
    const text = normalize(candidate.textContent);
    if (!text) continue;
    const sampleMatches = samples.filter((sample) => text.includes(sample)).length;
    const semanticWeight = candidate.matches('[itemprop~="articleBody"], [data-testid*="article-body" i]') ? 3
      : candidate.matches('article') ? 2 : 1;
    const score = sampleMatches * 1_000_000_000 - Math.abs(text.length - target.length) * 100 + semanticWeight;
    if (!best || score > best.score) best = { node: candidate, score };
  }
  return best?.node || candidates[0];
}

function extractCapture(selectionText = '') {
  const captureId = crypto.randomUUID();
  const selection = window.getSelection();
  const liveSelectionText = selection?.toString().trim() || '';
  const hasSelection = Boolean(liveSelectionText || selectionText.trim());
  const readable = hasSelection ? null : readabilityArticle();
  const pageRoot = principalContentRoot(readable?.parsed);
  let root = readable?.root || pageRoot;
  let mediaRoot = pageRoot;
  let extractionMode = readable || pageRoot !== document.body ? 'article' : 'full-page';
  if (hasSelection) {
    const container = document.createElement('div');
    if (selection && selection.rangeCount && liveSelectionText) container.appendChild(selection.getRangeAt(0).cloneContents());
    else container.textContent = selectionText.trim();
    root = container;
    mediaRoot = container;
    extractionMode = 'selection';
  }
  const media = discoverMedia(mediaRoot);
  const clean = cleanRoot(root, media);
  const title = readable?.parsed.title || document.querySelector('meta[property="og:title"]')?.content || document.title || 'Untitled page';
  const author = readable?.parsed.byline || document.querySelector('meta[name="author"], meta[property="article:author"]')?.content || '';
  const publishedAt = readable?.parsed.publishedTime || document.querySelector('meta[property="article:published_time"], meta[name="date"]')?.content || document.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  const converted = toMarkdown(clean, captureId, media);
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
    return { ok: true, data: bytesToBase64(new Uint8Array(buffer)), byteSize: buffer.byteLength };
  } catch (error) {
    return { ok: false, code: error?.name === 'TimeoutError' ? 'asset_timeout' : 'asset_fetch_failed' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'everroom:capture') {
    try { sendResponse(extractCapture(message.selectionText || '')); } catch { sendResponse(null); }
    return true;
  }
  if (message?.type === 'everroom:read-asset') {
    void readAsset(message.asset).then(sendResponse);
    return true;
  }
  if (message?.type === 'everroom:confirm-large-images') {
    const megabytes = (Number(message.assetBytes || 0) / 1024 / 1024).toFixed(1);
    const totalMegabytes = (Number(message.totalBytes || 0) / 1024 / 1024).toFixed(1);
    const chinese = document.documentElement.lang.toLowerCase().startsWith('zh') || navigator.language.toLowerCase().startsWith('zh');
    const prompt = chinese
      ? `这张图片约 ${megabytes} MB，本次已读取约 ${totalMegabytes} MB。图片较大，继续保存可能需要更长时间并占用更多本地空间。是否继续？`
      : `This image is about ${megabytes} MB (${totalMegabytes} MB read in this capture). Saving it may take longer and use more local storage. Continue?`;
    sendResponse({ confirmed: window.confirm(prompt) });
    return true;
  }
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'everroom-page') return;
  void chrome.runtime.sendMessage({ type: 'everroom:send', eventType: event.data.type || 'page.message', payload: event.data.payload && typeof event.data.payload === 'object' ? event.data.payload : {} });
});
