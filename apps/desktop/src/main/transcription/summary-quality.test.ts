import { describe, expect, it } from 'vitest'

import { looksLikeTranscriptEcho, summaryDetailMinimum } from './summary-quality'
import { buildTranscript, LEGIT_SUMMARY } from './transcription-test-fixtures'

describe('looksLikeTranscriptEcho', () => {
  it('识别整段原样照抄（含时间戳格式）的回显', () => {
    const transcript = buildTranscript()
    expect(looksLikeTranscriptEcho(transcript, transcript)).toBe(true)
  })

  it('识别剥掉时间戳说话人标记后的正文照抄', () => {
    const transcript = buildTranscript()
    const stripped = transcript.split('\n').map((line) => line.replace(/^\[\d{2}:\d{2}\]\s*\S+：/, '')).join('\n')
    expect(stripped.length).toBeGreaterThan(200)
    expect(looksLikeTranscriptEcho(stripped, transcript)).toBe(true)
  })

  it('识别正规内容与原文拷贝拼接的半回显', () => {
    const transcript = buildTranscript()
    expect(looksLikeTranscriptEcho(`${LEGIT_SUMMARY}\n\n${transcript}`, transcript)).toBe(true)
  })

  it('放行重新组织的正规总结', () => {
    const transcript = buildTranscript()
    expect(looksLikeTranscriptEcho(LEGIT_SUMMARY, transcript)).toBe(false)
  })

  it('放行含单处长引用的总结，不把局部引用当回显', () => {
    const transcript = buildTranscript()
    const quote = transcript.split('\n')[10]!.replace(/^\[\d{2}:\d{2}\]\s*/, '')
    expect(looksLikeTranscriptEcho(`${LEGIT_SUMMARY}原话是「${quote}」。`, transcript)).toBe(false)
  })

  it('过短的总结或过短的原文不判定为回显（交由其他校验兜底）', () => {
    const transcript = buildTranscript()
    expect(looksLikeTranscriptEcho('太短的总结', transcript)).toBe(false)
    const shortTranscript = '只录到一句话。'
    expect(looksLikeTranscriptEcho(LEGIT_SUMMARY, shortTranscript)).toBe(false)
    expect(looksLikeTranscriptEcho(shortTranscript, shortTranscript)).toBe(false)
  })
})

describe('summaryDetailMinimum', () => {
  it('按转写长度给出门槛，短转写不设门槛', () => {
    expect(summaryDetailMinimum(200)).toBeNull()
    expect(summaryDetailMinimum(400)).toEqual({ overview: 180, keyPoints: 4 })
    expect(summaryDetailMinimum(2_000)).toEqual({ overview: 500, keyPoints: 7 })
    expect(summaryDetailMinimum(6_000)).toEqual({ overview: 600, keyPoints: 10 })
  })
})
