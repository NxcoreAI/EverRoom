import type { AgentAccessService } from "./service.js";
import type { ResolvedAgentConnection } from "./types.js";
import type { AgentAccessTool, AgentAccessToolDeps } from "./tools-read.js";
import { createReadTools } from "./tools-read.js";
import { createWriteTools } from "./tools-write.js";

/** 对外工具全集 = 读五件套 + 自述 + 回写三件套（host 按 capabilities 过滤可见性）。 */
export function createAgentAccessTools(
  deps: AgentAccessToolDeps,
  connection: ResolvedAgentConnection,
  service: AgentAccessService,
  registerArtifact: (input: {
    filename: string;
    buffer: Buffer;
    roomId: string | null;
    sourceKey: string;
  }) => Promise<{ fileEntryId: string; contentHash: string; filename: string }>,
): AgentAccessTool[] {
  return [
    ...createReadTools(deps, connection),
    ...createWriteTools(connection, service, registerArtifact),
  ];
}

export type { AgentAccessTool, AgentAccessToolDeps } from "./tools-read.js";
