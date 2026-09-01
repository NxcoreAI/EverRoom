// Audits the Windows packaging output without installing it: mirrors the
// macOS "Audit package contents" CI step for the NSIS/win-unpacked layout.
// Node standard library + the repo's existing @electron/asar only.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { listPackage } from '@electron/asar'

const desktopRoot = resolve(import.meta.dirname, '..')
const releaseRoot = resolve(process.env.EVERROOM_RELEASE_DIR ?? join(desktopRoot, '..', '..', 'release'))
const version = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).version
const unpackedRoot = join(releaseRoot, 'win-unpacked')
const appRoot = join(unpackedRoot, 'EverRoom.exe')
const resourcesRoot = join(unpackedRoot, 'resources')
const installerPath = join(releaseRoot, `EverRoom-${version}-windows-x64.exe`)

const failures = []
const checked = []
const fail = (message) => failures.push(message)
const expectFile = (path, label) => {
  checked.push(label)
  if (!existsSync(path) || !statSync(path).isFile()) fail(`Missing ${label}: ${relative(releaseRoot, path)}`)
}
const expectPath = (path, label) => {
  checked.push(label)
  if (!existsSync(path)) fail(`Missing ${label}: ${relative(releaseRoot, path)}`)
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

// The same rule set the macOS audit applies: no env files, test files, source
// maps, or stray TypeScript in anything users install.
const forbidden = /(^|[\\/])(\.env($|\.)|(__tests__|tests?)([\\/]|$)|[^\\/]*(\.test|\.spec)\.[^\\/]+$|(test|spec)\.[^\\/]+$)|\.map$/i
const typescript = /\.(ts|tsx|mts|cts)$/i

// --- Installer and unpacked layout -----------------------------------------
expectFile(installerPath, 'NSIS installer')
if (existsSync(installerPath)) {
  // Cheap corruption guard: a Windows installer is a PE image ("MZ").
  const header = readFileSync(installerPath).subarray(0, 2).toString('latin1')
  if (header !== 'MZ') fail(`Installer is not a PE executable: ${relative(releaseRoot, installerPath)}`)
}
expectFile(appRoot, 'win-unpacked EverRoom.exe')
expectFile(join(resourcesRoot, 'packaged-env.json'), 'packaged-env.json')
expectFile(join(resourcesRoot, 'app.asar'), 'app.asar')

// --- Loose files under resources -------------------------------------------
// nango/ ships a vendored runtime whose compiled dist imports *.test.js and
// whose node_modules holds test fixtures — required at runtime, exempt from the
// loose-file audit (same exemption as the macOS step) and audited separately.
const nangoRoot = join(resourcesRoot, 'nango')
const looseFiles = filesUnder(resourcesRoot).filter((path) => !path.startsWith(nangoRoot + sep))
for (const path of looseFiles) {
  const normalized = relative(resourcesRoot, path).split('\\').join('/')
  if (forbidden.test(normalized)) fail(`Forbidden loose file: ${normalized}`)
  if (typescript.test(normalized) && !normalized.startsWith('open-connector/')) {
    fail(`Unexpected TypeScript in package: ${normalized}`)
  }
}
for (const path of filesUnder(join(resourcesRoot, 'nango'))) {
  const normalized = relative(resourcesRoot, path).split('\\').join('/')
  if (/(^|\/)\.env($|\.)/i.test(normalized) || /\.(map|ts|tsx|mts|cts)$/i.test(normalized)) {
    fail(`Forbidden file in nango runtime: ${normalized}`)
  }
}

// --- asar contents ----------------------------------------------------------
let asarFiles = []
if (existsSync(join(resourcesRoot, 'app.asar'))) {
  asarFiles = listPackage(join(resourcesRoot, 'app.asar')).map((path) => String(path).split('\\').join('/'))
  for (const path of asarFiles) {
    if (forbidden.test(path)) fail(`Forbidden file in app.asar: ${path}`)
    if (typescript.test(path) && !/[\\/]node_modules[\\/]@tencentdb-agent-memory[\\/](memory-tencentdb-v2|knowledge-service)[\\/]src[\\/]/.test(path)) {
      fail(`Unexpected TypeScript in app.asar: ${path}`)
    }
  }
}

const asarHas = (fragment) => asarFiles.some((path) => path.includes(fragment))

// --- Required runtime entries ----------------------------------------------
// Desktop entry points and bundled memory runtimes (spawned from the asar).
if (!asarHas('out/main/index.js')) fail('app.asar is missing the main entry out/main/index.js')
for (const fragment of [
  'memory-tencentdb-v2/bin/memory-gateway.mjs',
  'memory-tencentdb-v2/src/gateway/server.ts',
  'knowledge-service/src/server.ts',
]) {
  if (!asarHas(fragment)) fail(`app.asar is missing ${fragment}`)
}
// Windows native packages for the memory stack (napi-rs resolves them at
// runtime; smartUnpack lifts their .node files next to the asar).
for (const fragment of [
  '@node-rs/jieba-win32-x64-msvc',
  '@colbymchenry/codegraph-win32-x64',
  'sqlite-vec-windows-x64',
]) {
  if (!asarHas(fragment)) fail(`app.asar is missing native package ${fragment}`)
}

const unpackedNodeModules = join(resourcesRoot, 'app.asar.unpacked', 'node_modules')
expectFile(join(unpackedNodeModules, 'better-sqlite3', 'prebuilds', 'win32-x64.node'), 'asar-unpacked better-sqlite3 win32-x64 prebuild')
// esbuild puts the Windows binary at the package root; macOS uses bin/.
const esbuildBin = [join(unpackedNodeModules, '@esbuild', 'win32-x64', 'esbuild.exe'), join(unpackedNodeModules, '@esbuild', 'win32-x64', 'bin', 'esbuild.exe')]
  .find((path) => existsSync(path))
if (!esbuildBin) fail('asar-unpacked esbuild win32-x64 binary is missing')
// sqlite-vec ships a SQLite loadable extension (.dll) on Windows, not a .node.
const sqliteVecNative = filesUnder(join(unpackedNodeModules, 'sqlite-vec-windows-x64')).filter((path) => /\.(node|dll)$/i.test(path))
if (sqliteVecNative.length === 0) fail('asar-unpacked sqlite-vec-windows-x64 has no native library (.node/.dll)')

// Gateway service (extraResources).
expectFile(join(resourcesRoot, 'gateway', 'serve.js'), 'gateway entry serve.js')
expectPath(join(resourcesRoot, 'gateway', 'drizzle'), 'gateway drizzle migrations')
expectFile(join(resourcesRoot, 'gateway', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'), 'gateway better-sqlite3 win32-x64 prebuild')
const canvasNode = filesUnder(join(resourcesRoot, 'gateway', 'node_modules', '@napi-rs')).filter((path) => path.endsWith('.node'))
if (canvasNode.length === 0) fail('gateway @napi-rs/canvas win32-x64 native is missing')

// OpenConnector, Nango (with Windows embedded PostgreSQL), oo CLI, GenOffice.
expectFile(join(resourcesRoot, 'open-connector', 'src', 'server', 'index.ts'), 'open-connector entry')
expectFile(join(resourcesRoot, 'open-connector', 'dist', 'web', 'index.html'), 'open-connector web dist')
expectFile(join(resourcesRoot, 'nango', 'packages', 'server', 'dist', 'server.js'), 'nango server entry')
const postgresBin = filesUnder(join(resourcesRoot, 'nango')).filter((path) => /[\\/]postgres\.exe$/.test(path))
if (postgresBin.length === 0) fail('nango windows-x64 embedded PostgreSQL (postgres.exe) is missing')
const ooExe = join(resourcesRoot, 'oo', 'win32-x64', 'oo.exe')
expectFile(ooExe, 'oo CLI win32-x64')
expectFile(join(resourcesRoot, 'genoffice', 'native', 'xlsx-sidecar.exe'), 'genoffice xlsx-sidecar.exe')
for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
  expectFile(join(resourcesRoot, 'genoffice', app, 'main', 'embed.js'), `genoffice ${app} embed entry`)
}

// Run the packaged oo CLI once — the macOS audit does the same.
if (existsSync(ooExe)) {
  try {
    execFileSync(ooExe, ['--version'], { stdio: 'pipe', timeout: 60_000, windowsHide: true })
  } catch (error) {
    fail(`oo CLI --version failed: ${error.stderr?.toString() ?? error.message}`)
  }
}

// Start the packaged Nango runtime once. Static file checks cannot catch
// workspace links being materialized into a layout with a wrong projectRoot.
const nangoEntry = join(nangoRoot, 'packages', 'server', 'dist', 'server.js')
if (existsSync(appRoot) && existsSync(nangoEntry) && postgresBin.length > 0) {
  const smokeRoot = join(releaseRoot, '.nango-smoke')
  rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 3 })
  mkdirSync(smokeRoot, { recursive: true })
  let output = ''
  const child = spawn(appRoot, [nangoEntry], {
    cwd: join(nangoRoot, 'packages', 'server'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NANGO_EMBEDDED_DB: 'true',
      NANGO_DB_PORT: '5433',
      NANGO_EMBEDDED_DB_DIR: join(smokeRoot, 'embedded-postgres'),
      NANGO_SERVER_URL: 'http://localhost:3003',
      FLAG_AUTH_ENABLED: 'false',
      NANGO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SERVER_PORT: '3003',
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-8_000) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-8_000) })
  try {
    const deadline = Date.now() + 120_000
    let ready = false
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        ready = (await fetch('http://127.0.0.1:3003/health', { signal: AbortSignal.timeout(1_000) })).ok
      } catch {}
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) fail(`Packaged Nango health check failed (exit=${String(child.exitCode)}): ${output.trim()}`)
  } finally {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {}
    rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}

// --- Report -----------------------------------------------------------------
console.log(`Verified Windows package v${version}: ${checked.length} required entries, ${looseFiles.length} loose files, ${asarFiles.length} asar entries audited`)
if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`)
  process.exit(1)
}
console.log('Windows package audit passed')
