import type { RoomDocument } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'
import type { KnowledgeFileDto } from '../src/shared/knowledge'

import { consumeDocumentFocusRequest } from '../src/renderer/src/components/context-room/ported/documentFocus'
import {
  createContextRoomResourceLibrary,
  createContextRoomFileItem,
  formatBytes,
  knowledgeFileStatusLabel,
} from '../src/renderer/src/components/context-room/ported/resources'
import { createContextRoomFixture } from './context-room-fixture'

const room = createContextRoomFixture()

function backendDocument(id: string, title: string): RoomDocument {
  return {
    id,
    roomId: room.id,
    title,
    contentJson: { type: 'doc', content: [] },
    version: 2,
    status: 'active',
    activeTransactionId: null,
    deletedAt: null,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T11:00:00.000Z',
  }
}

function knowledgeFile(id: string, name: string): KnowledgeFileDto {
  return {
    id,
    originalName: name,
    bytes: 2048,
    title: null,
    status: 'confirmed',
    decidedBy: 'entry',
    confidence: 1,
    uploadedAt: '2026-08-15T09:00:00.000Z',
  }
}

describe('Context Room document resource mapping', () => {
  it('localizes generated file metadata without a placeholder Office preview payload', () => {
    const item = createContextRoomFileItem({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      modifiedAt: new Date('2026-08-15T09:00:00.000Z'),
      name: 'plan.xlsx',
      path: '/Users/test/plan.xlsx',
      size: 2048,
    }, 'en-US')
    const localizedRoom = { ...room, fileItems: [item] }
    const library = createContextRoomResourceLibrary(localizedRoom, [], [], 'en-US')
    const resource = library.resources.find((candidate) => candidate.kind === 'office-file')

    expect(item.summary).toBe('From the Everroom PC file system: /Users/test/plan.xlsx')
    expect(item.source).toBe('File system /Users/test/plan.xlsx')
    expect(resource).toMatchObject({
      kind: 'office-file',
      format: 'xlsx',
      source: {
        type: 'hostfs',
        path: '/Users/test/plan.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    })
    // 占位预览数据已移除：Office 文件改走顶栏内嵌预览标签打开
    expect(resource && 'preview' in resource).toBe(false)
  })

  it('shows only Gateway documents in the cloud document folder', () => {
    const document = backendDocument('gateway-doc-1', '真实文档')
    const library = createContextRoomResourceLibrary(room, [document])
    const documentFolder = library.folders.find((folder) => folder.name === '云文档')!
    const cloudResources = library.resources.filter((resource) => resource.folderId === documentFolder.id)

    expect(cloudResources).toHaveLength(1)
    expect(cloudResources[0]).toMatchObject({
      kind: 'cloud-doc',
      name: '真实文档',
      binding: { workspaceId: 'gateway', docId: 'gateway-doc-1' },
    })
    expect(cloudResources.some((resource) => resource.binding?.docId === room.cloudDoc.docId)).toBe(false)
  })

  it('does not create a placeholder cloud document when the Gateway list is empty', () => {
    const library = createContextRoomResourceLibrary(room, [])
    const documentFolder = library.folders.find((folder) => folder.name === '云文档')!

    expect(library.resources.filter((resource) => resource.folderId === documentFolder.id)).toEqual([])
  })

  it('places persisted trashed documents in a recycle bin after design attachments', () => {
    const trashed = {
      ...backendDocument('gateway-doc-trash', '已删除文档'),
      deletedAt: '2026-08-15T12:00:00.000Z',
    }
    const library = createContextRoomResourceLibrary(room, [], [trashed])

    expect(library.folders.map((folder) => folder.name)).toEqual([
      '云文档',
      'Office 文件',
      '设计与附件',
      '回收站',
    ])
    const trashFolder = library.folders.at(-1)!
    expect(library.resources).toContainEqual(expect.objectContaining({
      folderId: trashFolder.id,
      name: '已删除文档',
      trashed: true,
      binding: expect.objectContaining({ docId: 'gateway-doc-trash' }),
    }))
  })
})

describe('Context Room knowledge file merge into cloud document folder', () => {
  it('merges knowledge uploaded files alongside cloud documents', () => {
    const document = backendDocument('gateway-doc-1', '真实文档')
    const file = knowledgeFile('file-abc', '笔记.md')
    const library = createContextRoomResourceLibrary(room, [document], [], [file])
    const documentFolder = library.folders.find((folder) => folder.name === '云文档')!

    const cloudResources = library.resources.filter((resource) => resource.folderId === documentFolder.id)
    expect(cloudResources).toHaveLength(2)
    const knowledgeResource = cloudResources.find((resource) => resource.kind === 'knowledge-file')
    expect(knowledgeResource).toMatchObject({
      id: `${room.id}:kfile:file-abc`,
      roomId: room.id,
      folderId: documentFolder.id,
      name: '笔记.md',
      fileId: 'file-abc',
      originalName: '笔记.md',
      bytes: 2048,
      statusLabel: '已沉淀',
      sizeLabel: '2.0 KB',
    })
  })

  it('keeps existing three-argument calls free of knowledge files (default parameter)', () => {
    const library = createContextRoomResourceLibrary(room, [backendDocument('gateway-doc-1', '真实文档')])
    expect(library.resources.filter((resource) => resource.kind === 'knowledge-file')).toEqual([])
  })

  it('namespaces resource ids so cloud docs and knowledge files never collide', () => {
    const document = backendDocument('file-abc', '同名标题')
    const file = knowledgeFile('file-abc', '同名标题.md')
    const library = createContextRoomResourceLibrary(room, [document], [], [file])
    const ids = library.resources.map((resource) => resource.id)
    expect(ids).toContain(`${room.id}:cloud:file-abc`)
    expect(ids).toContain(`${room.id}:kfile:file-abc`)
  })

  it('never routes knowledge files into the trash folder', () => {
    const trashed = {
      ...backendDocument('gateway-doc-trash', '已删除文档'),
      deletedAt: '2026-08-15T12:00:00.000Z',
    }
    const library = createContextRoomResourceLibrary(room, [], [trashed], [knowledgeFile('file-abc', '笔记.md')])
    const trashFolder = library.folders.find((folder) => folder.name === '回收站')!
    const trashIds = library.resources.filter((resource) => resource.folderId === trashFolder.id).map((resource) => resource.id)
    expect(trashIds).toEqual([`${room.id}:trash:gateway-doc-trash`])
  })

  it('derives status labels and size labels from decision state', () => {
    expect(knowledgeFileStatusLabel({ status: 'confirmed', decidedBy: 'entry' })).toBe('已沉淀')
    expect(knowledgeFileStatusLabel({ status: 'auto', decidedBy: null })).toBe('归类中')
    expect(knowledgeFileStatusLabel({ status: 'auto', decidedBy: 'user' })).toBe('用户确认·入库中')
    expect(knowledgeFileStatusLabel({ status: 'reverted', decidedBy: null })).toBe('已撤销')
    expect(knowledgeFileStatusLabel({ status: 'pending', decidedBy: null })).toBe('处理中')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('Context Room knowledge file foldering by file type', () => {
  it('routes office-type uploads (docx/xlsx/pptx/pdf/csv) to the Office folder, not cloud documents', () => {
    const files = [
      knowledgeFile('file-docx', '编程学习文档.docx'),
      knowledgeFile('file-xlsx', '预算表.xlsx'),
      knowledgeFile('file-pptx', '季度汇报.pptx'),
      knowledgeFile('file-pdf', '编程语言学习文档.pdf'),
      knowledgeFile('file-csv', '数据.csv'),
    ]
    const library = createContextRoomResourceLibrary(room, [], [], files)
    const officeFolder = library.folders.find((folder) => folder.name === 'Office 文件')!
    const documentsFolder = library.folders.find((folder) => folder.name === '云文档')!

    const officeNames = library.resources
      .filter((resource) => resource.folderId === officeFolder.id)
      .map((resource) => resource.name)
    expect(officeNames).toEqual(['编程学习文档.docx', '预算表.xlsx', '季度汇报.pptx', '编程语言学习文档.pdf', '数据.csv'])
    expect(library.resources.some((resource) => resource.folderId === documentsFolder.id)).toBe(false)
  })

  it('keeps md in cloud documents and routes images to design attachments', () => {
    const files = [
      knowledgeFile('file-md', '笔记.md'),
      knowledgeFile('file-md-upper', 'NOTES.MARKDOWN'),
      knowledgeFile('file-png', '设计稿.png'),
    ]
    const library = createContextRoomResourceLibrary(room, [], [], files)
    const folderIdOf = (name: string) =>
      library.folders.find((folder) => folder.name === name)!.id
    const folderOf = (fileId: string) =>
      library.resources.find((resource) => resource.id === `${room.id}:kfile:${fileId}`)!.folderId

    expect(folderOf('file-md')).toBe(folderIdOf('云文档'))
    expect(folderOf('file-md-upper')).toBe(folderIdOf('云文档'))
    expect(folderOf('file-png')).toBe(folderIdOf('设计与附件'))
  })
})

describe('Context Room document focus requests', () => {
  it('does not override a manual document switch with an already handled Agent focus', () => {
    const firstFocus = consumeDocumentFocusRequest(null, 'room-a', 'document-a', true)
    expect(firstFocus.shouldOpen).toBe(true)

    const afterManualSwitch = consumeDocumentFocusRequest(
      firstFocus.handledKey,
      'room-a',
      'document-a',
      true,
    )
    expect(afterManualSwitch.shouldOpen).toBe(false)
  })

  it('waits for the focused document to load and accepts the same document after reset', () => {
    const beforeListLoads = consumeDocumentFocusRequest(null, 'room-a', 'document-a', false)
    expect(beforeListLoads).toEqual({ handledKey: null, shouldOpen: false })

    const afterListLoads = consumeDocumentFocusRequest(
      beforeListLoads.handledKey,
      'room-a',
      'document-a',
      true,
    )
    expect(afterListLoads.shouldOpen).toBe(true)

    const cleared = consumeDocumentFocusRequest(afterListLoads.handledKey, 'room-a', null, false)
    const nextAgentOpen = consumeDocumentFocusRequest(
      cleared.handledKey,
      'room-a',
      'document-a',
      true,
    )
    expect(nextAgentOpen.shouldOpen).toBe(true)
  })

  it('treats repeated navigation to the same document as a new request', () => {
    const first = consumeDocumentFocusRequest(null, 'room-a', 'document-a', true, 1)
    expect(first.shouldOpen).toBe(true)

    const alreadyHandled = consumeDocumentFocusRequest(
      first.handledKey,
      'room-a',
      'document-a',
      true,
      1,
    )
    expect(alreadyHandled.shouldOpen).toBe(false)

    const repeatedClick = consumeDocumentFocusRequest(
      alreadyHandled.handledKey,
      'room-a',
      'document-a',
      true,
      2,
    )
    expect(repeatedClick.shouldOpen).toBe(true)
  })
})
