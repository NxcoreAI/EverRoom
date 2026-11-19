import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
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
    // 中文的字体必须同时写进 <a:ea> 与 Hans 脚本表：只写 latin 时 WPS/PowerPoint 用 Hans 兜底字体，
    // 不读脚本表的渲染器（GenOffice）用 latin 字体，同一份 deck 会显示成两种中文字体。
    const theme = await (await JSZip.loadAsync(run.bytes)).file('ppt/theme/theme1.xml')!.async('string')
    for (const font of ['majorFont', 'minorFont']) {
      const block = new RegExp(`<a:${font}>[\\s\\S]*?</a:${font}>`).exec(theme)![0]
      expect(block).toContain('<a:ea typeface="Calibri"/>')
      expect(block).toContain('<a:font script="Hans" typeface="Calibri"/>')
    }
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

  it('画布裁剪：页内图形原样、部分出界裁到画布内、完全出界不落盘', async () => {
    // LAYOUT_WIDE = 12192000 × 6858000 EMU（13.33" × 7.5"）
    const script = [
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'const slide = pres.addSlide();',
      'slide.addShape(pres.ShapeType.rect, { x: 0.5, y: 0.5, w: 2, h: 2, fill: { color: "FF0000" } });',
      'slide.addShape(pres.ShapeType.rect, { x: 4, y: 3, w: 12, h: 2, fill: { color: "00FF00" } });',
      'slide.addShape(pres.ShapeType.ellipse, { x: 8.4, y: -1.6, w: 6.6, h: 6.6, fill: { color: "FFFF00" } });',
      'slide.addShape(pres.ShapeType.ellipse, { x: 20, y: 0, w: 2, h: 2, fill: { color: "0000FF" } });',
      'await pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n')
    const run = await runAgentPptxScript(script)
    expect(run.ok).toBe(true)
    if (!run.ok) return
    const xml = await (await JSZip.loadAsync(run.bytes)).file('ppt/slides/slide1.xml')!.async('string')
    // 页内：原样
    expect(xml).toContain('FF0000')
    expect(xml).toContain('<a:off x="457200" y="457200"/><a:ext cx="1828800" cy="1828800"/>')
    // 右边出界：w 裁到画布右缘（12192000 - 3657600 = 8534400）
    expect(xml).toContain('00FF00')
    expect(xml).toContain('cx="8534400"')
    // 顶部 + 右侧出界的圆（真实案例坐标）：y 裁到 0，右/下裁到画布缘
    expect(xml).toContain('FFFF00')
    expect(xml).toContain('<a:off x="7680960" y="0"/><a:ext cx="4511040" cy="4572000"/>')
    // 完全出界：整块跳过
    expect(xml).not.toContain('0000FF')
  })
})

describe('版式自查（layoutLint）', () => {
  it('标题压表格 + 色块盖表格 → 拒收并点名页号', async () => {
    const run = await runAgentPptxScript([
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'const s = pres.addSlide();',
      // 标题与表格同区（标题压表格约 60% 表头）
      's.addText("Privacy and realism on LFW", { x: 0.6, y: 1.0, w: 8, h: 0.6, fontSize: 28, isTextBox: true });',
      's.addTable([[{ text: "Method", options: { bold: true } }, { text: "FID" }], ["FALCO", "12.3"]], { x: 0.6, y: 1.2, w: 6, h: 2.5, fontSize: 12 });',
      // 大色块压在表格上
      's.addShape("rect", { x: 0.7, y: 1.4, w: 5, h: 2, fill: { color: "22C55E" } });',
      'await pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n'))
    expect(run.ok).toBe(false)
    if (run.ok) return
    expect(run.error).toContain('版式自查未通过')
    expect(run.error).toMatch(/第 \d+ 页/)
    expect(run.error).toMatch(/文字压表格|遮挡表格|遮挡文字/)
  })

  it('卡片底板先画、文字在卡片内 → 不误报（z 序：文字在块上）', async () => {
    const run = await runAgentPptxScript([
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'const s = pres.addSlide();',
      's.addShape("roundRect", { x: 0.5, y: 1, w: 4, h: 2, rectRadius: 0.1, fill: { color: "EAF2F8" } });',
      's.addText("01", { x: 0.8, y: 1.3, w: 1, h: 0.6, fontSize: 32, color: "0B5FFF", isTextBox: true });',
      's.addText("卡片说明", { x: 2, y: 1.4, w: 2.2, h: 0.8, fontSize: 14, isTextBox: true });',
      'await pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n'))
    expect(run.ok).toBe(true)
  })

  it('干净页面不被误杀', async () => {
    const run = await runAgentPptxScript([
      'const pptxgen = require("pptxgenjs");',
      'const pres = new pptxgen();',
      'pres.layout = "LAYOUT_WIDE";',
      'const s = pres.addSlide();',
      's.addText("标题", { x: 0.6, y: 0.4, w: 8, h: 0.8, fontSize: 32, isTextBox: true });',
      's.addText("正文", { x: 0.6, y: 1.6, w: 8, h: 1.2, fontSize: 16, isTextBox: true });',
      's.addShape("rect", { x: 9.5, y: 0.4, w: 3, h: 2, fill: { color: "EAF2F8" } });',
      'await pres.writeFile({ fileName: "deck.pptx" });',
    ].join('\n'))
    expect(run.ok).toBe(true)
  })
})
