import type { GatewayConfig } from "../../config.js";
import { AliyunAsrProvider } from "./aliyun-provider.js";
import type { AsrProvider } from "./types.js";

export function createAsrProvider(config: GatewayConfig): AsrProvider | null {
  return config.asr ? new AliyunAsrProvider(config.asr) : null;
}
