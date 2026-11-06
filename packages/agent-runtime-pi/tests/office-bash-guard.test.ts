import { describe, expect, it } from 'vitest'

import { officeBashViolation } from '../src/office-bash-guard.js'

describe('Office 文件的 bash 护栏', () => {
  it('拦截用 python/unzip 改 pptx 内部 XML 的命令', () => {
    const command = 'cd /tmp/x && python3 - <<EOF\nimport zipfile\nzipfile.ZipFile("a.pptx") \nEOF'
    expect(officeBashViolation(command)).toContain('不要用 bash 解压或改写 Office 文件')
  })

  it('拦截直接改 OOXML 内部路径', () => {
    expect(officeBashViolation('sed -i "s/六类意图/六类意图识别/" ppt/slides/slide2.xml')).toBeTruthy()
    expect(officeBashViolation('unzip -o deck.pptx -d /tmp/x')).toBeTruthy()
    expect(officeBashViolation('cp report.xlsx /tmp/backup.xlsx')).toBeTruthy()
  })

  it('放行只读查看（ls / file / grep -l）', () => {
    expect(officeBashViolation('ls -la "学生体质健康信息查询智能体.pptx"')).toBeNull()
    expect(officeBashViolation('file deck.pptx')).toBeNull()
    expect(officeBashViolation('grep -l "Top1" slides/*.xml')).toBeNull()
  })

  it('与 Office 无关的命令不受影响', () => {
    expect(officeBashViolation('python3 build.py')).toBeNull()
    expect(officeBashViolation('rm -rf /tmp/scratch')).toBeNull()
    expect(officeBashViolation('')).toBeNull()
  })

  it('按文件类型给出对应的正确工具', () => {
    expect(officeBashViolation('unzip -o a.pptx -d /tmp')).toContain('slides_edit')
    expect(officeBashViolation('cp a.docx /tmp/b.docx')).toContain('word_agent_edit')
    expect(officeBashViolation('mv a.xlsx /tmp/a.xlsx')).toContain('sheets_agent_edit')
  })
})
