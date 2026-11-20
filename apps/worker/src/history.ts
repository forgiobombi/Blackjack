import type { Env, Principal } from './env.ts'
import { json } from './http.ts'
import { Fault, option } from '../../../packages/protocol/validation.ts'
import type { Stats } from '../../../packages/protocol/types.ts'
import { EMPTY_STATS, STATS_FIELDS } from './wallet.ts'

export async function history(env: Env, actor: Principal, before: number) {
  const rows = await env.DB.prepare(
    'SELECT h.round_id AS id,r.table_name AS tableName,h.finished_at AS at,h.delta,h.outcome,h.hands,r.dealer,r.settings FROM round_history h JOIN replays r ON r.id=h.round_id ' +
      'WHERE h.user_id=? AND h.finished_at<? ORDER BY h.finished_at DESC LIMIT 25',
  )
    .bind(actor.id, before)
    .all<{
      id: string
      tableName: string
      at: number
      delta: number
      outcome: string
      hands: string
      dealer: string
      settings: string
    }>()
  return json({
    rounds: rows.results.map((row) => ({
      ...row,
      hands: JSON.parse(row.hands),
      dealer: JSON.parse(row.dealer),
      settings: JSON.parse(row.settings),
    })),
  })
}

export async function replay(env: Env, actor: Principal, id: string) {
  const data = await env.DB.prepare(
    'SELECT r.table_name AS tableName,r.finished_at AS at,r.settings,r.frames FROM replays r JOIN round_history h ON h.round_id=r.id WHERE r.id=? AND h.user_id=?',
  )
    .bind(id, actor.id)
    .first<{ tableName: string; at: number; settings: string; frames: string }>()
  if (!data) throw new Fault('not_found', 404)
  return json({ ...data, settings: JSON.parse(data.settings), frames: JSON.parse(data.frames) })
}

export async function statistics(env: Env, actor: Principal) {
  const result = await env.DB.prepare('SELECT ' + STATS_FIELDS + ' FROM statistics WHERE user_id=?')
    .bind(actor.id)
    .first<Stats>()
  return json(result ?? EMPTY_STATS)
}

export async function leaderboard(env: Env, actor: Principal, url: URL) {
  const sort = option(url.searchParams.get('sort') ?? 'blackjacks', [
    'blackjacks',
    'rounds',
    'longest',
    'percentage',
    'achievements',
  ])
  const scope = url.searchParams.get('scope') === 'friends'
  const achievementCount =
    '(s.rounds>=1)+(s.rounds>=10)+(s.rounds>=50)+(s.rounds>=100)+(s.blackjacks>=1)+(s.blackjacks>=5)+(s.blackjacks>=10)+(s.wins>=1)+(s.double_wins>=1)+(s.split_wins>=1)+(s.longest>=5)+(s.social>=1)'
  const expression =
    sort === 'percentage'
      ? '1.0 * s.wins / s.rounds'
      : sort === 'achievements'
        ? '(' + achievementCount + ')'
        : 's.' + sort
  const clause = scope
    ? " AND (p.id=? OR EXISTS(SELECT 1 FROM relationships r WHERE r.low_id=min(p.id,?) AND r.high_id=max(p.id,?) AND r.status='friends'))"
    : ''
  const values = scope ? [actor.id, actor.id, actor.id] : []
  const rows = await env.DB.prepare(
    'SELECT p.id,p.username,p.display_name AS name,p.avatar,s.rounds,' +
      expression +
      ' AS score FROM statistics s JOIN profiles p ON s.user_id=p.id WHERE p.private_stats=0 AND p.suspended=0' +
      (sort === 'percentage' ? ' AND s.rounds>=10' : '') +
      clause +
      ' ORDER BY score DESC,s.rounds DESC,p.id LIMIT 30',
  )
    .bind(...values)
    .all()
  return json({ leaders: rows.results })
}
