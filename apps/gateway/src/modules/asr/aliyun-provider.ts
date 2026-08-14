import type { AliyunAsrConfig } from "../../config.js";
import { AliyunAsrClient } from "./aliyun-client.js";
import type { AsrProvider, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

export class AliyunAsrProvider implements AsrProvider {
  readonly id = "aliyun";
  private readonly client: AliyunAsrClient;

  constructor(config: AliyunAsrConfig) {
    this.client = new AliyunAsrClient(config);
  }

  submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    return this.client.submit(input);
  }

  getTask(taskId: string): Promise<AsrTaskSnapshot> {
    return this.client.getTask(taskId);
  }
}
