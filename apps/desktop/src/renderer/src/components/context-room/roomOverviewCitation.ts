export type RoomOverviewCitationSection = "overview" | "status" | "next_steps" | "entities" | "timeline";

export const ROOM_OVERVIEW_CITATION_SECTIONS = [
  "overview",
  "status",
  "next_steps",
  "entities",
  "timeline",
] as const satisfies readonly RoomOverviewCitationSection[];

const ROOM_OVERVIEW_CITATION_SECTION_SET = new Set<string>(ROOM_OVERVIEW_CITATION_SECTIONS);

export function isRoomOverviewCitationSection(value: string | undefined): value is RoomOverviewCitationSection {
  return Boolean(value && ROOM_OVERVIEW_CITATION_SECTION_SET.has(value));
}

export interface RoomOverviewCitation {
  id: string;
  roomId: string;
  roomTitle: string;
  section: RoomOverviewCitationSection;
  text: string;
  comment?: string;
}

export const ROOM_OVERVIEW_CITATION_ADD_EVENT = "nxcore:room-overview-citation:add";
export const ROOM_OVERVIEW_CITATION_CLEAR_EVENT = "nxcore:room-overview-citation:clear";

export function addRoomOverviewCitation(citation: RoomOverviewCitation): void {
  window.dispatchEvent(new CustomEvent<RoomOverviewCitation>(ROOM_OVERVIEW_CITATION_ADD_EVENT, { detail: citation }));
}

export function clearRoomOverviewCitation(citationId: string): void {
  window.dispatchEvent(new CustomEvent<string>(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, { detail: citationId }));
}

export function buildRoomOverviewCitationContext(citations: readonly RoomOverviewCitation[]): string {
  return citations.map((citation, index) => [
    `引用 ${index + 1}`,
    `区块：${citation.section}`,
    `引用文本：${citation.text}`,
    ...(citation.comment ? [`用户评论：${citation.comment}`] : []),
  ].join('\n')).join('\n\n');
}

export function buildRoomOverviewCitationPrompt(citations: readonly RoomOverviewCitation[]): string {
  const comments = citations
    .map((citation) => citation.comment?.trim() ?? '')
    .filter(Boolean);
  if (comments.length === 0) return '';
  if (comments.length === 1) return comments[0]!;
  return [
    '请分别处理以下引用评论：',
    ...comments.map((comment, index) => `${index + 1}. ${comment}`),
  ].join('\n');
}
