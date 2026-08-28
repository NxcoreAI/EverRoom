import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const sourceRoot = join(desktopRoot, 'vendor', 'genoffice')
const docsRoot = join(sourceRoot, 'apps', 'docs')
const docsOutput = join(docsRoot, 'out')
const sheetsRoot = join(sourceRoot, 'apps', 'sheets')
const sheetsOutput = join(sheetsRoot, 'out')
const slidesRoot = join(sourceRoot, 'apps', 'slides')
const slidesOutput = join(slidesRoot, 'out')
const sidecarOutput = join(sheetsRoot, 'native', 'xlsx-engine', 'target', 'release', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
const outputRoot = join(desktopRoot, 'build', 'genoffice-runtime')
const stagingRoot = join(desktopRoot, 'build', `.genoffice-runtime-${process.pid}`)
const cacheFile = join(outputRoot, 'manifest.json')
const prepareVersion = 5
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

function fail(message) {
  throw new Error(`[genoffice] ${message}`)
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      GENOFFICE_EMBED_ONLY: '1',
    },
  })
}

function git(args) {
  return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim()
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function requireSubmodule() {
  for (const path of [
    join(sourceRoot, 'package.json'),
    join(sourceRoot, 'package-lock.json'),
    join(sourceRoot, 'LICENSE'),
    join(sourceRoot, 'NOTICE'),
    join(docsRoot, 'package.json'),
  ]) {
    if (!existsSync(path)) {
      fail('GenOffice submodule is missing or incomplete. Run: git submodule update --init --recursive')
    }
  }
}

function sourceKey() {
  const commit = git(['rev-parse', 'HEAD'])
  const trackedPatch = git(['diff', '--binary', 'HEAD'])
  // Untracked files (the local embed entries before they land in a fork
  // commit) never appear in `git diff HEAD`, so hash their paths and contents
  // too — otherwise editing them leaves a stale cached runtime.
  const untrackedFiles = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((path) => path.length > 0)
    .map((path) => {
      const absolute = join(sourceRoot, path)
      return statSync(absolute).isFile() ? `${path}:${hashFile(absolute)}` : `${path}:dir`
    })
    .join('\n')
  const lockHash = hashFile(join(sourceRoot, 'package-lock.json'))
  return {
    prepareVersion,
    commit,
    dirtyPatchHash: trackedPatch ? hashText(trackedPatch) : null,
    untrackedFilesHash: untrackedFiles ? hashText(untrackedFiles) : null,
    lockHash,
    platform: process.platform,
    arch: process.arch,
    electronMajor: 39,
    formats: ['docx', 'xlsx', 'pptx'],
  }
}

function cacheMatches(key) {
  if (!existsSync(cacheFile)) return false
  try {
    const current = JSON.parse(readFileSync(cacheFile, 'utf8'))
    return Object.entries(key).every(([name, value]) => JSON.stringify(current[name]) === JSON.stringify(value))
      && existsSync(join(outputRoot, 'docs', 'main', 'embed.js'))
      && existsSync(join(outputRoot, 'docs', 'main', 'package.json'))
      && existsSync(join(outputRoot, 'docs', 'preload', 'index.js'))
      && existsSync(join(outputRoot, 'docs', 'renderer', 'index.html'))
      && existsSync(join(outputRoot, 'sheets', 'main', 'embed.js'))
      && existsSync(join(outputRoot, 'sheets', 'preload', 'index.js'))
      && existsSync(join(outputRoot, 'sheets', 'renderer', 'index.html'))
      && existsSync(join(outputRoot, 'slides', 'main', 'embed.js'))
      && existsSync(join(outputRoot, 'slides', 'preload', 'index.js'))
      && existsSync(join(outputRoot, 'slides', 'renderer', 'index.html'))
      && existsSync(join(outputRoot, 'native', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'))
      && existsSync(join(outputRoot, 'fixtures', 'simple.docx'))
  } catch {
    return false
  }
}

function assertApacheOnlyBuild() {
  if (!existsSync(join(sourceRoot, 'ee'))) return
  if (resolve(docsOutput).startsWith(`${resolve(sourceRoot, 'ee')}/`)) {
    fail('enterprise edition output must never enter the EverRoom runtime')
  }
}

function assertEmbedBundle(mainDirectory) {
  const embed = join(mainDirectory, 'embed.js')
  if (!existsSync(embed)) {
    fail('Docs embed entry is unavailable. Update the NxcoreAI/genoffice submodule to the EverRoom embed branch.')
  }
  const javascript = filesUnder(mainDirectory).filter((path) => path.endsWith('.js'))
  const forbidden = [
    ['electron-updater', /require\(["']electron-updater["']\)/],
    ['GenOffice standalone bootstrap', /startDocsStandalone\(\)/],
  ]
  const entryText = readFileSync(embed, 'utf8')
  for (const [label, pattern] of forbidden) {
    if (pattern.test(entryText)) fail(`${label} leaked into docs/main/embed.js`)
  }
  const externalRequires = new Set()
  for (const path of javascript) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const request = match[1]
      if (!request.startsWith('.') && request !== 'electron' && !nodeBuiltins.has(request)) {
        externalRequires.add(request)
      }
    }
  }
  // The updater is emitted as a lazy standalone-only chunk. It is deliberately
  // omitted below, so no external package is allowed in the shipped closure.
  externalRequires.delete('electron-updater')
  if (externalRequires.size > 0) {
    fail(`unexpected runtime dependencies: ${[...externalRequires].sort().join(', ')}`)
  }
}

function copyDocsRuntime() {
  const target = join(stagingRoot, 'docs')
  cpSync(join(docsOutput, 'main'), join(target, 'main'), { recursive: true })
  cpSync(join(docsOutput, 'preload'), join(target, 'preload'), { recursive: true })
  cpSync(join(docsOutput, 'renderer'), join(target, 'renderer'), { recursive: true })
  rmSync(join(target, 'main', 'index.js'), { force: true })
  for (const path of filesUnder(join(target, 'main', 'chunks'))) {
    if (/[/\\]updater-[^/\\]+\.js$/.test(path)) rmSync(path, { force: true })
  }
  for (const path of filesUnder(join(target, 'renderer', 'assets'))) {
    if (/[/\\]AiPanel-[^/\\]+\.js$/.test(path)) rmSync(path, { force: true })
  }
  // The desktop package is ESM, while electron-vite emits this GenOffice
  // main-process entry as CommonJS. Keep the copied runtime's module boundary
  // explicit so development and packaged builds resolve it identically.
  writeFileSync(join(target, 'main', 'package.json'), '{\n  "type": "commonjs"\n}\n')
  assertEmbedBundle(join(target, 'main'))
  const forbiddenRuntimeFiles = filesUnder(target).filter((path) =>
    /[/\\](?:AiPanel|updater)-[^/\\]+\.js$/.test(path),
  )
  if (forbiddenRuntimeFiles.length > 0) {
    fail(`standalone AI/updater chunks leaked into runtime: ${forbiddenRuntimeFiles.join(', ')}`)
  }
  // Preload still exposes compatibility-shaped, inert AI methods to the shared
  // renderer. Only main-process code can register or execute those providers,
  // so enforce the network/handler boundary against docs/main.
  const executableText = filesUnder(join(target, 'main'))
    .filter((path) => path.endsWith('.js'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  const forbiddenBehaviors = [
    ['GenOffice AI login IPC', 'ai:gsk-login'],
    ['GenOffice AI streaming IPC', 'ai:stream-chunk'],
    ['Anthropic endpoint', 'api.anthropic.com'],
    ['OpenAI endpoint', 'api.openai.com'],
  ]
  for (const [label, marker] of forbiddenBehaviors) {
    if (executableText.includes(marker)) fail(`${label} leaked into the EverRoom runtime`)
  }
}

function copySheetsRuntime() {
  const target = join(stagingRoot, 'sheets')
  cpSync(join(sheetsOutput, 'main'), join(target, 'main'), { recursive: true })
  cpSync(join(sheetsOutput, 'preload'), join(target, 'preload'), { recursive: true })
  cpSync(join(sheetsOutput, 'renderer'), join(target, 'renderer'), { recursive: true })
  rmSync(join(target, 'main', 'index.js'), { force: true })
  writeFileSync(join(target, 'main', 'package.json'), '{\n  "type": "commonjs"\n}\n')
  assertEmbedBundle(join(target, 'main'))
  mkdirSync(join(stagingRoot, 'native'), { recursive: true })
  cpSync(sidecarOutput, join(stagingRoot, 'native', basename(sidecarOutput)))
}

function copySlidesRuntime() {
  const target = join(stagingRoot, 'slides')
  cpSync(join(slidesOutput, 'main'), join(target, 'main'), { recursive: true })
  cpSync(join(slidesOutput, 'preload'), join(target, 'preload'), { recursive: true })
  cpSync(join(slidesOutput, 'renderer'), join(target, 'renderer'), { recursive: true })
  rmSync(join(target, 'main', 'index.js'), { force: true })
  writeFileSync(join(target, 'main', 'package.json'), '{\n  "type": "commonjs"\n}\n')
  assertEmbedBundle(join(target, 'main'))
  // The AI panel is define-folded out of embed renderer builds; delete any
  // AiPanel chunk defensively (docs runtime does the same for its panel).
  for (const path of filesUnder(join(target, 'renderer', 'assets'))) {
    if (/[/\\]AiPanel-[^/\\]+\.js$/.test(path)) rmSync(path, { force: true })
  }
  // Same boundary as docs/main: no provider endpoints may ship in the closure.
  // (Genspark i18n strings are inert text; the registration paths are gone.)
  const executableText = filesUnder(join(target, 'main'))
    .filter((path) => path.endsWith('.js'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  for (const [label, marker] of [
    ['GenOffice AI login IPC', 'ai:gsk-login'],
    ['GenOffice AI streaming IPC', 'ai:stream'],
    ['Anthropic endpoint', 'api.anthropic.com'],
    ['OpenAI endpoint', 'api.openai.com'],
  ]) {
    if (executableText.includes(marker)) fail(`${label} leaked into the EverRoom runtime`)
  }
}

function runtimeHashes() {
  return Object.fromEntries(filesUnder(stagingRoot)
    .filter((path) => basename(path) !== 'manifest.json')
    .sort()
    .map((path) => [relative(stagingRoot, path).split('\\').join('/'), hashFile(path)]))
}

requireSubmodule()
const key = sourceKey()
if (cacheMatches(key)) {
  console.log(`[genoffice] runtime is current at ${outputRoot}`)
  process.exit(0)
}

if (!existsSync(join(sourceRoot, 'node_modules', '.package-lock.json'))) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], sourceRoot)
}

run('npm', ['run', 'build', '-w', '@genoffice/docs'], sourceRoot)
run('npm', ['run', 'build', '-w', '@genoffice/sheets'], sourceRoot)
run('npm', ['run', 'build', '-w', '@genoffice/slides'], sourceRoot)
assertApacheOnlyBuild()

rmSync(stagingRoot, { recursive: true, force: true })
try {
  mkdirSync(stagingRoot, { recursive: true })
  copyDocsRuntime()
  copySheetsRuntime()
  copySlidesRuntime()
  mkdirSync(join(stagingRoot, 'fixtures'), { recursive: true })
  cpSync(
    join(sourceRoot, 'fixtures', 'generated', 'simple.docx'),
    join(stagingRoot, 'fixtures', 'simple.docx'),
  )
  cpSync(join(sourceRoot, 'LICENSE'), join(stagingRoot, 'LICENSE'))
  cpSync(join(sourceRoot, 'NOTICE'), join(stagingRoot, 'NOTICE'))

  const manifest = {
    ...key,
    upstreamCommit: '583a045212f871943afb8ca4503fcb5ddf99a23f',
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    files: runtimeHashes(),
  }
  writeFileSync(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  mkdirSync(dirname(outputRoot), { recursive: true })
  rmSync(outputRoot, { recursive: true, force: true })
  renameSync(stagingRoot, outputRoot)
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}

const bytes = filesUnder(outputRoot).reduce((total, path) => total + statSync(path).size, 0)
console.log(`[genoffice] prepared DOCX runtime at ${outputRoot} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`)
