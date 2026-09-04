import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import { DocumentCommentService } from '../src/modules/documents/comments.js'
import { DocumentServiceError } from '../src/modules/documents/errors.js'

let closeDatabase: (() => void) | null = null

afterEach(() => {
  closeDatabase?.()
  closeDatabase = null
})

describe('document comments', () => {
  it('creates threads, replies, resolves and deletes', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-comments-'))
    const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
    closeDatabase = () => created.sqlite.close()
    const documents = new DocumentService(created.db, new DocumentEventBroker())
    const comments = new DocumentCommentService(created.db, (documentId) => Boolean(documents.get(documentId)))

    const room = `room-c-${Math.random().toString(36).slice(2, 8)}`
    const document = await documents.import({
      id: `doc-c-${Math.random().toString(36).slice(2, 10)}`,
      roomId: room,
      title: '评论测试文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] } as never,
    })

    expect(comments.list(document.id)).toHaveLength(0)
    const top = comments.create({ documentId: document.id, body: '  第一条评论  ' })
    expect(top.body).toBe('第一条评论')
    expect(top.authorName).toBe('我')

    const reply = comments.create({ documentId: document.id, body: '回复', parentId: top.id })
    expect(reply.parentId).toBe(top.id)
    // 二级回复不允许
    expect(() => comments.create({ documentId: document.id, body: '嵌套', parentId: reply.id }))
      .toThrowError(expect.objectContaining({ code: 'COMMENT_NESTING' }) as never)

    comments.resolve(document.id, top.id, true)
    expect(comments.list(document.id).find((item) => item.id === top.id)?.resolved).toBe(true)

    // 删除一级评论连带回复
    comments.delete(document.id, top.id)
    expect(comments.list(document.id)).toHaveLength(0)

    // 空内容拒绝
    expect(() => comments.create({ documentId: document.id, body: '   ' }))
      .toThrowError(expect.objectContaining({ code: 'COMMENT_BODY_EMPTY' }) as never)
    // 文档不存在
    expect(() => comments.list('not-exist'))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }) as never)
    expect(() => comments.delete(document.id, 'ghost'))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }) as never)
  })
})
