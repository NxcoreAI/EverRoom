import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openOriginal = vi.fn()
const onOpenOfficePreview = vi.fn()
const onOpenDocument = vi.fn()

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) =>
        actual.translate('zh-CN', message, values),
      locale: 'zh-CN',
    }),
  }
})

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({
    state: {
      rooms: [
        { id: 'room-a', title: '产品发布' },
        { id: 'room-b', title: '用户访谈' },
      ],
    },
  }),
}))

vi.mock('../src/renderer/src/components/context-room/RoomDocumentsProvider', () => ({
  useRoomDocumentsState: () => ({
    documentsByRoom: {
      'room-a': [
        { id: 'doc-1', title: '发布清单', updatedAt: '2026-09-29T10:00:00.000Z' },
        { id: 'doc-2', title: '复盘记录', updatedAt: '2026-09-27T09:00:00.000Z' },
      ],
    },
    documentsLoading: false,
  }),
}))

// FilterSelect 走 Radix（node 环境无 document），测试桩渲染原生 select。
vi.mock('../src/renderer/src/components/context-room/ported/components/shared', () => ({
  FilterSelect: function StubFilterSelect(props: {
    value: string
    options: ReadonlyArray<{ id: string; label: string }>
    onChange: (id: string) => void
    ariaLabel: string
  }) {
    return (
      <select
        value={props.value}
        aria-label={props.ariaLabel}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    )
  },
}))

vi.mock('../src/renderer/src/components/pages/PageHeader', () => ({
  PageHeader: function StubPageHeader(props: { title: string }) {
    return <h1>{props.title}</h1>
  },
}))

import { DocsPage } from '../src/renderer/src/components/pages/DocsPage'

function knowledgeFile(overrides: Record<string, unknown>) {
  return {
    id: 'file-x',
    originalName: 'a.docx',
    bytes: 100,
    title: null,
    status: 'ready',
    decidedBy: null,
    confidence: null,
    sourceKind: 'agent-generated',
    uploadedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function filesByRoom(items: unknown[]) {
  return { 'room-a': items, 'room-b': [] }
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll((node) => (
    typeof node.children === 'string' || Array.isArray(node.children)
      ? flattenChildren(node).includes(text)
      : false
  ))
}

function flattenChildren(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('')
}

function rowTitles(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByProps({ className: 'doc-row' })
    .map((row) => flattenChildren(row.findByType('strong')))
}

async function selectFilter(renderer: TestRenderer.ReactTestRenderer, label: string, value: string) {
  const select = renderer.root.findAllByProps({ 'aria-label': label })[0]
  await act(async () => {
    select!.props.onChange({ target: { value } })
  })
}

function installWindow(listRoomFiles: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', {
    nxcore: {
      knowledge: { listRoomFiles },
      files: { openOriginal },
    },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  openOriginal.mockReset()
  onOpenOfficePreview.mockClear()
  onOpenDocument.mockClear()
})

describe('DocsPage 文稿：云文档 + Room Office 产物合并列表', () => {
  it('合并两类来源并按最近更新排序，Office 行标注类型', async () => {
    installWindow(vi.fn((roomId: string) => Promise.resolve({
      items: roomId === 'room-a'
        ? [
            knowledgeFile({ id: 'file-1', originalName: '极核发布会.docx', uploadedAt: '2026-09-30T08:00:00.000Z' }),
            // 非 Agent 产物不进文稿列表
            knowledgeFile({ id: 'file-0', originalName: '上传件.pdf', sourceKind: 'manual-upload' }),
            // Agent 产物但非 Office 扩展名不进文稿列表
            knowledgeFile({ id: 'file-9', originalName: 'notes.md' }),
          ]
        : [],
    })))
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <DocsPage
          onNavigate={() => undefined}
          onOpenDocument={onOpenDocument}
          onOpenOfficePreview={onOpenOfficePreview}
        />,
      )
    })

    expect(rowTitles(renderer!)).toEqual(['极核发布会.docx', '发布清单', '复盘记录'])
    expect(textNodes(renderer!, '产品发布 · Word')).toHaveLength(1)
    expect(textNodes(renderer!, '产品发布 · 云文档')).toHaveLength(2)
  })

  it('点击 Office 产物行：openOriginal 携带 editable+roomId,打开顶栏预览标签', async () => {
    openOriginal.mockResolvedValue({ openedWith: 'office', instanceId: 'inst-1', kind: 'docx', title: 'x' })
    installWindow(vi.fn(() => Promise.resolve({ items: [
      knowledgeFile({ id: 'file-1', originalName: '极核发布会.docx', uploadedAt: '2026-09-30T08:00:00.000Z' }),
    ] })))
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <DocsPage
          onNavigate={() => undefined}
          onOpenDocument={onOpenDocument}
          onOpenOfficePreview={onOpenOfficePreview}
        />,
      )
    })

    const row = renderer!.root.findAllByProps({ className: 'doc-row' })[0]
    await act(async () => {
      row!.props.onClick()
    })
    expect(openOriginal).toHaveBeenCalledWith(
      'file-1',
      '极核发布会.docx',
      undefined,
      { editable: true, roomId: 'room-a' },
    )
    expect(onOpenOfficePreview).toHaveBeenCalledWith({ id: 'inst-1', title: '极核发布会.docx', kind: 'docx' })
  })

  it('类型与 Room 下拉筛选生效', async () => {
    installWindow(vi.fn((roomId: string) => Promise.resolve({
      items: roomId === 'room-b'
        ? [knowledgeFile({ id: 'file-2', originalName: '访谈纪要.pptx', uploadedAt: '2026-09-29T15:00:00.000Z' })]
        : [],
    })))
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = TestRenderer.create(
        <DocsPage
          onNavigate={() => undefined}
          onOpenDocument={onOpenDocument}
          onOpenOfficePreview={onOpenOfficePreview}
        />,
      )
    })

    // 类型筛 Word：数据里没有 Word 产物 → 空
    await selectFilter(renderer!, '按类型筛选', 'docx')
    expect(rowTitles(renderer!)).toEqual([])

    // 类型筛云文档：只剩云文档行
    await selectFilter(renderer!, '按类型筛选', 'document')
    expect(rowTitles(renderer!)).toEqual(['发布清单', '复盘记录'])

    // 类型筛 PPT：只剩 Room 产物行
    await selectFilter(renderer!, '按类型筛选', 'slides')
    expect(rowTitles(renderer!)).toEqual(['访谈纪要.pptx'])

    // Room 筛用户访谈 + 类型全部：还是只有该 Room 的产物
    await selectFilter(renderer!, '按类型筛选', 'all')
    await selectFilter(renderer!, '按 Room 筛选', 'room-b')
    expect(rowTitles(renderer!)).toEqual(['访谈纪要.pptx'])
  })
})

