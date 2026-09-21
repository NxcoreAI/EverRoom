import { createHash } from "node:crypto";
import type {
  AgentActiveDocumentContext,
  AgentAttachmentKind,
  AgentMessage,
  AgentWorkspacePermissionProfile,
  LocalAgentDelegationContext,
  LocalAgentDelegationMaterial,
} from "@nxcore/agent-contract";

export const LOCAL_AGENT_HISTORY_MESSAGE_LIMIT = 12;
export const LOCAL_AGENT_HISTORY_CONTENT_LIMIT = 8_000;
export const LOCAL_AGENT_ATTACHMENT_TEXT_LIMIT = 100_000;

export function localAgentGrant(profile: AgentWorkspacePermissionProfile): LocalAgentDelegationContext["grant"] {
  return profile === "full_access"
    ? { workspaceAccess: "full-access", approvals: "agent-reviewed", mutationAllowed: true }
    : profile === "workspace_write"
      ? { workspaceAccess: "workspace-write", approvals: "agent-reviewed", mutationAllowed: true }
      : { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false };
}

export interface LocalAgentDelegationSource {
  pageLabel: string;
  priorMessages: Array<Pick<AgentMessage, "role" | "authorAgentId" | "content" | "createdAt">>;
  attachments: Array<{ filename: string; mimeType: string; kind: AgentAttachmentKind; text?: string }>;
  promptAttachments: Array<{ fileName: string; content?: string }>;
  selectedText?: string;
  rooms: Array<{ id: string }>;
  activeDocument?: AgentActiveDocumentContext;
  workingDirectory: string;
  permissionProfile: AgentWorkspacePermissionProfile;
}

export interface LocalAgentDelegationInclude {
  /** 最近对话是否进入子包（transcript 材料开关）。 */
  conversation?: boolean;
  selection?: boolean;
  attachments?: boolean;
  activeDocument?: boolean;
}

export function buildLocalAgentDelegationPayload(
  input: {
    targetAgentId: string;
    assignmentText: string;
    sharedGoal?: string;
    constraints?: string[];
    materials?: LocalAgentDelegationMaterial[];
    include?: LocalAgentDelegationInclude;
  } & LocalAgentDelegationSource,
): Omit<LocalAgentDelegationContext, "provenance"> {
  const { pageLabel, priorMessages, attachments, promptAttachments, rooms, activeDocument } = input;
  const include = {
    conversation: true,
    selection: true,
    attachments: true,
    activeDocument: true,
    ...input.include,
  };
  const recentMessages = priorMessages.slice(-LOCAL_AGENT_HISTORY_MESSAGE_LIMIT);
  const messages = recentMessages.map((message) => ({
    role: message.role,
    content: message.content.slice(0, LOCAL_AGENT_HISTORY_CONTENT_LIMIT),
    authorAgentId: message.authorAgentId ?? null,
    createdAt: message.createdAt,
  }));
  const sharedGoal = input.sharedGoal?.trim();
  const selectedText = include.selection ? input.selectedText?.trim() : undefined;
  return {
    schemaVersion: 2,
    targetAgentId: input.targetAgentId,
    assignment: {
      text: input.assignmentText,
      ...(sharedGoal ? { sharedGoal } : {}),
      constraints: input.constraints ?? [],
    },
    task: { text: input.assignmentText },
    materials: input.materials ?? [],
    conversation: {
      messages: include.conversation ? messages : [],
      truncated: include.conversation
        ? priorMessages.length > LOCAL_AGENT_HISTORY_MESSAGE_LIMIT
          || recentMessages.some((message) => message.content.length > LOCAL_AGENT_HISTORY_CONTENT_LIMIT)
        : false,
    },
    ...(selectedText ? { selection: { pageLabel, text: selectedText } } : {}),
    attachments: include.attachments
      ? [
          ...attachments.map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            ...(attachment.text ? { text: attachment.text.slice(0, LOCAL_AGENT_ATTACHMENT_TEXT_LIMIT) } : {}),
          })),
          ...promptAttachments.map((attachment) => ({
            filename: attachment.fileName,
            mimeType: "text/plain",
            kind: "document" as const,
            ...(attachment.content ? { text: attachment.content.slice(0, LOCAL_AGENT_ATTACHMENT_TEXT_LIMIT) } : {}),
          })),
        ]
      : [],
    resources: {
      workspaceRoot: input.workingDirectory,
      roomIds: rooms.map((room) => room.id),
      ...(include.activeDocument && activeDocument ? {
        activeDocument: {
          roomId: activeDocument.roomId,
          documentId: activeDocument.documentId,
          title: activeDocument.title,
          version: activeDocument.version,
        },
      } : {}),
    },
    grant: localAgentGrant(input.permissionProfile),
  };
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
