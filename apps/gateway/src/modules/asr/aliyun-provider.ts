import type { AliyunAsrConfig } from "../../config.js";
import type { Logger } from "pino";
import { AliyunAsrClient } from "./aliyun-client.js";
import { AliyunOssAudioStorage } from "./aliyun-oss-storage.js";
import type { AsrProvider, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

export class AliyunAsrProvider implements AsrProvider {
  readonly id = "aliyun";
  private readonly client: AliyunAsrClient;

  constructor(config: AliyunAsrConfig, logger?: Logger) {
    this.client = new AliyunAsrClient({
      ...config,
      ...(logger ? { logger } : {}),
      ...(config.oss ? { audioStorage: new AliyunOssAudioStorage(config.oss, logger) } : {}),
    });
  }

  submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    return this.client.submit(input);
  }

  getTask(taskId: string): Promise<AsrTaskSnapshot> {
    return this.client.getTask(taskId);
  }
}
