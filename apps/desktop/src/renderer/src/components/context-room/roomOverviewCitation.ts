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
  claimRefs?: Array<{ claimId: string; text: string }>;
  comment?: string;
}

export const ROOM_OVERVIEW_CITATION_ADD_EVENT = "nxcore:room-overview-citation:add";
export const ROOM_OVERVIEW_CITATION_UPDATE_EVENT = "nxcore:room-overview-citation:update";
export const ROOM_OVERVIEW_CITATION_CLEAR_EVENT = "nxcore:room-overview-citation:clear";

export function addRoomOverviewCitation(citation: RoomOverviewCitation): void {
  window.dispatchEvent(new CustomEvent<RoomOverviewCitation>(ROOM_OVERVIEW_CITATION_ADD_EVENT, { detail: citation }));
}

export function updateRoomOverviewCitation(citation: RoomOverviewCitation): void {
  window.dispatchEvent(new CustomEvent<RoomOverviewCitation>(ROOM_OVERVIEW_CITATION_UPDATE_EVENT, { detail: citation }));
}

export function clearRoomOverviewCitation(citationId: string): void {
  window.dispatchEvent(new CustomEvent<string>(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, { detail: citationId }));
}

/**
 * 引用上下文是发给模型的资料块（context.selectedText），其行格式与 gateway 的
 * ROOM_OVERVIEW_CITATION_CONTEXT 正则耦合（区块：key\n引用文本：），不要改动行结构。
 */
export function buildRoomOverviewCitationContext(citations: readonly RoomOverviewCitation[]): string {
  return citations.map((citation, index) => [
    `引用 ${index + 1}`,
    `区块：${citation.section}`,
    `引用文本：${citation.text}`,
    ...(citation.claimRefs?.length ? [
      "命中 Claims：",
      ...citation.claimRefs.map((claim) => `- ${claim.claimId}：${claim.text}`),
    ] : []),
    ...(citation.comment?.trim() ? [`用户评论：${citation.comment.trim()}`] : []),
  ].join('\n')).join('\n\n');
}

const ROOM_OVERVIEW_CITATION_PROMPT_LABELS: Record<RoomOverviewCitationSection, Record<'zh-CN' | 'en-US', string>> = {
  overview: { 'zh-CN': 'Room 简介', 'en-US': 'Room overview' },
  status: { 'zh-CN': '当前状态', 'en-US': 'Current status' },
  next_steps: { 'zh-CN': '建议下一步', 'en-US': 'Suggested next steps' },
  entities: { 'zh-CN': '关联记忆实体', 'en-US': 'Related memory entities' },
  timeline: { 'zh-CN': 'Room 时间轴', 'en-US': 'Room timeline' },
};

function citationQuote(text: string): string {
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 32);
  return summary.length < text.replace(/\s+/g, ' ').trim().length ? `${summary}…` : summary;
}

/**
 * 引用评论的发送提示词（也是智能区里展示的用户消息）。编号与引用上下文的「引用 N」
 * 一一对应，未附评论的引用也占位说明，避免模型把评论错配到别的选区。
 */
export function buildRoomOverviewCitationPrompt(
  citations: readonly RoomOverviewCitation[],
  locale: string = 'zh-CN',
): string {
  if (!citations.some((citation) => citation.comment?.trim())) return '';
  const language = locale === 'en-US' ? 'en-US' : 'zh-CN';
  const roomTitle = citations[0]?.roomTitle ?? '';
  const count = citations.length;
  const header = language === 'en-US'
    ? (count === 1
      ? `My comment on a selection from the "${roomTitle}" room overview — please correct or clarify the overview accordingly:`
      : `My ${count} comments on selections from the "${roomTitle}" room overview — please correct or clarify the overview for each:`)
    : (count === 1
      ? `我对「${roomTitle}」Room 总览选区的评论如下，请据此纠正或澄清总览中的对应内容：`
      : `我对「${roomTitle}」Room 总览选区的 ${count} 条评论如下，请逐条据此纠正或澄清总览中的对应内容：`);
  const items = citations.map((citation, index) => {
    const label = ROOM_OVERVIEW_CITATION_PROMPT_LABELS[citation.section][language];
    const quote = citationQuote(citation.text);
    const comment = citation.comment?.trim();
    if (language === 'en-US') {
      const body = comment ?? 'no comment, background reference only';
      return `Citation ${index + 1} (${label} "${quote}"): ${body}`;
    }
    const body = comment ?? '未附评论，仅作参考背景';
    return `引用 ${index + 1}（${label}「${quote}」）：${body}`;
  });
  return [header, ...items].join('\n');
}
