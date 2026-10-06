import type { GatewayConfig } from "../../config.js";
import type { Logger } from "pino";
import { AliyunAsrProvider } from "./aliyun-provider.js";
import { NxCoreAsrProvider } from "./nxcore-asr-provider.js";
import { OpenAiCompatibleAsrProvider } from "./openai-compatible-provider.js";
import type { AsrProvider } from "./types.js";

export function createAsrProvider(config: GatewayConfig, logger?: Logger): AsrProvider | null {
  const asr = config.asr;
  if (!asr) return null;
  if (asr.engine === "openai-compatible") {
    return new OpenAiCompatibleAsrProvider({ ...asr, ...(logger ? { logger } : {}) });
  }
  if (asr.engine === "nxcore-asr") {
    return new NxCoreAsrProvider({ ...asr, ...(logger ? { logger } : {}) });
  }
  return new AliyunAsrProvider(asr, logger);
}
