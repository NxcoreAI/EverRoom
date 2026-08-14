import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import OSS from "ali-oss";
import type { Logger } from "pino";
import type { AliyunOssConfig } from "../../config.js";
import { AliyunAsrError } from "./errors.js";
import type { AsrAudioStorage, UploadedAudio } from "./audio-storage.js";

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

function datePath(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export class AliyunOssAudioStorage implements AsrAudioStorage {
  private readonly client: OSS;
  private readonly prefix: string;

  constructor(config: AliyunOssConfig, private readonly logger?: Logger) {
    this.prefix = config.prefix;
    this.client = new OSS({
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      ...(config.stsToken ? { stsToken: config.stsToken } : {}),
      secure: true,
      authorizationV4: true,
    });
  }

  async upload(filePath: string, contentType: string): Promise<UploadedAudio> {
    const objectName = [
      this.prefix,
      datePath(),
      `${randomUUID()}-${basename(filePath)}`,
    ].filter(Boolean).join("/");
    try {
      await this.client.put(objectName, filePath, {
        headers: { "Content-Type": contentType },
      });
      const url = await this.client.signatureUrlV4(
        "GET",
        SIGNED_URL_TTL_SECONDS,
        undefined,
        objectName,
      );
      return {
        url,
        cleanup: () => this.deleteObject(objectName),
      };
    } catch (cause) {
      await this.deleteObject(objectName).catch(() => undefined);
      throw new AliyunAsrError("upload file to OSS", "request failed", { cause });
    }
  }

  private async deleteObject(objectName: string): Promise<void> {
    try {
      await this.client.delete(objectName);
    } catch (error) {
      this.logger?.warn({ err: error, objectName }, "ASR OSS object cleanup failed");
      throw error;
    }
  }
}
