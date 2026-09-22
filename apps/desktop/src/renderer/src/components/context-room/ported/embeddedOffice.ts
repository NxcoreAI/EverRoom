import { useSyncExternalStore } from 'react'

/**
 * Room 内嵌 Office 预览仲裁（模块级 store）。
 * PageCanvas 切页会卸载 Room 页（React 状态随之丢失），而原生预览实例
 * 归属与「生成完成后自动打开」的意图必须存活于组件树之外。
 * App 依据 currentInstance 决定 rooms 页激活哪个实例；内嵌宿主组件
 * （EmbeddedOfficePreview）挂载时登记、卸载时释放。
 */
export interface EmbeddedOfficeInstance {
  roomId: string
  fileId: string
  instanceId: string
}

let currentInstance: EmbeddedOfficeInstance | null = null
const instanceListeners = new Set<() => void>()

function subscribeInstance(listener: () => void): () => void {
  instanceListeners.add(listener)
  return () => instanceListeners.delete(listener)
}

function getEmbeddedOfficeSnapshot(): EmbeddedOfficeInstance | null {
  return currentInstance
}

export function getEmbeddedOffice(): EmbeddedOfficeInstance | null {
  return currentInstance
}

export function setEmbeddedOffice(next: EmbeddedOfficeInstance): void {
  currentInstance = next
  instanceListeners.forEach((listener) => listener())
}

/** 仅当仍归属 expectedFileId 时释放，防止异步竞态误清后来登记的实例。 */
export function releaseEmbeddedOffice(expectedFileId: string): void {
  if (currentInstance?.fileId !== expectedFileId) return
  currentInstance = null
  instanceListeners.forEach((listener) => listener())
}

export function useEmbeddedOffice(): EmbeddedOfficeInstance | null {
  return useSyncExternalStore(subscribeInstance, getEmbeddedOfficeSnapshot)
}

/** Agent 生成完成后的 Room 内自动打开请求（App 发起，PortedDetail 消费）。 */
export interface RoomOfficeFocusRequest {
  roomId: string
  fileId: string
  originalName: string
  requestId: number
}

let pendingFocus: RoomOfficeFocusRequest | null = null
const focusListeners = new Set<() => void>()

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => focusListeners.delete(listener)
}

function getRoomOfficeFocusSnapshot(): RoomOfficeFocusRequest | null {
  return pendingFocus
}

export function requestRoomOfficeFocus(request: RoomOfficeFocusRequest): void {
  pendingFocus = request
  focusListeners.forEach((listener) => listener())
}

export function consumeRoomOfficeFocus(requestId: number): void {
  if (pendingFocus?.requestId !== requestId) return
  pendingFocus = null
  focusListeners.forEach((listener) => listener())
}

export function useRoomOfficeFocus(): RoomOfficeFocusRequest | null {
  return useSyncExternalStore(subscribeFocus, getRoomOfficeFocusSnapshot)
}
