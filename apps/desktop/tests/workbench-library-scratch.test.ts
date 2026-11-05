import { describe, expect, it } from 'vitest'

import {
  TMP_FOLDER_PATH,
  buildScratchLevel,
  folderLabel,
  isTmpPath,
  scratchRows,
} from '@/workbench/workspace/libraryTree'

describe('资料页 .tmp（scratch）子树', () => {
  const entries = [
    { path: 'thesis/abc/preview.png', size: 1024, modifiedAt: '2026-11-05T08:00:00Z' },
    { path: 'thesis/abc/outline.md', size: 512, modifiedAt: '2026-11-05T09:00:00Z' },
    { path: 'thesis/def.md', size: 32, modifiedAt: '2026-11-05T10:00:00Z' },
    { path: 'top.png', size: 0, modifiedAt: '2026-11-05T11:00:00Z' },
  ]

  it('isTmpPath 识别 .tmp 与其子路径，不误伤普通目录', () => {
    expect(isTmpPath(TMP_FOLDER_PATH)).toBe(true)
    expect(isTmpPath('.tmp/thesis')).toBe(true)
    expect(isTmpPath('docs')).toBe(false)
    expect(isTmpPath('tmp')).toBe(false)
    expect(isTmpPath('')).toBe(false)
  })

  it('根层：直接文件 + 一级子目录（不递归）', () => {
    const level = buildScratchLevel(entries, '')
    expect(level.path).toBe(TMP_FOLDER_PATH)
    expect(level.folders).toEqual(['thesis'])
    expect(level.files.map((file) => file.path)).toEqual(['top.png'])
  })

  it('子层：只列本层直接文件，子目录按首段展开', () => {
    const level = buildScratchLevel(entries, `${TMP_FOLDER_PATH}/thesis`)
    expect(level.folders).toEqual(['abc'])
    expect(level.files.map((file) => file.path)).toEqual(['thesis/def.md'])
    const deeper = buildScratchLevel(entries, `${TMP_FOLDER_PATH}/thesis/abc`)
    expect(deeper.folders).toEqual([])
    expect(deeper.files.map((file) => file.name)).toEqual(['preview.png', 'outline.md'])
  })

  it('scratchRows：文件夹在前，文件行携带大小与时间文案', () => {
    const rows = scratchRows(buildScratchLevel(entries, `${TMP_FOLDER_PATH}/thesis/abc`))
    expect(rows).toHaveLength(2)
    const fileRow = rows.find((row) => row.kind === 'scratch') as Extract<
      (typeof rows)[number],
      { kind: 'scratch' }
    >
    expect(fileRow.path).toBe(`${TMP_FOLDER_PATH}/thesis/abc/preview.png`)
    expect(fileRow.sizeLabel).toBe('1 KB')
    expect(fileRow.modifiedLabel).not.toBe('—')
  })

  it('folderLabel：.tmp 显示为「资料 / .tmp」，根仍是「资料」', () => {
    expect(folderLabel('')).toBe('资料')
    expect(folderLabel(TMP_FOLDER_PATH)).toBe(`资料 / ${TMP_FOLDER_PATH}`)
    expect(folderLabel('docs/api')).toBe('docs / api')
  })
})
