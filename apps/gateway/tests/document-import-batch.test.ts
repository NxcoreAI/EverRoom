import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type GatewayDatabase } from '../src/infrastructure/database/client.js'
import { documentRoomImports, rooms } from '../src/infrastructure/database/schema.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import {
  DocumentImportService,
} from '../src/modules/documents/import/service.js'
import {
  DocumentBatchImportService,
  type BatchRoomRosterEntry,
  type CreateBatchImportInput,
  type DocumentBatchImportPorts,
  type ImportClassifierVerdict,
} from '../src/modules/documents/import/batch-service.js'
import type { ImportActionRunner } from '../src/modules/documents/import/oo-runner.js'
import { ImportConnectorError } from '../src/modules/documents/import/oo-runner.js'
import type { OpenConnectorCliConfig } from '../src/config.js'

const connectorConfig: OpenConnectorCliConfig = {
  executable: 'oo',
  baseUrl: 'http://127.0.0.1:3999',
  runtimeToken: 'test-token',
  configDirectory: '/tmp/nxcore-batch-test/oo-config',
  dataDirectory: '/tmp/nxcore-batch-test/oo-data',
}

/** 形状对齐运行时封套解包后的执行器输出（service 注入点在 actionRunner 层）。 */
type FakeActionFn = (input: Record<string, unknown>) => unknown
type FakeAction = Record<string, unknown | FakeActionFn>

function fakeRunner(actions: FakeAction): ImportActionRunner {
  return async (_config, call) => {
    const value = actions[`${call.service}.${call.action}`]
    if (typeof value === 'function') return (value as FakeActionFn)(call.input)
    if (value === undefined) throw new Error(`unexpected action ${call.service}.${call.action}`)
    return value
  }
}

/** 正文读取按 documentId 返回唯一内容，保证多篇导入可区分。 */
function feishuReadActions(ids: string[], failIds: Set<string> = new Set()): FakeAction {
  return {
    'feishu.get_document': (input: Record<string, unknown>) => {
      const id = String(input.documentId)
      return { documentId: id, revisionId: 7, title: `文档 ${id}` }
    },
    'feishu.fetch_document': (input: Record<string, unknown>) => {
      const id = String(input.documentId)
      if (failIds.has(id)) throw new Error('feishu_http_500: upstream blew up')
      return {
        document: {
          document_id: id,
          revision_id: 7,
          title: `文档 ${id}`,
          url: `https://vyi-tech.feishu.cn/docx/${id}`,
          content: `# 文档 ${id}\n\n这是 ${id} 的导入正文。`,
        },
      }
    },
    'feishu.list_drive_comments': { items: [], hasMore: false },
    'feishu.search_documents': { results: [], total: 0, hasMore: false },
  }
}

let dataDirectory = ''
let db: GatewayDatabase
let rawDb: { exec: (sql: string) => void; close: () => void } | null = null
let closeDatabase: (() => void) | null = null

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-doc-batch-'))
  const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
  db = created.db
  rawDb = created.sqlite as unknown as { exec: (sql: string) => void; close: () => void }
  closeDatabase = () => created.sqlite.close()
})

afterAll(() => {
  closeDatabase?.()
})

function makeServices(actionRunner: ImportActionRunner, ports?: DocumentBatchImportPorts) {
  const documents = new DocumentService(db, new DocumentEventBroker())
  const imports = new DocumentImportService(db, documents, connectorConfig, dataDirectory, { actionRunner })
  const batch = new DocumentBatchImportService(db, imports, null, ports)
  return { documents, imports, batch }
}

function insertRoom(id: string, title = `Room ${id}`): void {
  db.insert(rooms).values({ id, title }).run()
}

async function waitBatch(batch: DocumentBatchImportService, batchId: string) {
  return vi.waitFor(async () => {
    const view = batch.getBatch(batchId)
    if (view.status === 'running') throw new Error('batch still running')
    return view
  }, { timeout: 5_000, interval: 20 })
}

// ── 全量列举 ────────────────────────────────────────────────────────────────

describe('document-import list', () => {
  it('feishu：云空间目录递归 + docx 过滤 + wiki 空间树（obj_token 为 remoteDocumentId）', async () => {
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB', 'tokW1aaaaaaaaaa', 'tokW2']),
      'feishu.list_drive_files': (input: Record<string, unknown>) => {
        if (!input.folderToken) {
          return {
            items: [
              { token: 'fold1', type: 'folder', name: '子目录' },
              { token: 'tokA', type: 'docx', name: '根目录文档', url: 'https://f.cn/docx/tokA', modified_time: '1788000000', owner_display_name: '张三' },
              { token: 'tokS', type: 'sheet', name: '表格不入列' },
            ],
            hasMore: false,
          }
        }
        return {
          items: [{ token: 'tokB', type: 'docx', name: '子目录文档', url: 'https://f.cn/docx/tokB' }],
          hasMore: false,
        }
      },
      'feishu.list_wiki_spaces': { items: [{ space_id: 'sp1', name: '知识库一' }], hasMore: false },
      'feishu.list_wiki_nodes': (input: Record<string, unknown>) => {
        if (input.parentNodeToken === 'n1') {
          return { items: [{ node_token: 'n2', obj_token: 'tokW2', obj_type: 'docx', title: '子节点文档', has_child: false }], hasMore: false }
        }
        return {
          items: [
            { node_token: 'n1', obj_token: 'tokW1aaaaaaaaaa', obj_type: 'docx', title: '顶层节点', has_child: true },
            { node_token: 'n3', obj_token: 'tokN1', obj_type: 'sheet', title: '表格节点不入列', has_child: false },
          ],
          hasMore: false,
        }
      },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('feishu')
    const byId = new Map(response.items.map((item) => [item.remoteDocumentId, item]))
    expect([...byId.keys()].sort()).toEqual(['tokA', 'tokB', 'tokW1aaaaaaaaaa', 'tokW2'])
    expect(byId.get('tokA')).toMatchObject({ origin: 'drive', ownerName: '张三', sourceUrl: 'https://f.cn/docx/tokA' })
    expect(byId.get('tokW1aaaaaaaaaa')).toMatchObject({ origin: 'wiki', wikiSpaceName: '知识库一' })
    expect(byId.get('tokW2')).toMatchObject({ origin: 'wiki', wikiSpaceName: '知识库一' })
    expect(response.truncated).toBe(false)
  })

  it('云空间列举 403 时降级：搜索兜底列文档 + wiki 树回填归属 + wiki 照常', async () => {
    const seenSearchInputs: Array<Record<string, unknown>> = []
    const actions: FakeAction = {
      'feishu.list_drive_files': () => {
        throw new ImportConnectorError('authentication_required', 'Feishu 99991679: drive:drive:readonly required')
      },
      'feishu.search_documents': (input: Record<string, unknown>) => {
        seenSearchInputs.push(input)
        if (input.pageToken === 'st-2') return { results: [], hasMore: false }
        return {
          results: [
            { title: '云文档甲', type: 'docx', url: 'https://f.cn/docx/tokS1aaaaaaaaaa', owner_name: '张三' },
            { title: '知识库文档（搜索兜底列出）', type: 'docx', url: 'https://f.cn/docx/tokW1aaaaaaaaaa' },
          ],
          total: 2,
          hasMore: true,
          pageToken: 'st-2',
        }
      },
      'feishu.list_wiki_spaces': { items: [{ space_id: 'sp1', name: '知识库一' }], hasMore: false },
      'feishu.list_wiki_nodes': { items: [{ node_token: 'n1', obj_token: 'tokW1aaaaaaaaaa', obj_type: 'docx', title: '知识库文档', has_child: false }], hasMore: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('feishu')
    const byId = new Map(response.items.map((item) => [item.remoteDocumentId, item]))
    // 搜索兜底列出云文档 + wiki 文档；wiki 树把后者回填为知识库归属。
    expect(byId.get('tokS1aaaaaaaaaa')).toMatchObject({ origin: 'drive', ownerName: '张三' })
    expect(byId.get('tokW1aaaaaaaaaa')).toMatchObject({ origin: 'wiki', wikiSpaceName: '知识库一', title: '知识库文档（搜索兜底列出）' })
    // 分页翻页正常。
    expect(seenSearchInputs).toHaveLength(2)
    expect(seenSearchInputs[1]).toMatchObject({ pageToken: 'st-2', query: '' })
    expect(response.warnings.some((warning) => warning.code === 'feishu_drive_listing_degraded')).toBe(true)
  })

  it('feishu：drive 与 wiki 同 token 去重（drive 优先）', async () => {
    const actions: FakeAction = {
      ...feishuReadActions(['tokDup']),
      'feishu.list_drive_files': {
        items: [{ token: 'tokDup', type: 'docx', name: '云空间版本', url: 'https://f.cn/docx/tokDup' }],
        hasMore: false,
      },
      'feishu.list_wiki_spaces': { items: [{ space_id: 'sp1', name: '知识库' }], hasMore: false },
      'feishu.list_wiki_nodes': {
        items: [{ node_token: 'n1', obj_token: 'tokDup', obj_type: 'docx', title: 'wiki 版本', has_child: false }],
        hasMore: false,
      },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('feishu')
    expect(response.items).toHaveLength(1)
    expect(response.items[0]).toMatchObject({ origin: 'drive', title: '云空间版本' })
  })

  it('feishu：知识库空间超过上限置 truncated 并警告', async () => {
    const manySpaces = Array.from({ length: 13 }, (_value, index) => ({ space_id: `sp${index}`, name: `空间${index}` }))
    const actions: FakeAction = {
      'feishu.list_drive_files': { items: [], hasMore: false },
      'feishu.list_wiki_spaces': { items: manySpaces, hasMore: false },
      'feishu.list_wiki_nodes': { items: [], hasMore: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('feishu')
    expect(response.truncated).toBe(true)
    expect(response.warnings.some((warning) => warning.code === 'list_truncated')).toBe(true)
  })

  it('notion：空 query 全量翻页（next_cursor 带出第二页）并给空范围提示', async () => {
    const seenInputs: Array<Record<string, unknown>> = []
    const actions: FakeAction = {
      'notion.search': (input: Record<string, unknown>) => {
        seenInputs.push(input)
        if (input.startCursor) {
          return {
            object: 'list',
            results: [{ id: 'page2', url: 'https://notion.so/page2', properties: { title: { title: [{ text: { content: '页面二' } }] } }, last_edited_time: '2026-09-02T00:00:00.000Z' }],
            next_cursor: null,
            has_more: false,
          }
        }
        return {
          object: 'list',
          results: [{ id: 'page1', url: 'https://notion.so/page1', properties: { title: { title: [{ text: { content: '页面一' } }] } }, last_edited_time: '2026-09-01T00:00:00.000Z' }],
          next_cursor: 'cursor-2',
          has_more: true,
        }
      },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('notion')
    expect(response.items.map((item) => item.remoteDocumentId)).toEqual(['page1', 'page2'])
    expect(response.items.every((item) => item.origin === 'page')).toBe(true)
    expect(seenInputs[1]).toMatchObject({ startCursor: 'cursor-2', query: '' })
    expect(response.truncated).toBe(false)
  })

  it('notion：无任何可见页面时给出共享范围提示', async () => {
    const actions: FakeAction = {
      'notion.search': { object: 'list', results: [], next_cursor: null, has_more: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('notion')
    expect(response.items).toHaveLength(0)
    expect(response.warnings.some((warning) => warning.code === 'list_empty_scope_hint')).toBe(true)
  })

  it('imported 标记：已 preview+commit 的来源置 true', async () => {
    insertRoom('room-list')
    const ids = ['tokA', 'tokB']
    const actions: FakeAction = {
      ...feishuReadActions(ids),
      'feishu.list_drive_files': {
        items: ids.map((id) => ({ token: id, type: 'docx', name: `文档 ${id}` })),
        hasMore: false,
      },
      'feishu.list_wiki_spaces': { items: [], hasMore: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const preview = await imports.preview('feishu', 'tokA')
    await imports.commitToRoom({ runId: preview.runId, roomId: 'room-list' })
    const response = await imports.listAllDocuments('feishu')
    const byId = new Map(response.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokA')?.imported).toBe(true)
    expect(byId.get('tokB')?.imported).toBe(false)
  })

  it('列举缓存：首次拉取落缓存，缓存回显带 fetchedAt 且 imported 标记按当前库重算', async () => {
    insertRoom('room-cache')
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB']),
      'feishu.list_drive_files': {
        items: [
          { token: 'tokA', type: 'docx', name: '文档甲' },
          { token: 'tokB', type: 'docx', name: '文档乙' },
        ],
        hasMore: false,
      },
      'feishu.list_wiki_spaces': { items: [], hasMore: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    // 无缓存时 getCachedList 返回 null。
    expect(imports.getCachedList('feishu')).toBeNull()
    // 首次拉取：实时结果 fetchedAt=null，同时落缓存。
    const fresh = await imports.listAllDocuments('feishu')
    expect(fresh.fetchedAt).toBeNull()
    // 缓存命中：同 items + fetchedAt 时间戳。
    const cached = imports.getCachedList('feishu')
    expect(cached).not.toBeNull()
    expect(cached!.items.map((item) => item.remoteDocumentId)).toEqual(['tokA', 'tokB'])
    expect(cached!.fetchedAt).toBeTruthy()
    expect(cached!.items.every((item) => !item.imported)).toBe(true)
    // 缓存之后导入 tokA：不重拉，缓存回显的 imported 标记应翻新。
    const preview = await imports.preview('feishu', 'tokA')
    await imports.commitToRoom({ runId: preview.runId, roomId: 'room-cache' })
    const refreshed = imports.getCachedList('feishu')!
    const byId = new Map(refreshed.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokA')?.imported).toBe(true)
    expect(byId.get('tokB')?.imported).toBe(false)
    // 连接维度隔离：另一连接名的缓存为空。
    expect(imports.getCachedList('feishu', 'other-conn')).toBeNull()
  })
})

// ── 批量导入（room 模式 + M1 守卫）──────────────────────────────────────────

describe('document-import batch (room mode)', () => {
  it('逐篇 preview+commit：3 篇全部落 Room', async () => {
    insertRoom('room-batch')
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB', 'tokC'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'room',
      roomId: 'room-batch',
    })
    expect(created.total).toBe(3)
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('completed')
    expect(view.succeeded).toBe(3)
    expect(view.failed).toBe(0)
    expect(view.items.every((item) => item.status === 'imported' && item.roomId === 'room-batch' && item.documentId)).toBe(true)
    const roomImports = db.select().from(documentRoomImports).all()
    expect(roomImports).toHaveLength(3)
  })

  it('中篇失败不中断：失败项记录 error，其余导入完成', async () => {
    insertRoom('room-batch')
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB', 'tokC'], new Set(['tokB']))))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'room',
      roomId: 'room-batch',
    })
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('completed')
    expect(view.succeeded).toBe(2)
    expect(view.failed).toBe(1)
    const failed = view.items.find((item) => item.remoteDocumentId === 'tokB')
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('feishu_http_500')
  })

  it('取消：处理中取消后剩余项 skipped，批状态 cancelled', async () => {
    insertRoom('room-cancel')
    let batchIdHolder: string | null = null
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB', 'tokC']),
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        // 处理到第二篇时发起取消：第三篇应在下一轮检查点被跳过。
        if (id === 'tokB') void Promise.resolve().then(() => {
          if (batchIdHolder) void Promise.resolve(batch.cancelBatch(batchIdHolder))
        })
        return {
          document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n正文。` },
        }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'room',
      roomId: 'room-cancel',
    })
    batchIdHolder = created.batchId
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('cancelled')
    const byId = new Map(view.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokA')?.status).toBe('imported')
    expect(byId.get('tokB')?.status).toBe('imported')
    expect(byId.get('tokC')?.status).toBe('skipped')
  })

  it('连接级失败短路整批：出错项 failed，其后 skipped，批状态 failed', async () => {
    insertRoom('room-short')
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB', 'tokC']),
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        if (id !== 'tokA') {
          throw new ImportConnectorError('authentication_required', 'token expired')
        }
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, content: `# ${id}` } }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'room',
      roomId: 'room-short',
    })
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('failed')
    expect(view.errorCode).toBe('IMPORT_CONNECTION_REQUIRED')
    const byId = new Map(view.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokA')?.status).toBe('imported')
    expect(byId.get('tokB')?.status).toBe('failed')
    expect(byId.get('tokC')?.status).toBe('skipped')
  })

  it('入口校验：空列表/超上限/缺 roomId/Room 不存在/auto 未就绪', async () => {
    insertRoom('room-real')
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    await expect(batch.createBatch({ provider: 'feishu', remoteDocumentIds: [], mode: 'room', roomId: 'room-real' }))
      .rejects.toMatchObject({ code: 'BATCH_EMPTY' })
    await expect(batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: Array.from({ length: 51 }, (_value, index) => `tok${index}`),
      mode: 'room',
      roomId: 'room-real',
    })).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' })
    await expect(batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room' }))
      .rejects.toMatchObject({ code: 'BATCH_ROOM_REQUIRED' })
    await expect(batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room', roomId: 'room-missing' }))
      .rejects.toMatchObject({ code: 'BATCH_ROOM_NOT_FOUND' })
    await expect(batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' }))
      .rejects.toMatchObject({ code: 'BATCH_AUTO_UNAVAILABLE' })
  })

  it('recoverInterrupted：遗留 running 批置 failed 且 pending 项 skipped', async () => {
    insertRoom('room-recover')
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
      roomId: 'room-recover',
    })
    await waitBatch(batch, created.batchId)
    // 手工造一行 running 残留，模拟进程死亡。
    rawDb!.exec("INSERT INTO document_import_batches (id, request_id, provider, mode, status, total, items_json, created_at, updated_at) VALUES ('batch-stuck', 'req-stuck', 'feishu', 'room', 'running', 2, '[{\"remoteDocumentId\":\"x\",\"title\":null,\"status\":\"pending\",\"roomId\":null,\"documentId\":null,\"importRunId\":null,\"error\":null},{\"remoteDocumentId\":\"y\",\"title\":null,\"status\":\"imported\",\"roomId\":\"r\",\"documentId\":\"d\",\"importRunId\":null,\"error\":null}]', strftime('%s','now')*1000, strftime('%s','now')*1000)")
    const recovered = batch.recoverInterrupted()
    expect(recovered).toBe(1)
    const view = batch.getBatch('batch-stuck')
    expect(view.status).toBe('failed')
    expect(view.errorCode).toBe('BATCH_INTERRUPTED')
    expect(view.items[0]?.status).toBe('skipped')
    expect(view.items[1]?.status).toBe('imported')
  })

  it('existingInRoom 只报该 Room 已落 primary 的来源；forceNew 跳过去重一律新建', async () => {
    insertRoom('room-exist')
    insertRoom('room-other')
    // 可变内容：第二批前改 tokA 内容，避免被无变化守卫拦下（内容相同→noChange 不落候选）。
    const contentOf: Record<string, string> = {
      tokA: '# 文档 tokA\n\n这是 tokA 的导入正文。',
      tokB: '# 文档 tokB\n\n这是 tokB 的导入正文。',
    }
    const actions: FakeAction = {
      'feishu.get_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { documentId: id, revisionId: 7, title: `文档 ${id}` }
      },
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: contentOf[id] ?? '' } }
      },
      'feishu.list_drive_comments': { items: [], hasMore: false },
    }
    const { imports, batch } = makeServices(fakeRunner(actions))
    const first = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB'],
      mode: 'room',
      roomId: 'room-other',
    })
    expect((await waitBatch(batch, first.batchId)).status).toBe('completed')
    // 跨 Room 隔离：room-exist 没导过为空；room-other 两篇都在。
    expect(imports.existingInRoom('feishu', 'room-exist', ['tokA', 'tokB'])).toEqual([])
    expect(new Set(imports.existingInRoom('feishu', 'room-other', ['tokA', 'tokB'])))
      .toEqual(new Set(['tokA', 'tokB']))
    // 内容变化后默认重导：转候选。
    contentOf.tokA = '# 文档 tokA\n\n这是 tokA 的导入正文。（远端已修改）'
    const second = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
      roomId: 'room-other',
    })
    expect((await waitBatch(batch, second.batchId)).status).toBe('completed')
    expect(db.select().from(documentRoomImports).all().filter((row) => row.relation === 'candidate')).toHaveLength(1)
    // forceNew=true：同来源仍新建 primary 文档（跳过去重）。
    const third = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
      roomId: 'room-other',
      forceNew: true,
    })
    const thirdView = await waitBatch(batch, third.batchId)
    expect(thirdView.status).toBe('completed')
    const primaries = db.select().from(documentRoomImports).all().filter((row) => row.relation === 'primary')
    expect(primaries).toHaveLength(3)
  })

  it('重复导入同一来源自动转候选版本（方案 §3.1 来源去重）', async () => {
    insertRoom('room-dup-source')
    let bodySuffix = ''
    const actions: FakeAction = {
      ...feishuReadActions(['tokA']),
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n${id} 的导入正文。${bodySuffix}` } }
      },
    }
    const { imports, batch } = makeServices(fakeRunner(actions))
    // 第一次：primary，Room 内新建文档版本 1。
    const first = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
      roomId: 'room-dup-source',
    })
    const firstView = await waitBatch(batch, first.batchId)
    expect(firstView.status).toBe('completed')
    const firstDocumentId = firstView.items[0]!.documentId!
    const firstRoomImports = db.select().from(documentRoomImports).all()
    expect(firstRoomImports).toHaveLength(1)
    expect(firstRoomImports[0]!.relation).toBe('primary')

    // 远端内容变化后，第二次导入同一篇：物化候选（标题带"外部更新候选"），
    // roomImport 指向原目标文档，可在版本面板 diff 后应用。
    bodySuffix = '\n\n远端新增段落。'
    const second = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
      roomId: 'room-dup-source',
    })
    const secondView = await waitBatch(batch, second.batchId)
    expect(secondView.status).toBe('completed')
    const secondRoomImports = db.select().from(documentRoomImports).all()
    expect(secondRoomImports).toHaveLength(2)
    const candidateRow = secondRoomImports.find((row) => row.relation === 'candidate')!
    expect(candidateRow.documentId).toBe(firstDocumentId)
    expect(candidateRow.candidateDocumentId).toBeTruthy()
    expect(candidateRow.importedVersion).toBeNull()
  })

  it('无变化守卫：重复导入内容未变时不落候选（noChange）', async () => {
    insertRoom('room-nochange')
    let bodySuffix = ''
    const actions: FakeAction = {
      ...feishuReadActions(['tokA']),
      'feishu.list_drive_files': { items: [{ token: 'tokA', type: 'docx', name: '文档甲' }], hasMore: false },
      'feishu.list_wiki_spaces': { items: [], hasMore: false },
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, content: `# ${id}\n\n内容。${bodySuffix}` } }
      },
    }
    const { imports, batch } = makeServices(fakeRunner(actions))
    const first = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room', roomId: 'room-nochange' })
    const firstView = await waitBatch(batch, first.batchId)
    expect(firstView.items[0]).toMatchObject({ status: 'imported' })
    expect(db.select().from(documentRoomImports).all()).toHaveLength(1)

    // 内容未变再导：noChange，不新增候选/roomImport，批量项 skipped。
    const second = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room', roomId: 'room-nochange' })
    const secondView = await waitBatch(batch, second.batchId)
    expect(secondView.items[0]).toMatchObject({ status: 'skipped' })
    expect(db.select().from(documentRoomImports).all()).toHaveLength(1)

    // 远端真的变了：正常物化候选。
    bodySuffix = '\n\n新段落。'
    const third = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room', roomId: 'room-nochange' })
    const thirdView = await waitBatch(batch, third.batchId)
    expect(thirdView.items[0]).toMatchObject({ status: 'imported' })
    const rows = db.select().from(documentRoomImports).all()
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.relation === 'candidate')).toHaveLength(1)

    // 应用候选后再查：无变化 → noChange。
    const candidateRow = rows.find((row) => row.relation === 'candidate')!
    await imports.applyCandidate(candidateRow.id)
    const applied = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'room', roomId: 'room-nochange' })
    const appliedView = await waitBatch(batch, applied.batchId)
    expect(appliedView.items[0]).toMatchObject({ status: 'skipped' })
    expect(db.select().from(documentRoomImports).all()).toHaveLength(2)
  })

  it('重复 remoteDocumentIds 去重', async () => {
    insertRoom('room-dedup')
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokA'],
      mode: 'room',
      roomId: 'room-dedup',
    })
    expect(created.total).toBe(1)
  })
})

// ── 批量导入（auto 模式，M2 端口注入）──────────────────────────────────────

describe('document-import batch (auto mode)', () => {
  function autoPorts(options?: {
    verdicts?: Record<string, ImportClassifierVerdict>
    roster?: BatchRoomRosterEntry[]
    incubated?: Array<{ sourceId: string; markdown: string; sourceTag: string }>
  }): DocumentBatchImportPorts {
    const roster = options?.roster ?? [{ id: 'room-alpha', title: 'Alpha 项目', kind: 'project', aliases: [] }]
    return {
      roster: async () => roster,
      classifier: {
        classify: async ({ title }) => options?.verdicts?.[title] ?? { roomId: null, confidence: 0 },
      },
      incubate: async (unit) => {
        options?.incubated?.push({ sourceId: unit.sourceId, markdown: unit.markdown, sourceTag: unit.sourceTag })
      },
    }
  }

  function autoActions(ids: string[]): FakeAction {
    return {
      'feishu.get_document': (input: Record<string, unknown>) => ({ documentId: String(input.documentId), revisionId: 7, title: `文档 ${String(input.documentId)}` }),
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n${id} 的完整正文。` } }
      },
      'feishu.list_drive_comments': { items: [], hasMore: false },
    }
  }

  it('高置信归房：commitToRoom 到判定 Room', async () => {
    insertRoom('room-alpha')
    const incubated: Array<{ sourceId: string; markdown: string; sourceTag: string }> = []
    const { batch } = makeServices(fakeRunner(autoActions(['tokA'])), autoPorts({
      verdicts: { '文档 tokA': { roomId: 'room-alpha', confidence: 0.9 } },
      incubated,
    }))
    const created = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const view = await waitBatch(batch, created.batchId)
    expect(view.items[0]).toMatchObject({ status: 'imported', roomId: 'room-alpha' })
    expect(incubated).toHaveLength(0)
  })

  it('低置信/无匹配：全文投喂孵化（cloud-doc 源 id + sourceTag）', async () => {
    const incubated: Array<{ sourceId: string; markdown: string; sourceTag: string }> = []
    const { batch } = makeServices(fakeRunner(autoActions(['tokB'])), autoPorts({
      verdicts: { '文档 tokB': { roomId: 'room-alpha', confidence: 0.3 } },
      incubated,
    }))
    const created = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokB'], mode: 'auto', connectionName: 'vyi' })
    const view = await waitBatch(batch, created.batchId)
    expect(view.items[0]?.status).toBe('incubated')
    expect(incubated).toHaveLength(1)
    expect(incubated[0]).toMatchObject({
      sourceId: 'import:feishu:tokB',
      sourceTag: 'connector:feishu:vyi',
    })
    expect(incubated[0]?.markdown).toContain('tokB 的完整正文')
  })

  it('分类器抛错降级孵化；名册空全部孵化；白名单外 roomId 拒绝归房', async () => {
    const incubated: Array<{ sourceId: string; markdown: string; sourceTag: string }> = []
    const ports: DocumentBatchImportPorts = {
      roster: async () => [{ id: 'room-alpha', title: 'Alpha', kind: 'project', aliases: [] }],
      classifier: {
        classify: async ({ title }) => {
          if (title === '文档 tokA') throw new Error('llm unavailable')
          if (title === '文档 tokB') return { roomId: 'room-hacked', confidence: 0.99 }
          return { roomId: null, confidence: 0 }
        },
      },
      incubate: async (unit) => { incubated.push(unit) },
    }
    const { batch } = makeServices(fakeRunner(autoActions(['tokA', 'tokB', 'tokC'])), ports)
    const created = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA', 'tokB', 'tokC'], mode: 'auto' })
    const view = await waitBatch(batch, created.batchId)
    expect(view.items.map((item) => item.status)).toEqual(['incubated', 'incubated', 'incubated'])
    expect(incubated.map((unit) => unit.sourceId)).toEqual(['import:feishu:tokA', 'import:feishu:tokB', 'import:feishu:tokC'])
  })

  it('roster 为空 → 全部孵化（router 关闭不再拒绝，降级由装配层管线处理）', async () => {
    const incubated: Array<{ sourceId: string; markdown: string; sourceTag: string }> = []
    const { batch } = makeServices(fakeRunner(autoActions(['tokA'])), autoPorts({ roster: [], incubated }))
    const created = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const view = await waitBatch(batch, created.batchId)
    expect(view.items[0]?.status).toBe('incubated')
    expect(incubated).toHaveLength(1)
  })
})

// CreateBatchImportInput 冒烟：类型契约由 agent-contract 提供
describe('createBatch input contract', () => {
  it('accepts provider/connectionName/mode/roomId shape', () => {
    const input: CreateBatchImportInput = { provider: 'notion', remoteDocumentIds: ['p1'], mode: 'room', roomId: 'r1' }
    expect(input.mode).toBe('room')
  })
})
