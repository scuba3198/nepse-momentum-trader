import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const formatter = resolve(root, 'node_modules/rescript/cli/rescript.js')

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.resi?$/.test(entry.name) ? [path] : []
  })
}

const unformatted = []
for (const file of sourceFiles(resolve(root, 'src'))) {
  const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const result = spawnSync(process.execPath, [formatter, 'format', '--stdin', '.res'], {
    cwd: root,
    encoding: 'utf8',
    input: source,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  if (source !== result.stdout.replaceAll('\r\n', '\n')) unformatted.push(file)
}

if (unformatted.length > 0) {
  console.error(`ReScript formatting required:\n${unformatted.join('\n')}`)
  process.exit(1)
}

console.log(`ReScript formatting verified (${sourceFiles(resolve(root, 'src')).length} files).`)
