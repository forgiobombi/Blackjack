import type { Env, Principal } from './env.ts'
import {
  Fault,
  integer,
  object,
  option,
  parseSettings,
  string,
  uuid,
} from '../../../packages/protocol/validation.ts'
import { json } from './http.ts'
import { callTable, canManage, summary } from './tables.ts'
import type { TableRow } from './tables.ts'
import { ledgerStatement } from './wallet.ts'

export function requireSuper(actor: Principal) {
  if (actor.role !== 'superadmin') throw new Fault('forbidden', 403)
}

export async function adminOverview(env: Env, actor: Principal) {
  if (!canManage(actor)) throw new Fault('forbidden', 403)
  const superAdmin = actor.role === 'superadmin'
  const id = superAdmin ? null : actor.id
  const tables = await env.DB.prepare(
    'SELECT * FROM game_tables WHERE (? IS NULL OR owner_id=?) ORDER BY created_at DESC LIMIT 40',
  )
    .bind(id, id)
    .all<TableRow>()
  const active = tables.results.filter((table) => table.status !== 'closed').slice(0, 16)
  const [counts, statuses] = await Promise.all([
    env.DB.prepare(
      'SELECT (SELECT count(*) FROM profiles WHERE ? IS NULL) AS users,(SELECT count(*) FROM replays r JOIN game_tables t ON t.id=r.table_id WHERE (? IS NULL OR t.owner_id=?)) AS rounds,' +
        "(SELECT count(*) FROM game_tables WHERE status!='closed' AND (? IS NULL OR owner_id=?)) AS active,(SELECT max(closed_at) FROM game_tables WHERE (? IS NULL OR owner_id=?)) AS lastCleanup",
    )
      .bind(id, id, id, id, id, id, id)
      .first(),
    Promise.all(
      active.map(async (table) => {
        try {
          const response = await callTable(env, table.id, 'status', {})
          return {
            id: table.id,
            ...(response.ok
              ? await response.json<Record<string, unknown>>()
              : { unavailable: true }),
          }
        } catch {
          return { id: table.id, unavailable: true }
        }
      }),
    ),
  ])
  return json({
    ...counts,
    tables: tables.results.map(summary),
    statuses,
    sampled: active.length,
    auth: true,
    database: true,
  })
}

export async function auditLogs(env: Env, actor: Principal) {
  if (!canManage(actor)) throw new Fault('forbidden', 403)
  const id = actor.role === 'superadmin' ? null : actor.id
  const rows = await env.DB.prepare(
    'SELECT a.id,a.actor_id AS actor,a.action,a.target,a.metadata,a.created_at AS at,p.display_name AS name FROM audit_logs a LEFT JOIN profiles p ON p.id=a.actor_id WHERE (? IS NULL OR a.actor_id=? OR EXISTS(SELECT 1 FROM game_tables t WHERE t.id=a.target AND t.owner_id=?)) ORDER BY a.created_at DESC LIMIT 70',
  )
    .bind(id, id, id)
    .all()
  return json({ logs: rows.results })
}

export async function adminUsers(env: Env, actor: Principal, query: string) {
  requireSuper(actor)
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20)
  const rows = await env.DB.prepare(
    'SELECT p.id,p.username,p.display_name AS name,p.role,p.suspended,w.balance FROM profiles p JOIN wallets w ON w.user_id=p.id WHERE substr(p.username,1,length(?))=? ORDER BY p.created_at DESC LIMIT 40',
  )
    .bind(normalized, normalized)
    .all()
  return json({ users: rows.results })
}

export async function updateUser(env: Env, actor: Principal, user: string, input: unknown) {
  requireSuper(actor)
  const data = object(input)
  const id = uuid(data.id)
  const action = option(data.action, ['promote', 'demote', 'suspend', 'restore', 'adjust'])
  const row = await env.DB.prepare('SELECT role FROM profiles WHERE id=?')
    .bind(user)
    .first<string>('role')
  if (!row) throw new Fault('not_found', 404)
  if (row === 'superadmin' && action !== 'adjust') throw new Fault('forbidden', 403)
  const db = env.DB
  const now = Date.now()
  const auditId = 'account:' + id
  const prior = await db.prepare('SELECT id FROM audit_logs WHERE id=?').bind(auditId).first()
  if (prior) return json({ ok: true })
  let update: D1PreparedStatement
  let metadata: object = {}
  if (action === 'adjust') {
    const chips = integer(data.chips, -100_000, 100_000)
    const reason = string(data.reason, 4, 140)
    if (!chips) throw new Fault('invalid')
    metadata = { chips, reason }
    update = ledgerStatement(db, {
      id: 'admin:' + id,
      user,
      table: null,
      round: null,
      delta: chips * 10,
      kind: 'adjustment',
      at: now,
    })
  } else {
    update =
      action === 'promote' || action === 'demote'
        ? db
            .prepare("UPDATE profiles SET role=? WHERE id=? AND role!='superadmin'")
            .bind(action === 'promote' ? 'admin' : 'player', user)
        : db
            .prepare("UPDATE profiles SET suspended=? WHERE id=? AND role!='superadmin'")
            .bind(Number(action === 'suspend'), user)
  }
  await db
    .batch([
      update,
      db
        .prepare(
          'INSERT INTO audit_logs(id,actor_id,action,target,metadata,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(auditId, actor.id, action, user, JSON.stringify(metadata), now),
    ])
    .catch((error: unknown) => {
      if (
        action === 'adjust' &&
        error instanceof Error &&
        error.message.includes('CHECK constraint')
      )
        throw new Fault('balance', 409)
      throw error
    })
  if (action === 'suspend') {
    const tables = await db
      .prepare(
        "SELECT t.id FROM table_memberships m JOIN game_tables t ON t.id=m.table_id WHERE m.user_id=? AND t.status!='closed' LIMIT 16",
      )
      .bind(user)
      .all<{ id: string }>()
    await Promise.allSettled(
      tables.results.map((table) => callTable(env, table.id, 'disconnect', { user })),
    )
  }
  return json({ ok: true })
}

export async function settings(env: Env, actor: Principal, input?: unknown) {
  requireSuper(actor)
  if (input === undefined) {
    const row = await env.DB.prepare(
      'SELECT starting_chips AS starting,refill_chips AS refill,refill_below AS below,refill_minutes AS minutes,table_defaults AS defaults FROM system_settings',
    ).first()
    return json({ ...row, defaults: row?.defaults ? JSON.parse(String(row.defaults)) : null })
  }
  const x = object(input)
  const starting = integer(x.starting, 100, 100_000)
  const refill = integer(x.refill, 100, 10_000)
  const below = integer(x.below, 0, 10_000)
  const minutes = integer(x.minutes, 60, 10_080)
  const defaults = x.defaults ? JSON.stringify(parseSettings(x.defaults)) : null
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE system_settings SET starting_chips=?,refill_chips=?,refill_below=?,refill_minutes=?,table_defaults=?',
    ).bind(starting, refill, below, minutes, defaults),
    env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_id,action,target,metadata,created_at) VALUES(?,?,'system_settings','system',?,?)",
    ).bind(
      crypto.randomUUID(),
      actor.id,
      JSON.stringify({ starting, refill, below, minutes, defaults: Boolean(defaults) }),
      Date.now(),
    ),
  ])
  return json({ ok: true })
}

export async function reports(env: Env, actor: Principal) {
  if (!canManage(actor)) throw new Fault('forbidden', 403)
  const id = actor.role === 'superadmin' ? null : actor.id
  const items = await env.DB.prepare(
    'SELECT r.id,r.table_id AS tableId,r.target,r.excerpt,r.reason,r.status,r.created_at AS at,p.display_name AS name FROM user_reports r JOIN game_tables t ON t.id=r.table_id JOIN profiles p ON p.id=r.target ' +
      'WHERE (? IS NULL OR t.owner_id=?) ORDER BY r.status,r.created_at DESC LIMIT 50',
  )
    .bind(id, id)
    .all()
  return json({ reports: items.results })
}

export async function reviewReport(env: Env, actor: Principal, id: string) {
  if (!canManage(actor)) throw new Fault('forbidden', 403)
  const owner = actor.role === 'superadmin' ? null : actor.id
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE user_reports SET status='reviewed' WHERE id=? AND status='open' AND EXISTS(SELECT 1 FROM game_tables t WHERE t.id=table_id AND (? IS NULL OR t.owner_id=?))",
    ).bind(id, owner, owner),
    env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_id,action,target,created_at) SELECT ?,?,'report_review',?,? WHERE changes()=1",
    ).bind(crypto.randomUUID(), actor.id, id, Date.now()),
  ])
  return json({ ok: true })
}
