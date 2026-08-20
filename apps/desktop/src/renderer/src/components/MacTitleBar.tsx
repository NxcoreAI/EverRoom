import { useLocale } from '@/i18n/LocaleContext'

export function MacTitleBar() {
  const { t } = useLocale()
  return <header className="mac-titlebar drag-region" aria-label={t('surface:macTitleBar.macosWindowBar')} />
}
