import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";
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

export function createGatewayLogger(dataDirectory: string, level: LogLevel): GatewayLogger {
  const logsDirectory = join(dataDirectory, "logs");
  mkdirSync(logsDirectory, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino-pretty",
        options: {
          colorize: process.stdout.isTTY,
          destination: 1,
          ignore: "pid,hostname",
          singleLine: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        },
      },
      {
        target: "pino-roll",
        options: {
          file: join(logsDirectory, "gateway.log"),
          frequency: "daily",
          dateFormat: "yyyy-MM-dd",
          limit: { count: LOG_RETENTION_DAYS },
          mkdir: true,
        },
      },
    ],
  });
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
    transport,
  );

  return {
    logger,
    logsDirectory,
    close: () => new Promise<void>((resolve, reject) => {
      const handleClose = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        transport.off("close", handleClose);
        transport.off("error", handleError);
      };
      transport.once("close", handleClose);
      transport.once("error", handleError);
      transport.end();
    }),
  };
}
