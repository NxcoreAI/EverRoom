import { Notification, pushNotifications } from 'electron'

import { parseAgentNotificationTarget, type AgentNotificationTarget } from '../../shared/notifications'
import type { SaasClient } from './saas-client'

function alertText(userInfo: Record<string, unknown>): { title: string; body: string } {
  const aps = userInfo.aps && typeof userInfo.aps === 'object' ? userInfo.aps as Record<string, unknown> : null
  const alert = aps?.alert && typeof aps.alert === 'object' ? aps.alert as Record<string, unknown> : null
  return {
    title: typeof alert?.title === 'string' ? alert.title : 'EverRoom',
    body: typeof alert?.body === 'string' ? alert.body : '',
  }
}

export class MacosPushNotificationService {
  private installed = false
  private registered = false
  private registrationInFlight: Promise<void> | null = null

  constructor(
    private readonly client: () => SaasClient | null,
    private readonly openTarget: (target: AgentNotificationTarget) => void,
  ) {}

  install(): void {
    if (this.installed || process.platform !== 'darwin') return
    this.installed = true
    pushNotifications.on('received-apns-notification', this.onRemoteNotification)
  }

  async registerAuthenticatedDevice(): Promise<void> {
    if (process.platform !== 'darwin' || this.registered) return
    if (this.registrationInFlight) return this.registrationInFlight
    this.install()
    const client = this.client()
    if (!client) return
    this.registrationInFlight = (async () => {
      try {
        const token = await pushNotifications.registerForAPNSNotifications()
        await client.registerPushToken('apns', token)
        this.registered = true
      } catch (error) {
        console.warn('macOS push notification registration failed', error)
      }
    })().finally(() => { this.registrationInFlight = null })
    return this.registrationInFlight
  }

  async beforeLogout(): Promise<void> {
    if (process.platform !== 'darwin') return
    await this.registrationInFlight
    await this.client()?.removePushToken('apns').catch((error) => {
      console.warn('Unable to remove macOS push token before logout', error)
    })
    if (this.registered) pushNotifications.unregisterForAPNSNotifications()
    this.registered = false
  }

  stop(): void {
    if (!this.installed) return
    pushNotifications.off('received-apns-notification', this.onRemoteNotification)
    this.installed = false
  }

  private readonly onRemoteNotification = (_event: Electron.Event, userInfo: Record<string, unknown>) => {
    const target = parseAgentNotificationTarget(userInfo)
    if (!target) return
    const { title, body } = alertText(userInfo)
    if (!Notification.isSupported()) {
      console.warn('macOS system notifications are unavailable; dropping agent notification', target.notificationId)
      return
    }
    const notification = new Notification({ title, body })
    notification.on('click', () => this.openTarget(target))
    notification.on('failed', (_event, reason) => console.warn('Agent notification failed to display', reason, target.notificationId))
    notification.show()
  }
}
