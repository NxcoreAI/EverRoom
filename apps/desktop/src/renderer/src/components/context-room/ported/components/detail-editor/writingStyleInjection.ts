/**
 * 补全侧写作风格注入（writing-style-profile-plan §7.1）：
 * renderer 读 profile（TTL + 版本缓存），开关关闭或无内容时不注入。
 * 拉取失败不得影响补全链路——返回 null 并以短 TTL 缓存避免连环打 IPC。
 */

const CACHE_TTL_MS = 10 * 60 * 1_000
const FAILURE_TTL_MS = 30 * 1_000

interface CompletionStyleCache {
  at: number
  block: string | null
  ok: boolean
}

let cache: CompletionStyleCache | null = null

export async function loadCompletionWritingStyleBlock(): Promise<string | null> {
  const now = Date.now()
  if (cache && now - cache.at < (cache.ok ? CACHE_TTL_MS : FAILURE_TTL_MS)) {
    return cache.block
  }
  const api = window.nxcore?.writingStyle
  if (!api) return null
  try {
    const [settings, profile] = await Promise.all([api.settings(), api.profile()])
    const block = settings.completionEnabled
      ? profile.injection?.completion ?? null
      : null
    cache = { at: Date.now(), block, ok: true }
    return block
  } catch {
    cache = { at: Date.now(), block: null, ok: false }
    return null
  }
}

/** 开关/指令变更后主动失效（10 分钟 TTL 兜底，不依赖调用方记得调）。 */
export function invalidateCompletionWritingStyleCache(): void {
  cache = null
}
