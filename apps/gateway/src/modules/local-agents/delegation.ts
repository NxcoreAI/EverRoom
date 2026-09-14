import { createHash } from "node:crypto";
import type {
  AgentWorkspacePermissionProfile,
  LocalAgentDelegationContext,
} from "@nxcore/agent-contract";

export function localAgentGrant(profile: AgentWorkspacePermissionProfile): LocalAgentDelegationContext["grant"] {
  return profile === "full_access"
    ? { workspaceAccess: "full-access", approvals: "agent-reviewed", mutationAllowed: true }
    : profile === "workspace_write"
      ? { workspaceAccess: "workspace-write", approvals: "agent-reviewed", mutationAllowed: true }
      : { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false };
}

export function sealDelegationPayload(
  payload: Omit<LocalAgentDelegationContext, "provenance">,
): LocalAgentDelegationContext {
  return {
    ...payload,
    provenance: {
      source: "everroom.local-agent-delegation",
      generatedAt: new Date().toISOString(),
      digestAlgorithm: "sha256",
      digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    },
  };
}
