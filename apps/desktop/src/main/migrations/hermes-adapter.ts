import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredMigrationSource } from '../../shared/migrations'
import type { NormalizedMigrationThread } from './types'

/**
 * Hermes 适配器壳：数据格式无公开资料，等真实样本到位后填充 reader。
 * 底座已就绪——provider 枚举、五项能力状态、增量判定、附件通道对 hermes 全部生效。
 * 填充时只需实现 detectHermesSource 的实际探测与 readHermesSource，
 * 并按样本验证会话/记忆/附件三类结构与身份映射（account/agent 标识字段 → externalSessionId/agentId）。
 */

export interface ResolvedHermesSource extends DiscoveredMigrationSource { path: string }

/** 身份映射：样本中哪组字段唯一定位「一个人的一场会话」。 */
export interface HermesIdentityMapping {
  externalSessionIdField: string
  agentIdField?: string
  accountFields: string[]
}

export interface HermesSampleVerification {
  sessions: boolean
  attachments: boolean
  identity: HermesIdentityMapping | null
}

const HERMES_DIRECTORY_CANDIDATES = ['.hermes', 'Hermes']
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export function hermesRootCandidates(home = homedir()): string[] {
  return HERMES_DIRECTORY_CANDIDATES.map((name) => join(home, name)).filter((path) => existsSync(path))
}

/** 样本到位前的占位：不误报来源，也不把未知目录当 Hermes。 */
export function detectHermesSource(_root: string): { kind: 'directory' | 'file' | 'cli'; fingerprint: string } | null {
  return null
}

export async function discoverHermesSources(_home = homedir()): Promise<ResolvedHermesSource[]> {
  return []
}

export async function readHermesSource(_sourcePath: string): Promise<{ threads: NormalizedMigrationThread[]; fingerprint: string }> {
  throw new Error('hermes_adapter_pending_samples')
}

export async function verifyHermesSample(_sample: unknown): Promise<HermesSampleVerification> {
  return { sessions: false, attachments: false, identity: null }
}

export { hash as hermesPathHash }
