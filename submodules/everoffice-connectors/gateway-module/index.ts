/**
 * everroom-connectors · gateway-module 出口
 *
 * 连接器已从「同步管道」收敛为「Agent 即席检索」：
 *   - 传输：OpenConnectorHttpClient（oo HTTP 唯一传输缝）
 *   - 授权：OpenConnectorAuthorizationService（本地模式）
 *   - 连接目录：ConnectorConnectionCatalog（oo 为准 + 本地墓碑）
 *   - 查询：query/ 下的档案、扇出、coverage、ref、read
 *   - 文件转换：converters / email-content / legacy-office（服务文档理解，不属于同步）
 */
export {
  OpenConnectorHttpClient,
  envelopeData,
  runOoHttp,
  type OoHttpRunner,
} from "./open-connector-http-client.js";
export {
  OpenConnectorAuthorizationService,
  ooServiceOfProvider,
  type ConnectorAuthorizationStart,
} from "./open-connector-authorization.js";
export {
  ConnectorConnectionCatalog,
  providerOfService,
  connectionIdOf,
  parseConnectionId,
  type ConnectorDisconnectStore,
} from "./connection-runtime.js";
export { connectorRoutes, type AuthorizationLike } from "./routes.js";
export { htmlToMarkdown, converterOfExtension } from "./converters.js";
export { convertEmailBody, convertRawEmailToMarkdown } from "./email-content.js";
export * from "./query/index.js";
export type { OpenConnectorCliConfig } from "./host-types.js";
