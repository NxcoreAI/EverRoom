import type { TiptapJsonContent } from '@nxcore/agent-contract'

import type { ContextRoomKind, ContextRoomRecord } from '@/components/context-room/ported/types'
import type { Translate } from '@/i18n/LocaleContext'

interface RoomUsageGuide {
  documentId: string
  title: string
  contentJson: TiptapJsonContent
}

const focusKeyByKind: Record<ContextRoomKind, string> = {
  人物: 'contextRoom:onboarding.guideFocusPerson',
  项目: 'contextRoom:onboarding.guideFocusProject',
  主题: 'contextRoom:onboarding.guideFocusTopic',
  长期目标: 'contextRoom:onboarding.guideFocusLongTermGoal',
  议题: 'contextRoom:onboarding.guideFocusIssue',
  事件: 'contextRoom:onboarding.guideFocusEvent',
}

function text(value: string): TiptapJsonContent {
  return { type: 'text', text: value }
}

function paragraph(value: string): TiptapJsonContent {
  return { type: 'paragraph', content: [text(value)] }
}

function heading(level: 2 | 3, value: string): TiptapJsonContent {
  return { type: 'heading', attrs: { level }, content: [text(value)] }
}

function bulletList(items: string[]): TiptapJsonContent {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  }
}

function orderedList(items: string[]): TiptapJsonContent {
  return {
    type: 'orderedList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  }
}

export function createRoomUsageGuide(
  room: Pick<ContextRoomRecord, 'id' | 'title' | 'kind'>,
  t: Translate,
): RoomUsageGuide {
  const title = t('contextRoom:onboarding.guideTitle', { name: room.title })
  const focus = t(focusKeyByKind[room.kind] ?? 'contextRoom:onboarding.guideFocusDefault')
  return {
    // A stable id makes onboarding retries idempotent at the document service.
    documentId: `room-guide-${room.id}`.slice(0, 128),
    title,
    contentJson: {
      type: 'doc',
      content: [
        paragraph(t('contextRoom:onboarding.guideIntro', { name: room.title })),
        heading(2, t('contextRoom:onboarding.guidePurposeHeading')),
        paragraph(t('contextRoom:onboarding.guidePurposeBody', { focus })),
        heading(2, t('contextRoom:onboarding.guideWorkflowHeading')),
        orderedList([
          t('contextRoom:onboarding.guideWorkflow1'),
          t('contextRoom:onboarding.guideWorkflow2'),
          t('contextRoom:onboarding.guideWorkflow3'),
          t('contextRoom:onboarding.guideWorkflow4'),
        ]),
        heading(2, t('contextRoom:onboarding.guideBelongsHeading')),
        bulletList([
          t('contextRoom:onboarding.guideBelongs1'),
          t('contextRoom:onboarding.guideBelongs2'),
          t('contextRoom:onboarding.guideBelongs3'),
        ]),
        heading(2, t('contextRoom:onboarding.guideAgentHeading')),
        paragraph(t('contextRoom:onboarding.guideAgentBody')),
        heading(2, t('contextRoom:onboarding.guideUsefulHeading')),
        bulletList([
          t('contextRoom:onboarding.guideUseful1'),
          t('contextRoom:onboarding.guideUseful2'),
          t('contextRoom:onboarding.guideUseful3'),
        ]),
      ],
    },
  }
}
