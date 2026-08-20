import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceEnvPath = resolve(desktopRoot, '../../.env')
if (existsSync(workspaceEnvPath)) process.loadEnvFile(workspaceEnvPath)
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
    brandingVersion: 5,
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
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :NSMicrophoneUsageDescription EverRoom needs microphone access to record and transcribe your voice.', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :NSAudioCaptureUsageDescription EverRoom needs system audio access to record and transcribe audio playing on this Mac.', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleURLTypes array', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleURLTypes:0 dict', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLName string com.nxcore.everroom.auth', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string everroom', plistPath])
  copyFileSync(iconPath, join(brandedApp, 'Contents/Resources/icon.icns'))
  const signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', brandedApp], { stdio: 'inherit' })
  if (signing.status !== 0) {
    console.warn('[desktop] ad-hoc Electron signing is unavailable; using the stock Electron executable for development.')
    rmSync(brandedApp, { recursive: true, force: true })
    return electronExecutable
  }
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
