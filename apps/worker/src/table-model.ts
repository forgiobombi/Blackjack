import { handValue } from '../../../packages/engine/cards.ts'
import type { Shoe } from '../../../packages/engine/cards.ts'
import type { Round } from '../../../packages/engine/round.ts'
import { IDLE_MS, LAST_WARNING_MS, MIN_WARNING_MS } from '../../../packages/protocol/rules.ts'
import type { TableSettings } from '../../../packages/protocol/rules.ts'
import type {
  Avatar,
  ChatMessage,
  EventKind,
  Frame,
  PublicHand,
  Reply,
  SeatView,
} from '../../../packages/protocol/types.ts'
import type { Entry, Settlement } from './wallet.ts'

export type Seat = {
  user: string
  name: string
  avatar: Avatar
  position: number
  ready: boolean
  offlineAt?: number
  retire?: boolean
}
export type Receipt = { user: string; id: string; error?: string }
export type TableState = {
  id: string
  owner: string
  createdAt: number
  settings: TableSettings
  lastActive: number
  warning: number
  version: number
  paused: boolean
  joinEnabled: boolean
  closing?: 'admin' | 'idle'
  closedAt?: number
  nextAt?: number
  round?: Round
  shoe?: Shoe
  seats: Seat[]
  frames: Frame[]
  chat: ChatMessage[]
  receipts: Receipt[]
  roundReceipts: Receipt[]
  lobbyTouches: string[]
}
export type Projection = {
  kind: 'create' | 'settings' | 'joining' | 'closing' | 'closed' | 'audit' | 'moderation'
  audit?: {
    id: string
    actor: string | null
    action: string
    target: string
    data?: object
    at: number
  }
  moderation?: { user: string; action: 'remove' | 'ban' | 'unban' | 'mute' | 'unmute' }
}
export type Pending = {
  next: TableState
  kind: EventKind
  visuals: Frame[]
  entry?: Entry
  settlement?: { entries: Entry[]; data: Settlement }
  projection?: Projection
  actor?: string
  command?: string
  attempts: number
  retryAt: number
}
export type Envelope = { current: TableState; pending?: Pending }

export function idleAt(state: TableState) {
  return state.lastActive + IDLE_MS
}

export function dueAt(state: TableState) {
  if (state.closedAt) return undefined
  const warningAt =
    state.lastActive +
    (state.warning === 0 ? MIN_WARNING_MS : state.warning === 1 ? LAST_WARNING_MS : IDLE_MS)
  const offline =
    state.round && state.round.phase !== 'complete'
      ? []
      : state.seats.flatMap((seat) => (seat.offlineAt ? [seat.offlineAt + 120_000] : []))
  return Math.min(
    warningAt,
    state.round?.deadline ?? Infinity,
    state.nextAt ?? Infinity,
    ...offline,
  )
}

export function activeRound(state: TableState) {
  return state.round !== undefined && state.round.phase !== 'complete'
}

export function touch(state: TableState, time: number) {
  state.lastActive = time
  state.warning = 0
}

export function recordReceipt(
  state: TableState,
  user: string,
  id: string,
  error?: string,
  isRound = false,
) {
  if (isRound) state.roundReceipts.push({ user, id, error })
  else state.receipts.push({ user, id, error })
  if (state.receipts.length > 512) state.receipts.splice(0, state.receipts.length - 512)
}

export function receipt(state: TableState, user: string, id: string): Reply | undefined {
  const matches = (entry: Receipt) => entry.id === id && entry.user === user
  const record = state.roundReceipts.find(matches) ?? state.receipts.find(matches)
  if (record)
    return { type: 'reply', id, ok: !record.error, error: record.error, sequence: state.version }
}

export function amounts(state: TableState, user: string) {
  return state.round?.players.find((player) => player.user === user)
}

export function publicHand(
  hand: NonNullable<TableState['round']>['players'][number]['hands'][number],
): PublicHand {
  return {
    id: hand.id,
    cards: hand.cards,
    ...handValue(hand.cards),
    stake: hand.stake,
    result: hand.result,
    returned: hand.returned,
  }
}

// Only this projection enters a socket payload or a replay. Hidden cards never enter either.
export function frame(
  state: TableState,
  kind: EventKind,
  at: number,
  connected = new Set<string>(),
  target?: number,
): Frame {
  const round = state.round
  const exposed = round?.revealed ? round.dealer : (round?.dealer.slice(0, 1) ?? [])
  const dealer = !round?.revealed && round?.dealer.length === 2 ? [...exposed, null] : exposed
  const seats: SeatView[] = state.seats.map((seat) => {
    const player = amounts(state, seat.user)
    return {
      position: seat.position,
      id: seat.user,
      name: seat.name,
      avatar: seat.avatar,
      ready: seat.ready,
      connected: connected.has(seat.user),
      bet: player?.bet ?? 0,
      hands: player?.hands.map(publicHand) ?? [],
      insurance: player?.insurance || undefined,
      insuranceReturned: player?.insuranceReturned,
    }
  })
  return {
    kind,
    at,
    phase: state.closedAt ? 'closed' : (round?.phase ?? 'waiting'),
    dealer,
    dealerTotal: handValue(exposed).total,
    seats,
    turn: round?.turn,
    roundId: round?.id,
    target,
    reason: state.closing,
  }
}

export function framesFor(state: TableState, at: number) {
  const visuals: Frame[] = []
  return {
    visuals,
    emit(kind: EventKind, target?: number) {
      // Copy now. Subsequent draws in the same server operation must not rewrite a replay frame.
      const event = structuredClone(frame(state, kind, at, undefined, target))
      state.frames.push(event)
      visuals.push(event)
    },
  }
}

export function finalize(state: TableState, now: number) {
  const round = state.round!
  const entries: Entry[] = []
  const result = {
    id: round.id,
    tableName: state.settings.name,
    at: now,
    settings: state.settings,
    delta: 0,
    outcome: '',
    hands: [],
    dealer: round.dealer,
  }
  const histories: Settlement['histories'] = []
  for (const player of round.players) {
    const hands = player.hands.map(publicHand)
    const paid = hands.reduce(
      (sum, hand) => sum + (hand.returned ?? 0),
      player.insuranceReturned ?? 0,
    )
    const staked = hands.reduce((sum, hand) => sum + hand.stake, player.insurance ?? 0)
    const delta = paid - staked
    if (paid > 0) {
      entries.push({
        id: 'pay:' + round.id + ':' + player.user,
        user: player.user,
        table: state.id,
        round: round.id,
        delta: paid,
        kind: round.cancelled ? 'refund' : 'settlement',
        at: now,
      })
    }
    histories.push({
      user: player.user,
      summary: {
        ...result,
        delta,
        hands,
        outcome: round.cancelled ? 'refund' : delta > 0 ? 'win' : delta < 0 ? 'loss' : 'push',
      },
      blackjacks: player.hands.filter((hand) => !hand.split && hand.status === 'natural').length,
      doubleWins: player.hands.filter((hand) => hand.doubled && hand.result === 'win').length,
      splitWins: player.hands.filter((hand) => hand.split && hand.result === 'win').length,
      social: Number(round.players.length > 1),
    })
  }
  round.phase = 'complete'
  const complete = structuredClone(frame(state, 'settled', now))
  state.frames.push(complete)
  // Join/leave and chat do not enter round replays. Archive before releasing retired seats.
  const frames = state.frames
  state.frames = []
  state.seats = state.seats.filter((seat) => !seat.retire)
  return { entries, data: { summary: result, table: state.id, frames, histories }, complete }
}
