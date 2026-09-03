import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentAuthController } from '../src/main/agent-auth/controller'
import { LarkAuthRunner } from '../src/main/agent-auth/lark-auth-runner'
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('agent auth controller', () => {
  const controllers: AgentAuthController[] = []

  afterEach(() => {
    for (const controller of controllers) controller.shutdown()
    controllers.length = 0
  })

  function createController(fakePath: string): AgentAuthController {
    const controller = new AgentAuthController(new LarkAuthRunner(fakePath))
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

  it('notion challenge guides to connector console without local CLI flow', async () => {
    const controller = createController('/nonexistent/lark-cli-xyz')
    const challenge = await controller.start({ provider: 'notion', phase: 'user_auth' })
    expect(challenge.status).toBe('pending')
    expect(challenge.steps[0]!.action).toBe('open_connector_console')
  })
})
