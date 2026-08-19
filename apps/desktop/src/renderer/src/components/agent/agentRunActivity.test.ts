import type { AgentEvent } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { agentToolStageText, reduceAgentRunActivity } from './agentRunActivity'

function event(seq: number, type: AgentEvent['type'], payload: unknown = {}): AgentEvent {
  return {
    id: `event-${seq}`,
    sessionId: 'session-1',
    runId: 'run-1',
    seq,
    type,
    occurredAt: new Date(seq * 1_000).toISOString(),
    payload,
  }
}

describe('Agent run activity', () => {
  it('keeps commentary and tools in event order and separates the final answer', () => {
    const activity = reduceAgentRunActivity([
      event(1, 'run.started'),
      event(2, 'message.delta', { delta: '先读取配置。' }),
      event(3, 'tool.started', { toolCallId: 'read-1', name: 'read_file', args: { path: 'app.ts' } }),
      event(4, 'tool.updated', { toolCallId: 'read-1', partialResult: { bytes: 20 } }),
      event(5, 'tool.completed', { toolCallId: 'read-1', result: { bytes: 40 } }),
      event(6, 'message.delta', { delta: '已找到入口，继续检查调用方。' }),
      event(7, 'tool.started', { toolCallId: 'search-1', name: 'search', args: { query: 'start' } }),
      event(8, 'tool.completed', { toolCallId: 'search-1', result: { results: [1, 2] } }),
      event(9, 'message.delta', { delta: '检查完成，调用关系正常。' }),
      event(10, 'message.completed', { content: '先读取配置。已找到入口，继续检查调用方。检查完成，调用关系正常。' }),
      event(11, 'run.completed'),
    ])

    expect(activity.steps).toHaveLength(2)
    expect(activity.steps[0]).toMatchObject({
      beforeText: '先读取配置。',
      afterText: '已找到入口，继续检查调用方。',
      tool: { id: 'read-1', status: 'completed', result: { bytes: 40 } },
    })
    expect(activity.pendingAnswer).toBe('')
    expect(activity.finalAnswer).toBe('检查完成，调用关系正常。')
  })

  it('keeps partial text and the terminal tool state when a run fails', () => {
    const activity = reduceAgentRunActivity([
      event(1, 'message.delta', { delta: '正在读取。' }),
      event(2, 'tool.started', { toolCallId: 'read-1', name: 'read_file', args: {} }),
      event(3, 'run.failed', { message: '读取失败' }),
    ])

    expect(activity.completed).toBe(false)
    expect(activity.pendingAnswer).toBe('')
    expect(activity.finalAnswer).toBe('')
    expect(activity.steps).toMatchObject([{
      beforeText: '正在读取。',
      tool: { id: 'read-1', status: 'error' },
    }])
  })

  it('provides factual stage text when tools finish before the only assistant answer', () => {
    const events = [
      event(1, 'run.started'),
      event(2, 'tool.started', {
        toolCallId: 'read-1', name: 'context_room_document_read', args: { title: '后端技术文档' },
      }),
      event(3, 'tool.completed', {
        toolCallId: 'read-1', name: 'context_room_document_read', result: { title: '后端技术文档' },
      }),
      event(4, 'tool.started', {
        toolCallId: 'patch-1', name: 'context_room_patch_begin', args: { title: '后端技术文档' },
      }),
      event(5, 'tool.completed', {
        toolCallId: 'patch-1', name: 'context_room_patch_begin', result: { summary: '已准备续写内容' },
      }),
      event(6, 'message.delta', { delta: '文档续写已经准备完成。' }),
      event(7, 'message.completed', { content: '文档续写已经准备完成。' }),
    ]
    const streaming = reduceAgentRunActivity(events)

    expect(streaming.steps).toHaveLength(2)
    expect(agentToolStageText(streaming.steps[0]!.tool)).toBe('')
    expect(agentToolStageText(streaming.steps[1]!.tool)).toBe('已准备续写内容。')
    expect(streaming.pendingAnswer).toBe('文档续写已经准备完成。')
    expect(streaming.finalAnswer).toBe('')

    const completed = reduceAgentRunActivity([...events, event(8, 'run.completed')])
    expect(completed.pendingAnswer).toBe('')
    expect(completed.finalAnswer).toBe('文档续写已经准备完成。')
  })

  it('shows distinct stage facts for the document patch tool chain', () => {
    const tools = [
      event(1, 'tool.completed', {
        toolCallId: 'read-1',
        name: 'context_room_document_read',
        result: { structuredContent: { title: '后端技术文档', version: 3, blockCount: 8 } },
      }),
      event(2, 'tool.completed', {
        toolCallId: 'begin-1',
        name: 'context_room_patch_begin',
        args: { summary: '补充部署与排障说明' },
        result: { structuredContent: { state: 'running' } },
      }),
      event(3, 'tool.completed', {
        toolCallId: 'hunk-1',
        name: 'context_room_patch_hunk',
        args: { sequence: 1, operation: 'replace', markdown: '新的部署说明' },
        result: { structuredContent: { acceptedSequence: 1 } },
      }),
      event(4, 'tool.completed', {
        toolCallId: 'commit-1',
        name: 'context_room_patch_commit',
        result: { structuredContent: { message: '修改建议已准备好，需要用户审阅后才会应用。' } },
      }),
    ]
    const activity = reduceAgentRunActivity(tools)

    expect(activity.steps.map((step) => agentToolStageText(step.tool))).toEqual([
      '《后端技术文档》当前有 8 个可编辑内容块，基于版本 3 处理。',
      '修改范围已确定：补充部署与排障说明。',
      '第 1 项为替换内容，建议内容 6 字。',
      '修改建议已准备好，需要用户审阅后才会应用。',
    ])
  })

  it('removes tool status narration while preserving meaningful commentary', () => {
    const activity = reduceAgentRunActivity([
      event(1, 'message.delta', { delta: '开始创建文档：个人知识管理指南。' }),
      event(2, 'tool.started', {
        toolCallId: 'begin-1', name: 'context_room_write_begin', args: { title: '个人知识管理指南' },
      }),
      event(3, 'tool.completed', {
        toolCallId: 'begin-1', name: 'context_room_write_begin', result: { title: '个人知识管理指南' },
      }),
      event(4, 'message.delta', { delta: '接下来写入文档内容。' }),
      event(5, 'tool.started', {
        toolCallId: 'append-1', name: 'context_room_write_append', args: { title: '个人知识管理指南' },
      }),
      event(6, 'tool.completed', {
        toolCallId: 'append-1', name: 'context_room_write_append', result: { title: '个人知识管理指南' },
      }),
      event(7, 'message.delta', { delta: '正文包含信息收集、组织与复盘三个部分。接下来提交新文档。' }),
      event(8, 'tool.started', {
        toolCallId: 'commit-1', name: 'context_room_write_commit', args: { title: '个人知识管理指南' },
      }),
      event(9, 'tool.completed', {
        toolCallId: 'commit-1', name: 'context_room_write_commit', result: { title: '个人知识管理指南' },
      }),
    ])

    expect(activity.steps.map((step) => step.beforeText)).toEqual(['', '', ''])
    expect(activity.steps.map((step) => step.afterText)).toEqual([
      '',
      '正文包含信息收集、组织与复盘三个部分。',
      '',
    ])
    expect(activity.steps.map((step) => agentToolStageText(step.tool))).toEqual(['', '', ''])
  })

  it('replaces copied document content with a short completion message', () => {
    const document = '数据库技术文档介绍数据模型、索引设计、事务隔离、查询优化和备份恢复。'.repeat(18)
    const activity = reduceAgentRunActivity([
      event(1, 'tool.started', {
        toolCallId: 'append-1', name: 'context_room_write_append', args: { text: document },
      }),
      event(2, 'tool.completed', {
        toolCallId: 'append-1', name: 'context_room_write_append', result: { acceptedSequence: 1 },
      }),
      event(3, 'tool.started', {
        toolCallId: 'commit-1', name: 'context_room_write_commit', args: { finalSequence: 1 },
      }),
      event(4, 'tool.completed', {
        toolCallId: 'commit-1',
        name: 'context_room_write_commit',
        result: { details: { navigation: { title: '数据库技术指南' } } },
      }),
      event(5, 'message.delta', { delta: document }),
      event(6, 'run.completed'),
    ])

    expect(activity.finalAnswer).toBe(
      '文档《数据库技术指南》已创建完成，内容已写入对应工作区。你可以在文档中继续查看或编辑。',
    )
  })

  it('preserves a genuine short document summary', () => {
    const summary = '文档已完成，涵盖数据模型、索引设计和事务隔离，并补充了查询优化与备份建议。'
    const activity = reduceAgentRunActivity([
      event(1, 'tool.started', {
        toolCallId: 'append-1', name: 'context_room_write_append', args: { text: '数据库正文。'.repeat(80) },
      }),
      event(2, 'tool.completed', {
        toolCallId: 'append-1', name: 'context_room_write_append', result: { acceptedSequence: 1 },
      }),
      event(3, 'tool.started', {
        toolCallId: 'commit-1', name: 'context_room_write_commit', args: { finalSequence: 1 },
      }),
      event(4, 'tool.completed', {
        toolCallId: 'commit-1',
        name: 'context_room_write_commit',
        result: { details: { navigation: { title: '数据库技术指南' } } },
      }),
      event(5, 'message.delta', { delta: summary }),
      event(6, 'run.completed'),
    ])

    expect(activity.finalAnswer).toBe(summary)
  })
})
