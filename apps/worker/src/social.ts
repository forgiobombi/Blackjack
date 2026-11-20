import { Fault, object, option, username, uuid } from '../../../packages/protocol/validation.ts'
import type { Avatar } from '../../../packages/protocol/types.ts'
import type { Env, Principal } from './env.ts'
import { json } from './http.ts'
import { callTable } from './tables.ts'

type Friend = {
  id: string
  username: string
  name: string
  avatar: Avatar
  requestedBy: string
  status: 'requested' | 'friends'
  lastPlayed?: number
}
export async function friends(env: Env, actor: Principal) {
  const now = Date.now()
  const [rows, blocks, invites, shared] = await env.DB.batch([
    env.DB.prepare(
      'SELECT p.id,p.username,p.display_name AS name,p.avatar,r.requested_by AS requestedBy,r.status,' +
        '(SELECT max(a.finished_at) FROM round_history a JOIN round_history b ON b.round_id=a.round_id AND b.user_id=p.id WHERE a.user_id=?) AS lastPlayed ' +
        'FROM relationships r JOIN profiles p ON p.id=CASE WHEN r.low_id=? THEN r.high_id ELSE r.low_id END WHERE (r.low_id=? OR r.high_id=?) AND p.suspended=0 ORDER BY r.updated_at DESC LIMIT 50',
    ).bind(actor.id, actor.id, actor.id, actor.id),
    env.DB.prepare(
      'SELECT p.id,p.username,p.display_name AS name FROM blocks b JOIN profiles p ON p.id=b.target_id WHERE b.actor_id=? LIMIT 50',
    ).bind(actor.id),
    env.DB.prepare(
      'SELECT i.id,f.secret AS token,p.display_name AS name,t.settings,i.expires_at AS expiresAt FROM friend_invites f JOIN table_invites i ON i.id=f.id ' +
        "JOIN profiles p ON p.id=i.creator_id JOIN game_tables t ON t.id=i.table_id WHERE f.recipient_id=? AND i.revoked=0 AND i.expires_at>? AND i.uses<i.max_uses AND t.status='open' AND t.join_enabled=1 " +
        'AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.actor_id=? AND b.target_id=i.creator_id) OR (b.actor_id=i.creator_id AND b.target_id=?)) ORDER BY i.created_at DESC LIMIT 25',
    ).bind(actor.id, now, actor.id, actor.id),
    env.DB.prepare(
      "SELECT t.id FROM game_tables t JOIN table_memberships m ON m.table_id=t.id WHERE t.status='open' AND m.user_id=? ORDER BY m.joined_at DESC LIMIT 5",
    ).bind(actor.id),
  ])
  const people = rows.results as Friend[]
  const activeTables = shared.results as { id: string }[]
  const incoming = invites.results as {
    id: string
    token: string
    name: string
    settings: string
    expiresAt: number
  }[]
  const accepted = people
    .filter((person) => person.status === 'friends')
    .map((person) => person.id)
    .slice(0, 25)
  const online = new Map<string, string>()
  if (accepted.length)
    await Promise.all(
      activeTables.map(async (item) => {
        try {
          const response = await callTable(env, String(item.id), 'presence', { users: accepted })
          if (response.ok)
            for (const id of (await response.json<{ online: string[] }>()).online)
              online.set(id, String(item.id))
        } catch {
          /* Offline or unavailable presence stays unknown. */
        }
      }),
    )
  return json({
    friends: people.map((person) => ({ ...person, tableId: online.get(person.id) })),
    blocked: blocks.results,
    invitations: incoming.map((item) => ({
      id: item.id,
      token: item.token,
      name: item.name,
      table: JSON.parse(String(item.settings)).name,
      expiresAt: item.expiresAt,
    })),
  })
}

export async function relationship(env: Env, actor: Principal, input: unknown) {
  const data = object(input)
  const action = option(data.action, ['request', 'accept', 'decline', 'remove', 'block', 'unblock'])
  const person =
    action === 'request'
      ? await env.DB.prepare('SELECT id FROM profiles WHERE username=? AND suspended=0')
          .bind(username(data.username))
          .first<string>('id')
      : uuid(data.user)
  if (!person || person === actor.id) throw new Fault('not_found', 404)
  const [low, high] = [actor.id, person].sort()
  const db = env.DB
  const now = Date.now()
  switch (action) {
    case 'request': {
      const result = await db
        .prepare(
          "INSERT INTO relationships(low_id,high_id,requested_by,status,updated_at) SELECT ?,?,?,'requested',? WHERE " +
            'NOT EXISTS(SELECT 1 FROM blocks WHERE (actor_id=? AND target_id=?) OR (actor_id=? AND target_id=?)) ON CONFLICT DO NOTHING RETURNING low_id',
        )
        .bind(low, high, actor.id, now, actor.id, person, person, actor.id)
        .first()
      if (!result) throw new Fault('friend_unavailable', 409)
      break
    }
    case 'accept': {
      const result = await db
        .prepare(
          "UPDATE relationships SET status='friends',updated_at=? WHERE low_id=? AND high_id=? AND requested_by!=? AND status='requested' RETURNING low_id",
        )
        .bind(now, low, high, actor.id)
        .first()
      if (!result) throw new Fault('friend_unavailable', 409)
      break
    }
    case 'decline':
      await db
        .prepare("DELETE FROM relationships WHERE low_id=? AND high_id=? AND status='requested'")
        .bind(low, high)
        .run()
      break
    case 'remove':
      await db
        .prepare('DELETE FROM relationships WHERE low_id=? AND high_id=?')
        .bind(low, high)
        .run()
      break
    case 'block':
      await db.batch([
        db
          .prepare('INSERT INTO blocks SELECT ?,id FROM profiles WHERE id=? ON CONFLICT DO NOTHING')
          .bind(actor.id, person),
        db.prepare('DELETE FROM relationships WHERE low_id=? AND high_id=?').bind(low, high),
        db
          .prepare(
            'UPDATE table_invites SET revoked=1 WHERE (creator_id=? AND recipient_id=?) OR (creator_id=? AND recipient_id=?)',
          )
          .bind(actor.id, person, person, actor.id),
      ])
      break
    case 'unblock':
      await db
        .prepare('DELETE FROM blocks WHERE actor_id=? AND target_id=?')
        .bind(actor.id, person)
        .run()
      break
  }
  return json({ ok: true })
}
