/**
 * 外部文档功能入口开关。OpenConnector 正式迁入前：
 * - feishuExport：已就绪（lark-cli 链路，真机验证通过）
 * - notionExport / externalImport：依赖 OpenConnector 连接，入口先隐藏，
 *   迁入完成后置 true 即恢复（代码链路均已实现，见 docs/feishu-notion-import-export-implementation.zh-CN.md）。
 */
export const externalDocumentFeatures = {
  feishuExport: true,
  notionExport: false,
  externalImport: false,
} as const
