import { describe, expect, it } from 'vitest'

import { createDocumentPdfHtml } from '../src/main/document-pdf-template'
import { markdownExportFileName } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapDocumentActions'
import { pdfExportFileName } from '../src/renderer/src/components/context-room/ported/components/detail-editor/tiptapPdfExport'
import {
  createDocxBlob,
  docxExportFileName,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/tiptapDocxExport'

describe('Markdown document export', () => {
  it('creates a safe Markdown download name', () => {
    expect(markdownExportFileName('项目计划')).toBe('项目计划.md')
    expect(markdownExportFileName('release: plan / v1')).toBe('release- plan - v1.md')
    expect(markdownExportFileName('  ...  ')).toBe('无标题文档.md')
  })

  it('creates a safe Word document download name', () => {
    expect(docxExportFileName('项目计划')).toBe('项目计划.docx')
    expect(docxExportFileName('release: plan / v1')).toBe('release- plan - v1.docx')
    expect(docxExportFileName('  ...  ')).toBe('无标题文档.docx')
  })

  it('creates a safe PDF download name', () => {
    expect(pdfExportFileName('项目计划')).toBe('项目计划.pdf')
    expect(pdfExportFileName('release: plan / v1')).toBe('release- plan - v1.pdf')
    expect(pdfExportFileName('  ...  ')).toBe('无标题文档.pdf')
  })

  it('builds an isolated A4 print document for PDF export', () => {
    const html = createDocumentPdfHtml({
      title: '<汇编 & "测试">',
      contentHtml: '<h2>代码示例</h2><pre><code>mov ax, bx\n; comment</code></pre>',
    })

    expect(html).toContain('<title>&lt;汇编 &amp; &quot;测试&quot;&gt;</title>')
    expect(html).toContain('<h1 class="document-title">&lt;汇编 &amp; &quot;测试&quot;&gt;</h1>')
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain('size: A4')
    expect(html).toContain('break-inside: auto')
    expect(html).toContain('box-decoration-break: clone')
    expect(html).toContain('<h2>代码示例</h2><pre><code>mov ax, bx\n; comment</code></pre>')
    expect(html).not.toContain('context-room-pdf-export')
    expect(html).not.toContain('ProseMirror')
  })

  it('packages common TipTap blocks as a docx Blob', async () => {
    const blob = await createDocxBlob({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '重点', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目' }] }] }],
        },
      ],
    }, '导出测试')

    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(blob.size).toBeGreaterThan(0)
  })
})
