import { DECKS, THEMES } from './rules.ts'
import type { Rules, TableSettings } from './rules.ts'
import { ACTIONS, AVATARS, REACTIONS } from './types.ts'
import type { Command, Preferences } from './types.ts'

export class Fault extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Fault('invalid')
  return value as Record<string, unknown>
}

export function string(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new Fault('invalid')
  const normalized = value.trim()
  if (
    normalized.length < min ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
  )
    throw new Fault('invalid')
  return normalized
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Fault('invalid')
  return value
}

export function option<T extends string | number>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Fault('invalid')
  return value as T
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Fault('invalid')
  return value
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value))
    throw new Fault('invalid')
  return value.toLowerCase()
}

export function username(value: unknown): string {
  const name = string(value, 3, 20)
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Fault('invalid_username')
  return name.toLowerCase()
}

export function parseRules(value: unknown): Rules {
  const x = object(value)
  return {
    decks: option(x.decks, DECKS),
    payout: option(x.payout, ['3:2', '6:5']),
    soft17: option(x.soft17, ['stand', 'hit']),
    double: option(x.double, ['any', '9-11', '10-11', 'off']),
    doubleAfterSplit: bool(x.doubleAfterSplit),
    split: option(x.split, ['rank', 'value', 'off']),
    maxHands: integer(x.maxHands, 2, 4),
    resplit: bool(x.resplit),
    resplitAces: bool(x.resplitAces),
    hitSplitAces: bool(x.hitSplitAces),
    insurance: bool(x.insurance),
    surrender: option(x.surrender, ['none', 'early', 'late']),
    holeCard: option(x.holeCard, ['american', 'european']),
    dealerBlackjack: option(x.dealerBlackjack, ['all', 'original']),
    penetration: integer(x.penetration, 35, 85),
  }
}

export function parseSettings(value: unknown): TableSettings {
  const x = object(value)
  const minBet = integer(x.minBet, 1, 100_000)
  return {
    name: string(x.name, 2, 44),
    description: string(x.description, 0, 180),
    private: bool(x.private),
    maxPlayers: integer(x.maxPlayers, 1, 7),
    spectators: bool(x.spectators),
    minBet,
    maxBet: integer(x.maxBet, minBet, 100_000),
    bettingSeconds: integer(x.bettingSeconds, 8, 90),
    turnSeconds: integer(x.turnSeconds, 10, 90),
    theme: option(x.theme, THEMES),
    speed: option(x.speed, ['normal', 'fast']),
    chat: bool(x.chat),
    friendInvites: bool(x.friendInvites),
    autoNext: bool(x.autoNext),
    lateEntry: bool(x.lateEntry),
    seats: option(x.seats, ['choose', 'first']),
    rules: parseRules(x.rules),
  }
}

export function parsePreferences(value: unknown): Preferences {
  const x = object(value)
  function volume(v: unknown) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Fault('invalid')
    return v
  }
  return {
    locale: option(x.locale, ['en', 'it']),
    motion: option(x.motion, ['high', 'balanced', 'minimal']),
    animationSpeed: option(x.animationSpeed, ['normal', 'fast']),
    audio: bool(x.audio),
    volume: volume(x.volume),
    effects: volume(x.effects),
    music: volume(x.music),
    chat: bool(x.chat),
    notifications: bool(x.notifications),
    cards: option(x.cards, ['ivory', 'midnight']),
    chips: option(x.chips, ['classic', 'plain']),
    density: option(x.density, ['cozy', 'compact']),
    theme: option(x.theme, ['table', ...THEMES]),
  }
}

export function parseCommand(value: unknown): Command {
  const x = object(value)
  const base = { id: uuid(x.id), tableId: uuid(x.tableId) }
  switch (x.kind) {
    case 'snapshot':
    case 'take_control':
    case 'leave':
      return { ...base, kind: x.kind }
    case 'seat':
      return { ...base, kind: x.kind, position: integer(x.position, 0, 6) }
    case 'ready':
      return { ...base, kind: x.kind, value: bool(x.value) }
    case 'bet':
      return {
        ...base,
        kind: x.kind,
        roundId: uuid(x.roundId),
        chips: integer(x.chips, 1, 100_000),
      }
    case 'clear':
      return { ...base, kind: x.kind, roundId: uuid(x.roundId) }
    case 'action':
      return {
        ...base,
        kind: 'action',
        roundId: uuid(x.roundId),
        action: option(x.action, ACTIONS),
        step: x.step === undefined ? undefined : integer(x.step, 0, 10_000),
        hand: x.hand === undefined ? undefined : integer(x.hand, 0, 100),
      }
    case 'chat':
      return { ...base, kind: x.kind, text: string(x.text, 1, 280) }
    case 'reaction':
      return { ...base, kind: x.kind, value: option(x.value, REACTIONS) }
    default:
      throw new Fault('invalid')
  }
}

export function parseAppearance(value: unknown) {
  const x = object(value)
  return {
    displayName: string(x.displayName, 2, 32),
    avatar: option(x.avatar, AVATARS),
    privateStats: bool(x.privateStats),
  }
}
