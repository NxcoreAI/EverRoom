import { cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const desktopRoot = resolve(import.meta.dirname, '..')
const connectorRoot = resolve(desktopRoot, '../gateway/src/modules/connector')
const outputRoot = resolve(desktopRoot, 'build/nango-runtime')
// Keep pnpm outside the repository workspace. Otherwise it discovers the
// root pnpm-workspace.yaml and can mutate EverRoom's own node_modules.
const stagingRoot = join(tmpdir(), `everroom-nango-runtime-${process.pid}`)

if (!existsSync(join(connectorRoot, 'package.json'))) {
  throw new Error(`Nango submodule is missing: ${connectorRoot}`)
}

const run = (command, args, cwd) => execFileSync(command, args, {
  cwd,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

// CI checks out the submodule fresh without its own node_modules; the build
// steps below (tsc, connect-ui vite build) need the connector's deps.
if (!existsSync(join(connectorRoot, 'node_modules'))) {
  run('npm', ['ci', '--force', '--no-audit', '--no-fund'], connectorRoot)
}

// Build Nango once, then copy only its compiled packages and production dependencies.
run('npm', ['exec', '--', 'tsc', '-b', 'packages/server/tsconfig.json', '--noCheck'], connectorRoot)
run('npm', ['run', '-w', '@nangohq/connect-ui', 'build'], connectorRoot)

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

const packageRoots = new Map()
for (const directory of readdirSync(join(connectorRoot, 'packages'))) {
  const packageRoot = join(connectorRoot, 'packages', directory)
  const manifestPath = join(packageRoot, 'package.json')
  if (existsSync(manifestPath)) packageRoots.set(JSON.parse(readFileSync(manifestPath, 'utf8')).name, { directory, packageRoot })
}

// Follow only Nango workspace dependencies reachable from the server. The old
// approach installed every production dependency in the monorepo (including
// jobs/runner/persist), making the temporary runtime directory exceed 1 GB.
const required = new Set(['@nangohq/nango-server', '@nangohq/connect-ui'])
const queue = ['@nangohq/nango-server', '@nangohq/connect-ui']
while (queue.length) {
  const name = queue.shift()
  const packageInfo = packageRoots.get(name)
  if (!packageInfo) continue
  const manifest = JSON.parse(readFileSync(join(packageInfo.packageRoot, 'package.json'), 'utf8'))
  for (const dependency of Object.keys({ ...manifest.dependencies })) {
    if (packageRoots.has(dependency) && !required.has(dependency)) {
      required.add(dependency)
      queue.push(dependency)
    }
  }
}

const serverManifest = JSON.parse(readFileSync(join(connectorRoot, 'packages/server/package.json'), 'utf8'))
const runtimeManifest = {
  name: '@everroom/nango-runtime',
  private: true,
  type: 'module',
  dependencies: {
    ...Object.fromEntries(Object.entries(serverManifest.dependencies).filter(([name]) => !packageRoots.has(name))),
    serve: '14.2.6',
    ...Object.fromEntries([...required].map((name) => [name, `file:./packages/${packageRoots.get(name).directory}`])),
  },
}
writeFileSync(join(stagingRoot, 'package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)

for (const name of required) {
  const { directory, packageRoot } = packageRoots.get(name)
  const destination = join(stagingRoot, 'packages', directory)
  mkdirSync(destination, { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(destination, 'package.json'))
  // data files referenced at runtime relative to the package root (flows.zero.json etc.)
  for (const file of readdirSync(packageRoot)) {
    if (/\.(json|ya?ml)$/.test(file) && file !== 'package.json') {
      cpSync(join(packageRoot, file), join(destination, file))
    }
  }
  for (const output of ['lib', 'dist', 'public']) {
    if (existsSync(join(packageRoot, output))) cpSync(join(packageRoot, output), join(destination, output), { recursive: true })
  }
  if (directory === 'database' && existsSync(join(packageRoot, 'scripts'))) {
    cpSync(join(packageRoot, 'scripts'), join(destination, 'scripts'), { recursive: true })
  }
  if (directory === 'providers' && existsSync(join(packageRoot, 'providers.yaml'))) {
    cpSync(join(packageRoot, 'providers.yaml'), join(destination, 'providers.yaml'))
  }
}

// server 从 packages/webapp/dist 静态托管 /images（logo 等），webapp 本体
// 不打包——只把 public/images 复制进 dist，与 dev 下 nango-supervisor 的做法一致。
const webappImages = join(connectorRoot, 'packages', 'webapp', 'public', 'images')
if (existsSync(webappImages)) {
  cpSync(webappImages, join(stagingRoot, 'packages', 'webapp', 'dist', 'images'), { recursive: true })
}

// pnpm handles the copied `file:` workspace packages without npm Arborist's
// `edgesOut` crash (npm 10/11 can fail when no lockfile exists for this graph).
// --node-linker=hoisted: pnpm's default symlink layout points into this staging
// tmpdir; after electron-builder moves the runtime (and the tmpdir is deleted)
// every link dangles and node_modules is dropped from the package entirely.
run('pnpm', ['install', '--prod', '--force', '--ignore-scripts', '--no-frozen-lockfile', '--node-linker=hoisted'], stagingRoot)

// electron-builder drops root node_modules from extraResources; nest deps
// under packages/ where the file tree survives packaging. ESM resolution
// from packages/server/dist/server.js walks up into packages/node_modules.
cpSync(join(stagingRoot, 'node_modules'), join(stagingRoot, 'packages', 'node_modules'), { recursive: true })
// .bin holds CLI symlinks whose relative targets dangle after the copy;
// the runtime spawns servers directly, never via .bin executables.
const packagedNodeModules = join(stagingRoot, 'packages', 'node_modules')
for (const directory of globSync('**/.bin', { cwd: packagedNodeModules })) {
  rmSync(join(packagedNodeModules, directory), { recursive: true, force: true })
}
// Root node_modules is dropped by electron-builder anyway; deleting it here
// avoids copying ~1G of dead weight into the package and re-scanning it.
rmSync(join(stagingRoot, 'node_modules'), { recursive: true, force: true })

// @embedded-postgres dylibs ship fully-versioned names but postgres links
// major-only (libzstd.1.dylib); duplicate the files at build time — real
// copies, because cpSync re-points copied symlinks at the (deleted) staging
// tmpdir and the runtime fix script can't see packages/node_modules anyway.
// There can be several copies (hoisted + nested under embedded-postgres's
// own node_modules) — patch every @embedded-postgres/<platform>/native/lib.
const findLibDirs = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '@embedded-postgres') {
        return readdirSync(path)
          .filter((platform) => existsSync(join(path, platform, 'native', 'lib')))
          .map((platform) => join(path, platform, 'native', 'lib'))
      }
      return findLibDirs(path)
    }
    return []
  })
for (const libDir of findLibDirs(join(stagingRoot, 'packages', 'node_modules'))) {
  for (const file of readdirSync(libDir)) {
    const m = file.match(/^(lib.+)\.(\d+)\.\d+(\.\d+)?\.(dylib|so)$/)
    if (!m) continue
    for (const link of [`${m[1]}.${m[2]}.${m[4]}`, `${m[1]}.${m[4]}`]) {
      const linkPath = join(libDir, link)
      if (!existsSync(linkPath)) cpSync(join(libDir, file), linkPath)
    }
  }
}

rmSync(outputRoot, { recursive: true, force: true })
cpSync(stagingRoot, outputRoot, { recursive: true })
rmSync(stagingRoot, { recursive: true, force: true })

// pnpm materialized the `file:` workspace deps as real dirs under
// packages/node_modules/@nangohq/*. @nangohq/utils computes projectRoot from
// __filename (../../../..), so those copies shift the "repo root" to
// packages/node_modules and break every projectRoot-relative resource
// (migrations, flows.zero.json, ...). Replace them with relative symlinks
// back to packages/<dir>: Node resolves module realpaths by default, so
// __filename lands in packages/<dir> and projectRoot matches dev layout.
for (const name of required) {
  const { directory } = packageRoots.get(name)
  const scoped = name.split('/')
  const nmPath = join(outputRoot, 'packages', 'node_modules', ...scoped)
  rmSync(nmPath, { recursive: true, force: true })
  symlinkSync(join('../../', directory), nmPath, 'dir')
}
console.log(`Prepared Nango runtime at ${outputRoot}`)
