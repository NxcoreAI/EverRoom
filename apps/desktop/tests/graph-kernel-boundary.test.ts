import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const GRAPH_KERNEL_ROOT = fileURLToPath(new URL('../src/renderer/src/components/graph', import.meta.url))
const RENDERER_SRC_ROOT = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/** 内核禁区词表（设计文档 R1）：通用图谱内核不得出现任何领域名词。 */
const FORBIDDEN_DOMAIN_WORDS = /\b(room|wiki|fact|entity|entities|memory|knowledge)s?\b/i
/** 使用面引入内核只能走公开门面（R3），禁止深路径。 */
const DEEP_KERNEL_IMPORT = /['"][^'"]*components\/graph\/(?!index['"])[^'"]*['"]/

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSourceFiles(path)
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : []
  })
}

describe('graph kernel boundary', () => {
  it('keeps domain vocabulary out of the generic graph kernel', () => {
    const offenders = listSourceFiles(GRAPH_KERNEL_ROOT)
      .map((file) => {
        const match = readFileSync(file, 'utf8').match(FORBIDDEN_DOMAIN_WORDS)
        return match ? `${file.replace(`${GRAPH_KERNEL_ROOT}/`, '')}: "${match[0]}"` : null
      })
      .filter((line): line is string => line !== null)
    // 出现领域词说明有领域知识漏进内核：把映射/配色/文案挪回使用面，或改成中性命名。
    expect(offenders).toEqual([])
  })

  it('routes renderer kernel imports through the public facade', () => {
    const offenders = listSourceFiles(RENDERER_SRC_ROOT)
      .filter((file) => !file.startsWith(`${GRAPH_KERNEL_ROOT}/`))
      .map((file) => {
        const match = readFileSync(file, 'utf8').match(DEEP_KERNEL_IMPORT)
        return match ? `${file.replace(`${RENDERER_SRC_ROOT}/`, '')}: ${match[0]}` : null
      })
      .filter((line): line is string => line !== null)
    // 深路径引用会绕开门面，内核内部结构调整时直接波及使用面。
    expect(offenders).toEqual([])
  })
})
