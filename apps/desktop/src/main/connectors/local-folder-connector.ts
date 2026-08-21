import { createReadStream, watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  Connector,
  ConnectorConnection,
  ConnectorItem,
  ConnectorScanResult,
  ConnectorSubscription,
} from './types'
import {
  isIgnoredLocalDirectory,
  LOCAL_PARSEABLE_EXTENSIONS,
} from '../file-format-policy'

export interface LocalFolderConfig {
  rootPath: string
}

export class LocalFolderConnector implements Connector<LocalFolderConfig> {
  readonly kind = 'local-folder' as const
  readonly capabilities = ['pull', 'incremental', 'watch'] as const

  constructor(private readonly scanExtensions: ReadonlySet<string> = LOCAL_PARSEABLE_EXTENSIONS) {}

  getConnectionKey(config: LocalFolderConfig): string {
    return resolve(config.rootPath)
  }

  async scan(
    connection: ConnectorConnection<LocalFolderConfig>,
  ): Promise<ConnectorScanResult> {
    const items: ConnectorItem[] = []
    let failed = 0

    const visit = async (directory: string, isRoot = false): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (isRoot) throw error
        failed += 1
        return
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory() && isIgnoredLocalDirectory(entry.name)) continue
        const absolutePath = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath)
          continue
        }
        if (!entry.isFile()) continue

        const extension = extname(entry.name).toLowerCase()
        if (!this.scanExtensions.has(extension)) continue

        try {
          const info = await stat(absolutePath)
          const itemPath = relative(connection.config.rootPath, absolutePath)
          items.push({
            remoteId: info.ino > 0 ? `${info.dev}:${info.ino}` : itemPath,
            title: basename(itemPath),
            uri: pathToFileURL(absolutePath).toString(),
            path: itemPath,
            extension,
            byteSize: info.size,
            modifiedAt: info.mtime.toISOString(),
            openContent: () => createReadStream(absolutePath),
          })
        } catch {
          failed += 1
        }
      }
    }

    await visit(connection.config.rootPath, true)
    return { items, failed }
  }

  watch(
    connection: ConnectorConnection<LocalFolderConfig>,
    onChange: () => void,
  ): ConnectorSubscription | null {
    try {
      const watcher = watch(connection.config.rootPath, { recursive: true }, onChange)
      watcher.on('error', () => watcher.close())
      return watcher
    } catch {
      return null
    }
  }

  resolveLocalPath(
    connection: ConnectorConnection<LocalFolderConfig>,
    itemPath: string,
  ): string {
    const rootPath = resolve(connection.config.rootPath)
    const localPath = resolve(rootPath, itemPath)
    if (localPath !== rootPath && !localPath.startsWith(`${rootPath}${sep}`)) {
      throw new Error('文件位置超出已授权目录。')
    }
    return localPath
  }
}
