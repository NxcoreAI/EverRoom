import type {
  AgentActiveDocumentContext,
  AgentFileAttachment,
  AgentRoomReference,
  StartAgentRunInput,
} from '@nxcore/agent-contract'

export function buildAgentRunContext(
  rooms: AgentRoomReference[],
  selectedText?: string,
  selectedRoomId?: string,
  activeDocument?: AgentActiveDocumentContext | null,
  pageLabel?: string,
  attachments?: AgentFileAttachment[],
): NonNullable<StartAgentRunInput['context']> {
  return {
    ...(pageLabel?.trim() ? { pageLabel: pageLabel.trim() } : {}),
    rooms: rooms.map(({ id, title, kind, background, goal, status, contextSummary }) => ({
      id,
      title,
      ...(kind ? { kind } : {}),
      ...(background?.trim() ? { background: background.trim().slice(0, 2_000) } : {}),
      ...(goal?.trim() ? { goal: goal.trim().slice(0, 2_000) } : {}),
      ...(status?.trim() ? { status: status.trim().slice(0, 500) } : {}),
      ...(contextSummary ? { contextSummary } : {}),
    })),
    ...(selectedText?.trim() ? { selectedText: selectedText.trim().slice(0, 8_000) } : {}),
    ...(selectedRoomId?.trim() ? { selectedRoomId: selectedRoomId.trim() } : {}),
    ...(activeDocument ? { activeDocument } : {}),
    ...(attachments?.length ? { attachments } : {}),
  }
}
