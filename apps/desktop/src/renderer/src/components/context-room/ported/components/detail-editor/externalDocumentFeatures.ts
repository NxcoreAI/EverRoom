/**
 * 外部文档功能入口开关。OpenConnector 正式迁入前：
 * - feishuExport：已就绪（lark-cli 链路，真机验证通过）
 * - notionExport：官方 ntn CLI 链路，当前仅随 macOS 发行包提供（ntn 无 Windows）
 * - externalImport：依赖 OpenConnector 连接，入口先隐藏
 * 恢复入口时改这里的布尔值即可（见 docs/feishu-notion-import-export-implementation.zh-CN.md）。
 */
const platform = typeof window !== 'undefined' ? window.nxcore?.platform : undefined

export const externalDocumentFeatures = {
  feishuExport: true,
  notionExport: platform === undefined || platform === 'darwin',
  externalImport: false,
} as const
