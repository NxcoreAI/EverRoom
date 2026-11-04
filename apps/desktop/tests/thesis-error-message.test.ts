import { describe, expect, it } from 'vitest'
import { describeThesisError, isThesisCardMissing } from '../src/shared/thesis-error-message'

describe('describeThesisError', () => {
  it('翻译「还没有格式卡」并给出如何自解', () => {
    const text = describeThesisError('thesis_format_card_not_found')
    expect(text).toContain('还没有可用的论文格式卡')
    expect(text).toContain('上传论文模版')
    // 关键：告诉用户模版与文档必须同工作区——否则用户会在别的空间里找不着
    expect(text).toContain('同一个工作区')
  })

  it('跨工作区引用模版给出可执行引导', () => {
    const text = describeThesisError('thesis_template_not_in_workspace')
    expect(text).toContain('当前工作区')
    expect(text).toContain('资料库')
  })

  it('上游 502 nginx 页面翻成「暂时不可用」，不把 HTML 甩给用户', () => {
    const raw = '502 <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>'
    const text = describeThesisError(raw)
    expect(text).toContain('暂时不可用')
    expect(text).not.toContain('<html>')
    expect(text).not.toContain('Bad Gateway')
  })

  it('模型输出上限给出可操作建议', () => {
    const text = describeThesisError('本次处理达到模型输出上限，未能生成最终结论。已保留处理过程，请缩小范围后重试。')
    expect(text).toContain('输出上限')
    expect(text).toContain('重试')
  })

  it('额度耗尽指向设置页而不是让用户猜', () => {
    expect(describeThesisError('insufficient_user_quota')).toContain('额度不足')
  })

  it('模版阶段失败带阶段引导', () => {
    expect(describeThesisError('thesis_template_unpack_failed:not a zip')).toContain('压缩包')
    expect(describeThesisError('thesis_template_normalize_failed:bad doc')).toContain('另存为 .docx')
    expect(describeThesisError('thesis_template_facts_extract_failed:a.docx:boom')).toContain('版式读取失败')
  })

  it('非 docx 源文档说明清楚', () => {
    expect(describeThesisError('thesis_source_not_docx')).toContain('.docx')
  })

  it('未知错误保留原文（截断），不吞信息', () => {
    const long = 'x'.repeat(600)
    const text = describeThesisError(long)
    expect(text.startsWith('排版失败：')).toBe(true)
    expect(text.length).toBeLessThan(400)
  })

  it('空消息也有兜底文案', () => {
    expect(describeThesisError('')).toBe('排版失败：没有收到具体原因，请重试。')
    expect(describeThesisError(undefined)).toBe('排版失败：没有收到具体原因，请重试。')
  })
})

describe('isThesisCardMissing', () => {
  it('识别「缺格式卡」这一可自解状态', () => {
    expect(isThesisCardMissing('thesis_format_card_not_found')).toBe(true)
    expect(isThesisCardMissing('thesis_bridge_unavailable')).toBe(false)
    expect(isThesisCardMissing(undefined)).toBe(false)
  })
})
