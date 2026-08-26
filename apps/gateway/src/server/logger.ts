import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import pinoRoll from "pino-roll";
import type { LogLevel } from "../config.js";
import { redactSecrets, redactText } from "../security/secret-redaction.js";

const LOG_RETENTION_DAYS = 30;

const REDACTED_PATHS = [
  "req.headers.authorization",
  "headers.authorization",
  "authToken",
  "token",
];

export interface GatewayLogger {
  logger: Logger;
  logsDirectory: string;
  close(): Promise<void>;
}

function closeStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off("close", finish);
      stream.off("finish", finish);
      stream.off("error", fail);
    };
    stream.once("close", finish);
    stream.once("finish", finish);
    stream.once("error", fail);
    stream.end();
  });
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[90m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};
const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|signature|token|transcript|detailmarkdown/i;

function levelName(level: unknown): { label: string; color: string } {
  const numeric = typeof level === "number" ? level : 30;
  if (numeric >= 50) return { label: "ERROR", color: ANSI.red };
  if (numeric >= 40) return { label: "WARN", color: ANSI.yellow };
  if (numeric <= 20) return { label: "DEBUG", color: ANSI.cyan };
  return { label: "INFO", color: ANSI.green };
}

function localTimestamp(value: Date): string {
  const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const time = `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}.${String(value.getMilliseconds()).padStart(3, "0")}`;
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${date} ${time} ${offset}`;
}

function displayValue(value: unknown, key = ""): string {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = redactText(String(value))
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|signature|credential|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/\s+/g, " ")
      // The startup runtime snapshot is intentionally emitted as JSON so it
      // can be copied during configuration debugging. It is already redacted
      // before logging, so keep that one field intact.
      .slice(0, key === "configJson" ? 20_000 : 500);
    return /[\s|=]/.test(text) ? JSON.stringify(text) : text;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.message === "string") return candidate.message.replace(/\s+/g, " ").slice(0, 500);
    return `{${Object.keys(candidate).slice(0, 8).join(",")}}`;
  }
  return String(value);
}

export function formatGatewayConsoleRecord(record: Record<string, unknown>, colorize = true): string {
  record = redactSecrets(record);
  const { label, color } = levelName(record.level);
  const parsedTime = typeof record.time === "string" ? new Date(record.time) : new Date();
  const timestamp = Number.isNaN(parsedTime.getTime()) ? localTimestamp(new Date()) : localTimestamp(parsedTime);
  const source = typeof record.module === "string"
    ? `gateway/${record.module}`
    : typeof record.source === "string" ? `gateway/${record.source}` : "gateway";
  let message = typeof record.msg === "string" ? record.msg : "event";
  message = message.replace(/^\[([^\]]+)\]\s*/, "");
  const excluded = new Set(["level", "time", "pid", "hostname", "msg", "source", "module", "name", "event"]);
  const fields = Object.entries(record)
    .filter(([key, value]) => !excluded.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${displayValue(value, key)}`);
  const line = `${timestamp} ${label.padEnd(5)} [${source}] ${message}${fields.length ? ` | ${fields.join(" ")}` : ""}`;
  const useColor = colorize && process.env.NXCORE_NO_COLOR !== "1";
  return useColor ? `${ANSI.dim}${timestamp}${ANSI.reset} ${color}${label.padEnd(5)}${ANSI.reset} [${source}] ${message}${fields.length ? ` | ${fields.join(" ")}` : ""}` : line;
}

function createConsoleStream(colorize: boolean): Writable {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          process.stdout.write(`${formatGatewayConsoleRecord(JSON.parse(line) as Record<string, unknown>, colorize)}\n`);
        } catch {
          process.stdout.write(`${redactText(line)}\n`);
        }
      }
      callback();
    },
    final(callback) {
      if (pending) {
        try {
          process.stdout.write(`${formatGatewayConsoleRecord(JSON.parse(pending) as Record<string, unknown>, colorize)}\n`);
        } catch {
          process.stdout.write(`${redactText(pending)}\n`);
        }
      }
      callback();
    },
  });
}

export async function createGatewayLogger(dataDirectory: string, level: LogLevel): Promise<GatewayLogger> {
  const logsDirectory = join(dataDirectory, "logs");
  mkdirSync(logsDirectory, { recursive: true });

  const consoleStream = createConsoleStream(process.env.NXCORE_NO_COLOR !== "1");
  const fileStream = await pinoRoll({
    file: join(logsDirectory, "gateway.log"),
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    limit: { count: LOG_RETENTION_DAYS },
    mkdir: true,
  });
  const destination = pino.multistream([
    { stream: consoleStream },
    { stream: fileStream },
  ]);
  const logger = pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: REDACTED_PATHS,
        censor: "[REDACTED]",
      },
      serializers: {
        req: (request) => {
          const serialized = pino.stdSerializers.req(request);
          return { method: serialized.method, url: serialized.url };
        },
        res: (response) => {
          const candidate = response as {
            statusCode?: unknown;
            raw?: { statusCode?: unknown };
          };
          const statusCode = candidate.statusCode ?? candidate.raw?.statusCode;
          return { statusCode: typeof statusCode === "number" ? statusCode : null };
        },
        err: pino.stdSerializers.err,
      },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((value) => redactSecrets(value)) as Parameters<typeof method>);
        },
      },
    },
    destination,
  );

  return {
    logger,
    logsDirectory,
    close: async () => {
      logger.flush();
      await Promise.all([closeStream(consoleStream), closeStream(fileStream)]);
    },
  };
}
