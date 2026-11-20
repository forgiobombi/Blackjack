export const DECKS = [1, 2, 4, 6, 8] as const
export const THEMES = ['emerald', 'midnight', 'burgundy', 'modern', 'minimal'] as const
export type Theme = (typeof THEMES)[number]
export type Rules = {
  decks: (typeof DECKS)[number]
  payout: '3:2' | '6:5'
  soft17: 'stand' | 'hit'
  double: 'any' | '9-11' | '10-11' | 'off'
  doubleAfterSplit: boolean
  split: 'rank' | 'value' | 'off'
  maxHands: number
  resplit: boolean
  resplitAces: boolean
  hitSplitAces: boolean
  insurance: boolean
  surrender: 'none' | 'early' | 'late'
  holeCard: 'american' | 'european'
  dealerBlackjack: 'all' | 'original'
  penetration: number
}

export type TableSettings = {
  name: string
  description: string
  private: boolean
  maxPlayers: number
  spectators: boolean
  minBet: number
  maxBet: number
  bettingSeconds: number
  turnSeconds: number
  theme: Theme
  speed: 'normal' | 'fast'
  chat: boolean
  friendInvites: boolean
  autoNext: boolean
  lateEntry: boolean
  seats: 'choose' | 'first'
  rules: Rules
}

export const UNIT = 10
export const IDLE_MS = 30 * 60_000
export const MIN_WARNING_MS = 25 * 60_000
export const LAST_WARNING_MS = 29 * 60_000
export const CLASSIC: Rules = {
  decks: 6,
  payout: '3:2',
  soft17: 'stand',
  double: 'any',
  doubleAfterSplit: true,
  split: 'rank',
  maxHands: 4,
  resplit: true,
  resplitAces: false,
  hitSplitAces: false,
  insurance: true,
  surrender: 'late',
  holeCard: 'american',
  dealerBlackjack: 'all',
  penetration: 75,
}

export const PRESETS = {
  classic: { rules: CLASSIC, bettingSeconds: 20, turnSeconds: 25, speed: 'normal' },
  vegas: {
    rules: { ...CLASSIC, decks: 8, soft17: 'hit', split: 'value' },
    bettingSeconds: 20,
    turnSeconds: 25,
    speed: 'normal',
  },
  european: {
    rules: {
      ...CLASSIC,
      decks: 2,
      holeCard: 'european',
      double: '9-11',
      split: 'rank',
      doubleAfterSplit: false,
      surrender: 'none',
      maxHands: 2,
      resplit: false,
    },
    bettingSeconds: 20,
    turnSeconds: 25,
    speed: 'normal',
  },
  fast: {
    rules: {
      ...CLASSIC,
      decks: 4,
      insurance: false,
      surrender: 'none',
      maxHands: 2,
      resplit: false,
    },
    bettingSeconds: 12,
    turnSeconds: 15,
    speed: 'fast',
  },
} as const satisfies Record<
  string,
  Pick<TableSettings, 'rules' | 'bettingSeconds' | 'turnSeconds' | 'speed'>
>

export const DEFAULT_TABLE: TableSettings = {
  name: '',
  description: '',
  private: true,
  maxPlayers: 7,
  spectators: true,
  minBet: 5,
  maxBet: 1000,
  bettingSeconds: 20,
  turnSeconds: 25,
  theme: 'emerald',
  speed: 'normal',
  chat: true,
  friendInvites: false,
  autoNext: false,
  lateEntry: true,
  seats: 'choose',
  rules: CLASSIC,
}
