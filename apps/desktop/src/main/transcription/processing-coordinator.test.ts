import { describe, expect, it } from 'vitest'

import { parseSummary, SummaryValidationError } from './processing-coordinator'
import { buildTranscript, LEGIT_SUMMARY } from './transcription-test-fixtures'

const validSummaryJson = JSON.stringify({
  eventType: 'MEETING',
  title: '项目周会',
  overview: LEGIT_SUMMARY,
  keyPoints: ['评审意见下周三前交付', '数据源延迟是主要风险', '数据侧先给缓冲方案', '各负责人会后确认时间点'],
  decisions: ['由数据侧先给出缓冲方案'],
  actionItems: [{ text: '确认交付时间点', owner: '各负责人', dueDate: null }],
  unresolvedQuestions: [],
  topics: ['项目进度'],
  representativeTags: [],
})

describe('parseSummary', () => {
  it('接受结构完整、内容经重新组织的总结', () => {
    const transcript = buildTranscript()
    const summary = parseSummary(validSummaryJson, transcript)
    expect(summary.title).toBe('项目周会')
    expect(summary.keyPoints).toHaveLength(4)
  })

  it('overview 整段照抄逐字稿时拒绝并携带修复提示（#260）', () => {
    const transcript = buildTranscript()
    const echoed = JSON.stringify({ ...JSON.parse(validSummaryJson), overview: transcript })
    try {
      parseSummary(echoed, transcript)
      expect.unreachable('回显总结应被拒绝')
    } catch (error) {
      expect(error).toBeInstanceOf(SummaryValidationError)
      expect((error as SummaryValidationError).message).toBe('echoed_transcript_summary')
      expect((error as SummaryValidationError).hint).toContain('整段照抄')
    }
  })

  it('篇幅不足仍返回 incomplete_agent_summary，不被回显检查遮蔽', () => {
    const transcript = buildTranscript()
    const sparse = JSON.stringify({ ...JSON.parse(validSummaryJson), overview: '太短', keyPoints: ['只有一条'] })
    expect(() => parseSummary(sparse, transcript)).toThrow('incomplete_agent_summary')
  })
})
