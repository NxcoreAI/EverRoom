import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import pinoPretty from "pino-pretty";
import pinoRoll from "pino-roll";
import type { LogLevel } from "../config.js";

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

export async function createGatewayLogger(dataDirectory: string, level: LogLevel): Promise<GatewayLogger> {
  const logsDirectory = join(dataDirectory, "logs");
  mkdirSync(logsDirectory, { recursive: true });

  const consoleStream = pinoPretty({
    colorize: process.stdout.isTTY,
    destination: 1,
    ignore: "pid,hostname",
    singleLine: true,
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
  });
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
          const serialized = pino.stdSerializers.res(response);
          return { statusCode: serialized.statusCode };
        },
        err: pino.stdSerializers.err,
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
