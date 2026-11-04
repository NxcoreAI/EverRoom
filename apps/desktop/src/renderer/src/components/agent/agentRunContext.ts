import type {
  AgentActiveDocumentContext,
  AgentMountedDirectory,
  StartAgentRunInput,
} from '@nxcore/agent-contract'

/**
 * Phase 2i 后无 Room 维度：run context 不再携带 rooms / selectedRoomId，
 * 文稿一律工作区级（activeDocument 亦无 roomId 字段）。
 */
export function buildAgentRunContext(
  selectedText?: string,
  activeDocument?: AgentActiveDocumentContext | null,
  pageLabel?: string,
  mountedDirectories?: AgentMountedDirectory[],
  referencedConversationId?: string,
  referencedLocalAgentIds?: string[],
): NonNullable<StartAgentRunInput['context']> {
  return {
    ...(pageLabel?.trim() ? { pageLabel: pageLabel.trim() } : {}),
    ...(selectedText?.trim() ? { selectedText: selectedText.trim().slice(0, 8_000) } : {}),
    ...(activeDocument ? { activeDocument } : {}),
    ...(mountedDirectories?.length
      ? {
          mountedDirectories: mountedDirectories.map((directory) => ({
            name: directory.name,
            path: directory.path,
          })),
        }
      : {}),
    ...(referencedConversationId ? { referencedConversationId } : {}),
    ...(referencedLocalAgentIds?.length ? { referencedLocalAgentIds } : {}),
  }
}
