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
  | 'linkGraph';

export interface BoardTab {
  id: BoardId;
  label: string;
  icon: LucideIcon;
  tone: string;
}

export const BOARD_TABS = [
  { id: 'work', label: 'contextRoom:roomBoard.work', icon: Briefcase, tone: 'room' },
  { id: 'artifacts', label: 'contextRoom:roomBoard.artifacts', icon: FileStack, tone: 'document' },
  { id: 'relations', label: 'contextRoom:roomBoard.relations', icon: Share2, tone: 'data' },
  { id: 'wiki', label: 'contextRoom:roomBoard.wiki', icon: BookOpen, tone: 'data' },
  { id: 'thoughts', label: 'contextRoom:roomBoard.thoughts', icon: Lightbulb, tone: 'ai' },
] as const satisfies readonly BoardTab[];

/** 各板块内部页签；单页签或面板自带页签（wiki）的板块不渲染 BoardTabs。 */
export const BOARD_SUBTABS: Record<BoardId, readonly { id: BoardSubtab; label: string }[]> = {
  work: [
    { id: 'overview', label: 'contextRoom:boardTab.overview' },
    { id: 'activity', label: 'contextRoom:boardTab.activity' },
    { id: 'todo', label: 'contextRoom:boardTab.todo' },
    { id: 'materials', label: 'contextRoom:boardTab.materials' },
  ],
  artifacts: [],
  relations: [
    { id: 'roomRelations', label: 'contextRoom:boardTab.roomRelations' },
    { id: 'entities', label: 'contextRoom:boardTab.entities' },
    { id: 'linkGraph', label: 'contextRoom:boardTab.linkGraph' },
  ],
  wiki: [],
  thoughts: [],
};

/** wiki/thoughts 板块单页面板，无板块级页签。 */
export const DEFAULT_SUBTABS: Record<BoardId, BoardSubtab | null> = {
  work: 'overview',
  artifacts: 'library',
  relations: 'roomRelations',
  wiki: null,
  thoughts: null,
};
