import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentAuthController } from '../src/main/agent-auth/controller'
import { LarkAuthRunner } from '../src/main/agent-auth/lark-auth-runner'
import { NtnAuthRunner } from '../src/main/agent-auth/ntn-auth-runner'
import type { AgentAuthEventFrame } from '../src/shared/agent-auth'

/** 假 lark-cli：auth status 按 APP_STATE 环境变量返回；login --no-wait 输出设备码契约。 */
async function writeFakeLarkCli(): Promise<{ path: string; stateFile: () => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nxcore-agent-auth-'))
  const path = join(dir, 'lark-cli')
  const script = `#!/bin/bash
STATE_FILE="$(dirname "$0")/state"
case " $* " in
  *" --version "*) echo "lark-cli version test"; exit 0;;
esac
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$(cat "$STATE_FILE")" = "app-ready" ]; then
    echo '{"ok":true,"appId":"cli_x","identities":{"user":{"available":true,"tokenStatus":"valid","userName":"测试用户"}}}'
  else
    echo '{"ok":true,"appId":"","identities":{"user":{"available":false}}}'
  fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ] && [[ " $* " == *" --no-wait "* ]]; then
  # 与真实 lark-cli 一致：不带 scope/domain 时报 validation 错（防调用点回归）
  if [[ " $* " != *" --domain "* && " $* " != *" --scope "* && " $* " != *" --recommend "* ]]; then
    echo '{"ok":false,"error":{"type":"validation","subtype":"invalid_argument","message":"please specify the scopes to authorize","param":"--scope"}}' >&2
    exit 1
  fi
  echo '{"ok":true,"data":{"verificationUrl":"https://feishu.cn/verify?code=abc","deviceCode":"devcode123"}}'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ] && [[ " $* " == *" --device-code "* ]]; then
  echo '{"ok":true,"data":{"authorized":true}}'
  echo app-ready > "$STATE_FILE"
  exit 0
fi
if [ "$1" = "config" ]; then
  echo "打开 https://feishu.cn/app-setup 完成应用创建"
  sleep 0.2
  echo app-ready > "$STATE_FILE"
  exit 0
fi
echo '{"ok":false,"error":{"type":"cli","message":"unsupported"}}' >&2
exit 3
`
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  const stateFile = join(dir, 'state')
  await writeFile(stateFile, 'no-app', 'utf8')
  return { path, stateFile: async () => stateFile }
}

/** 假 ntn：login --no-browser 打 URL+校验码退出；login poll 立即成功；whoami 已登录。 */
async function writeFakeNtnCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nxcore-ntn-'))
  const path = join(dir, 'ntn')
  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "ntn 0.23.1-test"; exit 0; fi
if [ "$1" = "whoami" ]; then
  echo '{"id":"user-1","name":"Notion 测试用户","user":{"name":"Notion 测试用户"}}'
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "--no-browser" ]; then
  echo 'Open this URL in your browser to log in:'
  echo ''
  echo '  https://app.notion.com/workers/cli-login?verificationCode=ABC-123'
  echo ''
  echo 'Confirm that this verification code matches what you see in the browser:'
  echo ''
  echo '  ABC-123'
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "poll" ]; then
  exit 0
fi
echo 'error: unsupported' >&2
exit 3
`
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('agent auth controller', () => {
  const controllers: AgentAuthController[] = []

  afterEach(() => {
    for (const controller of controllers) controller.shutdown()
    controllers.length = 0
  })

  function createController(fakePath: string, ntnPath?: string, persist?: { save(state: string): void; load(): string | null; clear(): void }): AgentAuthController {
    const controller = new AgentAuthController(
      new LarkAuthRunner(fakePath),
      persist ? { persist } : {},
      ntnPath ? new NtnAuthRunner(ntnPath) : null,
    )
    controllers.push(controller)
    return controller
  }

  it('reports missing cli as environment not ready', async () => {
    const controller = createController('/nonexistent/lark-cli-xyz')
    const status = await controller.status()
    expect(status.feishu.cliState).toBe('missing')
    expect(status.activeChallenge).toBeNull()
  })

  it('app setup challenge surfaces URL and then completes user auth, card stays authorized', async () => {
    const { path } = await writeFakeLarkCli()
    const controller = createController(path)
    const events: AgentAuthEventFrame[] = []
    controller.onEvent((frame) => events.push(frame))

    const challenge = await controller.start({ provider: 'feishu', phase: 'app_setup' })
    expect(challenge.status).toBe('pending')
    // config init → resume → user auth(--no-wait 带出 URL)→ device poll → authorized
    let urlSeen = false
    let finalChallenge: (typeof challenge) | null = null
    for (let attempt = 0; attempt < 60 && !finalChallenge; attempt += 1) {
      await delay(100)
      const updates = events.filter((frame) => frame.type === 'challenge.updated' && frame.challenge.phase === 'user_auth')
      if (updates.some((frame) => frame.type === 'challenge.updated' && frame.challenge.verificationUrl)) {
        urlSeen = true
      }
      const last = updates.at(-1)
      if (last && last.type === 'challenge.updated' && last.challenge.status === 'authorized') {
        finalChallenge = last.challenge
      }
    }
    expect(urlSeen).toBe(true)
    expect(finalChallenge?.status).toBe('authorized')
    // 授权完成后卡片保留在控制器状态中（不自动移除）
    const status = await controller.status()
    expect(status.activeChallenge?.status).toBe('authorized')
  })

  it('device polling completes and marks challenge authorized', async () => {
    const { path } = await writeFakeLarkCli()
    const controller = createController(path)
    await controller.start({ provider: 'feishu', phase: 'app_setup' })
    await delay(900)
    // config init → user auth → device poll（fake 立即成功）→ resume 判定 authorized
    const status = await controller.status()
    expect(status.feishu.appConfigured).toBe(true)
    expect(status.feishu.userAuthorized).toBe(true)
  })

  it('cancel stops the pending challenge', async () => {
    const { path } = await writeFakeLarkCli()
    const controller = createController(path)
    const challenge = await controller.start({ provider: 'feishu', phase: 'user_auth' })
    const after = controller.cancel(challenge.id)
    expect(after).toBeNull()
    const status = await controller.status()
    expect(status.activeChallenge).toBeNull()
  })

  it('notion login challenge surfaces url + verification code and completes', async () => {
    const ntnPath = await writeFakeNtnCli()
    const controller = createController('/nonexistent/lark-cli-xyz', ntnPath)
    const events: AgentAuthEventFrame[] = []
    controller.onEvent((frame) => events.push(frame))

    const challenge = await controller.start({ provider: 'notion', phase: 'user_auth' })
    expect(challenge.status).toBe('pending')

    // login --no-browser → 卡片带出 URL 与校验码 → poll 立即成功 → resume 判定已授权
    let urlSeen = false
    let codeSeen = false
    let authorized: (typeof challenge) | null = null
    for (let attempt = 0; attempt < 50 && !authorized; attempt += 1) {
      await delay(100)
      for (const frame of events) {
        if (frame.type !== 'challenge.updated') continue
        if (frame.challenge.verificationUrl === 'https://app.notion.com/workers/cli-login?verificationCode=ABC-123') urlSeen = true
        if (frame.challenge.steps.some((step) => step.description?.includes('ABC-123'))) codeSeen = true
        if (frame.challenge.status === 'authorized') authorized = frame.challenge
      }
    }
    expect(urlSeen).toBe(true)
    expect(codeSeen).toBe(true)
    expect(authorized?.status).toBe('authorized')
    expect(authorized?.message).toContain('Notion')
    const status = await controller.status()
    expect(status.activeChallenge?.status).toBe('authorized')
  })

  it('restores persisted challenge as expired after restart', async () => {
    const { path } = await writeFakeLarkCli()
    let saved: string | null = null
    const persist = {
      save: (state: string): void => { saved = state },
      load: (): string | null => saved,
      clear: (): void => { saved = null },
    }
    const first = createController(path, undefined, persist)
    const challenge = await first.start({ provider: 'feishu', phase: 'user_auth' })
    expect(challenge.status).toBe('pending')
    expect(saved).toBeTruthy()
    first.shutdown()

    // “重启”：新控制器从持久化恢复 → 过期卡片，可重新发起
    const second = new AgentAuthController(new LarkAuthRunner(path), { persist })
    controllers.push(second)
    const status = await second.status()
    expect(status.activeChallenge?.status).toBe('expired')
    expect(status.activeChallenge?.verificationUrl).toBeNull()
    const restarted = await second.start({ provider: 'feishu', phase: 'user_auth' })
    expect(restarted.status).toBe('pending')
  })

  it('does not restore an authorized challenge after restart', async () => {
    const { path } = await writeFakeLarkCli()
    let saved: string | null = null
    const persist = {
      save: (state: string): void => { saved = state },
      load: (): string | null => saved,
      clear: (): void => { saved = null },
    }
    const first = createController(path, undefined, persist)
    await first.start({ provider: 'feishu', phase: 'user_auth' })
    // 等异步 login 流程落定（fake 立即完成/失败并写持久化）。
    await delay(500)
    // 模拟授权成功：直接把持久化内容改成 authorized（持久化层本不该再写，
    // 这里覆盖历史遗留文件的场景）。
    saved = JSON.stringify({ ...JSON.parse(saved ?? '{}'), status: 'authorized' })
    first.shutdown()

    const second = new AgentAuthController(new LarkAuthRunner(path), { persist })
    controllers.push(second)
    const status = await second.status()
    expect(status.activeChallenge).toBeNull()
    expect(saved).toBeNull()
  })

  it('dismisses a restored pending challenge when keychain is already authorized', async () => {
    const { path } = await writeFakeLarkCli()
    // 让 fake lark 处于已登录状态（app-ready）
    await import('node:fs/promises').then((fs) => fs.writeFile(join(path, '..', 'state'), 'app-ready', 'utf8'))
    let saved: string | null = null
    const persist = {
      save: (state: string): void => { saved = state },
      load: (): string | null => saved,
      clear: (): void => { saved = null },
    }
    // 未完成的 pending 记录（模拟重启时落盘的是进行中状态）
    saved = JSON.stringify({
      id: 'challenge-x', provider: 'feishu', phase: 'user_auth', status: 'pending',
      reason: 'not_connected', title: '授权飞书账号', steps: [], exportRunId: null,
      startedAt: new Date().toISOString(),
    })
    const controller = new AgentAuthController(new LarkAuthRunner(path), { persist })
    controllers.push(controller)
    // 恢复后异步核对钥匙串 → 已授权则静默撤卡
    await delay(600)
    const status = await controller.status()
    expect(status.activeChallenge).toBeNull()
    expect(saved).toBeNull()
  })

  it('notion without ntn runner rejects with platform message', async () => {
    const controller = createController('/nonexistent/lark-cli-xyz')
    const error = await controller.start({ provider: 'notion', phase: 'user_auth' })
      .then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('macOS')
  })
})
