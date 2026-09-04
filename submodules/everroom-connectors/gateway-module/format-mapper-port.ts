import type {
  NormalizedMailChange,
  NormalizedCalendarChange,
} from "@nxcore/connector-contract";

/**
 * FormatMapperPort：归一化映射端口（格式映射体系）。
 *
 * provider 拉取器在原内联归一化调用点改为调用 ctx.normalize*；ctx 由引擎装配时
 * 绑定到本端口（apps/gateway 的 FormatMappingService 实现）。映射未就绪（首次
 * 见到该 provider 格式、生成中或已失败）时抛 FormatMappingPendingError，该轮 run
 * 以 format_mapping_pending 失败、游标不动，后台生成完成后下一 tick 自动重试。
 */
export interface FormatMapperPort {
  normalizeMail(provider: string, raw: unknown): Promise<NormalizedMailChange>;
  normalizeCalendar(provider: string, raw: unknown): Promise<NormalizedCalendarChange>;
}

/**
 * 映射未就绪。message 为稳定机器可读串（manager 原样持久化为 run 错误，渲染层透出）。
 */
export class FormatMappingPendingError extends Error {
  readonly code = "format_mapping_pending";
  constructor(
    readonly service: string,
    readonly recordKind: "mail" | "calendar",
    readonly detail?: string,
  ) {
    super(
      `format_mapping_pending:${service}:${recordKind}` +
        (detail ? `（${detail}）` : "（等待格式映射生成，通常 1 分钟内自动完成）"),
    );
    this.name = "FormatMappingPendingError";
  }
}
