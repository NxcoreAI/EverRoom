import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronExecutable = require('electron')
const electronViteCli = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function prepareMacElectron() {
  const sourceApp = resolve(dirname(electronExecutable), '../..')
  const sourcePlist = join(sourceApp, 'Contents/Info.plist')
  const iconPath = join(desktopRoot, 'build/icon.icns')
  const cacheDirectory = join(desktopRoot, 'node_modules/.cache/everroom-electron')
  const brandedApp = join(cacheDirectory, 'EverRoom.app')
  const markerPath = join(cacheDirectory, 'build.json')
  const marker = JSON.stringify({
    electronExecutable,
    electronPlistModifiedAt: statSync(sourcePlist).mtimeMs,
    iconModifiedAt: statSync(iconPath).mtimeMs,
  })

  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) {
    return join(brandedApp, 'Contents/MacOS/Electron')
  }

  mkdirSync(cacheDirectory, { recursive: true })
  rmSync(brandedApp, { recursive: true, force: true })

  const clone = spawnSync('/bin/cp', ['-cR', sourceApp, brandedApp], { stdio: 'inherit' })
  if (clone.status !== 0) cpSync(sourceApp, brandedApp, { recursive: true })

  const plistPath = join(brandedApp, 'Contents/Info.plist')
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName EverRoom', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName EverRoom', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.nxcore.everroom.dev', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile icon.icns', plistPath])
  copyFileSync(iconPath, join(brandedApp, 'Contents/Resources/icon.icns'))
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', brandedApp])
  writeFileSync(markerPath, marker)

  return join(brandedApp, 'Contents/MacOS/Electron')
}

const brandedElectron = process.platform === 'darwin' ? prepareMacElectron() : electronExecutable
const child = spawn(process.execPath, [electronViteCli, 'dev', ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_EXEC_PATH: brandedElectron },
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
