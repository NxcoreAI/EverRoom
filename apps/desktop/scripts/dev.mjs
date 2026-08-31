import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceEnvPath = resolve(desktopRoot, '../../.env')
if (existsSync(workspaceEnvPath)) process.loadEnvFile(workspaceEnvPath)
const electronExecutable = require('electron').trim()
const electronViteCli = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function electronHealthCheck(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  if (result.status === 0) return null
  if (result.error) return result.error.message
  if (result.signal) return `terminated by ${result.signal}`
  return `exited with code ${result.status ?? 'unknown'}`
}

function assertElectronHealthy(executable) {
  const failure = electronHealthCheck(executable)
  if (!failure) return

  console.error(`
[desktop] Electron executable is not runnable (${failure}):
  ${executable}

The Electron app bundle or its code signature is damaged. Reinstall workspace dependencies with:
  pnpm install --force
`)
  process.exit(1)
}

function prepareMacElectron() {
  const sourceApp = resolve(dirname(electronExecutable), '../..')
  const sourcePlist = join(sourceApp, 'Contents/Info.plist')
  const iconPath = join(desktopRoot, 'build/icon.icns')
  const cacheDirectory = join(desktopRoot, 'node_modules/.cache/everroom-electron')
  const brandedApp = join(cacheDirectory, 'EverRoom.app')
  const markerPath = join(cacheDirectory, 'build.json')
  const marker = JSON.stringify({
    brandingVersion: 6,
    electronExecutable,
    electronPlistModifiedAt: statSync(sourcePlist).mtimeMs,
    iconModifiedAt: statSync(iconPath).mtimeMs,
  })

  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) {
    const cachedExecutable = join(brandedApp, 'Contents/MacOS/Electron')
    if (!electronHealthCheck(cachedExecutable)) return cachedExecutable
    console.warn('[desktop] cached branded Electron is not runnable; rebuilding it.')
    rmSync(brandedApp, { recursive: true, force: true })
    rmSync(markerPath, { force: true })
  }

  assertElectronHealthy(electronExecutable)

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
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :NSDocumentsFolderUsageDescription string EverRoom needs access to selected folders to recognize supported documents in the file app.', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :NSDesktopFolderUsageDescription string EverRoom needs access to selected folders to recognize supported documents in the file app.', plistPath])
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
    assertElectronHealthy(electronExecutable)
    return electronExecutable
  }
  const brandedExecutable = join(brandedApp, 'Contents/MacOS/Electron')
  const brandedFailure = electronHealthCheck(brandedExecutable)
  if (brandedFailure) {
    console.warn(`[desktop] branded Electron is not runnable (${brandedFailure}); using the stock Electron executable for development.`)
    rmSync(brandedApp, { recursive: true, force: true })
    assertElectronHealthy(electronExecutable)
    return electronExecutable
  }
  writeFileSync(markerPath, marker)

  const devAppPath = brandedApp
  console.log(`
[desktop] macOS 开发环境「录屏与系统音频」授权指引:
  1. 打开 系统设置 → 隐私与安全性 → 录屏与系统音频 (Screen & System Audio Recording)
  2. 点击 "+" 号,前往并选择下方这个 app(注意是缓存里的 EverRoom.app,不是 release 安装包):
     ${devAppPath}
  3. 添加后按提示退出并重新启动开发版应用 (pnpm dev),权限即生效
  说明: 开发环境下真正发起系统音频捕获的是这个带 branding 的 Electron.app,
  TCC 权限按 app 路径+签名记录,所以必须给它授权而不是给终端或 IDE。
`)

  return brandedExecutable
}

if (process.platform !== 'darwin') assertElectronHealthy(electronExecutable)
const brandedElectron = process.platform === 'darwin' ? prepareMacElectron() : electronExecutable
const child = spawn(process.execPath, [electronViteCli, 'dev', ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_EXEC_PATH: brandedElectron },
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
