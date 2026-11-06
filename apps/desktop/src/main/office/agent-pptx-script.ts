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
}

export type AgentPptxScriptRun =
  | { ok: true; bytes: Buffer; warnings: string[]; consoleTail: string[] }
  | { ok: false; error: string; warnings: string[]; consoleTail: string[] }

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
 * 包装 pptxgenjs 构造器：new 或直调均可；writeFile/write 一律重定向到临时目录的 deck.pptx。
 * writes 收集每次落盘 promise——脚本漏写 await 时外层收尾等待，避免 readFileSync 赢过写盘的竞态。
 */
function wrapPptxgen(
  RealPptxgen: unknown,
  deckPath: string,
  writes: Array<Promise<unknown>>,
  onSlide?: (slideCount: number) => void,
): (new () => unknown) & Record<string, unknown> {
  let slideCount = 0
  const Ctor = RealPptxgen as new () => Record<string, unknown>
  const writeFileTo = (target: Record<string, unknown>, opts?: string | Record<string, unknown>) => {
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
          return () => {
            slideCount += 1
            onSlide?.(slideCount)
            return original.apply(target)
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

export async function runAgentPptxScript(
  script: string,
  options: AgentPptxScriptOptions = {},
): Promise<AgentPptxScriptRun> {
  const warnings: string[] = []
  const consoleTail: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'everroom-agent-pptx-'))
  const deckPath = join(dir, DECK_NAME)
  try {
    const baseRequire = createRequire(import.meta.url)
    const rawPptxgen = baseRequire('pptxgenjs') as { default?: unknown } & unknown
    // 兼容 CJS 直出与 { default } 两种导出形态（pptxgenjs 历代打包差异）。
    const RealPptxgen = ((rawPptxgen as { default?: unknown }).default ?? rawPptxgen) as unknown

    const scriptBody = await preResolveMaterials(script, dir, options.resolveMaterial, warnings)
    let applyTheme: Record<string, unknown> | null = null
    const writes: Array<Promise<unknown>> = []
    const sandboxRequire = (name: string): unknown => {
      if (name === 'pptxgenjs') return wrapPptxgen(RealPptxgen, deckPath, writes, options.onSlide)
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
    return { ok: true, bytes, warnings, consoleTail }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message, warnings, consoleTail }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
