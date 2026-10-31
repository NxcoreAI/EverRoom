import { access, chmod, mkdir, mkdtemp, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareLarkCliVersions,
  createLarkCliRuntime,
  ensureLarkCliMasterKey,
  larkCliMasterKeyPath,
  larkCliSpawnEnvironment,
  MIN_SUPPORTED_LARK_CLI_VERSION,
  parseLarkCliVersion,
} from '../src/main/runtime/lark-cli-runtime'

/** 写一个只实现 `--version` 的假 lark-cli（与真实 CLI 输出格式一致）。 */
async function writeFakeLarkCli(directory: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const executable = join(directory, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  await writeFile(executable, `#!/bin/bash\necho "lark-cli version ${version}"\n`, 'utf8')
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  return executable
}

/** 最小基础环境：不继承测试进程的 PATH/HOME，避免探测到机器上真实安装的 lark-cli。 */
function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '', ...overrides }
}

async function makeWorkspace(): Promise<{ root: string; resourcesPath: string; appPath: string; homeDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'everroom-lark-runtime-'))
  const resourcesPath = join(root, 'resources')
  const appPath = join(root, 'app')
  const homeDirectory = join(root, 'data', 'lark-cli', 'home')
  await mkdir(resourcesPath, { recursive: true })
  await mkdir(appPath, { recursive: true })
  return { root, resourcesPath, appPath, homeDirectory }
}

describe('lark-cli runtime resolution', () => {
  it('prefers the bundled binary over a system installation', async () => {
    const workspace = await makeWorkspace()
    const systemBinary = await writeFakeLarkCli(join(workspace.root, 'system-bin'), '9.9.9')
    const bundled = await writeFakeLarkCli(
      join(workspace.resourcesPath, 'lark-cli', `${process.platform}-${process.arch}`),
      '1.0.93',
    )
    const runtime = createLarkCliRuntime({
      ...workspace,
      baseEnvironment: baseEnvironment({
        // 系统路径里也放一个更新的版本，验证「内置优先」而不是「版本优先」。
        PATH: join(workspace.root, 'system-bin'),
      }),
    })
    expect(systemBinary).not.toBe(bundled)
    expect(runtime.source).toBe('bundled')
    expect(runtime.executable).toBe(bundled)
    expect(runtime.version).toBe('1.0.93')
    expect(runtime.detail).toContain('随应用内置')
  })

  it('honors NXCORE_LARK_CLI_PATH as an explicit override', async () => {
    const workspace = await makeWorkspace()
    const explicit = await writeFakeLarkCli(join(workspace.root, 'custom'), '1.0.94')
    const runtime = createLarkCliRuntime({
      ...workspace,
      baseEnvironment: baseEnvironment({ NXCORE_LARK_CLI_PATH: explicit }),
    })
    expect(runtime.source).toBe('env')
    expect(runtime.executable).toBe(explicit)
    expect(runtime.version).toBe('1.0.94')
  })

  it('falls back to a system installation when the bundled binary is missing', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace.root, 'user-home')
    await writeFakeLarkCli(join(home, '.local', 'bin'), '1.0.95')
    const runtime = createLarkCliRuntime({
      ...workspace,
      baseEnvironment: baseEnvironment({ HOME: home }),
    })
    expect(runtime.source).toBe('system')
    expect(runtime.executable).toBe(join(home, '.local', 'bin', 'lark-cli'))
    expect(runtime.version).toBe('1.0.95')
    expect(runtime.detail).toContain('系统安装')
  })

  it('rejects a system installation older than the supported minimum', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace.root, 'user-home')
    await writeFakeLarkCli(join(home, '.local', 'bin'), '1.0.80')
    const runtime = createLarkCliRuntime({
      ...workspace,
      baseEnvironment: baseEnvironment({ HOME: home }),
    })
    expect(runtime.source).toBe('missing')
    expect(runtime.version).toBeNull()
    expect(compareLarkCliVersions('1.0.80', MIN_SUPPORTED_LARK_CLI_VERSION)).toBeLessThan(0)
  })

  it('reports missing when neither bundled nor system binary is available', async () => {
    const workspace = await makeWorkspace()
    const runtime = createLarkCliRuntime({
      ...workspace,
      baseEnvironment: baseEnvironment({ HOME: join(workspace.root, 'user-home') }),
    })
    expect(runtime.source).toBe('missing')
    expect(runtime.executable).toBe('lark-cli')
    expect(runtime.detail).toContain('未找到')
  })

  it('creates the application-private home directory', async () => {
    const workspace = await makeWorkspace()
    createLarkCliRuntime({ ...workspace, baseEnvironment: baseEnvironment() })
    await expect(access(workspace.homeDirectory)).resolves.toBeUndefined()
  })

  it('seeds the master key file before any lark-cli invocation (no system keychain)', async () => {
    const workspace = await makeWorkspace()
    createLarkCliRuntime({ ...workspace, baseEnvironment: baseEnvironment() })
    if (process.platform !== 'darwin') return
    const keyPath = larkCliMasterKeyPath(workspace.homeDirectory)!
    const bytes = await readFile(keyPath)
    expect(bytes.length).toBe(32)
  })

  it('injects binary path and private home into the gateway environment', async () => {
    const workspace = await makeWorkspace()
    const bundled = await writeFakeLarkCli(
      join(workspace.resourcesPath, 'lark-cli', `${process.platform}-${process.arch}`),
      '1.0.93',
    )
    const runtime = createLarkCliRuntime({ ...workspace, baseEnvironment: baseEnvironment() })
    expect(runtime.gatewayEnvironment()).toEqual({
      NXCORE_LARK_CLI_PATH: bundled,
      NXCORE_LARK_CLI_HOME: workspace.homeDirectory,
    })
  })
})

describe('lark-cli private master key (no system keychain)', () => {
  it('creates a 32-byte 0600 key file and never overwrites it', async () => {
    const workspace = await makeWorkspace()
    expect(ensureLarkCliMasterKey(workspace.homeDirectory, 'darwin')).toBe('created')
    const keyPath = larkCliMasterKeyPath(workspace.homeDirectory, 'darwin')!
    const first = await readFile(keyPath)
    expect(first.length).toBe(32)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    // 第二次调用（模拟再次启动）不覆盖，避免已有凭据无法解密。
    expect(ensureLarkCliMasterKey(workspace.homeDirectory, 'darwin')).toBe('existing')
    expect(await readFile(keyPath)).toEqual(first)
  })

  it('is a no-op outside macOS', async () => {
    const workspace = await makeWorkspace()
    expect(larkCliMasterKeyPath(workspace.homeDirectory, 'win32')).toBeNull()
    expect(ensureLarkCliMasterKey(workspace.homeDirectory, 'win32')).toBe('unsupported')
  })
})

describe('lark-cli environment isolation', () => {
  it('pins HOME to the private directory and keeps only allowlisted variables', () => {
    const environment = larkCliSpawnEnvironment({
      HOME: '/Users/someone',
      USER: 'someone',
      LOGNAME: 'someone',
      LANG: 'zh_CN.UTF-8',
      TZ: 'Asia/Shanghai',
      PATH: '/usr/local/bin:/usr/bin',
      HTTPS_PROXY: 'http://proxy.corp:8080',
      NO_PROXY: 'localhost',
      SSL_CERT_FILE: '/etc/ssl/corp.pem',
      // 以下都不该进入 lark-cli 子进程：外部 Agent 上下文 / Node/Electron 注入 / 用户
      // 自带的 lark-cli 配置。
      LARKSUITE_CLI_PROFILE: 'personal',
      LARK_CLI_NO_PROXY_WARN: '1',
      FEISHU_APP_ID: 'cli_personal',
      OPENCLAW_HOME: '/Users/someone/.openclaw',
      HERMES_HOME: '/Users/someone/.hermes',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_registry: 'https://registry.example',
      XDG_CONFIG_HOME: '/Users/someone/.config',
      USERPROFILE: 'C:\\Users\\someone',
      APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
    }, '/private/home')

    expect(environment.HOME).toBe('/private/home')
    expect(environment.USERPROFILE).toBe('/private/home')
    expect(environment.APPDATA).toBe('/private/home/AppData/Roaming')
    expect(environment.LOCALAPPDATA).toBe('/private/home/AppData/Local')
    expect(environment.NO_COLOR).toBe('1')
    expect(environment.USER).toBe('someone')
    expect(environment.LANG).toBe('zh_CN.UTF-8')
    expect(environment.TZ).toBe('Asia/Shanghai')
    expect(environment.HTTPS_PROXY).toBe('http://proxy.corp:8080')
    expect(environment.NO_PROXY).toBe('localhost')
    expect(environment.SSL_CERT_FILE).toBe('/etc/ssl/corp.pem')
    expect(environment.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(environment.LARKSUITE_CLI_PROFILE).toBeUndefined()
    expect(environment.LARK_CLI_NO_PROXY_WARN).toBeUndefined()
    expect(environment.FEISHU_APP_ID).toBeUndefined()
    expect(environment.OPENCLAW_HOME).toBeUndefined()
    expect(environment.HERMES_HOME).toBeUndefined()
    expect(environment.NODE_OPTIONS).toBeUndefined()
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(environment.npm_config_registry).toBeUndefined()
    expect(environment.XDG_CONFIG_HOME).toBeUndefined()
  })

  it('keeps LARK_CLI_NO_PROXY only when explicitly enabled', () => {
    expect(larkCliSpawnEnvironment({ LARK_CLI_NO_PROXY: '1' }, '/home').LARK_CLI_NO_PROXY).toBe('1')
    expect(larkCliSpawnEnvironment({ LARK_CLI_NO_PROXY: '0' }, '/home').LARK_CLI_NO_PROXY).toBeUndefined()
  })

  it('parses and compares semantic versions', () => {
    expect(parseLarkCliVersion('lark-cli version 1.0.93')).toBe('1.0.93')
    expect(parseLarkCliVersion('1.2.3-beta')).toBe('1.2.3')
    expect(parseLarkCliVersion('no version here')).toBeNull()
    expect(compareLarkCliVersions('1.0.93', '1.0.90')).toBe(1)
    expect(compareLarkCliVersions('1.0.90', '1.0.90')).toBe(0)
    expect(compareLarkCliVersions('1.0.89', '1.0.90')).toBe(-1)
    expect(compareLarkCliVersions('1.10.0', '1.9.9')).toBe(1)
  })
})