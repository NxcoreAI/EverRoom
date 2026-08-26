const SENSITIVE_KEY = /(?:^|[_-])(?:api[-_]?key|authorization|cookie|credential|password|secret|signature|token)(?:$|[_-])/i;
const REDACTED = "[REDACTED]";

const secrets = new Set<string>();
const deltaTails = new Map<string, string>();

export function registerSecret(value: string | undefined): void {
  if (!value) return;
  secrets.add(value);
}

export function registerSecrets(value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key)) registerSecret(value);
    return;
  }
  if (Array.isArray(value)) return value.forEach((child) => registerSecrets(child, key));
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) registerSecrets(child, childKey);
  }
}

export function redactText(input: string): string {
  let output = input
    .replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:api_?key|key|token|signature|credential|secret|password)=)[^&#\s]+/gi, `$1${REDACTED}`);
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(secret, REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) output = output.replaceAll(encoded, REDACTED);
    const formEncoded = encoded.replaceAll("%20", "+");
    if (formEncoded !== encoded) output = output.replaceAll(formEncoded, REDACTED);
  }
  return output;
}

export function redactSecrets<T>(value: T, key = "", seen = new WeakMap<object, unknown>()): T {
  if (value === "********" || value === "[REDACTED]") return value;
  if (SENSITIVE_KEY.test(key) && value !== undefined && value !== null && value !== ""
    && (typeof value !== "object" || value instanceof Error)) return REDACTED as T;
  if (typeof value === "string") return redactText(value) as T;
  if (value instanceof Error) {
    const error = new Error(redactText(value.message));
    error.name = value.name;
    if (value.stack) error.stack = redactText(value.stack);
    return error as T;
  }
  if (!value || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached as T;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    value.forEach((child) => output.push(redactSecrets(child, "", seen)));
    return output as T;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [childKey, child] of Object.entries(value)) output[childKey] = redactSecrets(child, childKey, seen);
  return output as T;
}

export function redactDelta(scope: string, delta: string): string {
  const previous = deltaTails.get(scope) ?? "";
  const combined = redactText(previous + delta);
  const longest = Math.max(0, ...[...secrets].flatMap((secret) => [
    secret.length - 1,
    encodeURIComponent(secret).length - 1,
  ]));
  const emitLength = Math.max(0, combined.length - longest);
  deltaTails.set(scope, combined.slice(emitLength));
  return combined.slice(0, emitLength);
}

export function clearRedactionDelta(scope: string): void {
  deltaTails.delete(scope);
}

export function resetSecretRedactionForTests(): void {
  secrets.clear();
  deltaTails.clear();
}
