import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import { afterEach, describe, expect, it } from 'vitest'

import { createDatabase } from '../src/infrastructure/database/client.js'
import { contextRooms, documentBlockReferences, documents } from '../src/infrastructure/database/schema.js'
import { ContextRoomService } from '../src/modules/context-rooms/service.js'
import {
  bootstrapKnowledgeSpaceDemo,
  KNOWLEDGE_SPACE_FORMATS_DOCUMENT_ID,
  KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
  KNOWLEDGE_SPACE_ROOM_ID,
} from '../src/modules/demo/context-room-demo.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'

const temporaryDirectories: string[] = []
const disposables: Array<() => void> = []

afterEach(async () => {
  disposables.splice(0).forEach((dispose) => dispose())
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-context-room-demo-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  disposables.push(() => database.sqlite.close())
  return {
    ...database,
    documentService: new DocumentService(database.db, new DocumentEventBroker()),
    roomService: new ContextRoomService(database.db),
  }
}

function allNodes(content: TiptapJsonContent): TiptapJsonContent[] {
  return [content, ...(content.content ?? []).flatMap(allNodes)]
}

describe('Knowledge Space starter data', () => {
  it('creates one Room and two editable documents exactly once', async () => {
    const { db, documentService, roomService } = await createHarness()

    await expect(bootstrapKnowledgeSpaceDemo(db, documentService)).resolves.toBe(true)

    expect(roomService.getSnapshot().rooms).toEqual([
      expect.objectContaining({
        id: KNOWLEDGE_SPACE_ROOM_ID,
        title: 'Knowledge Space',
        data: expect.objectContaining({ stats: expect.objectContaining({ docs: 2 }) }),
      }),
    ])
    expect(documentService.list(KNOWLEDGE_SPACE_ROOM_ID)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
        title: 'EverRoom Product & Module Guide',
      }),
      expect.objectContaining({
        id: KNOWLEDGE_SPACE_FORMATS_DOCUMENT_ID,
        title: 'Document Formatting & Tools Showcase',
      }),
    ]))

    const showcase = documentService.get(KNOWLEDGE_SPACE_FORMATS_DOCUMENT_ID)!
    const nodes = allNodes(showcase.contentJson)
    const nodeTypes = new Set(nodes.map((node) => node.type))
    expect(nodeTypes).toEqual(expect.objectContaining(new Set([
      'heading',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'table',
      'image',
      'documentBlockReference',
    ])))
    expect(new Set(nodes.flatMap((node) => node.marks?.map((mark) => mark.type) ?? [])))
      .toEqual(expect.objectContaining(new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link'])))

    const reference = nodes.find((node) => node.type === 'documentBlockReference')
    const overviewBlockIds = new Set(
      documentService.listBlocks(KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID).map((block) => block.blockId),
    )
    expect(reference?.attrs).toMatchObject({
      targetRoomId: KNOWLEDGE_SPACE_ROOM_ID,
      targetDocumentId: KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
    })
    expect(overviewBlockIds.has(String(reference?.attrs?.targetBlockId))).toBe(true)
    expect(db.select().from(documentBlockReferences).all()).toHaveLength(1)

    await expect(bootstrapKnowledgeSpaceDemo(db, documentService)).resolves.toBe(false)
    expect(db.select().from(contextRooms).all()).toHaveLength(1)
    expect(db.select().from(documents).all()).toHaveLength(2)
  })
})
