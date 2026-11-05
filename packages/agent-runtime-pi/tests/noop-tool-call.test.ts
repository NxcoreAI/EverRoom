import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_NOOP_TOOL_CALLS, isNoOpBashCommand, isNoOpToolCall } from '../src/noop-tool-call.js'

describe('空转工具调用识别', () => {
  it('把纯打点的 bash 命令认成空转', () => {
    expect(isNoOpBashCommand('echo step264b')).toBe(true)
    expect(isNoOpBashCommand('  echo "placeholder to batch reads"  ')).toBe(true)
    expect(isNoOpBashCommand('printf "%s" ok')).toBe(true)
    expect(isNoOpBashCommand('true')).toBe(true)
    expect(isNoOpBashCommand(':')).toBe(true)
  })

  it('有副作用风险的命令不算空转', () => {
    expect(isNoOpBashCommand('echo hi > out.txt')).toBe(false)
    expect(isNoOpBashCommand('echo a && rm -rf x')).toBe(false)
    expect(isNoOpBashCommand('echo $(whoami)')).toBe(false)
    expect(isNoOpBashCommand('ls -la')).toBe(false)
    expect(isNoOpBashCommand('cat /dev/null')).toBe(false)
    expect(isNoOpBashCommand('')).toBe(false)
    expect(isNoOpBashCommand(undefined)).toBe(false)
  })

  it('read /dev/null 与 bash 打点都算，真实工具调用不算', () => {
    expect(isNoOpToolCall('bash', { command: 'echo step50' })).toBe(true)
    expect(isNoOpToolCall('read', { path: '/dev/null', limit: 1 })).toBe(true)
    expect(isNoOpToolCall('read', { path: '/tmp/a.txt' })).toBe(false)
    expect(isNoOpToolCall('sheets_agent_read', { fileId: 'x' })).toBe(false)
    expect(isNoOpToolCall('bash', { command: 'python build.py' })).toBe(false)
    expect(isNoOpToolCall('bash', undefined)).toBe(false)
  })

  it('阈值是个正数', () => {
    expect(DEFAULT_MAX_NOOP_TOOL_CALLS).toBeGreaterThan(1)
  })
})
