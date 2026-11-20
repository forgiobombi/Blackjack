import {
  Fault,
  object,
  parseAppearance,
  parsePreferences,
  string,
  uuid,
} from '../../../packages/protocol/validation.ts'
import type { ChatMessage } from '../../../packages/protocol/types.ts'
import {
  adminOverview,
  adminUsers,
  auditLogs,
  reports,
  reviewReport,
  settings,
  updateUser,
} from './admin.ts'
import {
  ensureProfile,
  exchange,
  handleAuthPage,
  identity,
  logout,
  principal,
  refresh,
} from './auth.ts'
import type { Env } from './env.ts'
import { history, leaderboard, replay, statistics } from './history.ts'
import { appUrl, bodyJson, cors, errorResponse, json, limit } from './http.ts'
import { friends, relationship } from './social.ts'
import {
  admit,
  browseTables,
  callTable,
  canManage,
  createTable,
  invite,
  listInvitations,
  member,
  revokeInvite,
  summary,
  tableAdmin,
  tableRow,
  webSocket,
} from './tables.ts'
import { getProfile, profile, refill } from './wallet.ts'
export { BlackjackTable } from './table.ts'

async function api(request: Request, env: Env, url: URL) {
  const method = request.method
  const path = url.pathname.replace(/\/$/, '')
  const origin = request.headers.get('Origin')
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
  const app = appUrl(env)
  if (origin && origin !== app.origin) throw new Fault('origin', 403)
  if (method === 'OPTIONS') {
    if (origin !== app.origin) throw new Fault('origin', 403)
    return new Response(null, { status: 204, headers: { 'Access-Control-Max-Age': '600' } })
  }
  await limit(env.API_LIMIT, 'ip:' + ip)
  if (method === 'GET' && path === '/api/health') {
    await env.DB.prepare('SELECT id FROM system_settings WHERE id=1').first()
    return json({
      status: 'ok',
      database: true,
      authConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY),
    })
  }
  const socket = /^\/api\/tables\/([^/]+)\/socket$/.exec(path)
  if (method === 'GET' && socket) {
    if (origin !== app.origin) throw new Fault('origin', 403)
    return webSocket(env, uuid(socket[1]), request)
  }
  if (method === 'POST' && (path === '/api/auth/exchange' || path === '/api/auth/refresh')) {
    if (origin !== app.origin) throw new Fault('origin', 403)
    await limit(env.AUTH_LIMIT, path + ':' + ip)
    return path.endsWith('/exchange') ? exchange(env, request) : refresh(env, request)
  }
  const user = await identity(env, request)
  if (method === 'POST' && path === '/api/auth/logout') return logout(env, request, user)
  if (path === '/api/me' && method === 'GET') return json(profile(await ensureProfile(env, user)))
  if (path === '/api/me/setup' && method === 'POST') {
    const data = object(await bodyJson(request))
    return json(profile(await ensureProfile(env, user, data.username)))
  }
  const actor = await principal(env, user)
  if (path === '/api/me' && method === 'PATCH') {
    const data = parseAppearance(await bodyJson(request))
    await env.DB.prepare('UPDATE profiles SET display_name=?,avatar=?,private_stats=? WHERE id=?')
      .bind(data.displayName, data.avatar, Number(data.privateStats), actor.id)
      .run()
    return json(profile((await getProfile(env.DB, actor.id))!))
  }
  if (path === '/api/me/preferences' && method === 'PATCH') {
    const data = parsePreferences(await bodyJson(request))
    await env.DB.prepare('UPDATE profiles SET preferences=? WHERE id=?')
      .bind(JSON.stringify(data), actor.id)
      .run()
    return json(profile((await getProfile(env.DB, actor.id))!))
  }
  if (path === '/api/me/refill' && method === 'POST')
    return json(await refill(env.DB, actor.id, uuid(object(await bodyJson(request)).id)))
  if (path === '/api/me/wallet' && method === 'GET') {
    const entries = await env.DB.prepare(
      'SELECT id,delta,kind,created_at AS at,table_id AS tableId,round_id AS roundId FROM wallet_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 40',
    )
      .bind(actor.id)
      .all()
    const available = await env.DB.prepare(
      'SELECT (w.balance<=s.refill_below*10 AND w.last_refill<=?-60000*s.refill_minutes) AS eligible, s.refill_chips AS chips FROM wallets w CROSS JOIN system_settings s WHERE w.user_id=?',
    )
      .bind(Date.now(), actor.id)
      .first()
    return json({ entries: entries.results, refill: available })
  }
  if (path === '/api/friends' && method === 'GET') return friends(env, actor)
  if (path === '/api/friends' && method === 'POST') {
    await limit(env.AUTH_LIMIT, 'social:' + actor.id)
    return relationship(env, actor, await bodyJson(request))
  }
  if (path === '/api/stats' && method === 'GET') return statistics(env, actor)
  if (path === '/api/leaderboard' && method === 'GET') return leaderboard(env, actor, url)
  if (path === '/api/history' && method === 'GET') {
    const before = url.searchParams.has('before')
      ? Number(url.searchParams.get('before'))
      : Date.now() + 1
    if (!Number.isSafeInteger(before) || before < 0) throw new Fault('invalid')
    return history(env, actor, before)
  }
  const round = /^\/api\/history\/([^/]+)$/.exec(path)
  if (round && method === 'GET') return replay(env, actor, uuid(round[1]))
  if (path === '/api/tables' && method === 'GET') return browseTables(env, actor)
  if (path === '/api/tables' && method === 'POST') {
    await limit(env.JOIN_LIMIT, 'create:' + actor.id)
    return createTable(env, actor, await bodyJson(request))
  }
  if ((path === '/api/join' || path === '/api/join/preview') && method === 'POST')
    return admit(env, actor, await bodyJson(request), ip, path.endsWith('/preview'))
  if (path === '/api/admin' && method === 'GET') return adminOverview(env, actor)
  if (path === '/api/admin/audit' && method === 'GET') return auditLogs(env, actor)
  if (path === '/api/admin/reports' && method === 'GET') return reports(env, actor)
  const report = /^\/api\/admin\/reports\/([^/]+)$/.exec(path)
  if (report && method === 'POST') return reviewReport(env, actor, uuid(report[1]))
  if (path === '/api/admin/users' && method === 'GET')
    return adminUsers(env, actor, url.searchParams.get('q') ?? '')
  const adminUser = /^\/api\/admin\/users\/([^/]+)$/.exec(path)
  if (adminUser && method === 'POST')
    return updateUser(env, actor, uuid(adminUser[1]), await bodyJson(request))
  if (path === '/api/admin/settings' && method === 'GET') return settings(env, actor)
  if (path === '/api/admin/settings' && method === 'PATCH')
    return settings(env, actor, await bodyJson(request))
  if (path === '/api/table-defaults' && method === 'GET') {
    if (!canManage(actor)) throw new Fault('forbidden', 403)
    const defaults = await env.DB.prepare(
      'SELECT table_defaults FROM system_settings',
    ).first<string>('table_defaults')
    return json({ defaults: defaults ? JSON.parse(defaults) : null })
  }
  const tablePath =
    /^\/api\/tables\/([^/]+)(?:\/(ticket|invite|invitations|admin|report|status|people)(?:\/([^/]+))?)?$/.exec(
      path,
    )
  if (tablePath) {
    const table = await tableRow(env, uuid(tablePath[1]))
    const segment = tablePath[2]
    if (segment === 'admin' && method === 'POST')
      return tableAdmin(env, actor, table, await bodyJson(request))
    if (segment === 'invite' && method === 'POST') {
      await limit(env.AUTH_LIMIT, 'invite:' + actor.id)
      return invite(env, actor, table, await bodyJson(request))
    }
    if (segment === 'invitations' && method === 'GET') return listInvitations(env, actor, table)
    if (segment === 'invitations' && method === 'POST')
      return revokeInvite(env, actor, table, uuid(tablePath[3]))
    await member(env, table, actor)
    if (segment === 'ticket' && method === 'POST') {
      if (table.status === 'closed') throw new Fault('closed', 410)
      return callTable(env, table.id, 'ticket', { actor })
    }
    if (segment === 'people' && method === 'GET') {
      if (!canManage(actor, table.owner_id)) throw new Fault('forbidden', 403)
      const people = await env.DB.prepare(
        'SELECT p.id,p.display_name AS name,p.username,p.avatar,coalesce(r.banned,0) AS banned,coalesce(r.muted,0) AS muted ' +
          'FROM profiles p LEFT JOIN table_memberships m ON m.user_id=p.id AND m.table_id=? LEFT JOIN table_restrictions r ON r.user_id=p.id AND r.table_id=? ' +
          'WHERE m.user_id IS NOT NULL OR r.user_id IS NOT NULL ORDER BY m.joined_at DESC LIMIT 60',
      )
        .bind(table.id, table.id)
        .all()
      return json({ people: people.results })
    }
    if (segment === 'status' && method === 'GET') {
      if (!canManage(actor, table.owner_id)) throw new Fault('forbidden', 403)
      return callTable(env, table.id, 'status', {})
    }
    if (segment === 'report' && method === 'POST') {
      await limit(env.AUTH_LIMIT, 'report:' + actor.id)
      const data = object(await bodyJson(request))
      const reason = string(data.reason, 3, 160)
      const id = uuid(data.id)
      const response = await callTable(env, table.id, 'message', { actor, id })
      if (!response.ok) return response
      const message = await response.json<ChatMessage>()
      await env.DB.prepare(
        'INSERT INTO user_reports(id,reporter,target,table_id,message_id,excerpt,reason,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
        .bind(
          crypto.randomUUID(),
          actor.id,
          message.author,
          table.id,
          message.id,
          message.text,
          reason,
          Date.now(),
        )
        .run()
      return json({ ok: true })
    }
    if (!segment && method === 'GET') return json({ table: summary(table) })
  }
  throw new Fault('not_found', 404)
}

async function purge(env: Env, now: number) {
  const day = 86_400_000
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM auth_transfers WHERE id IN (SELECT id FROM auth_transfers WHERE expires_at<? LIMIT 1000)',
    ).bind(now),
    env.DB.prepare(
      'DELETE FROM revoked_sessions WHERE id IN (SELECT id FROM revoked_sessions WHERE expires_at<? LIMIT 1000)',
    ).bind(now),
    env.DB.prepare(
      'DELETE FROM table_invites WHERE id IN (SELECT id FROM table_invites WHERE expires_at<? LIMIT 500)',
    ).bind(now - day),
    env.DB.prepare(
      'DELETE FROM replays WHERE id IN (SELECT id FROM replays WHERE finished_at<? LIMIT 250)',
    ).bind(now - 90 * day),
    env.DB.prepare(
      "DELETE FROM user_reports WHERE id IN (SELECT id FROM user_reports WHERE status='reviewed' AND created_at<? LIMIT 250)",
    ).bind(now - 90 * day),
    env.DB.prepare(
      'DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at<? LIMIT 300)',
    ).bind(now - 365 * day),
  ])
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isApi = url.pathname.startsWith('/api/')
    try {
      if (isApi) return cors(await api(request, env, url), request.headers.get('Origin'), env)
      if (url.pathname.startsWith('/auth/')) return await handleAuthPage(env, request, url)
      if (url.pathname === '/' && env.APP_URL) return Response.redirect(appUrl(env).href, 302)
      throw new Fault('not_found', 404)
    } catch (error) {
      const response = errorResponse(error)
      return isApi ? cors(response, request.headers.get('Origin'), env) : response
    }
  },
  async scheduled(controller, env) {
    await purge(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
