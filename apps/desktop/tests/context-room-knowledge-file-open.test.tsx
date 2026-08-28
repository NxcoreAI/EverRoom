import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
// WorkspaceContent 的传递依赖经图谱画布引入 pixi(node 环境无 window)，mock 掉画布本体
vi.mock('../src/renderer/src/components/graph/PixiForceGraphCanvas', () => ({
  PixiForceGraphCanvas: () => null,
}))

import { WorkspaceContent } from '../src/renderer/src/components/context-room/ported/components/detail-workspace/WorkspaceContent'
import { KnowledgeFileExternalCard } from '../src/renderer/src/components/context-room/ported/components/detail-panels/KnowledgeFileExternalCard'
import { createContextRoomFixture } from './context-room-fixture'
import type { ContextRoomKnowledgeFileResource } from '../src/renderer/src/components/context-room/ported/types'
import type { KnowledgeFileDto } from '../src/shared/knowledge'

function knowledgeFileDto(id: string, originalName: string): KnowledgeFileDto {
  return {
    id,
    originalName,
    bytes: 2048,
    title: null,
    status: 'confirmed',
    decidedBy: null,
    confidence: null,
    uploadedAt: '2026-08-27T00:00:00.000Z',
  }
}

function knowledgeFileResource(id: string, originalName: string): ContextRoomKnowledgeFileResource {
  return {
    id: `room-test:kfile:${id}`,
    roomId: 'room-test',
    folderId: 'room-test:folder:documents',
    name: originalName,
    updatedAt: '2026/8/27 08:00:00',
    kind: 'knowledge-file',
    fileId: id,
    originalName,
    bytes: 2048,
    uploadedAt: '2026-08-27T00:00:00.000Z',
    statusLabel: '已沉淀',
    sizeLabel: '2.0 KB',
  }
}

function installKnowledgeBridge(openFileImpl: () => Promise<void> = () => Promise.resolve()) {
  const knowledge = {
    openFile: vi.fn(openFileImpl),
    revealFile: vi.fn(() => Promise.resolve()),
    readFileMarkdown: vi.fn(() => Promise.resolve({ markdown: '# 预览' })),
  }
  vi.stubGlobal('window', { nxcore: { knowledge } })
  return knowledge
}

function renderWorkspaceContent(selectedResource: ContextRoomKnowledgeFileResource) {
  return TestRenderer.create(
    <WorkspaceContent
      room={createContextRoomFixture()}
      rooms={[]}
      panels={['documents']}
      selectedObject={null}
      selectedResource={selectedResource}
      backendDocuments={[]}
      knowledgeFiles={[knowledgeFileDto(selectedResource.fileId, selectedResource.originalName)]}
      focusedDocumentId={null}
      focusedBlockId={null}
      documentFocusRequestId={null}
      onBackendDocumentChange={() => {}}
      onDeleteDocument={() => Promise.resolve()}
      onOpenRoom={() => {}}
      onMobileBack={() => {}}
      onCloseObject={() => {}}
      onUpdateRoom={() => {}}
    />,
  )
}

describe('非 md knowledge 文件：编辑栏渲染外部打开卡片', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  it('pdf 等非 md 文件渲染 KnowledgeFileExternalCard，md 仍走应用内阅读器', async () => {
    installKnowledgeBridge()

    await act(async () => {
      renderer = renderWorkspaceContent(knowledgeFileResource('file-pdf', '季度报告.pdf'))
      await Promise.resolve()
    })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'context-room-knowledge-external-card' }))
      .toHaveLength(1)

    act(() => renderer!.unmount())
    await act(async () => {
      renderer = renderWorkspaceContent(knowledgeFileResource('file-md', '会议纪要.md'))
      await Promise.resolve()
    })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'context-room-knowledge-external-card' }))
      .toHaveLength(0)
  })

  it('卡片「用系统应用打开」调用 openFile(fileId)，失败时弹 toast', async () => {
    const knowledge = installKnowledgeBridge(() => Promise.reject(new Error('没有关联应用')))

    let rendererCard: TestRenderer.ReactTestRenderer
    await act(async () => {
      rendererCard = TestRenderer.create(
        <KnowledgeFileExternalCard resource={knowledgeFileResource('file-xlsx', '预算表.xlsx')} />,
      )
      await Promise.resolve()
    })
    const openButton = rendererCard!.root.findAllByType('button')
      .find((button) => button.props.children?.some?.((child: unknown) => typeof child === 'string' && child.includes('用系统应用打开')))
    expect(openButton).toBeDefined()

    await act(async () => {
      openButton!.props.onClick()
      await Promise.resolve()
    })
    expect(knowledge.openFile).toHaveBeenCalledWith('file-xlsx')

    const { showToast } = await import('@/state/toast')
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: '打开原件失败',
    }))
  })
})
