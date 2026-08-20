export interface DocumentPdfHtmlInput {
  title: string
  contentHtml: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

export function createDocumentPdfHtml({ title, contentHtml }: DocumentPdfHtmlInput): string {
  const safeTitle = escapeHtml(title.trim() || '无标题文档')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https: http: nxcore-document-asset:">
  <meta name="color-scheme" content="light">
  <title>${safeTitle}</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm 20mm;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      background: #ffffff;
      color: #25282d;
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.75;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    body {
      min-width: 0;
    }

    .document {
      width: 100%;
      margin: 0;
      background: #ffffff;
    }

    .document-title {
      margin: 0 0 10mm;
      color: #17191d;
      font-size: 24pt;
      font-weight: 700;
      line-height: 1.25;
      overflow-wrap: anywhere;
      break-after: avoid-page;
    }

    .document-content > :first-child {
      margin-top: 0;
    }

    .document-content > :last-child {
      margin-bottom: 0;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      color: #17191d;
      font-weight: 650;
      line-height: 1.35;
      break-after: avoid-page;
      page-break-after: avoid;
    }

    h1 { margin: 9mm 0 3.5mm; font-size: 20pt; }
    h2 { margin: 7mm 0 3mm; font-size: 15.5pt; }
    h3 { margin: 6mm 0 2.5mm; font-size: 13pt; }
    h4 { margin: 5mm 0 2mm; font-size: 11.5pt; }
    h5 { margin: 4mm 0 2mm; font-size: 10.5pt; }
    h6 { margin: 4mm 0 2mm; font-size: 9.5pt; }

    p {
      margin: 0 0 3.2mm;
      orphans: 3;
      widows: 3;
    }

    strong { font-weight: 700; }
    s { text-decoration-thickness: 1px; }

    ul,
    ol {
      margin: 0 0 4mm;
      padding-left: 7mm;
    }

    li {
      margin: 0.8mm 0;
      orphans: 2;
      widows: 2;
    }

    li > p {
      margin-bottom: 1.2mm;
    }

    ul[data-type='taskList'] {
      padding-left: 0;
      list-style: none;
    }

    ul[data-type='taskList'] li {
      display: grid;
      grid-template-columns: 5mm minmax(0, 1fr);
      column-gap: 2mm;
      align-items: start;
    }

    ul[data-type='taskList'] li > label {
      display: block;
      line-height: 1.75;
    }

    ul[data-type='taskList'] input[type='checkbox'] {
      width: 3.5mm;
      height: 3.5mm;
      margin: 1.2mm 0 0;
      accent-color: #3d6fa8;
    }

    ul[data-type='taskList'] li > div {
      min-width: 0;
    }

    ul[data-type='taskList'] li[data-checked='true'] > div {
      color: #717780;
      text-decoration: line-through;
    }

    blockquote {
      margin: 5mm 0;
      padding: 1mm 0 1mm 4mm;
      border-left: 1.2mm solid #c8d0da;
      color: #555b64;
    }

    blockquote > :last-child {
      margin-bottom: 0;
    }

    code {
      padding: 0.35mm 1.1mm;
      border-radius: 1mm;
      background: #f0f2f4;
      color: #25282d;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.9em;
    }

    pre {
      margin: 5mm 0;
      padding: 4mm 4.5mm;
      border: 0.25mm solid #d8dde3;
      border-radius: 1.5mm;
      background: #f4f5f7;
      color: #202329;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 8.5pt;
      line-height: 1.58;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      break-inside: auto;
      page-break-inside: auto;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    pre code {
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      white-space: inherit;
    }

    .tableWrapper {
      width: 100%;
      margin: 5mm 0;
      overflow: visible;
    }

    table {
      width: 100%;
      margin: 5mm 0;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 9pt;
    }

    .tableWrapper table {
      margin: 0;
    }

    thead {
      display: table-header-group;
    }

    tr,
    img {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    th,
    td {
      min-width: 0;
      padding: 2.2mm 2.6mm;
      border: 0.25mm solid #cfd5dc;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }

    th {
      background: #edf0f3;
      color: #202329;
      font-weight: 700;
    }

    th > p,
    td > p {
      margin: 0;
    }

    img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 5mm auto;
      object-fit: contain;
    }

    hr {
      margin: 7mm 0;
      border: 0;
      border-top: 0.25mm solid #cfd5dc;
    }

    a {
      color: #285f99;
      text-decoration: underline;
      text-decoration-thickness: 0.2mm;
      text-underline-offset: 0.5mm;
      overflow-wrap: anywhere;
    }

    a[href^='everroom://'] {
      color: #3d5875;
      text-decoration-style: dotted;
    }

    [data-document-block-reference] {
      margin: 4mm 0;
      padding: 3mm 3.5mm;
      border-left: 1mm solid #91a4b8;
      background: #f2f4f6;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    [data-document-block-reference] strong,
    [data-document-block-reference] small {
      display: block;
    }

    [data-document-block-reference] small {
      margin-top: 0.8mm;
      color: #606873;
      font-size: 9pt;
    }

    [data-placeholder]::before,
    .is-empty::before {
      content: none !important;
    }
  </style>
</head>
<body>
  <main class="document">
    <h1 class="document-title">${safeTitle}</h1>
    <article class="document-content">${contentHtml}</article>
  </main>
</body>
</html>`
}
