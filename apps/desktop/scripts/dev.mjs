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

function electronHealthCheck(executable, retries = 3, delayMs = 1500) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
    if (result.status === 0) return null
    // Gatekeeper 在新签名落盘后可能有短暂的首次评估延迟，稍等重试。
    if (attempt < retries) spawnSync('/bin/sleep', [String((delayMs / 1000).toFixed(1))])
  }
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
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

// 从钥匙串自动发现 Apple Development 证书（用于 dev 推送签名），找不到返回空串。
function findDevelopmentIdentity() {
  const listed = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (listed.status !== 0) return ''
  const match = listed.stdout.match(/^\s*\d+\)\s+[0-9A-F]+\s+"(Apple Development: [^"]+)"$/m)
  return match?.[1] ?? ''
}

// 找 profile 目录里最新修改的 .provisionprofile（dev 推送 entitlement 校验用）。
function findNewestProfile(directory) {
  if (!existsSync(directory)) return null
  const entries = spawnSync('/bin/ls', ['-t', directory], { encoding: 'utf8' })
  if (entries.status !== 0) return null
  const newest = entries.stdout.split('\n').find(name => name.endsWith('.provisionprofile'))
  return newest ? join(directory, newest) : null
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
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier ai.nxcore.everroom', plistPath])
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
  // 开发推送验证需要真实 Team 签名 + aps-environment entitlement（ad-hoc 签名无法注册 APNs）。
  // 未配置开发者证书时回退 ad-hoc，推送不可用但应用可跑。
  const devEntitlements = join(cacheDirectory, 'dev-entitlements.plist')
  writeFileSync(devEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key>
  <string>SS33VDS3A4.ai.nxcore.everroom</string>
  <key>com.apple.developer.aps-environment</key>
  <string>development</string>
  <key>com.apple.developer.team-identifier</key>
  <string>SS33VDS3A4</string>
  <key>keychain-access-groups</key>
  <array>
    <string>SS33VDS3A4.*</string>
  </array>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`)
  // Profile 必须嵌入 app 才能让 aps-environment entitlement 通过 AMFI 校验。
  // EVERROOM_MAC_DEV_PROFILE 指向 .provisionprofile；默认找 Xcode profile 目录里最新的。
  const profileSource = process.env.EVERROOM_MAC_DEV_PROFILE ?? findNewestProfile(join(process.env.HOME ?? '', 'Library/Developer/Xcode/UserData/Provisioning/Profiles'))
  if (profileSource) {
    copyFileSync(profileSource, join(brandedApp, 'Contents/embedded.provisionprofile'))
    console.log(`[desktop] embedded provisioning profile: ${profileSource}`)
  } else {
    console.warn('[desktop] no macOS development provisioning profile found; APNs entitlement may be rejected.')
  }
  const devIdentity = process.env.EVERROOM_MAC_SIGN_IDENTITY ?? findDevelopmentIdentity()
  let signing
  if (devIdentity) {
    console.log(`[desktop] signing dev Electron with: ${devIdentity}`)
    signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--timestamp=none', '--entitlements', devEntitlements, '--sign', devIdentity, brandedApp], { stdio: 'inherit' })
    if (signing.status !== 0) {
      console.warn(`[desktop] entitlements signing failed (exit ${signing.status}); retrying without entitlements. APNs push will be unavailable until a provisioning profile is provided.`)
      signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', devIdentity, brandedApp], { stdio: 'inherit' })
    }
  } else {
    console.warn('[desktop] no Apple Development signing identity found; falling back to ad-hoc signing. APNs push registration will be unavailable in this dev session.')
    signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', brandedApp], { stdio: 'inherit' })
  }
  if (signing.status !== 0) {
    console.warn(`[desktop] dev Electron signing failed (exit ${signing.status}): ${signing.stderr ?? 'no stderr'}`)
    console.warn('[desktop] keeping branded app with its current (possibly ad-hoc) signature and continuing.')
  }
  const brandedExecutable = join(brandedApp, 'Contents/MacOS/Electron')
  const brandedFailure = electronHealthCheck(brandedExecutable)
  if (brandedFailure) {
    console.warn(`[desktop] branded Electron failed health check (${brandedFailure}); this usually means aps-environment entitlement requires a provisioning profile.`)
    console.warn('[desktop] falling back to plain certificate signature so the app stays runnable (no push).')
    const plain = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', devIdentity || '-', brandedApp], { stdio: 'inherit' })
    if (plain.status === 0 && !electronHealthCheck(brandedExecutable)) {
      writeFileSync(markerPath, marker)
      console.log(`[desktop] branded dev Electron ready (no push entitlement): ${brandedApp}`)
      return brandedExecutable
    }
    rmSync(brandedApp, { recursive: true, force: true })
    assertElectronHealthy(electronExecutable)
    return electronExecutable
  }
  writeFileSync(markerPath, marker)
  console.log(`[desktop] branded dev Electron ready: ${brandedApp}`)

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
