/**
 * Agent 直连工具（原宿主 modules/agent/open-connector-tools.ts，随连接器域迁入）。
 *
 * Seam 3 目标态：内部 spawn CLI 换 OpenConnectorHttpClient（见执行方向 §P1）。
 */
export {
  createOpenConnectorPiTools,
  type OoRunner,
} from "./open-connector-tools.js";
