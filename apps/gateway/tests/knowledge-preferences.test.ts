import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pino from 'pino'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import {
  entities as entitiesTable,
  entityDocLinks,
  routeDecisions,
  roomDuplicateCandidates,
} from '../src/infrastructure/database/schema.js'
import {
  KnowledgePreferences,
  collectPreferenceStats,
  type KnowledgePreferenceLlm,
} from '../src/modules/knowledge/preferences.js'
import { buildExtractionPrompt, buildIdentityPrompt } from '../src/modules/knowledge/llm.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness(llm?: KnowledgePreferenceLlm | null) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-knowledge-preferences-'))
  temporaryDirectories.push(dataDir)
  const database = createDatabase(join(dataDir, 'gateway.sqlite'), resolve('drizzle'))
  const preferences = new KnowledgePreferences(
    database.db,
    () => llm ?? null,
    pino({ level: 'silent' }),
  )
  return { ...database, preferences }
}

function seedSignals(db: ReturnType<typeof createDatabase>['db']) {
  const now = new Date()
  for (const [id, name, status] of [
    ['entity-a', '校园生活', 'room'],
    ['entity-b', '校园生活记录', 'room'],
    ['entity-c', '重复主题', 'room'],
    ['entity-d', '重复主题甲', 'room'],
    ['entity-e', '重复主题乙', 'room'],
    ['entity-s1', '暂不一', 'suppressed'],
    ['entity-s2', '暂不二', 'suppressed'],
    ['entity-s3', '暂不三', 'suppressed'],
  ] as const) {
    db.insert(entitiesTable).values({ id, name, kind: '主题', status, createdAt: now, updatedAt: now }).run()
  }
  // 「重复主题」跨 2 个配对被判 distinct（entity-c vs d / entity-c vs e）。
  const candidate = (id: string, a: string, b: string, decided: 'distinct' | 'related' | null) => {
    db.insert(roomDuplicateCandidates).values({
      id, roomAId: a, roomBId: b,
      nameScore: 0.9, centroidScore: 0, contentOverlap: 0, entityOverlap: 0, duplicateScore: 0.27,
      confidence: 'pending', reasons: [], status: decided ?? 'open',
      ...(decided ? { decidedStatus: decided, decidedAt: now } : {}),
      evidenceRevision: 'rev-1', scoringVersion: 2, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run()
  }
  candidate('cand-1', 'entity-c', 'entity-d', 'distinct')
  candidate('cand-2', 'entity-c', 'entity-e', 'distinct')
  candidate('cand-3', 'entity-a', 'entity-b', 'related')
  // 近 30 天路由撤销 + 手动挂载。
  db.insert(routeDecisions).values({
    id: 'decision-1', sourceId: 'src-1', sourceVersion: 1, confidence: 0.9,
    status: 'reverted', updatedAt: now, createdAt: now,
  }).run()
  for (const id of ['link-1', 'link-2']) {
    db.insert(entityDocLinks).values({
      id, entityId: 'entity-a', sourceKind: 'file', sourceId: `file-${id}`, sourceVersion: 1,
      role: 'manual', decidedBy: 'user', createdAt: now, updatedAt: now,
    }).run()
  }
}

describe('KnowledgePreferences（M3 习惯学习）', () => {
  it('collects deterministic stats across the three signal families', async () => {
    const { db, preferences, sqlite } = await harness()
    seedSignals(db)
    const stats = collectPreferenceStats(db)
    expect(stats.corrections).toEqual({ reverts: 1, manualLinks: 2 })
    expect(stats.mergeVerdicts.distinct).toBe(2)
    expect(stats.mergeVerdicts.related).toBe(1)
    expect(stats.mergeVerdicts.topDistinctNames).toEqual([{ name: '重复主题', count: 2 }])
    expect(stats.promotion).toEqual({ suppressed: 3, promotedRooms: 5 })
    void preferences
    sqlite.close()
  })

  it('composes the injection digest with user takeover first and honours the injection switch', async () => {
    const { db, preferences, sqlite } = await harness()
    seedSignals(db)
    preferences.refreshStats()
    expect(preferences.digestForInjection()).toContain('信号统计')
    expect(preferences.digestForInjection()).not.toContain('用户偏好')

    // 编辑即接管：用户偏好优先于系统洞察。
    preferences.updateUserPreference('工作与生活主题严格分开，不要合并。')
    const digest = preferences.digestForInjection()
    expect(digest.indexOf('用户偏好')).toBeLessThan(digest.indexOf('信号统计'))

    // 负向断言：注入开关关闭 → digest 恒空（行为回到 M2）。
    preferences.updateSettings({ injectionEnabled: false })
    expect(preferences.digestForInjection()).toBe('')
    preferences.updateSettings({ injectionEnabled: true })
    expect(preferences.digestForInjection()).toContain('用户偏好')

    // 清空即解除接管。
    preferences.updateUserPreference('   ')
    expect(preferences.getPreferences().userEdited).toBe(false)
    expect(preferences.digestForInjection()).not.toContain('用户偏好')
    sqlite.close()
  })

  it('refreshes the insight via LLM, skips unchanged material, and keeps old insight on failure', async () => {
    const chatForPreferences = vi.fn(async () => '洞察 v1：用户偏好细粒度主题。')
    const { db, preferences, sqlite } = await harness({ chatForPreferences })
    seedSignals(db)

    // 样本 < 3 不生成（冷启动空注入 = 现状行为）。
    const fresh = await harness({ chatForPreferences })
    await fresh.preferences.refreshNow()
    expect(chatForPreferences).not.toHaveBeenCalled()
    expect(fresh.preferences.getPreferences().insight).toBeNull()
    fresh.sqlite.close()

    await preferences.refreshNow()
    expect(preferences.getPreferences().insight).toBe('洞察 v1：用户偏好细粒度主题。')
    expect(chatForPreferences).toHaveBeenCalledTimes(1)

    // 素材指纹未变：跳过 LLM 重写。
    await preferences.refreshNow()
    expect(chatForPreferences).toHaveBeenCalledTimes(1)

    // LLM 失败：洞察保旧。
    chatForPreferences.mockRejectedValue(new Error('llm down'))
    db.update(roomDuplicateCandidates).set({ decidedStatus: 'distinct', decidedAt: new Date() })
      .where(eq(roomDuplicateCandidates.id, 'cand-3')).run()
    await preferences.refreshNow()
    expect(preferences.getPreferences().insight).toBe('洞察 v1：用户偏好细粒度主题。')
    sqlite.close()
  })

  it('skips learning entirely when the learning switch is off', async () => {
    const chatForPreferences = vi.fn(async () => '不该出现')
    const { db, preferences, sqlite } = await harness({ chatForPreferences })
    seedSignals(db)
    preferences.updateSettings({ learningEnabled: false })
    await preferences.refreshNow()
    expect(chatForPreferences).not.toHaveBeenCalled()
    expect(preferences.getPreferences().stats).toBeNull()
    sqlite.close()
  })
})

describe('M3 prompt 注入构造（纯函数）', () => {
  it('prepends the advisory digest to extraction prompts only when present', () => {
    const withDigest = buildExtractionPrompt('标题', '# 正文', '用户偏好：细粒度主题')
    expect(withDigest).toContain('【整理偏好（建议性参考，可信系统注入）】')
    expect(withDigest).toContain('用户偏好：细粒度主题')
    expect(withDigest.indexOf('整理偏好')).toBeLessThan(withDigest.indexOf('资料标题'))

    const withoutDigest = buildExtractionPrompt('标题', '# 正文', undefined)
    expect(withoutDigest.startsWith('资料标题')).toBe(true)
  })

  it('adds pair history and preference digest to identity prompts independently', () => {
    const prompt = buildIdentityPrompt(
      {
        name: 'A', aliases: [], kind: '主题', evidenceSamples: [],
        priorVerdictNote: '用户曾于 2026-09-01 判定非重复',
        preferenceDigest: '洞察摘要',
      },
      { name: 'B', aliases: [], kind: '主题', evidenceSamples: [] },
    )
    expect(prompt).toContain('整理偏好（建议性参考）：洞察摘要')
    expect(prompt).toContain('历史参考（可信注入）：用户曾于 2026-09-01 判定非重复')

    const bare = buildIdentityPrompt(
      { name: 'A', aliases: [], kind: '主题', evidenceSamples: [] },
      { name: 'B', aliases: [], kind: '主题', evidenceSamples: [] },
    )
    expect(bare.startsWith('实体 A：')).toBe(true)
    expect(bare).not.toContain('历史参考')
    expect(bare).not.toContain('整理偏好')
  })
})
