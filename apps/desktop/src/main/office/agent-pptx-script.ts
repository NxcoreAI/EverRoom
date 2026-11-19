/**
 * Agent pptxgenjs 脚本执行器（pptx skill「执行层」）：主进程内 vm 沙箱运行 agent 写的
 * 整册构建脚本，产出 deck.pptx 字节。require 白名单只有 pptxgenjs 与 apply_theme——
 * 没有 process/fs/网络等宿主能力，输出经 writeFile 代理强制写入本次临时目录。
 *
 * ponytail: vm 不是安全边界（恶意脚本仍可经构造器链逃逸），当前威胁模型是「自家
 * 主 Agent 生成的脚本」而非不可信输入；若要对抗提示注入，升级路径是子进程 +
 * node:permission 沙箱，而不是在 vm 上继续加固。
 */
import { createRequire } from 'node:module'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

/** apply_theme.js（CJS）在 vm 里需要的 require 面：按需加载 + 带路径的 resolve。 */
type SandboxRequire = ((name: string) => unknown) & {
  resolve: (name: string, options?: NodeJS.RequireResolveOptions) => string
}

const DECK_NAME = 'deck.pptx'
const MATERIAL_REF = /everroom-material:\/\/([a-f0-9]{64})/g
const DEFAULT_TIMEOUT_MS = 180_000
/** 单 1×1 透明 PNG：素材回源失败时占位，保证脚本仍可跑完（warnings 里如实上报）。 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
)

export interface AgentPptxScriptOptions {
  /** pptx skill 的 apply_theme.js 源码；缺省时脚本 require('pptx/apply_theme.js') 会得到明确报错。 */
  applyThemeJs?: string | null
  /** everroom-material:// 回源；不传则素材一律按占位图处理。 */
  resolveMaterial?: ((url: string) => Promise<{ bytes: Uint8Array; ext: string } | null>) | null
  timeoutMs?: number
  /** 每新增一页回调（addSlide 计数）：驱动生成进度展示。 */
  onSlide?: (slideCount: number) => void
  /**
   * 版式自查：页内元素几何重叠（文字互压、色块盖字/盖表）。缺省 true ——
   * PresentBench 实测第 14 页标题压表格、大色块遮挡数据表，扣了整页 4 条分。
   * 关闭只用于宿主想自行处理的情况。
   */
  layoutLint?: boolean
}

export type AgentPptxScriptRun =
  | { ok: true; bytes: Buffer; warnings: string[]; consoleTail: string[] }
  | { ok: false; error: string; warnings: string[]; consoleTail: string[] }

/** 版式自查发现的页内几何问题（一行一条，供模型按页修）。 */
export interface PptxLayoutIssue { slide: number; detail: string }

/** 素材引用 → 本地文件：脚本里出现的 everroom-material:// 全部替换成临时目录里的真实文件。 */
async function preResolveMaterials(
  script: string,
  dir: string,
  resolveMaterial: AgentPptxScriptOptions['resolveMaterial'],
  warnings: string[],
): Promise<string> {
  const refs = [...new Set(script.match(MATERIAL_REF) ?? [])]
  let out = script
  for (const [index, ref] of refs.entries()) {
    let material: { bytes: Uint8Array; ext: string } | null = null
    try {
      material = (await resolveMaterial?.(ref)) ?? null
    } catch {
      material = null
    }
    if (material) {
      const filePath = join(dir, `material-${index}.${material.ext}`)
      writeFileSync(filePath, material.bytes)
      out = out.split(ref).join(filePath)
    } else {
      warnings.push(`素材 ${ref} 回源失败，已用占位图替代——请检查该 materialRef 是否仍有效`)
      const filePath = join(dir, `material-${index}.png`)
      writeFileSync(filePath, PLACEHOLDER_PNG)
      out = out.split(ref).join(filePath)
    }
  }
  return out
}

/** 把 apply_theme.js 以 CJS 方式装进 vm：require 带主进程解析路径（jszip 从 pptxgenjs 旁边找）。 */
function loadApplyTheme(
  source: string,
  dir: string,
  baseRequire: NodeRequire,
  consoleTail: string[],
): Record<string, unknown> {
  const modulePaths = [dirname(baseRequire.resolve('pptxgenjs'))]
  const sandboxRequire = ((name: string): unknown => {
    if (name === 'fs') return nodeFs
    return baseRequire(baseRequire.resolve(name, { paths: modulePaths }))
  }) as SandboxRequire
  sandboxRequire.resolve = (name, options) =>
    baseRequire.resolve(name, { ...(options ?? {}), paths: [...(options?.paths ?? []), ...modulePaths] })
  const module = { exports: {} as Record<string, unknown> }
  vm.runInNewContext(source, {
    require: sandboxRequire,
    module,
    exports: module.exports,
    __filename: join(dir, 'apply_theme.js'),
    console: capturedConsole(consoleTail),
  }, { filename: 'apply_theme.js' })
  return module.exports
}

function capturedConsole(consoleTail: string[]): Pick<Console, 'log' | 'warn' | 'error'> {
  const push = (prefix: string) => (...args: unknown[]) => {
    consoleTail.push(prefix + args.map(a => String(a)).join(' '))
    if (consoleTail.length > 200) consoleTail.splice(0, consoleTail.length - 200)
  }
  return { log: push(''), warn: push('[warn] '), error: push('[error] ') }
}

/**
 * 记录一次 add* 调用的快照，供落盘前的版式自查。
 * 必须在调用时立刻取数值：pptxgenjs 会把传入的 options 对象**原地**改成 EMU 整数
 * （9600 EMU/px），事后读同一个对象拿到的是 548640 这种值，几何比较全部失效。
 */
interface RecordedOp {
  name: string
  rect: { x: number; y: number; w: number; h: number } | null
  text: string
  shapeType?: string
  filled?: boolean
}

interface RectItem { label: string; x: number; y: number; w: number; h: number; order: number }

function rectOf(options: Record<string, unknown>): NonNullable<RecordedOp['rect']> | null {
  const x = options.x, y = options.y, w = options.w, h = options.h
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

function snapshotText(textArg: unknown, options: Record<string, unknown>): string {
  if (typeof textArg === "string") return textArg
  if (Array.isArray(textArg)) {
    return (textArg as Array<unknown>).map((r) => {
      if (typeof r === "string") return r
      if (r && typeof r === "object") return String((r as Record<string, unknown>).text ?? "")
      return ""
    }).join("")
  }
  if (Array.isArray(options.paragraphs)) {
    return (options.paragraphs as Array<Record<string, unknown>>)
      .map((p) => (Array.isArray(p.runs) ? (p.runs as Array<Record<string, unknown>>).map((r) => String(r?.text ?? "")).join("") : ""))
      .join(" ")
  }
  return ""
}

function intersectionArea(a: RectItem, b: RectItem): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

const EMU_PER_INCH = 914400

type CanvasLayout = { width: number; height: number }

/** pptxgenjs getSmartParseNumber 同源规则：数字 <100 视为英寸，≥100 视为 EMU，"50%" 按画布尺寸换算。 */
function toEmuLen(value: unknown, dir: 'X' | 'Y', layout: CanvasLayout): number | null {
  if (typeof value === 'number') return value < 100 ? Math.round(value * EMU_PER_INCH) : value
  if (typeof value === 'string' && value.includes('%')) {
    const pct = Number.parseFloat(value)
    if (!Number.isFinite(pct)) return null
    return Math.round((pct / 100) * (dir === 'X' ? layout.width : layout.height))
  }
  return null
}

/**
 * 画布裁剪：图形只保留画布内的部分（出界的部分不画）。完全出界返回 false，调用方跳过这次 add*。
 * ponytail: 按 bbox 裁剪——矩形精确；圆等曲线形状裁后变椭圆（pptx 没有形状级 clip，
 * 真裁剪要 custGeom 多边形近似，出界图形成普遍问题再上）；旋转形状按未旋转 bbox 处理。
 */
function clampToCanvas(options: Record<string, unknown>, layout: CanvasLayout): boolean {
  const x = toEmuLen(options.x, 'X', layout)
  const y = toEmuLen(options.y, 'Y', layout)
  const w = toEmuLen(options.w, 'X', layout)
  const h = toEmuLen(options.h, 'Y', layout)
  // 解析不了（缺坐标、w/h≤0 的自适应图片等）不拦，交给 pptxgenjs 原行为
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return true
  const nx = Math.max(x, 0)
  const ny = Math.max(y, 0)
  const nw = Math.min(x + w, layout.width) - nx
  const nh = Math.min(y + h, layout.height) - ny
  if (nw <= 0 || nh <= 0) return false
  if (nx === x && ny === y && nw === w && nh === h) return true
  // 写回英寸数字：画布最长 13.34"，恒 <100，getSmartParseNumber 一定按英寸解析
  options.x = nx / EMU_PER_INCH
  options.y = ny / EMU_PER_INCH
  options.w = nw / EMU_PER_INCH
  options.h = nh / EMU_PER_INCH
  return true
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/**
 * 版式自查（几何层，不依赖视觉模型）：文字互压、色块盖文字/盖表格。
 * 阈值偏保守，只在明显不合理时报告（PresentBench FALCO 第 14 页那种整页不可读）。
 */
function lintSlideOps(ops: RecordedOp[]): string[] {
  const issues: string[] = []
  const texts: RectItem[] = []
  const boxes: RectItem[] = []
  const tables: RectItem[] = []
  for (const [order, op] of ops.entries()) {
    const rect = op.rect
    if (!rect) continue
    const label = clip(op.text.replace(/\s+/g, " ").trim(), 24)
    if (op.name === "addText") {
      texts.push({ ...rect, label, order })
    } else if (op.name === "addTable") {
      tables.push({ ...rect, label: "表格", order })
    } else if (op.name === "addChart") {
      // 图表与文字重叠多半是刻意压放（图表标题），不参与自查。
    } else if (op.name === "addShape") {
      const shapeType = op.shapeType ?? "rect"
      // 带文字的形状按文字处理（按钮/标签），不当作覆盖块。
      if (op.text.trim()) {
        texts.push({ ...rect, label, order })
      } else if (op.filled && shapeType !== "line" && shapeType !== "lineArrow") {
        boxes.push({ ...rect, label: `色块(${shapeType})`, order })
      }
    }
  }
  // 1) 文字互压：交集 ≥ 较小文字面积的 15%。
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!, b = texts[j]!
      const inter = intersectionArea(a, b)
      if (inter <= 0) continue
      const minArea = Math.min(a.w * a.h, b.w * b.h)
      if (minArea > 0 && inter / minArea >= 0.15) {
        issues.push(`文字重叠：「${a.label || "文字框"}」与「${b.label || "文字框"}」重叠 ${Math.round(inter / minArea * 100)}%`)
      }
    }
  }
  // 2) 文字压表格：交集 ≥ 文字面积 15%。
  for (const t of texts) {
    for (const tb of tables) {
      const inter = intersectionArea(t, tb)
      if (inter > 0 && inter / (t.w * t.h) >= 0.15) {
        issues.push(`文字压表格：「${t.label || "文字框"}」覆盖表格 ${Math.round(inter / (t.w * t.h) * 100)}%`)
      }
    }
  }
  // 3) 色块盖文字：仅当色块**画在文字之后**（z 序在上）且交集 ≥ 文字面积 80%。
  // 卡片底板先画、文字后画是正常设计（文字在卡片内），不应报警。
  for (const box of boxes) {
    for (const t of texts) {
      if (box.order < t.order) continue
      const inter = intersectionArea(box, t)
      if (inter > 0 && inter / (t.w * t.h) >= 0.8) {
        issues.push(`${box.label}遮挡文字：「${t.label || "文字框"}」被盖住 ${Math.round(inter / (t.w * t.h) * 100)}%`)
      }
    }
  }
  // 4) 色块盖表格：仅当色块画在表格之后（z 序在上）且交集 ≥ 表格面积 50%。
  for (const box of boxes) {
    for (const tb of tables) {
      if (box.order < tb.order) continue
      const inter = intersectionArea(box, tb)
      if (inter > 0 && inter / (tb.w * tb.h) >= 0.5) {
        issues.push(`${box.label}遮挡表格 ${Math.round(inter / (tb.w * tb.h) * 100)}%`)
      }
    }
  }
  return issues.slice(0, 12)
}

/**
 * 包装 pptxgenjs 构造器：new 或直调均可；writeFile/write 一律重定向到临时目录的 deck.pptx。
 * writes 收集每次落盘 promise——脚本漏写 await 时外层收尾等待，避免 readFileSync 赢过写盘的竞态。
 */
function wrapPptxgen(
  RealPptxgen: unknown,
  deckPath: string,
  writes: Array<Promise<unknown>>,
  onSlide: ((slideCount: number) => void) | undefined,
  layoutIssues: string[],
): (new () => unknown) & Record<string, unknown> {
  let slideCount = 0
  const slideOps = new Map<number, RecordedOp[]>()
  let linted = false
  const runLint = () => {
    if (linted) return
    linted = true
    for (const [slideNo, ops] of slideOps) {
      for (const issue of lintSlideOps(ops)) layoutIssues.push(`第 ${slideNo} 页：${issue}`)
    }
  }
  const Ctor = RealPptxgen as new () => Record<string, unknown>
  const writeFileTo = (target: Record<string, unknown>, opts?: string | Record<string, unknown>) => {
    runLint()
    const promise = (target.writeFile as (o: Record<string, unknown>) => Promise<unknown>)({
      ...(typeof opts === 'string' ? { fileName: opts } : (opts as Record<string, unknown>) ?? {}),
      fileName: deckPath,
    })
    // 收尾等待只关心完成，不吞给脚本的异常：推入的是独立 catch 副本。
    writes.push(Promise.resolve(promise).then(() => undefined, () => undefined))
    return promise
  }
  const wrapped = function pptxgen(this: unknown) {
    const instance = new Ctor()
    const proxy = new Proxy(instance, {
      get(target: Record<string, unknown>, prop: string | symbol) {
        if (prop === 'addSlide') {
          const original = target[prop as string] as (...args: unknown[]) => unknown
          return (...args: unknown[]) => {
            slideCount += 1
            const slideNo = slideCount
            onSlide?.(slideNo)
            slideOps.set(slideNo, [])
            const slide = original.apply(target, args) as Record<string, unknown>
            // 记录本页 add* 调用的几何与文案：落盘前做确定性版式自查。
            return new Proxy(slide, {
              get(slideTarget: Record<string, unknown>, slideProp: string | symbol) {
                const value = slideTarget[slideProp as string]
                if (typeof value !== 'function') return value
                if (typeof slideProp === 'string' && ['addText', 'addShape', 'addTable', 'addChart', 'addImage'].includes(slideProp)) {
                  return (...callArgs: unknown[]) => {
                    // 各方法的签名不同：options 的位置要按方法取，否则几何全空、自查失效。
                    const asRecord = (v: unknown): Record<string, unknown> =>
                      (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}
                    let options: Record<string, unknown> = {}
                    let textArg: unknown
                    if (slideProp === 'addText') {
                      textArg = callArgs[0]
                      options = asRecord(callArgs[1])
                    } else if (slideProp === 'addShape') {
                      options = asRecord(callArgs[1])
                      ;(options as Record<string, unknown>).shapeType = options.shapeType ?? callArgs[0]
                    } else if (slideProp === 'addTable') {
                      options = asRecord(callArgs[1])
                    } else if (slideProp === 'addChart') {
                      options = asRecord(callArgs[2])
                    } else {
                      options = asRecord(callArgs[0])
                    }
                    // 图形画布裁剪：出界部分不画（完全出界整块跳过），发生在快照之前，
                    // 这样版式自查看到的也是裁剪后的几何。
                    if (slideProp === 'addShape' || slideProp === 'addImage') {
                      const layout = (slideTarget as { _presLayout?: CanvasLayout })._presLayout
                      if (layout && layout.width > 0 && layout.height > 0 && !clampToCanvas(options, layout)) {
                        return slideTarget
                      }
                    }
                    // 调用时立即快照：pptxgenjs 之后会把 options 原地改写为 EMU。
                    const rect = rectOf(options)
                    slideOps.get(slideNo)?.push({
                      name: slideProp,
                      rect,
                      text: snapshotText(textArg, options),
                      ...(slideProp === 'addShape' ? { shapeType: String(options.shapeType ?? 'rect') } : {}),
                      ...(slideProp === 'addShape' ? { filled: Boolean(options.fill || options.gradient) } : {}),
                    })
                    return (value as (...a: unknown[]) => unknown).apply(slideTarget, callArgs)
                  }
                }
                return (value as (...a: unknown[]) => unknown).bind(slideTarget)
              },
            })
          }
        }
        if (prop === 'writeFile') return (opts?: string | Record<string, unknown>) => writeFileTo(target, opts)
        if (prop === 'write') {
          // write({outputType}) 与 writeFile 同源：统一落 deck.pptx，再按调用方要的形态返回字节。
          return async (opts?: Record<string, unknown>) => {
            const clean = { ...(opts ?? {}) }
            delete clean.outputType
            await writeFileTo(target, clean)
            const bytes = readFileSync(deckPath)
            const outputType = (opts as { outputType?: string } | undefined)?.outputType
            if (outputType === 'base64') return bytes.toString('base64')
            if (outputType === 'binarystring') return bytes.toString('binary')
            if (outputType === 'arraybuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            return bytes
          }
        }
        const value = target[prop as string]
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    return proxy
  } as unknown as (new () => unknown) & Record<string, unknown>
  // 静态属性原样透传，但 .default 指回包装类——脚本走 require("pptxgenjs").default 的
  // ESM/CJS 互操作写法时，拿到的仍是重定向后的构造器而不是裸类。
  return Object.assign(wrapped, RealPptxgen as Record<string, unknown>, { default: wrapped })
}

/**
 * 编译期错误补上脚本行号与上下文：模型写整册脚本难免一处语法手滑（实测 634 行脚本
 * 第 350 行多了个 `]`），只回 "Unexpected token ']'" 它找不到位置、重试还在盲改。
 * vm 栈形如 "evalmachine.<anonymous>:351"，包了一层 (async () => {\n 故脚本行号 = 栈行号 - 1。
 */
function withScriptContext(message: string, scriptBody: string, error: unknown): string {
  const stack = error instanceof Error ? error.stack ?? "" : ""
  const line = Number(/evalmachine\.<anonymous>:(\d+)/.exec(stack)?.[1] ?? NaN);
  if (!Number.isFinite(line)) return message
  const target = Math.max(1, line - 1)
  const lines = scriptBody.split("\n")
  const from = Math.max(1, target - 2)
  const to = Math.min(lines.length, target + 2)
  const excerpt = []
  for (let n = from; n <= to; n += 1) {
    excerpt.push(`${n === target ? ">" : " "} ${n}: ${lines[n - 1] ?? ""}`.slice(0, 220))
  }
  return `${message}（脚本第 ${target} 行附近；上下文：\n${excerpt.join("\n")}）`
}

export async function runAgentPptxScript(
  script: string,
  options: AgentPptxScriptOptions = {},
): Promise<AgentPptxScriptRun> {
  const warnings: string[] = []
  const consoleTail: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'everroom-agent-pptx-'))
  const deckPath = join(dir, DECK_NAME)
  let scriptBody = ""
  try {
    const baseRequire = createRequire(import.meta.url)
    const rawPptxgen = baseRequire('pptxgenjs') as { default?: unknown } & unknown
    // 兼容 CJS 直出与 { default } 两种导出形态（pptxgenjs 历代打包差异）。
    const RealPptxgen = ((rawPptxgen as { default?: unknown }).default ?? rawPptxgen) as unknown

    scriptBody = await preResolveMaterials(script, dir, options.resolveMaterial, warnings)
    let applyTheme: Record<string, unknown> | null = null
    const writes: Array<Promise<unknown>> = []
    const layoutIssues: string[] = []
    const sandboxRequire = (name: string): unknown => {
      if (name === 'pptxgenjs') return wrapPptxgen(RealPptxgen, deckPath, writes, options.onSlide, layoutIssues)
      if (name === 'pptx/apply_theme.js') {
        if (!options.applyThemeJs) {
          throw new Error('apply_theme 不可用（宿主未提供 pptx/apply_theme.js）：请改用直接 hex 色，不用 SchemeColor/applyTheme')
        }
        applyTheme ??= loadApplyTheme(options.applyThemeJs, dir, baseRequire, consoleTail)
        const exports = applyTheme
        // applyTheme 的 deck 路径按临时目录解析（skill 约定相对 "deck.pptx"）。
        return {
          applyTheme: (deckPathArg: string, theme: unknown) =>
            (exports.applyTheme as (p: string, t: unknown) => Promise<unknown>)(resolve(dir, deckPathArg), theme),
        }
      }
      throw new Error(`require("${name}") 不在白名单内：脚本只能 require("pptxgenjs") 与 require("pptx/apply_theme.js")`)
    }

    const runPromise = vm.runInNewContext(
      `(async () => {\n${scriptBody}\n})()`,
      { require: sandboxRequire, console: capturedConsole(consoleTail) },
      { timeout: 10_000 },
    ) as Promise<unknown>
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const result = await Promise.race([
      runPromise,
      new Promise<'__timeout__'>(resolve_ => setTimeout(() => resolve_('__timeout__'), timeoutMs).unref?.()),
    ])
    if (result === '__timeout__') {
      return { ok: false, error: `脚本执行超时（${timeoutMs / 1000}s）——检查是否有死循环或过大的同步计算`, warnings, consoleTail }
    }

    // 脚本漏写 await 时 writeFile 可能还在飞：先等落盘（上限同整体超时），再收产物。
    await Promise.race([
      Promise.allSettled(writes),
      new Promise<'__timeout__'>(resolve_ => setTimeout(() => resolve_('__timeout__'), timeoutMs).unref?.()),
    ])

    let bytes: Buffer
    try {
      bytes = readFileSync(deckPath)
    } catch {
      return {
        ok: false,
        error: `脚本未产出 ${DECK_NAME}——最后一步必须 await pres.writeFile({ fileName: "${DECK_NAME}" })（pres.write() 也可）`,
        warnings,
        consoleTail,
      }
    }
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return { ok: false, error: `${DECK_NAME} 不是合法的 pptx（zip 魔数校验失败）`, warnings, consoleTail }
    }
    if ((options.layoutLint ?? true) && layoutIssues.length > 0) {
      // 版式自查硬拒收：重叠页交付后就是不可读的废页（PresentBench 实测整页视觉项全灭）。
      // 让模型按页号修脚本重交，而不是把不可读页落进成品。
      return {
        ok: false,
        error: `版式自查未通过（${layoutIssues.length} 处）：\n${layoutIssues.slice(0, 8).join("\n")}\n请按页号调整坐标/尺寸后重交。`,
        warnings,
        consoleTail,
      }
    }
    return { ok: true, bytes, warnings, consoleTail }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: withScriptContext(message, scriptBody, error), warnings, consoleTail }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
