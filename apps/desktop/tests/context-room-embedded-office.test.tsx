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

function agentDocxResource(fileId = 'file-agent-docx'): ContextRoomKnowledgeFileResource {
  return {
    id: `room-test:kfile:${fileId}`,
    roomId: 'room-test',
    folderId: 'room-test:folder:documents',
    name: '本周总结.docx',
    updatedAt: '2026/9/22 08:00:00',
    kind: 'knowledge-file',
    fileId,
    originalName: '本周总结.docx',
    bytes: 4096,
    uploadedAt: '2026-09-22T00:00:00.000Z',
    statusLabel: '已沉淀',
    sizeLabel: '4.0 KB',
  }
}

function knowledgeFileDto(fileId: string): KnowledgeFileDto {
  return {
    id: fileId,
    originalName: '本周总结.docx',
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
          knowledgeFiles={[knowledgeFileDto(resource.fileId)]}
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
    expect(bridge.openOriginal).toHaveBeenCalledWith('file-agent-docx', '本周总结.docx')
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

  it('openOriginal 返回非 Office 结果 → 回退外部打开卡片，不登记实例', async () => {
    installOfficeBridge(async () => ({ openedWith: 'system' }))

    const host = await renderWorkspaceContent(agentDocxResource())
    expect(host.querySelectorAll('[data-testid="context-room-knowledge-external-card"]')).toHaveLength(1)
    expect(getEmbeddedOffice()).toBeNull()
  })
})
