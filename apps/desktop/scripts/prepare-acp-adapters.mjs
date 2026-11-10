import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

// 预装 ACP 适配器（claude/codex 本机 Agent 的协议转接层）：构建期用 npm 锁精确
// 版本装进 build/acp-adapters/<provider>/node_modules/<pkg>，随 extraResources
// 内置进应用（产品运行时不做任何网络安装）。适配器升级 = 改下面的版本号并
// 重新发版；探测/启动链把它作为用户 PATH 与私有目录之后的兜底。

const ADAPTERS = [
  { provider: 'claude', pkg: '@zed-industries/claude-agent-acp', version: '0.23.1' },
  { provider: 'codex', pkg: '@agentclientprotocol/codex-acp', version: '2.1.1' },
]

const buildRoot = join(dirname(import.meta.dirname), 'build', 'acp-adapters')

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function npmInstall(prefix, spec) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', spec], {
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install ${spec} failed (code=${String(code)})`))
    })
  })
}

for (const { provider, pkg, version } of ADAPTERS) {
  const prefix = join(buildRoot, provider)
  const markerPath = join(prefix, '.everroom-bundled.json')
  const marker = JSON.stringify({ pkg, version })
  const installedManifest = join(prefix, 'node_modules', pkg, 'package.json')
  if ((await exists(installedManifest)) && await readFile(markerPath, 'utf8').catch(() => '') === marker) {
    console.log(`ACP adapter ready: ${pkg}@${version}`)
    continue
  }
  await mkdir(prefix, { recursive: true })
  await npmInstall(prefix, `${pkg}@${version}`)
  if (!(await exists(installedManifest))) {
    throw new Error(`ACP adapter ${pkg}@${version} did not land in ${prefix}`)
  }
  await writeFile(markerPath, marker, 'utf8')
  console.log(`ACP adapter installed: ${pkg}@${version} -> ${prefix}`)
}
