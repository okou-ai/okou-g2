import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const sdk = JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json', 'utf8'))
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
mkdirSync('build', { recursive: true })
execFileSync('evenhub', [
  'pack', 'app.json', 'dist', '--sdk-ver', sdk.version,
  '-o', `build/okou-g2-${manifest.version}.ehpk`,
], { stdio: 'inherit' })
