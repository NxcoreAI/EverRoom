import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  importRoomMarkdownFiles,
  isMarkdownFileName,
} from '../src/renderer/src/components/context-room/knowledgeMarkdownImport'
import type { KnowledgeFileDto } from '../src/shared/knowledge'

function knowledgeFile(id: string, originalName: string): KnowledgeFileDto {
  return {
    id,
    originalName,
    bytes: 128,
    title: null,
    status: 'confirmed',
    decidedBy: null,
    confidence: null,
    uploadedAt: '2026-08-27T00:00:00.000Z',
  }
}

function installBridge({
  files,
  documents = [],
  markdownOf = () => '# 标题\n\n正文',
}: {
  files: KnowledgeFileDto[]
  documents?: Array<{ id: string; title: string }>
  markdownOf?: (fileId: string) => string
}) {
  const knowledge = {
    listRoomFiles: vi.fn(() => Promise.resolve({ items: files })),
    readFileMarkdown: vi.fn((fileId: string) => Promise.resolve({ markdown: markdownOf(fileId) })),
  }
  const documentsApi = {
    list: vi.fn(() => Promise.resolve(documents)),
    import: vi.fn(() => Promise.resolve({ id: 'doc-new', title: 'imported' })),
  }
  vi.stubGlobal('window', {
    nxcore: { knowledge, documents: documentsApi },
  })
  return { knowledge, documentsApi }
}

describe('knowledgeMarkdownImport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('isMarkdownFileName 覆盖 md/markdown 大小写与常见非 md 扩展', () => {
    expect(isMarkdownFileName('笔记.md')).toBe(true)
    expect(isMarkdownFileName('NOTES.MARKDOWN')).toBe(true)
    expect(isMarkdownFileName('报告.pdf')).toBe(false)
    expect(isMarkdownFileName('表格.xlsx')).toBe(false)
    expect(isMarkdownFileName('无扩展名')).toBe(false)
  })

  it('只把 Room 归属的 md 文件转为云文档，标题去掉扩展名', async () => {
    const { documentsApi } = installBridge({
      files: [
        knowledgeFile('file-a', '会议纪要.md'),
        knowledgeFile('file-b', '设计稿.pdf'),
        knowledgeFile('file-c', 'README.markdown'),
      ],
    })

    const created = await importRoomMarkdownFiles('room-md-1')

    expect(created).toBe(2)
    expect(documentsApi.import).toHaveBeenCalledTimes(2)
    const titles = documentsApi.import.mock.calls.map(([input]) => input.title)
    expect(titles).toEqual(['会议纪要', 'README'])
    for (const input of documentsApi.import.mock.calls.map(([input]) => input)) {
      expect(input.roomId).toBe('room-md-1')
      expect(input.contentJson.type).toBe('doc')
    }
  })

  it('Room 内已存在同名文档时跳过（幂等去重）', async () => {
    const { documentsApi } = installBridge({
      files: [knowledgeFile('file-dup', '会议纪要.md')],
      documents: [{ id: 'doc-existing', title: '会议纪要' }],
    })

    const created = await importRoomMarkdownFiles('room-md-2')

    expect(created).toBe(0)
    expect(documentsApi.import).not.toHaveBeenCalled()
  })

  it('单文件读取失败不影响其余文件，且失败的文件下次重试', async () => {
    const { knowledge, documentsApi } = installBridge({
      files: [
        knowledgeFile('file-bad', '坏文件.md'),
        knowledgeFile('file-good', '好文件.md'),
      ],
      markdownOf: (fileId) => {
        if (fileId === 'file-bad') throw new Error('解析失败')
        return '# 好文件'
      },
    })

    expect(await importRoomMarkdownFiles('room-md-3')).toBe(1)
    expect(documentsApi.import).toHaveBeenCalledTimes(1)

    // 修复后重跑：失败文件补转，成功文件不重复
    knowledge.readFileMarkdown.mockImplementation(() => Promise.resolve({ markdown: '# 修复' }))
    expect(await importRoomMarkdownFiles('room-md-3')).toBe(1)
    expect(documentsApi.import).toHaveBeenCalledTimes(2)
  })

  it('processed Set 让已成功文件在重复触发时不再创建', async () => {
    const { documentsApi } = installBridge({
      files: [knowledgeFile('file-once', '一次性.md')],
    })

    await importRoomMarkdownFiles('room-md-4')
    await importRoomMarkdownFiles('room-md-4')

    expect(documentsApi.import).toHaveBeenCalledTimes(1)
  })

  it('knowledge/documents 服务不可用时静默返回 0', async () => {
    vi.stubGlobal('window', {})

    expect(await importRoomMarkdownFiles('room-md-5')).toBe(0)
  })
})
