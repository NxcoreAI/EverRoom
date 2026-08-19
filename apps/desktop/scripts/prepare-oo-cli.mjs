import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { resolveExecutablePath } = require('@oomol-lab/oo-cli')
const executableName = process.platform === 'win32' ? 'oo.exe' : 'oo'
const source = resolveExecutablePath()
if (!existsSync(source)) throw new Error('oo CLI platform executable was not installed')

const targetDirectory = join(dirname(import.meta.dirname), 'build', 'oo', `${process.platform}-${process.arch}`)
const target = join(targetDirectory, executableName)
await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)
console.log(`Prepared oo CLI: ${target}`)
