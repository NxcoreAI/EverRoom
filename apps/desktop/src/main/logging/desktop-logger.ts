import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { captureSentryLog } from '../monitoring/sentry'

type LogLevel = 'info' | 'warn' | 'error'

const LOG_RETENTION_DAYS = 30
const LOG_FILE_PATTERN = /^desktop-(\d{4}-\d{2}-\d{2})\.log$/

let logsDirectory: string | null = null
let writeQueue = Promise.resolve()

function localDate(value: Date): string {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-')
}

async function removeExpiredLogs(directory: string): Promise<void> {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS)
  const names = await readdir(directory)
  await Promise.all(names.map(async (name) => {
    const match = LOG_FILE_PATTERN.exec(name)
    if (!match) return
    const createdAt = new Date(`${match[1]}T00:00:00`)
    if (createdAt < cutoff) await unlink(join(directory, name))
  }))
}

function enqueue(operation: () => Promise<void>): void {
  writeQueue = writeQueue.then(operation).catch((error) => {
    process.stderr.write(`[desktop][logger] ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

export function configureDesktopLogger(dataDirectory: string): void {
  logsDirectory = join(dataDirectory, 'logs')
  const directory = logsDirectory
  enqueue(async () => {
    await mkdir(directory, { recursive: true })
    await removeExpiredLogs(directory)
  })
}

export function logDesktop(
  module: string,
  level: LogLevel,
  event: Record<string, unknown>,
): void {
  const now = new Date()
  const entry = {
    time: now.toISOString(),
    level,
    source: 'desktop',
    module,
    ...event,
  }
  console[level](`[desktop][${module}] ${JSON.stringify(event)}`)
  captureSentryLog(module, level, event)
  const directory = logsDirectory
  if (!directory) return
  enqueue(() => appendFile(
    join(directory, `desktop-${localDate(now)}.log`),
    `${JSON.stringify(entry)}\n`,
    'utf8',
  ))
}

export function flushDesktopLogs(): Promise<void> {
  return writeQueue
}
