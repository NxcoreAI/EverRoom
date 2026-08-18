import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type IFontAttributesProperties,
  type IRunOptions,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx'
import type { JSONContent } from '@tiptap/react'

const ORDERED_LIST_REFERENCE = 'tiptap-ordered-list'
const BODY_FONT: IFontAttributesProperties = {
  ascii: 'Arial',
  hAnsi: 'Arial',
  eastAsia: 'PingFang SC',
  cs: 'PingFang SC',
  hint: 'eastAsia',
}
const CODE_FONT: IFontAttributesProperties = {
  ascii: 'Courier New',
  hAnsi: 'Courier New',
  eastAsia: 'PingFang SC',
  cs: 'PingFang SC',
  hint: 'eastAsia',
}

type ListKind = 'bullet' | 'ordered' | 'task'

function textFromNode(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textFromNode).join('')
}

function codeBlockText(node: JSONContent): string {
  const parts: string[] = []
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      parts.push('\n')
      continue
    }
    if (child.type === 'paragraph' && parts.length > 0 && !parts.at(-1)?.endsWith('\n')) {
      parts.push('\n')
    }
    parts.push(textFromNode(child))
  }
  return parts.join('')
}

function textRunOptions(node: JSONContent): IRunOptions {
  const marks = node.marks ?? []
  const color = marks.find((mark) => mark.type === 'textStyle')?.attrs?.color
  return {
    text: node.text ?? '',
    ...(marks.some((mark) => mark.type === 'bold') ? { bold: true } : {}),
    ...(marks.some((mark) => mark.type === 'italic') ? { italics: true } : {}),
    ...(marks.some((mark) => mark.type === 'strike') ? { strike: true } : {}),
    ...(marks.some((mark) => mark.type === 'underline') ? { underline: {} } : {}),
    font: marks.some((mark) => mark.type === 'code') ? CODE_FONT : BODY_FONT,
    language: { eastAsia: 'zh-CN' },
    ...(typeof color === 'string' && /^#?[0-9a-f]{6}$/i.test(color)
      ? { color: color.replace(/^#/, '') }
      : {}),
  }
}

function inlineChildren(nodes: JSONContent[] | undefined): ParagraphChild[] {
  const children: ParagraphChild[] = []
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      children.push(new TextRun({ break: 1 }))
      continue
    }
    if (node.type !== 'text') {
      if (node.content?.length) children.push(...inlineChildren(node.content))
      continue
    }

    const link = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href
    const lines = (node.text ?? '').split('\n')
    lines.forEach((line, index) => {
      if (index > 0) children.push(new TextRun({ break: 1 }))
      const run = new TextRun({ ...textRunOptions(node), text: line })
      if (typeof link === 'string' && link.length > 0) {
        children.push(new ExternalHyperlink({ children: [run], link }))
      } else {
        children.push(run)
      }
    })
  }
  return children
}

function paragraphForNode(
  node: JSONContent,
  options: IParagraphOptions = {},
): Paragraph {
  const children = inlineChildren(node.content)
  return new Paragraph({
    ...options,
    children: children.length ? children : [new TextRun('')],
  })
}

function listParagraph(
  node: JSONContent,
  kind: ListKind,
  level: number,
  firstParagraph: boolean,
): Paragraph {
  const itemContent = node.content ?? []
  const paragraphNode = itemContent.find((child) => child.type === 'paragraph')
  const inlineContent = paragraphNode?.content ?? itemContent.filter((child) => (
    child.type !== 'bulletList' && child.type !== 'orderedList' && child.type !== 'taskList'
  ))
  const paragraph = { type: 'paragraph' as const, content: inlineContent }
  const prefix = kind === 'task'
    ? `[${node.attrs?.checked === true ? 'x' : ' '}] `
    : ''
  const children = inlineChildren(paragraph.content)
  if (prefix && firstParagraph) children.unshift(new TextRun(prefix))
  const options: IParagraphOptions = {
    children: children.length ? children : [new TextRun('')],
  }
  if (firstParagraph) {
    if (kind === 'ordered') {
      return new Paragraph({
        ...options,
        numbering: { reference: ORDERED_LIST_REFERENCE, level },
      })
    } else {
      return new Paragraph({ ...options, bullet: { level } })
    }
  }
  return new Paragraph(options)
}

function renderList(node: JSONContent, kind: ListKind, level: number): Array<Paragraph | Table> {
  const result: Array<Paragraph | Table> = []
  for (const item of node.content ?? []) {
    if (item.type !== 'listItem' && item.type !== 'taskItem') continue
    const paragraphs = (item.content ?? []).filter((child) => child.type === 'paragraph')
    if (paragraphs.length === 0) {
      result.push(listParagraph(item, kind, level, true))
    } else {
      paragraphs.forEach((paragraph, index) => result.push(
        listParagraph({ ...item, content: paragraph.content }, kind, level, index === 0),
      ))
    }
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList') result.push(...renderList(child, 'bullet', level + 1))
      if (child.type === 'orderedList') result.push(...renderList(child, 'ordered', level + 1))
      if (child.type === 'taskList') result.push(...renderList(child, 'task', level + 1))
    }
  }
  return result
}

function renderTable(node: JSONContent): Table {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow').map((row) => {
    const cells = (row.content ?? []).filter((cell) => cell.type === 'tableCell' || cell.type === 'tableHeader')
      .map((cell) => {
        const paragraphs = (cell.content ?? []).flatMap((child) => {
          if (child.type === 'paragraph') return [paragraphForNode(child)]
          if (child.type === 'heading') return [paragraphForNode(child)]
          const text = textFromNode(child)
          return [new Paragraph(text)]
        })
        return new TableCell({ children: paragraphs.length ? paragraphs : [new Paragraph('')] })
      })
    return new TableRow({ children: cells.length ? cells : [new TableCell({ children: [new Paragraph('')] })] })
  })
  return new Table({
    rows: rows.length ? rows : [new TableRow({ children: [new TableCell({ children: [new Paragraph('')] })] })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
  })
}

function splitMarkdownHeadingParagraph(node: JSONContent): JSONContent[] | null {
  if (node.content?.length !== 1 || node.content[0].type !== 'text' || node.content[0].marks?.length) return null
  const text = node.content[0].text ?? ''
  const leading = text.match(/^(#{1,6})\s+(.+)$/s)
  if (leading) {
    return [{
      type: 'heading',
      attrs: { level: leading[1].length },
      content: [{ type: 'text', text: leading[2] }],
    }]
  }
  const embedded = text.match(/^(.+?[。！？.!?])\s*(#{1,6})\s+(.+)$/s)
  if (!embedded) return null
  return [
    { type: 'paragraph', content: [{ type: 'text', text: embedded[1] }] },
    {
      type: 'heading',
      attrs: { level: embedded[2].length },
      content: [{ type: 'text', text: embedded[3] }],
    },
  ]
}

function renderBlocks(nodes: JSONContent[] | undefined): Array<Paragraph | Table> {
  const result: Array<Paragraph | Table> = []
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'paragraph': {
        const split = splitMarkdownHeadingParagraph(node)
        result.push(...(split ? renderBlocks(split) : [paragraphForNode(node)]))
        break
      }
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))
        result.push(paragraphForNode(node, {
          heading: HeadingLevel[`HEADING_${level}` as keyof typeof HeadingLevel],
        }))
        break
      }
      case 'bulletList':
        result.push(...renderList(node, 'bullet', 0))
        break
      case 'orderedList':
        result.push(...renderList(node, 'ordered', 0))
        break
      case 'taskList':
        result.push(...renderList(node, 'task', 0))
        break
      case 'blockquote':
        for (const child of node.content ?? []) {
          if (child.type === 'paragraph') {
            result.push(paragraphForNode(child, {
              indent: { left: 720 },
              border: { left: { color: 'B7C5D6', space: 8, style: BorderStyle.SINGLE, size: 12 } },
            }))
          } else {
            result.push(...renderBlocks([child]))
          }
        }
        break
      case 'codeBlock': {
        const text = codeBlockText(node)
          .replace(/\r\n?/g, '\n')
          .replace(/\t/g, '    ')
        const lines = text.split('\n')
        const children: ParagraphChild[] = []
        lines.forEach((line, lineIndex) => {
          if (lineIndex > 0) children.push(new TextRun({ break: 1 }))
          if (line.length > 0) children.push(new TextRun({
            text: line,
            font: CODE_FONT,
            language: { eastAsia: 'zh-CN' },
          }))
        })
        result.push(new Paragraph({
          children: children.length ? children : [new TextRun(' ')],
          shading: { fill: 'F3F4F6' },
          spacing: { before: 80, after: 80, line: 240 },
          indent: { left: 180, right: 180 },
          keepLines: true,
        }))
        break
      }
      case 'horizontalRule':
        result.push(new Paragraph({ text: '---' }))
        break
      case 'table':
        result.push(renderTable(node))
        break
      case 'image':
        result.push(new Paragraph({ text: node.attrs?.alt ? `[Image: ${String(node.attrs.alt)}]` : '[Image]' }))
        break
      default:
        if (node.content?.length) result.push(...renderBlocks(node.content))
        else if (node.type === 'text' && node.text) result.push(new Paragraph(node.text))
    }
  }
  return result
}

export function docxExportFileName(documentName: string): string {
  const safeName = documentName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
  return `${safeName || '无标题文档'}.docx`
}

export async function createDocxBlob(content: JSONContent, documentName: string): Promise<Blob> {
  const children = renderBlocks(content.type === 'doc' ? content.content : [content])
  const document = new Document({
    title: documentName,
    styles: {
      default: {
        document: { run: { font: BODY_FONT } },
      },
    },
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
    numbering: {
      config: [{
        reference: ORDERED_LIST_REFERENCE,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
        })),
      }],
    },
  })
  return Packer.toBlob(document)
}
