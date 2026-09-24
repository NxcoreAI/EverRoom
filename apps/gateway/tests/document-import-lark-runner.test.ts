import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LarkCliError, type LarkCliConfig } from '../src/modules/documents/agent-export/lark-cli.js'
import { ImportConnectorError } from '../src/modules/documents/import/oo-runner.js'
import { importAdapterOf } from '../src/modules/documents/import/providers.js'
import {
  createLarkImportActionRunner,
  downloadLarkMediaToFile,
  larkErrorToImportConnectorError,
} from '../src/modules/documents/import/lark-action-runner.js'

/**
 * lark-action-runner 单测：8 action 的 CLI 信封→oo 形状归一化、错误映射、
 * 鉴权门禁顺序与媒体下载。假 CLI 是 bash 脚本，按子命令分发固定信封，
 * 每次调用把 "$1 $2" 追加到 calls.log（get_document 短路断言靠它计数）。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function writeFakeLarkCli(behavior: 'ok' | 'auth_error' = 'ok'): Promise<{
  config: LarkCliConfig
  callLog: () => Promise<string[]>
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'nxcore-lark-runner-'))
  const path = join(dir, 'lark-cli')
  const fail = behavior === 'auth_error'
    ? `echo '{"ok":false,"error":{"type":"auth","message":"not logged in"}}' >&2\nexit 3`
    : `echo '{"ok":false,"error":{"type":"cli","message":"unsupported"}}' >&2\nexit 3`
  const script = `#!/bin/bash
echo "$1 $2" >> "$(dirname "$0")/calls.log"
${behavior === 'auth_error' ? `echo '{"ok":false,"error":{"type":"auth","message":"not logged in"}}' >&2\nexit 3\n` : ''}
if [[ " $* " == *" drive files list "* ]]; then
  if [[ " $* " == *" --page-token p2 "* ]]; then
    echo '{"ok":true,"data":{"files":[{"token":"tokDoc2","name":"第二篇","type":"docx","url":"https://feishu.cn/docx/tokDoc2","modified_time":"1760000000"}],"has_more":false}}'
  else
    echo '{"ok":true,"data":{"files":[{"token":"fldSub","name":"子目录","type":"folder","url":"https://feishu.cn/drive/folder/fldSub"},{"token":"tokDoc1","name":"第一篇","type":"docx","url":"https://feishu.cn/docx/tokDoc1","modified_time":"1759000000"}],"next_page_token":"p2","has_more":true}}'
  fi
  exit 0
fi
if [[ " $* " == *" docs +search "* ]]; then
  echo '{"ok":true,"data":{"results":[{"entity_type":"DOC","title_highlighted":"季度<h>复盘</h>报<em>告</em>","result_meta":{"token":"tokHit1","url":"https://feishu.cn/docx/tokHit1","update_time":"1760000200","owner_name":"张三"}},{"title":"无 meta 的裸结果"}],"page_token":null,"has_more":false}}'
  exit 0
fi
if [[ " $* " == *" wiki +space-list "* ]]; then
  echo '{"ok":true,"data":{"items":[{"space_id":"sp1","name":"知识库"}],"page_token":"spg2","has_more":true}}'
  exit 0
fi
if [[ " $* " == *" wiki +node-list "* ]]; then
  SID=""
  prev=""
  for a in "$@"; do if [ "$prev" = "--space-id" ]; then SID="$a"; fi; prev="$a"; done
  printf '{"ok":true,"data":{"items":[{"node_token":"nod1","obj_token":"tokWiki1","obj_type":"docx","title":"wiki 节点 %s","obj_edit_time":"1760001000","has_child":false}],"has_more":false}}\\n' "$SID"
  exit 0
fi
if [[ " $* " == *" docs +fetch "* ]]; then
  echo '{"ok":true,"data":{"document":{"document_id":"tokFetch1","revision_id":42,"content":"<title>导入<b>标题</b></title>\\n\\n# 正文\\n\\n段落"}}}'
  exit 0
fi
if [[ " $* " == *" drive +list-comments "* ]]; then
  echo '{"ok":true,"data":{"items":[{"id":"c1","is_solved":true}],"file_token":"tokC","has_more":true,"page_token":"cpg2","count":1}}'
  exit 0
fi
if [[ " $* " == *" docs +media-download "* ]]; then
  OUT=""
  prev=""
  for a in "$@"; do if [ "$prev" = "--output" ]; then OUT="$a"; fi; prev="$a"; done
  printf '\\x89\\x50\\x4e\\x47\\x0d\\x0a\\x1a\\x0a' > "$OUT"
  printf '{"ok":true,"data":{"output":"%s"}}\\n' "$OUT"
  exit 0
fi
${fail}
`
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return {
    config: { executable: path },
    callLog: async () => {
      try {
        return (await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup()
})

async function makeRunner(behavior: 'ok' | 'auth_error' = 'ok', ensureAuth?: () => Promise<void>) {
  const cli = await writeFakeLarkCli(behavior)
  cleanups.push(cli.cleanup)
  return {
    cli,
    run: createLarkImportActionRunner(cli.config, ensureAuth ? { ensureAuth } : {}),
  }
}

// ── action 归一化 ────────────────────────────────────────────────────────────

describe('lark-action-runner 归一化', () => {
  it('list_drive_files：files→items、next_page_token→pageToken、翻页 hasMore', async () => {
    const { run } = await makeRunner()
    const page1 = await run({ service: 'feishu', action: 'list_drive_files', input: {} }, undefined)
    expect(page1).toEqual({
      items: [
        { token: 'fldSub', name: '子目录', type: 'folder', url: 'https://feishu.cn/drive/folder/fldSub' },
        { token: 'tokDoc1', name: '第一篇', type: 'docx', url: 'https://feishu.cn/docx/tokDoc1', modified_time: '1759000000' },
      ],
      pageToken: 'p2',
      hasMore: true,
    })
    const page2 = await run({ service: 'feishu', action: 'list_drive_files', input: { pageToken: 'p2' } }, undefined)
    expect(page2).toEqual({
      items: [{ token: 'tokDoc2', name: '第二篇', type: 'docx', url: 'https://feishu.cn/docx/tokDoc2', modified_time: '1760000000' }],
      pageToken: null,
      hasMore: false,
    })
  })

  it('search_documents：result_meta 拍平 + 高亮标签剥除；无 meta 条目保 title 落 token null', async () => {
    const { run } = await makeRunner()
    const result = await run({ service: 'feishu', action: 'search_documents', input: { query: '复盘' } }, undefined)
    expect(result).toEqual({
      results: [
        {
          url: 'https://feishu.cn/docx/tokHit1',
          token: 'tokHit1',
          doc_token: 'tokHit1',
          title: '季度复盘报告',
          owner_name: '张三',
          update_time: '1760000200',
        },
        { url: null, token: null, doc_token: null, title: '无 meta 的裸结果', owner_name: null, update_time: null },
      ],
      pageToken: null,
      hasMore: false,
    })
  })

  it('list_wiki_spaces / list_wiki_nodes：snake 分页键归一，items 原样透传，spaceId 透传命令行', async () => {
    const { run, cli } = await makeRunner()
    const spaces = await run({ service: 'feishu', action: 'list_wiki_spaces', input: {} }, undefined)
    expect(spaces).toEqual({ items: [{ space_id: 'sp1', name: '知识库' }], hasMore: true, pageToken: 'spg2' })

    const nodes = await run({ service: 'feishu', action: 'list_wiki_nodes', input: { spaceId: 'sp42' } }, undefined)
    expect(nodes).toEqual({
      items: [{ node_token: 'nod1', obj_token: 'tokWiki1', obj_type: 'docx', title: 'wiki 节点 sp42', obj_edit_time: '1760001000', has_child: false }],
      hasMore: false,
      pageToken: null,
    })
    const calls = await cli.callLog()
    expect(calls.some((line) => line === 'wiki +node-list')).toBe(true)
  })

  it('get_document：短路返回空对象，不 spawn CLI、不触发鉴权', async () => {
    let ensureCount = 0
    const { run, cli } = await makeRunner('ok', async () => { ensureCount += 1 })
    await run({ service: 'feishu', action: 'list_drive_files', input: {} }, undefined)
    const before = (await cli.callLog()).length
    const meta = await run({ service: 'feishu', action: 'get_document', input: { documentId: 'tokFetch1' } }, undefined)
    expect(meta).toEqual({})
    expect((await cli.callLog()).length).toBe(before)
    expect(ensureCount).toBe(1)
  })

  it('fetch_document：title 从正文 <title> 提取（内层标签也剥）、revision 数字转字符串', async () => {
    const { run } = await makeRunner()
    const result = await run({ service: 'feishu', action: 'fetch_document', input: { documentId: 'tokFetch1' } }, undefined)
    expect(result).toEqual({
      document: {
        content: '<title>导入<b>标题</b></title>\n\n# 正文\n\n段落',
        document_id: 'tokFetch1',
        revision_id: '42',
        title: '导入标题',
      },
    })
  })

  it('list_drive_comments：外层 snake 分页键归一，评论条目原样透传', async () => {
    const { run } = await makeRunner()
    const result = await run({ service: 'feishu', action: 'list_drive_comments', input: { fileToken: 'tokC', fileType: 'docx' } }, undefined)
    expect(result).toEqual({ items: [{ id: 'c1', is_solved: true }], hasMore: true, pageToken: 'cpg2' })
  })

  it('不认识的 action / 非 feishu service → action_not_found', async () => {
    const { run } = await makeRunner()
    await expect(run({ service: 'feishu', action: 'create_doc', input: {} }, undefined))
      .rejects.toMatchObject({ code: 'action_not_found' })
    await expect(run({ service: 'notion', action: 'search', input: {} }, undefined))
      .rejects.toMatchObject({ code: 'action_not_found' })
  })

  it('缺必填参数 → invalid_input（不 spawn）', async () => {
    const { run, cli } = await makeRunner()
    await expect(run({ service: 'feishu', action: 'fetch_document', input: {} }, undefined))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await cli.callLog()).toEqual([])
  })
})

// ── 错误映射 ─────────────────────────────────────────────────────────────────

describe('lark 错误映射', () => {
  it.each([
    ['auth_required', 'authentication_required'],
    ['app_setup_required', 'no_connection'],
    ['environment', 'connector_unavailable'],
    ['timeout', 'timeout'],
    ['scope_missing', 'connector_error'],
    ['cli', 'connector_error'],
  ])('%s → %s', (kind, code) => {
    const mapped = larkErrorToImportConnectorError(new LarkCliError(kind as LarkCliError['kind'], 'detail-x'))
    expect(mapped).toBeInstanceOf(ImportConnectorError)
    expect(mapped.code).toBe(code)
    expect(mapped.detail).toBe('detail-x')
  })

  it('CLI auth 失败信封 → authentication_required（经 runLarkCli stderr 契约）', async () => {
    const { run } = await makeRunner('auth_error')
    await expect(run({ service: 'feishu', action: 'list_drive_files', input: {} }, undefined))
      .rejects.toMatchObject({ code: 'authentication_required', detail: 'not logged in' })
  })
})

// ── 鉴权门禁顺序 ─────────────────────────────────────────────────────────────

describe('鉴权门禁', () => {
  it('每次 action 调用先过 ensureAuth；get_document 短路跳过', async () => {
    let ensureCount = 0
    const { run } = await makeRunner('ok', async () => { ensureCount += 1 })
    await run({ service: 'feishu', action: 'search_documents', input: { query: 'x' } }, undefined)
    await run({ service: 'feishu', action: 'list_wiki_spaces', input: {} }, undefined)
    await run({ service: 'feishu', action: 'get_document', input: { documentId: 't' } }, undefined)
    expect(ensureCount).toBe(2)
  })
})

// ── 媒体下载 ─────────────────────────────────────────────────────────────────

describe('downloadLarkMediaToFile', () => {
  it('下载写盘、返回信封路径、字节为 PNG magic', async () => {
    const { cli } = await makeRunner()
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-lark-media-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const target = join(dir, 'imgToken001.bin')
    const written = await downloadLarkMediaToFile(cli.config, 'imgToken001', target)
    expect(written).toBe(target)
    expect(await readFile(target)).toEqual(PNG_MAGIC)
  })
})

// ── 适配器对接（归一化形状命中 providers 解析键表）─────────────────────────────

describe('适配器对接', () => {
  it('searchDocuments：拍平条目被 mapFeishuSearchItem 正常解析', async () => {
    const { run } = await makeRunner()
    const adapter = importAdapterOf('feishu', run)
    const { items } = await adapter.searchDocuments('复盘')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: '季度复盘报告' })
  })

  it('readDocument：metaless 流程拿 title/正文/revision（get_document 短路不报错）', async () => {
    const { run } = await makeRunner()
    const adapter = importAdapterOf('feishu', run)
    const read = await adapter.readDocument('tokFetch1')
    expect(read.title).toBe('导入标题')
    expect(read.bodyMarkdown).toContain('# 正文')
    expect(read.sourceRevision).toBe('42')
  })
})
