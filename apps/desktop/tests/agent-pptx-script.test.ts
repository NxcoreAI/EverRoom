import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { runAgentPptxScript } from '../src/main/office/agent-pptx-script'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const applyThemeJs = readFileSync(
  join(repoRoot, 'agents', 'main', 'skills', 'pptx', 'scripts', 'apply_theme.js'),
  'utf8',
)

const RED_DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const MINIMAL_SCRIPT = [
  'const pptxgen = require("pptxgenjs");',
  'const pres = new pptxgen();',
  'pres.layout = "LAYOUT_WIDE";',
  'const slide = pres.addSlide();',
  'slide.addText("季度回顾", { x: 0.6, y: 0.5, w: 12, h: 1, fontSize: 40, color: "1A1A2E", isTextBox: true });',
  'await pres.writeFile({ fileName: "deck.pptx" });',
].join('\n')

describe('runAgentPptxScript', () => {
  it('完整脚本 → 产出合法 pptx 字节（zip 魔数），writeFile 被重定向到临时目录', async () => {
    const run = await runAgentPptxScript(MINIMAL_SCRIPT)
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.bytes.byteLength).toBeGreaterThan(1000)
    expect(run.bytes[0]).toBe(0x50)
    expect(run.bytes[1]).toBe(0x4b)
    expect(run.warnings).toEqual([])
  })

  it('require 白名单外模块（fs）→ 明确报错，不产出文件', async () => {
    const run = await runAgentPptxScript(
      'const fs = require("fs");\nfs.writeFileSync("/tmp/pwned", "x");',
    )
    expect(run.ok).toBe(false)
    if (run.ok) return
    expect(run.error).toContain('白名单')
  })

  it('未 writeFile → 报错指出 deck.pptx 约定', async () => {
    const run = await runAgentPptxScript('const pptxgen = require("pptxgenjs"); const p = new pptxgen();')
    expect(run.ok).toBe(false)
    if (run.ok) return
    expect(run.error).toContain('deck.pptx')
  })

  it('pres.write({outputType}) 形态也产出 deck（writeFile/write 同源重定向）', async () => {
    const run = await runAgentPptxScript([
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.addSlide().addText("write 形态", { x: 1, y: 1, w: 8, h: 1, fontSize: 32, isTextBox: true });',
      'const data = await pres.write({ outputType: "base64" });',
      'if (typeof data !== "string" || data.length < 100) throw new Error("write 返回值异常");',
    ].join('\n'))
    expect(run.ok).toBe(true)
  })

  it('require("pptxgenjs").default 互操作写法拿到的是包装类（writeFile 仍被重定向）', async () => {
    const run = await runAgentPptxScript([
      'const mod = require("pptxgenjs");',
      'const pptxgen = mod.default ?? mod;',
      'const pres = new pptxgen();',
      'pres.addSlide().addText("default 互操作", { x: 1, y: 1, w: 8, h: 1, fontSize: 32, isTextBox: true });',
      'await pres.writeFile({ fileName: "任意名.pptx" });',
    ].join('\n'))
    expect(run.ok).toBe(true)
  })

  it('漏写 await 的 writeFile 也能收尾拿到产物（readFileSync 不再赢过写盘）', async () => {
    const run = await runAgentPptxScript([
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.addSlide().addText("no await", { x: 1, y: 1, w: 8, h: 1, fontSize: 32, isTextBox: true });',
      'pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n'))
    expect(run.ok).toBe(true)
  })

  it('apply_theme 全链路：writeFile 后 applyTheme 重写主题，仍产出合法 pptx', async () => {
    const script = [
      'const pptxgen = require("pptxgenjs");',
      'const { applyTheme } = require("pptx/apply_theme.js");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'pres.theme = { headFontFace: "Calibri", bodyFontFace: "Calibri" };',
      'const slide = pres.addSlide();',
      'slide.addText("Hello", { x: 1, y: 1, w: 10, h: 1, color: pres.SchemeColor.text2, isTextBox: true });',
      'await pres.writeFile({ fileName: "deck.pptx" });',
      'await applyTheme("deck.pptx", { name: "测试主题", colors: {',
      '  dk1: "1A1A2E", lt1: "FFFFFF", dk2: "222244", lt2: "F2F2F6",',
      '  accent1: "065A82", accent2: "1C7293", accent3: "21295C",',
      '  accent4: "2C5F2D", accent5: "F96167", accent6: "6D2E46",',
      '  hlink: "0563C1", folHlink: "954F72" } });',
    ].join('\n')
    const run = await runAgentPptxScript(script, { applyThemeJs })
    expect(run.ok).toBe(true)
    if (!run.ok) return
    expect(run.bytes[0]).toBe(0x50)
  })

  it('apply_theme 缺失 → require("pptx/apply_theme.js") 得到明确报错', async () => {
    const run = await runAgentPptxScript('require("pptx/apply_theme.js");')
    expect(run.ok).toBe(false)
    if (run.ok) return
    expect(run.error).toContain('apply_theme 不可用')
  })

  it('everroom-material:// 预解析：可回源 → 本地文件替换；回源失败 → 占位图 + warning', async () => {
    const materialUrl = `everroom-material://${'ab'.repeat(32)}`
    const script = [
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'const slide = pres.addSlide();',
      `slide.addImage({ path: "${materialUrl}", x: 4, y: 2, w: 2, h: 2 });`,
      'await pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n')
    const ok = await runAgentPptxScript(script, {
      resolveMaterial: async () => ({ bytes: Buffer.from(RED_DOT, 'base64'), ext: 'png' }),
    })
    expect(ok.ok).toBe(true)
    const failed = await runAgentPptxScript(script, { resolveMaterial: async () => null })
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.warnings.join('\n')).toContain('回源失败')
  })
})
