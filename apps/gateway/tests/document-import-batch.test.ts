import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type GatewayDatabase } from '../src/infrastructure/database/client.js'
import { documentImportRuns, documentRoomImports, documents } from '../src/infrastructure/database/schema.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import {
  DocumentImportService,
} from '../src/modules/documents/import/service.js'
import {
  DocumentBatchImportService,
  type CreateBatchImportInput,
} from '../src/modules/documents/import/batch-service.js'
import { documentImportBatchRoutes } from '../src/modules/documents/import/batch-routes.js'
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

function makeServices(actionRunner: ImportActionRunner) {
  const documents = new DocumentService(db, new DocumentEventBroker())
  // larkActionFn 是飞书换轨 lark-cli 后的测试缝：同一 fake 双注入，
  // 既有断言零改动（feishu 走 larkActionFn，notion 走 actionRunner）。
  const imports = new DocumentImportService(db, documents, connectorConfig, dataDirectory, {
    actionRunner,
    larkActionFn: (call) => actionRunner(connectorConfig, call),
  })
  const batch = new DocumentBatchImportService(db, imports, null)
  return { documents, imports, batch }
}

async function waitBatch(batch: DocumentBatchImportService, batchId: string) {
  return vi.waitFor(async () => {
    const view = batch.getBatch(batchId)
    if (view.status === 'running') throw new Error('batch still running')
    return view
  }, { timeout: 5_000, interval: 20 })
}

// ── 全量列举 ────────────────────────────────────────────────────────────────

describe('飞书 lark-cli 注入隔离', () => {
  it('只注入 larkActionFn（无 oo 连接配置）：feishu 照常列举，notion 仍 OPEN_CONNECTOR_UNAVAILABLE', async () => {
    const documents = new DocumentService(db, new DocumentEventBroker())
    const actionRunner = fakeRunner({
      'feishu.list_drive_files': { items: [{ token: 'tokA', type: 'docx', name: '直连文档', url: 'https://f.cn/docx/tokA' }], hasMore: false },
      'feishu.list_wiki_spaces': { items: [], hasMore: false },
    })
    const imports = new DocumentImportService(db, documents, null, dataDirectory, {
      larkActionFn: (call) => actionRunner(connectorConfig, call),
    })
    const response = await imports.listAllDocuments('feishu')
    expect(response.items.map((item) => item.remoteDocumentId)).toEqual(['tokA'])
    await expect(imports.listAllDocuments('notion')).rejects.toMatchObject({
      code: 'OPEN_CONNECTOR_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('连接器页「关闭飞书」（墓碑）后：lark-cli 导入被拦截，凭据仍在', async () => {
    const documents = new DocumentService(db, new DocumentEventBroker())
    const actionRunner = fakeRunner({
      'feishu.list_drive_files': { items: [], hasMore: false },
      'feishu.list_wiki_spaces': { items: [], hasMore: false },
    })
    let disabled = true
    const imports = new DocumentImportService(db, documents, null, dataDirectory, {
      larkActionFn: (call) => actionRunner(connectorConfig, call),
      isFeishuDisabled: () => disabled,
    })
    await expect(imports.listAllDocuments('feishu')).rejects.toMatchObject({
      code: 'IMPORT_CONNECTION_REQUIRED',
      statusCode: 422,
      message: expect.stringContaining('连接已在连接器页关闭'),
    })

    // 重新开启（移除墓碑）后恢复，lark-cli 凭据不受影响。
    disabled = false
    const response = await imports.listAllDocuments('feishu')
    expect(response.items).toEqual([])
  })
})

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

  it('feishu：知识库空间不再按小上限截断（13 个全列）；仅 1000 安全上限生效', async () => {
    const manySpaces = Array.from({ length: 13 }, (_value, index) => ({ space_id: `sp${index}`, name: `空间${index}` }))
    const actions: FakeAction = {
      'feishu.list_drive_files': { items: [], hasMore: false },
      'feishu.list_wiki_spaces': { items: manySpaces, hasMore: false },
      'feishu.list_wiki_nodes': { items: [], hasMore: false },
    }
    const { imports } = makeServices(fakeRunner(actions))
    const response = await imports.listAllDocuments('feishu')
    expect(response.truncated).toBe(false)
    expect(response.warnings.some((warning) => warning.code === 'list_truncated')).toBe(false)

    const tooMany = Array.from({ length: 1001 }, (_value, index) => ({ space_id: `sp${index}`, name: `空间${index}` }))
    const capped = await makeServices(fakeRunner({
      ...actions,
      'feishu.list_wiki_spaces': { items: tooMany, hasMore: false },
    })).imports.listAllDocuments('feishu')
    expect(capped.truncated).toBe(true)
    expect(capped.warnings.some((warning) => warning.code === 'list_truncated')).toBe(true)
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

// ── 批量导入：工作区文档导入（唯一行为，无归房/孵化端口）─────────────────────

describe('document-import batch (workspace import)', () => {
  it('auto 模式无需分类器/孵化端口：全部落成工作区文稿（roomId=null）', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB', 'tokC'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'auto',
    })
    expect(created.total).toBe(3)
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('completed')
    expect(view.succeeded).toBe(3)
    expect(view.failed).toBe(0)
    expect(view.targetRoomId).toBeNull()
    expect(view.items.every((item) => item.status === 'imported' && item.roomId === null && item.documentId)).toBe(true)
    // 落地产物是工作区文稿：origin=import。
    const landed = db.select().from(documents).all()
    expect(landed).toHaveLength(3)
    expect(landed.every((row) => row.origin === 'import')).toBe(true)
    // 不再写 Room 时代的 document_room_imports。
    expect(db.select().from(documentRoomImports).all()).toHaveLength(0)
    // 每条都追得到成功的 import run，且 run 的目标是工作区文稿。
    const runs = db.select().from(documentImportRuns).all()
    expect(runs).toHaveLength(3)
    expect(runs.every((row) => row.status === 'succeeded' && row.targetDocumentId && row.targetRoomId === null)).toBe(true)
  })

  it('mode=room 与 mode=auto 语义相同：都导入工作区，显式目标不再写库', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'room',
    })
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('completed')
    expect(view.mode).toBe('room')
    expect(view.targetRoomId).toBeNull()
    expect(view.items[0]).toMatchObject({ status: 'imported', roomId: null })
    expect(db.select().from(documentRoomImports).all()).toHaveLength(0)
  })

  it('中篇失败不中断：失败项记录 error，其余导入完成', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB', 'tokC'], new Set(['tokB']))))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokB', 'tokC'],
      mode: 'auto',
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
      mode: 'auto',
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
      mode: 'auto',
    })
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('failed')
    expect(view.errorCode).toBe('IMPORT_CONNECTION_REQUIRED')
    const byId = new Map(view.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokA')?.status).toBe('imported')
    expect(byId.get('tokB')?.status).toBe('failed')
    expect(byId.get('tokC')?.status).toBe('skipped')
  })

  it('getActiveBatch：按 provider+连接名找回进行中批次，跨连接隔离，终态后不再返回', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB']),
      'feishu.fetch_document': async (input: Record<string, unknown>) => {
        await gate
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n正文。` } }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const created = await batch.createBatch({
      provider: 'feishu',
      connectionName: 'vyi',
      remoteDocumentIds: ['tokA', 'tokB'],
      mode: 'auto',
    })
    // 首篇卡在 fetch：批进行中，同 provider+连接名可找回；默认连接/其他连接名找不到。
    expect(batch.getActiveBatch('feishu', 'vyi')?.id).toBe(created.batchId)
    expect(batch.getActiveBatch('feishu')).toBeNull()
    expect(batch.getActiveBatch('feishu', 'other')).toBeNull()
    release!()
    await waitBatch(batch, created.batchId)
    expect(batch.getActiveBatch('feishu', 'vyi')).toBeNull()
  })

  it('入口校验：空列表/超上限（Room 存在性与显式目标已不再校验）', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    await expect(batch.createBatch({ provider: 'feishu', remoteDocumentIds: [], mode: 'auto' }))
      .rejects.toMatchObject({ code: 'BATCH_EMPTY' })
    await expect(batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: Array.from({ length: 51 }, (_value, index) => `tok${index}`),
      mode: 'auto',
    })).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' })
  })

  it('recoverInterrupted：遗留 running 批置 failed 且 pending 项 skipped', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA'],
      mode: 'auto',
    })
    await waitBatch(batch, created.batchId)
    // 手工造一行 running 残留，模拟进程死亡。
    rawDb!.exec("INSERT INTO document_import_batches (id, request_id, provider, mode, status, total, items_json, created_at, updated_at) VALUES ('batch-stuck', 'req-stuck', 'feishu', 'auto', 'running', 2, '[{\"remoteDocumentId\":\"x\",\"title\":null,\"status\":\"pending\",\"roomId\":null,\"documentId\":null,\"importRunId\":null,\"error\":null},{\"remoteDocumentId\":\"y\",\"title\":null,\"status\":\"imported\",\"roomId\":null,\"documentId\":\"d\",\"importRunId\":null,\"error\":null}]', strftime('%s','now')*1000, strftime('%s','now')*1000)")
    const recovered = batch.recoverInterrupted()
    expect(recovered).toBe(1)
    const view = batch.getBatch('batch-stuck')
    expect(view.status).toBe('failed')
    expect(view.errorCode).toBe('BATCH_INTERRUPTED')
    expect(view.items[0]?.status).toBe('skipped')
    expect(view.items[1]?.status).toBe('imported')
  })

  it('重导同一来源：内容未变 → skipped 不落新版本；内容变化 → 同一文稿追加版本', async () => {
    let bodySuffix = ''
    const actions: FakeAction = {
      ...feishuReadActions(['tokA']),
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n${id} 的导入正文。${bodySuffix}` } }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const first = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const firstView = await waitBatch(batch, first.batchId)
    const firstDocumentId = firstView.items[0]!.documentId!
    expect(db.select().from(documents).all()).toHaveLength(1)
    expect(db.select().from(documents).all()[0]!.version).toBe(1)

    // 内容未变再导：noChange → 该篇 skipped，不落新版本、不新增文稿。
    const second = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const secondView = await waitBatch(batch, second.batchId)
    expect(secondView.items[0]).toMatchObject({ status: 'skipped' })
    expect(db.select().from(documents).all()).toHaveLength(1)
    expect(db.select().from(documents).all()[0]!.version).toBe(1)

    // 远端真的变了：同一篇工作区文稿追加版本（不新建文稿）。
    bodySuffix = '\n\n远端新增段落。'
    const third = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const thirdView = await waitBatch(batch, third.batchId)
    expect(thirdView.items[0]).toMatchObject({ status: 'imported', documentId: firstDocumentId })
    const landed = db.select().from(documents).all()
    expect(landed).toHaveLength(1)
    expect(landed[0]!.version).toBe(2)
  })

  it('forceNew 跳过去重与无变化守卫：同来源内容未变也新建一篇', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const first = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    const firstView = await waitBatch(batch, first.batchId)
    const second = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto', forceNew: true })
    const secondView = await waitBatch(batch, second.batchId)
    expect(secondView.items[0]!.status).toBe('imported')
    expect(secondView.items[0]!.documentId).not.toBe(firstView.items[0]!.documentId)
    expect(db.select().from(documents).all()).toHaveLength(2)
  })

  it('importedInWorkspace：只报已落地工作区的来源', async () => {
    const { imports, batch } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB'])))
    expect(imports.importedInWorkspace('feishu', ['tokA', 'tokB'])).toEqual([])
    const created = await batch.createBatch({ provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' })
    expect((await waitBatch(batch, created.batchId)).status).toBe('completed')
    expect(imports.importedInWorkspace('feishu', ['tokA', 'tokB'])).toEqual(['tokA'])
  })

  it('重复 remoteDocumentIds 去重', async () => {
    const { batch } = makeServices(fakeRunner(feishuReadActions(['tokA'])))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokA', 'tokA'],
      mode: 'auto',
    })
    expect(created.total).toBe(1)
  })

  it('空文档落 skipped 不算失败，其余文档照常导入', async () => {
    const actions: FakeAction = {
      ...feishuReadActions(['tokOk']),
      'feishu.get_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return { documentId: id, revisionId: 7, title: id === 'tokEmpty' ? '' : `文档 ${id}`, raw: {} }
      },
      'feishu.fetch_document': (input: Record<string, unknown>) => {
        const id = String(input.documentId)
        return {
          document: {
            document_id: id,
            revision_id: 7,
            title: `文档 ${id}`,
            url: `https://f.cn/docx/${id}`,
            content: id === 'tokEmpty' ? '' : `# 文档 ${id}\n\n正文。`,
          },
        }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const created = await batch.createBatch({
      provider: 'feishu',
      remoteDocumentIds: ['tokEmpty', 'tokOk'],
      mode: 'auto',
    })
    const view = await waitBatch(batch, created.batchId)
    expect(view.status).toBe('completed')
    expect(view.failed).toBe(0)
    const byId = new Map(view.items.map((item) => [item.remoteDocumentId, item]))
    expect(byId.get('tokEmpty')?.status).toBe('skipped')
    expect(byId.get('tokEmpty')?.error).toContain('空文档已跳过')
    expect(byId.get('tokOk')?.status).toBe('imported')
  })
})

// CreateBatchImportInput 冒烟：类型契约由 agent-contract 提供
describe('createBatch input contract', () => {
  it('accepts provider/connectionName/mode/forceNew shape（无 roomId）', () => {
    const input: CreateBatchImportInput = { provider: 'notion', remoteDocumentIds: ['p1'], mode: 'room' }
    expect(input.mode).toBe('room')
  })
})

// ── 批量导入路由：兼容契约（旧版桌面构建发的 mode/roomId 不得 400）─────────────

describe('document-import batch routes (compat contract)', () => {
  it('POST batch：mode=auto 无端口即成功；mode=room+roomId 仍 200 且忽略目标；未知 mode 400', async () => {
    const { batch, imports } = makeServices(fakeRunner(feishuReadActions(['tokA', 'tokB'])))
    const app = Fastify()
    await app.register(documentImportBatchRoutes(batch, imports))
    await app.ready()

    const auto = await app.inject({
      method: 'POST',
      url: '/v1/document-import/batch',
      payload: { provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'auto' },
    })
    expect(auto.statusCode).toBe(200)
    const autoBody = auto.json() as { batchId: string; total: number }
    expect(autoBody.total).toBe(1)
    expect((await waitBatch(batch, autoBody.batchId)).items[0]?.status).toBe('imported')

    const legacy = await app.inject({
      method: 'POST',
      url: '/v1/document-import/batch',
      payload: { provider: 'feishu', remoteDocumentIds: ['tokB'], mode: 'room', roomId: 'room-legacy' },
    })
    expect(legacy.statusCode).toBe(200)
    const legacyView = await waitBatch(batch, (legacy.json() as { batchId: string }).batchId)
    expect(legacyView.targetRoomId).toBeNull()
    expect(legacyView.items[0]).toMatchObject({ status: 'imported', roomId: null })

    const bogus = await app.inject({
      method: 'POST',
      url: '/v1/document-import/batch',
      payload: { provider: 'feishu', remoteDocumentIds: ['tokA'], mode: 'bogus' },
    })
    expect(bogus.statusCode).toBe(400)

    // existing-in-workspace 预检路由：只按工作区已导入集合判定，无房间维度入参。
    const existing = await app.inject({
      method: 'POST',
      url: '/v1/document-import/existing-in-workspace',
      payload: { provider: 'feishu', remoteDocumentIds: ['tokA', 'tokC'] },
    })
    expect(existing.statusCode).toBe(200)
    expect(existing.json()).toMatchObject({ provider: 'feishu', existingRemoteIds: ['tokA'] })

    await app.close()
  })
})
// ── 找回进行中批次（面板重挂载恢复导入进度）──────────────────────────────────

describe('document-import batches/active route', () => {
  it('GET active：返回 running 批完整视图（字段不剥），无进行中/非法 provider 的行为', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const actions: FakeAction = {
      ...feishuReadActions(['tokA', 'tokB']),
      'feishu.fetch_document': async (input: Record<string, unknown>) => {
        await gate
        const id = String(input.documentId)
        return { document: { document_id: id, revision_id: 7, title: `文档 ${id}`, url: `https://f.cn/docx/${id}`, content: `# 文档 ${id}\n\n正文。` } }
      },
    }
    const { batch } = makeServices(fakeRunner(actions))
    const app = Fastify()
    await app.register(documentImportBatchRoutes(batch))
    await app.ready()

    // 无进行中批次：null。
    const idle = await app.inject({ method: 'GET', url: '/v1/document-import/batches/active?provider=feishu' })
    expect(idle.statusCode).toBe(200)
    expect(idle.json()).toBeNull()

    const created = await batch.createBatch({
      provider: 'feishu',
      connectionName: 'vyi',
      remoteDocumentIds: ['tokA', 'tokB'],
      mode: 'auto',
    })
    const running = await app.inject({ method: 'GET', url: `/v1/document-import/batches/active?provider=feishu&connectionName=vyi` })
    expect(running.statusCode).toBe(200)
    expect(running.json()).toMatchObject({ id: created.batchId, provider: 'feishu', connectionName: 'vyi', status: 'running', total: 2, items: [{ remoteDocumentId: 'tokA', status: 'pending' }, { remoteDocumentId: 'tokB', status: 'pending' }] })
    // 响应体含 createdAt/updatedAt 等完整视图字段（fastify 默认序列化不剥）。
    expect(running.json()).toHaveProperty('createdAt')

    // 默认连接查询不带 connectionName：匹配 connection_name IS NULL，vyi 批不可见。
    expect((await app.inject({ method: 'GET', url: '/v1/document-import/batches/active?provider=feishu' })).json()).toBeNull()
    // 非法 provider 400。
    expect((await app.inject({ method: 'GET', url: '/v1/document-import/batches/active?provider=gmail' })).statusCode).toBe(400)

    release!()
    await waitBatch(batch, created.batchId)
    expect((await app.inject({ method: 'GET', url: '/v1/document-import/batches/active?provider=feishu&connectionName=vyi' })).json()).toBeNull()
    await app.close()
  })
})
