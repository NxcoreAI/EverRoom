/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
// WorkspaceContent 的传递依赖经图谱画布引入 pixi(node 环境无 window)，mock 掉画布本体
vi.mock('../src/renderer/src/components/graph/PixiForceGraphCanvas', () => ({
  PixiForceGraphCanvas: () => null,
}))

import { WorkspaceContent } from '../src/renderer/src/components/context-room/ported/components/detail-workspace/WorkspaceContent'
import {
  getEmbeddedOffice,
  releaseEmbeddedOffice,
} from '../src/renderer/src/components/context-room/ported/embeddedOffice'
import { createContextRoomFixture } from './context-room-fixture'
import type { ContextRoomKnowledgeFileResource } from '../src/renderer/src/components/context-room/ported/types'
import type { KnowledgeFileDto } from '../src/shared/knowledge'

function agentDocxResource(fileId = 'file-agent-docx', name = '本周总结.docx'): ContextRoomKnowledgeFileResource {
  return {
    id: `room-test:kfile:${fileId}`,
    roomId: 'room-test',
    folderId: 'room-test:folder:documents',
    name,
    updatedAt: '2026/9/22 08:00:00',
    kind: 'knowledge-file',
    fileId,
    originalName: name,
    bytes: 4096,
    uploadedAt: '2026-09-22T00:00:00.000Z',
    statusLabel: '已沉淀',
    sizeLabel: '4.0 KB',
  }
}

function knowledgeFileDto(fileId: string, name = '本周总结.docx'): KnowledgeFileDto {
  return {
    id: fileId,
    originalName: name,
    bytes: 4096,
    title: null,
    status: 'confirmed',
    decidedBy: null,
    confidence: null,
    uploadedAt: '2026-09-22T00:00:00.000Z',
    sourceKind: 'agent-generated',
  }
}

/** happy-dom 无 ResizeObserver：宿主的矩形上报不在本测试射程内，桩掉即可。 */
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function installOfficeBridge(openOriginalImpl: () => Promise<unknown>) {
  const openOriginal = vi.fn(openOriginalImpl)
  const setWorkspaceBounds = vi.fn()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // happy-dom 的真 window 保留（createRoot 依赖其 document），只挂 nxcore 桥。
  ;(window as unknown as { nxcore: unknown }).nxcore = {
    files: { openOriginal },
    office: { setWorkspaceBounds },
    knowledge: {
      openFile: vi.fn(() => Promise.resolve()),
      revealFile: vi.fn(() => Promise.resolve()),
    },
  }
  return { openOriginal, setWorkspaceBounds }
}

function resetEmbeddedStore(): void {
  const current = getEmbeddedOffice()
  if (current) releaseEmbeddedOffice(current.fileId)
}

describe('Room 右区内嵌 Office 预览（Agent 产物替换云文档位置）', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    resetEmbeddedStore()
    delete (window as unknown as { nxcore?: unknown }).nxcore
    vi.unstubAllGlobals()
  })

  async function renderWorkspaceContent(resource: ContextRoomKnowledgeFileResource): Promise<HTMLDivElement> {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <WorkspaceContent
          room={createContextRoomFixture()}
          selectedResource={resource}
          backendDocuments={[]}
          knowledgeFiles={[knowledgeFileDto(resource.fileId, resource.originalName)]}
          focusedDocumentId={null}
          focusedBlockId={null}
          documentFocusRequestId={null}
          onBackendDocumentChange={() => {}}
          onDeleteDocument={() => Promise.resolve()}
          onSelectionTextChange={() => {}}
          onChapterChange={() => {}}
          registerQuoteInsert={() => () => {}}
          onMobileBack={() => {}}
          onUpdateRoom={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('选中 Office 产物 → 宿主占位 + openOriginal 登记 embeddedOffice，卸载即释放', async () => {
    const bridge = installOfficeBridge(async () => ({
      openedWith: 'office',
      instanceId: 'inst-docx-1',
      title: '本周总结.docx',
      kind: 'docx',
    }))

    const host = await renderWorkspaceContent(agentDocxResource())
    // docx 产物：编辑预览（editable + roomId 归属，主进程据此回填版本链）。
    expect(bridge.openOriginal).toHaveBeenCalledWith(
      'file-agent-docx',
      '本周总结.docx',
      undefined,
      { editable: true, roomId: 'room-test' },
    )
    expect(host.querySelectorAll('[data-office-file-id="file-agent-docx"]')).toHaveLength(1)
    expect(getEmbeddedOffice()).toMatchObject({
      roomId: 'room-test',
      fileId: 'file-agent-docx',
      instanceId: 'inst-docx-1',
    })

    act(() => root!.unmount())
    root = null
    expect(getEmbeddedOffice()).toBeNull()
  })

  it('pptx/xlsx 产物同样传 editable；legacy 与 pdf 不传', async () => {
    const bridge = installOfficeBridge(async () => ({
      openedWith: 'office',
      instanceId: 'inst-office-1',
      title: 'x',
      kind: 'docx',
    }))

    const deck = await renderWorkspaceContent(agentDocxResource('file-agent-pptx', '季度汇报.pptx'))
    expect(bridge.openOriginal).toHaveBeenLastCalledWith(
      'file-agent-pptx',
      '季度汇报.pptx',
      undefined,
      { editable: true, roomId: 'room-test' },
    )
    expect(deck.querySelectorAll('[data-office-file-id="file-agent-pptx"]')).toHaveLength(1)

    act(() => root!.unmount())
    root = null
    resetEmbeddedStore()

    const sheet = await renderWorkspaceContent(agentDocxResource('file-agent-xlsx', '预算表.xlsx'))
    expect(bridge.openOriginal).toHaveBeenLastCalledWith(
      'file-agent-xlsx',
      '预算表.xlsx',
      undefined,
      { editable: true, roomId: 'room-test' },
    )

    act(() => root!.unmount())
    root = null
    resetEmbeddedStore()

    await renderWorkspaceContent(agentDocxResource('file-agent-pdf', '报告.pdf'))
    expect(bridge.openOriginal).toHaveBeenLastCalledWith('file-agent-pdf', '报告.pdf', undefined, undefined)
  })

  it('openOriginal 返回非 Office 结果 → 回退外部打开卡片，不登记实例', async () => {
    installOfficeBridge(async () => ({ openedWith: 'system' }))

    const host = await renderWorkspaceContent(agentDocxResource())
    expect(host.querySelectorAll('[data-testid="context-room-knowledge-external-card"]')).toHaveLength(1)
    expect(getEmbeddedOffice()).toBeNull()
  })
})
