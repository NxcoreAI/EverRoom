import type { FastifyBaseLogger } from "fastify";
import { sniffImageMime } from "../../infrastructure/image-mime.js";
import type { PerceptionService } from "../perception/service.js";
import { insightEvidenceMarkdown } from "../reality/insight-tags.js";
import type { FilesService } from "./service.js";

export interface ImageDescribeOutcome {
  dataType: "image";
  title: string;
  markdown: string;
}

/** ingest 引擎挂接点：processBytes 对图片扩展名调用；VLM 结果同时落视觉库。 */
export interface ImageDescriber {
  describe(input: { buffer: Buffer; filename: string; capturedAt: Date }): Promise<ImageDescribeOutcome>;
}

const DESCRIBE_TIMEOUT_MS = 45_000;

function placeholderOutcome(filename: string): ImageDescribeOutcome {
  const title = filename.replace(/\.[^.]+$/, "") || filename;
  return { dataType: "image", title, markdown: `# ${filename}\n\n> 暂无 AI 描述（视觉模型不可用或调用失败）。` };
}

export class ImageDescribeService implements ImageDescriber {
  constructor(
    private readonly files: FilesService,
    private readonly perception: PerceptionService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async describe(input: { buffer: Buffer; filename: string; capturedAt: Date }): Promise<ImageDescribeOutcome> {
    const fallback = placeholderOutcome(input.filename);
    const mime = sniffImageMime(input.buffer);
    if (!mime) return fallback;

    const uploaded = await this.files.upload({
      filename: input.filename,
      buffer: input.buffer,
      mime,
      assetKind: "photo",
      originChannel: "file-import",
      visibility: "private",
      capturedAt: input.capturedAt,
    });

    const existing = this.perception.observationOf(uploaded.fileId);
    if (existing?.node.vlmStatus === "ready" && existing.node.summary) {
      return {
        dataType: "image",
        title: existing.node.title ?? fallback.title,
        markdown: insightEvidenceMarkdown({
          title: existing.node.title ?? fallback.title,
          eventType: existing.node.eventType,
          summary: existing.node.summary,
          keyPoints: existing.node.keyPoints,
          tags: existing.node.representativeTags,
        }),
      };
    }

    const vlm = this.perception.currentVlm();
    if (!vlm || !this.perception.settings().onlineVlmEnabled) {
      await this.registerForBackfill(uploaded.fileId, input.capturedAt);
      return fallback;
    }
    try {
      const result = await vlm.infer({ buffer: input.buffer, mime }, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS));
      this.perception.registerResolvedObservation({
        fileId: uploaded.fileId,
        kind: "photo",
        capturedAt: input.capturedAt,
        result,
        model: vlm.model,
      });
      return {
        dataType: "image",
        title: result.title,
        markdown: insightEvidenceMarkdown({
          title: result.title,
          eventType: result.eventType,
          summary: result.summary,
          keyPoints: result.keyPoints,
          tags: result.representativeTags,
        }),
      };
    } catch (error) {
      this.logger.warn({
        fileId: uploaded.fileId,
        err: error instanceof Error ? error.message : String(error),
      }, "image describe vlm failed, deferring to perception queue");
      await this.registerForBackfill(uploaded.fileId, input.capturedAt);
      return fallback;
    }
  }

  /** VLM 暂不可用：按常规注册（pending/disabled），感知队列或 backfill 日后补描述。 */
  private async registerForBackfill(fileId: string, capturedAt: Date): Promise<void> {
    try {
      this.perception.registerObservation({ fileId, kind: "photo", capturedAt });
    } catch (error) {
      this.logger.warn({
        fileId,
        err: error instanceof Error ? error.message : String(error),
      }, "image describe backfill registration failed");
    }
  }
}
