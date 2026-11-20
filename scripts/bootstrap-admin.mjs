import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const id = args[0]
if (!id || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
  throw new Error('Pass the verified Supabase user UUID')
const local = args.includes('--local')
if (!local && !args.includes('--remote')) throw new Error('Choose --local or --remote')
const now = Date.now()
const sql = [
  "UPDATE profiles SET role='superadmin' WHERE id='" +
    id.toLowerCase() +
    "' AND suspended=0 AND NOT EXISTS(SELECT 1 FROM profiles WHERE role='superadmin')",
  "INSERT INTO audit_logs(id,actor_id,action,target,created_at) SELECT 'bootstrap:" +
    id.toLowerCase() +
    "',id,'bootstrap',id," +
    now +
    " FROM profiles WHERE id='" +
    id.toLowerCase() +
    "' AND role='superadmin' ON CONFLICT DO NOTHING",
  "SELECT id,username,role FROM profiles WHERE id='" + id.toLowerCase() + "'",
].join(';')
const cli = resolve('node_modules/wrangler/bin/wrangler.js')
const target = local ? 'DB' : process.env.D1_DATABASE_ID
if (!target || (!local && !/^[a-f0-9-]{36}$/i.test(target)))
  throw new Error('Set D1_DATABASE_ID for a remote bootstrap')
const mode = local ? '--local' : '--remote'
const command = [cli, 'd1', 'execute', target, mode, '--command', sql]
if (local) command.push('-c', 'apps/worker/wrangler.jsonc')
const result = spawnSync(process.execPath, command, { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
