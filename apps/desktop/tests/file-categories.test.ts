import { describe, expect, it } from 'vitest'

import { categoryForFile } from '../src/renderer/src/components/pages/fileCategories'

function file(originalName: string, mime = 'text/plain') {
  return {
    id: originalName,
    originalName,
    bytes: 10,
    mime,
    contentHash: 'hash',
    parsed: true,
    createdAt: '',
    updatedAt: '',
  }
}

describe('file recognition categories', () => {
  it('uses semantic filename signals before the engine data type', () => {
    expect(categoryForFile(file('2026 年度总结.docx'), {
      id: 'event-1',
      sourceKind: 'file',
      sourceId: '2026 年度总结.docx',
      sourceVersion: 1,
      dataType: 'office-doc',
      detectedBy: 'extension',
      title: '2026 年度总结',
      contentHash: 'hash',
      parsedId: 'parsed-1',
      pipelines: { room: true, wiki: true, memory: false },
      memoryResult: null,
      routeJobId: null,
      originChannel: 'upload',
      createdAt: '',
      updatedAt: '',
    }).key).toBe('summary')
  })

  it('falls back to the persisted data type mapping', () => {
    expect(categoryForFile(file('metrics.xlsx'), {
      id: 'event-2',
      sourceKind: 'file',
      sourceId: 'metrics.xlsx',
      sourceVersion: 1,
      dataType: 'spreadsheet',
      detectedBy: 'extension',
      title: 'metrics.xlsx',
      contentHash: 'hash',
      parsedId: 'parsed-2',
      pipelines: { room: true, wiki: true, memory: false },
      memoryResult: null,
      routeJobId: null,
      originChannel: 'upload',
      createdAt: '',
      updatedAt: '',
    }).key).toBe('data')
  })
})

