import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const privateVersion = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(privateVersion ?? '') || privateVersion === manifest.version) {
  throw new Error('Pass a separate Private version with npm run pack:release -- x.y.z. app.json supplies the Beta version.')
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
git('fetch', 'origin', 'main')
const commit = git('rev-parse', 'HEAD')
if (commit !== git('rev-parse', 'FETCH_HEAD') || git('status', '--porcelain')) {
  throw new Error('Publish from a clean checkout of the latest pushed main commit.')
}

const npm = (...args) => execFileSync('npm', args, { stdio: 'inherit' })
npm('run', 'build')
const sdk = JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json', 'utf8'))
mkdirSync('build', { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'okou-g2-release-'))
try {
  const privateManifest = join(scratch, 'app.json')
  writeFileSync(privateManifest, JSON.stringify({ ...manifest, version: privateVersion }))
  for (const [channel, version, source] of [
    ['private', privateVersion, privateManifest],
    ['beta', manifest.version, 'app.json'],
  ]) {
    const out = `build/okou-g2-${version}-${channel}.ehpk`
    npm('exec', '--yes', '--package=@evenrealities/evenhub-cli@0.2.0', '--',
      'evenhub', 'pack', source, 'dist', '--sdk-ver', sdk.version, '-o', out)
  }
  console.log(`Packed Private ${privateVersion} and Beta ${manifest.version} from main ${commit}.`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
