/** 本地数据源当前真正能进入 EvidenceService 的文件格式。 */
export const LOCAL_PARSEABLE_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.text',
  '.txt',
])

/** Office, compatible OpenDocument, and PDF formats treated as safe documents. */
export const OFFICE_FILE_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.dotm',
  '.rtf',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.xlt',
  '.xltx',
  '.xltm',
  '.xla',
  '.xlam',
  '.ods',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pot',
  '.potx',
  '.potm',
  '.pps',
  '.ppsx',
  '.ppsm',
  '.sldx',
  '.sldm',
  '.odp',
])

/** Gateway-supported formats that a local folder connector may discover. */
export const LOCAL_AUTO_SCAN_EXTENSIONS = new Set([
  ...OFFICE_FILE_EXTENSIONS,
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.csv',
  '.html',
  '.htm',
])

/** Office/OpenDocument and PDF files can enter a batch without confirmation. */
export function isLowRiskFileExtension(extension: string): boolean {
  return OFFICE_FILE_EXTENSIONS.has(extension.toLowerCase())
}

export const HIGH_RISK_FILE_BATCH_THRESHOLD = 100

/** JSON 只允许走内部结构化入口，外部目录扫描永远不读取或入库。 */
export const LOCAL_NEVER_SCAN_EXTENSIONS = new Set(['.json'])

export function isLocalParseableExtension(extension: string): boolean {
  const normalized = extension.toLowerCase()
  return !LOCAL_NEVER_SCAN_EXTENSIONS.has(normalized) && LOCAL_PARSEABLE_EXTENSIONS.has(normalized)
}

/**
 * 扫描时直接剪枝的无意义目录：依赖、构建产物、缓存、测试缓存和工具
 * 生成目录不应进入 EverRoom 的本地知识库。
 */
export const IGNORED_LOCAL_DIRECTORY_NAMES = new Set([
  '.cache',
  '.dart_tool',
  '.git',
  '.gradle',
  '.hg',
  '.idea',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.pnpm-store',
  '.pytest_cache',
  '.svn',
  '.terraform',
  '.tox',
  '.turbo',
  '__pycache__',
  'applications',
  'bin',
  'bower_components',
  'build',
  'cache',
  'caches',
  'coverage',
  'deriveddata',
  'dist',
  'env',
  'logs',
  'node_modules',
  'obj',
  'out',
  'pods',
  'target',
  'temp',
  'tmp',
  'vendor',
  'venv',
])

export function isIgnoredLocalDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_LOCAL_DIRECTORY_NAMES.has(name.toLowerCase())
}
