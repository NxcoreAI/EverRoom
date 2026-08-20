import type { ContextRoomRecord } from '../../types';
import { useLocale } from '../../../../../i18n/LocaleContext';
import { ReferenceDialog } from '../shared';

export function MailDetailDialog({
  room,
  mailId,
  onClose,
}: {
  room: ContextRoomRecord;
  mailId: string | null;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const mail = mailId
    ? room.materials.find((item) => item.id === mailId && item.type === '邮件')
    : null;

  return (
    <ReferenceDialog
      open={Boolean(mailId)}
      onOpenChange={(open) => !open && onClose()}
      title={t('contextRoom:mailDetailDialog.emailDetails')}
    >
      {mail ? (
        <article className="context-room-workspace-mail-dialog">
          <header>
            <h2>{mail.title}</h2>
          </header>
          <dl>
            <div>
              <dt>{t('contextRoom:mailDetailDialog.from')}</dt>
              <dd>{mail.sender ?? '张总 · 星港科技'}</dd>
            </div>
            <div>
              <dt>{t('contextRoom:mailDetailDialog.to')}</dt>
              <dd>{mail.recipient ?? t('contextRoom:mailDetailDialog.me')}</dd>
            </div>
            <div>
              <dt>{t('contextRoom:mailDetailDialog.time')}</dt>
              <dd>{mail.time}</dd>
            </div>
          </dl>
          <section>
            <span>{t('contextRoom:mailDetailDialog.text')}</span>
            <p>{mail.body ?? mail.summary}</p>
          </section>
          {mail.attachments?.length ? (
            <section className="context-room-mail-attachments">
              <span>{t('contextRoom:mailDetailDialog.attachments')}</span>
              {mail.attachments.map((attachment) => (
                <button type="button" key={attachment.name}>
                  <b>{attachment.name}</b>
                  <small>{attachment.size}</small>
                </button>
              ))}
            </section>
          ) : null}
          <footer>
            <span>{t('contextRoom:mailDetailDialog.room')}</span>
            <b>{room.title}</b>
          </footer>
        </article>
      ) : null}
    </ReferenceDialog>
  );
}
