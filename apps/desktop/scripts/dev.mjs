import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 打包态的文档类型关联由 electron-builder 从 mac.extendInfo 写进 Info.plist；开发态
// 直接读同一份清单，让缓存里的 branded Electron 也能在访达「打开方式」里出现
// （避免两处清单漂移）。
const documentTypes = JSON.parse(
  readFileSync(join(desktopRoot, 'package.json'), 'utf8'),
).build?.mac?.extendInfo?.CFBundleDocumentTypes ?? []
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

// TCC（屏幕录制/麦克风等）只对签名校验通过的应用生效。pnpm 安装的 Electron
// dist 可能整包缺 _CodeSignature（曾实锤 electron@40.10.6），克隆出的带牌应用
// 会带着「签名指示有资源但资源缺失」的坏签名运行——表现为用户在系统设置授权
// 后应用内仍然报未授权。因此缓存命中与重签结果都必须做签名校验。
function signatureHealthy(appBundle) {
  const result = spawnSync('/usr/bin/codesign', ['--verify', appBundle], { encoding: 'utf8' })
  return result.status === 0
}

// pnpm 解压 Electron dist 包时会把 framework 的符号链接拍平成真实拷贝：
// Versions/Current 与顶层二进制/Resources 全是实目录/实文件。codesign 对这种
// 结构判「bundle format is ambiguous」拒绝签名，_CodeSignature 永远生成不了。
// 这里恢复规范结构：Versions/Current -> A，顶层条目 -> Versions/Current/<name>。
function repairFrameworkLayouts(frameworksDir) {
  if (!existsSync(frameworksDir)) return
  for (const name of readdirSync(frameworksDir)) {
    if (!name.endsWith('.framework')) continue
    const frameworkPath = join(frameworksDir, name)
    const versionsA = join(frameworkPath, 'Versions/A')
    if (!existsSync(versionsA)) continue
    const currentPath = join(frameworkPath, 'Versions/Current')
    rmSync(currentPath, { recursive: true, force: true })
    symlinkSync('A', currentPath)
    for (const entry of readdirSync(versionsA)) {
      const topLevel = join(frameworkPath, entry)
      rmSync(topLevel, { recursive: true, force: true })
      symlinkSync(join('Versions/Current', entry), topLevel)
    }
  }
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

/**
 * 访达「打开方式」/ 双击文档：把 package.json 的 mac.extendInfo.CFBundleDocumentTypes
 * 写进开发态 Info.plist。LSHandlerRank=Alternate 表示不抢系统默认打开方式，只出现在
 * 右键「打开方式」里；用户可自行设为默认。数组/字符串两种值按 PlistBuddy 语法展开。
 */
function applyDocumentTypes(plistPath, types) {
  spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :CFBundleDocumentTypes', plistPath], { stdio: 'ignore' })
  if (types.length === 0) return
  run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleDocumentTypes array', plistPath])
  types.forEach((type, index) => {
    const base = `:CFBundleDocumentTypes:${index}`
    run('/usr/libexec/PlistBuddy', ['-c', `Add ${base} dict`, plistPath])
    for (const [key, value] of Object.entries(type)) {
      if (Array.isArray(value)) {
        run('/usr/libexec/PlistBuddy', ['-c', `Add ${base}:${key} array`, plistPath])
        value.forEach((item, itemIndex) => {
          run('/usr/libexec/PlistBuddy', ['-c', `Add ${base}:${key}:${itemIndex} string ${item}`, plistPath])
        })
      } else {
        run('/usr/libexec/PlistBuddy', ['-c', `Add ${base}:${key} string ${value}`, plistPath])
      }
    }
  })
}

/** 让 LaunchServices 立刻认识开发态 app 的文档类型（否则要等系统下次扫描）。 */
function registerWithLaunchServices(appBundle) {
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  if (!existsSync(lsregister)) return
  const result = spawnSync(lsregister, ['-f', appBundle], { stdio: 'ignore' })
  if (result.status !== 0) {
    console.warn('[desktop] LaunchServices registration failed; Finder may not list EverRoom under Open With until the next launch.')
  }
}

function prepareMacElectron() {
  const sourceApp = resolve(dirname(electronExecutable), '../..')
  const sourcePlist = join(sourceApp, 'Contents/Info.plist')
  const iconPath = join(desktopRoot, 'build/icon.icns')
  const cacheDirectory = join(desktopRoot, 'node_modules/.cache/everroom-electron')
  const brandedApp = join(cacheDirectory, 'EverRoom.app')
  const markerPath = join(cacheDirectory, 'build.json')
  const marker = JSON.stringify({
    brandingVersion: 10,
    electronExecutable,
    electronPlistModifiedAt: statSync(sourcePlist).mtimeMs,
    iconModifiedAt: statSync(iconPath).mtimeMs,
  })

  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) {
    const cachedExecutable = join(brandedApp, 'Contents/MacOS/Electron')
    if (!electronHealthCheck(cachedExecutable)) {
      if (signatureHealthy(brandedApp)) return cachedExecutable
      console.warn('[desktop] cached branded Electron has an invalid code signature; rebuilding it (TCC permissions cannot bind to a broken signature).')
    }
    rmSync(brandedApp, { recursive: true, force: true })
    rmSync(markerPath, { force: true })
  }

  assertElectronHealthy(electronExecutable)

  mkdirSync(cacheDirectory, { recursive: true })
  rmSync(brandedApp, { recursive: true, force: true })

  const clone = spawnSync('/bin/cp', ['-cR', sourceApp, brandedApp], { stdio: 'inherit' })
  if (clone.status !== 0) cpSync(sourceApp, brandedApp, { recursive: true })

  const plistPath = join(brandedApp, 'Contents/Info.plist')
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName EverOffice', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName EverOffice', plistPath])
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier ai.nxcore.everoffice', plistPath])
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
  applyDocumentTypes(plistPath, documentTypes)
  copyFileSync(iconPath, join(brandedApp, 'Contents/Resources/icon.icns'))
  repairFrameworkLayouts(join(brandedApp, 'Contents/Frameworks'))
  // 开发推送验证需要真实 Team 签名 + aps-environment entitlement（ad-hoc 签名无法注册 APNs）。
  // 未配置开发者证书时回退 ad-hoc，推送不可用但应用可跑。
  const devEntitlements = join(cacheDirectory, 'dev-entitlements.plist')
  writeFileSync(devEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key>
  <string>SS33VDS3A4.ai.nxcore.everoffice</string>
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
  // macOS 26 (Tahoe)：无 embedded provisioning profile 时携带 aps-environment/
  // application-identifier/keychain-access-groups 这组 entitlements 会导致 GPU
  // helper 进程被系统 SIGKILL（签名验证失败）。因此按 profile 有无分级：
  // 有 profile → 全套（APNs 推送可用）；无 profile → 仅 cs.* 运行时三项。
  const runtimeEntitlements = join(cacheDirectory, 'dev-runtime-entitlements.plist')
  writeFileSync(runtimeEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`)
  // macOS 26 (Tahoe)：开发证书 + provisioning 类 entitlements（aps-environment/
  // application-identifier/keychain-access-groups，即使 embedded profile 完全匹配）
  // 会导致 GPU helper 进程被系统 SIGKILL（GPU process isn't usable）。
  // 实验结论（2026-09-03）：同二进制 adhoc 签名或仅 cs.* entitlements 均正常。
  // 因此 dev 默认只用 cs.* 运行时三项；需要调试 APNs 推送时显式设
  // EVERROOM_MAC_DEV_PUSH=1 恢复全套（代价：本机 GPU 可能不可用）。
  const wantDevPush = process.env.EVERROOM_MAC_DEV_PUSH === '1'
  let effectiveEntitlements = runtimeEntitlements
  if (wantDevPush) {
    const profileSource = process.env.EVERROOM_MAC_DEV_PROFILE ?? findNewestProfile(join(process.env.HOME ?? '', 'Library/Developer/Xcode/UserData/Provisioning/Profiles'))
    if (profileSource) {
      copyFileSync(profileSource, join(brandedApp, 'Contents/embedded.provisionprofile'))
      effectiveEntitlements = devEntitlements
      console.log(`[desktop] embedded provisioning profile: ${profileSource}`)
    } else {
      console.warn('[desktop] EVERROOM_MAC_DEV_PUSH=1 but no provisioning profile found; falling back to runtime-only entitlements.')
    }
  } else {
    console.log('[desktop] dev entitlements: runtime-only (set EVERROOM_MAC_DEV_PUSH=1 to enable APNs debugging; may trigger macOS 26 GPU kills)')
  }
  const devIdentity = process.env.EVERROOM_MAC_SIGN_IDENTITY ?? findDevelopmentIdentity()
  let signing
  if (devIdentity) {
    console.log(`[desktop] signing dev Electron with: ${devIdentity}`)
    signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--timestamp=none', '--entitlements', effectiveEntitlements, '--sign', devIdentity, brandedApp], { stdio: 'inherit' })
    if (signing.status !== 0) {
      console.warn(`[desktop] entitlements signing failed (exit ${signing.status}); retrying without entitlements.`)
      signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', devIdentity, brandedApp], { stdio: 'inherit' })
    }
  } else {
    console.warn('[desktop] no Apple Development signing identity found; falling back to ad-hoc signing. APNs push registration will be unavailable in this dev session.')
    signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', brandedApp], { stdio: 'inherit' })
  }
  if (signing.status !== 0 || !signatureHealthy(brandedApp)) {
    console.warn(`[desktop] dev Electron signing failed (exit ${signing.status}): ${signing.stderr ?? 'no stderr'}; retrying with ad-hoc signing.`)
    signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', brandedApp], { stdio: 'inherit' })
  }
  if (signing.status !== 0 || !signatureHealthy(brandedApp)) {
    console.error(`
[desktop] branded Electron signature is invalid after signing.
  Screen recording / microphone permissions cannot be granted to this app until fixed.
  Try: rm -rf "${cacheDirectory}" && pnpm dev
`)
    process.exit(1)
  }
  const brandedExecutable = join(brandedApp, 'Contents/MacOS/Electron')
  const brandedFailure = electronHealthCheck(brandedExecutable)
  if (brandedFailure) {
    console.warn(`[desktop] branded Electron failed health check (${brandedFailure}); this usually means aps-environment entitlement requires a provisioning profile.`)
    console.warn('[desktop] falling back to plain certificate signature so the app stays runnable (no push).')
    const plain = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', devIdentity || '-', brandedApp], { stdio: 'inherit' })
    if (plain.status === 0 && !electronHealthCheck(brandedExecutable)) {
      writeFileSync(markerPath, marker)
      registerWithLaunchServices(brandedApp)
      console.log(`[desktop] branded dev Electron ready (no push entitlement): ${brandedApp}`)
      return brandedExecutable
    }
    rmSync(brandedApp, { recursive: true, force: true })
    assertElectronHealthy(electronExecutable)
    return electronExecutable
  }
  writeFileSync(markerPath, marker)
  registerWithLaunchServices(brandedApp)
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
