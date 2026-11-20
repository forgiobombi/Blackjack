import type { Frame, Profile, RoundSummary, Stats } from '../../../packages/protocol/types.ts'
import { DEFAULT_PREFERENCES } from '../../../packages/protocol/types.ts'
import { Fault } from '../../../packages/protocol/validation.ts'

export type WalletKind =
  'bet' | 'double' | 'split' | 'insurance' | 'clear' | 'settlement' | 'refund' | 'adjustment'
export type Entry = {
  id: string
  user: string
  table: string | null
  round: string | null
  delta: number
  kind: WalletKind
  at: number
}
export type History = {
  user: string
  summary: RoundSummary
  blackjacks: number
  doubleWins: number
  splitWins: number
  social: number
}
export type Settlement = {
  summary: RoundSummary
  table: string
  frames: Frame[]
  histories: History[]
}

export type ProfileRow = {
  id: string
  username: string
  display_name: string
  avatar: Profile['avatar']
  role: Profile['role']
  suspended: number
  private_stats: number
  preferences: string
  created_at: number
  balance: number
  refill_at: number
}
export const PROFILE_SELECT =
  'SELECT p.*, w.balance, w.last_refill + s.refill_minutes * 60000 AS refill_at FROM profiles p JOIN wallets w ON w.user_id=p.id CROSS JOIN system_settings s'
export function profile(row: ProfileRow): Profile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    role: row.role,
    createdAt: row.created_at,
    balance: row.balance,
    refillAt: row.refill_at,
    privateStats: Boolean(row.private_stats),
    preferences: { ...DEFAULT_PREFERENCES, ...JSON.parse(row.preferences) },
  }
}
export async function getProfile(db: D1Database, id: string): Promise<ProfileRow | null> {
  return db
    .prepare(PROFILE_SELECT + ' WHERE p.id=?')
    .bind(id)
    .first<ProfileRow>()
}

export async function registerProfile(
  db: D1Database,
  id: string,
  username: string,
  locale: 'en' | 'it',
) {
  const now = Date.now()
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO profiles(id,username,display_name,preferences,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(id, username, username, JSON.stringify({ ...DEFAULT_PREFERENCES, locale }), now),
      db.prepare('INSERT INTO wallets(user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(id),
      db
        .prepare(
          "INSERT INTO wallet_ledger(id,user_id,delta,kind,created_at) SELECT ?,?,starting_chips*10,'initial',? FROM system_settings WHERE id=1 ON CONFLICT DO NOTHING",
        )
        .bind('grant:' + id, id, now),
    ])
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('UNIQUE constraint failed: profiles.username')
    )
      throw new Fault('username_taken', 409)
    throw error
  }
  return (await getProfile(db, id))!
}

export function ledgerStatement(db: D1Database, entry: Entry) {
  return db
    .prepare(
      'INSERT INTO wallet_ledger(id,user_id,table_id,round_id,delta,kind,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(entry.id, entry.user, entry.table, entry.round, entry.delta, entry.kind, entry.at)
}

export async function reserveOrRelease(db: D1Database, entry: Entry): Promise<boolean> {
  const row = await db
    .prepare(
      'INSERT INTO wallet_ledger(id,user_id,table_id,round_id,delta,kind,created_at) ' +
        'SELECT ?,user_id,?,?,?,?,? FROM wallets WHERE user_id=? AND balance+?>=0 ON CONFLICT(id) DO NOTHING RETURNING id',
    )
    .bind(
      entry.id,
      entry.table,
      entry.round,
      entry.delta,
      entry.kind,
      entry.at,
      entry.user,
      entry.delta,
    )
    .first<{ id: string }>()
  if (row) return true
  const recorded = await db
    .prepare('SELECT user_id,table_id,round_id,delta,kind FROM wallet_ledger WHERE id=?')
    .bind(entry.id)
    .first<{ user_id: string; table_id: string; round_id: string; delta: number; kind: string }>()
  if (
    recorded &&
    (recorded.user_id !== entry.user ||
      recorded.table_id !== entry.table ||
      recorded.round_id !== entry.round ||
      recorded.delta !== entry.delta ||
      recorded.kind !== entry.kind)
  )
    throw new Error('Conflicting ledger operation')
  return Boolean(recorded)
}

export async function settle(
  db: D1Database,
  entries: Entry[],
  settlement: Settlement,
): Promise<void> {
  const { summary, frames, histories, table } = settlement
  await db.batch([
    ...entries.map((entry) => ledgerStatement(db, entry)),
    db
      .prepare(
        'INSERT INTO replays(id,table_id,table_name,settings,dealer,frames,finished_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(
        summary.id,
        table,
        summary.tableName,
        JSON.stringify(summary.settings),
        JSON.stringify(summary.dealer),
        JSON.stringify(frames),
        summary.at,
      ),
    ...histories.map(({ user, summary: handSummary, blackjacks, doubleWins, splitWins, social }) =>
      db
        .prepare(
          'INSERT INTO round_history(round_id,user_id,finished_at,delta,outcome,hands,blackjacks,double_wins,split_wins,social) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(
          summary.id,
          user,
          summary.at,
          handSummary.delta,
          handSummary.outcome,
          JSON.stringify(handSummary.hands),
          blackjacks,
          doubleWins,
          splitWins,
          social,
        ),
    ),
  ])
}

export async function refill(db: D1Database, user: string, operation: string) {
  const now = Date.now()
  const id = 'refill:' + user + ':' + operation
  const row = await db
    .prepare(
      "INSERT INTO wallet_ledger(id,user_id,delta,kind,created_at) SELECT ?,w.user_id,s.refill_chips*10,'refill',? " +
        'FROM wallets w CROSS JOIN system_settings s WHERE w.user_id=? AND balance<=s.refill_below*10 AND last_refill<=?-60000*s.refill_minutes ON CONFLICT DO NOTHING RETURNING id',
    )
    .bind(id, now, user, now)
    .first()
  if (!row && !(await db.prepare('SELECT id FROM wallet_ledger WHERE id=?').bind(id).first()))
    throw new Fault('refill_unavailable', 409)
  return profile((await getProfile(db, user))!)
}

export const EMPTY_STATS: Stats = {
  rounds: 0,
  wins: 0,
  losses: 0,
  pushes: 0,
  blackjacks: 0,
  streak: 0,
  longest: 0,
  doubleWins: 0,
  splitWins: 0,
  social: 0,
}
export const STATS_FIELDS =
  'rounds,wins,losses,pushes,blackjacks,streak,longest,double_wins AS doubleWins,split_wins AS splitWins,social'
