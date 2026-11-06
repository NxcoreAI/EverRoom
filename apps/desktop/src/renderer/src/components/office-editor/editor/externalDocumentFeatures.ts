/**
 * 外部文档功能入口开关：
 * - feishuExport：已就绪（lark-cli 链路，真机验证通过）
 * - notionExport：官方 ntn CLI 链路，当前仅随 macOS 发行包提供（ntn 无 Windows）
 * - externalImport：OpenConnector 已迁入，导入链路走 runOoHttp 直连本地 runtime
 */
const platform = typeof window !== 'undefined' ? window.nxcore?.platform : undefined

export const externalDocumentFeatures = {
  feishuExport: true,
  notionExport: platform === undefined || platform === 'darwin',
  externalImport: true,
} as const
