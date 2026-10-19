import { describe, expect, it } from 'vitest'
import type { KnowledgeFileDto } from '../src/shared/knowledge'

import { isArtifactImportFileName, isRoomArtifactSourceKind } from '../src/shared/sources'
import { createContextRoomResourceLibrary } from '../src/renderer/src/components/context-room/ported/resources'
import { createContextRoomFixture } from './context-room-fixture'

const room = createContextRoomFixture()

function knowledgeFile(id: string, name: string, sourceKind: string): KnowledgeFileDto {
  return {
    id,
    originalName: name,
    bytes: 2048,
    title: null,
    status: 'confirmed',
    decidedBy: 'entry',
    confidence: 1,
    sourceKind,
    uploadedAt: '2026-08-15T09:00:00.000Z',
  }
}

describe('产物库导入：格式与来源判定', () => {
  it('Office 扩展名可导入，其余（pdf/md/无扩展名）不收', () => {
    expect(isArtifactImportFileName('方案.docx')).toBe(true)
    expect(isArtifactImportFileName('deck.PPTX')).toBe(true)
    expect(isArtifactImportFileName('旧表.xls')).toBe(true)
    expect(isArtifactImportFileName('表格.xlsm')).toBe(true)
    expect(isArtifactImportFileName('scan.pdf')).toBe(false)
    expect(isArtifactImportFileName('notes.md')).toBe(false)
    expect(isArtifactImportFileName('noext')).toBe(false)
  })

  it('产物来源 = Agent 生成 + 导入，其余归资料', () => {
    expect(isRoomArtifactSourceKind('agent-generated')).toBe(true)
    expect(isRoomArtifactSourceKind('artifact-imported')).toBe(true)
    expect(isRoomArtifactSourceKind('manual-upload')).toBe(false)
    expect(isRoomArtifactSourceKind(undefined)).toBe(false)
  })

  it('knowledge-file 资源透传 sourceKind（产物标签与打开路由的分流依据）', () => {
    const library = createContextRoomResourceLibrary(room, [], [], [
      knowledgeFile('f1', '方案.docx', 'artifact-imported'),
      knowledgeFile('f2', '初稿.docx', 'agent-generated'),
      knowledgeFile('f3', '会议纪要.md', 'manual-upload'),
    ], 'zh-CN')
    const sourceKindByFileId = new Map(
      library.resources
        .filter((resource) => resource.kind === 'knowledge-file')
        .map((resource) => [resource.fileId, resource.sourceKind]),
    )
    expect(sourceKindByFileId.get('f1')).toBe('artifact-imported')
    expect(sourceKindByFileId.get('f2')).toBe('agent-generated')
    expect(sourceKindByFileId.get('f3')).toBe('manual-upload')
  })
})
