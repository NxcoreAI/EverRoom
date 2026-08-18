import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { captureSentryLog } from '../monitoring/sentry'

type LogLevel = 'info' | 'warn' | 'error'
type ConsoleLevel = LogLevel | 'log'

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
}
const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[90m',
  magenta: '\u001b[35m',
  infoBadge: '\u001b[30;42m',
  warnBadge: '\u001b[30;43m',
  errorBadge: '\u001b[97;41m',
}
const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|signature|token|transcript|detailmarkdown/i
const MAX_VALUE_LENGTH = 500

const LOG_RETENTION_DAYS = 30
const LOG_FILE_PATTERN = /^desktop-(\d{4}-\d{2}-\d{2})\.log$/

let logsDirectory: string | null = null
let writeQueue = Promise.resolve()
let consoleInstalled = false

function localDate(value: Date): string {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-')
}

function timestamp(value: Date): string {
  const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const time = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}.${String(value.getMilliseconds()).padStart(3, '0')}`
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`
  return `${date} ${time} ${offset}`
}

function formatValue(value: unknown, key: string): string {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (value === null || value === undefined) return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') {
    const cleaned = value
      .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:token|signature|credential|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/\s+/g, ' ')
      .slice(0, MAX_VALUE_LENGTH)
    return /[\s|=]/.test(cleaned) ? JSON.stringify(cleaned) : cleaned
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') return `{${Object.keys(value).slice(0, 8).join(',')}}`
  return String(value)
}

function formatConsoleLine(now: Date, module: string, level: LogLevel, event: Record<string, unknown>): string {
  const eventName = typeof event.event === 'string' ? event.event : 'event'
  const fields = Object.entries(event)
    .filter(([key, value]) => key !== 'event' && value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value, key)}`)
  const suffix = fields.length > 0 ? ` | ${fields.join(' ')}` : ''
  const levelColor = level === 'error' ? ANSI.errorBadge : level === 'warn' ? ANSI.warnBadge : ANSI.infoBadge
  const plainTimestamp = timestamp(now)
  const plainLevel = LEVEL_LABEL[level].padEnd(5)
  const scope = `[desktop/${module}]`
  return `${ANSI.dim}${plainTimestamp}${ANSI.reset} ${levelColor} ${plainLevel} ${ANSI.reset} ${ANSI.magenta}${scope}${ANSI.reset} ${eventName}${suffix}`
}

function appendLogFile(now: Date, module: string, level: LogLevel, event: Record<string, unknown>): void {
  const directory = logsDirectory
  if (!directory) return
  const entry = {
    time: now.toISOString(),
    level,
    source: 'desktop',
    module,
    ...event,
  }
  enqueue(() => appendFile(
    join(directory, `desktop-${localDate(now)}.log`),
    `${JSON.stringify(entry)}\n`,
    'utf8',
  ))
}

function writeToOriginalConsole(level: LogLevel, line: string): void {
  const stream = level === 'info' ? process.stdout : process.stderr
  stream.write(`${line}\n`)
}

function installGlobalConsole(): void {
  if (consoleInstalled) return
  consoleInstalled = true
  const writeGlobal = (level: ConsoleLevel, args: unknown[]) => {
    const actualLevel: LogLevel = level === 'log' ? 'info' : level
    const [first, ...rest] = args
    const event = typeof first === 'string' ? first : 'console event'
    const details = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest
    const now = new Date()
    const payload = details === undefined ? { event } : { event, details }
    writeToOriginalConsole(actualLevel, formatConsoleLine(now, 'console', actualLevel, payload))
    appendLogFile(now, 'console', actualLevel, payload)
  }
  console.log = (...args) => writeGlobal('log', args)
  console.info = (...args) => writeGlobal('info', args)
  console.warn = (...args) => writeGlobal('warn', args)
  console.error = (...args) => writeGlobal('error', args)
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
    writeToOriginalConsole('error', `${timestamp(new Date())} ERROR [desktop/logger] write failed | error=${formatValue(error, 'error')}`)
  })
}

export function configureDesktopLogger(dataDirectory: string): void {
  logsDirectory = join(dataDirectory, 'logs')
  const directory = logsDirectory
  installGlobalConsole()
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
  writeToOriginalConsole(level, formatConsoleLine(now, module, level, event))
  captureSentryLog(module, level, event)
  appendLogFile(now, module, level, event)
}

export function flushDesktopLogs(): Promise<void> {
  return writeQueue
}
