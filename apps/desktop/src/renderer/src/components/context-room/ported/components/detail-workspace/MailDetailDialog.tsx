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
      title={t('邮件详情')}
    >
      {mail ? (
        <article className="context-room-workspace-mail-dialog">
          <header>
            <h2>{mail.title}</h2>
          </header>
          <dl>
            <div>
              <dt>{t('发件人')}</dt>
              <dd>{mail.sender ?? '张总 · 星港科技'}</dd>
            </div>
            <div>
              <dt>{t('收件人')}</dt>
              <dd>{mail.recipient ?? t('我')}</dd>
            </div>
            <div>
              <dt>{t('时间')}</dt>
              <dd>{mail.time}</dd>
            </div>
          </dl>
          <section>
            <span>{t('正文')}</span>
            <p>{mail.body ?? mail.summary}</p>
          </section>
          {mail.attachments?.length ? (
            <section className="context-room-mail-attachments">
              <span>{t('附件')}</span>
              {mail.attachments.map((attachment) => (
                <button type="button" key={attachment.name}>
                  <b>{attachment.name}</b>
                  <small>{attachment.size}</small>
                </button>
              ))}
            </section>
          ) : null}
          <footer>
            <span>{t('所属 Room')}</span>
            <b>{room.title}</b>
          </footer>
        </article>
      ) : null}
    </ReferenceDialog>
  );
}
