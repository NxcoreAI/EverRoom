import type { RoomMailDetail } from '@nxcore/agent-contract';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { MailProviderIcon } from '../MailProviderIcon';
import { X } from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';

/** 连接器邮件详情拉取（会话内缓存，Room 切换即失效）：待办邮件区与资料面板共用。 */
export function useConnectorMailDetail(roomId: string, sourceId: string | null) {
  const [state, setState] = useState<{ loading: boolean; detail: RoomMailDetail | null; error: boolean }>({
    loading: false,
    detail: null,
    error: false,
  });
  const cache = useRef(new Map<string, RoomMailDetail>());
  const seq = useRef(0);

  useEffect(() => {
    cache.current.clear();
    seq.current += 1;
  }, [roomId]);

  useEffect(() => {
    if (!sourceId) {
      setState({ loading: false, detail: null, error: false });
      return;
    }
    const cached = cache.current.get(sourceId);
    if (cached) {
      setState({ loading: false, detail: cached, error: false });
      return;
    }
    const ticket = seq.current + 1;
    seq.current = ticket;
    setState({ loading: true, detail: null, error: false });
    void (async () => {
      try {
        const fetched = await window.nxcore?.contextRooms?.readMail(roomId, sourceId);
        if (!fetched) throw new Error('mail_detail_unavailable');
        cache.current.set(sourceId, fetched);
        if (seq.current === ticket) {
          setState({ loading: false, detail: fetched, error: false });
        }
      } catch {
        if (seq.current === ticket) {
          setState({ loading: false, detail: null, error: true });
        }
      }
    })();
  }, [roomId, sourceId]);

  return state;
}

/** 连接器邮件详情面板：身份头 + 元信息 + 正文滚动区。 */
export function ConnectorMailDetailPanel({
  state,
  locale,
  onClose,
}: {
  state: { loading: boolean; detail: RoomMailDetail | null; error: boolean };
  locale: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  if (state.loading) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.loadingMailBody')}</p>
      </aside>
    );
  }
  if (state.error || !state.detail) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.mailBodyUnavailable')}</p>
      </aside>
    );
  }
  const detail = state.detail;
  const when = detail.sentAt && !Number.isNaN(Date.parse(detail.sentAt))
    ? new Date(detail.sentAt).toLocaleString(locale)
    : null;
  return (
    <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
      <header>
        <MailProviderIcon provider={detail.provider} />
        <div className="context-room-mail-detail-title">
          <strong title={detail.subject}>{detail.subject}</strong>
          <small>
            {detail.senderName ?? t('contextRoom:objectDetail.defaultSender')}
            {detail.senderAddress ? ` <${detail.senderAddress}>` : ''}
          </small>
        </div>
        <button type="button" aria-label={t('contextRoom:activityPanes.closeMailDetail')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <p className="context-room-mail-detail-meta">
        {when ? <time>{t('contextRoom:activityPanes.sentAt')}：{when}</time> : null}
      </p>
      <div className="context-room-mail-detail-body">
        <MarkdownBody markdown={detail.body} />
      </div>
    </aside>
  );
}
