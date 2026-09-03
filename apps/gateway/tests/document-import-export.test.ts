import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type GatewayDatabase } from '../src/infrastructure/database/client.js'
import {
  agentDocumentExports,
  documentImportComments,
  documentImportRuns,
  documentImportSnapshots,
  documentRoomImports,
} from '../src/infrastructure/database/schema.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import {
  DocumentImportService,
  ImportServiceError,
} from '../src/modules/documents/import/service.js'
import type { ImportActionRunner } from '../src/modules/documents/import/oo-runner.js'
import {
  AgentDocumentExportService,
} from '../src/modules/documents/agent-export/service.js'
import type { OpenConnectorCliConfig } from '../src/config.js'

const connectorConfig: OpenConnectorCliConfig = {
  executable: 'oo',
  baseUrl: 'http://127.0.0.1:3999',
  runtimeToken: 'test-token',
  configDirectory: '/tmp/nxcore-import-test/oo-config',
  dataDirectory: '/tmp/nxcore-import-test/oo-data',
}

type FakeAction = Record<string, unknown>

function fakeRunner(actions: FakeAction, throwers: Record<string, Error> = {}): ImportActionRunner {
  return async (_config, call) => {
    const key = `${call.service}.${call.action}`
    if (throwers[key]) throw throwers[key]
    const result = actions[key]
    if (result === undefined) throw new Error(`unexpected action ${key}`)
    return result
  }
}

const FEISHU_READ: FakeAction = {
  // 形状对齐 OpenConnector feishu 执行器的真实输出（裸透传飞书 API）。
  'feishu.search_documents': {
    results: [{ title: '文档一', type: 'docx', url: 'https://vyi-tech.feishu.cn/docx/tok1' }],
    total: 1,
    hasMore: false,
  },
  'feishu.get_document': { documentId: 'tokA', revisionId: 5, title: '远端需求文档', raw: {} },
  'feishu.fetch_document': {
    document: {
      document_id: 'tokA',
      revision_id: 5,
      title: '远端需求文档',
      url: 'https://vyi-tech.feishu.cn/docx/tokA',
      content: '# 远端需求文档\n\n这是导入的正文段落。\n\n![图](https://img.example.com/a.png)',
    },
  },
  'feishu.list_drive_comments': {
    items: [
      {
        id: 'c1',
        is_solved: false,
        quote: '远端需求文档',
        reply_list: {
          replies: [
            {
              id: 'r1',
              content: { elements: [{ type: 'text', text_run: { text: '第一段评论' } }] },
              user_id: 'ou_zhangsan',
              created_time: '1788000000',
            },
            {
              id: 'r2',
              content: { elements: [{ type: 'text', text_run: { text: '回复评论' } }] },
              user_id: 'ou_lisi',
            },
          ],
        },
      },
    ],
    hasMore: false,
  },
}

const NOTION_READ: FakeAction = {
  'notion.retrieve_page': { title: 'Notion Page', url: 'https://notion.so/abc123', last_edited_time: '2026-09-01T00:00:00.000Z' },
  'notion.retrieve_page_markdown': { markdown: '# Notion Page\n\nnotion 正文' },
  'notion.search': { results: [{ id: 'page1', url: 'https://notion.so/page1', properties: { title: { title: [{ text: { content: '页面一' } }] } } }] },
}

let dataDirectory = ''
let db: GatewayDatabase
let closeDatabase: (() => void) | null = null
const disposables: Array<() => void> = []

async function createHarness(options: {
  connector?: OpenConnectorCliConfig | null
  actionRunner?: ImportActionRunner
  lark?: { executable: string } | null
} = {}) {
  dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-doc-import-'))
  const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
  db = created.db
  closeDatabase = () => created.sqlite.close()
  const documents = new DocumentService(db, new DocumentEventBroker())
  const imports = new DocumentImportService(
    db,
    documents,
    options.connector === undefined ? connectorConfig : options.connector,
    dataDirectory,
    options.actionRunner ? { actionRunner: options.actionRunner } : undefined,
  )
  const exports_ = new AgentDocumentExportService(
    db,
    documents,
    options.connector === undefined ? connectorConfig : options.connector,
    options.lark === undefined ? null : options.lark,
    dataDirectory,
    options.actionRunner ? { actionRunner: options.actionRunner } : undefined,
  )
  return { documents, imports, exports_ }
}

async function createRoomDocument(documents: DocumentService): Promise<{ roomId: string; documentId: string }> {
  const roomId = `room-${Math.random().toString(36).slice(2, 10)}`
  const document = await documents.import({
    id: `doc-${Math.random().toString(36).slice(2, 12)}`,
    roomId,
    title: '本地文档',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '本地正文' }] }] } as never,
  })
  return { roomId, documentId: document.id }
}

async function writeFakeLarkCli(behavior: 'ok' | 'no-app'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nxcore-lark-'))
  const path = join(dir, 'lark-cli')
  const authLine = behavior === 'ok'
    ? `echo '{"ok":true,"appId":"cli_test_app","identities":{"user":{"available":true,"tokenStatus":"valid","userName":"测试用户"}}}'`
    : `echo '{"ok":true,"appId":"","identities":{"user":{"available":false}}}'`
  const script = `#!/bin/bash
case " $* " in
  *" --version "*) echo "lark-cli version 1.0.93-test"; exit 0;;
esac
if [ "$1" = "auth" ]; then
  ${authLine}
  exit 0
fi
if [ "$1" = "docs" ] && [ "$2" = "+fetch" ]; then
  echo '{"ok":true,"data":{"document":{"title":"远端目标文档","revision_id":9,"url":"https://feishu.cn/docx/tokA"}}}'
  exit 0
fi
if [ "$1" = "docs" ] && [ "$2" = "+create" ]; then
  cat >/dev/null
  echo '{"ok":true,"data":{"document":{"document_id":"doccnCreated1","url":"https://feishu.cn/docx/doccnCreated1","revision_id":1}}}'
  exit 0
fi
if [ "$1" = "docs" ] && [ "$2" = "+update" ] && [[ " $* " == *" --command append "* ]]; then
  cat >/dev/null
  echo '{"ok":true,"data":{"document":{"document_id":"tokA","url":"https://feishu.cn/docx/tokA","revision_id":11}}}'
  exit 0
fi
if [ "$1" = "markdown" ] && [ "$2" = "+create" ]; then
  cat >/dev/null
  echo '{"ok":true,"data":{"file":{"file_token":"mdfile0001","url":"https://vyi-tech.feishu.cn/file/mdfile0001"}}}'
  exit 0
fi
if [ "$1" = "docs" ] && [ "$2" = "+update" ]; then
  cat >/dev/null
  echo '{"ok":true,"data":{"document":{"document_id":"tokA","url":"https://feishu.cn/docx/tokA","revision_id":10}}}'
  exit 0
fi
echo '{"ok":false,"error":{"type":"cli","message":"unsupported"}}' >&2
exit 3
`
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  disposables.push(() => undefined)
  return path
}

beforeEach(() => {
  // harness 由各用例自行创建
})

afterEach(() => {
  closeDatabase?.()
  closeDatabase = null
})

afterAll(() => {
  for (const dispose of disposables) dispose()
})

describe('document import service', () => {
  it('search parses feishu results', async () => {
    const { imports } = await createHarness({
      actionRunner: fakeRunner({
        'feishu.search_documents': {
          results: [{ title: '文档一', type: 'docx', url: 'https://vyi-tech.feishu.cn/docx/toksearch0001ABC' }],
        },
      }),
    })
    const response = await imports.search('feishu', '文档')
    expect(response.provider).toBe('feishu')
    expect(response.items).toHaveLength(1)
    expect(response.items[0]!.remoteDocumentId).toBe('toksearch0001ABC')
  })

  it('preview captures snapshot, comments and warnings', async () => {
    const { imports } = await createHarness({ actionRunner: fakeRunner(FEISHU_READ) })
    const preview = await imports.preview('feishu', 'tokA')
    expect(preview.title).toBe('远端需求文档')
    expect(preview.commentsStatus).toBe('complete')
    expect(preview.comments).toHaveLength(2)
    expect(preview.comments[0]!.authorName).toBe('ou_zhangsan')
    expect(preview.comments[0]!.body).toBe('第一段评论')
    expect(preview.comments[0]!.quotedText).toBe('远端需求文档')
    expect(preview.comments[1]!.parentId).toBe('c1')
    expect(preview.warnings.some((warning) => warning.code === 'assets_kept_as_remote_references')).toBe(true)
    const snapshots = db.select().from(documentImportSnapshots).all()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.commentsStatus).toBe('complete')
    expect(db.select().from(documentImportComments).all()).toHaveLength(2)
    const run = db.select().from(documentImportRuns).all()[0]!
    expect(run.status).toBe('preview')
    expect(run.sourceId).not.toBeNull()
  })

  it('degrades to commentsStatus=failed without blocking the body', async () => {
    const { imports } = await createHarness({
      actionRunner: fakeRunner(FEISHU_READ, { 'feishu.list_drive_comments': new Error('comment API failed') }),
    })
    const preview = await imports.preview('feishu', 'tokA')
    expect(preview.commentsStatus).toBe('failed')
    expect(preview.warnings.some((warning) => warning.code === 'comments_read_failed')).toBe(true)
    expect(preview.bodyExcerpt).toContain('导入的正文段落')
  })

  it('notion preview marks comments unavailable', async () => {
    const { imports } = await createHarness({ actionRunner: fakeRunner(NOTION_READ) })
    const preview = await imports.preview('notion', 'page1')
    expect(preview.commentsStatus).toBe('unavailable')
    expect(preview.warnings.some((warning) => warning.code === 'comments_unsupported_provider')).toBe(true)
  })

  it('throws OPEN_CONNECTOR_UNAVAILABLE when connector is not configured', async () => {
    const { imports } = await createHarness({ connector: null })
    const error = await imports.search('feishu', 'x').then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ImportServiceError)
    const serviceError = error as ImportServiceError
    expect(serviceError.code).toBe('OPEN_CONNECTOR_UNAVAILABLE')
    expect(serviceError.statusCode).toBe(503)
  })

  it('commits preview to a room as primary version 1', async () => {
    const { imports } = await createHarness({ actionRunner: fakeRunner(FEISHU_READ) })
    const preview = await imports.preview('feishu', 'tokA')
    const roomId = `room-${Math.random().toString(36).slice(2, 8)}`
    const result = await imports.commitToRoom({ runId: preview.runId, roomId })
    expect(result.relation).toBe('primary')
    expect(result.document.version).toBe(1)
    const rows = db.select().from(documentRoomImports).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.relation).toBe('primary')
    expect(rows[0]!.importedVersion).toBe(1)
    const history = await imports.importHistory(roomId, result.documentId)
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]!.relation).toBe('primary')
  })

  it('re-import creates a candidate, never overwrites, then apply creates v2', async () => {
    const { imports, documents } = await createHarness({ actionRunner: fakeRunner(FEISHU_READ) })
    const roomId = `room-${Math.random().toString(36).slice(2, 8)}`
    // 首次导入：primary，创建文档版本 1
    const preview = await imports.preview('feishu', 'tokA')
    const primary = await imports.commitToRoom({ runId: preview.runId, roomId })
    const documentId = primary.documentId
    const before = documents.get(documentId)!

    const check = await imports.checkExternalUpdate(roomId, documentId)
    expect(check.relation).toBe('candidate')
    // 目标文档未被覆盖
    expect(documents.get(documentId)!.version).toBe(before.version)
    expect(documents.get(documentId)!.contentJson).toEqual(before.contentJson)
    // 候选文档已物化且带标注标题
    const candidate = documents.get(check.documentId)!
    expect(candidate.title).toContain('外部更新候选')

    const history = await imports.importHistory(roomId, documentId)
    expect(history.entries.some((entry) => entry.relation === 'candidate')).toBe(true)
    // 评论两侧 complete 才可比
    expect(history.commentDiff?.comparable).toBe(true)

    const candidateEntry = history.entries.find((entry) => entry.relation === 'candidate')!
    const applied = await imports.applyCandidate(candidateEntry.roomImportId)
    expect(applied.version).toBe(before.version + 1)
    // 应用后不能重复应用
    const again = await imports.applyCandidate(candidateEntry.roomImportId).then(() => null, (caught: unknown) => caught)
    expect(again).toBeInstanceOf(ImportServiceError)
    expect((again as ImportServiceError).code).toBe('CANDIDATE_ALREADY_APPLIED')
  })
})

describe('agent document export service', () => {
  it('create mode succeeds end to end', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({ roomId, documentId, provider: 'feishu', mode: 'create' })
    expect(run.status).toBe('succeeded')
    expect(run.remoteUrl).toBe('https://feishu.cn/docx/doccnCreated1')
    expect(run.version).toBe(1)
    const row = db.select().from(agentDocumentExports).all()[0]!
    expect(row.payloadHash).toBeTruthy()
    expect(row.payloadMarkdownRef).toBeTruthy()
  })

  it('update mode requires explicit confirmation before overwrite', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({
      roomId,
      documentId,
      provider: 'feishu',
      mode: 'update',
      target: { remoteUrl: 'https://feishu.cn/docx/tokA', writeScope: 'replace_document' },
    })
    expect(run.status).toBe('awaiting_confirmation')
    expect(run.confirmation?.targetTitle).toBe('远端目标文档')
    expect(run.confirmation?.writeScope).toBe('replace_document')
    expect(run.confirmation?.warnings.some((warning) => warning.code === 'overwrite_warning')).toBe(true)
    // 未确认前没有任何 remote 结果
    expect(run.remoteUrl).toBeNull()
    const confirmed = await harness.exports_.confirmAndExecute(run.id)
    expect(confirmed.status).toBe('succeeded')
    expect(confirmed.remoteRevision).toBe('10')
  })

  it('update mode defaults to append without overwrite warning', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({
      roomId,
      documentId,
      provider: 'feishu',
      mode: 'update',
      target: { remoteUrl: 'https://feishu.cn/docx/tokA' },
    })
    expect(run.status).toBe('awaiting_confirmation')
    expect(run.confirmation?.writeScope).toBe('append')
    expect(run.confirmation?.warnings).toHaveLength(0)
    const confirmed = await harness.exports_.confirmAndExecute(run.id)
    expect(confirmed.status).toBe('succeeded')
    expect(confirmed.remoteRevision).toBe('11')
  })

  it('feishu export_file creates a drive markdown file', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({
      roomId,
      documentId,
      provider: 'feishu',
      mode: 'export_file',
    })
    expect(run.status).toBe('succeeded')
    expect(run.remoteUrl).toBe('https://vyi-tech.feishu.cn/file/mdfile0001')
  })

  it('local document images are replaced with placeholders and warned', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const roomId = `room-${Math.random().toString(36).slice(2, 8)}`
    const document = await harness.documents.import({
      id: `doc-${Math.random().toString(36).slice(2, 10)}`,
      roomId,
      title: '带本地图的文档',
      contentJson: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '看图：' }] },
          { type: 'image', attrs: { src: 'nxcore-document-asset://asset-1', alt: '截图' } },
        ],
      } as never,
    })
    const run = await harness.exports_.runExport({
      roomId,
      documentId: document.id,
      provider: 'feishu',
      mode: 'export_file',
    })
    expect(run.status).toBe('succeeded')
    expect(run.warnings.some((warning) => warning.code === 'local_assets_placeholder')).toBe(true)
  })

  it('update mode without a user-provided target fails validation', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    await expect(harness.exports_.runExport({ roomId, documentId, provider: 'feishu', mode: 'update' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'EXPORT_TARGET_REQUIRED' }) as never)
  })

  it('missing lark-cli reports environment_not_ready instead of auth', async () => {
    const harness = await createHarness({ connector: null, lark: { executable: '/nonexistent/lark-cli-xyz' } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({ roomId, documentId, provider: 'feishu', mode: 'create' })
    expect(run.status).toBe('environment_not_ready')
    expect(run.challenge).toBeNull()
  })

  it('unconfigured feishu app returns app_setup challenge', async () => {
    const larkPath = await writeFakeLarkCli('no-app')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({ roomId, documentId, provider: 'feishu', mode: 'create' })
    expect(run.status).toBe('awaiting_auth')
    expect(run.challenge?.phase).toBe('app_setup')
    expect(run.challenge?.reason).toBe('app_setup_required')
  })

  it('notion export without connector reports environment_not_ready', async () => {
    const harness = await createHarness({ connector: null, lark: null })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({ roomId, documentId, provider: 'notion', mode: 'create' })
    expect(run.status).toBe('environment_not_ready')
  })

  it('notion create succeeds via connector action', async () => {
    const harness = await createHarness({
      actionRunner: fakeRunner({
        'notion.search': { results: [] },
        'notion.create_page': { id: 'page-new', url: 'https://notion.so/page-new' },
      }),
    })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const run = await harness.exports_.runExport({
      roomId,
      documentId,
      provider: 'notion',
      mode: 'create',
      target: { parentId: 'parent-page-1' },
    })
    expect(run.status).toBe('succeeded')
    expect(run.remoteUrl).toBe('https://notion.so/page-new')
  })

  it('export payload is pinned to the version at run creation', async () => {
    const larkPath = await writeFakeLarkCli('ok')
    const harness = await createHarness({ connector: null, lark: { executable: larkPath } })
    const { roomId, documentId } = await createRoomDocument(harness.documents)
    const runId = await harness.exports_.createRun({ roomId, documentId, provider: 'feishu', mode: 'create' })
    // 任务创建后继续编辑文档不影响本次 payload
    await harness.documents.save(documentId, {
      baseVersion: harness.documents.get(documentId)!.version,
      title: '本地文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '编辑后的正文' }] }] } as never,
    })
    const run = await harness.exports_.getRun(runId)
    expect(run.version).toBe(1)
  })
})

describe('import service error mapping', () => {
  it('maps connector auth failures to IMPORT_CONNECTION_REQUIRED', async () => {
    const { imports } = await createHarness({
      actionRunner: async () => {
        throw new (await import('../src/modules/documents/import/oo-runner.js')).ImportConnectorError('authentication_required', 'oauth failed')
      },
    })
    await expect(imports.search('feishu', 'x')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ImportServiceError)
      const serviceError = error as ImportServiceError
      expect(serviceError.code).toBe('IMPORT_CONNECTION_REQUIRED')
      expect(serviceError.statusCode).toBe(422)
      return true
    })
  })
})
