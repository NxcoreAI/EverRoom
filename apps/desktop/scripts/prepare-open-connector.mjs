import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const OPEN_CONNECTOR_REVISION = '5719a69468c698c7cb8108e062ff64ecef8a2e65'
const require = createRequire(import.meta.url)
const sourcePackagePath = require.resolve('@oomol-lab/open-connector/package.json')
const sourceDirectory = dirname(sourcePackagePath)
const desktopDirectory = dirname(import.meta.dirname)
const buildDirectory = join(desktopDirectory, 'build')
const targetDirectory = join(buildDirectory, 'open-connector')
const markerPath = join(targetDirectory, '.everroom-runtime.json')

const sourceManifest = JSON.parse(await readFile(sourcePackagePath, 'utf8'))
const expectedMarker = JSON.stringify({
  runtimeFormat: 1,
  revision: OPEN_CONNECTOR_REVISION,
  version: sourceManifest.version,
})

if (
  existsSync(markerPath)
  && await readFile(markerPath, 'utf8').catch(() => '') === expectedMarker
  && existsSync(join(targetDirectory, 'src', 'server', 'index.ts'))
  && existsSync(join(targetDirectory, 'catalog', 'apps'))
  && existsSync(join(targetDirectory, 'dist', 'web', 'index.html'))
) {
  console.log(`OpenConnector runtime is ready: ${targetDirectory}`)
  process.exit(0)
}

const stagingDirectory = join(buildDirectory, `.open-connector-${process.pid}`)
await mkdir(buildDirectory, { recursive: true })
await rm(stagingDirectory, { recursive: true, force: true })

for (const entry of [
  'package.json',
  'tsconfig.json',
  'LICENSE.txt',
  'NOTICE.md',
  'src',
  'scripts',
  'migrations',
  'web',
]) {
  await cp(join(sourceDirectory, entry), join(stagingDirectory, entry), {
    recursive: true,
    dereference: true,
  })
}

try {
  await run('npm', ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stagingDirectory)
  await run(process.execPath, ['scripts/ensure-generated.ts'], stagingDirectory)
  await run('npm', ['run', 'build:web'], stagingDirectory)

  const runtimeManifest = JSON.parse(await readFile(join(stagingDirectory, 'package.json'), 'utf8'))
  delete runtimeManifest.workspaces
  delete runtimeManifest.devDependencies
  runtimeManifest.scripts = {}
  await writeFile(join(stagingDirectory, 'package.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
  await rm(join(stagingDirectory, 'web'), { recursive: true, force: true })
  await run('npm', ['prune', '--omit=dev', '--ignore-scripts'], stagingDirectory)

  const finalDirectory = `${stagingDirectory}-runtime`
  await rm(finalDirectory, { recursive: true, force: true })
  await mkdir(finalDirectory, { recursive: true })
  for (const entry of [
    'package.json',
    'LICENSE.txt',
    'NOTICE.md',
    'src',
    'catalog',
    'dist',
    'migrations',
    'node_modules',
  ]) {
    await cp(join(stagingDirectory, entry), join(finalDirectory, entry), {
      recursive: true,
      dereference: true,
      ...(entry === 'src' ? {
        filter: (source) => !source.split(/[\\/]/).some((segment) => (
          segment === '__tests__' || /\.test\.[cm]?[jt]sx?$/.test(segment)
        )),
      } : {}),
    })
  }
  await writeFile(join(finalDirectory, '.everroom-runtime.json'), expectedMarker)
  await rm(targetDirectory, { recursive: true, force: true })
  await rename(finalDirectory, targetDirectory)
  console.log(`Prepared OpenConnector ${sourceManifest.version}: ${targetDirectory}`)
} finally {
  await rm(stagingDirectory, { recursive: true, force: true })
}

function run(command, arguments_, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`))
    })
  })
}
