import { useEffect } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * 主进程请求错误的 UI 出口：统一走顶部红色 toast（自动消失、进出过渡），
 * 不再打断式模态弹窗。ASR 权限类错误带"打开系统设置"操作按钮，展示更久。
 */
export function AppErrorToast() {
  const { t } = useLocale()

  useEffect(() => window.nxcore?.errors.onRequestError((error) => {
    if (error.severity === 'notice') {
      showToast({
        title: error.title ?? t('surface:appErrorDialog.notice'),
        message: error.message,
      })
      return
    }
    showToast({
      variant: 'error',
      title: error.title ?? t('surface:appErrorDialog.requestNotCompleted'),
      message: error.message,
      ...(error.action && error.actionLabel ? {
        actionLabel: error.actionLabel,
        onAction: () => {
          if (error.action === 'open-microphone-settings') void window.nxcore?.asr.openMicrophoneSettings().catch(() => undefined)
          else if (error.action === 'open-system-audio-settings') void window.nxcore?.asr.openSystemAudioSettings().catch(() => undefined)
        },
      } : {}),
    })
  }), [t])

  return null
}
