import type { GatewayConfig } from "../../config.js";
import type { Logger } from "pino";
import { AliyunAsrProvider } from "./aliyun-provider.js";
import type { AsrProvider } from "./types.js";

export function createAsrProvider(config: GatewayConfig, logger?: Logger): AsrProvider | null {
  return config.asr ? new AliyunAsrProvider(config.asr, logger) : null;
}
