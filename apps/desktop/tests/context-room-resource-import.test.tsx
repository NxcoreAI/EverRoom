import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { createContextRoomFixture } from './context-room-fixture'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { ArtifactLibraryPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ArtifactLibraryPane'

function renderArtifactLibrary() {
  return TestRenderer.create(
    <ArtifactLibraryPane
      room={createContextRoomFixture()}
      backendDocuments={[]}
      trashedDocuments={[]}
      selectedId={null}
      onSelect={() => {}}
      onCreateDocument={vi.fn().mockResolvedValue(undefined)}
      onDeleteDocument={() => Promise.resolve()}
      onRestoreDocument={() => Promise.resolve()}
      onDeleteDocumentPermanently={() => Promise.resolve()}
    />,
  )
}

describe('产物库：文件导入入口只在新建产物弹层内', () => {
  it('产物库没有独立的“从文件系统导入”按钮（避免与弹层内导入重复）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibrary()
    })
    const buttons = renderer!.root.findAllByType('button')
    expect(buttons.some((node) => node.props.className === 'context-room-resource-add-file')).toBe(false)
    expect(buttons.some((node) => (node.props['aria-label'] ?? '').includes('从文件系统导入'))).toBe(false)
    // 弹层关闭时隐藏的 markdown 输入不挂载（它随 Popover 内容渲染）
    expect(renderer!.root.findAllByProps({ className: 'context-room-document-import-input' })).toHaveLength(0)
  })

  it('工具条保留“新建产物”入口（弹层内含导入本地 Markdown）', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    await act(async () => {
      renderer = renderArtifactLibrary()
    })
    const newArtifact = renderer!.root.findAllByType('button')
      .find((node) => node.props['aria-label'] === '新建产物')
    expect(newArtifact).toBeTruthy()
  })
})
