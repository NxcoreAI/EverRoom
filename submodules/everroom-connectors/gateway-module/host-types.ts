/**
 * 宿主类型注入（submodule 自包含的关键缝）。
 *
 * gateway-module 不 import 宿主 `../../config.js`、`../../infrastructure/database/*`
 * 的实际路径，而是从这里取类型。宿主通过 tsconfig paths：
 *   "#gateway/config"    → apps/gateway/src/config.ts
 *   "#gateway/database"  → apps/gateway/src/infrastructure/database/client.ts
 *   "#gateway/schema"    → apps/gateway/src/infrastructure/database/schema.ts
 * 注入实现。submodule 独立 typecheck 时用 host-stubs/ 下的结构等价 stub。
 *
 * agent 工具运行时经 port-agent-tools.ts 的 factory setter 注入（运行时缝）；
 * PiAgentRuntimeTool / AgentRuntime 等类型来自 workspace 包 @nxcore/agent-runtime(-pi)。
 *
 * 依赖原则：本文件只允许 `export type`，不产生运行时依赖。
 */

/** 宿主网关配置（apps/gateway/src/config.ts）。 */
export type {
  GatewayConfig,
  ConnectorSyncJobConfig,
  OpenConnectorCliConfig,
} from "../../../apps/gateway/src/config.js";
/** 宿主数据库句柄（apps/gateway/src/infrastructure/database/client.ts）。 */
export type { GatewayDatabase } from "../../../apps/gateway/src/infrastructure/database/client.js";
