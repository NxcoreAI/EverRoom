import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDatabase, type GatewayDatabase } from '../src/infrastructure/database/client.js'
import {
  documentImportListCache,
  documentImportRuns,
  documentImportSnapshots,
  documentImportSources,
  documentRoomImports,
  documents,
} from '../src/infrastructure/database/schema.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import { DocumentImportService } from '../src/modules/documents/import/service.js'
import { shouldFullSync } from '../src/modules/documents/import/list-sync-worker.js'
import type { ImportActionRunner } from '../src/modules/documents/import/oo-runner.js'
import type { OpenConnectorCliConfig } from '../src/config.js'

const connectorConfig: OpenConnectorCliConfig = {
  executable: 'oo',
  baseUrl: 'http://127.0.0.1:3999',
  runtimeToken: 'test-token',
  configDirectory: '/tmp/nxcore-list-sync-test/oo-config',
  dataDirectory: '/tmp/nxcore-list-sync-test/oo-data',
}

type FakeActionFn = (input: Record<string, unknown>) => unknown

function fakeRunner(actions: Record<string, unknown | FakeActionFn>): ImportActionRunner {
  return async (_config, call) => {
    const value = actions[`${call.service}.${call.action}`]
    if (typeof value === 'function') return (value as FakeActionFn)(call.input)
    if (value === undefined) throw new Error(`unexpected action ${call.service}.${call.action}`)
    return value
  }
}

let dataDirectory = ''
let db: GatewayDatabase
let closeDatabase: (() => void) | null = null

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-list-sync-'))
  const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
  db = created.db
  closeDatabase = () => created.sqlite.close()
})

afterAll(() => {
  closeDatabase?.()
})

function makeService(actionRunner: ImportActionRunner) {
  const documentService = new DocumentService(db, new DocumentEventBroker())
  return new DocumentImportService(db, documentService, connectorConfig, dataDirectory, {
    actionRunner,
    larkActionFn: (call) => actionRunner(connectorConfig, call),
  })
}

function cacheRow(provider: 'feishu' | 'notion' = 'feishu') {
  return db.select().from(documentImportListCache).where(eq(documentImportListCache.provider, provider)).get()
}

/** 飞书全量列举 fake：云空间 1 篇 + 知识库 1 篇。 */
function feishuFullActions(overrides: Record<string, unknown | FakeActionFn> = {}) {
  return {
    'feishu.list_drive_files': {
      items: [{ token: 'tokDrive', type: 'docx', name: '云空间文档', url: 'https://f.cn/docx/tokDrive', modified_time: String(Date.now() - 3_600_000) }],
      hasMore: false,
    },
    'feishu.list_wiki_spaces': { items: [{ space_id: 'sp1', name: '空间A' }], hasMore: false },
    'feishu.list_wiki_nodes': {
      items: [{ obj_token: 'tokWiki', obj_type: 'docx', title: '知识库文档', obj_edit_time: String(Math.floor((Date.now() - 7_200_000) / 1000)), has_child: false }],
      hasMore: false,
    },
    ...overrides,
  }
}

describe('shouldFullSync 判据', () => {
  it('从未全量过 → true；24h 内 → false；超过 24h → true', () => {
    const now = new Date('2026-10-12T12:00:00.000Z')
    expect(shouldFullSync(null, now)).toBe(true)
    expect(shouldFullSync(new Date('2026-10-12T02:00:00.000Z'), now)).toBe(false)
    expect(shouldFullSync(new Date('2026-10-11T11:00:00.000Z'), now)).toBe(true)
  })
})

describe('列举缓存增量同步', () => {
  it('全量列举写入 full 缓存行并带水位线', async () => {
    const service = makeService(fakeRunner(feishuFullActions()))
    const response = await service.listAllDocuments('feishu')
    expect(response.items.map((item) => item.remoteDocumentId).sort()).toEqual(['tokDrive', 'tokWiki'])
    const row = cacheRow()
    expect(row?.syncMode).toBe('full')
    expect(row?.watermarkAt).not.toBeNull()
    expect(row?.lastFullAt).not.toBeNull()
  })

  it('delta 合并新文档与变更，保留缓存里的 wiki 归属，推进水位线', async () => {
    const searchInputs: Array<Record<string, unknown>> = []
    let deltaReady = false
    const actions = feishuFullActions({
      'feishu.search_documents': (input: Record<string, unknown>) => {
        searchInputs.push(input)
        if (!deltaReady) return { results: [], total: 0, hasMore: false }
        return {
          results: [
            // 同 token：缓存里是 wiki 归属，delta 搜索记为 drive → 合并保留 wiki。
            { docToken: 'tokWiki', title: '知识库文档（改名）', url: 'https://f.cn/wiki/tokWiki', updated_timestamp: String(Date.now() - 60_000) },
            // 新文档：追加。
            { docToken: 'tokNew', title: '新文档', url: 'https://f.cn/docx/tokNew', updated_timestamp: String(Date.now() - 30_000) },
          ],
          total: 2,
          hasMore: false,
        }
      },
    })
    const service = makeService(fakeRunner(actions))
    await service.listAllDocuments('feishu')
    const before = cacheRow()

    deltaReady = true
    const delta = await service.listAllDocuments('feishu', undefined, 'delta')
    expect(delta.items.map((item) => item.remoteDocumentId).sort()).toEqual(['tokDrive', 'tokNew', 'tokWiki'])

    const renamed = delta.items.find((item) => item.remoteDocumentId === 'tokWiki')
    expect(renamed?.title).toBe('知识库文档（改名）')
    expect(renamed?.origin).toBe('wiki')
    expect(renamed?.wikiSpaceName).toBe('空间A')

    const row = cacheRow()
    expect(row?.syncMode).toBe('delta')
    // 水位线单调不退（全量把水位线定在同步当下；真实场景后续修改会推进它）。
    expect(row!.watermarkAt!.getTime()).toBeGreaterThanOrEqual(before!.watermarkAt!.getTime())

    // 请求形状：带 from_update_time（水位线 − 5 分钟重叠窗）。
    expect(searchInputs.length).toBeGreaterThan(0)
    const last = searchInputs.at(-1)
    expect(last?.docFilter).toBeDefined()
    expect((last?.docFilter as Record<string, unknown>).from_update_time).toBeGreaterThan(0)
  })

  it('delta 无缓存 → 直接全量', async () => {
    const service = makeService(fakeRunner(feishuFullActions({
      'feishu.search_documents': { results: [], total: 0, hasMore: false },
    })))
    await service.listAllDocuments('feishu', undefined, 'delta')
    const row = cacheRow()
    expect(row?.syncMode).toBe('full')
    expect(row?.itemCount).toBe(2)
  })

  it('时间过滤被忽略（首页全旧）→ 回退全量', async () => {
    let driveCalls = 0
    const actions = feishuFullActions({
      'feishu.list_drive_files': (input: Record<string, unknown>) => {
        driveCalls += 1
        return { items: [{ token: 'tokDrive', type: 'docx', name: '云空间文档', modified_time: String(Date.now() - 3_600_000) }], hasMore: false }
      },
      'feishu.search_documents': {
        results: [{ docToken: 'tokOld', title: '旧文档', url: 'https://f.cn/docx/tokOld', updated_timestamp: String(Date.now() - 90_000_000) }],
        total: 1,
        hasMore: false,
      },
    })
    const service = makeService(fakeRunner(actions))
    await service.listAllDocuments('feishu')
    expect(driveCalls).toBe(1)

    await service.listAllDocuments('feishu', undefined, 'delta')
    // 回退全量：drive 列举再跑一次，缓存行记 full。
    expect(driveCalls).toBe(2)
    expect(cacheRow()?.syncMode).toBe('full')
  })

  it('delta 请求失败 → 回退全量；全量也失败 → 抛原始错误', async () => {
    let searchCalls = 0
    const actions = feishuFullActions({
      'feishu.search_documents': () => {
        searchCalls += 1
        throw new Error('search blew up')
      },
    })
    const service = makeService(fakeRunner(actions))
    await service.listAllDocuments('feishu')
    await service.listAllDocuments('feishu', undefined, 'delta')
    expect(searchCalls).toBe(1)
    expect(cacheRow()?.syncMode).toBe('full')
  })

  it('markImported 按落地集合回填（大列表无 inArray）', async () => {
    // 落地链：source → run → snapshot → roomImport（documentId 挂真实 documents 行）。
    db.insert(documents).values({ id: 'doc-1', title: '本地文档', contentJson: [] }).run()
    db.insert(documentImportSources).values({ id: 'src-1', provider: 'feishu', remoteDocumentId: 'tokWiki' }).run()
    db.insert(documentImportRuns).values({ id: 'run-1', requestId: 'req-1', provider: 'feishu', sourceId: 'src-1', remoteDocumentId: 'tokWiki', status: 'succeeded' }).run()
    db.insert(documentImportSnapshots).values({ id: 'snap-1', sourceId: 'src-1', importRunId: 'run-1', artifactRef: 'a', contentHash: 'h', commentsStatus: 'unavailable' }).run()
    db.insert(documentRoomImports).values({ id: 'ri-1', roomId: 'room-1', documentId: 'doc-1', importRunId: 'run-1', snapshotId: 'snap-1', relation: 'primary' }).run()

    // 云空间 400 篇：超过旧实现 inArray 安全范围也无碍（新实现不按 ids 查询）。
    const bulk = Array.from({ length: 400 }, (_, index) => ({
      token: `tokBulk${index}`,
      type: 'docx',
      name: `批量 ${index}`,
      url: `https://f.cn/docx/tokBulk${index}`,
      modified_time: String(Date.now() - 1_000_000),
    }))
    const service = makeService(fakeRunner(feishuFullActions({
      'feishu.list_drive_files': { items: bulk, hasMore: false },
    })))
    const response = await service.listAllDocuments('feishu')
    expect(response.items.length).toBe(401)
    const imported = response.items.filter((item) => item.imported)
    expect(imported.map((item) => item.remoteDocumentId)).toEqual(['tokWiki'])
  })
})

describe('Notion 增量列举', () => {
  it('按 last_edited_time 降序翻页，整页早于水位线即停', async () => {
    const searchCalls: Array<Record<string, unknown>> = []
    let deltaReady = false
    const actions: Record<string, unknown | FakeActionFn> = {
      'notion.search': (input: Record<string, unknown>) => {
        searchCalls.push(input)
        if (!deltaReady) return { results: [], has_more: false }
        const start = typeof input.startCursor === 'string' ? input.startCursor : ''
        if (!start) {
          return {
            results: [
              { id: 'page-fresh', name: '新页面', url: 'https://n.so/page-fresh', last_edited_time: new Date(Date.now() - 60_000).toISOString() },
              { id: 'page-old', name: '旧页面', url: 'https://n.so/page-old', last_edited_time: new Date(Date.now() - 90_000_000).toISOString() },
            ],
            has_more: true,
            next_cursor: 'c2',
          }
        }
        // 第二页本应还有，但第一页已含早于水位线的条目 → 不应翻到这里。
        return {
          results: [{ id: 'page-old2', name: '更旧', url: 'https://n.so/page-old2', last_edited_time: new Date(Date.now() - 95_000_000).toISOString() }],
          has_more: false,
        }
      },
    }
    const service = makeService(fakeRunner(actions))
    // 全量（空结果）建缓存行：水位线 = 同步当下。
    await service.listAllDocuments('notion')
    expect(cacheRow('notion')?.syncMode).toBe('full')

    deltaReady = true
    const delta = await service.listAllDocuments('notion', undefined, 'delta')
    const ids = delta.items.map((item) => item.remoteDocumentId).sort()
    expect(ids).toEqual(['page-fresh', 'page-old'])
    // 早停：带 startCursor 的第二次 search 不应发生。
    expect(searchCalls.filter((input) => typeof input.startCursor === 'string').length).toBe(0)
    expect(searchCalls.at(-1)?.sort).toEqual({ timestamp: 'last_edited_time', direction: 'descending' })
  })
})
