import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const sentryMocks = vi.hoisted(() => ({ captureSentryLog: vi.fn() }))

vi.mock('../src/main/monitoring/sentry', () => sentryMocks)

import {
  configureDesktopLogger,
  flushDesktopLogs,
  logDesktop,
  logDocumentCursorCompletion,
} from '../src/main/logging/desktop-logger'

const originalConsole = {
  error: console.error,
  info: console.info,
  log: console.log,
  warn: console.warn,
}
let temporaryDirectory = ''

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'nxcore-desktop-logger-'))
  configureDesktopLogger(temporaryDirectory)
  await flushDesktopLogs()
})

afterAll(async () => {
  await flushDesktopLogs()
  console.error = originalConsole.error
  console.info = originalConsole.info
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('desktop logger isolation', () => {
  it('keeps completion content in its local file and never forwards it remotely', async () => {
    const documentBody = 'PRIVATE_DOCUMENT_BODY_7f3e'
    const suggestion = 'PRIVATE_COMPLETION_SUGGESTION_91ac'

    logDocumentCursorCompletion('info', {
      event: 'suggestion.shown',
      documentBody,
      suggestion,
    })
    logDesktop('desktop-logger-test', 'info', { event: 'ordinary.event', marker: 'ordinary' })
    await flushDesktopLogs()

    const logDirectory = join(temporaryDirectory, 'logs')
    const names = await readdir(logDirectory)
    const completionName = names.find((name) => name.startsWith('cursor-completion-'))
    const desktopName = names.find((name) => name.startsWith('desktop-'))
    expect(completionName).toBeDefined()
    expect(desktopName).toBeDefined()

    const completionLog = await readFile(join(logDirectory, completionName!), 'utf8')
    const desktopLog = await readFile(join(logDirectory, desktopName!), 'utf8')
    expect(completionLog).toContain(documentBody)
    expect(completionLog).toContain(suggestion)
    expect(desktopLog).not.toContain(documentBody)
    expect(desktopLog).not.toContain(suggestion)

    expect(sentryMocks.captureSentryLog).toHaveBeenCalledOnce()
    expect(sentryMocks.captureSentryLog).toHaveBeenCalledWith(
      'desktop-logger-test',
      'info',
      { event: 'ordinary.event', marker: 'ordinary' },
    )
    expect(JSON.stringify(sentryMocks.captureSentryLog.mock.calls)).not.toContain(documentBody)
    expect(JSON.stringify(sentryMocks.captureSentryLog.mock.calls)).not.toContain(suggestion)
  })
})
