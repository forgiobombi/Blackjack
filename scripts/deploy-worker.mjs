import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const migrationsOnly = process.argv.includes('--migrations-only')
const workerSettings = ['APP_URL', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']
for (const name of [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'D1_DATABASE_ID',
  ...(migrationsOnly ? [] : [...workerSettings, 'AUTH_BRIDGE_KEY']),
]) {
  if (!process.env[name]) throw new Error('Missing deployment setting ' + name)
}
if (!migrationsOnly && !/^[a-f0-9]{64}$/i.test(process.env.AUTH_BRIDGE_KEY))
  throw new Error('AUTH_BRIDGE_KEY must be 32 hex-encoded bytes')
if (
  !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(process.env.D1_DATABASE_ID) ||
  /^0[-0]+$/.test(process.env.D1_DATABASE_ID)
)
  throw new Error('D1_DATABASE_ID must be the real production binding ID')
for (const key of migrationsOnly ? [] : ['APP_URL', 'SUPABASE_URL']) {
  const value = new URL(process.env[key])
  if (value.protocol !== 'https:' || value.hash || value.search || value.username || value.password)
    throw new Error(key + ' must be a canonical HTTPS URL')
}
if (!migrationsOnly && !process.env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_'))
  throw new Error('Provide the Supabase publishable key, not a privileged key')
const config = JSON.parse(readFileSync('apps/worker/wrangler.jsonc', 'utf8'))
config.d1_databases[0].database_id = process.env.D1_DATABASE_ID
if (!migrationsOnly)
  config.vars = Object.fromEntries(workerSettings.map((name) => [name, process.env[name]]))
const deployment = resolve('apps/worker/.dev.vars.deploy-config.json')
const temporary = mkdtempSync(join(tmpdir(), 'royale-worker-'))
const secretFile = join(temporary, 'secrets.json')
function wrangler(...args) {
  const cli = resolve('node_modules/wrangler/bin/wrangler.js')
  const result = spawnSync(process.execPath, [cli, ...args, '-c', deployment], {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Wrangler failed (exit ' + result.status + ')')
}
let configCreated = false
try {
  writeFileSync(deployment, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
  configCreated = true
  wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
  if (!migrationsOnly) {
    writeFileSync(secretFile, JSON.stringify({ AUTH_BRIDGE_KEY: process.env.AUTH_BRIDGE_KEY }), {
      flag: 'wx',
      mode: 0o600,
    })
    wrangler('deploy', '--secrets-file', secretFile)
  }
} finally {
  if (configCreated) rmSync(deployment, { force: true })
  rmSync(temporary, { force: true, recursive: true })
}
