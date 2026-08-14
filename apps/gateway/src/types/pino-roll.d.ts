declare module "pino-roll" {
  import type { Writable } from "node:stream";

  interface PinoRollOptions {
    file: string;
    frequency?: "daily" | "hourly";
    dateFormat?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    mkdir?: boolean;
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<Writable>;
}
