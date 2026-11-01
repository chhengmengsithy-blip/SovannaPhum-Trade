import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outdir = resolve(root, 'dist-server')

await rm(outdir, { recursive: true, force: true })

await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  sourcesContent: true,
  treeShaking: true,
  logLevel: 'info',
})

console.log('Backend production bundle: dist-server/index.mjs')
