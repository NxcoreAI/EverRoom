// @vitest-environment happy-dom
/**
 * 主页「技能」页（workbench/home/SkillsPage.tsx）的渲染测试。
 *
 * 数据形状与网关 `/v1/skills` 一致（mock `window.nxcore.agent`），验证四件事：
 * 1. 清单按归属 Agent 分组，启用计数来自真实数据；
 * 2. 搜索与归属筛选都在本地收敛，不重新请求；
 * 3. 开关走 `setSkillEnabled`，成功后界面更新、失败后回滚；
 * 4. 读取失败与「没有技能」区分开（失败给重试，空态不复用失败文案）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillDto } from '../src/shared/sources'
import { SkillsPage } from '../src/renderer/src/workbench/home/SkillsPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAMPLE_SKILLS: AgentSkillDto[] = [
  {
    id: 'builtin:main:document-export',
    name: 'document-export',
    description: '一次性把文档固定版本导出到飞书或 Notion',
    ownerId: 'main',
    ownerName: 'Main Agent',
    ownerKind: 'builtin',
    path: './skills/document-export',
    enabled: true,
    bytes: 2048,
    updatedAt: null,
  },
  {
    id: 'subagent:doc-writer:rewrite',
    name: 'rewrite',
    description: '只改写选中的文字片段',
    ownerId: 'doc-writer',
    ownerName: 'Document Writer',
    ownerKind: 'subagent',
    path: './skills/rewrite',
    enabled: true,
    bytes: 900,
    updatedAt: null,
  },
  {
    id: 'subagent:doc-writer:draft-create',
    name: 'draft-create',
    description: '按指令起草新文档',
    ownerId: 'doc-writer',
    ownerName: 'Document Writer',
    ownerKind: 'subagent',
    path: './skills/draft-create',
    enabled: false,
    bytes: 1200,
    updatedAt: '2026-11-02T10:00:00.000Z',
  },
]

interface SkillBridgeOptions {
  skills?: AgentSkillDto[]
  listFail?: boolean
  /** 针对具体技能 id 让 PATCH 失败。 */
  failOn?: string
  /** 选择文件夹的返回值（null＝用户取消）。 */
  pickedDirectory?: string | null
  /** 让写操作失败（传网关机器码，验证话术翻译）。 */
  mutateError?: string
}

function installSkillBridge(options: SkillBridgeOptions = {}) {
  // 可变清单：新增/删除后重新 listSkills 能拿到新状态（页面确实会 reload）。
  let skills = [...(options.skills ?? SAMPLE_SKILLS)]
  const snapshot = () => ({
    skills,
    counts: { total: skills.length, enabled: skills.filter((skill) => skill.enabled).length },
  })
  const guard = () => {
    if (options.mutateError) throw new Error(options.mutateError)
  }

  const setSkillEnabled = vi.fn(async (skillId: string, enabled: boolean) => {
    if (options.failOn === skillId) throw new Error('gateway unavailable')
    skills = skills.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill))
    const target = skills.find((skill) => skill.id === skillId)
    return { ...(target as AgentSkillDto), enabled }
  })
  const createSkill = vi.fn(async (input: { name: string; description: string; body: string }) => {
    guard()
    const created: AgentSkillDto = {
      id: `user:local:${input.name}`,
      name: input.name,
      description: input.description,
      ownerId: 'local',
      ownerName: '自定义技能',
      ownerKind: 'user',
      path: `agent/skills/${input.name}`,
      enabled: true,
      bytes: input.body.length,
      updatedAt: null,
    }
    skills = [...skills, created]
    return created
  })
  const importSkillDirectory = vi.fn(async (sourceDirectory: string) => {
    guard()
    const created: AgentSkillDto = {
      id: 'user:local:imported',
      name: 'imported',
      description: '来自文件夹',
      ownerId: 'local',
      ownerName: '自定义技能',
      ownerKind: 'user',
      path: 'agent/skills/imported',
      enabled: true,
      bytes: 100,
      updatedAt: null,
    }
    expect(sourceDirectory).toBe(options.pickedDirectory ?? '/tmp/my-skill')
    skills = [...skills, created]
    return created
  })
  const deleteSkill = vi.fn(async (skillId: string) => {
    guard()
    skills = skills.filter((skill) => skill.id !== skillId)
  })

  const agent = {
    listSkills: options.listFail
      ? vi.fn().mockRejectedValue(new Error('gateway unavailable'))
      : vi.fn(async () => snapshot()),
    getSkill: vi.fn(async (skillId: string) => {
      const skill = skills.find((entry) => entry.id === skillId)
      return skill ? { ...skill, prompt: '---\nname: rewrite\n---\n# Rewrite\n只改写片段。' } : null
    }),
    setSkillEnabled,
    createSkill,
    importSkillDirectory,
    // undefined＝用例没指定（默认给一个路径）；null＝用户取消。
    pickSkillDirectory: vi.fn(async () => (
      options.pickedDirectory === undefined ? '/tmp/my-skill' : options.pickedDirectory
    )),
    deleteSkill,
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = { agent }
  return { agent, setSkillEnabled, createSkill, importSkillDirectory, deleteSkill }
}

/** 自定义技能的固定行（删除/新增用例用）。 */
const USER_SKILL: AgentSkillDto = {
  id: 'user:local:weekly-report',
  name: 'weekly-report',
  description: '把本周邮件与会议汇总成周报',
  ownerId: 'local',
  ownerName: '自定义技能',
  ownerKind: 'user',
  path: 'agent/skills/weekly-report',
  enabled: true,
  bytes: 512,
  updatedAt: null,
}

let container: HTMLDivElement
let root: Root

async function flush(rounds = 8, step = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, step))
    })
  }
}

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<SkillsPage />)
  })
  await flush()
}

function text(): string {
  return container.textContent ?? ''
}

function toggles(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
}

function findButton(label: string, scope: ParentNode = container): HTMLButtonElement {
  // 分段按钮的 textContent 会带上计数（「子 Agent1」），所以用包含匹配。
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => (button.textContent ?? '').includes(label)
      || (button.getAttribute('aria-label') ?? '').includes(label))
  if (!found) throw new Error(`没有找到按钮：${label}`)
  return found
}

/** 弹窗渲染在 portal（document.body）里，查询得从 body 出发。 */
function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.ui-modal')
  if (!element) throw new Error('弹窗没有打开')
  return element
}

/** React 受控文本域/输入框：走原生 setter + input 事件。 */
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(2)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('技能页', () => {
  it('按归属 Agent 分组渲染清单与启用计数', async () => {
    installSkillBridge()
    await renderPage()

    expect(text()).toContain('技能')
    expect(text()).toContain('Main Agent')
    expect(text()).toContain('Document Writer')
    // 归属类别徽标 + 说明
    expect(text()).toContain('内置 Agent')
    expect(text()).toContain('子 Agent')
    // 启用计数：3 个里 2 个启用
    expect(text()).toContain('2 / 3 已启用')
    // 行内元信息
    expect(text()).toContain('./skills/document-export')
    expect(text()).toContain('2.0 KB')
    // 停用行有自己的状态文案
    expect(text()).toContain('已停用')
  })

  it('搜索与归属筛选在本地收敛', async () => {
    const { agent } = installSkillBridge()
    await renderPage()

    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索技能"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush(2)
    expect(text()).toContain('draft-create')
    expect(text()).not.toContain('document-export')

    await act(async () => { findButton('子 Agent').click() })
    await flush(2)
    expect(text()).toContain('draft-create')
    // 内置 Agent 分组整体隐藏
    expect(text()).not.toContain('Main Agent')

    // 搜索与筛选都是本地的：只请求过一次清单
    expect(agent.listSkills).toHaveBeenCalledTimes(1)
  })

  it('点开关写入网关；成功后更新状态文案', async () => {
    const { setSkillEnabled } = installSkillBridge()
    await renderPage()

    // 第一行（builtin 组）默认启用 → 点一下应停用
    await act(async () => { toggles()[0]!.click() })
    await flush(4)

    expect(setSkillEnabled).toHaveBeenCalledWith('builtin:main:document-export', false)
    expect(toggles()[0]!.getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('1 / 3 已启用')
  })

  it('切换失败时回滚并提示', async () => {
    const { setSkillEnabled } = installSkillBridge({ failOn: 'builtin:main:document-export' })
    const toastSpy = vi.fn()
    window.addEventListener('everroom:workbench-toast', toastSpy as EventListener)
    await renderPage()

    await act(async () => { toggles()[0]!.click() })
    await flush(4)

    expect(setSkillEnabled).toHaveBeenCalledTimes(1)
    // 回滚：开关仍是启用
    expect(toggles()[0]!.getAttribute('aria-checked')).toBe('true')
    expect(toastSpy).toHaveBeenCalled()
    window.removeEventListener('everroom:workbench-toast', toastSpy as EventListener)
  })

  it('清单读取失败给重试，而不是装作没有技能', async () => {
    installSkillBridge({ listFail: true })
    await renderPage()

    expect(text()).toContain('技能清单读取失败')
    expect(text()).not.toContain('当前没有可用的技能')
    expect(findButton('重试')).toBeTruthy()
  })

  it('点行打开详情，展示 SKILL.md 原文', async () => {
    const { agent } = installSkillBridge()
    await renderPage()

    const row = container.querySelector<HTMLButtonElement>('.wb-skills-row-main')
    await act(async () => { row!.click() })
    await flush(4)

    expect(agent.getSkill).toHaveBeenCalledWith('builtin:main:document-export')
    expect(document.body.textContent ?? '').toContain('# Rewrite')
  })
})

describe('技能页：新增与删除', () => {
  it('手写技能：提交后调用网关并刷新清单', async () => {
    const { agent, createSkill } = installSkillBridge()
    await renderPage()

    await act(async () => { findButton('新增技能').click() })
    await flush(2)
    const dialogScope = dialog()
    await fill(dialogScope.querySelector<HTMLInputElement>('input[placeholder="weekly-report"]')!, 'weekly-report')
    await fill(
      dialogScope.querySelector<HTMLInputElement>('input[placeholder="把本周邮件与会议汇总成周报"]')!,
      '把本周邮件与会议汇总成周报',
    )
    await fill(dialogScope.querySelector<HTMLTextAreaElement>('textarea')!, '# 周报\n\n先列结论。')

    await act(async () => { findButton('创建技能', dialogScope).click() })
    await flush(6)

    expect(createSkill).toHaveBeenCalledWith({
      name: 'weekly-report',
      description: '把本周邮件与会议汇总成周报',
      body: '# 周报\n\n先列结论。',
    })
    // 初次加载 + 新增后刷新
    expect(agent.listSkills).toHaveBeenCalledTimes(2)
    expect(text()).toContain('weekly-report')
    expect(text()).toContain('自定义技能')
  })

  it('从文件夹导入：选目录后调用导入接口', async () => {
    const { importSkillDirectory } = installSkillBridge({ pickedDirectory: '/Users/me/skills/my-skill' })
    await renderPage()

    await act(async () => { findButton('新增技能').click() })
    await flush(2)
    await act(async () => { findButton('从文件夹导入', dialog()).click() })
    await flush(2)
    await act(async () => { findButton('选择文件夹', dialog()).click() })
    await flush(6)

    expect(importSkillDirectory).toHaveBeenCalledWith('/Users/me/skills/my-skill')
    expect(text()).toContain('imported')
  })

  it('取消选择文件夹时不发起导入', async () => {
    const { importSkillDirectory } = installSkillBridge({ pickedDirectory: null })
    await renderPage()

    await act(async () => { findButton('新增技能').click() })
    await flush(2)
    await act(async () => { findButton('从文件夹导入', dialog()).click() })
    await flush(2)
    await act(async () => { findButton('选择文件夹', dialog()).click() })
    await flush(4)

    expect(importSkillDirectory).not.toHaveBeenCalled()
  })

  it('网关拒绝时把机器码翻成用户话术', async () => {
    installSkillBridge({ mutateError: 'skill_source_missing_manifest' })
    await renderPage()

    await act(async () => { findButton('新增技能').click() })
    await flush(2)
    await act(async () => { findButton('从文件夹导入', dialog()).click() })
    await flush(2)
    await act(async () => { findButton('选择文件夹', dialog()).click() })
    await flush(6)

    expect(dialog().textContent ?? '').toContain('这个文件夹里没有 SKILL.md')
  })

  it('只有自定义技能能删；确认后调用删除接口', async () => {
    const { deleteSkill, agent } = installSkillBridge({ skills: [...SAMPLE_SKILLS, USER_SKILL] })
    await renderPage()

    // 三行内置/子 Agent 技能没有删除按钮，只有自定义那一行有。
    const deleteButtons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="删除「"]')]
    expect(deleteButtons).toHaveLength(1)

    await act(async () => { deleteButtons[0]!.click() })
    await flush(2)
    await act(async () => { findButton('删除', dialog()).click() })
    await flush(6)

    expect(deleteSkill).toHaveBeenCalledWith('user:local:weekly-report')
    expect(agent.listSkills).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain('weekly-report')
  })
})
