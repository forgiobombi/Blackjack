import { secureInt } from '../../../packages/engine/cards.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import type { TableSummary } from '../../../packages/protocol/types.ts'
import {
  Fault,
  integer,
  object,
  option,
  parseSettings,
  string,
  uuid,
} from '../../../packages/protocol/validation.ts'
import type { Env, Principal } from './env.ts'
import { digest, json, limit, token } from './http.ts'

export type TableRow = {
  id: string
  owner_id: string
  settings: string
  status: 'open' | 'closing' | 'closed'
  join_enabled: number
  created_at: number
  closed_at?: number
  close_reason?: string
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PROTOCOL = 'royale.v1'

export function summary(row: TableRow): TableSummary {
  return {
    id: row.id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    settings: JSON.parse(row.settings),
    status: row.status,
  }
}

export function canManage(actor: Principal, owner?: string) {
  return (
    actor.role === 'superadmin' ||
    (actor.role === 'admin' && (owner === undefined || owner === actor.id))
  )
}

export async function tableRow(env: Env, id: string): Promise<TableRow> {
  const row = await env.DB.prepare('SELECT * FROM game_tables WHERE id=?')
    .bind(id)
    .first<TableRow>()
  if (!row) throw new Fault('not_found', 404)
  return row
}

export async function member(env: Env, table: TableRow, actor: Principal) {
  const membership = await env.DB.prepare(
    'SELECT m.user_id, coalesce(r.banned,0) AS banned FROM game_tables t LEFT JOIN table_memberships m ON m.table_id=t.id AND m.user_id=? ' +
      'LEFT JOIN table_restrictions r ON r.table_id=t.id AND r.user_id=? WHERE t.id=?',
  )
    .bind(actor.id, actor.id, table.id)
    .first<{ user_id: string | null; banned: number }>()
  if (membership?.banned) throw new Fault('banned', 403)
  if (!membership?.user_id && !canManage(actor, table.owner_id)) throw new Fault('membership', 403)
}

function stub(env: Env, id: string) {
  return env.TABLES.get(env.TABLES.idFromName(id))
}

export async function callTable(env: Env, id: string, path: string, payload: unknown) {
  return stub(env, id).fetch('https://table.internal/' + path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  })
}

export function webSocket(env: Env, id: string, request: Request) {
  const offered =
    request.headers
      .get('Sec-WebSocket-Protocol')
      ?.split(',')
      .map((item) => item.trim()) ?? []
  const credential = offered.find((item) => /^ticket\.[A-Za-z0-9_-]{43}$/.test(item))
  if (
    !offered.includes(PROTOCOL) ||
    !credential ||
    request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
  )
    throw new Fault('auth_required', 401)
  return stub(env, id).fetch('https://table.internal/connect', {
    headers: { Upgrade: 'websocket', 'X-Table-Ticket': credential.slice(7) },
  })
}

export async function browseTables(env: Env, actor: Principal) {
  const rows = await env.DB.prepare(
    "SELECT t.* FROM game_tables t WHERE t.status!='closed' AND (t.private=0 OR t.owner_id=? OR EXISTS (SELECT 1 FROM table_memberships m WHERE m.table_id=t.id AND m.user_id=?) OR ?) " +
      'AND NOT EXISTS (SELECT 1 FROM table_restrictions r WHERE r.table_id=t.id AND r.user_id=? AND r.banned=1) ORDER BY t.created_at DESC LIMIT 40',
  )
    .bind(actor.id, actor.id, Number(actor.role === 'superadmin'), actor.id)
    .all<TableRow>()
  return json({ tables: rows.results.map(summary) })
}

export async function createTable(env: Env, actor: Principal, input: unknown) {
  if (!canManage(actor)) throw new Fault('forbidden', 403)
  const data = object(input)
  const id = uuid(data.id)
  const count = await env.DB.prepare(
    "SELECT count(*) AS count FROM game_tables WHERE owner_id=? AND status!='closed' AND id!=?",
  )
    .bind(actor.id, id)
    .first<number>('count')
  if ((count ?? 0) >= 8) throw new Fault('table_limit', 409)
  return callTable(env, id, 'init', { id, actor, settings: parseSettings(data.settings) })
}

export async function invite(env: Env, actor: Principal, table: TableRow, input: unknown) {
  const data = object(input)
  const managed = canManage(actor, table.owner_id)
  const config = summary(table).settings
  const recipient = data.recipient === undefined ? null : uuid(data.recipient)
  const expiry = integer(data.minutes ?? 120, 5, 1440)
  const maxUses = recipient ? 1 : integer(data.uses ?? 10, 1, 32)
  await member(env, table, actor)
  if (!managed && (!config.friendInvites || !recipient)) throw new Fault('forbidden', 403)
  if (table.status !== 'open' || !table.join_enabled) throw new Fault('closed', 409)
  if (recipient) {
    const friends = await env.DB.prepare(
      "SELECT 1 FROM relationships WHERE low_id=min(?,?) AND high_id=max(?,?) AND status='friends' AND NOT EXISTS(" +
        'SELECT 1 FROM blocks WHERE (actor_id=? AND target_id=?) OR (actor_id=? AND target_id=?))',
    )
      .bind(actor.id, recipient, actor.id, recipient, actor.id, recipient, recipient, actor.id)
      .first()
    if (!friends) throw new Fault('forbidden', 403)
  }
  const id = crypto.randomUUID()
  const secret = token(24)
  const code = Array.from({ length: 8 }, () => ALPHABET[secureInt(ALPHABET.length)]).join('')
  const [secretHash, codeHash] = await Promise.all([
    digest('link:' + secret),
    digest('code:' + code),
  ])
  const now = Date.now()
  const expiresAt = now + expiry * 60_000
  const statement = env.DB.prepare(
    'INSERT INTO table_invites (id,table_id,creator_id,token_hash,code_hash,recipient_id,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).bind(id, table.id, actor.id, secretHash, codeHash, recipient, maxUses, expiresAt, now)
  if (recipient) {
    await env.DB.batch([
      statement,
      env.DB.prepare('INSERT INTO friend_invites VALUES(?,?,?)').bind(id, recipient, secret),
    ])
  } else {
    await statement.run()
  }
  return json({ id, token: secret, code, expiresAt }, 201)
}

export async function listInvitations(env: Env, actor: Principal, table: TableRow) {
  if (!canManage(actor, table.owner_id)) throw new Fault('forbidden', 403)
  const rows = await env.DB.prepare(
    'SELECT id, max_uses AS maxUses, uses, expires_at AS expiresAt, revoked, created_at AS createdAt FROM table_invites WHERE table_id=? ORDER BY created_at DESC LIMIT 40',
  )
    .bind(table.id)
    .all()
  return json({ invitations: rows.results })
}

export async function revokeInvite(env: Env, actor: Principal, table: TableRow, id: string) {
  if (!canManage(actor, table.owner_id)) throw new Fault('forbidden', 403)
  const result = await env.DB.batch([
    env.DB.prepare(
      'UPDATE table_invites SET revoked=1 WHERE id=? AND table_id=? AND revoked=0',
    ).bind(id, table.id),
    env.DB.prepare(
      "INSERT INTO audit_logs(id,actor_id,action,target,created_at) SELECT ?,?,'invite_revoke',?,? WHERE changes()=1",
    ).bind(crypto.randomUUID(), actor.id, id, Date.now()),
  ])
  return json({ ok: true, revoked: result[0].meta.changes > 0 })
}

async function findAdmission(
  env: Env,
  actor: Principal,
  data: Record<string, unknown>,
  ip: string,
) {
  if (data.invite === undefined) {
    const table = await tableRow(env, uuid(data.tableId))
    const joined = await env.DB.prepare(
      'SELECT 1 FROM table_memberships WHERE table_id=? AND user_id=?',
    )
      .bind(table.id, actor.id)
      .first()
    if (summary(table).settings.private && !joined && !canManage(actor, table.owner_id))
      throw new Fault('membership', 403)
    return { table, id: null, joined: Boolean(joined) }
  }
  await Promise.all([
    limit(env.JOIN_LIMIT, 'join-user:' + actor.id),
    limit(env.JOIN_LIMIT, 'join-ip:' + ip),
  ])
  const input = string(data.invite, 8, 32)
  // Hash namespaces separate random URL secrets from manually entered codes.
  if (!/^[\w-]{32}$/.test(input) && !/^[A-Z2-9]{8}$/i.test(input))
    throw new Fault('invite_invalid', 404)
  const isCode = input.length === 8
  const hash = await digest(isCode ? 'code:' + input.toUpperCase() : 'link:' + input)
  const row = await env.DB.prepare(
    'SELECT t.*, i.id AS invite_id, i.expires_at,i.revoked,i.uses,i.max_uses,' +
      'EXISTS(SELECT 1 FROM table_memberships m WHERE m.table_id=t.id AND m.user_id=?) AS joined ' +
      'FROM table_invites i JOIN game_tables t ON t.id=i.table_id WHERE ' +
      (isCode ? 'i.code_hash=?' : 'i.token_hash=?') +
      ' AND (i.recipient_id IS NULL OR i.recipient_id=?)',
  )
    .bind(actor.id, hash, actor.id)
    .first<
      TableRow & {
        invite_id: string
        expires_at: number
        revoked: number
        uses: number
        max_uses: number
        joined: number
      }
    >()
  if (!row) throw new Fault('invite_invalid', 404)
  if (row.status !== 'open' || !row.join_enabled) throw new Fault('closed', 409)
  if (row.revoked) throw new Fault('invite_revoked', 410)
  if (row.expires_at <= Date.now()) throw new Fault('invite_expired', 410)
  if (!row.joined && row.uses >= row.max_uses) throw new Fault('invite_used', 410)
  return { table: row, id: row.invite_id, joined: Boolean(row.joined) }
}

export async function admit(
  env: Env,
  actor: Principal,
  input: unknown,
  ip: string,
  preview: boolean,
) {
  const { table, id, joined } = await findAdmission(env, actor, object(input), ip)
  if (
    table.status !== 'open' ||
    (!table.join_enabled && !joined && !canManage(actor, table.owner_id))
  )
    throw new Fault('closed', 409)
  if (
    (await env.DB.prepare('SELECT banned FROM table_restrictions WHERE table_id=? AND user_id=?')
      .bind(table.id, actor.id)
      .first<number>('banned')) === 1
  )
    throw new Fault('banned', 403)
  const capacity = await callTable(env, table.id, 'preview', {
    actor,
    existing: joined || canManage(actor, table.owner_id),
  })
  if (!capacity.ok) return capacity
  const info = await capacity.json<{ seats: number; canSeat: boolean; spectators: number }>()
  if (preview) return json({ table: summary(table), ...info, joined })
  if (!joined) {
    const now = Date.now()
    const result = await env.DB.prepare(
      'INSERT INTO table_memberships(table_id,user_id,joined_at,sponsor) ' +
        'SELECT t.id,?,?,? FROM game_tables t WHERE t.id=? AND t.status=? AND (t.join_enabled=1 OR ?) AND ' +
        'NOT EXISTS(SELECT 1 FROM table_restrictions r WHERE r.table_id=t.id AND r.user_id=? AND r.banned=1) AND ' +
        '(? IS NULL OR EXISTS(SELECT 1 FROM table_invites i WHERE i.id=? AND i.table_id=t.id AND i.revoked=0 AND i.expires_at>? AND i.uses<i.max_uses AND (i.recipient_id IS NULL OR i.recipient_id=?))) ' +
        'ON CONFLICT DO NOTHING RETURNING user_id',
    )
      .bind(
        actor.id,
        now,
        id,
        table.id,
        'open',
        Number(canManage(actor, table.owner_id)),
        actor.id,
        id,
        id,
        now,
        actor.id,
      )
      .first()
    if (
      !result &&
      !(await env.DB.prepare('SELECT 1 FROM table_memberships WHERE table_id=? AND user_id=?')
        .bind(table.id, actor.id)
        .first())
    )
      throw new Fault('invite_invalid', 409)
  }
  return json({ table: summary(table) })
}

export async function tableAdmin(env: Env, actor: Principal, table: TableRow, input: unknown) {
  if (!canManage(actor, table.owner_id)) throw new Fault('forbidden', 403)
  const raw = object(input)
  const action = option(raw.action, [
    'start',
    'pause',
    'resume',
    'close',
    'settings',
    'joining',
    'remove',
    'ban',
    'unban',
    'mute',
    'unmute',
  ])
  const id = uuid(raw.id)
  const target = ['remove', 'ban', 'unban', 'mute', 'unmute'].includes(action)
    ? uuid(raw.user)
    : undefined
  if (target === table.owner_id) throw new Fault('forbidden', 403)
  const settings: TableSettings | undefined =
    action === 'settings' ? parseSettings(raw.settings) : undefined
  const enabled = action === 'joining' ? option(raw.enabled, [0, 1]) : undefined
  return callTable(env, table.id, 'admin', { actor, action, id, target, settings, enabled })
}
