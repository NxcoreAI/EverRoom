import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureWorkingCopyWritable } from '../src/main/office/working-copy'
import { writeBackEditedDocument } from '../src/main/office/write-back'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-write-back-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('writeBackEditedDocument', () => {
  it('replaces the original file with the edited working copy', async () => {
    const directory = await workspace()
    const workingCopy = join(directory, 'working.docx')
    const target = join(directory, 'original.docx')
    await writeFile(workingCopy, 'edited')
    await writeFile(target, 'original')

    await writeBackEditedDocument(workingCopy, target)

    expect(await readFile(target, 'utf8')).toBe('edited')
  })

  it('refuses to recreate a moved or unmounted folder', async () => {
    const directory = await workspace()
    const workingCopy = join(directory, 'working.xlsx')
    const target = join(directory, 'gone', 'report.xlsx')
    await writeFile(workingCopy, 'cells')

    await expect(writeBackEditedDocument(workingCopy, target)).rejects.toThrow(/original folder is unavailable/i)
    expect(await readdir(directory)).toEqual(['working.xlsx'])
  })

  it('writes through a symlink without replacing the link', async () => {
    const directory = await workspace()
    const workingCopy = join(directory, 'working.pptx')
    const realTarget = join(directory, 'real.pptx')
    const link = join(directory, 'linked.pptx')
    await writeFile(workingCopy, 'slides')
    await writeFile(realTarget, 'old')
    await symlink(realTarget, link)

    await writeBackEditedDocument(workingCopy, link)

    expect(await readFile(realTarget, 'utf8')).toBe('slides')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await realpath(link)).toBe(await realpath(realTarget))
  })

  it('fails without leaving a temporary file behind', async () => {
    const directory = await workspace()
    const target = join(directory, 'missing-source.docx')

    await expect(writeBackEditedDocument(join(directory, 'nope.docx'), target)).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })
})

describe('write-back permissions', () => {
  it('makes a read-only original writable after saving, keeping other bits', async () => {
    const directory = await workspace()
    const workingCopy = join(directory, 'working.docx')
    const target = join(directory, 'readonly.xlsx')
    await writeFile(workingCopy, 'edited')
    await writeFile(target, 'original')
    await chmod(target, 0o444)

    await writeBackEditedDocument(workingCopy, target)

    expect(await readFile(target, 'utf8')).toBe('edited')
    expect((await stat(target)).mode & 0o777).toBe(0o644)
  })
})

describe('working copy permissions', () => {
  it('makes a read-only working copy writable so the editor can save', async () => {
    const directory = await workspace()
    const copy = join(directory, 'readonly.docx')
    await writeFile(copy, 'bytes')
    await chmod(copy, 0o444)

    ensureWorkingCopyWritable(copy)

    expect((await stat(copy)).mode & 0o200).toBe(0o200)
    // 其余权限位保持不变（不把 444 改成 666）。
    expect((await stat(copy)).mode & 0o777).toBe(0o644)
  })
})
