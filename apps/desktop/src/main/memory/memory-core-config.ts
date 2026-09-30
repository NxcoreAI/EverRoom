import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * MemoryCore 调度参数下发（状态/参考分流 2026-09-24 定案，第 2 层）。
 *
 * fork 的 L1/L2 调度旋钮（everyNConversations 等）没有专用环境变量，只有
 * tdai-gateway.yaml 配置文件查找路径（TDAI_GATEWAY_CONFIG > CWD > dataDir；
 * supervisor 的 spawn cwd 即 dataDir，二者同一路径）。这里每次启动覆写
 * dataDir 下的 tdai-gateway.yaml；env 键（端口/apiKey/LLM/embedding）优先级
 * 高于文件，不受影响。手工改该文件会在下次启动被覆盖——长期调整改这里。
 *
 * 只写偏离 fork 默认值的键：
 * - everyNConversations 5 → 8：记忆收窄为状态型后体量下降，L1 蒸馏降频
 *   （稳态约省 40% 次蒸馏调用）；warm-up 保持默认开启，新会话冷启动不受影响。
 */
const GATEWAY_CONFIG_YAML = [
  '# EverRoom supervisor 下发（每次启动覆写；env 键优先级更高）',
  'memory:',
  '  pipeline:',
  '    everyNConversations: 8',
  '',
].join('\n')

export async function writeMemoryCoreGatewayConfig(dataDir: string): Promise<string> {
  const configPath = join(dataDir, 'tdai-gateway.yaml')
  await writeFile(configPath, GATEWAY_CONFIG_YAML, 'utf8')
  return configPath
}
