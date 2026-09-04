/**
 * everroom-connectors · gateway-module 出口
 *
 * 宿主（apps/gateway）经 workspace 别名 `@nxcore/connectors-module` 引用本模块。
 * 模块内文件自旧路径 `apps/gateway/src/modules/connectors/` 平移而来，
 * 相对导入保持不变；对宿主的依赖收敛为：
 *   - `@nxcore/connector-contract`（submodule 内兄弟包）
 *   - `#gateway/*`（宿主注入类型：config / database / schema，见 host-types.ts）
 *   - `#agent/*`（宿主 agent 运行时，见 host-types.ts）
 */
export * from "./types.js";
export { SYNC_PROVIDERS, assertSyncProvidersValid } from "./sync-providers/index.js";
export { ConnectorManager } from "./manager.js";
export { ConnectorSyncService } from "./service.js";
export { ConnectorMarkdownService } from "./markdown-service.js";
export { projectDomainRecords } from "./domain-projection.js";
export { nangoConnectorRoutes, cliConnectorRoutes } from "./routes.js";
export { htmlToMarkdown, converterOfExtension } from "./converters.js";
export { convertEmailBody, convertRawEmailToMarkdown } from "./email-content.js";
export {
  connectorEmailToMarkdown,
  connectorDocumentToMarkdown,
  connectorCalendarEventToMarkdown,
  connectorTodoToMarkdown,
  connectorGenericRecordToMarkdown,
} from "./connector-markdown.js";
export { parseIcsCalendar } from "./ics.js";
