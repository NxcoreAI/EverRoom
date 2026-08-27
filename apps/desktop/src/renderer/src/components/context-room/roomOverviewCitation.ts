export type RoomOverviewCitationSection = "overview" | "status" | "next_steps" | "entities" | "timeline";

export interface RoomOverviewCitation {
  id: string;
  roomId: string;
  roomTitle: string;
  section: RoomOverviewCitationSection;
  text: string;
}

export const ROOM_OVERVIEW_CITATION_ADD_EVENT = "nxcore:room-overview-citation:add";
export const ROOM_OVERVIEW_CITATION_CLEAR_EVENT = "nxcore:room-overview-citation:clear";

export function addRoomOverviewCitation(citation: RoomOverviewCitation): void {
  window.dispatchEvent(new CustomEvent<RoomOverviewCitation>(ROOM_OVERVIEW_CITATION_ADD_EVENT, { detail: citation }));
}

export function clearRoomOverviewCitation(citationId: string): void {
  window.dispatchEvent(new CustomEvent<string>(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, { detail: citationId }));
}
