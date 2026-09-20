import { useEffect, useMemo, useState } from 'react';

import type {
  EmergenceFocusChapter,
  EmergenceFocusInput,
  EmergenceFocusLevel,
  EmergenceFocusTrigger,
} from '../../../../../../shared/knowledge';

/**
 * 焦点协调器（PRD 7.3 FocusContext 一期）：Room 内唯一权威焦点源。
 * - 信号：选区（编辑器）、章节（光标所在节）、产物（打开的文档）、Room 兜底；
 * - 仲裁：selection > chapter > document > room，低级信号不覆盖高级信号；
 * - 锁定：锁定后冻结当时焦点，信号继续到达但只用于解锁后恢复；
 * - 版本：焦点定案即递增，消费方可据此丢弃过期结果。
 */
export interface UseRoomFocusOptions {
  roomId: string;
  /** 当前板块（信息性字段，随焦点透传）。 */
  board: string;
  /** 右区编辑器打开的产物（cloud-doc 选中项），null=无编辑现场。 */
  documentId: string | null;
  documentTitle: string | null;
}

export interface RoomFocusController {
  focus: EmergenceFocusInput;
  /** 非选区级别的焦点文案（章节标题/产物标题/房间 id）；选区级别由视图自行 i18n。 */
  label: string | null;
  level: EmergenceFocusLevel;
  locked: boolean;
  toggleLocked: () => void;
  setSelection: (text: string | null) => void;
  setChapter: (chapter: EmergenceFocusChapter | null) => void;
}

export interface FocusArbitration {
  level: EmergenceFocusLevel;
  /** 非选区级别的焦点文案（章节标题/产物标题）；选区与 Room 级别由视图兜底。 */
  label: string | null;
  trigger: EmergenceFocusTrigger;
}

/** 焦点仲裁（PRD 7.3 优先级链）：selection > chapter > document > room。 */
export function arbitrateFocus(
  selection: string | null,
  chapter: EmergenceFocusChapter | null,
  documentId: string | null,
  documentTitle: string | null,
): FocusArbitration {
  if (selection) return { level: 'selection', label: null, trigger: 'selection-settle' };
  if (chapter && chapter.bodyText.trim()) {
    return {
      level: 'chapter',
      label: chapter.heading ?? (documentTitle || null),
      trigger: 'chapter-stable',
    };
  }
  if (documentId) return { level: 'document', label: documentTitle || null, trigger: 'document-open' };
  return { level: 'room', label: null, trigger: 'panel-open' };
}

export function useRoomFocus({ roomId, board, documentId, documentTitle }: UseRoomFocusOptions): RoomFocusController {
  const [selection, setSelectionState] = useState<string | null>(null);
  const [chapter, setChapterState] = useState<EmergenceFocusChapter | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockedFocus, setLockedFocus] = useState<EmergenceFocusInput | null>(null);
  const [lockedArbitration, setLockedArbitration] = useState<FocusArbitration | null>(null);

  // 换产物/关编辑器=旧文档的选区与章节信号全部作废。
  useEffect(() => {
    setSelectionState(null);
    setChapterState(null);
  }, [roomId, documentId]);

  const arbitration = arbitrateFocus(selection, chapter, documentId, documentTitle);
  const liveFocus = useMemo<EmergenceFocusInput>(() => ({
    documentId,
    selectionText: selection,
    blockId: null,
    board,
    level: arbitration.level,
    trigger: arbitration.trigger,
    chapter,
  }), [documentId, selection, board, arbitration, chapter]);

  // 焦点身份变化即版本递增（渲染期比较须存 state，ref 会在严格模式双渲染下丢更新）。
  const focusKey = `${documentId ?? ''}|${selection ?? ''}|${chapter?.heading ?? ''}|${chapter?.bodyText ?? ''}`;
  const [versionState, setVersionState] = useState({ key: focusKey, version: 1 });
  if (versionState.key !== focusKey) {
    setVersionState({ key: focusKey, version: versionState.version + 1 });
  }

  const focus = locked && lockedFocus ? lockedFocus : liveFocus;
  const effectiveArbitration = lockedArbitration ?? arbitration;
  const toggleLocked = () => {
    setLocked((current) => {
      const next = !current;
      setLockedFocus(next ? liveFocus : null);
      setLockedArbitration(next ? arbitration : null);
      return next;
    });
  };

  return {
    focus,
    label: effectiveArbitration.label,
    level: (focus.level ?? effectiveArbitration.level),
    locked,
    toggleLocked,
    setSelection: setSelectionState,
    setChapter: setChapterState,
  };
}
