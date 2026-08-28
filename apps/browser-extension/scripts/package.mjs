import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(directory, 'manifest.json')
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
if (!manifest.version || !manifest.name) throw new Error('manifest.json must contain name and version')
if (!existsSync(resolve(directory, 'background.js')) || !existsSync(resolve(directory, 'popup.html'))) {
  throw new Error('browser extension source is incomplete')
}

const outputDirectory = resolve(directory, '../../release')
const output = resolve(outputDirectory, `EverRoom-browser-extension-v${manifest.version}.zip`)
await mkdir(outputDirectory, { recursive: true })
await rm(output, { force: true })
await new Promise((resolvePromise, reject) => {
  const child = spawn('zip', ['-qr', output, 'manifest.json', 'background.js', 'content-script.js', 'i18n.js', 'popup-state.js', 'popup.html', 'popup.js', 'vendor', 'icons'], { cwd: directory, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`zip exited with code ${code}`)))
})
console.log(output)
