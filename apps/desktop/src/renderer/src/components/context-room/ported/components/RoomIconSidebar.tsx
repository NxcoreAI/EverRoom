import {
  BookOpen,
  Briefcase,
  FileStack,
  Lightbulb,
  LucideIcon,
  Share2,
} from 'lucide-react';

export type BoardId = 'work' | 'artifacts' | 'relations' | 'wiki' | 'thoughts';

export type BoardSubtab =
  | 'overview'
  | 'activity'
  | 'todo'
  | 'materials'
  | 'library'
  | 'trash'
  | 'roomRelations'
  | 'entities'
  | 'linkGraph'
  | 'wikiDir'
  | 'wikiGraph';

export interface BoardTab {
  id: BoardId;
  label: string;
  icon: LucideIcon;
  tone: string;
}

export const BOARD_TABS = [
  { id: 'work', label: 'contextRoom:roomBoard.work', icon: Briefcase, tone: 'room' },
  { id: 'thoughts', label: 'contextRoom:roomBoard.thoughts', icon: Lightbulb, tone: 'ai' },
  { id: 'artifacts', label: 'contextRoom:roomBoard.artifacts', icon: FileStack, tone: 'document' },
  { id: 'relations', label: 'contextRoom:roomBoard.relations', icon: Share2, tone: 'data' },
  { id: 'wiki', label: 'contextRoom:roomBoard.wiki', icon: BookOpen, tone: 'data' },
] as const satisfies readonly BoardTab[];

/** 各板块内部页签；单页签板块（思路）不渲染 BoardTabs。 */
export const BOARD_SUBTABS: Record<BoardId, readonly { id: BoardSubtab; label: string }[]> = {
  work: [
    { id: 'overview', label: 'contextRoom:boardTab.overview' },
    { id: 'todo', label: 'contextRoom:boardTab.todo' },
    { id: 'activity', label: 'contextRoom:boardTab.activity' },
    { id: 'materials', label: 'contextRoom:boardTab.materials' },
  ],
  thoughts: [],
  artifacts: [],
  relations: [
    { id: 'roomRelations', label: 'contextRoom:boardTab.roomRelations' },
    { id: 'entities', label: 'contextRoom:boardTab.entities' },
    { id: 'linkGraph', label: 'contextRoom:boardTab.linkGraph' },
  ],
  wiki: [
    { id: 'wikiDir', label: 'contextRoom:wiki.pages' },
    { id: 'wikiGraph', label: 'contextRoom:wiki.graph' },
  ],
};

export const DEFAULT_SUBTABS: Record<BoardId, BoardSubtab | null> = {
  work: 'overview',
  thoughts: null,
  artifacts: 'library',
  relations: 'roomRelations',
  wiki: 'wikiDir',
};
