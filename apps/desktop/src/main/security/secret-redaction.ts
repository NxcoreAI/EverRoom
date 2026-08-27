const SENSITIVE_KEY = /(?:^|[_-])(?:api[-_]?key|authorization|cookie|credential|password|secret|signature|token)(?:$|[_-])/i
const secrets = new Set<string>()

export function registerDesktopSecret(value: string | undefined): void {
  if (value) secrets.add(value)
}

export function redactDesktopText(input: string): string {
  let output = input
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api_?key|key|token|signature|credential|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(secret, '[REDACTED]')
    output = output.replaceAll(encodeURIComponent(secret), '[REDACTED]')
  }
  return output
}

export function redactDesktopSecrets<T>(value: T, key = '', seen = new WeakMap<object, unknown>()): T {
  if (SENSITIVE_KEY.test(key) && value !== undefined && value !== null && value !== ''
    && (typeof value !== 'object' || value instanceof Error)) return '[REDACTED]' as T
  if (typeof value === 'string') return redactDesktopText(value) as T
  if (value instanceof Error) {
    const error = new Error(redactDesktopText(value.message))
    error.name = value.name
    error.stack = value.stack ? redactDesktopText(value.stack) : undefined
    return error as T
  }
  if (!value || typeof value !== 'object') return value
  const cached = seen.get(value)
  if (cached) return cached as T
  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    value.forEach((child) => output.push(redactDesktopSecrets(child, '', seen)))
    return output as T
  }
  const output: Record<string, unknown> = {}
  seen.set(value, output)
  for (const [childKey, child] of Object.entries(value)) output[childKey] = redactDesktopSecrets(child, childKey, seen)
  return output as T
}
