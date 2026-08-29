import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

// gateway 密码箱主密钥已改为代码内置默认（apps/gateway secret-store 的
// DEFAULT_SECRET_STORE_MASTER_KEY，NXCORE_SECRET_STORE_KEY 可经环境变量/.env 覆盖），
// 不再经 safeStorage/Keychain 解锁，也就不再需要登录后重启网关注入密钥。
// 这里只清理旧机制遗留：wrapped key 文件删除；旧密文用的是每安装一份的随机密钥，
// 换固定密钥后无法解开，挪走留档（gateway 解到坏密文会直接启动失败），密钥需重填一次。
export async function cleanupLegacyGatewaySecretKey(securityDirectory: string): Promise<void> {
  const wrappedKeyPath = join(securityDirectory, 'gateway-master-key.json')
  try {
    await rm(wrappedKeyPath, { force: true })
    const credentialsPath = join(securityDirectory, 'credentials.enc')
    try {
      await rename(credentialsPath, `${credentialsPath}.stale-${Date.now()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // 目录空了就顺手删掉，避免留下空的 security/。
    const remaining = await readdir(securityDirectory)
    if (remaining.length === 0) await rm(securityDirectory, { recursive: true, force: true })
  } catch (error) {
    console.warn('Legacy gateway secret files left in place.', error)
  }
}
