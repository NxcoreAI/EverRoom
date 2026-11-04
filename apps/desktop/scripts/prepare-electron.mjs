import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Electron 的二进制由 electron 包自己的 postinstall（install.js + @electron/get）
// 下载解压到 node_modules/.pnpm/electron@*/node_modules/electron/dist，并写 path.txt。
// 这一步会被 `pnpm install --ignore-scripts` 跳过，也会在 GitHub Releases 不可达时
// 下载失败——两种情况下 node_modules 里只剩 JS 壳子，dev.mjs 顶部的 require('electron')
// 会直接抛「Electron failed to install correctly, please delete node_modules/electron…」，
// 而真正的修法（重跑 install.js 或走镜像）并没有人告诉用户。
//
// 因此这里在 dev/打包前做自愈：检测二进制是否在位，缺了就重跑 electron 自带 install.js；
// 官方源失败时回退 npmmirror 镜像（国内网络通常只有镜像可达，且能命中 @electron/get 本地缓存）。
const require = createRequire(import.meta.url)

const electronDir = dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')
const platformPath =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'

function readVersion() {
  try {
    return readFileSync(join(electronDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '')
  } catch {
    return null
  }
}

function readPathFile() {
  try {
    return readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()
  } catch {
    return null
  }
}

function electronInstalled() {
  if (readVersion() !== version) return false
  if (readPathFile() !== platformPath) return false
  return existsSync(join(electronDir, 'dist', platformPath))
}

// 与 electron/install.js 的镜像变量一致：ELECTRON_MIRROR / ELECTRON_CUSTOM_DIR。
const MIRROR = 'https://npmmirror.com/mirrors/electron/'
const MIRROR_CUSTOM_DIR = 'v{{ version }}'

function runInstaller(extraEnv) {
  console.log(`[desktop] installing Electron ${version} binary (${process.platform}-${process.arch})…`)
  const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  return result.status === 0 && electronInstalled()
}

if (electronInstalled()) {
  process.exit(0)
}

// 1) 先按用户环境下载（含 .npmrc 的 electron_mirror 配置）。
// 2) 官方 GitHub Releases 在国内网络常常超时，失败后回退 npmmirror 镜像重试。
if (runInstaller({}) || runInstaller({ ELECTRON_MIRROR: MIRROR, ELECTRON_CUSTOM_DIR: MIRROR_CUSTOM_DIR })) {
  console.log(`[desktop] Electron ${version} binary ready: ${join(electronDir, 'dist')}`)
  process.exit(0)
}

console.error(`
[desktop] Electron ${version} binary could not be installed.
  electron package: ${electronDir}

排查建议:
  1. 确认网络可访问 https://npmmirror.com/mirrors/electron/ (或 GitHub Releases)；
  2. 手动重装: pnpm rebuild electron
     （如需镜像: ELECTRON_MIRROR=${MIRROR} ELECTRON_CUSTOM_DIR='v{{ version }}' pnpm rebuild electron）
  3. 或删除重来: rm -rf node_modules/electron && pnpm install
`)
process.exit(1)
