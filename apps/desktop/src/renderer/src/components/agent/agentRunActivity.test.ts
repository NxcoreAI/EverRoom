import type { AgentEvent, SubagentInvocationEvent, SubagentInvocationNode } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { toolKind } from './AgentExecutionTimeline'
import {
  agentToolLabel,
  agentToolResultSummary,
  agentToolStageText,
  agentToolSubject,
  buildTimelineRows,
  createAgentRunActivityAccumulator,
  foldAgentRunActivityEvent,
  reduceAgentRunActivity,
  reduceSubagentInvocationTools,
  snapshotAgentRunActivity,
  subagentChainLabel,
  subagentInvocationStatus,
  type AgentActivityStep,
} from './agentRunActivity'
import { translate } from '../../i18n/LocaleContext'

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
  it('localizes generated tool status text without translating user-provided subjects', () => {
    const t = (message: string, values?: Record<string, string | number>) => translate('en-US', message, values)
    const tool = {
      id: 'read-1', runId: 'run-1', name: 'read_file', args: { path: '配置.md' },
      status: 'completed' as const, startedAt: new Date().toISOString(),
    }
    expect(agentToolLabel(tool, false, t)).toBe('Read file')
    expect(agentToolLabel(tool, true, t)).toBe('File read')
    expect(agentToolLabel({ ...tool, name: 'custom_tool' }, true, t)).toBe('Executed custom tool')
    expect(agentToolResultSummary({ results: [1, 2] }, t)).toBe('2 results')
    expect(agentToolStageText({ ...tool, status: 'stopped' }, t)).toBe('Stopped')
    expect(agentToolSubject(tool)).toBe('配置.md')
  })

  it('labels dispatch tools as delegations instead of file edits (dispatch contains "patch")', () => {
    const t = (message: string, values?: Record<string, string | number>) => translate('en-US', message, values)
    const tool = {
      id: 'dispatch-1', runId: 'run-1', name: 'local_agent_dispatch', args: { task: '审查这个实现' },
      status: 'completed' as const, startedAt: new Date().toISOString(),
    }
    expect(agentToolLabel(tool, false, t)).toBe('Delegate to local Agent')
    expect(agentToolLabel(tool, true, t)).toBe('Delegated to local Agent')
    expect(agentToolLabel({ ...tool, name: 'agent_dispatch' }, true, t)).toBe('Subagent dispatched')
    expect(agentToolSubject(tool)).toBe('审查这个实现')
  })

  it('labels knowledge tools distinctly from web search and file reads', () => {
    const t = (message: string, values?: Record<string, string | number>) => translate('en-US', message, values)
    const tool = {
      id: 'wiki-1', runId: 'run-1', name: 'wiki_search', args: { query: 'OIDC 设备授权' },
      status: 'completed' as const, startedAt: new Date().toISOString(),
    }
    expect(agentToolLabel(tool, false, t)).toBe('Search the knowledge base')
    expect(agentToolLabel(tool, true, t)).toBe('Knowledge base search completed')
    expect(agentToolLabel({ ...tool, name: 'wiki_read' }, false, t)).toBe('Read knowledge base page')
    expect(agentToolLabel({ ...tool, name: 'wiki_read' }, true, t)).toBe('Knowledge base page read')
    expect(agentToolLabel({ ...tool, name: 'conversation_search' }, true, t)).toBe('Past conversations searched')
    expect(agentToolLabel({ ...tool, name: 'web_search' }, true, t)).toBe('Web search completed')
  })

  it('maps connector tools to distinct timeline presentations', () => {
    const tools = [
      { name: 'connector_search', args: { service: 'gmail', query: 'find messages' } },
      { name: 'connector_schema', args: { service: 'notion', name: 'create_page' } },
      { name: 'connector_apps', args: { service: 'github' } },
      { name: 'connector_run', args: { service: 'slack', name: 'send_message' } },
    ].map((tool, index) => ({
      id: `connector-${index}`,
      runId: 'run-1',
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      ...tool,
    }))

    expect(tools.map((tool) => toolKind(tool.name))).toEqual(['search', 'schema', 'connector', 'action'])
    expect(tools.map((tool) => agentToolLabel(tool))).toEqual([
      '查找可用操作',
      '查看操作要求',
      '获取连接账户',
      '执行连接操作',
    ])
    expect(tools.map((tool) => agentToolSubject(tool))).toEqual([
      'gmail · find messages',
      'notion · create_page',
      'github',
      'slack · send_message',
    ])
  })

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

  it('drops the abandoned retry wave when the run restarts its message body (#199)', () => {
    const activity = reduceAgentRunActivity([
      event(1, 'tool.started', { toolCallId: 'read-1', name: 'read_file', args: {} }),
      event(2, 'tool.completed', { toolCallId: 'read-1', name: 'read_file', result: { content: 'ok' } }),
      event(3, 'message.started', { role: 'assistant' }),
      event(4, 'message.delta', { delta: '第一波半截正文' }),
      // pi 自动重试：上一波被运行时丢弃，message.started 重发表示从头生成
      event(5, 'message.started', { role: 'assistant' }),
      event(6, 'message.delta', { delta: '第二波完整正文' }),
      event(7, 'run.completed'),
    ])

    expect(activity.finalAnswer).toBe('第二波完整正文')
    expect(activity.pendingAnswer).toBe('')
  })
})

describe('subagent timeline rows', () => {
  function invocation(overrides: Partial<SubagentInvocationNode> & { id: string }): SubagentInvocationNode {
    return {
      agentDefinitionId: 'researcher',
      agentRevisionId: 'revision-1',
      source: 'primary_agent',
      parentSessionId: 'session-1',
      parentRunId: 'run-1',
      task: '研究任务',
      input: null,
      status: 'completed',
      result: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-09-29T10:00:02.000Z',
      startedAt: '2026-09-29T10:00:02.000Z',
      completedAt: '2026-09-29T10:00:30.000Z',
      agentName: 'Researcher',
      ...overrides,
    }
  }

  it('labels nested invocations with the parent chain and keeps run-level ones plain', () => {
    const byId = new Map([
      ['parent-inv', invocation({ id: 'parent-inv', agentName: 'Document Writer' })],
      ['child-inv', invocation({
        id: 'child-inv',
        agentName: 'Content Analyst',
        parentRunId: 'parent-inv',
      })],
    ])
    expect(subagentChainLabel(byId.get('parent-inv')!, byId, 'run-1')).toBe('Document Writer')
    expect(subagentChainLabel(byId.get('child-inv')!, byId, 'run-1')).toBe('Document Writer → Content Analyst')
    // 链路中断（父调用不在树里）时退回单名
    expect(subagentChainLabel(byId.get('child-inv')!, new Map(), 'run-1')).toBe('Content Analyst')
  })

  it('merges tool steps and subagent invocations into one chronological list', () => {
    const steps: AgentActivityStep[] = [{
      id: 'dispatch-1',
      sequence: 1,
      tool: {
        id: 'dispatch-1', runId: 'run-1', name: 'document_draft', args: {},
        status: 'completed', startedAt: '2026-09-29T10:00:01.000Z',
        completedAt: '2026-09-29T10:01:00.000Z',
      },
      beforeText: '',
      afterText: '',
    }]
    const invocations = [
      invocation({
        id: 'nested-inv',
        agentName: 'Content Analyst',
        parentRunId: 'parent-inv',
        status: 'running',
        createdAt: '2026-09-29T10:00:20.000Z',
        startedAt: '2026-09-29T10:00:21.000Z',
        completedAt: null,
      }),
      invocation({
        id: 'parent-inv',
        agentName: 'Document Writer',
        status: 'running',
        completedAt: null,
      }),
    ]
    const rows = buildTimelineRows(steps, invocations, 'run-1')
    expect(rows.map((row) => row.key)).toEqual(['dispatch-1', 'subagent-parent-inv', 'subagent-nested-inv'])
    expect(rows[0]!.kind).toBe('tool')
    const parentRow = rows[1]!
    expect(parentRow.kind).toBe('subagent')
    if (parentRow.kind === 'subagent') {
      expect(parentRow.subagent.label).toBe('Document Writer')
      expect(parentRow.subagent.status).toBe('running')
    }
    const nestedRow = rows[2]!
    expect(nestedRow.kind).toBe('subagent')
    if (nestedRow.kind === 'subagent') {
      expect(nestedRow.subagent.label).toBe('Document Writer → Content Analyst')
      expect(nestedRow.subagent.status).toBe('running')
    }
  })
  it('调度类工具行在它的子代理行已展示时去重：只留子代理那一步', () => {
    const dispatchStep = (id: string, invocationId: string | undefined): AgentActivityStep => ({
      id,
      sequence: 1,
      tool: {
        id, runId: 'run-1', name: 'agent_dispatch', args: { agentId: 'researcher', task: '研究任务' },
        status: 'completed', startedAt: '2026-09-29T10:00:01.000Z',
        completedAt: '2026-09-29T10:00:30.000Z',
        ...(invocationId
          ? { result: { content: JSON.stringify({ invocationId }), details: { id: invocationId, agentDefinitionId: 'researcher' } } }
          : {}),
      },
      beforeText: '',
      afterText: '',
    })
    const invocations = [invocation({ id: 'inv-9', agentName: 'Researcher', status: 'running', completedAt: null })]

    // 调用已展示：dispatch 工具行去重，只留子代理行。
    const deduped = buildTimelineRows([dispatchStep('d-1', 'inv-9')], invocations, 'run-1')
    expect(deduped.map((row) => row.kind)).toEqual(['subagent'])
    expect(deduped[0]!.key).toBe('subagent-inv-9')

    // 调用不在展示列表（派发失败没产生调用 / 轮询未到）：工具行保留。
    const kept = buildTimelineRows([dispatchStep('d-1', 'inv-9')], [], 'run-1')
    expect(kept.map((row) => row.kind)).toEqual(['tool'])

    // 结果未回的运行中 dispatch 行照常显示，调用行出现后自然去重。
    const pending = buildTimelineRows([dispatchStep('d-2', undefined)], invocations, 'run-1')
    expect(pending.map((row) => row.kind)).toEqual(['tool', 'subagent'])
  })


  it('maps invocation terminal statuses and surfaces the error message', () => {
    expect(subagentInvocationStatus('accepted')).toBe('pending')
    expect(subagentInvocationStatus('running')).toBe('running')
    expect(subagentInvocationStatus('completed')).toBe('completed')
    expect(subagentInvocationStatus('failed')).toBe('error')
    expect(subagentInvocationStatus('timed_out')).toBe('error')
    expect(subagentInvocationStatus('cancelled')).toBe('stopped')
    expect(subagentInvocationStatus('interrupted')).toBe('stopped')
    const rows = buildTimelineRows([], [invocation({
      id: 'failed-inv',
      status: 'failed',
      errorCode: 'timeout',
      errorMessage: null,
    })], 'run-1')
    expect(rows[0]!.kind).toBe('subagent')
    if (rows[0]!.kind === 'subagent') {
      expect(rows[0]!.subagent.status).toBe('error')
      expect(rows[0]!.subagent.errorMessage).toBe('错误码 timeout')
    }
  })

  it('incremental fold matches the full replay for a mixed tool/stream/failure run', () => {
    const events: AgentEvent[] = [
      event(1, 'run.started'),
      event(2, 'reasoning.delta', { delta: '想想。' }),
      event(3, 'message.delta', { delta: '先看一眼' }),
      event(4, 'tool.started', { toolCallId: 'search-1', name: 'web_search', args: { query: 'EverRoom' } }),
      event(5, 'message.delta', { delta: '，再搜' }),
      event(6, 'tool.completed', { toolCallId: 'search-1', result: { results: [1, 2, 3] } }),
      event(7, 'tool.started', { toolCallId: 'read-1', name: 'read_file', args: { path: 'a.md' } }),
      event(8, 'tool.failed', { toolCallId: 'read-1', message: '不存在' }),
      // pi 自动重试：重启消息体丢弃上一波半截正文
      event(9, 'message.started', { role: 'assistant' }),
      event(10, 'message.delta', { delta: '重写正文' }),
      event(11, 'tool.started', { toolCallId: 'read-2', name: 'read_file', args: { path: 'b.md' } }),
      event(12, 'tool.completed', { toolCallId: 'read-2', result: 'ok' }),
      event(13, 'run.failed', { message: '中断' }),
    ]
    const full = reduceAgentRunActivity(events)

    const acc = createAgentRunActivityAccumulator()
    for (const item of events) foldAgentRunActivityEvent(acc, item)
    const incremental = snapshotAgentRunActivity(acc)

    expect(incremental).toEqual(full)
    expect(incremental.steps.map((step) => step.id)).toEqual(['search-1', 'read-1', 'read-2'])
    expect(incremental.completed).toBe(false)

    // 无观察变化的事件必须返回 false（跳过无谓重渲染）；正文/思考的清空
    // 属于消息流（reduceAgentRunEvents/useAgentSession），不在活动折算范围。
    const settled = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvent(settled, event(1, 'run.started'))
    foldAgentRunActivityEvent(settled, event(2, 'message.started', { role: 'assistant' }))
    expect(foldAgentRunActivityEvent(settled, event(3, 'message.started', { role: 'assistant' }))).toBe(false)
    expect(foldAgentRunActivityEvent(settled, event(4, 'run.completed'))).toBe(true)
    expect(foldAgentRunActivityEvent(settled, event(5, 'run.completed'))).toBe(false)
    expect(foldAgentRunActivityEvent(settled, event(6, 'reasoning.delta', { delta: '忽略' }))).toBe(false)
    expect(foldAgentRunActivityEvent(settled, event(7, 'message.delta', { delta: '' }))).toBe(false)
  })

  it('snapshot copies steps so later fold mutations do not leak into previous snapshots', () => {
    const acc = createAgentRunActivityAccumulator()
    foldAgentRunActivityEvent(acc, event(1, 'tool.started', { toolCallId: 'a-1', name: 'web_search', args: {} }))
    const first = snapshotAgentRunActivity(acc)
    foldAgentRunActivityEvent(acc, event(2, 'message.delta', { delta: '第一段话' }))
    foldAgentRunActivityEvent(acc, event(3, 'tool.started', { toolCallId: 'b-2', name: 'read_file', args: {} }))
    const second = snapshotAgentRunActivity(acc)
    // 新工具到达时会把积压正文写进上一个 step 的 afterText；早先的快照不能被改到。
    expect(first.steps[0]!.afterText).toBe('')
    expect(second.steps[0]!.afterText).not.toBe('')
    expect(acc.steps[0]!.afterText).toBe(second.steps[0]!.afterText)
  })
})

describe('subagent invocation tool flow', () => {
  function invocationEvent(seq: number, type: SubagentInvocationEvent['type'], payload: unknown = {}): SubagentInvocationEvent {
    return {
      id: `inv-event-${seq}`,
      invocationId: 'inv-1',
      seq,
      type,
      payload,
      occurredAt: new Date(seq * 1_000).toISOString(),
    }
  }

  it('folds tool events into display calls and skips non-tool events', () => {
    const tools = reduceSubagentInvocationTools('inv-1', [
      invocationEvent(1, 'run.started'),
      invocationEvent(2, 'tool.requested', { toolCallId: 'call-1', name: 'wiki_search', args: { query: 'EverRoom' } }),
      invocationEvent(3, 'tool.started', { toolCallId: 'call-1' }),
      invocationEvent(4, 'tool.completed', { toolCallId: 'call-1', name: 'wiki_search', result: { results: [1, 2, 3] } }),
      invocationEvent(5, 'message.completed', { role: 'assistant', content: '完成。' }),
    ])
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'call-1',
      name: 'wiki_search',
      runId: 'inv-1',
      status: 'completed',
    })
    expect(agentToolResultSummary(tools[0]!.result)).toContain('3')
  })

  it('sorts out-of-order input by seq and surfaces failures', () => {
    const tools = reduceSubagentInvocationTools('inv-1', [
      invocationEvent(3, 'tool.completed', { toolCallId: 'call-1', name: 'wiki_search', result: {} }),
      invocationEvent(2, 'tool.started', { toolCallId: 'call-1' }),
      invocationEvent(1, 'tool.requested', { toolCallId: 'call-1', name: 'wiki_search', args: {} }),
      invocationEvent(4, 'tool.failed', { toolCallId: 'call-2', name: 'context_room_write_commit', message: '写入冲突' }),
    ])
    expect(tools.map((tool) => tool.id)).toEqual(['call-1', 'call-2'])
    expect(tools[0]!.status).toBe('completed')
    expect(tools[1]!.status).toBe('error')
    expect(tools[1]!.error).toBe('写入冲突')
  })
})
