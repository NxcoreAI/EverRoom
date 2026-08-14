import {
  BookOpen,
  Flag,
  MessageSquare,
  Target,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { ContextRoomKind, ContextRoomRecord } from '../types';

import { uiText } from '../adapters';

export function roomKindIcon(kind: ContextRoomKind): LucideIcon {
  if (kind === '议题') return MessageSquare;
  if (kind === '事件') return Zap;
  if (kind === '人物') return UserRound;
  if (kind === '项目') return Target;
  if (kind === '长期目标') return Flag;
  return BookOpen;
}

export function roomKindTone(kind: ContextRoomKind) {
  if (kind === '议题') return 'ai';
  if (kind === '事件') return 'calendar';
  if (kind === '人物') return 'people';
  if (kind === '项目') return 'room';
  if (kind === '长期目标') return 'memory';
  return 'document';
}

export function getToneClass(tone: ContextRoomRecord['tone']) {
  return {
    sky: 'border-sky-200 bg-sky-50 text-sky-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    zinc: 'border-zinc-200 bg-zinc-100 text-zinc-700',
  }[tone];
}

export function createEditorContent(room: ContextRoomRecord) {
  return uiText(`
    <h2>${room.title}</h2>
    <p>${room.kind} / ${room.brief.background}</p>
    <ul>
      <li>目标：${room.brief.goal}</li>
      <li>关键结论：${room.brief.decisions.join('、') || '暂无'}</li>
      <li>24h 反向召回：${room.nextReverseRecall}</li>
    </ul>
  `);
}
